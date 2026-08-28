import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  canForkTeleportNativeConflict,
  shouldShowTeleportNativeConflict,
  teleportNativeConflictDescription,
  teleportNativeConflictResultForThread,
  teleportNativeConflictTitle,
} from "./teleportNativeConflict";

describe("teleport native conflict copy", () => {
  it("shows a forkable warning for a diverged file", () => {
    expect(shouldShowTeleportNativeConflict("diverged")).toBe(true);
    expect(teleportNativeConflictTitle("diverged")).toBe("Native CLI session changed");
    expect(teleportNativeConflictDescription({ status: "diverged" })).toContain("Fork");
  });

  it("shows a blocking warning for a missing file without a fork action", () => {
    expect(shouldShowTeleportNativeConflict("missing")).toBe(true);
    expect(teleportNativeConflictTitle("missing")).toBe("Native session file is missing");
    expect(teleportNativeConflictDescription({ status: "missing" })).not.toContain("Fork");
    expect(canForkTeleportNativeConflict({ status: "missing" })).toBe(false);
  });

  it("shows a blocking warning for an oversize file without a fork action", () => {
    expect(shouldShowTeleportNativeConflict("oversize")).toBe(true);
    expect(teleportNativeConflictTitle("oversize")).toBe("Native session file is too large");
    expect(teleportNativeConflictDescription({ status: "oversize" })).not.toContain("Fork");
    expect(canForkTeleportNativeConflict({ status: "oversize" })).toBe(false);
  });

  it("only offers fork when a diverged file has an observed revision", () => {
    expect(
      canForkTeleportNativeConflict({
        status: "diverged",
        observedRevision: { algorithm: "sha256", digest: "abc", byteLength: 12 },
      }),
    ).toBe(true);
    expect(canForkTeleportNativeConflict({ status: "diverged" })).toBe(false);
  });

  it("hides the banner when the file is unchanged or already forked", () => {
    expect(shouldShowTeleportNativeConflict("unchanged")).toBe(false);
    expect(shouldShowTeleportNativeConflict("forked")).toBe(false);
    expect(shouldShowTeleportNativeConflict("untracked")).toBe(false);
  });

  it("ignores a previous thread's native conflict after navigation", () => {
    const matching = {
      schemaVersion: 1 as const,
      threadId: ThreadId.make("thread-b"),
      status: "diverged" as const,
    };
    expect(
      teleportNativeConflictResultForThread({
        threadId: ThreadId.make("thread-b"),
        watching: true,
        result: {
          schemaVersion: 1,
          threadId: ThreadId.make("thread-a"),
          status: "diverged",
        },
      }),
    ).toBeNull();
    expect(
      teleportNativeConflictResultForThread({
        threadId: ThreadId.make("thread-b"),
        watching: false,
        result: matching,
      }),
    ).toBeNull();
    expect(
      teleportNativeConflictResultForThread({
        threadId: ThreadId.make("thread-b"),
        watching: true,
        result: matching,
      }),
    ).toEqual(matching);
  });
});
