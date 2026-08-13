import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import * as Effect from "effect/Effect";

import { OpenCodeRuntimeError, runOpenCodeSdk } from "./opencodeRuntime.ts";

export const OPENCODE_RESUME_VERSION = 1 as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseOpenCodeResume(raw: unknown): { sessionId: string } | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== OPENCODE_RESUME_VERSION) return undefined;
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;
  return { sessionId: raw.sessionId.trim() };
}

export function openExistingOpenCodeSession(
  client: OpencodeClient,
  sessionId: string,
): Effect.Effect<{ id: string }, OpenCodeRuntimeError> {
  const sessionApi = client.session as typeof client.session & {
    get?: (input: { sessionID: string }) => Promise<{ data?: { id?: string } | null }>;
  };

  if (typeof sessionApi.get === "function") {
    return Effect.gen(function* () {
      const response = yield* runOpenCodeSdk(
        "session.get",
        () =>
          sessionApi.get?.({ sessionID: sessionId }) ??
          Promise.reject(new Error("OpenCode session.get is unavailable.")),
      );
      const returnedId =
        typeof response.data?.id === "string" && response.data.id.trim()
          ? response.data.id.trim()
          : undefined;
      if (returnedId === undefined) {
        return yield* new OpenCodeRuntimeError({
          operation: "session.get",
          detail: `OpenCode session.get returned no session payload for requested session '${sessionId}'.`,
        });
      }
      if (returnedId !== sessionId) {
        return yield* new OpenCodeRuntimeError({
          operation: "session.get",
          detail: `OpenCode session.get returned '${returnedId}' for requested session '${sessionId}'.`,
        });
      }
      return { id: sessionId };
    });
  }

  return Effect.fail(
    new OpenCodeRuntimeError({
      operation: "session.get",
      detail: "Installed OpenCode SDK/server cannot resume sessions by id.",
    }),
  );
}
