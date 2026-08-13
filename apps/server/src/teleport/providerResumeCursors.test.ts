import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { ProviderDriverKind } from "@t3tools/contracts";
import {
  buildTeleportResumeCursor,
  readTeleportProviderSessionId,
} from "./providerResumeCursors.ts";

describe("buildTeleportResumeCursor", () => {
  it("maps Codex imports to Codex thread resume cursors", () => {
    const cursor = Effect.runSync(
      buildTeleportResumeCursor({
        provider: ProviderDriverKind.make("codex"),
        externalSessionId: "codex-thread-1",
      }),
    );

    expect(cursor).toEqual({ threadId: "codex-thread-1" });
  });

  it("maps Cursor and OpenCode imports to session id resume cursors", () => {
    const cursor = Effect.runSync(
      buildTeleportResumeCursor({
        provider: ProviderDriverKind.make("cursor"),
        externalSessionId: "cursor-session-1",
      }),
    );
    const openCodeCursor = Effect.runSync(
      buildTeleportResumeCursor({
        provider: ProviderDriverKind.make("opencode"),
        externalSessionId: "opencode-session-1",
      }),
    );

    expect(cursor).toEqual({ schemaVersion: 1, sessionId: "cursor-session-1" });
    expect(openCodeCursor).toEqual({ schemaVersion: 1, sessionId: "opencode-session-1" });
  });

  it("rejects unsupported providers", () => {
    const exit = Effect.runSyncExit(
      buildTeleportResumeCursor({
        provider: ProviderDriverKind.make("claudeAgent"),
        externalSessionId: "claude-session-1",
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
  });
});

describe("readTeleportProviderSessionId", () => {
  it("reads provider session ids from supported cursor shapes", () => {
    expect(
      readTeleportProviderSessionId({
        provider: ProviderDriverKind.make("codex"),
        resumeCursor: { threadId: "codex-thread-1" },
      }),
    ).toBe("codex-thread-1");
    expect(
      readTeleportProviderSessionId({
        provider: ProviderDriverKind.make("cursor"),
        resumeCursor: { schemaVersion: 1, sessionId: "cursor-session-1" },
      }),
    ).toBe("cursor-session-1");
    expect(
      readTeleportProviderSessionId({
        provider: ProviderDriverKind.make("opencode"),
        resumeCursor: { schemaVersion: 1, sessionId: "opencode-session-1" },
      }),
    ).toBe("opencode-session-1");
  });
});
