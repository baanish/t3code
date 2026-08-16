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

import { getTeleportFormat } from "./formats/registry.ts";
import { isRecord, nonEmptyString } from "./json.ts";

const decodeTeleportRuntimePayload = Schema.decodeUnknownOption(TeleportRuntimePayload);

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
  return (
    getTeleportFormat(input.provider)?.resumeCursor(input.externalSessionId) ?? {
      sessionId: input.externalSessionId,
    }
  );
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
  readonly providerInstanceId?: TeleportThreadState["providerInstanceId"];
  readonly payload: TeleportRuntimePayload;
}): TeleportThreadState {
  return {
    presence: resolveTeleportPresence(input.payload),
    provider: input.provider,
    ...(input.providerInstanceId === undefined
      ? {}
      : { providerInstanceId: input.providerInstanceId }),
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

  if (!isTeleportProvider(input.provider)) {
    return undefined;
  }
  return getTeleportFormat(input.provider)?.readExternalSessionId(input.resumeCursor);
}
