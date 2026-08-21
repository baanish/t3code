import { CommandId, TELEPORT_IMPORT_BATCH_SEMANTICS, ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";

import {
  committedTeleportImportState,
  importSessionBatch,
  importingTeleportState,
  nativeTranscriptWouldWipeExistingHistory,
  recoverInterruptedImportTeleports,
  restorePresenceForImport,
  restoredTeleportStateAfterInterruptedImport,
  runInPlaceTeleportImport,
  runNewThreadTeleportImport,
} from "./importTransaction.ts";

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

  it("restores native presence after an interrupted import", () => {
    const importing = importingTeleportState({
      base: BASE_TELEPORT,
      restorePresence: "native",
    });
    assert.equal(importing.presence, "importing");
    assert.equal(restorePresenceForImport(importing), "native");
    assert.deepEqual(restoredTeleportStateAfterInterruptedImport(importing), {
      ...BASE_TELEPORT,
      presence: "native",
    });
    assert.equal(
      restoredTeleportStateAfterInterruptedImport(committedTeleportImportState(importing)),
      null,
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
      });
      assert.equal(yield* Ref.get(restored), "thread-1:native");
    }),
  );
});
