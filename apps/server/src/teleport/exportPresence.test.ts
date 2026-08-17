import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import {
  isPendingTeleportNativePath,
  pendingTeleportNativePath,
  realExportNativePath,
  teleportExportPresenceOnFailure,
} from "./exportPresence.ts";

describe("teleport export presence", () => {
  it("builds and detects pending native path sentinels", () => {
    const pending = pendingTeleportNativePath("codex", "11111111-1111-4111-8111-111111111111");
    assert.equal(pending, "teleport-pending:codex:11111111-1111-4111-8111-111111111111");
    assert.equal(isPendingTeleportNativePath(pending), true);
    assert.equal(isPendingTeleportNativePath("/home/user/.codex/sessions/rollout.jsonl"), false);
  });

  it("ignores pending sentinels when reusing an export path", () => {
    assert.equal(realExportNativePath("teleport-pending:claudeAgent:abc"), undefined);
    assert.equal(
      realExportNativePath("/home/user/.codex/sessions/rollout.jsonl"),
      "/home/user/.codex/sessions/rollout.jsonl",
    );
    assert.equal(realExportNativePath(undefined), undefined);
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
