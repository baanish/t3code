import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  resolveTeleportPresence,
  TeleportExportError,
  TeleportLockProbeError,
  TeleportRuntimePayload,
  TeleportThreadState,
} from "./teleport.ts";

const decodeTeleportThreadState = Schema.decodeUnknownSync(TeleportThreadState);
const decodeTeleportRuntimePayload = Schema.decodeUnknownSync(TeleportRuntimePayload);
const decodeTeleportExportError = Schema.decodeUnknownSync(TeleportExportError);

describe("teleport presence", () => {
  it("decodes a complete thread teleport state", () => {
    const parsed = decodeTeleportThreadState({
      presence: "native",
      provider: "grok",
      externalSessionId: "session-1",
      nativePath: "/home/user/.grok/sessions/session-1",
      lastSyncedAt: "2026-08-14T22:00:00.000Z",
    });
    expect(parsed.presence).toBe("native");
    expect(parsed.provider).toBe("grok");
  });

  it("uses an explicit presence on the runtime payload", () => {
    const parsed = decodeTeleportRuntimePayload({
      schemaVersion: 1,
      externalSessionId: "session-1",
      nativePath: "/tmp/session.jsonl",
      lastSyncDirection: "export",
      lastSyncedAt: "2026-08-14T22:00:00.000Z",
      nativeFormatVersion: 1,
      presence: "t3",
    });
    expect(resolveTeleportPresence(parsed)).toBe("t3");
  });

  it("treats a legacy export as native presence", () => {
    const parsed = decodeTeleportRuntimePayload({
      schemaVersion: 1,
      externalSessionId: "session-1",
      nativePath: "/tmp/session.jsonl",
      lastSyncDirection: "export",
      lastSyncedAt: "2026-08-14T22:00:00.000Z",
      nativeFormatVersion: 1,
    });
    expect(parsed.presence).toBeUndefined();
    expect(resolveTeleportPresence(parsed)).toBe("native");
  });

  it("treats a legacy import as t3 presence", () => {
    expect(
      resolveTeleportPresence({
        lastSyncDirection: "import",
      }),
    ).toBe("t3");
  });
});

describe("teleport lock probe errors", () => {
  it("are part of the export error union", () => {
    const parsed = decodeTeleportExportError({
      _tag: "TeleportLockProbeError",
      nativePath: "/tmp/session.jsonl",
      message: "Failed to check whether /tmp/session.jsonl is locked.",
    });
    expect(parsed._tag).toBe("TeleportLockProbeError");
    expect(parsed).toBeInstanceOf(TeleportLockProbeError);
  });
});
