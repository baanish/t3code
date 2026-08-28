import {
  CommandId,
  TELEPORT_IMPORT_BATCH_SEMANTICS,
  ThreadId,
  type TeleportRestorePresence,
  type TeleportThreadState,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";

import { teleportCwdsMatch } from "./cwd.ts";
import { isPendingTeleportNativePath } from "./exportPresence.ts";
import { isRecord } from "./json.ts";

export { TELEPORT_IMPORT_BATCH_SEMANTICS };

/**
 * Startup reconciliation: retry once, isolate a persistent failure, and
 * re-fail interrupts so layer construction does not report success mid-shutdown.
 */
export const retryStartupRecovery = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  onFailure: (cause: Cause.Cause<E>) => Effect.Effect<A, never, R>,
) =>
  effect.pipe(
    Effect.retry({ times: 1 }),
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause) ? Effect.failCause(cause) : onFailure(cause),
    ),
  );

export function nativeTranscriptWouldWipeExistingHistory(input: {
  readonly nativeMessageCount: number;
  readonly existingNativeMessageCount: number;
}): boolean {
  return input.nativeMessageCount === 0 && input.existingNativeMessageCount > 0;
}

/**
 * In-place import matches provider + externalSessionId + instance. Do not
 * rewrite a thread bound to a different real file. Directory-only bindings
 * and `teleport-pending:` sentinels are not a durable file identity.
 */
export function inPlaceImportPathIsCompatible(options: {
  readonly parsedNativePath: string;
  readonly existingNativePath: string | undefined;
}): boolean {
  const existingNativePath =
    options.existingNativePath === undefined ||
    isPendingTeleportNativePath(options.existingNativePath)
      ? undefined
      : options.existingNativePath;
  if (existingNativePath === undefined) {
    return true;
  }
  return teleportCwdsMatch(existingNativePath, options.parsedNativePath);
}

type RestorableDirectoryStatus = "starting" | "running" | "stopped" | "error";

