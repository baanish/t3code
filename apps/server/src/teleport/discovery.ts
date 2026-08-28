import {
  TELEPORT_SCHEMA_VERSION,
  TeleportDiscoveryError,
  TeleportSchemaVersionError,
  type ProviderInstanceId,
  type TeleportListSessionsResult,
  type TeleportProvider,
  type TeleportSessionCandidate,
} from "@t3tools/contracts";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { teleportSessionBelongsToProject } from "./cwd.ts";
import * as TeleportFormatRegistry from "./formats/registry.ts";
import {
  canonicalizeTeleportNativePath,
  configuredInstanceRootsForProvider,
  configuredTeleportNativeRootFor,
  nativePathIsUnderRoot,
  type TeleportHomes,
} from "./homes.ts";
import { definedField } from "./json.ts";
import type { ParsedNativeSession } from "./types.ts";

export const discoverTeleportSessions = Effect.fn("discoverTeleportSessions")(function* (input: {
  readonly homes: TeleportHomes;
  readonly cwd: string;
  readonly extraCwds?: ReadonlyArray<string>;
  readonly providers?: ReadonlyArray<TeleportProvider>;
}): Effect.fn.Return<
  TeleportListSessionsResult,
  TeleportSchemaVersionError | TeleportDiscoveryError,
  FileSystem.FileSystem | Path.Path | Crypto.Crypto | TeleportFormatRegistry.TeleportFormatRegistry
> {
  const formats = yield* TeleportFormatRegistry.TeleportFormatRegistry;
  const providers = input.providers ?? formats.providers;
  const sessions = [];

  for (const provider of providers) {
    const adapter = formats.get(provider);
    if (!adapter) {
      continue;
    }
    sessions.push(
      ...(yield* adapter.list({
        homes: input.homes,
        cwd: input.cwd,
        ...definedField("extraCwds", input.extraCwds),
      })),
    );
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
  const requestedRoot = configuredTeleportNativeRootFor(homes, session.provider, requested);
  const listedRoot = configuredTeleportNativeRootFor(
    homes,
    session.provider,
    session.providerInstanceId,
  );
  if (requestedRoot === undefined || listedRoot === undefined) {
    return false;
  }
  return requestedRoot === listedRoot && nativePathIsUnderRoot(session.nativePath, requestedRoot);
}

const resolveNativePathInstance = Effect.fn("resolveNativePathInstance")(function* (input: {
  readonly homes: TeleportHomes;
  readonly provider: TeleportProvider;
  readonly nativePath: string;
  readonly requestedInstanceId?: ProviderInstanceId;
}): Effect.fn.Return<
  { readonly nativePath: string; readonly instanceId: ProviderInstanceId },
  TeleportDiscoveryError,
  FileSystem.FileSystem | Path.Path
> {
  const canonicalPath = yield* canonicalizeTeleportNativePath(input.nativePath);
  const matchingInstanceIds: ProviderInstanceId[] = [];
  for (const instance of configuredInstanceRootsForProvider(input.homes, input.provider)) {
    const canonicalRoot = yield* canonicalizeTeleportNativePath(instance.root);
    if (nativePathIsUnderRoot(canonicalPath, canonicalRoot)) {
      matchingInstanceIds.push(instance.instanceId);
    }
  }

  if (input.requestedInstanceId !== undefined) {
    if (matchingInstanceIds.includes(input.requestedInstanceId)) {
      return {
        nativePath: canonicalPath,
        instanceId: input.requestedInstanceId,
      };
    }
    return yield* new TeleportDiscoveryError({
      reason: `Native ${input.provider} session path is outside instance '${input.requestedInstanceId}'.`,
    });
  }

  const instanceId = matchingInstanceIds[0];
  if (instanceId === undefined) {
    return yield* new TeleportDiscoveryError({
      reason: `Native ${input.provider} session path is outside the configured CLI home.`,
    });
  }
  return {
    nativePath: canonicalPath,
    instanceId,
  };
});

export const loadTeleportSession = Effect.fn("loadTeleportSession")(function* (input: {
  readonly homes: TeleportHomes;
  readonly provider: TeleportProvider;
  readonly externalSessionId: string;
  readonly cwd: string;
  readonly extraCwds?: ReadonlyArray<string>;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly nativePath?: string;
}): Effect.fn.Return<
  ParsedNativeSession,
  TeleportSchemaVersionError | TeleportDiscoveryError,
  FileSystem.FileSystem | Path.Path | Crypto.Crypto | TeleportFormatRegistry.TeleportFormatRegistry
> {
  const formats = yield* TeleportFormatRegistry.TeleportFormatRegistry;
  const adapter = formats.get(input.provider);
  if (!adapter) {
    return yield* new TeleportDiscoveryError({
      reason: `Native ${input.provider} session support is not registered.`,
    });
  }

  let nativePath = input.nativePath;
  if (nativePath === undefined) {
    const listed = yield* discoverTeleportSessions({
      homes: input.homes,
      cwd: input.cwd,
      providers: [input.provider],
      ...definedField("extraCwds", input.extraCwds),
    });
    const candidate = listed.sessions.find(
      (session) =>
        session.provider === input.provider &&
        session.externalSessionId === input.externalSessionId &&
        candidateMatchesRequestedInstance(session, input.providerInstanceId, input.homes),
    );
    if (!candidate) {
      return yield* new TeleportDiscoveryError({
        reason: `Native ${input.provider} session '${input.externalSessionId}' was not found for this project.`,
      });
    }
    nativePath = candidate.nativePath;
  }

  const resolved = yield* resolveNativePathInstance({
    homes: input.homes,
    provider: input.provider,
    nativePath,
    ...(input.providerInstanceId === undefined
      ? {}
      : { requestedInstanceId: input.providerInstanceId }),
  });

  const parsed = yield* adapter.load({
    homes: input.homes,
    cwd: input.cwd,
    externalSessionId: input.externalSessionId,
    nativePath: resolved.nativePath,
  });
  if (parsed.externalSessionId !== input.externalSessionId) {
    return yield* new TeleportDiscoveryError({
      reason: `Native ${input.provider} session at '${resolved.nativePath}' no longer matches '${input.externalSessionId}'.`,
    });
  }
  const cwdMatches = yield* teleportSessionBelongsToProject({
    sessionCwd: parsed.cwd,
    projectCwd: input.cwd,
    ...definedField("extraCwds", input.extraCwds),
  });
  if (!cwdMatches) {
    return yield* new TeleportDiscoveryError({
      reason: `Native ${input.provider} session '${input.externalSessionId}' no longer belongs to this project.`,
    });
  }
  return {
    ...parsed,
    ...definedField("providerInstanceId", resolved.instanceId),
  };
});
