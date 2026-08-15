import {
  isTeleportProvider,
  ProviderDriverKind,
  resolveTeleportPresence,
  TeleportRuntimePayload,
  TeleportUnsupportedProviderError,
  type TeleportProvider,
  type TeleportThreadState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { isRecord, nonEmptyString } from "./json.ts";

const decodeTeleportRuntimePayload = Schema.decodeUnknownOption(TeleportRuntimePayload);

const CODEX = ProviderDriverKind.make("codex");
const CLAUDE = ProviderDriverKind.make("claudeAgent");
const OPENCODE = ProviderDriverKind.make("opencode");
const GROK = ProviderDriverKind.make("grok");

export function toTeleportProvider(
  provider: ProviderDriverKind,
): Effect.Effect<TeleportProvider, TeleportUnsupportedProviderError> {
  if (isTeleportProvider(provider)) {
    return Effect.succeed(provider);
  }
  return Effect.fail(
    new TeleportUnsupportedProviderError({
      provider,
      message: `Teleport does not support provider '${provider}'.`,
    }),
  );
}

export function buildTeleportResumeCursor(input: {
  readonly provider: TeleportProvider;
  readonly externalSessionId: string;
}): unknown {
  switch (input.provider) {
    case "codex":
      return { threadId: input.externalSessionId };
    case "claudeAgent":
      return { resume: input.externalSessionId };
    case "opencode":
    case "grok":
      return { schemaVersion: 1, sessionId: input.externalSessionId };
    default: {
      const _exhaustive: never = input.provider;
      return _exhaustive;
    }
  }
}

export function readTeleportRuntimePayload(
  runtimePayload: unknown,
): TeleportRuntimePayload | undefined {
  if (!isRecord(runtimePayload)) {
    return undefined;
  }
  return Option.getOrUndefined(decodeTeleportRuntimePayload(runtimePayload.teleport));
}

export function teleportThreadStateFromPayload(input: {
  readonly provider: TeleportProvider;
  readonly payload: TeleportRuntimePayload;
}): TeleportThreadState {
  return {
    presence: resolveTeleportPresence(input.payload),
    provider: input.provider,
    externalSessionId: input.payload.externalSessionId,
    nativePath: input.payload.nativePath,
    lastSyncedAt: input.payload.lastSyncedAt,
  };
}

export function readTeleportExternalSessionId(input: {
  readonly provider: ProviderDriverKind;
  readonly resumeCursor: unknown;
  readonly runtimePayload: unknown;
}): string | undefined {
  if (isRecord(input.runtimePayload)) {
    const teleport = input.runtimePayload.teleport;
    if (isRecord(teleport)) {
      const externalSessionId = nonEmptyString(teleport.externalSessionId);
      if (externalSessionId) {
        return externalSessionId;
      }
    }
  }

  if (!isRecord(input.resumeCursor)) {
    return undefined;
  }

  switch (input.provider) {
    case CODEX:
      return nonEmptyString(input.resumeCursor.threadId);
    case CLAUDE:
      return (
        nonEmptyString(input.resumeCursor.resume) ?? nonEmptyString(input.resumeCursor.threadId)
      );
    case OPENCODE:
    case GROK:
      return nonEmptyString(input.resumeCursor.sessionId);
    default:
      return undefined;
  }
}