function restoredDirectoryStatusAfterFailedImport(
  status: RestorableDirectoryStatus | undefined,
): RestorableDirectoryStatus | undefined {
  if (status === undefined) {
    return undefined;
  }
  switch (status) {
    case "running":
    case "starting":
      return "stopped";
    case "stopped":
    case "error":
      return status;
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

function omitPendingTeleportRuntimePayload(
  runtimePayload: unknown | null | undefined,
): unknown | null | undefined {
  if (runtimePayload == null || !isRecord(runtimePayload)) {
    return runtimePayload;
  }
  const teleport = runtimePayload.teleport;
  if (
    !isRecord(teleport) ||
    typeof teleport.nativePath !== "string" ||
    !isPendingTeleportNativePath(teleport.nativePath)
  ) {
    return runtimePayload;
  }
  const { teleport: _pending, ...rest } = runtimePayload;
  void _pending;
  return rest;
}

/**
 * Revert must restore identity, not a pre-stop `running`/`starting` binding or
 * a `teleport-pending:` native path snapshot taken before stop.
 */
export function restoreDirectoryBindingAfterFailedImport<
  T extends {
    readonly status?: RestorableDirectoryStatus;
    readonly runtimePayload?: unknown | null;
  },
>(binding: T): T {
  const status = restoredDirectoryStatusAfterFailedImport(binding.status);
  const runtimePayload = omitPendingTeleportRuntimePayload(binding.runtimePayload);
  if (status === binding.status && runtimePayload === binding.runtimePayload) {
    return binding;
  }
  return {
    ...binding,
    ...(status === undefined ? {} : { status }),
    ...(runtimePayload === binding.runtimePayload ? {} : { runtimePayload }),
  };
}

export function importingTeleportState(input: {
  readonly base: Omit<TeleportThreadState, "presence" | "restorePresence">;
  readonly restorePresence?: TeleportRestorePresence | undefined;
}): TeleportThreadState {
  return {
    ...input.base,
    presence: "importing",
    ...(input.restorePresence === undefined ? {} : { restorePresence: input.restorePresence }),
  };
}

export function teleportStateWithPresence(
  input: TeleportThreadState,
  presence: TeleportRestorePresence,
): TeleportThreadState {
  return {
    presence,
    provider: input.provider,
    ...(input.providerInstanceId === undefined
      ? {}
      : { providerInstanceId: input.providerInstanceId }),
    externalSessionId: input.externalSessionId,
    nativePath: input.nativePath,
    lastSyncedAt: input.lastSyncedAt,
    ...(input.nativeRevision === undefined ? {} : { nativeRevision: input.nativeRevision }),
    ...(input.forkedFromThreadId === undefined
      ? {}
      : { forkedFromThreadId: input.forkedFromThreadId }),
  };
}

export function committedTeleportImportState(input: TeleportThreadState): TeleportThreadState {
  return teleportStateWithPresence(input, "t3");
}

export function restorePresenceForImport(
  teleport: TeleportThreadState | null | undefined,
): TeleportRestorePresence | undefined {
  if (teleport == null) {
    return undefined;
  }
  switch (teleport.presence) {
    case "importing":
      return teleport.restorePresence;
    case "native":
      return "native";
    case "t3":
      return "t3";
    default: {
      const _exhaustive: never = teleport.presence;
      return _exhaustive;
    }
  }
}

export type InterruptedImportTeleportRestore =
  | { readonly action: "none" }
  | { readonly action: "clear" }
  | { readonly action: "delete" }
  | { readonly action: "set"; readonly teleport: TeleportThreadState };

export function importHistoryIsEmptyOrFenceOnly(
  messages: ReadonlyArray<{ readonly role: string }>,
): boolean {
  return !messages.some((message) => message.role === "user" || message.role === "assistant");
}

/**
 * Crash recovery for a leftover `presence: "importing"` fence.
 *
 * Native restore keeps the importing payload's identity and relocks the
 * composer. New-thread import stamps restorePresence `t3` and has empty or
 * fence-only history; those threads are deleted to match live
 * acquireUseRelease cleanup. First-time in-place import (no restorePresence)
 * and in-place restorePresence `t3` with existing history clear teleport
 * instead of flipping to `t3` with the importing `nativeRevision`.
 */
export function restoredTeleportStateAfterInterruptedImport(
  teleport: TeleportThreadState | null | undefined,
  options?: {
    readonly historyIsEmptyOrFenceOnly?: boolean;
  },
): InterruptedImportTeleportRestore {
  if (teleport == null || teleport.presence !== "importing") {
    return { action: "none" };
  }
  if (teleport.restorePresence === "native") {
    return {
      action: "set",
      teleport: teleportStateWithPresence(teleport, "native"),
    };
  }
  if (teleport.restorePresence === "t3" && options?.historyIsEmptyOrFenceOnly === true) {
    return { action: "delete" };
  }
  return { action: "clear" };
}

export type RevertDirectoryAfterFailedInPlaceImport<T> =
  | { readonly action: "delete" }
  | { readonly action: "restore"; readonly binding: T };

/**
 * First-time in-place import can upsert a directory row that did not exist.
 * Revert must delete that row. A prior binding restores identity fields only.
 */
export function revertDirectoryAfterFailedInPlaceImport<
  T extends {
    readonly status?: RestorableDirectoryStatus;
    readonly runtimePayload?: unknown | null;
  },
>(previousBinding: T | undefined): RevertDirectoryAfterFailedInPlaceImport<T> {
  if (previousBinding === undefined) {
    return { action: "delete" };
  }
  return {
    action: "restore",
    binding: restoreDirectoryBindingAfterFailedImport(previousBinding),
  };
}

/**
 * Live revert after an in-place import fails or is interrupted.
 *
 * When a prior teleport document existed, restore that object (native→importing
 * →native keeps the pre-import native identity). When there was no teleport
 * field, clear rather than persisting the uncommitted import as `t3`.
 */
export function revertTeleportAfterFailedInPlaceImport(
  prior: TeleportThreadState | null | undefined,
): Exclude<InterruptedImportTeleportRestore, { action: "none" } | { action: "delete" }> {
  if (prior == null) {
    return { action: "clear" };
  }
  if (prior.presence === "importing") {
    const restored = restoredTeleportStateAfterInterruptedImport(prior);
    return restored.action === "set" ? restored : { action: "clear" };
  }
  const presence = restorePresenceForImport(prior);
  if (presence === undefined) {
    return { action: "clear" };
  }
  return { action: "set", teleport: teleportStateWithPresence(prior, presence) };
}

export type InPlaceTeleportImportPorts<E, R = never> = {
  readonly beginImporting: Effect.Effect<void, E, R>;
  readonly stopSession: Effect.Effect<void, E, R>;
  readonly persistDirectory: Effect.Effect<void, E, R>;
  readonly commitOrchestration: Effect.Effect<void, E, R>;
  readonly finalizeDirectory: Effect.Effect<void, E, R>;
  readonly updateTitle: Effect.Effect<void, E, R>;
  readonly revertImporting: Effect.Effect<void, never, R>;
};

const revertOnError = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  revert: Effect.Effect<void, never, R>,
): Effect.Effect<A, E, R> =>
  // `onError` observes typed failures, defects, and interruption, and the
  // revert itself is uninterruptible so a cancelled RPC cannot leave
  // `presence: "importing"` stranded until process restart.
  effect.pipe(Effect.onError(() => revert));

/**
 * In-place import durability protocol:
 * 1. orchestration fence (`importing`) so `thread.turn.start` cannot admit work
 * 2. stop leftover provider runtime
 * 3. provider-directory claim (separate durability boundary)
 * 4. atomic T3 commit (unarchive + t3 presence + history)
 * 5. directory presence finalize (best-effort)
 * 6. title (best-effort)
 *
 * The fence is inside the same revert region as stop/directory/commit. If
 * `beginImporting` itself commits and the Effect is then interrupted or
 * defects, revert still runs. Typed failures, defects, and interruptions
 * before the T3 commit revert the importing fence. Title and the post-commit
 * directory finalize cannot invalidate a successful T3 commit.
 */
export const runInPlaceTeleportImport = <E, R = never>(
  ports: InPlaceTeleportImportPorts<E, R>,
): Effect.Effect<void, E, R> =>
  Effect.gen(function* () {
    yield* revertOnError(
      ports.beginImporting.pipe(
        Effect.flatMap(() => ports.stopSession),
        Effect.flatMap(() => ports.persistDirectory),
        Effect.flatMap(() => ports.commitOrchestration),
      ),
      ports.revertImporting,
    );
    yield* ports.finalizeDirectory.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("teleport.import.directory-finalize-skipped").pipe(
          Effect.annotateLogs({ cause: String(cause) }),
        ),
      ),
    );
    yield* ports.updateTitle.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("teleport.import.title-update-skipped").pipe(
          Effect.annotateLogs({ cause: String(cause) }),
        ),
      ),
    );
  });

