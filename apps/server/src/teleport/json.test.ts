import { describe, expect, it } from "@effect/vitest";

import {
  isSafeTeleportSessionId,
  isSyntheticNativeUserText,
  nativeSessionText,
  parseJsonObject,
  uuidFromPath,
} from "./json.ts";
import { isOversizeTeleportSession, MAX_TELEPORT_SESSION_BYTES } from "./types.ts";

describe("teleport json helpers", () => {
  it("keeps leading and trailing whitespace on native session text", () => {
    expect(nativeSessionText("  keep this  \n")).toBe("  keep this  \n");
    expect(nativeSessionText("   ")).toBeUndefined();
    expect(nativeSessionText(1)).toBeUndefined();
  });

  it("rejects session ids that can traverse out of the native root", () => {
    expect(isSafeTeleportSessionId("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")).toBe(true);
    expect(isSafeTeleportSessionId("ses_sample")).toBe(true);
    expect(isSafeTeleportSessionId("../.codex/sessions")).toBe(false);
    expect(isSafeTeleportSessionId("..\\..\\.codex")).toBe(false);
    expect(isSafeTeleportSessionId("..")).toBe(false);
    expect(isSafeTeleportSessionId(".")).toBe(false);
  });

  it("treats Claude slash-command records as synthetic user text", () => {
    expect(isSyntheticNativeUserText("<local-command-caveat>\nCaveat:\n")).toBe(true);
    expect(isSyntheticNativeUserText("<command-name>/init</command-name>")).toBe(true);
    expect(isSyntheticNativeUserText("<system-reminder>stay on task</system-reminder>")).toBe(true);
    expect(isSyntheticNativeUserText("<local-command-stdout>ok</local-command-stdout>")).toBe(true);
    expect(isSyntheticNativeUserText("Use a light theme")).toBe(false);
  });

  it("parses a BOM-prefixed first JSONL record", () => {
    expect(parseJsonObject('\uFEFF{"type":"session_meta"}')).toEqual({
      type: "session_meta",
    });
  });

  it("extracts a rollout UUID from the filename, not parent directories", () => {
    expect(
      uuidFromPath(
        "/tmp/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/rollout-2026-08-14T06-00-00-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl",
      ),
    ).toBe("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  });

  it("compares native session sizes as bigint", () => {
    expect(isOversizeTeleportSession(BigInt(MAX_TELEPORT_SESSION_BYTES) + 1n)).toBe(true);
    expect(isOversizeTeleportSession(MAX_TELEPORT_SESSION_BYTES)).toBe(false);
    expect(isOversizeTeleportSession(1)).toBe(false);
  });
});
