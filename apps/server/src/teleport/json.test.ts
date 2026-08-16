import { describe, expect, it } from "@effect/vitest";

import { isSafeTeleportSessionId, nativeSessionText } from "./json.ts";

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
});
