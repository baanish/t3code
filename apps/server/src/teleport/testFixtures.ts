import { TELEPORT_NATIVE_FORMAT_VERSION } from "@t3tools/contracts";

import type { ParsedNativeSession } from "./types.ts";

export const TELEPORT_TEST_SESSION_ID = "11111111-1111-4111-8111-111111111111";
export const TELEPORT_TEST_CREATED_AT = "2026-08-14T06:00:00.000Z";

export function sampleTeleportSession(
  provider: ParsedNativeSession["provider"],
  cwd = "/workspace",
): ParsedNativeSession {
  return {
    provider,
    externalSessionId: TELEPORT_TEST_SESSION_ID,
    cwd,
    nativePath: `/tmp/${provider}.session`,
    nativeFormatVersion: TELEPORT_NATIVE_FORMAT_VERSION,
    title: "Fix the flaky matcher",
    createdAt: TELEPORT_TEST_CREATED_AT,
    updatedAt: "2026-08-14T06:01:00.000Z",
    messages: [
      {
        role: "user",
        text: "Fix the flaky matcher",
        createdAt: TELEPORT_TEST_CREATED_AT,
        id: "user-1",
      },
      {
        role: "assistant",
        text: "I'll tighten the path comparison and add a realpath fallback.",
        createdAt: "2026-08-14T06:01:00.000Z",
        id: "assistant-1",
      },
    ],
  };
}
