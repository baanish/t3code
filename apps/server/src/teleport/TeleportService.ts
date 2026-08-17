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
  resolveTeleportPresence,
  type ModelSelection,
  type OrchestrationMessage,
  type ProviderInstanceId,
  type TeleportExportError,
  type TeleportExportSessionInput,
  type TeleportExportSessionResult,
  type TeleportImportedSession,
  type TeleportImportError,
  type TeleportImportSessionsInput,
  type TeleportImportSessionsResult,
  type TeleportListSessionsError,
  type TeleportListSessionsInput,
  type TeleportListSessionsResult,
  type TeleportProvider,
  type TeleportRuntimePayload,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import { resolveThreadWorkspaceCwd } from "../checkpointing/Utils.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { canReplaceThreadTitle } from "../orchestration/threadTitles.ts";
import * as ProcessRunner from "../processRunner.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import * as ServerSettings from "../serverSettings.ts";
import { resolveTeleportCwdPath, teleportCwdsEquivalent } from "./cwd.ts";
import { discoverTeleportSessions, loadTeleportSession } from "./discovery.ts";
import * as TeleportFormatRegistry from "./formats/registry.ts";
import { resolveTeleportHomes, type TeleportHomes } from "./homes.ts";
import { firstUserTitle, truncateTitle } from "./json.ts";
import {
  buildTeleportResumeCursor,
  readTeleportExternalSessionId,
  readTeleportRuntimePayload,
  teleportThreadStateFromPayload,
  toTeleportProvider,
} from "./resumeCursors.ts";
import {
  MAX_TELEPORT_MESSAGE_CHARS,
  MAX_TELEPORT_MESSAGES,
  nativeTextMessage,
  type NativeTextMessage,
  type ParsedNativeSession,
} from "./types.ts";

export class TeleportService extends Context.Service<
  TeleportService,
  {
    readonly listSessions: (
      input: TeleportListSessionsInput,
    ) => Effect.Effect<TeleportListSessionsResult, TeleportListSessionsError>;

    readonly importSessions: (
      input: TeleportImportSessionsInput,
    ) => Effect.Effect<TeleportImportSessionsResult, TeleportImportError>;

    readonly exportSession: (
      input: TeleportExportSessionInput,
    ) => Effect.Effect<TeleportExportSessionResult, TeleportExportError>;
  }
>()("t3/teleport/TeleportService") {}

function modelSelectionForProvider(
  provider: TeleportProvider,
  instanceId?: ProviderInstanceId,
): ModelSelection {
  const driver = ProviderDriverKind.make(provider);
  return {
    instanceId: instanceId ?? defaultInstanceIdForDriver(driver),
    model: DEFAULT_MODEL_BY_PROVIDER[driver] ?? DEFAULT_MODEL,
  };
}

function capMessages(messages: ReadonlyArray<NativeTextMessage>): NativeTextMessage[] {
  return messages.slice(-MAX_TELEPORT_MESSAGES).map((message) =>
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
    id: MessageId.make(ids[index] ?? `${index}`),
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
      nativeTextMessage({
        role: message.role,
        text: message.text,
        createdAt: message.createdAt,
        id: message.id,
      }),
    ];
  });
}

function allocateExportSessionId(
  existingPayload: TeleportRuntimePayload | undefined,
  nextUuid: string,
): string {
  return existingPayload?.externalSessionId ?? nextUuid;
}

function isBusySessionStatus(status: string | undefined): boolean {
  return status === "starting" || status === "running";
}

