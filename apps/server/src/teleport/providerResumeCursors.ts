import * as Effect from "effect/Effect";
import {
  ProviderDriverKind,
  TeleportUnsupportedProviderError,
  type TeleportImportError,
} from "@t3tools/contracts";

const CODEX = ProviderDriverKind.make("codex");
const CURSOR = ProviderDriverKind.make("cursor");
const OPENCODE = ProviderDriverKind.make("opencode");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function buildTeleportResumeCursor(input: {
  readonly provider: ProviderDriverKind;
  readonly externalSessionId: string;
}): Effect.Effect<unknown, TeleportImportError> {
  switch (input.provider) {
    case CODEX:
      return Effect.succeed({ threadId: input.externalSessionId });
    case CURSOR:
    case OPENCODE:
      return Effect.succeed({
        schemaVersion: 1,
        sessionId: input.externalSessionId,
      });
    default:
      return Effect.fail(
        new TeleportUnsupportedProviderError({
          provider: input.provider,
          message: `Teleport import does not support provider '${input.provider}'.`,
        }),
      );
  }
}

export function readTeleportProviderSessionId(input: {
  readonly provider: ProviderDriverKind;
  readonly resumeCursor: unknown;
}): string | undefined {
  if (!isRecord(input.resumeCursor)) {
    return undefined;
  }
  if (input.provider === CODEX) {
    const threadId = input.resumeCursor.threadId;
    return typeof threadId === "string" && threadId.trim() ? threadId.trim() : undefined;
  }
  if (input.provider === CURSOR || input.provider === OPENCODE) {
    const sessionId = input.resumeCursor.sessionId;
    return typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : undefined;
  }
  return undefined;
}

export function isTeleportSupportedProvider(provider: ProviderDriverKind): boolean {
  return provider === CODEX || provider === CURSOR || provider === OPENCODE;
}
