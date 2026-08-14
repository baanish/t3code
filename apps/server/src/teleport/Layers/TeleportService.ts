import {
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  ProviderDriverKind,
  TELEPORT_NATIVE_FORMAT_VERSION,
  TELEPORT_SCHEMA_VERSION,
  TeleportDiscoveryError,
  TeleportInvalidInputError,
  TeleportProjectResolutionError,
  TeleportIdentityConflictError,
  TeleportNativeWriteError,
  TeleportUnsupportedProviderError,
  ThreadId,
  defaultInstanceIdForDriver,
  isTeleportProvider,
  type ModelSelection,
  type OrchestrationMessage,
  type TeleportExportSessionInput,
  type TeleportExportSessionResult,
  type TeleportImportSessionsInput,
  type TeleportImportSessionsResult,
  type TeleportListSessionsInput,
  type TeleportListSessionsResult,
  type TeleportProvider,
  type TeleportRuntimePayload,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as OrchestrationEngine from "../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderInstanceRegistry } from "../../provider/Services/ProviderInstanceRegistry.ts";
import { ProviderSessionDirectory } from "../../provider/Services/ProviderSessionDirectory.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { canonicalizeTeleportCwd, teleportCwdsMatch } from "../cwd.ts";
import { discoverTeleportSessions, loadTeleportSession } from "../discovery.ts";
import { requireNativePathUnlocked } from "../fileLock.ts";
import {
  allocateClaudeSessionPath,
  parseClaudeSessionContents,
  serializeClaudeSession,
} from "../formats/claude.ts";
import {
  allocateCodexSessionPath,
  parseCodexSessionContents,
  serializeCodexSession,
} from "../formats/codex.ts";
import {
  allocateGrokSessionPath,
  parseGrokSessionContents,
  serializeGrokSession,
} from "../formats/grok.ts";
import { writeOpenCodeSession } from "../formats/opencode.ts";
import { resolveTeleportHomes } from "../homes.ts";
import { writeNativeSessionAtomically } from "../nativeWrite.ts";
import {
  buildTeleportResumeCursor,
  readTeleportExternalSessionId,
  toTeleportProvider,
} from "../resumeCursors.ts";
import { firstUserTitle, truncateTitle } from "../json.ts";
import {
  MAX_TELEPORT_MESSAGE_CHARS,
  MAX_TELEPORT_MESSAGES,
  type NativeTextMessage,
  type ParsedNativeSession,
} from "../types.ts";
import { TeleportService } from "../Services/TeleportService.ts";

function modelSelectionForProvider(provider: TeleportProvider): ModelSelection {
  const driver = ProviderDriverKind.make(provider);
  return {
    instanceId: defaultInstanceIdForDriver(driver),
    model: DEFAULT_MODEL_BY_PROVIDER[driver] ?? DEFAULT_MODEL,
  };
}

function capMessages(messages: ReadonlyArray<NativeTextMessage>): NativeTextMessage[] {
  return messages
    .slice(-MAX_TELEPORT_MESSAGES)
    .map((message) =>
      message.text.length > MAX_TELEPORT_MESSAGE_CHARS
        ? {
            ...message,
            text: `${message.text.slice(0, MAX_TELEPORT_MESSAGE_CHARS)}\n\n[truncated]`,
          }
        : message,
    );
}

function nativeMessagesToOrchestration(
  messages: ReadonlyArray<NativeTextMessage>,
  ids: ReadonlyArray<string>,
  now: string,
): OrchestrationMessage[] {
  return messages.map((message, index) => ({
    id: MessageId.make(message.id ?? ids[index] ?? `${index}`),
    role: message.role,
    text: message.text,
    turnId: null,
    streaming: false,
    createdAt: message.createdAt ?? now,
    updatedAt: message.createdAt ?? now,
  }));
}

function orchestrationToNative(messages: ReadonlyArray<OrchestrationMessage>): NativeTextMessage[] {
  return messages.flatMap((message) => {
    if (message.role !== "user" && message.role !== "assistant") {
      return [];
    }
    const text = message.text.trim();
    if (text.length === 0) {
      return [];
    }
    return [
      {
        role: message.role,
        text: message.text,
        createdAt: message.createdAt,
        id: message.id,
      },
    ];
  });
}

function isBusySessionStatus(status: string | undefined): boolean {
  return status === "starting" || status === "running";
}

export const TeleportServiceLive = Layer.effect(
  TeleportService,
  Effect.gen(function* () {
    const settingsService = yield* ServerSettings.ServerSettingsService;
    const engine = yield* OrchestrationEngine.OrchestrationEngineService;
    const snapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    const directory = yield* ProviderSessionDirectory;
    const instanceRegistry = yield* ProviderInstanceRegistry;
    const crypto = yield* Crypto.Crypto;
    const nativeContext = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
    const provideNative = <A, E>(
      effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
    ): Effect.Effect<A, E> => effect.pipe(Effect.provideContext(nativeContext));

    const nextId = () => crypto.randomUUIDv4;
    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

    const mapDispatchError = (message: string) => (cause: unknown) =>
      new TeleportInvalidInputError({
        message,
        cause,
      });

    const listSessions = (input: TeleportListSessionsInput) =>
      provideNative(
        Effect.gen(function* () {
          const cwd = yield* canonicalizeTeleportCwd(input.cwd);
          const settings = yield* settingsService.getSettings.pipe(
            Effect.mapError(
              (cause) =>
                new TeleportDiscoveryError({
                  message: "Server settings could not be read for teleport discovery.",
                  cause,
                }),
            ),
          );
          const homes = yield* resolveTeleportHomes(settings);
          return yield* discoverTeleportSessions({
            homes,
            cwd,
            ...(input.providers ? { providers: input.providers } : {}),
          });
        }),
      );

    const importSessions = (input: TeleportImportSessionsInput) =>
      provideNative(
        Effect.gen(function* () {
          const project = yield* snapshotQuery.getProjectShellById(input.projectId).pipe(
            Effect.mapError(
              (cause) =>
                new TeleportProjectResolutionError({
                  message: "Failed to load the target project.",
                  cause,
                }),
            ),
          );
          if (Option.isNone(project)) {
            return yield* new TeleportProjectResolutionError({
              message: `Project '${input.projectId}' was not found.`,
            });
          }
          const cwd = yield* canonicalizeTeleportCwd(input.cwd);
          if (!teleportCwdsMatch(project.value.workspaceRoot, cwd)) {
            return yield* new TeleportInvalidInputError({
              message: "Import cwd must match the selected project's workspace root.",
            });
          }
          const seenRefs = new Set<string>();
          for (const ref of input.sessions) {
            const key = `${ref.provider}:${ref.externalSessionId}`;
            if (seenRefs.has(key)) {
              return yield* new TeleportInvalidInputError({
                message: `Duplicate session '${ref.externalSessionId}' in the import batch.`,
              });
            }
            seenRefs.add(key);
          }

          const settings = yield* settingsService.getSettings.pipe(
            Effect.mapError(
              (cause) =>
                new TeleportDiscoveryError({
                  message: "Server settings could not be read for teleport import.",
                  cause,
                }),
            ),
          );
          const homes = yield* resolveTeleportHomes(settings);
          const bindings = yield* directory.listBindings().pipe(
            Effect.mapError(
              (cause) =>
                new TeleportDiscoveryError({
                  message: "Failed to read provider session bindings.",
                  cause,
                }),
            ),
          );

          const parsedSessions: ParsedNativeSession[] = [];
          for (const ref of input.sessions) {
            const parsed = yield* loadTeleportSession({
              homes,
              provider: ref.provider,
              externalSessionId: ref.externalSessionId,
              cwd,
            });
            yield* requireNativePathUnlocked(parsed.nativePath);
            parsedSessions.push({
              ...parsed,
              messages: capMessages(parsed.messages),
            });
          }

          const imported: TeleportImportSessionsResult["imported"] = [];
          const now = yield* nowIso;

          for (const parsed of parsedSessions) {
            const driver = ProviderDriverKind.make(parsed.provider);
            let existingThreadId: ThreadId | undefined;
            let existingProjectId = input.projectId;
            for (const binding of bindings) {
              if (binding.provider !== driver) {
                continue;
              }
              const externalSessionId = readTeleportExternalSessionId({
                provider: binding.provider,
                resumeCursor: binding.resumeCursor,
                runtimePayload: binding.runtimePayload,
              });
              if (externalSessionId !== parsed.externalSessionId) {
                continue;
              }
              const shell = yield* snapshotQuery.getThreadShellById(binding.threadId).pipe(
                Effect.mapError(
                  (cause) =>
                    new TeleportDiscoveryError({
                      message: "Failed to load an existing teleport thread.",
                      cause,
                    }),
                ),
              );
              if (Option.isNone(shell) || shell.value.archivedAt !== null) {
                continue;
              }
              if (shell.value.projectId !== input.projectId) {
                return yield* new TeleportIdentityConflictError({
                  provider: parsed.provider,
                  externalSessionId: parsed.externalSessionId,
                  existingThreadId: binding.threadId,
                  existingProjectId: shell.value.projectId,
                  message: `Session '${parsed.externalSessionId}' is already bound to another T3 project.`,
                });
              }
              existingThreadId = binding.threadId;
              existingProjectId = shell.value.projectId;
              if (isBusySessionStatus(shell.value.session?.status)) {
                return yield* new TeleportInvalidInputError({
                  message: `Cannot import while T3 session '${parsed.externalSessionId}' is running.`,
                });
              }
              break;
            }

            const messageIds = yield* Effect.forEach(parsed.messages, () => nextId(), {
              concurrency: 1,
            });
            const messages = nativeMessagesToOrchestration(parsed.messages, messageIds, now);
            const title =
              truncateTitle(
                parsed.title ?? firstUserTitle(parsed.messages) ?? "Imported session",
              ) || "Imported session";
            let threadId = existingThreadId;
            let updatedInPlace = false;

            if (threadId) {
              updatedInPlace = true;
              const replaceCommandId = CommandId.make(yield* nextId());
              yield* engine
                .dispatch({
                  type: "thread.history.replace",
                  commandId: replaceCommandId,
                  threadId,
                  messages,
                  createdAt: now,
                })
                .pipe(Effect.mapError(mapDispatchError("Failed to replace thread history.")));
              yield* engine
                .dispatch({
                  type: "thread.meta.update",
                  commandId: CommandId.make(yield* nextId()),
                  threadId,
                  title,
                })
                .pipe(Effect.mapError(mapDispatchError("Failed to update imported thread title.")));
            } else {
              threadId = ThreadId.make(yield* nextId());
              yield* engine
                .dispatch({
                  type: "thread.create",
                  commandId: CommandId.make(yield* nextId()),
                  threadId,
                  projectId: input.projectId,
                  title,
                  modelSelection: modelSelectionForProvider(parsed.provider),
                  runtimeMode: DEFAULT_RUNTIME_MODE,
                  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
                  branch: null,
                  worktreePath: null,
                  createdAt: now,
                })
                .pipe(Effect.mapError(mapDispatchError("Failed to create an imported thread.")));
              yield* engine
                .dispatch({
                  type: "thread.history.replace",
                  commandId: CommandId.make(yield* nextId()),
                  threadId,
                  messages,
                  createdAt: now,
                })
                .pipe(
                  Effect.mapError(mapDispatchError("Failed to write imported thread history.")),
                );
            }

            const teleportPayload: TeleportRuntimePayload = {
              schemaVersion: TELEPORT_SCHEMA_VERSION,
              externalSessionId: parsed.externalSessionId,
              nativePath: parsed.nativePath,
              lastSyncDirection: "import",
              lastSyncedAt: now,
              nativeFormatVersion: parsed.nativeFormatVersion,
            };
            yield* directory
              .upsert({
                threadId,
                provider: driver,
                providerInstanceId: defaultInstanceIdForDriver(driver),
                status: "stopped",
                resumeCursor: buildTeleportResumeCursor({
                  provider: parsed.provider,
                  externalSessionId: parsed.externalSessionId,
                }),
                runtimePayload: { teleport: teleportPayload },
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new TeleportDiscoveryError({
                      message: "Failed to bind the imported native session.",
                      cause,
                    }),
                ),
              );

            imported.push({
              threadId,
              projectId: existingProjectId,
              provider: parsed.provider,
              providerInstanceId: defaultInstanceIdForDriver(driver),
              externalSessionId: parsed.externalSessionId,
              updatedInPlace,
            });
          }

          return {
            schemaVersion: TELEPORT_SCHEMA_VERSION,
            imported,
          };
        }),
      );

    const exportSession = (input: TeleportExportSessionInput) =>
      provideNative(
        Effect.gen(function* () {
          const thread = yield* snapshotQuery.getThreadDetailById(input.threadId).pipe(
            Effect.mapError(
              (cause) =>
                new TeleportInvalidInputError({
                  message: "Failed to load the thread for export.",
                  cause,
                }),
            ),
          );
          if (Option.isNone(thread)) {
            return yield* new TeleportInvalidInputError({
              message: `Thread '${input.threadId}' was not found.`,
            });
          }
          if (isBusySessionStatus(thread.value.session?.status)) {
            return yield* new TeleportInvalidInputError({
              message: "Cannot export while this T3 session is running.",
            });
          }

          const project = yield* snapshotQuery.getProjectShellById(thread.value.projectId).pipe(
            Effect.mapError(
              (cause) =>
                new TeleportProjectResolutionError({
                  message: "Failed to load the thread's project.",
                  cause,
                }),
            ),
          );
          if (Option.isNone(project)) {
            return yield* new TeleportProjectResolutionError({
              message: "The thread's project was not found.",
            });
          }

          const binding = yield* directory.getBinding(input.threadId).pipe(
            Effect.mapError(
              (cause) =>
                new TeleportInvalidInputError({
                  message: "Failed to read the thread's provider binding.",
                  cause,
                }),
            ),
          );
          const instance = yield* instanceRegistry.getInstance(
            thread.value.modelSelection.instanceId,
          );
          const driverKind =
            Option.getOrUndefined(binding)?.provider ??
            instance?.driverKind ??
            (isTeleportProvider(thread.value.modelSelection.instanceId)
              ? ProviderDriverKind.make(thread.value.modelSelection.instanceId)
              : undefined);
          if (!driverKind) {
            return yield* new TeleportInvalidInputError({
              message: "Teleport export could not resolve a supported provider for this thread.",
            });
          }
          const provider = yield* toTeleportProvider(driverKind);
          const cwd = yield* canonicalizeTeleportCwd(project.value.workspaceRoot);
          const settings = yield* settingsService.getSettings.pipe(
            Effect.mapError(
              (cause) =>
                new TeleportNativeWriteError({
                  nativePath: cwd,
                  message: "Server settings could not be read for teleport export.",
                  cause,
                }),
            ),
          );
          const homes = yield* resolveTeleportHomes(settings);
          const now = yield* nowIso;
          const existingExternalId = Option.isSome(binding)
            ? readTeleportExternalSessionId({
                provider: driverKind,
                resumeCursor: binding.value.resumeCursor,
                runtimePayload: binding.value.runtimePayload,
              })
            : undefined;
          const externalSessionId = existingExternalId ?? (yield* nextId());
          const messages = capMessages(orchestrationToNative(thread.value.messages));
          const nativeSession: ParsedNativeSession = {
            provider,
            externalSessionId,
            cwd,
            nativePath: "",
            nativeFormatVersion: TELEPORT_NATIVE_FORMAT_VERSION,
            title: thread.value.title,
            createdAt: thread.value.createdAt,
            updatedAt: now,
            messages,
          };

          const path = yield* Path.Path;
          const existingNativePath =
            Option.isSome(binding) &&
            binding.value.runtimePayload &&
            typeof binding.value.runtimePayload === "object" &&
            binding.value.runtimePayload !== null &&
            "teleport" in binding.value.runtimePayload &&
            typeof (binding.value.runtimePayload as { teleport?: { nativePath?: unknown } })
              .teleport?.nativePath === "string"
              ? (binding.value.runtimePayload as { teleport: { nativePath: string } }).teleport
                  .nativePath
              : undefined;

          let nativePath: string;
          switch (provider) {
            case "codex": {
              nativePath =
                existingNativePath ??
                allocateCodexSessionPath({
                  sessionsRoot: homes.codexSessionsRoot,
                  sessionId: externalSessionId,
                  createdAt: thread.value.createdAt,
                  join: path.join,
                });
              const contents = serializeCodexSession({ ...nativeSession, nativePath });
              yield* writeNativeSessionAtomically({
                filePath: nativePath,
                contents,
                verify: (written) =>
                  parseCodexSessionContents({ contents: written, nativePath }).pipe(
                    Effect.flatMap((parsed) =>
                      Option.isSome(parsed)
                        ? Effect.void
                        : new TeleportNativeWriteError({
                            nativePath,
                            message: `Exported Codex session failed verification: ${nativePath}`,
                          }),
                    ),
                    Effect.mapError((error) =>
                      error._tag === "TeleportSchemaVersionError"
                        ? new TeleportNativeWriteError({
                            nativePath,
                            message: error.message,
                            cause: error,
                          })
                        : error,
                    ),
                  ),
              });
              break;
            }
            case "claudeAgent": {
              nativePath =
                existingNativePath ??
                allocateClaudeSessionPath({
                  projectsRoot: homes.claudeProjectsRoot,
                  cwd,
                  sessionId: externalSessionId,
                  join: path.join,
                });
              const contents = serializeClaudeSession({ ...nativeSession, nativePath });
              yield* writeNativeSessionAtomically({
                filePath: nativePath,
                contents,
                verify: (written) =>
                  parseClaudeSessionContents({ contents: written, nativePath }).pipe(
                    Effect.flatMap((parsed) =>
                      Option.isSome(parsed)
                        ? Effect.void
                        : new TeleportNativeWriteError({
                            nativePath,
                            message: `Exported Claude session failed verification: ${nativePath}`,
                          }),
                    ),
                    Effect.mapError((error) =>
                      error._tag === "TeleportSchemaVersionError"
                        ? new TeleportNativeWriteError({
                            nativePath,
                            message: error.message,
                            cause: error,
                          })
                        : error,
                    ),
                  ),
              });
              break;
            }
            case "opencode": {
              yield* requireNativePathUnlocked(homes.opencodeRoot);
              nativePath = yield* writeOpenCodeSession({
                opencodeRoot: homes.opencodeRoot,
                session: { ...nativeSession, nativePath: homes.opencodeRoot },
              });
              break;
            }
            case "grok": {
              nativePath =
                existingNativePath ??
                allocateGrokSessionPath({
                  sessionsRoot: homes.grokSessionsRoot,
                  sessionId: externalSessionId,
                  join: path.join,
                });
              const contents = serializeGrokSession({ ...nativeSession, nativePath });
              yield* writeNativeSessionAtomically({
                filePath: nativePath,
                contents,
                verify: (written) =>
                  parseGrokSessionContents({ contents: written, nativePath }).pipe(
                    Effect.flatMap((parsed) =>
                      Option.isSome(parsed)
                        ? Effect.void
                        : new TeleportNativeWriteError({
                            nativePath,
                            message: `Exported Grok session failed verification: ${nativePath}`,
                          }),
                    ),
                    Effect.mapError((error) =>
                      error._tag === "TeleportSchemaVersionError"
                        ? new TeleportNativeWriteError({
                            nativePath,
                            message: error.message,
                            cause: error,
                          })
                        : error,
                    ),
                  ),
              });
              break;
            }
            default: {
              const _exhaustive: never = provider;
              return _exhaustive;
            }
          }

          const teleportPayload: TeleportRuntimePayload = {
            schemaVersion: TELEPORT_SCHEMA_VERSION,
            externalSessionId,
            nativePath,
            lastSyncDirection: "export",
            lastSyncedAt: now,
            nativeFormatVersion: TELEPORT_NATIVE_FORMAT_VERSION,
          };
          yield* directory
            .upsert({
              threadId: input.threadId,
              provider: driverKind,
              providerInstanceId:
                Option.getOrUndefined(binding)?.providerInstanceId ??
                defaultInstanceIdForDriver(driverKind),
              status: "stopped",
              resumeCursor: buildTeleportResumeCursor({ provider, externalSessionId }),
              runtimePayload: { teleport: teleportPayload },
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new TeleportNativeWriteError({
                    nativePath,
                    message: "Failed to bind the exported native session.",
                    cause,
                  }),
              ),
            );

          return {
            schemaVersion: TELEPORT_SCHEMA_VERSION,
            provider,
            providerInstanceId: defaultInstanceIdForDriver(driverKind),
            externalSessionId,
            nativePath,
            cwd,
          };
        }),
      );

    return TeleportService.of({
      listSessions,
      importSessions,
      exportSession,
    });
  }),
);
