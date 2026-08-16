import {
  TELEPORT_SCHEMA_VERSION,
  TeleportDiscoveryError,
  TeleportSchemaVersionError,
  type ProviderInstanceId,
  type TeleportListSessionsResult,
  type TeleportProvider,
  type TeleportSessionCandidate,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { isTeleportCwdWithin, teleportCwdsEquivalent } from "./cwd.ts";
import { getTeleportFormat, listRegisteredTeleportProviders } from "./formats/registry.ts";
import { nativePathIsUnderRoot, teleportNativeRootFor, type TeleportHomes } from "./homes.ts";
import { definedField } from "./json.ts";
import type { ParsedNativeSession } from "./types.ts";

export const discoverTeleportSessions = Effect.fn("discoverTeleportSessions")(function* (input: {
  readonly homes: TeleportHomes;
  readonly cwd: string;
  readonly providers?: ReadonlyArray<TeleportProvider>;
}): Effect.fn.Return<
  TeleportListSessionsResult,
  TeleportSchemaVersionError | TeleportDiscoveryError,
  FileSystem.FileSystem | Path.Path
> {
  const providers = input.providers ?? listRegisteredTeleportProviders();
  const sessions = [];

  for (const provider of providers) {
    const adapter = getTeleportFormat(provider);
    if (!adapter) {
      continue;
    }
    sessions.push(...(yield* adapter.list({ homes: input.homes, cwd: input.cwd })));
  }

  return {
    schemaVersion: TELEPORT_SCHEMA_VERSION,
    sessions: sessions.toSorted((left, right) => {
      const leftAt = left.updatedAt ?? left.createdAt ?? "";
      const rightAt = right.updatedAt ?? right.createdAt ?? "";
      return rightAt.localeCompare(leftAt);
    }),
  };
});

function candidateMatchesRequestedInstance(
  session: TeleportSessionCandidate,
  requested: ProviderInstanceId | undefined,
  homes: TeleportHomes,
): boolean {
  if (requested === undefined || session.providerInstanceId === requested) {
    return true;
  }
  const requestedRoot = teleportNativeRootFor(homes, session.provider, requested);
  const listedRoot = teleportNativeRootFor(homes, session.provider, session.providerInstanceId);
  return requestedRoot === listedRoot && nativePathIsUnderRoot(session.nativePath, requestedRoot);
}

export const loadTeleportSession = Effect.fn("loadTeleportSession")(function* (input: {
  readonly homes: TeleportHomes;
  readonly provider: TeleportProvider;
  readonly externalSessionId: string;
  readonly cwd: string;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly nativePath?: string;
}): Effect.fn.Return<
  ParsedNativeSession,
  TeleportSchemaVersionError | TeleportDiscoveryError,
  FileSystem.FileSystem | Path.Path
> {
  const adapter = getTeleportFormat(input.provider);
  if (!adapter) {
    return yield* new TeleportDiscoveryError({
      message: `Native ${input.provider} session support is not registered.`,
    });
  }

  let nativePath = input.nativePath;
  let listedInstanceId = input.providerInstanceId;
  if (nativePath === undefined) {
    const listed = yield* discoverTeleportSessions({
      homes: input.homes,
      cwd: input.cwd,
      providers: [input.provider],
    });
    const candidate = listed.sessions.find(
      (session) =>
        session.provider === input.provider &&
        session.externalSessionId === input.externalSessionId &&
        candidateMatchesRequestedInstance(session, input.providerInstanceId, input.homes),
    );
    if (!candidate) {
      return yield* new TeleportDiscoveryError({
        message: `Native ${input.provider} session '${input.externalSessionId}' was not found for this project.`,
      });
    }
    nativePath = candidate.nativePath;
    listedInstanceId = input.providerInstanceId ?? candidate.providerInstanceId;
  }

  const parsed = yield* adapter.load({
    homes: input.homes,
    cwd: input.cwd,
    externalSessionId: input.externalSessionId,
    nativePath,
  });
  if (parsed.externalSessionId !== input.externalSessionId) {
    return yield* new TeleportDiscoveryError({
      message: `Native ${input.provider} session at '${nativePath}' no longer matches '${input.externalSessionId}'.`,
    });
  }
  const cwdMatches =
    (yield* teleportCwdsEquivalent(parsed.cwd, input.cwd)) ||
    isTeleportCwdWithin(parsed.cwd, input.cwd) ||
    isTeleportCwdWithin(input.cwd, parsed.cwd);
  if (!cwdMatches) {
    return yield* new TeleportDiscoveryError({
      message: `Native ${input.provider} session '${input.externalSessionId}' no longer belongs to this project.`,
    });
  }
  return {
    ...parsed,
    ...definedField("providerInstanceId", listedInstanceId ?? parsed.providerInstanceId),
  };
});
