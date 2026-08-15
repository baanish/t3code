// Native Codex files store wall-clock ISO timestamps and JSONL event records.
// @effect-diagnostics globalDate:off preferSchemaOverJson:off
import {
  TELEPORT_NATIVE_FORMAT_VERSION,
  TeleportDiscoveryError,
  TeleportNativeWriteError,
  TeleportSchemaVersionError,
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type TeleportSessionCandidate,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { teleportCwdsEquivalent } from "../cwd.ts";
import { readNativeSessionFile } from "../sessionFile.ts";
import { requireNativePathUnlocked } from "../fileLock.ts";
import {
  firstUserTitle,
  isRecord,
  isSyntheticNativeUserText,
  nonEmptyString,
  parseJsonObject,
  uuidFromPath,
} from "../json.ts";
import { writeNativeSessionAtomically } from "../nativeWrite.ts";
import { registerTeleportFormat } from "./registry.ts";
import {
  nativeTextMessage,
  parsedNativeSession,
  teleportCandidateFields,
  type NativeTextMessage,
  type ParsedNativeSession,
} from "../types.ts";

const CODEX = ProviderDriverKind.make("codex");

function isForkedSessionMeta(payload: Record<string, unknown>): boolean {
  if (typeof payload.forked_from_id === "string") {
    return true;
  }
  const source = payload.source;
  if (!isRecord(source)) {
    return false;
  }
  const subagent = source.subagent;
  if (!isRecord(subagent)) {
    return false;
  }
  const spawn = subagent.thread_spawn;
  if (!isRecord(spawn)) {
    return false;
  }
  return typeof spawn.parent_thread_id === "string";
}

function extractMessage(event: Record<string, unknown>): NativeTextMessage | undefined {
  if (event.type !== "response_item") {
    return undefined;
  }
  const payload = isRecord(event.payload) ? event.payload : undefined;
  if (payload?.type !== "message") {
    return undefined;
  }
  const role = payload.role === "user" || payload.role === "assistant" ? payload.role : undefined;
  if (!role) {
    return undefined;
  }
  const text = collectCodexText(payload.content);
  if (!text) {
    return undefined;
  }
  if (isSyntheticNativeUserText(text)) {
    return undefined;
  }
  return nativeTextMessage({
    role,
    text,
    createdAt: nonEmptyString(event.timestamp),
    id: undefined,
  });
}

function collectCodexText(content: unknown): string | undefined {
  if (typeof content === "string") {
    return nonEmptyString(content);
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const parts: string[] = [];
  for (const part of content) {
    if (!isRecord(part)) {
      continue;
    }
    const text = nonEmptyString(part.text);
    if (text) {
      parts.push(text);
    }
  }
  return nonEmptyString(parts.join("\n"));
}

export function parseCodexSessionContents(input: {
  readonly contents: string;
  readonly nativePath: string;
}): Effect.Effect<Option.Option<ParsedNativeSession>, TeleportSchemaVersionError> {
  const lines = input.contents.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return Effect.succeed(Option.none());
  }

  let sessionId: string | undefined;
  let cwd: string | undefined;
  let createdAt: string | undefined;
  let title: string | undefined;
  let nativeFormatVersion: number = TELEPORT_NATIVE_FORMAT_VERSION;
  let forked = false;
  const messages: NativeTextMessage[] = [];

  for (const line of lines) {
    const event = parseJsonObject(line);
    if (!event) {
      continue;
    }
    const declaredVersion = event.nativeFormatVersion;
    if (typeof declaredVersion === "number" && Number.isInteger(declaredVersion)) {
      nativeFormatVersion = declaredVersion;
    }
    if (nativeFormatVersion > TELEPORT_NATIVE_FORMAT_VERSION) {
      return Effect.fail(
        new TeleportSchemaVersionError({
          provider: "codex",
          nativePath: input.nativePath,
          foundVersion: nativeFormatVersion,
          supportedVersion: TELEPORT_NATIVE_FORMAT_VERSION,
          message: `Unsupported Codex session format version ${nativeFormatVersion} in ${input.nativePath}.`,
        }),
      );
    }

    if (event.type === "session_meta") {
      const payload = isRecord(event.payload) ? event.payload : undefined;
      if (!payload) {
        continue;
      }
      if (isForkedSessionMeta(payload)) {
        forked = true;
        continue;
      }
      sessionId = nonEmptyString(payload.id) ?? nonEmptyString(payload.session_id) ?? sessionId;
      cwd = nonEmptyString(payload.cwd) ?? cwd;
      createdAt = nonEmptyString(event.timestamp) ?? nonEmptyString(payload.timestamp) ?? createdAt;
      title = nonEmptyString(payload.title) ?? title;
      continue;
    }

    if (event.type === "turn_context") {
      const payload = isRecord(event.payload) ? event.payload : undefined;
      cwd = nonEmptyString(payload?.cwd) ?? cwd;
      continue;
    }

    const message = extractMessage(event);
    if (message) {
      messages.push(message);
    }
  }

  if (forked) {
    return Effect.succeed(Option.none());
  }

  const externalSessionId = sessionId ?? uuidFromPath(input.nativePath);
  if (!externalSessionId || !cwd) {
    return Effect.succeed(Option.none());
  }

  const updatedAt = messages.at(-1)?.createdAt ?? createdAt;
  return Effect.succeed(
    Option.some(
      parsedNativeSession({
        provider: "codex",
        externalSessionId,
        cwd,
        nativePath: input.nativePath,
        nativeFormatVersion,
        title: title ?? firstUserTitle(messages),
        createdAt,
        updatedAt,
        messages,
      }),
    ),
  );
}

const CODEX_EXPORT_ORIGINATOR = "t3-teleport";
const CODEX_EXPORT_CLI_VERSION = "0.0.0";

/**
 * Codex TUI bootstrap requires the first parseable rollout line to be
 * `session_meta`. Extra top-level fields (including our format version) make
 * that line fail serde, so resume then treats the first `response_item` as
 * the header and errors with "does not start with session metadata".
 * `cli_version` is required on SessionMeta.
 */
export function serializeCodexSession(session: ParsedNativeSession): string {
  const timestamp = session.createdAt ?? new Date().toISOString();
  let ordinal = 0;
  const lines: string[] = [
    JSON.stringify({
      timestamp,
      ordinal: ordinal++,
      type: "session_meta",
      payload: {
        id: session.externalSessionId,
        session_id: session.externalSessionId,
        timestamp,
        cwd: session.cwd,
        originator: CODEX_EXPORT_ORIGINATOR,
        cli_version: CODEX_EXPORT_CLI_VERSION,
        source: "cli",
        thread_source: "user",
      },
    }),
    JSON.stringify({
      timestamp,
      ordinal: ordinal++,
      type: "turn_context",
      payload: {
        cwd: session.cwd,
      },
    }),
  ];

  for (const message of session.messages) {
    const at = message.createdAt ?? timestamp;
    lines.push(
      JSON.stringify({
        timestamp: at,
        ordinal: ordinal++,
        type: "response_item",
        payload: {
          type: "message",
          role: message.role,
          content: [
            {
              type: message.role === "user" ? "input_text" : "output_text",
              text: message.text,
            },
          ],
        },
      }),
    );
  }

  return `${lines.join("\n")}\n`;
}

export function allocateCodexSessionPath(input: {
  readonly sessionsRoot: string;
  readonly sessionId: string;
  readonly createdAt: string;
  readonly join: (left: string, ...rest: string[]) => string;
}): string {
  const created = new Date(input.createdAt);
  const safeDate = Number.isNaN(created.getTime()) ? new Date() : created;
  const year = String(safeDate.getUTCFullYear());
  const month = String(safeDate.getUTCMonth() + 1).padStart(2, "0");
  const day = String(safeDate.getUTCDate()).padStart(2, "0");
  const stamp = safeDate.toISOString().replaceAll(":", "-");
  return input.join(
    input.sessionsRoot,
    year,
    month,
    day,
    `rollout-${stamp}-${input.sessionId}.jsonl`,
  );
}

export const listCodexJsonlFiles = Effect.fn("listCodexJsonlFiles")(function* (
  sessionsRoot: string,
) {
  return yield* walkFiles(sessionsRoot, (filePath) => filePath.endsWith(".jsonl"));
});

export function toCodexCandidate(session: ParsedNativeSession): TeleportSessionCandidate {
  return {
    provider: "codex",
    providerInstanceId: defaultInstanceIdForDriver(CODEX),
    externalSessionId: session.externalSessionId,
    cwd: session.cwd,
    nativePath: session.nativePath,
    nativeFormatVersion: session.nativeFormatVersion,
    ...teleportCandidateFields(session),
  };
}

const walkFiles = Effect.fn("walkFiles")(function* (
  root: string,
  predicate: (filePath: string) => boolean,
): Effect.fn.Return<ReadonlyArray<string>, never, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const exists = yield* fs.exists(root).pipe(Effect.orElseSucceed(() => false));
  if (!exists) {
    return [];
  }

  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    const entries = yield* fs.readDirectory(current).pipe(Effect.orElseSucceed(() => []));
    for (const name of entries) {
      const entryPath = path.join(current, name);
      const stat = yield* fs.stat(entryPath).pipe(Effect.orElseSucceed(() => null));
      if (stat === null) {
        continue;
      }
      if (stat.type === "Directory") {
        stack.push(entryPath);
      } else if (stat.type === "File" && predicate(entryPath)) {
        files.push(entryPath);
      }
    }
  }
  return files;
});

