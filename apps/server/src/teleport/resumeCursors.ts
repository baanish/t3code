import {
  isTeleportProvider,
  ProviderDriverKind,
  resolveTeleportPresence,
  TELEPORT_SCHEMA_VERSION,
  TeleportRuntimePayload,
  TeleportUnsupportedProviderError,
  type TeleportProvider,
  type TeleportThreadState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { TeleportFormatAdapter } from "./formats/adapter.ts";
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
    }),
  );
}

export function buildTeleportResumeCursor(input: {
  readonly provider: TeleportProvider;
  readonly externalSessionId: string;
  readonly adapter?: TeleportFormatAdapter | undefined;
}): unknown {
  return (
    input.adapter?.resumeCursor(input.externalSessionId) ?? {
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

export function teleportRuntimePayloadFromThreadState(
  teleport: TeleportThreadState,
  extras: {
    readonly lastSyncDirection: TeleportRuntimePayload["lastSyncDirection"];
    readonly nativeFormatVersion: TeleportRuntimePayload["nativeFormatVersion"];
  },
): TeleportRuntimePayload {
  return {
    schemaVersion: TELEPORT_SCHEMA_VERSION,
    externalSessionId: teleport.externalSessionId,
    nativePath: teleport.nativePath,
    lastSyncDirection: extras.lastSyncDirection,
    lastSyncedAt: teleport.lastSyncedAt,
    nativeFormatVersion: extras.nativeFormatVersion,
    presence: teleport.presence,
    ...(teleport.nativeRevision === undefined ? {} : { nativeRevision: teleport.nativeRevision }),
  };
}

export function teleportThreadStateFromPayload(input: {
  readonly provider: TeleportProvider;
  readonly providerInstanceId?: TeleportThreadState["providerInstanceId"];
  readonly payload: TeleportRuntimePayload;
  readonly forkedFromThreadId?: TeleportThreadState["forkedFromThreadId"];
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
    ...(input.payload.nativeRevision === undefined
      ? {}
      : { nativeRevision: input.payload.nativeRevision }),
    ...(input.forkedFromThreadId === undefined
      ? {}
      : { forkedFromThreadId: input.forkedFromThreadId }),
  };
}

export function readTeleportExternalSessionId(input: {
  readonly provider: ProviderDriverKind;
  readonly resumeCursor: unknown;
  readonly runtimePayload: unknown;
  readonly adapter?: TeleportFormatAdapter | undefined;
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

  return input.adapter?.readExternalSessionId(input.resumeCursor);
}