export type NewThreadTeleportImportPorts<E, R = never> = {
  readonly beginImporting: Effect.Effect<void, E, R>;
  readonly commitOrchestration: Effect.Effect<void, E, R>;
  readonly finalizeDirectory: Effect.Effect<void, E, R>;
};

export const runNewThreadTeleportImport = <E, R = never>(
  ports: NewThreadTeleportImportPorts<E, R>,
): Effect.Effect<void, E, R> =>
  Effect.gen(function* () {
    yield* ports.beginImporting;
    yield* ports.commitOrchestration;
    yield* ports.finalizeDirectory.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("teleport.import.directory-finalize-skipped").pipe(
          Effect.annotateLogs({ cause: String(cause) }),
        ),
      ),
    );
  });

/**
 * Sequential per-session commit. A later identity or persist failure does
 * not undo earlier successes; the caller still sees the failure. Load and
 * unlock must already have succeeded for every session.
 */
export const importSessionBatch = <A, E, R = never>(
  sessions: ReadonlyArray<A>,
  importOne: (session: A) => Effect.Effect<A, E, R>,
): Effect.Effect<A[], E, R> =>
  Effect.gen(function* () {
    const imported: A[] = [];
    for (const session of sessions) {
      imported.push(yield* importOne(session));
    }
    return imported;
  });