registerTeleportFormat({
  provider: "codex",
  list: Effect.fn("listCodexSessions")(function* (input) {
    const files = yield* listCodexJsonlFiles(input.homes.codexSessionsRoot);
    const sessions = [];
    for (const nativePath of files) {
      const parsed = yield* readNativeSessionFile({
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
    return sessions;
  }),
  load: Effect.fn("loadCodexSession")(function* (input) {
    const parsed = yield* readNativeSessionFile({
      nativePath: input.nativePath,
      parse: parseCodexSessionContents,
    });
    if (Option.isNone(parsed)) {
      return yield* new TeleportDiscoveryError({
        message: `Native Codex session '${input.externalSessionId}' could not be parsed.`,
      });
    }
    return parsed.value;
  }),
  write: Effect.fn("writeCodexSession")(function* (input) {
    const path = yield* Path.Path;
    const now = yield* DateTime.now;
    const nativePath =
      input.existingNativePath ??
      allocateCodexSessionPath({
        sessionsRoot: input.homes.codexSessionsRoot,
        sessionId: input.session.externalSessionId,
        createdAt: input.session.createdAt ?? input.session.updatedAt ?? DateTime.formatIso(now),
        join: path.join,
      });
    const contents = serializeCodexSession({ ...input.session, nativePath });
    yield* writeNativeSessionAtomically({
      filePath: nativePath,
      contents,
      verify: (written) =>
        parseCodexSessionContents({ contents: written, nativePath }).pipe(
          Effect.flatMap((parsed) =>
            Option.isSome(parsed)
              ? Effect.void
              : new TeleportNativeWriteError({
                  nativePath,
                  message: `Exported Codex session failed verification: ${nativePath}`,
                }),
          ),
          Effect.mapError((error) =>
            error._tag === "TeleportSchemaVersionError"
              ? new TeleportNativeWriteError({
                  nativePath,
                  message: error.message,
                  cause: error,
                })
              : error,
          ),
        ),
    });
    return nativePath;
  }),
  requireUnlocked: (input) => requireNativePathUnlocked(input.nativePath),
  resumeCursor: (externalSessionId) => ({ threadId: externalSessionId }),
  readExternalSessionId: (resumeCursor) =>
    isRecord(resumeCursor) ? nonEmptyString(resumeCursor.threadId) : undefined,
});
