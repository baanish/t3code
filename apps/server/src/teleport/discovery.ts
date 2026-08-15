import {
  TELEPORT_SCHEMA_VERSION,
  TeleportDiscoveryError,
  TeleportSchemaVersionError,
  type TeleportListSessionsResult,
  type TeleportProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { getTeleportFormat, listRegisteredTeleportProviders } from "./formats/registry.ts";
import type { TeleportHomes } from "./homes.ts";
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

export const loadTeleportSession = Effect.fn("loadTeleportSession")(function* (input: {
  readonly homes: TeleportHomes;
  readonly provider: TeleportProvider;
  readonly externalSessionId: string;
  readonly cwd: string;
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

  const listed = yield* discoverTeleportSessions({
    homes: input.homes,
    cwd: input.cwd,
    providers: [input.provider],
  });
  const candidate = listed.sessions.find(
    (session) =>
      session.provider === input.provider && session.externalSessionId === input.externalSessionId,
  );
  if (!candidate) {
    return yield* new TeleportDiscoveryError({
      message: `Native ${input.provider} session '${input.externalSessionId}' was not found for this project.`,
    });
  }

  return yield* adapter.load({
    homes: input.homes,
    cwd: input.cwd,
    externalSessionId: input.externalSessionId,
    nativePath: candidate.nativePath,
  });
});
