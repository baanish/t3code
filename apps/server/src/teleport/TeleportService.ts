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
  TeleportNativeDivergenceError,
  TeleportNativeWriteError,
  TeleportUnsupportedProviderError,
  teleportNativeRevisionBlocksMutation,
  ThreadId,
  defaultInstanceIdForDriver,
  isCanonicalTeleportBinding,
  isTeleportProvider,
  resolveTeleportPresence,
  type ModelSelection,
  type OrchestrationMessage,
  type ProjectId,
  type ProviderInstanceId,
  type TeleportCheckNativeRevisionError,
  type TeleportCheckNativeRevisionInput,
  type TeleportCheckNativeRevisionResult,
  type TeleportExportError,
  type TeleportExportSessionInput,
  type TeleportExportSessionResult,
  type TeleportForkNativeDivergenceError,
  type TeleportForkNativeDivergenceInput,
  type TeleportForkNativeDivergenceResult,
  type TeleportImportedSession,
  type TeleportImportError,
  type TeleportImportSessionsInput,
  type TeleportImportSessionsResult,
  type TeleportListSessionsError,
  type TeleportListSessionsInput,
  type TeleportListSessionsResult,
  type TeleportProvider,
  type TeleportRuntimePayload,
  type TeleportThreadState,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";

import { resolveThreadWorkspaceCwd } from "../checkpointing/Utils.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { canReplaceThreadTitle } from "../orchestration/threadTitles.ts";
import * as ProcessRunner from "../processRunner.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  normalizeTeleportCwd,
  resolveTeleportCwdPath,
  teleportCwdsEquivalent,
  uniqueTeleportCwds,
} from "./cwd.ts";
import { discoverTeleportSessions, loadTeleportSession } from "./discovery.ts";
import {
  isPendingTeleportNativePath,
  pendingTeleportNativePath,
  recoveredInterruptedExportState,
  teleportExportPresenceOnFailure,
} from "./exportPresence.ts";
import * as TeleportFormatRegistry from "./formats/registry.ts";
import { resolveTeleportHomes, type TeleportHomes } from "./homes.ts";
import { definedField, firstUserTitle, truncateTitle } from "./json.ts";
import {
  buildTeleportResumeCursor,
  readTeleportExternalSessionId,
  readTeleportRuntimePayload,
  teleportRuntimePayloadFromThreadState,
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
import {
  committedTeleportImportState,
  importingTeleportState,
  inPlaceImportPathIsCompatible,
  nativeTranscriptWouldWipeExistingHistory,
  importHistoryIsEmptyOrFenceOnly,
  recoverInterruptedImportTeleports,
  recoverLaggingDirectoryImportFinalize,
  retryStartupRecovery,
  restorePresenceForImport,
  revertDirectoryAfterFailedInPlaceImport,
  revertTeleportAfterFailedInPlaceImport,
  runInPlaceTeleportImport,
  runNewThreadTeleportImport,
} from "./importTransaction.ts";
import {
  classifyNativeRevision,
  findCoveringNativeFork,
  nativeForkThreadId,
  nativeRevisionCheckResult,
  nativeRevisionDivergenceError,
  nativeRevisionsEqual,
  observeNativeRevision,
  resolveNativeForkPlan,
  reuseNativeForkAfterCreateConflict,
  shouldWatchNativeRevision,
} from "./nativeRevision.ts";

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

    readonly checkNativeRevision: (
      input: TeleportCheckNativeRevisionInput,
    ) => Effect.Effect<TeleportCheckNativeRevisionResult, TeleportCheckNativeRevisionError>;

    readonly forkNativeDivergence: (
      input: TeleportForkNativeDivergenceInput,
    ) => Effect.Effect<TeleportForkNativeDivergenceResult, TeleportForkNativeDivergenceError>;

    readonly requireNativeRevisionForTurn: (
      threadId: ThreadId,
    ) => Effect.Effect<void, TeleportCheckNativeRevisionError | TeleportNativeDivergenceError>;
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
    | Crypto.Crypto
    | FileSystem.FileSystem
    | Path.Path
    | TeleportFormatRegistry.TeleportFormatRegistry
    | ProcessRunner.ProcessRunner
  >();
  const provideNative = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      | Crypto.Crypto
      | FileSystem.FileSystem
      | Path.Path
      | TeleportFormatRegistry.TeleportFormatRegistry
      | ProcessRunner.ProcessRunner
    >,
  ): Effect.Effect<A, E> => effect.pipe(Effect.provideContext(nativeContext));

  const nextId = () => crypto.randomUUIDv4;
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  // Process-local only. This Set is not visible to other server processes
  // or cluster replicas. Cross-process exclusion needs a shared store; do
  // not treat withInFlight as a distributed lock.
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
  const worktreeCwdsFromThreads = (
    threads: ReadonlyArray<{
      readonly projectId: ProjectId;
      readonly worktreePath: string | null;
    }>,
    projectId: ProjectId,
  ): string[] =>
    uniqueTeleportCwds(
      threads.flatMap((thread) => {
        if (thread.projectId !== projectId || thread.worktreePath === null) {
          return [];
        }
        if (normalizeTeleportCwd(thread.worktreePath) === "/") {
          return [];
        }
        return [thread.worktreePath];
      }),
    );
  const loadProjectWorktreeCwds = (projectId: ProjectId) =>
    Effect.all([snapshotQuery.getShellSnapshot(), snapshotQuery.getArchivedShellSnapshot()]).pipe(
      Effect.map(([active, archived]) =>
        uniqueTeleportCwds([
          ...worktreeCwdsFromThreads(active.threads, projectId),
          ...worktreeCwdsFromThreads(archived.threads, projectId),
        ]),
      ),
      Effect.mapError(
        (cause) =>
          new TeleportDiscoveryError({
            reason: "Failed to load project worktree paths for teleport.",
            cause,
          }),
      ),
    );
  /**
   * List discovery is scoped to a registered T3 project workspace (same contract
   * the UI already sends). Free-form ancestors such as `/` or `$HOME` must not
   * match every native CLI session on the host for a read-scoped client.
   */
  const loadWorkspaceWorktreeCwds = (cwd: string) =>
    Effect.all([snapshotQuery.getShellSnapshot(), snapshotQuery.getArchivedShellSnapshot()]).pipe(
      Effect.mapError(
        (cause) =>
          new TeleportDiscoveryError({
            reason: "Failed to load project worktree paths for teleport.",
            cause,
          }),
      ),
      Effect.flatMap(([active, archived]) =>
        Effect.gen(function* () {
          for (const project of active.projects) {
            if (yield* teleportCwdsEquivalent(project.workspaceRoot, cwd)) {
              return uniqueTeleportCwds([
                ...worktreeCwdsFromThreads(active.threads, project.id),
                ...worktreeCwdsFromThreads(archived.threads, project.id),
              ]);
            }
          }
          return yield* new TeleportInvalidInputError({
            reason: "List cwd must match a registered project's workspace root.",
          });
        }),
      ),
    );
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

  const dispatchTeleportClear = (input: {
    readonly threadId: ThreadId;
    readonly createdAt: string;
    readonly reason: string;
  }) =>
    nextId().pipe(
      Effect.flatMap((id) =>
        engine.dispatch({
          type: "thread.teleport.clear",
          commandId: CommandId.make(id),
          threadId: input.threadId,
          createdAt: input.createdAt,
        }),
      ),
      Effect.mapError(
        (cause) =>
          new TeleportInvalidInputError({
            reason: input.reason,
            cause,
          }),
      ),
      Effect.asVoid,
    );

  const dispatchTeleportSet = (input: {
    readonly threadId: ThreadId;
    readonly teleport: TeleportThreadState;
    readonly createdAt: string;
    readonly reason: string;
  }) =>
    nextId().pipe(
      Effect.flatMap((id) =>
        engine.dispatch({
          type: "thread.teleport.set",
          commandId: CommandId.make(id),
          threadId: input.threadId,
          teleport: input.teleport,
          createdAt: input.createdAt,
        }),
      ),
      Effect.mapError(
        (cause) =>
          new TeleportInvalidInputError({
            reason: input.reason,
            cause,
          }),
      ),
      Effect.asVoid,
    );

  const dispatchTeleportImport = (input: {
    readonly threadId: ThreadId;
    readonly teleport: TeleportThreadState;
    readonly messages: OrchestrationMessage[];
    readonly createdAt: string;
    readonly reason: string;
  }) =>
    nextId().pipe(
      Effect.flatMap((id) =>
        engine.dispatch({
          type: "thread.teleport.import",
          commandId: CommandId.make(id),
          threadId: input.threadId,
          teleport: input.teleport,
          messages: input.messages,
          createdAt: input.createdAt,
        }),
      ),
      Effect.mapError(
        (cause) =>
          new TeleportInvalidInputError({
            reason: input.reason,
            cause,
          }),
      ),
      Effect.asVoid,
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
        const extraCwds = yield* loadWorkspaceWorktreeCwds(cwd);
        return yield* discoverTeleportSessions({
          homes,
          cwd,
          ...definedField("extraCwds", extraCwds.length > 0 ? extraCwds : undefined),
          ...(input.providers ? { providers: input.providers } : {}),
        });
      }),
    );

  const importSessions = (input: TeleportImportSessionsInput) => {
    // Load and unlock every session before any thread is committed so a
    // missing file, parse error, unsupported provider, or CLI lock aborts
    // the batch with zero imports. Sequential commit still retains earlier
    // sessions if a later identity or persist step fails.
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
            const instanceId =
              ref.providerInstanceId ??
              defaultInstanceIdForDriver(ProviderDriverKind.make(ref.provider));
            const key = `${ref.provider}:${instanceId}:${ref.externalSessionId}`;
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
          const extraCwds = yield* loadProjectWorktreeCwds(input.projectId);
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
            const loaded = yield* loadTeleportSession({
              homes,
              provider: ref.provider,
              externalSessionId: ref.externalSessionId,
              cwd,
              ...definedField("extraCwds", extraCwds.length > 0 ? extraCwds : undefined),
              ...(ref.providerInstanceId === undefined
                ? {}
                : { providerInstanceId: ref.providerInstanceId }),
              ...(ref.nativePath === undefined ? {} : { nativePath: ref.nativePath }),
            });
            yield* requireParsedSessionUnlocked(loaded, homes);
            parsedSessions.push({
              ...loaded,
              messages: capMessages(loaded.messages),
            });
          }

          const imported: TeleportImportedSession[] = [];
          const now = yield* nowIso;
          const [activeShell, archivedShell] = yield* Effect.all([
            snapshotQuery.getShellSnapshot().pipe(
              Effect.mapError(
                (cause) =>
                  new TeleportDiscoveryError({
                    reason: "Failed to load threads for teleport import.",
                    cause,
                  }),
              ),
            ),
            snapshotQuery.getArchivedShellSnapshot().pipe(
              Effect.mapError(
                (cause) =>
                  new TeleportDiscoveryError({
                    reason: "Failed to load archived threads for teleport import.",
                    cause,
                  }),
              ),
            ),
          ]);
          const importThreadShells = [...activeShell.threads, ...archivedShell.threads];

          for (const parsed of parsedSessions) {
            const driver = ProviderDriverKind.make(parsed.provider);
            let existingThreadId: ThreadId | undefined;
            let existingProjectId = input.projectId;
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
              if (
                !inPlaceImportPathIsCompatible({
                  parsedNativePath: parsed.nativePath,
                  existingNativePath: readTeleportRuntimePayload(binding.runtimePayload)
                    ?.nativePath,
                })
              ) {
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
                });
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

            if (existingThreadId === undefined) {
              for (const shell of importThreadShells) {
                const teleport = shell.teleport;
                if (
                  teleport == null ||
                  !isCanonicalTeleportBinding(teleport) ||
                  teleport.provider !== parsed.provider ||
                  teleport.externalSessionId !== parsed.externalSessionId
                ) {
                  continue;
                }
                const expectedInstanceId =
                  parsed.providerInstanceId ?? defaultInstanceIdForDriver(driver);
                if (
                  teleport.providerInstanceId !== undefined &&
                  teleport.providerInstanceId !== expectedInstanceId
                ) {
                  continue;
                }
                if (
                  !inPlaceImportPathIsCompatible({
                    parsedNativePath: parsed.nativePath,
                    existingNativePath: teleport.nativePath,
                  })
                ) {
                  continue;
                }
                if (shell.projectId !== input.projectId) {
                  return yield* new TeleportIdentityConflictError({
                    provider: parsed.provider,
                    externalSessionId: parsed.externalSessionId,
                    existingThreadId: shell.id,
                    existingProjectId: shell.projectId,
                  });
                }
                existingThreadId = shell.id;
                existingProjectId = shell.projectId;
                existingProviderInstanceId =
                  teleport.providerInstanceId ?? existingProviderInstanceId;
                if (isBusySessionStatus(shell.session?.status)) {
                  return yield* new TeleportInvalidInputError({
                    reason: `Cannot import while T3 session '${parsed.externalSessionId}' is running.`,
                  });
                }
                break;
              }
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
            const providerInstanceId =
              existingProviderInstanceId ??
              parsed.providerInstanceId ??
              defaultInstanceIdForDriver(driver);
            const nativeRevision = parsed.nativeRevision;
            const revisionBeforeCommit = yield* observeNativeRevision(parsed.nativePath);
            if (
              nativeRevision === undefined ||
              revisionBeforeCommit.status !== "observed" ||
              !nativeRevisionsEqual(nativeRevision, revisionBeforeCommit.revision)
            ) {
              return yield* new TeleportDiscoveryError({
                reason: `Native ${parsed.provider} session '${parsed.externalSessionId}' changed during import. Retry the import.`,
              });
            }
            const teleportPayload: TeleportRuntimePayload = {
              schemaVersion: TELEPORT_SCHEMA_VERSION,
              externalSessionId: parsed.externalSessionId,
              nativePath: parsed.nativePath,
              lastSyncDirection: "import",
              lastSyncedAt: now,
              nativeFormatVersion: parsed.nativeFormatVersion,
              presence: "t3",
              ...(nativeRevision === undefined ? {} : { nativeRevision }),
            };
            const persistDirectoryBinding = (
              boundThreadId: ThreadId,
              presence: TeleportRuntimePayload["presence"],
            ) =>
              directory
                .upsert({
                  threadId: boundThreadId,
                  provider: driver,
                  providerInstanceId,
                  status: "stopped",
                  resumeCursor: buildTeleportResumeCursor({
                    provider: parsed.provider,
                    externalSessionId: parsed.externalSessionId,
                    adapter: formats.get(parsed.provider),
                  }),
                  runtimePayload: {
                    teleport: {
                      ...teleportPayload,
                      ...(presence === undefined ? {} : { presence }),
                    },
                  },
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
            type ImportMutationError =
              | TeleportInvalidInputError
              | TeleportDiscoveryError
              | PlatformError.PlatformError;
            const committedTeleport = committedTeleportImportState(
              teleportThreadStateFromPayload({
                provider: parsed.provider,
                providerInstanceId,
                payload: teleportPayload,
              }),
            );

            if (threadId) {
              const inPlaceThreadId = threadId;
              yield* claimExtraInFlight(inFlightKeys, `thread:${inPlaceThreadId}`);
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
              if (
                nativeTranscriptWouldWipeExistingHistory({
                  nativeMessageCount: parsed.messages.length,
                  existingNativeMessageCount: orchestrationToNative(latest.value.messages).length,
                })
              ) {
                return yield* new TeleportInvalidInputError({
                  reason: "Native session has no messages; refusing to wipe this thread.",
                });
              }
              updatedInPlace = true;
              const previousBinding = yield* directory.getBinding(threadId).pipe(
                Effect.mapError(
                  (cause) =>
                    new TeleportDiscoveryError({
                      reason: "Failed to read the existing provider binding for in-place import.",
                      cause,
                    }),
                ),
              );
              const importingTeleport = importingTeleportState({
                base: committedTeleport,
                restorePresence: restorePresenceForImport(latest.value.teleport),
              });
              const revertedTeleport = revertTeleportAfterFailedInPlaceImport(
                latest.value.teleport,
              );
              const revertPresence = (() => {
                switch (revertedTeleport.action) {
                  case "clear":
                    return dispatchTeleportClear({
                      threadId,
                      createdAt: now,
                      reason: "Failed to revert teleport import presence.",
                    }).pipe(Effect.catch(() => Effect.void));
                  case "set":
                    return dispatchTeleportSet({
                      threadId,
                      teleport: revertedTeleport.teleport,
                      createdAt: now,
                      reason: "Failed to revert teleport import presence.",
                    }).pipe(Effect.catch(() => Effect.void));
                  default: {
                    const _exhaustive: never = revertedTeleport;
                    return _exhaustive;
                  }
                }
              })();
              const revertImporting = Effect.uninterruptible(
                revertPresence.pipe(
                  Effect.flatMap(() => {
                    const revertedDirectory = revertDirectoryAfterFailedInPlaceImport(
                      Option.getOrUndefined(previousBinding),
                    );
                    switch (revertedDirectory.action) {
                      case "delete":
                        return directory
                          .deleteByThreadId(inPlaceThreadId)
                          .pipe(Effect.catch(() => Effect.void));
                      case "restore":
                        return directory
                          .upsert(revertedDirectory.binding)
                          .pipe(Effect.catch(() => Effect.void));
                      default: {
                        const _exhaustive: never = revertedDirectory;
                        return _exhaustive;
                      }
                    }
                  }),
                ),
              );
              yield* runInPlaceTeleportImport<ImportMutationError>({
                beginImporting: dispatchTeleportSet({
                  threadId,
                  teleport: importingTeleport,
                  createdAt: now,
                  reason: "Failed to persist teleport import presence.",
                }),
                stopSession: stopThreadProviderSession(threadId),
                persistDirectory: persistDirectoryBinding(threadId, "importing"),
                commitOrchestration: dispatchTeleportImport({
                  threadId,
                  teleport: committedTeleport,
                  messages,
                  createdAt: now,
                  reason: "Failed to import native history.",
                }),
                finalizeDirectory: persistDirectoryBinding(threadId, "t3"),
                updateTitle: canReplaceThreadTitle(latest.value.title)
                  ? engine
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
                        Effect.asVoid,
                      )
                  : Effect.void,
                revertImporting,
              });
            } else {
              threadId = ThreadId.make(yield* nextId());
              const createdThreadId = threadId;
              const cleanupCommandId = CommandId.make(yield* nextId());
              const importingTeleport = importingTeleportState({
                base: committedTeleport,
                restorePresence: "t3",
              });
              yield* Effect.acquireUseRelease(
                engine
                  .dispatch({
                    type: "thread.create",
                    commandId: CommandId.make(yield* nextId()),
                    threadId: createdThreadId,
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
                  ),
                () =>
                  runNewThreadTeleportImport<ImportMutationError>({
                    beginImporting: dispatchTeleportSet({
                      threadId: createdThreadId,
                      teleport: importingTeleport,
                      createdAt: now,
                      reason: "Failed to persist teleport import presence.",
                    }),
                    commitOrchestration: dispatchTeleportImport({
                      threadId: createdThreadId,
                      teleport: committedTeleport,
                      messages,
                      createdAt: now,
                      reason: "Failed to write imported thread history.",
                    }),
                    finalizeDirectory: persistDirectoryBinding(createdThreadId, "t3"),
                  }),
                (_acquired, exit) => {
                  if (Exit.isSuccess(exit)) {
                    return Effect.void;
                  }
                  return engine
                    .dispatch({
                      type: "thread.delete",
                      commandId: cleanupCommandId,
                      threadId: createdThreadId,
                    })
                    .pipe(
                      Effect.catch(() =>
                        Effect.logWarning("teleport.import.created-thread-cleanup-skipped", {
                          threadId: createdThreadId,
                        }),
                      ),
                    );
                },
              );
            }

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
          const persistedPayload = Option.isSome(binding)
            ? readTeleportRuntimePayload(binding.value.runtimePayload)
            : undefined;
          const existingPayload =
            persistedPayload && isPendingTeleportNativePath(persistedPayload.nativePath)
              ? { ...persistedPayload, presence: "t3" as const }
              : persistedPayload;
          const threadTeleport = thread.value.teleport;
          const threadOwnsNativeSession =
            threadTeleport?.presence === "native" &&
            !isPendingTeleportNativePath(threadTeleport.nativePath);
          if (threadOwnsNativeSession || resolveTeleportPresence(existingPayload) === "native") {
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
                  stage: "read-settings",
                  cause,
                }),
            ),
          );
          const homes = yield* resolveTeleportHomes(settings);
          // Native files can contain tool calls, results, images, reasoning,
          // and provider metadata that T3's text projection intentionally
          // drops. Never replace an imported native file with that lossy
          // projection; each export gets a new native identity and path.
          const externalSessionId = yield* nextId();
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
          const messages = orchestrationToNative(latest.value.messages);
          if (messages.length === 0) {
            return yield* new TeleportInvalidInputError({
              reason: "Cannot export a thread with no user or assistant text.",
            });
          }
          const pendingNativePath = pendingTeleportNativePath(provider, externalSessionId);
          const pendingPayload: TeleportRuntimePayload = {
            schemaVersion: TELEPORT_SCHEMA_VERSION,
            externalSessionId,
            nativePath: pendingNativePath,
            lastSyncDirection: "export",
            lastSyncedAt: now,
            nativeFormatVersion: TELEPORT_NATIVE_FORMAT_VERSION,
            presence: "native",
          };
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
                  : threadTeleport && !isPendingTeleportNativePath(threadTeleport.nativePath)
                    ? {
                        ...teleportRuntimePayloadFromThreadState(threadTeleport, {
                          lastSyncDirection: "import",
                          nativeFormatVersion: TELEPORT_NATIVE_FORMAT_VERSION,
                        }),
                        presence: "t3",
                      }
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
          const persistExportedNative = (nativePath: string) => {
            const teleportPayload: TeleportRuntimePayload = {
              schemaVersion: TELEPORT_SCHEMA_VERSION,
              externalSessionId,
              nativePath,
              lastSyncDirection: "export",
              lastSyncedAt: now,
              nativeFormatVersion: TELEPORT_NATIVE_FORMAT_VERSION,
              presence: "native",
            };
            const adapter = formats.get(provider);
            return Effect.gen(function* () {
              if (adapter) {
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
                    Effect.catch(() =>
                      Effect.logWarning("teleport.export.binding-persist-on-failure", {
                        threadId: input.threadId,
                        nativePath,
                      }),
                    ),
                  );
              }
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
                  Effect.catch(() =>
                    Effect.logWarning("teleport.export.presence-persist-on-failure", {
                      threadId: input.threadId,
                      nativePath,
                    }),
                  ),
                );
            }).pipe(
              Effect.catchCause(() =>
                Effect.logWarning("teleport.export.persist-native-failed", {
                  threadId: input.threadId,
                  nativePath,
                }),
              ),
            );
          };

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
          const writtenNativePathRef = yield* Ref.make<string | undefined>(undefined);

          return yield* Effect.acquireUseRelease(
            engine
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
              ),
            () =>
              Effect.gen(function* () {
                const adapter = formats.get(provider);
                if (!adapter) {
                  return yield* new TeleportUnsupportedProviderError({
                    provider: driverKind,
                  });
                }
                const nativePath = yield* adapter.write({
                  homes,
                  session: nativeSession,
                });
                yield* Ref.set(writtenNativePathRef, nativePath);

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
                          stage: "bind",
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
            (_acquired, exit) => {
              if (Exit.isSuccess(exit)) {
                return Effect.void;
              }
              return Ref.get(writtenNativePathRef).pipe(
                Effect.flatMap((writtenNativePath) =>
                  teleportExportPresenceOnFailure({
                    writtenNativePath,
                    revert: revertExportPresence,
                    persistWritten: persistExportedNative,
                  }),
                ),
              );
            },
          );
        }),
      ).pipe(
        Effect.catchTags({
          PlatformError: (cause: PlatformError.PlatformError) =>
            new TeleportNativeWriteError({
              stage: "filesystem",
              cause,
            }),
        }),
      ),
    );
  };

  const loadTeleportThreadShells = Effect.gen(function* () {
    const [activeShell, archivedShell] = yield* Effect.all([
      snapshotQuery.getShellSnapshot(),
      snapshotQuery.getArchivedShellSnapshot(),
    ]);
    return [...activeShell.threads, ...archivedShell.threads];
  });

  const classifyWatchedNativeRevision = (input: {
    readonly threadId: ThreadId;
    readonly teleport: TeleportThreadState | null | undefined;
    readonly threads: ReadonlyArray<{
      readonly id: ThreadId;
      readonly teleport?: TeleportThreadState | null | undefined;
    }>;
  }) =>
    Effect.gen(function* () {
      const teleport = input.teleport;
      if (teleport == null || !shouldWatchNativeRevision(teleport)) {
        return nativeRevisionCheckResult({
          threadId: input.threadId,
          classified: { status: "not-applicable" },
          ...(teleport == null ? {} : { nativePath: teleport.nativePath }),
        });
      }
      const nativePath = teleport.nativePath;
      if (teleport.nativeRevision === undefined) {
        return nativeRevisionCheckResult({
          threadId: input.threadId,
          nativePath,
          classified: classifyNativeRevision({
            teleport,
            observation: null,
          }),
        });
      }
      const observation = yield* observeNativeRevision(nativePath);
      const coveringFork =
        observation.status === "observed"
          ? findCoveringNativeFork({
              sourceThreadId: input.threadId,
              observedDigest: observation.revision.digest,
              threads: input.threads,
            })
          : undefined;
      return nativeRevisionCheckResult({
        threadId: input.threadId,
        nativePath,
        classified: classifyNativeRevision({
          teleport,
          observation,
          ...(coveringFork === undefined ? {} : { coveringForkThreadId: coveringFork.id }),
        }),
      });
    });

  const checkNativeRevision = (input: TeleportCheckNativeRevisionInput) =>
    provideNative(
      Effect.gen(function* () {
        const thread = yield* snapshotQuery.getThreadDetailById(input.threadId).pipe(
          Effect.mapError(
            (cause) =>
              new TeleportProjectResolutionError({
                reason: "Failed to load the thread for a native revision check.",
                cause,
              }),
          ),
        );
        if (Option.isNone(thread)) {
          return yield* new TeleportInvalidInputError({
            reason: `Thread '${input.threadId}' was not found.`,
          });
        }
        const threads = yield* loadTeleportThreadShells.pipe(
          Effect.mapError(
            (cause) =>
              new TeleportDiscoveryError({
                reason: "Failed to load threads for a native revision check.",
                cause,
              }),
          ),
        );
        return yield* classifyWatchedNativeRevision({
          threadId: input.threadId,
          teleport: thread.value.teleport,
          threads: threads.map((entry) => ({
            id: entry.id,
            ...(entry.teleport == null ? {} : { teleport: entry.teleport }),
          })),
        });
      }),
    );

  const requireNativeRevisionForTurn = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const result = yield* checkNativeRevision({ threadId });
      if (teleportNativeRevisionBlocksMutation(result.status)) {
        if (result.nativePath === undefined) {
          return yield* new TeleportInvalidInputError({
            reason: "This thread has no imported native session path.",
          });
        }
        return yield* nativeRevisionDivergenceError({
          threadId,
          nativePath: result.nativePath,
          classified: {
            status: result.status,
            ...(result.persistedRevision === undefined
              ? {}
              : { persistedRevision: result.persistedRevision }),
            ...(result.observedRevision === undefined
              ? {}
              : { observedRevision: result.observedRevision }),
            ...(result.forkedThreadId === undefined
              ? {}
              : { forkedThreadId: result.forkedThreadId }),
          },
        });
      }
      switch (result.status) {
        case "not-applicable":
        case "untracked":
        case "unchanged":
        case "forked":
          return;
        case "diverged":
        case "missing":
        case "oversize":
          return yield* new TeleportDiscoveryError({
            reason: "Failed to verify the imported native session.",
          });
        default: {
          const _exhaustive: never = result.status;
          return _exhaustive;
        }
      }
    }).pipe(
      Effect.catchDefect((defect) =>
        Effect.fail(
          new TeleportDiscoveryError({
            reason: "Failed to verify the imported native session.",
            cause: defect,
          }),
        ),
      ),
    );

  const forkNativeDivergence = (input: TeleportForkNativeDivergenceInput) => {
    const inFlightKeys = [`thread:${input.threadId}`, `fork:${input.threadId}`];
    return withInFlight(
      inFlightKeys,
      provideNative(
        Effect.gen(function* () {
          const thread = yield* snapshotQuery.getThreadDetailById(input.threadId).pipe(
            Effect.mapError(
              (cause) =>
                new TeleportInvalidInputError({
                  reason: "Failed to load the thread for a native fork.",
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
              reason: "Cannot fork native changes while this T3 session is running.",
            });
          }
          const teleport = thread.value.teleport;
          if (
            teleport == null ||
            !shouldWatchNativeRevision(teleport) ||
            teleport.nativeRevision === undefined
          ) {
            return yield* new TeleportInvalidInputError({
              reason: "This thread has no imported native session to fork.",
            });
          }
          const threads = yield* loadTeleportThreadShells.pipe(
            Effect.mapError(
              (cause) =>
                new TeleportDiscoveryError({
                  reason: "Failed to load threads for a native fork.",
                  cause,
                }),
            ),
          );
          const checked = yield* classifyWatchedNativeRevision({
            threadId: input.threadId,
            teleport,
            threads,
          });
          const plan = resolveNativeForkPlan({
            status: checked.status,
            ...(checked.persistedRevision === undefined
              ? {}
              : { persistedRevision: checked.persistedRevision }),
            ...(checked.observedRevision === undefined
              ? {}
              : { observedRevision: checked.observedRevision }),
            ...(checked.forkedThreadId === undefined
              ? {}
              : { forkedThreadId: checked.forkedThreadId }),
          });
          if (plan.action === "reuse") {
            return {
              schemaVersion: TELEPORT_SCHEMA_VERSION,
              sourceThreadId: input.threadId,
              threadId: plan.threadId,
              replayed: true,
              provider: teleport.provider,
              providerInstanceId:
                teleport.providerInstanceId ??
                defaultInstanceIdForDriver(ProviderDriverKind.make(teleport.provider)),
              externalSessionId: teleport.externalSessionId,
              nativePath: teleport.nativePath,
            };
          }
          if (plan.action === "reject") {
            if (plan.reason === "missing" || plan.reason === "oversize") {
              return yield* nativeRevisionDivergenceError({
                threadId: input.threadId,
                nativePath: teleport.nativePath,
                classified: {
                  status: plan.reason,
                  ...(checked.persistedRevision === undefined
                    ? {}
                    : { persistedRevision: checked.persistedRevision }),
                },
              });
            }
            return yield* new TeleportInvalidInputError({
              reason:
                plan.reason === "unchanged"
                  ? "Native session has not diverged."
                  : "This thread has no imported native session to fork.",
            });
          }
          if (checked.observedRevision === undefined) {
            return yield* new TeleportInvalidInputError({
              reason: "Native session has not diverged.",
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
          const settings = yield* settingsService.getSettings.pipe(
            Effect.mapError(
              (cause) =>
                new TeleportDiscoveryError({
                  reason: "Server settings could not be read for teleport fork.",
                  cause,
                }),
            ),
          );
          const homes = yield* resolveTeleportHomes(settings);
          const extraCwds = yield* loadProjectWorktreeCwds(thread.value.projectId);
          const cwd = yield* resolveTeleportCwdPath(project.value.workspaceRoot);
          const parsed = yield* loadTeleportSession({
            homes,
            provider: teleport.provider,
            externalSessionId: teleport.externalSessionId,
            cwd,
            ...definedField("extraCwds", extraCwds.length > 0 ? extraCwds : undefined),
            ...(teleport.providerInstanceId === undefined
              ? {}
              : { providerInstanceId: teleport.providerInstanceId }),
            nativePath: teleport.nativePath,
          });
          yield* requireParsedSessionUnlocked(parsed, homes);
          if (
            parsed.nativeRevision === undefined ||
            !nativeRevisionsEqual(checked.observedRevision, parsed.nativeRevision)
          ) {
            return yield* new TeleportDiscoveryError({
              reason: "Native session changed while preparing the fork. Retry the fork.",
            });
          }
          const capped = capMessages(parsed.messages);
          const now = yield* nowIso;
          const messageIds = yield* Effect.forEach(capped, () => nextId(), { concurrency: 1 });
          const messages = nativeMessagesToOrchestration(capped, messageIds, now);
          const title =
            truncateTitle(parsed.title ?? firstUserTitle(capped) ?? "Forked native session") ||
            "Forked native session";
          const driver = ProviderDriverKind.make(parsed.provider);
          const providerInstanceId =
            teleport.providerInstanceId ??
            parsed.providerInstanceId ??
            defaultInstanceIdForDriver(driver);
          const observedAfterLoad = yield* observeNativeRevision(parsed.nativePath);
          if (
            observedAfterLoad.status !== "observed" ||
            !nativeRevisionsEqual(parsed.nativeRevision, observedAfterLoad.revision)
          ) {
            return yield* new TeleportDiscoveryError({
              reason: "Native session changed while preparing the fork. Retry the fork.",
            });
          }
          const forkedRevision = parsed.nativeRevision;
          const replayedAfterLoad = findCoveringNativeFork({
            sourceThreadId: input.threadId,
            observedDigest: forkedRevision.digest,
            threads: yield* loadTeleportThreadShells.pipe(
              Effect.mapError(
                (cause) =>
                  new TeleportDiscoveryError({
                    reason: "Failed to re-load threads before creating a native fork.",
                    cause,
                  }),
              ),
            ),
          });
          if (replayedAfterLoad !== undefined) {
            return {
              schemaVersion: TELEPORT_SCHEMA_VERSION,
              sourceThreadId: input.threadId,
              threadId: replayedAfterLoad.id,
              replayed: true,
              provider: parsed.provider,
              providerInstanceId,
              externalSessionId: parsed.externalSessionId,
              nativePath: parsed.nativePath,
            };
          }

          const teleportPayload: TeleportRuntimePayload = {
            schemaVersion: TELEPORT_SCHEMA_VERSION,
            externalSessionId: parsed.externalSessionId,
            nativePath: parsed.nativePath,
            lastSyncDirection: "import",
            lastSyncedAt: now,
            nativeFormatVersion: parsed.nativeFormatVersion,
            presence: "t3",
            nativeRevision: forkedRevision,
          };
          const committedTeleport = {
            ...committedTeleportImportState(
              teleportThreadStateFromPayload({
                provider: parsed.provider,
                providerInstanceId,
                payload: teleportPayload,
                forkedFromThreadId: input.threadId,
              }),
            ),
            forkedFromThreadId: input.threadId,
          };
          const createdThreadId = nativeForkThreadId(input.threadId, forkedRevision.digest);
          const cleanupCommandId = CommandId.make(yield* nextId());
          const importingTeleport = importingTeleportState({
            base: committedTeleport,
            restorePresence: "t3",
          });
          type ImportMutationError = TeleportInvalidInputError | TeleportDiscoveryError;
          const createdOrReused = yield* engine
            .dispatch({
              type: "thread.create",
              commandId: CommandId.make(yield* nextId()),
              threadId: createdThreadId,
              projectId: thread.value.projectId,
              title,
              modelSelection: modelSelectionForProvider(parsed.provider, providerInstanceId),
              runtimeMode: DEFAULT_RUNTIME_MODE,
              interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
              branch: thread.value.branch,
              worktreePath: thread.value.worktreePath,
              createdAt: now,
            })
            .pipe(
              Effect.matchEffect({
                onSuccess: () => Effect.succeed({ replayed: false as const }),
                onFailure: (cause) =>
                  Effect.gen(function* () {
                    const existing = yield* snapshotQuery.getThreadDetailById(createdThreadId).pipe(
                      Effect.mapError(
                        (loadCause) =>
                          new TeleportDiscoveryError({
                            reason: "Failed to reload a forked thread after a create conflict.",
                            cause: loadCause,
                          }),
                      ),
                    );
                    const reused = reuseNativeForkAfterCreateConflict({
                      sourceThreadId: input.threadId,
                      observedDigest: forkedRevision.digest,
                      ...(Option.isSome(existing) ? { existing: existing.value } : {}),
                    });
                    if (reused === undefined) {
                      return yield* new TeleportInvalidInputError({
                        reason: "Failed to create a forked thread.",
                        cause,
                      });
                    }
                    return { replayed: true as const };
                  }),
              }),
            );
          if (createdOrReused.replayed) {
            return {
              schemaVersion: TELEPORT_SCHEMA_VERSION,
              sourceThreadId: input.threadId,
              threadId: createdThreadId,
              replayed: true,
              provider: parsed.provider,
              providerInstanceId,
              externalSessionId: parsed.externalSessionId,
              nativePath: parsed.nativePath,
            };
          }
          yield* Effect.acquireUseRelease(
            Effect.void,
            () =>
              runNewThreadTeleportImport<ImportMutationError>({
                beginImporting: dispatchTeleportSet({
                  threadId: createdThreadId,
                  teleport: importingTeleport,
                  createdAt: now,
                  reason: "Failed to persist teleport import presence.",
                }),
                commitOrchestration: dispatchTeleportImport({
                  threadId: createdThreadId,
                  teleport: committedTeleport,
                  messages,
                  createdAt: now,
                  reason: "Failed to write forked thread history.",
                }),
                finalizeDirectory: Effect.void,
              }),
            (_acquired, exit) => {
              if (Exit.isSuccess(exit)) {
                return Effect.void;
              }
              return engine
                .dispatch({
                  type: "thread.delete",
                  commandId: cleanupCommandId,
                  threadId: createdThreadId,
                })
                .pipe(
                  Effect.catch(() =>
                    Effect.logWarning("teleport.fork.created-thread-cleanup-skipped", {
                      threadId: createdThreadId,
                    }),
                  ),
                );
            },
          );

          return {
            schemaVersion: TELEPORT_SCHEMA_VERSION,
            sourceThreadId: input.threadId,
            threadId: createdThreadId,
            replayed: false,
            provider: parsed.provider,
            providerInstanceId,
            externalSessionId: parsed.externalSessionId,
            nativePath: parsed.nativePath,
          };
        }),
      ).pipe(
        Effect.catchTags({
          PlatformError: (cause: PlatformError.PlatformError) =>
            new TeleportDiscoveryError({
              reason: "Native filesystem error during teleport fork.",
              cause,
            }),
        }),
      ),
    );
  };

  const recoverInterruptedTeleports = Effect.gen(function* () {
    const now = yield* nowIso;
    const [activeShell, archivedShell] = yield* Effect.all([
      snapshotQuery.getShellSnapshot(),
      snapshotQuery.getArchivedShellSnapshot(),
    ]);
    const threads = [...activeShell.threads, ...archivedShell.threads];
    const recoveryThreads = yield* Effect.forEach(
      threads,
      (thread) => {
        if (thread.teleport?.presence !== "importing") {
          return Effect.succeed({
            id: thread.id,
            ...(thread.teleport == null ? {} : { teleport: thread.teleport }),
          });
        }
        return retryStartupRecovery(
          snapshotQuery.getThreadDetailById(thread.id).pipe(
            Effect.map((detail) => ({
              id: thread.id,
              ...(thread.teleport == null ? {} : { teleport: thread.teleport }),
              historyIsEmptyOrFenceOnly: Option.match(detail, {
                onNone: () => false,
                onSome: (value) => importHistoryIsEmptyOrFenceOnly(value.messages),
              }),
            })),
          ),
          () =>
            Effect.logWarning("teleport.import.recovery-detail-skipped").pipe(
              Effect.annotateLogs({ threadId: thread.id }),
              Effect.as({
                id: thread.id,
                ...(thread.teleport == null ? {} : { teleport: thread.teleport }),
              }),
            ),
        );
      },
      { concurrency: 1 },
    );
    yield* recoverInterruptedImportTeleports({
      threads: recoveryThreads,
      nextCommandId: nextId().pipe(Effect.map(CommandId.make), Effect.orDie),
      setTeleport: (threadId, teleport) =>
        dispatchTeleportSet({
          threadId,
          teleport,
          createdAt: now,
          reason: "Failed to recover an interrupted teleport import.",
        }),
      clearTeleport: (threadId) =>
        dispatchTeleportClear({
          threadId,
          createdAt: now,
          reason: "Failed to recover an interrupted teleport import.",
        }),
      deleteThread: (threadId, commandId) =>
        engine
          .dispatch({
            type: "thread.delete",
            commandId,
            threadId,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new TeleportInvalidInputError({
                  reason: "Failed to recover an interrupted teleport import.",
                  cause,
                }),
            ),
            Effect.flatMap(() =>
              directory.deleteByThreadId(threadId).pipe(Effect.catch(() => Effect.void)),
            ),
            Effect.asVoid,
          ),
      afterRecover: (threadId, restored) => {
        if (restored.action !== "clear") {
          return Effect.void;
        }
        return directory.deleteByThreadId(threadId).pipe(Effect.catch(() => Effect.void));
      },
    });

    const [recoveredActiveShell, recoveredArchivedShell] = yield* retryStartupRecovery(
      Effect.all([snapshotQuery.getShellSnapshot(), snapshotQuery.getArchivedShellSnapshot()]),
      (cause) =>
        Effect.logWarning("teleport.import.recovery-snapshot-refresh-skipped").pipe(
          Effect.annotateLogs({ cause: String(cause) }),
          Effect.as([activeShell, archivedShell] as const),
        ),
    );
    const recoveredThreads = [...recoveredActiveShell.threads, ...recoveredArchivedShell.threads];

    const directoryBindings = yield* retryStartupRecovery(
      directory.listBindings().pipe(
        Effect.map(
          (
            bindings,
          ): {
            readonly ok: boolean;
            readonly bindings: typeof bindings;
          } => ({ ok: true, bindings }),
        ),
      ),
      (cause) =>
        Effect.logWarning("teleport.import.directory-finalize-recovery-skipped").pipe(
          Effect.annotateLogs({ cause: String(cause) }),
          Effect.as({
            ok: false,
            bindings: [] as const,
          }),
        ),
    );
    const bindingByThreadId = new Map(
      directoryBindings.bindings.map((binding) => [binding.threadId, binding] as const),
    );
    yield* directoryBindings.ok
      ? recoverLaggingDirectoryImportFinalize({
          threads: recoveredThreads.map((thread) => {
            const binding = bindingByThreadId.get(thread.id);
            const payload =
              binding === undefined
                ? undefined
                : readTeleportRuntimePayload(binding.runtimePayload);
            return {
              id: thread.id,
              ...(thread.teleport == null ? {} : { teleport: thread.teleport }),
              ...(payload?.presence === undefined ? {} : { directoryPresence: payload.presence }),
              ...(payload?.nativePath === undefined
                ? {}
                : { directoryNativePath: payload.nativePath }),
            };
          }),
          finalizeDirectory: (threadId) => {
            const thread = recoveredThreads.find((candidate) => candidate.id === threadId);
            const teleport = thread?.teleport;
            if (
              teleport == null ||
              (teleport.presence !== "t3" && teleport.presence !== "native")
            ) {
              return Effect.void;
            }
            const driver = ProviderDriverKind.make(teleport.provider);
            const providerInstanceId =
              teleport.providerInstanceId ?? defaultInstanceIdForDriver(driver);
            return directory.upsert({
              threadId,
              provider: driver,
              providerInstanceId,
              status: "stopped",
              resumeCursor: buildTeleportResumeCursor({
                provider: teleport.provider,
                externalSessionId: teleport.externalSessionId,
                adapter: formats.get(teleport.provider),
              }),
              runtimePayload: {
                teleport: {
                  schemaVersion: TELEPORT_SCHEMA_VERSION,
                  externalSessionId: teleport.externalSessionId,
                  nativePath: teleport.nativePath,
                  lastSyncDirection: "import",
                  lastSyncedAt: teleport.lastSyncedAt,
                  nativeFormatVersion: TELEPORT_NATIVE_FORMAT_VERSION,
                  presence: teleport.presence,
                  ...(teleport.nativeRevision === undefined
                    ? {}
                    : { nativeRevision: teleport.nativeRevision }),
                },
              },
            });
          },
        })
      : Effect.void;

    const pendingExports = recoveredThreads.filter(
      (thread) =>
        thread.teleport?.presence === "native" &&
        isPendingTeleportNativePath(thread.teleport.nativePath),
    );
    if (pendingExports.length === 0) {
      return;
    }

    const settings = yield* settingsService.getSettings;
    const homes = yield* resolveTeleportHomes(settings);
    for (const thread of pendingExports) {
      yield* retryStartupRecovery(
        Effect.gen(function* () {
          const pending = thread.teleport;
          if (pending == null) {
            return;
          }
          const cwdSource = resolveThreadWorkspaceCwd({
            thread,
            projects: recoveredActiveShell.projects,
          });
          const discovered =
            cwdSource === undefined
              ? undefined
              : yield* resolveTeleportCwdPath(cwdSource).pipe(
                  Effect.flatMap((cwd) =>
                    loadTeleportSession({
                      homes,
                      provider: pending.provider,
                      externalSessionId: pending.externalSessionId,
                      cwd,
                      ...(pending.providerInstanceId === undefined
                        ? {}
                        : { providerInstanceId: pending.providerInstanceId }),
                    }),
                  ),
                  Effect.map((session): ParsedNativeSession | undefined => session),
                  Effect.catchCause(() => Effect.succeed(undefined)),
                );
          const recoveredTeleport = recoveredInterruptedExportState(
            pending,
            discovered?.nativePath,
          );
          if (recoveredTeleport === null) {
            return;
          }
          yield* dispatchTeleportSet({
            threadId: thread.id,
            teleport: recoveredTeleport,
            createdAt: now,
            reason: "Failed to recover an interrupted teleport export.",
          });

          if (discovered === undefined) {
            return;
          }

          const adapter = formats.get(pending.provider);
          if (!adapter) {
            return;
          }
          const driver = ProviderDriverKind.make(pending.provider);
          const providerInstanceId =
            pending.providerInstanceId ?? defaultInstanceIdForDriver(driver);
          const runtimePayload: TeleportRuntimePayload = {
            schemaVersion: TELEPORT_SCHEMA_VERSION,
            externalSessionId: pending.externalSessionId,
            nativePath: recoveredTeleport.nativePath,
            lastSyncDirection: "export",
            lastSyncedAt: pending.lastSyncedAt,
            nativeFormatVersion: discovered?.nativeFormatVersion ?? TELEPORT_NATIVE_FORMAT_VERSION,
            presence: recoveredTeleport.presence,
          };
          yield* directory.upsert({
            threadId: thread.id,
            provider: driver,
            providerInstanceId,
            status: "stopped",
            resumeCursor: buildTeleportResumeCursor({
              provider: pending.provider,
              externalSessionId: pending.externalSessionId,
              adapter,
            }),
            runtimePayload: { teleport: runtimePayload },
          });
        }),
        (cause) =>
          Effect.logWarning("teleport.export.recovery-skipped", {
            threadId: thread.id,
            cause: String(cause),
          }),
      );
    }
  });

  yield* retryStartupRecovery(recoverInterruptedTeleports, (cause) =>
    Effect.logWarning("teleport.recovery-failed", { cause: String(cause) }),
  );

  return TeleportService.of({
    listSessions,
    importSessions,
    exportSession,
    checkNativeRevision,
    forkNativeDivergence,
    requireNativeRevisionForTurn,
  });
});

export const layer = Layer.effect(TeleportService, make).pipe(
  Layer.provide(TeleportFormatRegistry.layer),
  Layer.provide(ProcessRunner.layer),
);
