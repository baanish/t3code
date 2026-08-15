import {
  TELEPORT_SCHEMA_VERSION,
  TeleportDiscoveryError,
  TeleportSchemaVersionError,
  type TeleportListSessionsResult,
  type TeleportProvider,
  type TeleportSessionCandidate,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { teleportCwdsEquivalent } from "./cwd.ts";
import {
  listClaudeJsonlFiles,
  parseClaudeSessionContents,
  toClaudeCandidate,
} from "./formats/claude.ts";
import {
  listCodexJsonlFiles,
  parseCodexSessionContents,
  toCodexCandidate,
} from "./formats/codex.ts";
import { listGrokSessionDirs, readGrokSessionFromDir, toGrokCandidate } from "./formats/grok.ts";
import {
  listOpenCodeSessions,
  readOpenCodeSessionById,
  toOpenCodeCandidate,
} from "./formats/opencode.ts";
import type { TeleportHomes } from "./homes.ts";
import { MAX_TELEPORT_SESSION_BYTES, type ParsedNativeSession } from "./types.ts";

const ALL_PROVIDERS: ReadonlyArray<TeleportProvider> = ["codex", "claudeAgent", "opencode", "grok"];

export const discoverTeleportSessions = Effect.fn("discoverTeleportSessions")(function* (input: {
  readonly homes: TeleportHomes;
  readonly cwd: string;
  readonly providers?: ReadonlyArray<TeleportProvider>;
}): Effect.fn.Return<
  TeleportListSessionsResult,
  TeleportSchemaVersionError | TeleportDiscoveryError,
  FileSystem.FileSystem | Path.Path
> {
  const providers = input.providers ?? ALL_PROVIDERS;
  const sessions: TeleportSessionCandidate[] = [];

  for (const provider of providers) {
    switch (provider) {
      case "codex": {
        const files = yield* listCodexJsonlFiles(input.homes.codexSessionsRoot);
        for (const nativePath of files) {
          const parsed = yield* readParsedSessionFile({
            nativePath,
            parse: parseCodexSessionContents,
          });
          if (Option.isNone(parsed)) {
            continue;
          }
          if (!(yield* teleportCwdsEquivalent(parsed.value.cwd, input.cwd))) {
            continue;
          }
          sessions.push(toCodexCandidate(parsed.value));
        }
        break;
      }
      case "claudeAgent": {
        const files = yield* listClaudeJsonlFiles(input.homes.claudeProjectsRoot, input.cwd);
        for (const nativePath of files) {
          const parsed = yield* readParsedSessionFile({
            nativePath,
            parse: parseClaudeSessionContents,
          });
          if (Option.isNone(parsed)) {
            continue;
          }
          if (!(yield* teleportCwdsEquivalent(parsed.value.cwd, input.cwd))) {
            continue;
          }
          sessions.push(toClaudeCandidate(parsed.value));
        }
        break;
      }
      case "opencode": {
        const parsedSessions = yield* listOpenCodeSessions({
          opencodeRoot: input.homes.opencodeRoot,
          cwd: input.cwd,
        });
        sessions.push(...parsedSessions.map(toOpenCodeCandidate));
        break;
      }
      case "grok": {
        const dirs = yield* listGrokSessionDirs(input.homes.grokSessionsRoot);
        for (const nativePath of dirs) {
          const parsed = yield* readGrokSessionFromDir(nativePath);
          if (Option.isNone(parsed)) {
            continue;
          }
          if (!(yield* teleportCwdsEquivalent(parsed.value.cwd, input.cwd))) {
            continue;
          }
          sessions.push(toGrokCandidate(parsed.value));
        }
        break;
      }
      default: {
        const _exhaustive: never = provider;
        return _exhaustive;
      }
    }
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

  if (input.provider === "opencode") {
    const parsed = yield* readOpenCodeSessionById({
      opencodeRoot: input.homes.opencodeRoot,
      sessionId: input.externalSessionId,
    });
    if (Option.isNone(parsed)) {
      return yield* new TeleportDiscoveryError({
        message: `Native OpenCode session '${input.externalSessionId}' could not be read.`,
      });
    }
    return parsed.value;
  }

  if (input.provider === "grok") {
    const parsed = yield* readGrokSessionFromDir(candidate.nativePath);
    if (Option.isNone(parsed)) {
      return yield* new TeleportDiscoveryError({
        message: `Native Grok session '${input.externalSessionId}' could not be read.`,
      });
    }
    return parsed.value;
  }

  const parser =
    input.provider === "codex" ? parseCodexSessionContents : parseClaudeSessionContents;
  const parsed = yield* readParsedSessionFile({
    nativePath: candidate.nativePath,
    parse: parser,
  });
  if (Option.isNone(parsed)) {
    return yield* new TeleportDiscoveryError({
      message: `Native ${input.provider} session '${input.externalSessionId}' could not be parsed.`,
    });
  }
  return parsed.value;
});

const readParsedSessionFile = Effect.fn("readParsedSessionFile")(function* (input: {
  readonly nativePath: string;
  readonly parse: (args: {
    readonly contents: string;
    readonly nativePath: string;
  }) => Effect.Effect<Option.Option<ParsedNativeSession>, TeleportSchemaVersionError>;
}): Effect.fn.Return<
  Option.Option<ParsedNativeSession>,
  TeleportSchemaVersionError,
  FileSystem.FileSystem
> {
  const fs = yield* FileSystem.FileSystem;
  const stat = yield* fs.stat(input.nativePath).pipe(Effect.orElseSucceed(() => null));
  if (stat === null || stat.type !== "File") {
    return Option.none();
  }
  if (typeof stat.size === "number" && stat.size > MAX_TELEPORT_SESSION_BYTES) {
    return Option.none();
  }
  const contents = yield* fs.readFileString(input.nativePath).pipe(Effect.orElseSucceed(() => ""));
  if (contents.length === 0) {
    return Option.none();
  }
  return yield* input.parse({ contents, nativePath: input.nativePath });
});
