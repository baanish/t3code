import {
  CommandId,
  TELEPORT_IMPORT_BATCH_SEMANTICS,
  ThreadId,
  type TeleportRestorePresence,
  type TeleportThreadState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

export { TELEPORT_IMPORT_BATCH_SEMANTICS };

export function nativeTranscriptWouldWipeExistingHistory(input: {
  readonly nativeMessageCount: number;
  readonly existingNativeMessageCount: number;
}): boolean {
  return input.nativeMessageCount === 0 && input.existingNativeMessageCount > 0;
}

export function importingTeleportState(input: {
  readonly base: Omit<TeleportThreadState, "presence" | "restorePresence">;
  readonly restorePresence?: TeleportRestorePresence;
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
): TeleportRestorePresence {
  if (teleport?.presence === "importing") {
    return teleport.restorePresence ?? "t3";
  }
  return teleport?.presence === "native" ? "native" : "t3";
}

export function restoredTeleportStateAfterInterruptedImport(
  teleport: TeleportThreadState | null | undefined,
): TeleportThreadState | null {
  if (teleport == null || teleport.presence !== "importing") {
    return null;
  }
  return teleportStateWithPresence(teleport, teleport.restorePresence ?? "t3");
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
 * Typed failures, defects, and interruptions before the T3 commit revert the
 * importing fence. Title and the post-commit directory finalize cannot
 * invalidate a successful T3 commit.
 */
export const runInPlaceTeleportImport = <E, R = never>(
  ports: InPlaceTeleportImportPorts<E, R>,
): Effect.Effect<void, E, R> =>
  Effect.gen(function* () {
    yield* ports.beginImporting;
    yield* revertOnError(
      ports.stopSession.pipe(
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
 * Sequential per-session import. A later failure does not undo earlier
 * successes; the caller still sees the failure.
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
  }>;
  readonly nextCommandId: Effect.Effect<CommandId, never, R>;
  readonly setTeleport: (
    threadId: ThreadId,
    teleport: TeleportThreadState,
    commandId: CommandId,
  ) => Effect.Effect<void, E, R>;
}): Effect.Effect<void, never, R> =>
  Effect.gen(function* () {
    for (const thread of input.threads) {
      const restored = restoredTeleportStateAfterInterruptedImport(thread.teleport);
      if (restored === null) {
        continue;
      }
      const commandId = yield* input.nextCommandId;
      yield* input
        .setTeleport(thread.id, restored, commandId)
        .pipe(
          Effect.catchCause(() =>
            Effect.logWarning("teleport.import.recovery-skipped").pipe(
              Effect.annotateLogs({ threadId: thread.id }),
            ),
          ),
        );
    }
  });