export const recoverInterruptedImportTeleports = <E, R = never>(input: {
  readonly threads: ReadonlyArray<{
    readonly id: ThreadId;
    readonly teleport?: TeleportThreadState | null;
    readonly historyIsEmptyOrFenceOnly?: boolean;
  }>;
  readonly nextCommandId: Effect.Effect<CommandId, never, R>;
  readonly setTeleport: (
    threadId: ThreadId,
    teleport: TeleportThreadState,
    commandId: CommandId,
  ) => Effect.Effect<void, E, R>;
  readonly clearTeleport: (threadId: ThreadId, commandId: CommandId) => Effect.Effect<void, E, R>;
  readonly deleteThread: (threadId: ThreadId, commandId: CommandId) => Effect.Effect<void, E, R>;
  readonly afterRecover?: (
    threadId: ThreadId,
    restored: Exclude<InterruptedImportTeleportRestore, { action: "none" }>,
  ) => Effect.Effect<void, never, R>;
}) =>
  Effect.gen(function* () {
    for (const thread of input.threads) {
      const restored =
        thread.historyIsEmptyOrFenceOnly === undefined
          ? restoredTeleportStateAfterInterruptedImport(thread.teleport)
          : restoredTeleportStateAfterInterruptedImport(thread.teleport, {
              historyIsEmptyOrFenceOnly: thread.historyIsEmptyOrFenceOnly,
            });
      if (restored.action === "none") {
        continue;
      }
      const commandId = yield* input.nextCommandId;
      const recover = (() => {
        switch (restored.action) {
          case "clear":
            return input.clearTeleport(thread.id, commandId);
          case "delete":
            return input.deleteThread(thread.id, commandId);
          case "set":
            return input.setTeleport(thread.id, restored.teleport, commandId);
          default: {
            const _exhaustive: never = restored;
            return _exhaustive;
          }
        }
      })();
      yield* retryStartupRecovery(
        recover.pipe(
          Effect.flatMap(() => input.afterRecover?.(thread.id, restored) ?? Effect.void),
        ),
        () =>
          Effect.logWarning("teleport.import.recovery-skipped").pipe(
            Effect.annotateLogs({ threadId: thread.id }),
          ),
      );
    }
  });

export function directoryNeedsFinalizeAfterCommittedImport(input: {
  readonly orchestrationPresence: TeleportThreadState["presence"] | null | undefined;
  readonly directoryPresence: TeleportThreadState["presence"] | null | undefined;
  readonly directoryNativePath?: string | undefined;
}): boolean {
  if (input.orchestrationPresence === "native" && input.directoryPresence === "importing") {
    return true;
  }
  if (input.orchestrationPresence !== "t3") {
    return false;
  }
  if (input.directoryPresence === "importing") {
    return true;
  }
  if (input.directoryPresence == null) {
    return true;
  }
  return (
    input.directoryNativePath !== undefined &&
    isPendingTeleportNativePath(input.directoryNativePath)
  );
}

/**
 * After a successful T3 import commit, directory finalize is best-effort.
 * Startup repairs threads that already own the transcript in orchestration
 * but still have an importing or pending directory payload.
 */
export const recoverLaggingDirectoryImportFinalize = <E, R = never>(input: {
  readonly threads: ReadonlyArray<{
    readonly id: ThreadId;
    readonly teleport?: TeleportThreadState | null;
    readonly directoryPresence?: TeleportThreadState["presence"] | null;
    readonly directoryNativePath?: string;
  }>;
  readonly finalizeDirectory: (threadId: ThreadId) => Effect.Effect<void, E, R>;
}) =>
  Effect.gen(function* () {
    for (const thread of input.threads) {
      if (
        !directoryNeedsFinalizeAfterCommittedImport({
          orchestrationPresence: thread.teleport?.presence,
          directoryPresence: thread.directoryPresence,
          ...(thread.directoryNativePath === undefined
            ? {}
            : { directoryNativePath: thread.directoryNativePath }),
        })
      ) {
        continue;
      }
      yield* retryStartupRecovery(input.finalizeDirectory(thread.id), (cause) =>
        Effect.logWarning("teleport.import.directory-finalize-recovery-skipped").pipe(
          Effect.annotateLogs({ threadId: thread.id, cause: String(cause) }),
        ),
      );
    }
  });
