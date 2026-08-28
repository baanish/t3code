import { CommandId, TELEPORT_IMPORT_BATCH_SEMANTICS, ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";

import { pendingTeleportNativePath } from "./exportPresence.ts";
import {
  committedTeleportImportState,
  importSessionBatch,
  importingTeleportState,
  inPlaceImportPathIsCompatible,
  nativeTranscriptWouldWipeExistingHistory,
  directoryNeedsFinalizeAfterCommittedImport,
  importHistoryIsEmptyOrFenceOnly,
  recoverInterruptedImportTeleports,
  recoverLaggingDirectoryImportFinalize,
  restoreDirectoryBindingAfterFailedImport,
  restorePresenceForImport,
  revertDirectoryAfterFailedInPlaceImport,
  restoredTeleportStateAfterInterruptedImport,
  revertTeleportAfterFailedInPlaceImport,
  runInPlaceTeleportImport,
  runNewThreadTeleportImport,
} from "./importTransaction.ts";
import { readTeleportRuntimePayload } from "./resumeCursors.ts";

const BASE_TELEPORT = {
  provider: "codex" as const,
  externalSessionId: "session-1",
  nativePath: "/tmp/session.jsonl",
  lastSyncedAt: "2026-08-14T22:00:00.000Z",
};

type ImportStepError = {
  readonly _tag: "ImportStepError";
  readonly step: string;
};

function importStepError(step: string): ImportStepError {
  return { _tag: "ImportStepError", step };
}

describe("teleport import transaction", () => {
  it("documents per-session batch atomicity", () => {
    assert.equal(TELEPORT_IMPORT_BATCH_SEMANTICS, "per-session");
  });

  it("refuses to wipe existing history with an empty native transcript", () => {
    assert.equal(
      nativeTranscriptWouldWipeExistingHistory({
        nativeMessageCount: 0,
        existingNativeMessageCount: 2,
      }),
      true,
    );
    assert.equal(
      nativeTranscriptWouldWipeExistingHistory({
        nativeMessageCount: 0,
        existingNativeMessageCount: 0,
      }),
      false,
    );
    assert.equal(
      nativeTranscriptWouldWipeExistingHistory({
        nativeMessageCount: 1,
        existingNativeMessageCount: 2,
      }),
      false,
    );
  });

  it("does not in-place-match a different durable nativePath", () => {
    assert.equal(
      inPlaceImportPathIsCompatible({
        parsedNativePath: "/tmp/b.jsonl",
        existingNativePath: "/tmp/a.jsonl",
      }),
      false,
    );
    assert.equal(
      inPlaceImportPathIsCompatible({
        parsedNativePath: "/tmp/a.jsonl",
        existingNativePath: "/tmp/a.jsonl",
      }),
      true,
    );
    assert.equal(
      inPlaceImportPathIsCompatible({
        parsedNativePath: "/tmp/b.jsonl",
        existingNativePath: undefined,
      }),
      true,
    );
    assert.equal(
      inPlaceImportPathIsCompatible({
        parsedNativePath: "/tmp/b.jsonl",
        existingNativePath: pendingTeleportNativePath("codex", "session-1"),
      }),
      true,
    );
  });

  it("restores identity without a running status or pending native path", () => {
    const pending = pendingTeleportNativePath("codex", "session-1");
    const restored = restoreDirectoryBindingAfterFailedImport({
      threadId: ThreadId.make("thread-1"),
      provider: "codex",
      status: "running" as const,
      resumeCursor: { threadId: "session-1" },
      runtimePayload: {
        teleport: {
          schemaVersion: 1,
          externalSessionId: "session-1",
          nativePath: pending,
          lastSyncDirection: "export",
          lastSyncedAt: "2026-08-14T22:00:00.000Z",
          nativeFormatVersion: 1,
          presence: "native",
        },
      },
    });
    assert.equal(restored.status, "stopped");
    assert.deepEqual(restored.resumeCursor, { threadId: "session-1" });
    assert.equal(readTeleportRuntimePayload(restored.runtimePayload), undefined);
    assert.equal(
      restoreDirectoryBindingAfterFailedImport({
        status: "starting" as const,
      }).status,
      "stopped",
    );
    const kept = restoreDirectoryBindingAfterFailedImport({
      status: "error" as const,
      runtimePayload: {
        teleport: {
          schemaVersion: 1,
          externalSessionId: "session-1",
          nativePath: "/tmp/session.jsonl",
          lastSyncDirection: "import",
          lastSyncedAt: "2026-08-14T22:00:00.000Z",
          nativeFormatVersion: 1,
          presence: "t3",
        },
      },
    });
    assert.equal(kept.status, "error");
    assert.equal(readTeleportRuntimePayload(kept.runtimePayload)?.nativePath, "/tmp/session.jsonl");
  });

  it("deletes a first-time directory binding and restores a prior one", () => {
    assert.deepEqual(revertDirectoryAfterFailedInPlaceImport(undefined), { action: "delete" });
    const prior = {
      threadId: ThreadId.make("thread-1"),
      provider: "codex" as const,
      status: "running" as const,
      runtimePayload: {
        teleport: {
          schemaVersion: 1,
          externalSessionId: "session-1",
          nativePath: pendingTeleportNativePath("codex", "session-1"),
          lastSyncDirection: "export",
          lastSyncedAt: "2026-08-14T22:00:00.000Z",
          nativeFormatVersion: 1,
          presence: "native" as const,
        },
      },
    };
    const restored = revertDirectoryAfterFailedInPlaceImport(prior);
    assert.equal(restored.action, "restore");
    if (restored.action === "restore") {
      assert.equal(restored.binding.status, "stopped");
      assert.equal(readTeleportRuntimePayload(restored.binding.runtimePayload), undefined);
    }
  });

  it("preserves native revision and fork provenance when changing presence", () => {
    const withRevision = importingTeleportState({
      base: {
        ...BASE_TELEPORT,
        nativeRevision: {
          algorithm: "sha256",
          digest: "abc",
          byteLength: 12,
        },
        forkedFromThreadId: ThreadId.make("thread-source"),
      },
      restorePresence: "t3",
    });
    const committed = committedTeleportImportState(withRevision);
    assert.equal(committed.presence, "t3");
    assert.equal(committed.nativeRevision?.digest, "abc");
    assert.equal(committed.forkedFromThreadId, "thread-source");
    assert.equal(committed.restorePresence, undefined);
  });

  it("restores native presence after an interrupted import", () => {
    const importing = importingTeleportState({
      base: BASE_TELEPORT,
      restorePresence: "native",
    });
    assert.equal(importing.presence, "importing");
    assert.equal(restorePresenceForImport(importing), "native");
    assert.deepEqual(restoredTeleportStateAfterInterruptedImport(importing), {
      action: "set",
      teleport: {
        ...BASE_TELEPORT,
        presence: "native",
      },
    });
    assert.deepEqual(
      restoredTeleportStateAfterInterruptedImport(committedTeleportImportState(importing)),
      { action: "none" },
    );
  });

  it("clears teleport after an interrupted first-time import", () => {
    const firstTimeImporting = importingTeleportState({
      base: {
        ...BASE_TELEPORT,
        nativeRevision: {
          algorithm: "sha256",
          digest: "imported-but-uncommitted",
          byteLength: 42,
        },
      },
    });
    assert.equal(restorePresenceForImport(undefined), undefined);
    assert.equal(restorePresenceForImport(null), undefined);
    assert.deepEqual(restoredTeleportStateAfterInterruptedImport(firstTimeImporting), {
      action: "clear",
    });
    assert.deepEqual(
      restoredTeleportStateAfterInterruptedImport(
        importingTeleportState({
          base: {
            ...BASE_TELEPORT,
            nativeRevision: {
              algorithm: "sha256",
              digest: "imported-but-uncommitted",
              byteLength: 42,
            },
          },
          restorePresence: "t3",
        }),
      ),
      { action: "clear" },
    );
    assert.deepEqual(revertTeleportAfterFailedInPlaceImport(undefined), { action: "clear" });
    assert.deepEqual(
      revertTeleportAfterFailedInPlaceImport({
        ...BASE_TELEPORT,
        presence: "native",
      }),
      {
        action: "set",
        teleport: {
          ...BASE_TELEPORT,
          presence: "native",
        },
      },
    );
  });

  it.effect("keeps earlier sessions when a later session in the batch fails", () =>
    Effect.gen(function* () {
      const retained: string[] = [];
      const error = yield* importSessionBatch(["one", "two"], (session) => {
        if (session === "two") {
          return Effect.fail(importStepError("session-two"));
        }
        return Effect.sync(() => {
          retained.push(session);
          return session;
        });
      }).pipe(Effect.flip);
      assert.equal(error.step, "session-two");
      assert.deepEqual(retained, ["one"]);
    }),
  );

  it.effect("reverts the importing fence when binding persistence fails before T3 commit", () =>
    Effect.gen(function* () {
      const steps = yield* Ref.make<string[]>([]);
      const record = (step: string) => Ref.update(steps, (current) => [...current, step]);
      const error = yield* runInPlaceTeleportImport({
        beginImporting: record("beginImporting"),
        stopSession: record("stopSession"),
        persistDirectory: record("persistDirectory").pipe(
          Effect.flatMap(() => Effect.fail(importStepError("persistDirectory"))),
        ),
        commitOrchestration: record("commitOrchestration"),
        finalizeDirectory: record("finalizeDirectory"),
        updateTitle: record("updateTitle"),
        revertImporting: record("revertImporting"),
      }).pipe(Effect.flip);
      assert.equal(error.step, "persistDirectory");
      assert.deepEqual(yield* Ref.get(steps), [
        "beginImporting",
        "stopSession",
        "persistDirectory",
        "revertImporting",
      ]);
    }),
  );

  it.effect("reverts the importing fence when the T3 import commit fails", () =>
    Effect.gen(function* () {
      const steps = yield* Ref.make<string[]>([]);
      const record = (step: string) => Ref.update(steps, (current) => [...current, step]);
      const error = yield* runInPlaceTeleportImport({
        beginImporting: record("beginImporting"),
        stopSession: record("stopSession"),
        persistDirectory: record("persistDirectory"),
        commitOrchestration: record("commitOrchestration").pipe(
          Effect.flatMap(() => Effect.fail(importStepError("commitOrchestration"))),
        ),
        finalizeDirectory: record("finalizeDirectory"),
        updateTitle: record("updateTitle"),
        revertImporting: record("revertImporting"),
      }).pipe(Effect.flip);
      assert.equal(error.step, "commitOrchestration");
      assert.deepEqual(yield* Ref.get(steps), [
        "beginImporting",
        "stopSession",
        "persistDirectory",
        "commitOrchestration",
        "revertImporting",
      ]);
    }),
  );

  it.effect("reverts the importing fence when a pre-commit step dies", () =>
    Effect.gen(function* () {
      const steps = yield* Ref.make<string[]>([]);
      const record = (step: string) => Ref.update(steps, (current) => [...current, step]);
      const defect = new Error("commitOrchestration");
      const exit = yield* runInPlaceTeleportImport({
        beginImporting: record("beginImporting"),
        stopSession: record("stopSession"),
        persistDirectory: record("persistDirectory"),
        commitOrchestration: record("commitOrchestration").pipe(
          Effect.flatMap(() => Effect.die(defect)),
        ),
        finalizeDirectory: record("finalizeDirectory"),
        updateTitle: record("updateTitle"),
        revertImporting: record("revertImporting"),
      }).pipe(Effect.exit);
      assert.equal(Exit.isFailure(exit), true);
      if (Exit.isFailure(exit)) {
        assert.equal(Cause.hasDies(exit.cause), true);
        assert.equal(Cause.squash(exit.cause), defect);
      }
      assert.deepEqual(yield* Ref.get(steps), [
        "beginImporting",
        "stopSession",
        "persistDirectory",
        "commitOrchestration",
        "revertImporting",
      ]);
    }),
  );

  it.effect("reverts the importing fence when a pre-commit step is interrupted", () =>
    Effect.gen(function* () {
      const steps = yield* Ref.make<string[]>([]);
      const record = (step: string) => Ref.update(steps, (current) => [...current, step]);
      const exit = yield* runInPlaceTeleportImport({
        beginImporting: record("beginImporting"),
        stopSession: record("stopSession"),
        persistDirectory: record("persistDirectory").pipe(Effect.flatMap(() => Effect.interrupt)),
        commitOrchestration: record("commitOrchestration"),
        finalizeDirectory: record("finalizeDirectory"),
        updateTitle: record("updateTitle"),
        revertImporting: record("revertImporting"),
      }).pipe(Effect.exit);
      assert.equal(Exit.isFailure(exit), true);
      if (Exit.isFailure(exit)) {
        assert.equal(Cause.hasInterrupts(exit.cause), true);
      }
      assert.deepEqual(yield* Ref.get(steps), [
        "beginImporting",
        "stopSession",
        "persistDirectory",
        "revertImporting",
      ]);
    }),
  );

  it.effect("reverts the importing fence when the import fiber is interrupted", () =>
    Effect.gen(function* () {
      const steps = yield* Ref.make<string[]>([]);
      const started = yield* Deferred.make<void>();
      const record = (step: string) => Ref.update(steps, (current) => [...current, step]);
      const fiber = yield* runInPlaceTeleportImport({
        beginImporting: record("beginImporting"),
        stopSession: record("stopSession").pipe(
          Effect.flatMap(() => Deferred.succeed(started, undefined)),
          Effect.flatMap(() => Effect.never),
        ),
        persistDirectory: record("persistDirectory"),
        commitOrchestration: record("commitOrchestration"),
        finalizeDirectory: record("finalizeDirectory"),
        updateTitle: record("updateTitle"),
        revertImporting: record("revertImporting"),
      }).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      assert.deepEqual(yield* Ref.get(steps), ["beginImporting", "stopSession", "revertImporting"]);
    }),
  );

  it.effect("reverts the importing fence when beginImporting dies after committing", () =>
    Effect.gen(function* () {
      const steps = yield* Ref.make<string[]>([]);
      const record = (step: string) => Ref.update(steps, (current) => [...current, step]);
      const defect = new Error("beginImporting");
      const exit = yield* runInPlaceTeleportImport({
        beginImporting: record("beginImporting").pipe(Effect.flatMap(() => Effect.die(defect))),
        stopSession: record("stopSession"),
        persistDirectory: record("persistDirectory"),
        commitOrchestration: record("commitOrchestration"),
        finalizeDirectory: record("finalizeDirectory"),
        updateTitle: record("updateTitle"),
        revertImporting: record("revertImporting"),
      }).pipe(Effect.exit);
      assert.equal(Exit.isFailure(exit), true);
      if (Exit.isFailure(exit)) {
        assert.equal(Cause.hasDies(exit.cause), true);
        assert.equal(Cause.squash(exit.cause), defect);
      }
      assert.deepEqual(yield* Ref.get(steps), ["beginImporting", "revertImporting"]);
    }),
  );

  it.effect("reverts the importing fence when beginImporting is interrupted", () =>
    Effect.gen(function* () {
      const steps = yield* Ref.make<string[]>([]);
      const started = yield* Deferred.make<void>();
      const record = (step: string) => Ref.update(steps, (current) => [...current, step]);
      const fiber = yield* runInPlaceTeleportImport({
        beginImporting: record("beginImporting").pipe(
          Effect.flatMap(() => Deferred.succeed(started, undefined)),
          Effect.flatMap(() => Effect.never),
        ),
        stopSession: record("stopSession"),
        persistDirectory: record("persistDirectory"),
        commitOrchestration: record("commitOrchestration"),
        finalizeDirectory: record("finalizeDirectory"),
        updateTitle: record("updateTitle"),
        revertImporting: record("revertImporting"),
      }).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      assert.deepEqual(yield* Ref.get(steps), ["beginImporting", "revertImporting"]);
    }),
  );

  it.effect("reverts the importing fence when interrupted immediately after beginImporting", () =>
    Effect.gen(function* () {
      const steps = yield* Ref.make<string[]>([]);
      const fenced = yield* Deferred.make<void>();
      const record = (step: string) => Ref.update(steps, (current) => [...current, step]);
      const fiber = yield* runInPlaceTeleportImport({
        beginImporting: record("beginImporting").pipe(
          Effect.flatMap(() => Deferred.succeed(fenced, undefined)),
        ),
        stopSession: record("stopSession").pipe(Effect.flatMap(() => Effect.never)),
        persistDirectory: record("persistDirectory"),
        commitOrchestration: record("commitOrchestration"),
        finalizeDirectory: record("finalizeDirectory"),
        updateTitle: record("updateTitle"),
        revertImporting: record("revertImporting"),
      }).pipe(Effect.forkChild);
      yield* Deferred.await(fenced);
      yield* Fiber.interrupt(fiber);
      const observed = yield* Ref.get(steps);
      assert.equal(observed.includes("beginImporting"), true);
      assert.equal(observed.includes("revertImporting"), true);
      assert.equal(observed.includes("persistDirectory"), false);
      assert.equal(observed.includes("commitOrchestration"), false);
    }),
  );

  it.effect("succeeds when title update fails after the T3 commit", () =>
    Effect.gen(function* () {
      const steps = yield* Ref.make<string[]>([]);
      const record = (step: string) => Ref.update(steps, (current) => [...current, step]);
      yield* runInPlaceTeleportImport({
        beginImporting: record("beginImporting"),
        stopSession: record("stopSession"),
        persistDirectory: record("persistDirectory"),
        commitOrchestration: record("commitOrchestration"),
        finalizeDirectory: record("finalizeDirectory"),
        updateTitle: record("updateTitle").pipe(
          Effect.flatMap(() => Effect.fail(importStepError("updateTitle"))),
        ),
        revertImporting: record("revertImporting"),
      });
      assert.deepEqual(yield* Ref.get(steps), [
        "beginImporting",
        "stopSession",
        "persistDirectory",
        "commitOrchestration",
        "finalizeDirectory",
        "updateTitle",
      ]);
    }),
  );

  it.effect("claims the provider directory only after a new-thread T3 commit", () =>
    Effect.gen(function* () {
      const steps = yield* Ref.make<string[]>([]);
      const record = (step: string) => Ref.update(steps, (current) => [...current, step]);
      yield* runNewThreadTeleportImport({
        beginImporting: record("beginImporting"),
        commitOrchestration: record("commitOrchestration"),
        finalizeDirectory: record("finalizeDirectory"),
      });
      assert.deepEqual(yield* Ref.get(steps), [
        "beginImporting",
        "commitOrchestration",
        "finalizeDirectory",
      ]);
    }),
  );

  it.effect("keeps a committed new-thread import when directory finalize dies", () =>
    Effect.gen(function* () {
      const steps = yield* Ref.make<string[]>([]);
      const record = (step: string) => Ref.update(steps, (current) => [...current, step]);
      yield* runNewThreadTeleportImport({
        beginImporting: record("beginImporting"),
        commitOrchestration: record("commitOrchestration"),
        finalizeDirectory: record("finalizeDirectory").pipe(
          Effect.flatMap(() => Effect.die("directory finalize defect")),
        ),
      });
      assert.deepEqual(yield* Ref.get(steps), [
        "beginImporting",
        "commitOrchestration",
        "finalizeDirectory",
      ]);
    }),
  );

  it.effect("fails before directory persistence when a new-thread T3 commit fails", () =>
    Effect.gen(function* () {
      const steps = yield* Ref.make<string[]>([]);
      const record = (step: string) => Ref.update(steps, (current) => [...current, step]);
      const error = yield* runNewThreadTeleportImport({
        beginImporting: record("beginImporting"),
        commitOrchestration: record("commitOrchestration").pipe(
          Effect.flatMap(() => Effect.fail(importStepError("commitOrchestration"))),
        ),
        finalizeDirectory: record("finalizeDirectory"),
      }).pipe(Effect.flip);
      assert.equal(error.step, "commitOrchestration");
      assert.deepEqual(yield* Ref.get(steps), ["beginImporting", "commitOrchestration"]);
    }),
  );

  it.effect("retries after a directory failure then commits", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0);
      const first = yield* runInPlaceTeleportImport({
        beginImporting: Effect.void,
        stopSession: Effect.void,
        persistDirectory: Effect.fail(importStepError("persistDirectory")),
        commitOrchestration: Effect.void,
        finalizeDirectory: Effect.void,
        updateTitle: Effect.void,
        revertImporting: Effect.void,
      }).pipe(Effect.flip);
      assert.equal(first.step, "persistDirectory");
      yield* runInPlaceTeleportImport({
        beginImporting: Effect.void,
        stopSession: Effect.void,
        persistDirectory: Ref.update(attempts, (count) => count + 1),
        commitOrchestration: Effect.void,
        finalizeDirectory: Effect.void,
        updateTitle: Effect.void,
        revertImporting: Effect.void,
      });
      assert.equal(yield* Ref.get(attempts), 1);
    }),
  );

  it.effect("recovers leftover importing presence without stranding the thread", () =>
    Effect.gen(function* () {
      const restored = yield* Ref.make<string | null>(null);
      yield* recoverInterruptedImportTeleports({
        threads: [
          {
            id: ThreadId.make("thread-1"),
            teleport: importingTeleportState({
              base: BASE_TELEPORT,
              restorePresence: "native",
            }),
          },
          {
            id: ThreadId.make("thread-2"),
            teleport: {
              ...BASE_TELEPORT,
              presence: "t3",
            },
          },
        ],
        nextCommandId: Effect.succeed(CommandId.make("cmd-recover")),
        setTeleport: (threadId, teleport) => Ref.set(restored, `${threadId}:${teleport.presence}`),
        clearTeleport: (threadId) => Ref.set(restored, `${threadId}:cleared`),
        deleteThread: (threadId) => Ref.set(restored, `${threadId}:deleted`),
      });
      assert.equal(yield* Ref.get(restored), "thread-1:native");
    }),
  );

  it.effect("clears leftover first-time importing presence on recovery", () =>
    Effect.gen(function* () {
      const restored = yield* Ref.make<string | null>(null);
      yield* recoverInterruptedImportTeleports({
        threads: [
          {
            id: ThreadId.make("thread-first"),
            teleport: importingTeleportState({
              base: {
                ...BASE_TELEPORT,
                nativeRevision: {
                  algorithm: "sha256",
                  digest: "uncommitted",
                  byteLength: 12,
                },
              },
            }),
            historyIsEmptyOrFenceOnly: true,
          },
        ],
        nextCommandId: Effect.succeed(CommandId.make("cmd-recover-clear")),
        setTeleport: (threadId, teleport) => Ref.set(restored, `${threadId}:${teleport.presence}`),
        clearTeleport: (threadId) => Ref.set(restored, `${threadId}:cleared`),
        deleteThread: (threadId) => Ref.set(restored, `${threadId}:deleted`),
        afterRecover: (threadId, recovered) =>
          Ref.set(restored, `${threadId}:${recovered.action}:directory`),
      });
      assert.equal(yield* Ref.get(restored), "thread-first:clear:directory");
    }),
  );

  it.effect("deletes a leftover new-thread import with empty history", () =>
    Effect.gen(function* () {
      const restored = yield* Ref.make<string | null>(null);
      assert.equal(importHistoryIsEmptyOrFenceOnly([]), true);
      assert.equal(importHistoryIsEmptyOrFenceOnly([{ role: "user" }]), false);
      yield* recoverInterruptedImportTeleports({
        threads: [
          {
            id: ThreadId.make("thread-new"),
            teleport: importingTeleportState({
              base: BASE_TELEPORT,
              restorePresence: "t3",
            }),
            historyIsEmptyOrFenceOnly: true,
          },
        ],
        nextCommandId: Effect.succeed(CommandId.make("cmd-recover-delete")),
        setTeleport: (threadId, teleport) => Ref.set(restored, `${threadId}:${teleport.presence}`),
        clearTeleport: (threadId) => Ref.set(restored, `${threadId}:cleared`),
        deleteThread: (threadId) => Ref.set(restored, `${threadId}:deleted`),
      });
      assert.equal(yield* Ref.get(restored), "thread-new:deleted");
    }),
  );

  it.effect("does not delete an in-place import of an existing thread", () =>
    Effect.gen(function* () {
      const restored = yield* Ref.make<string | null>(null);
      yield* recoverInterruptedImportTeleports({
        threads: [
          {
            id: ThreadId.make("thread-inplace"),
            teleport: importingTeleportState({
              base: BASE_TELEPORT,
              restorePresence: "t3",
            }),
            historyIsEmptyOrFenceOnly: false,
          },
        ],
        nextCommandId: Effect.succeed(CommandId.make("cmd-recover-inplace")),
        setTeleport: (threadId, teleport) => Ref.set(restored, `${threadId}:${teleport.presence}`),
        clearTeleport: (threadId) => Ref.set(restored, `${threadId}:cleared`),
        deleteThread: (threadId) => Ref.set(restored, `${threadId}:deleted`),
      });
      assert.equal(yield* Ref.get(restored), "thread-inplace:cleared");
    }),
  );

  it.effect("retries a failed import recovery once", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0);
      const restored = yield* Ref.make<string | null>(null);
      yield* recoverInterruptedImportTeleports({
        threads: [
          {
            id: ThreadId.make("thread-retry"),
            teleport: importingTeleportState({
              base: BASE_TELEPORT,
              restorePresence: "native",
            }),
          },
        ],
        nextCommandId: Effect.succeed(CommandId.make("cmd-recover-retry")),
        setTeleport: (threadId, teleport) =>
          Ref.updateAndGet(attempts, (count) => count + 1).pipe(
            Effect.flatMap((count) =>
              count === 1
                ? Effect.fail("transient recovery failure" as const)
                : Ref.set(restored, `${threadId}:${teleport.presence}`),
            ),
          ),
        clearTeleport: (threadId) => Ref.set(restored, `${threadId}:cleared`),
        deleteThread: (threadId) => Ref.set(restored, `${threadId}:deleted`),
      });
      assert.equal(yield* Ref.get(attempts), 2);
      assert.equal(yield* Ref.get(restored), "thread-retry:native");
    }),
  );

  it.effect("re-fails interrupted import recovery", () =>
    Effect.gen(function* () {
      const exit = yield* recoverInterruptedImportTeleports({
        threads: [
          {
            id: ThreadId.make("thread-interrupt"),
            teleport: importingTeleportState({
              base: BASE_TELEPORT,
              restorePresence: "native",
            }),
          },
        ],
        nextCommandId: Effect.succeed(CommandId.make("cmd-recover-interrupt")),
        setTeleport: () => Effect.interrupt,
        clearTeleport: () => Effect.void,
        deleteThread: () => Effect.void,
      }).pipe(Effect.exit);
      assert.equal(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause), true);
    }),
  );

  it("finalizes a directory that lagged behind a committed T3 import", () => {
    assert.equal(
      directoryNeedsFinalizeAfterCommittedImport({
        orchestrationPresence: "t3",
        directoryPresence: "importing",
      }),
      true,
    );
    assert.equal(
      directoryNeedsFinalizeAfterCommittedImport({
        orchestrationPresence: "t3",
        directoryPresence: undefined,
      }),
      true,
    );
    assert.equal(
      directoryNeedsFinalizeAfterCommittedImport({
        orchestrationPresence: "t3",
        directoryPresence: "t3",
        directoryNativePath: pendingTeleportNativePath("codex", "session-1"),
      }),
      true,
    );
    assert.equal(
      directoryNeedsFinalizeAfterCommittedImport({
        orchestrationPresence: "t3",
        directoryPresence: "t3",
      }),
      false,
    );
    assert.equal(
      directoryNeedsFinalizeAfterCommittedImport({
        orchestrationPresence: "t3",
        directoryPresence: "native",
      }),
      false,
    );
    assert.equal(
      directoryNeedsFinalizeAfterCommittedImport({
        orchestrationPresence: "native",
        directoryPresence: "importing",
      }),
      true,
    );
    assert.equal(
      directoryNeedsFinalizeAfterCommittedImport({
        orchestrationPresence: "importing",
        directoryPresence: "importing",
      }),
      false,
    );
  });

  it.effect("repairs a lagging importing directory after a committed T3 import", () =>
    Effect.gen(function* () {
      const finalized = yield* Ref.make<string[]>([]);
      yield* recoverLaggingDirectoryImportFinalize({
        threads: [
          {
            id: ThreadId.make("thread-lagging"),
            teleport: {
              ...BASE_TELEPORT,
              presence: "t3",
            },
            directoryPresence: "importing",
          },
          {
            id: ThreadId.make("thread-ok"),
            teleport: {
              ...BASE_TELEPORT,
              presence: "t3",
            },
            directoryPresence: "t3",
          },
          {
            id: ThreadId.make("thread-importing"),
            teleport: importingTeleportState({ base: BASE_TELEPORT }),
            directoryPresence: "importing",
          },
        ],
        finalizeDirectory: (threadId) => Ref.update(finalized, (current) => [...current, threadId]),
      });
      assert.deepEqual(yield* Ref.get(finalized), ["thread-lagging"]);
    }),
  );

  it.effect("repairs a lagging importing directory after native presence is restored", () =>
    Effect.gen(function* () {
      const finalized = yield* Ref.make<string[]>([]);
      yield* recoverLaggingDirectoryImportFinalize({
        threads: [
          {
            id: ThreadId.make("thread-restored-native"),
            teleport: {
              ...BASE_TELEPORT,
              presence: "native",
            },
            directoryPresence: "importing",
          },
        ],
        finalizeDirectory: (threadId) => Ref.update(finalized, (current) => [...current, threadId]),
      });
      assert.deepEqual(yield* Ref.get(finalized), ["thread-restored-native"]);
    }),
  );

  it.effect("logs and continues when directory finalize recovery is skipped", () =>
    Effect.gen(function* () {
      const finalized = yield* Ref.make<string[]>([]);
      yield* recoverLaggingDirectoryImportFinalize({
        threads: [
          {
            id: ThreadId.make("thread-skip"),
            teleport: {
              ...BASE_TELEPORT,
              presence: "t3",
            },
            directoryPresence: "importing",
          },
          {
            id: ThreadId.make("thread-after-skip"),
            teleport: {
              ...BASE_TELEPORT,
              presence: "t3",
            },
          },
        ],
        finalizeDirectory: (threadId) => {
          if (threadId === "thread-skip") {
            return Effect.fail(importStepError("finalizeDirectory"));
          }
          return Ref.update(finalized, (current) => [...current, threadId]);
        },
      });
      assert.deepEqual(yield* Ref.get(finalized), ["thread-after-skip"]);
    }),
  );
});