export const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const directory = yield* ProviderSessionDirectory;
  const instanceRegistry = yield* ProviderInstanceRegistry;
  const providerService = yield* ProviderService;
  const crypto = yield* Crypto.Crypto;
  const formats = yield* TeleportFormatRegistry.TeleportFormatRegistry;
  const nativeContext = yield* Effect.context<
    | FileSystem.FileSystem
    | Path.Path
    | TeleportFormatRegistry.TeleportFormatRegistry
    | ProcessRunner.ProcessRunner
  >();
  const provideNative = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      | FileSystem.FileSystem
      | Path.Path
      | TeleportFormatRegistry.TeleportFormatRegistry
      | ProcessRunner.ProcessRunner
    >,
  ): Effect.Effect<A, E> => effect.pipe(Effect.provideContext(nativeContext));

  const nextId = () => crypto.randomUUIDv4;
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const inFlight = new Set<string>();
  const alreadyInFlightError = () =>
    new TeleportInvalidInputError({
      reason: "Teleport already in progress for this session.",
    });
  const withInFlight = <A, E, R = never>(
    keys: string[],
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | TeleportInvalidInputError, R> =>
    Effect.suspend((): Effect.Effect<A, E | TeleportInvalidInputError, R> => {
      for (const key of keys) {
        if (inFlight.has(key)) {
          return alreadyInFlightError();
        }
      }
      for (const key of keys) {
        inFlight.add(key);
      }
      return effect.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            for (const key of keys) {
              inFlight.delete(key);
            }
          }),
        ),
      );
    });
  const claimExtraInFlight = (keys: string[], extra: string) =>
    Effect.suspend((): Effect.Effect<void, TeleportInvalidInputError> => {
      if (keys.includes(extra)) {
        return Effect.void;
      }
      if (inFlight.has(extra)) {
        return alreadyInFlightError();
      }
      inFlight.add(extra);
      keys.push(extra);
      return Effect.void;
    });

  const requireParsedSessionUnlocked = (parsed: ParsedNativeSession, homes: TeleportHomes) => {
    const adapter = formats.get(parsed.provider);
    if (!adapter) {
      return new TeleportUnsupportedProviderError({
        provider: ProviderDriverKind.make(parsed.provider),
        message: `Teleport does not support provider '${parsed.provider}'.`,
      });
    }
    return adapter.requireUnlocked({
      homes,
      nativePath: parsed.nativePath,
    });
  };

  const stopThreadProviderSession = (threadId: ThreadId) =>
    providerService.stopSession({ threadId }).pipe(
      Effect.catchTags({
        ProviderValidationError: (error) =>
          Effect.logDebug("teleport.stop-session-skipped", {
            threadId,
            reason: error._tag,
          }),
        ProviderSessionNotFoundError: (error) =>
          Effect.logDebug("teleport.stop-session-skipped", {
            threadId,
            reason: error._tag,
          }),
        ProviderAdapterSessionNotFoundError: (error) =>
          Effect.logDebug("teleport.stop-session-skipped", {
            threadId,
            reason: error._tag,
          }),
      }),
      Effect.mapError(
        (cause) =>
          new TeleportInvalidInputError({
            reason: "Failed to stop the T3 provider session.",
            cause,
          }),
      ),
    );

  const listSessions = (input: TeleportListSessionsInput) =>
    provideNative(
      Effect.gen(function* () {
        const cwd = yield* resolveTeleportCwdPath(input.cwd);
        const settings = yield* settingsService.getSettings.pipe(
          Effect.mapError(
            (cause) =>
              new TeleportDiscoveryError({
                reason: "Server settings could not be read for teleport discovery.",
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

  const importSessions = (input: TeleportImportSessionsInput) => {
    const inFlightKeys = input.sessions.map(
      (session) => `session:${session.provider}:${session.externalSessionId}`,
    );
    return withInFlight(
      inFlightKeys,
      provideNative(
        Effect.gen(function* () {
          const project = yield* snapshotQuery.getProjectShellById(input.projectId).pipe(
            Effect.mapError(
              (cause) =>
                new TeleportProjectResolutionError({
                  reason: "Failed to load the target project.",
                  cause,
                }),
            ),
          );
          if (Option.isNone(project)) {
            return yield* new TeleportProjectResolutionError({
              reason: `Project '${input.projectId}' was not found.`,
            });
          }
          const cwd = yield* resolveTeleportCwdPath(input.cwd);
          if (!(yield* teleportCwdsEquivalent(project.value.workspaceRoot, cwd))) {
            return yield* new TeleportInvalidInputError({
              reason: "Import cwd must match the selected project's workspace root.",
            });
          }
          const seenRefs = new Set<string>();
          for (const ref of input.sessions) {
            const key = `${ref.provider}:${ref.providerInstanceId ?? ""}:${ref.externalSessionId}`;
            if (seenRefs.has(key)) {
              return yield* new TeleportInvalidInputError({
                reason: `Duplicate session '${ref.externalSessionId}' in the import batch.`,
              });
            }
            seenRefs.add(key);
          }

          const settings = yield* settingsService.getSettings.pipe(
            Effect.mapError(
              (cause) =>
                new TeleportDiscoveryError({
                  reason: "Server settings could not be read for teleport import.",
                  cause,
                }),
            ),
          );
          const homes = yield* resolveTeleportHomes(settings);
          const bindings = yield* directory.listBindings().pipe(
            Effect.mapError(
              (cause) =>
                new TeleportDiscoveryError({
                  reason: "Failed to read provider session bindings.",
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
              ...(ref.providerInstanceId === undefined
                ? {}
                : { providerInstanceId: ref.providerInstanceId }),
              ...(ref.nativePath === undefined ? {} : { nativePath: ref.nativePath }),
            });
            yield* requireParsedSessionUnlocked(parsed, homes);
            parsedSessions.push({
              ...parsed,
              messages: capMessages(parsed.messages),
            });
          }

          const imported: TeleportImportedSession[] = [];
          const now = yield* nowIso;

          for (const parsed of parsedSessions) {
            const driver = ProviderDriverKind.make(parsed.provider);
            let existingThreadId: ThreadId | undefined;
            let existingProjectId = input.projectId;
            let existingArchived = false;
            let existingProviderInstanceId: (typeof bindings)[number]["providerInstanceId"];
            for (const binding of bindings) {
              if (binding.provider !== driver) {
                continue;
              }
              const externalSessionId = readTeleportExternalSessionId({
                provider: binding.provider,
                resumeCursor: binding.resumeCursor,
                runtimePayload: binding.runtimePayload,
                adapter: isTeleportProvider(binding.provider)
                  ? formats.get(binding.provider)
                  : undefined,
              });
              if (externalSessionId !== parsed.externalSessionId) {
                continue;
              }
              const expectedInstanceId =
                parsed.providerInstanceId ?? defaultInstanceIdForDriver(driver);
              if (binding.providerInstanceId !== expectedInstanceId) {
                continue;
              }
              const shell = yield* snapshotQuery.getThreadShellById(binding.threadId).pipe(
                Effect.mapError(
                  (cause) =>
                    new TeleportDiscoveryError({
                      reason: "Failed to load an existing teleport thread.",
                      cause,
                    }),
                ),
              );
              if (Option.isNone(shell)) {
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
              if (shell.value.archivedAt !== null) {
                existingArchived = true;
              }
              existingThreadId = binding.threadId;
              existingProjectId = shell.value.projectId;
              existingProviderInstanceId = binding.providerInstanceId;
              if (isBusySessionStatus(shell.value.session?.status)) {
                return yield* new TeleportInvalidInputError({
                  reason: `Cannot import while T3 session '${parsed.externalSessionId}' is running.`,
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
              yield* claimExtraInFlight(inFlightKeys, `thread:${threadId}`);
              const latest = yield* snapshotQuery.getThreadDetailById(threadId).pipe(
                Effect.mapError(
                  (cause) =>
                    new TeleportDiscoveryError({
                      reason: "Failed to load the existing thread for in-place import.",
                      cause,
                    }),
                ),
              );
              if (Option.isNone(latest)) {
                return yield* new TeleportDiscoveryError({
                  reason: `Thread '${threadId}' was not found for in-place import.`,
                });
              }
              if (isBusySessionStatus(latest.value.session?.status)) {
                return yield* new TeleportInvalidInputError({
                  reason: `Cannot import while T3 session '${parsed.externalSessionId}' is running.`,
                });
              }
              yield* stopThreadProviderSession(threadId);
              if (
                parsed.messages.length === 0 &&
                orchestrationToNative(latest.value.messages).length > 0
              ) {
                return yield* new TeleportInvalidInputError({
                  reason: "Native session has no messages; refusing to wipe this thread.",
                });
              }
              if (existingArchived) {
                yield* engine
                  .dispatch({
                    type: "thread.unarchive",
                    commandId: CommandId.make(yield* nextId()),
                    threadId,
                  })
                  .pipe(
                    Effect.mapError(
                      (cause) =>
                        new TeleportInvalidInputError({
                          reason: "Failed to unarchive the existing teleport thread.",
                          cause,
                        }),
                    ),
                  );
              }
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
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new TeleportInvalidInputError({
                        reason: "Failed to replace thread history.",
                        cause,
                      }),
                  ),
                );
              if (canReplaceThreadTitle(latest.value.title)) {
                yield* engine
                  .dispatch({
                    type: "thread.meta.update",
                    commandId: CommandId.make(yield* nextId()),
                    threadId,
                    title,
                  })
                  .pipe(
                    Effect.mapError(
                      (cause) =>
                        new TeleportInvalidInputError({
                          reason: "Failed to update imported thread title.",
                          cause,
                        }),
                    ),
                  );
              }
            } else {
              threadId = ThreadId.make(yield* nextId());
              yield* engine
                .dispatch({
                  type: "thread.create",
                  commandId: CommandId.make(yield* nextId()),
                  threadId,
                  projectId: input.projectId,
                  title,
                  modelSelection: modelSelectionForProvider(
                    parsed.provider,
                    parsed.providerInstanceId,
                  ),
                  runtimeMode: DEFAULT_RUNTIME_MODE,
                  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
                  branch: null,
                  worktreePath: null,
                  createdAt: now,
                })
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new TeleportInvalidInputError({
                        reason: "Failed to create an imported thread.",
                        cause,
                      }),
                  ),
                );
              yield* engine
                .dispatch({
                  type: "thread.history.replace",
                  commandId: CommandId.make(yield* nextId()),
                  threadId,
                  messages,
                  createdAt: now,
                })
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new TeleportInvalidInputError({
                        reason: "Failed to write imported thread history.",
                        cause,
                      }),
                  ),
                );
            }

            const providerInstanceId =
              existingProviderInstanceId ??
              parsed.providerInstanceId ??
              defaultInstanceIdForDriver(driver);
            const teleportPayload: TeleportRuntimePayload = {
              schemaVersion: TELEPORT_SCHEMA_VERSION,
              externalSessionId: parsed.externalSessionId,
              nativePath: parsed.nativePath,
              lastSyncDirection: "import",
              lastSyncedAt: now,
              nativeFormatVersion: parsed.nativeFormatVersion,
              presence: "t3",
            };
            yield* directory
              .upsert({
                threadId,
                provider: driver,
                providerInstanceId,
                status: "stopped",
                resumeCursor: buildTeleportResumeCursor({
                  provider: parsed.provider,
                  externalSessionId: parsed.externalSessionId,
                  adapter: formats.get(parsed.provider),
                }),
                runtimePayload: { teleport: teleportPayload },
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new TeleportDiscoveryError({
                      reason: "Failed to bind the imported native session.",
                      cause,
                    }),
                ),
              );
            yield* engine
              .dispatch({
                type: "thread.teleport.set",
                commandId: CommandId.make(yield* nextId()),
                threadId,
                teleport: teleportThreadStateFromPayload({
                  provider: parsed.provider,
                  providerInstanceId,
                  payload: teleportPayload,
                }),
                createdAt: now,
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new TeleportInvalidInputError({
                      reason: "Failed to persist teleport presence.",
                      cause,
                    }),
                ),
              );

            imported.push({
              threadId,
              projectId: existingProjectId,
              provider: parsed.provider,
              providerInstanceId,
              externalSessionId: parsed.externalSessionId,
              updatedInPlace,
            });
          }

          return {
            schemaVersion: TELEPORT_SCHEMA_VERSION,
            imported,
          };
        }),
      ).pipe(
        Effect.catchTags({
          PlatformError: (cause: PlatformError.PlatformError) =>
            new TeleportDiscoveryError({
              reason: "Native filesystem error during teleport import.",
              cause,
            }),
        }),
      ),
    );
  };

  const exportSession = (input: TeleportExportSessionInput) => {
    const inFlightKeys = [`thread:${input.threadId}`];
    return withInFlight(
      inFlightKeys,
      provideNative(
        Effect.gen(function* () {
          const thread = yield* snapshotQuery.getThreadDetailById(input.threadId).pipe(
            Effect.mapError(
              (cause) =>
                new TeleportInvalidInputError({
                  reason: "Failed to load the thread for export.",
                  cause,
                }),
            ),
          );
          if (Option.isNone(thread)) {
            return yield* new TeleportInvalidInputError({
              reason: `Thread '${input.threadId}' was not found.`,
            });
          }
          if (isBusySessionStatus(thread.value.session?.status)) {
            return yield* new TeleportInvalidInputError({
              reason: "Cannot export while this T3 session is running.",
            });
          }

          const project = yield* snapshotQuery.getProjectShellById(thread.value.projectId).pipe(
            Effect.mapError(
              (cause) =>
                new TeleportProjectResolutionError({
                  reason: "Failed to load the thread's project.",
                  cause,
                }),
            ),
          );
          if (Option.isNone(project)) {
            return yield* new TeleportProjectResolutionError({
              reason: "The thread's project was not found.",
            });
          }

          const binding = yield* directory.getBinding(input.threadId).pipe(
            Effect.mapError(
              (cause) =>
                new TeleportInvalidInputError({
                  reason: "Failed to read the thread's provider binding.",
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
              reason: "Teleport export could not resolve a supported provider for this thread.",
            });
          }
          const provider = yield* toTeleportProvider(driverKind);
          const existingPayload = Option.isSome(binding)
            ? readTeleportRuntimePayload(binding.value.runtimePayload)
            : undefined;
          if (resolveTeleportPresence(existingPayload) === "native") {
            return yield* new TeleportInvalidInputError({
              reason: "This thread is already in the native CLI. Import it before exporting again.",
            });
          }

          yield* stopThreadProviderSession(input.threadId);
          const now = yield* nowIso;
          yield* engine
            .dispatch({
              type: "thread.session.stop",
              commandId: CommandId.make(yield* nextId()),
              threadId: input.threadId,
              createdAt: now,
            })
            .pipe(
              Effect.catch(() =>
                Effect.logDebug("teleport.export.session-stop-dispatch-skipped", {
                  threadId: input.threadId,
                }),
              ),
            );

          const settings = yield* settingsService.getSettings.pipe(
            Effect.mapError(
              (cause) =>
                new TeleportNativeWriteError({
                  nativePath: project.value.workspaceRoot,
                  message: "Server settings could not be read for teleport export.",
                  cause,
                }),
            ),
          );
          const homes = yield* resolveTeleportHomes(settings);
          const existingNativePath = existingPayload?.nativePath;
          const externalSessionId = allocateExportSessionId(existingPayload, yield* nextId());
          yield* claimExtraInFlight(inFlightKeys, `session:${provider}:${externalSessionId}`);
          const providerInstanceId =
            Option.getOrUndefined(binding)?.providerInstanceId ??
            thread.value.modelSelection.instanceId;
          const latest = yield* snapshotQuery.getThreadDetailById(input.threadId).pipe(
            Effect.mapError(
              (cause) =>
                new TeleportInvalidInputError({
                  reason: "Failed to re-check the thread before export.",
                  cause,
                }),
            ),
          );
          if (Option.isNone(latest)) {
            return yield* new TeleportInvalidInputError({
              reason: `Thread '${input.threadId}' was not found.`,
            });
          }
          if (isBusySessionStatus(latest.value.session?.status)) {
            return yield* new TeleportInvalidInputError({
              reason: "Cannot export while this T3 session is running.",
            });
          }
          const cwdSource =
            resolveThreadWorkspaceCwd({
              thread: latest.value,
              projects: [project.value],
            }) ?? project.value.workspaceRoot;
          const cwd = yield* resolveTeleportCwdPath(cwdSource);
          const messages = capMessages(orchestrationToNative(latest.value.messages));
          const pendingNativePath =
            existingNativePath ?? `teleport-pending:${provider}:${externalSessionId}`;
          const pendingPayload: TeleportRuntimePayload = {
            schemaVersion: TELEPORT_SCHEMA_VERSION,
            externalSessionId,
            nativePath: pendingNativePath,
            lastSyncDirection: "export",
            lastSyncedAt: now,
            nativeFormatVersion: TELEPORT_NATIVE_FORMAT_VERSION,
            presence: "native",
          };
          yield* engine
            .dispatch({
              type: "thread.teleport.set",
              commandId: CommandId.make(yield* nextId()),
              threadId: input.threadId,
              teleport: teleportThreadStateFromPayload({
                provider,
                providerInstanceId,
                payload: pendingPayload,
              }),
              createdAt: now,
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new TeleportInvalidInputError({
                    reason: "Failed to persist teleport presence.",
                    cause,
                  }),
              ),
            );

          const revertExportPresence = engine
            .dispatch({
              type: "thread.teleport.set",
              commandId: CommandId.make(yield* nextId()),
              threadId: input.threadId,
              teleport: teleportThreadStateFromPayload({
                provider,
                providerInstanceId,
                payload: existingPayload
                  ? { ...existingPayload, presence: "t3" }
                  : { ...pendingPayload, presence: "t3" },
              }),
              createdAt: now,
            })
            .pipe(
              Effect.catch(() =>
                Effect.logDebug("teleport.export.presence-revert-skipped", {
                  threadId: input.threadId,
                }),
              ),
            );

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
            providerInstanceId,
          };

          const adapter = formats.get(provider);
          if (!adapter) {
            yield* revertExportPresence;
            return yield* new TeleportUnsupportedProviderError({
              provider: driverKind,
              message: `Teleport does not support provider '${provider}'.`,
            });
          }
          const nativePath = yield* adapter
            .write({
              homes,
              session: nativeSession,
              ...(existingNativePath !== undefined ? { existingNativePath } : {}),
            })
            .pipe(Effect.tapError(() => revertExportPresence));

          const teleportPayload: TeleportRuntimePayload = {
            schemaVersion: TELEPORT_SCHEMA_VERSION,
            externalSessionId,
            nativePath,
            lastSyncDirection: "export",
            lastSyncedAt: now,
            nativeFormatVersion: TELEPORT_NATIVE_FORMAT_VERSION,
            presence: "native",
          };
          yield* directory
            .upsert({
              threadId: input.threadId,
              provider: driverKind,
              providerInstanceId,
              status: "stopped",
              resumeCursor: buildTeleportResumeCursor({
                provider,
                externalSessionId,
                adapter,
              }),
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
          yield* engine
            .dispatch({
              type: "thread.teleport.set",
              commandId: CommandId.make(yield* nextId()),
              threadId: input.threadId,
              teleport: teleportThreadStateFromPayload({
                provider,
                providerInstanceId,
                payload: teleportPayload,
              }),
              createdAt: now,
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new TeleportInvalidInputError({
                    reason: "Failed to persist teleport presence.",
                    cause,
                  }),
              ),
            );

          return {
            schemaVersion: TELEPORT_SCHEMA_VERSION,
            provider,
            providerInstanceId,
            externalSessionId,
            nativePath,
            cwd,
          };
        }),
      ).pipe(
        Effect.catchTags({
          PlatformError: (cause: PlatformError.PlatformError) =>
            new TeleportNativeWriteError({
              nativePath: "native session",
              message: "Native filesystem error during teleport export.",
              cause,
            }),
        }),
      ),
    );
  };

  return TeleportService.of({
    listSessions,
    importSessions,
    exportSession,
  });
});

export const layer = Layer.effect(TeleportService, make).pipe(
  Layer.provide(TeleportFormatRegistry.layer),
  Layer.provide(ProcessRunner.layer),
);
