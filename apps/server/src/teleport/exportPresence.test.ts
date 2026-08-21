import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import {
  isPendingTeleportNativePath,
  pendingTeleportNativePath,
  recoveredInterruptedExportState,
  teleportExportPresenceOnFailure,
} from "./exportPresence.ts";

describe("teleport export presence", () => {
  it("builds and detects pending native path sentinels", () => {
    const pending = pendingTeleportNativePath("codex", "11111111-1111-4111-8111-111111111111");
    assert.equal(pending, "teleport-pending:codex:11111111-1111-4111-8111-111111111111");
    assert.equal(isPendingTeleportNativePath(pending), true);
    assert.equal(isPendingTeleportNativePath("/home/user/.codex/sessions/rollout.jsonl"), false);
  });

  it("recovers a pending export to T3 when no native file was written", () => {
    assert.deepEqual(
      recoveredInterruptedExportState(
        {
          presence: "native",
          provider: "codex",
          externalSessionId: "11111111-1111-4111-8111-111111111111",
          nativePath: "teleport-pending:codex:11111111-1111-4111-8111-111111111111",
          lastSyncedAt: "2026-08-14T22:00:00.000Z",
        },
        undefined,
      ),
      {
        presence: "t3",
        provider: "codex",
        externalSessionId: "11111111-1111-4111-8111-111111111111",
        nativePath: "teleport-pending:codex:11111111-1111-4111-8111-111111111111",
        lastSyncedAt: "2026-08-14T22:00:00.000Z",
      },
    );
  });

  it("recovers a pending export to the discovered native file", () => {
    const nativePath = "/home/user/.codex/sessions/rollout.jsonl";
    assert.deepEqual(
      recoveredInterruptedExportState(
        {
          presence: "native",
          provider: "codex",
          externalSessionId: "11111111-1111-4111-8111-111111111111",
          nativePath: "teleport-pending:codex:11111111-1111-4111-8111-111111111111",
          lastSyncedAt: "2026-08-14T22:00:00.000Z",
        },
        nativePath,
      ),
      {
        presence: "native",
        provider: "codex",
        externalSessionId: "11111111-1111-4111-8111-111111111111",
        nativePath,
        lastSyncedAt: "2026-08-14T22:00:00.000Z",
      },
    );
  });

  it.effect("reverts presence when the native file was never written", () =>
    Effect.gen(function* () {
      const outcome = yield* Ref.make("none");
      yield* teleportExportPresenceOnFailure({
        writtenNativePath: undefined,
        revert: Ref.set(outcome, "reverted"),
        persistWritten: (nativePath) => Ref.set(outcome, nativePath),
      });
      assert.equal(yield* Ref.get(outcome), "reverted");
    }),
  );

  it.effect("persists the real native path when write succeeded and later steps failed", () =>
    Effect.gen(function* () {
      const outcome = yield* Ref.make("none");
      yield* teleportExportPresenceOnFailure({
        writtenNativePath: "/home/user/.codex/sessions/rollout.jsonl",
        revert: Ref.set(outcome, "reverted"),
        persistWritten: (nativePath) => Ref.set(outcome, nativePath),
      });
      assert.equal(yield* Ref.get(outcome), "/home/user/.codex/sessions/rollout.jsonl");
    }),
  );
});
