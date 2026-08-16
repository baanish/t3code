// Native Grok Build sessions are directories of JSON/JSONL ACP records.
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
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { normalizeProjectPathForDispatch } from "@t3tools/shared/path";

import { teleportCwdsEquivalent } from "../cwd.ts";
import { requireNativePathUnlocked } from "../fileLock.ts";
import { registerTeleportFormat } from "./registry.ts";
import { replaceNativeFile } from "../nativeWrite.ts";
import {
  firstUserTitle,
  isRecord,
  isSafeTeleportSessionId,
  nonEmptyString,
  parseJsonObject,
} from "../json.ts";
import {
  MAX_TELEPORT_SESSION_BYTES,
  nativeTextMessage,
  parsedNativeSession,
  teleportCandidateFields,
  type NativeTextMessage,
  type ParsedNativeSession,
} from "../types.ts";

const GROK = ProviderDriverKind.make("grok");
const GROK_CHAT_FORMAT_VERSION = 1;
const SUMMARY_FILE = "summary.json";
const UPDATES_FILE = "updates.jsonl";
const CHAT_HISTORY_FILE = "chat_history.jsonl";

export const requireGrokSessionUnlocked = Effect.fn("requireGrokSessionUnlocked")(function* (
  nativePath: string,
) {
  const path = yield* Path.Path;
  yield* requireNativePathUnlocked(nativePath);
  yield* requireNativePathUnlocked(path.join(nativePath, SUMMARY_FILE));
  yield* requireNativePathUnlocked(path.join(nativePath, UPDATES_FILE));
  yield* requireNativePathUnlocked(path.join(nativePath, CHAT_HISTORY_FILE));
});

export function encodeGrokCwdGroup(cwd: string): string {
  // Encode the cwd spelling we persist, not the comparison form. Comparison
  // lowercases Windows paths and forces backslashes, which would write a
  // different folder than the native Grok CLI looks up.
  return encodeURIComponent(normalizeProjectPathForDispatch(cwd));
}

export function allocateGrokSessionPath(input: {
  readonly sessionsRoot: string;
  readonly cwd: string;
  readonly sessionId: string;
  readonly join: (left: string, ...rest: string[]) => string;
}): string {
  return input.join(input.sessionsRoot, encodeGrokCwdGroup(input.cwd), input.sessionId);
}

export const listGrokSessionDirs = Effect.fn("listGrokSessionDirs")(function* (
  sessionsRoot: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const exists = yield* fs.exists(sessionsRoot).pipe(Effect.orElseSucceed(() => false));
  if (!exists) {
    return [] as string[];
  }
  const dirs: string[] = [];
  const groups = yield* fs.readDirectory(sessionsRoot).pipe(Effect.orElseSucceed(() => []));
  for (const groupName of groups) {
    const groupPath = path.join(sessionsRoot, groupName);
    const groupStat = yield* fs.stat(groupPath).pipe(Effect.orElseSucceed(() => null));
    if (groupStat?.type !== "Directory") {
      continue;
    }
    if (yield* isGrokSessionDirectory(groupPath)) {
      dirs.push(groupPath);
      continue;
    }
    const children = yield* fs.readDirectory(groupPath).pipe(Effect.orElseSucceed(() => []));
    for (const childName of children) {
      const childPath = path.join(groupPath, childName);
      if (yield* isGrokSessionDirectory(childPath)) {
        dirs.push(childPath);
      }
    }
  }
  return dirs;
});

export const readGrokSessionFromDir = Effect.fn("readGrokSessionFromDir")(function* (
  nativePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const summaryPath = path.join(nativePath, SUMMARY_FILE);
  const updatesPath = path.join(nativePath, UPDATES_FILE);
  const summaryStat = yield* fs.stat(summaryPath).pipe(Effect.orElseSucceed(() => null));
  const updatesStat = yield* fs.stat(updatesPath).pipe(Effect.orElseSucceed(() => null));
  if (summaryStat?.type !== "File") {
    return Option.none<ParsedNativeSession>();
  }
  if (typeof summaryStat.size === "number" && summaryStat.size > MAX_TELEPORT_SESSION_BYTES) {
    return Option.none<ParsedNativeSession>();
  }
  if (
    updatesStat !== null &&
    typeof updatesStat.size === "number" &&
    updatesStat.size > MAX_TELEPORT_SESSION_BYTES
  ) {
    return Option.none<ParsedNativeSession>();
  }
  const summaryContents = yield* fs
    .readFileString(summaryPath)
    .pipe(Effect.orElseSucceed(() => ""));
  const updatesContents = yield* fs
    .readFileString(updatesPath)
    .pipe(Effect.orElseSucceed(() => ""));
  return yield* parseGrokSessionDirectory({
    summaryContents,
    updatesContents,
    nativePath,
  });
});

export const writeGrokSession = Effect.fn("writeGrokSession")(function* (input: {
  readonly sessionsRoot: string;
  readonly session: ParsedNativeSession;
  readonly existingNativePath?: string;
}): Effect.fn.Return<string, TeleportNativeWriteError, FileSystem.FileSystem | Path.Path> {
  if (!isSafeTeleportSessionId(input.session.externalSessionId)) {
    return yield* new TeleportNativeWriteError({
      nativePath: input.sessionsRoot,
      message: `Refusing to write a Grok session with an unsafe id '${input.session.externalSessionId}'.`,
    });
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const nativePath = yield* resolveGrokWritePath({
    sessionsRoot: input.sessionsRoot,
    session: input.session,
    existingNativePath: input.existingNativePath,
  });
  const mapWriteError = (message: string) => (cause: unknown) =>
    new TeleportNativeWriteError({
      nativePath,
      message,
      cause,
    });

  const summaryContents = serializeGrokSummary(input.session);
  const updatesContents = serializeGrokUpdates(input.session);
  const chatHistoryContents = serializeGrokChatHistory(input.session);

  yield* requireGrokSessionUnlocked(nativePath).pipe(
    Effect.mapError(mapWriteError(`Native Grok session is locked: ${nativePath}`)),
  );

  yield* fs
    .makeDirectory(path.dirname(nativePath), { recursive: true })
    .pipe(
      Effect.mapError(mapWriteError(`Failed to create Grok session parent for ${nativePath}.`)),
    );

  yield* Effect.scoped(
    Effect.gen(function* () {
      const tempDirectory = yield* fs
        .makeTempDirectoryScoped({
          directory: path.dirname(nativePath),
          prefix: `${path.basename(nativePath)}.`,
        })
        .pipe(
          Effect.mapError(mapWriteError(`Failed to create a temp directory for ${nativePath}.`)),
        );
      yield* fs
        .writeFileString(path.join(tempDirectory, SUMMARY_FILE), summaryContents)
        .pipe(
          Effect.mapError(mapWriteError(`Failed to write temp Grok summary for ${nativePath}.`)),
        );
      yield* fs
        .writeFileString(path.join(tempDirectory, UPDATES_FILE), updatesContents)
        .pipe(
          Effect.mapError(mapWriteError(`Failed to write temp Grok updates for ${nativePath}.`)),
        );
      yield* fs
        .writeFileString(path.join(tempDirectory, CHAT_HISTORY_FILE), chatHistoryContents)
        .pipe(
          Effect.mapError(
            mapWriteError(`Failed to write temp Grok chat history for ${nativePath}.`),
          ),
        );
      const verified = yield* readGrokSessionFromDir(tempDirectory).pipe(
        Effect.mapError((error) =>
          error._tag === "TeleportSchemaVersionError"
            ? new TeleportNativeWriteError({
                nativePath,
                message: error.message,
                cause: error,
              })
            : new TeleportNativeWriteError({
                nativePath,
                message: `Exported Grok session failed verification: ${nativePath}`,
                cause: error,
              }),
        ),
      );
      if (Option.isNone(verified)) {
        return yield* new TeleportNativeWriteError({
          nativePath,
          message: `Exported Grok session failed verification: ${nativePath}`,
        });
      }
      yield* requireGrokSessionUnlocked(nativePath).pipe(
        Effect.mapError(mapWriteError(`Native Grok session is locked: ${nativePath}`)),
      );
      const destStat = yield* fs.stat(nativePath).pipe(Effect.orElseSucceed(() => null));
      if (destStat?.type === "File") {
        yield* fs
          .remove(nativePath, { force: true })
          .pipe(Effect.mapError(mapWriteError(`Failed to replace ${nativePath}.`)));
      }
      yield* fs
        .makeDirectory(nativePath, { recursive: true })
        .pipe(
          Effect.mapError(mapWriteError(`Failed to create Grok session directory ${nativePath}.`)),
        );
      for (const name of [SUMMARY_FILE, UPDATES_FILE, CHAT_HISTORY_FILE] as const) {
        yield* replaceNativeFile({
          from: path.join(tempDirectory, name),
          to: path.join(nativePath, name),
        }).pipe(
          Effect.mapError(mapWriteError(`Failed to replace ${path.join(nativePath, name)}.`)),
        );
      }
    }),
  );

  return nativePath;
});

export function parseGrokSessionDirectory(input: {
  readonly summaryContents: string;
  readonly updatesContents: string;
  readonly nativePath: string;
}): Effect.Effect<Option.Option<ParsedNativeSession>, TeleportSchemaVersionError> {
  const summary = parseJsonObject(input.summaryContents);
  if (!summary) {
    return Effect.succeed(Option.none());
  }

  const chatFormatVersion =
    typeof summary.chat_format_version === "number" && Number.isInteger(summary.chat_format_version)
      ? summary.chat_format_version
      : GROK_CHAT_FORMAT_VERSION;
  const nativeFormatVersion =
    typeof summary.nativeFormatVersion === "number" && Number.isInteger(summary.nativeFormatVersion)
      ? summary.nativeFormatVersion
      : TELEPORT_NATIVE_FORMAT_VERSION;
  if (
    chatFormatVersion > GROK_CHAT_FORMAT_VERSION ||
    nativeFormatVersion > TELEPORT_NATIVE_FORMAT_VERSION
  ) {
    const foundVersion = Math.max(chatFormatVersion, nativeFormatVersion);
    return Effect.fail(
      new TeleportSchemaVersionError({
        provider: "grok",
        nativePath: input.nativePath,
        foundVersion,
        supportedVersion: TELEPORT_NATIVE_FORMAT_VERSION,
        message: `Unsupported Grok session format version ${foundVersion} in ${input.nativePath}.`,
      }),
    );
  }

  if (isSkippedGrokSession(summary)) {
    return Effect.succeed(Option.none());
  }

  const info = isRecord(summary.info) ? summary.info : undefined;
  const externalSessionId =
    nonEmptyString(info?.id) ?? nonEmptyString(basenamePath(input.nativePath));
  const cwd = nonEmptyString(info?.cwd) ?? nonEmptyString(summary.cwd);
  if (!externalSessionId || !cwd) {
    return Effect.succeed(Option.none());
  }

  const messages = parseGrokUpdates(input.updatesContents);
  const createdAt =
    nonEmptyString(summary.created_at) ?? messages[0]?.createdAt ?? isoFromUnixSeconds(undefined);
  const updatedAt =
    nonEmptyString(summary.updated_at) ??
    nonEmptyString(summary.last_active_at) ??
    messages.at(-1)?.createdAt ??
    createdAt;

  return Effect.succeed(
    Option.some(
      parsedNativeSession({
        provider: "grok",
        externalSessionId,
        cwd,
        nativePath: input.nativePath,
        nativeFormatVersion: TELEPORT_NATIVE_FORMAT_VERSION,
        title:
          nonEmptyString(summary.generated_title) ??
          nonEmptyString(summary.session_summary) ??
          firstUserTitle(messages),
        createdAt,
        updatedAt,
        messages,
      }),
    ),
  );
}

export function toGrokCandidate(session: ParsedNativeSession): TeleportSessionCandidate {
  return {
    provider: "grok",
    providerInstanceId: defaultInstanceIdForDriver(GROK),
    externalSessionId: session.externalSessionId,
    cwd: session.cwd,
    nativePath: session.nativePath,
    nativeFormatVersion: session.nativeFormatVersion,
    ...teleportCandidateFields(session),
  };
}

export function serializeGrokSummary(session: ParsedNativeSession): string {
  const createdAt = session.createdAt ?? new Date().toISOString();
  const updatedAt = session.updatedAt ?? createdAt;
  const title = session.title ?? firstUserTitle(session.messages) ?? session.externalSessionId;
  return `${JSON.stringify(
    {
      info: {
        id: session.externalSessionId,
        cwd: session.cwd,
      },
      session_summary: title,
      generated_title: title,
      created_at: createdAt,
      updated_at: updatedAt,
      num_messages: session.messages.length,
      num_chat_messages: session.messages.length,
      current_model_id: "deepseek",
      chat_format_version: GROK_CHAT_FORMAT_VERSION,
    },
    null,
    2,
  )}\n`;
}

export function serializeGrokUpdates(session: ParsedNativeSession): string {
  const lines: string[] = [];
  let promptIndex = 0;
  for (const message of session.messages) {
    const timestamp = unixSeconds(message.createdAt ?? session.createdAt);
    const sessionUpdate = message.role === "user" ? "user_message_chunk" : "agent_message_chunk";
    const meta =
      message.role === "user"
        ? { promptIndex, modelId: "deepseek" }
        : { promptIndex, modelId: "deepseek", updateType: "AgentMessageChunk" };
    if (message.role === "user") {
      promptIndex += 1;
    }
    lines.push(
      JSON.stringify({
        timestamp,
        method: "session/update",
        params: {
          sessionId: session.externalSessionId,
          update: {
            sessionUpdate,
            content: { type: "text", text: message.text },
            _meta: meta,
          },
        },
      }),
    );
  }
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

export function serializeGrokChatHistory(session: ParsedNativeSession): string {
  const lines: string[] = [];
  let promptIndex = 0;
  for (const message of session.messages) {
    if (message.role === "user") {
      lines.push(
        JSON.stringify({
          type: "user",
          content: [{ type: "text", text: `<user_query>\n${message.text}\n</user_query>` }],
          prompt_index: promptIndex,
        }),
      );
      promptIndex += 1;
      continue;
    }
    lines.push(
      JSON.stringify({
        type: "assistant",
        content: message.text,
        model_id: "deepseek",
      }),
    );
  }
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

function parseGrokUpdates(contents: string): NativeTextMessage[] {
  const messages: NativeTextMessage[] = [];
  let current: { role: "user" | "assistant"; parts: string[]; createdAt?: string } | undefined;
  const flush = (): void => {
    if (!current) {
      return;
    }
    const text = current.parts.join("");
    if (text.length > 0) {
      messages.push(
        nativeTextMessage({
          role: current.role,
          text,
          createdAt: current.createdAt,
          id: undefined,
        }),
      );
    }
    current = undefined;
  };

  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    const parsed = parseJsonObject(line);
    if (!parsed) {
      continue;
    }
    const params = isRecord(parsed.params) ? parsed.params : undefined;
    const update = isRecord(params?.update) ? params.update : undefined;
    if (!update) {
      continue;
    }
    const sessionUpdate = nonEmptyString(update.sessionUpdate);
    const role =
      sessionUpdate === "user_message_chunk"
        ? "user"
        : sessionUpdate === "agent_message_chunk"
          ? "assistant"
          : undefined;
    if (!role) {
      continue;
    }
    const text = textFromGrokContent(update.content);
    if (!text) {
      continue;
    }
    const createdAt = isoFromUnixSeconds(parsed.timestamp);
    if (current && current.role === role) {
      current.parts.push(text);
      continue;
    }
    flush();
    current = { role, parts: [text], ...definedCreatedAt(createdAt) };
  }
  flush();
  return messages;
}

function textFromGrokContent(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content.length > 0 ? content : undefined;
  }
  if (!isRecord(content) || typeof content.text !== "string") {
    return undefined;
  }
  return content.text.length > 0 ? content.text : undefined;
}

function isSkippedGrokSession(summary: Record<string, unknown>): boolean {
  if (nonEmptyString(summary.parent_session_id)) {
    return true;
  }
  const kind = nonEmptyString(summary.session_kind);
  return kind === "fork" || kind === "subagent" || kind === "subagent_fork";
}

const isGrokSessionDirectory = Effect.fn("isGrokSessionDirectory")(function* (nativePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stat = yield* fs.stat(nativePath).pipe(Effect.orElseSucceed(() => null));
  if (stat?.type !== "Directory") {
    return false;
  }
  const summaryPath = path.join(nativePath, SUMMARY_FILE);
  const summaryStat = yield* fs.stat(summaryPath).pipe(Effect.orElseSucceed(() => null));
  return summaryStat?.type === "File";
});

const resolveGrokWritePath = Effect.fn("resolveGrokWritePath")(function* (input: {
  readonly sessionsRoot: string;
  readonly session: ParsedNativeSession;
  readonly existingNativePath: string | undefined;
}) {
  const path = yield* Path.Path;
  const allocated = allocateGrokSessionPath({
    sessionsRoot: input.sessionsRoot,
    cwd: input.session.cwd,
    sessionId: input.session.externalSessionId,
    join: path.join,
  });
  if (!input.existingNativePath) {
    return allocated;
  }
  if (yield* isGrokSessionDirectory(input.existingNativePath)) {
    return input.existingNativePath;
  }
  return allocated;
});

function unixSeconds(iso: string | undefined): number {
  if (!iso) {
    return Math.floor(Date.now() / 1000);
  }
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : Math.floor(Date.now() / 1000);
}

function isoFromUnixSeconds(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const millis = value > 1_000_000_000_000 ? value : value * 1000;
  return new Date(millis).toISOString();
}

function definedCreatedAt(createdAt: string | undefined): { readonly createdAt?: string } {
  return createdAt ? { createdAt } : {};
}

function basenamePath(filePath: string): string {
  const parts = filePath.split(/[/\\]/u).filter((part) => part.length > 0);
  return parts.at(-1) ?? filePath;
}

registerTeleportFormat({
  provider: "grok",
  list: Effect.fn("listGrokSessions")(function* (input) {
    const dirs = yield* listGrokSessionDirs(input.homes.grokSessionsRoot);
    const sessions = [];
    for (const nativePath of dirs) {
      const parsed = yield* readGrokSessionFromDir(nativePath);
      if (Option.isNone(parsed) || !isSafeTeleportSessionId(parsed.value.externalSessionId)) {
        continue;
      }
      if (!(yield* teleportCwdsEquivalent(parsed.value.cwd, input.cwd))) {
        continue;
      }
      sessions.push(toGrokCandidate(parsed.value));
    }
    return sessions;
  }),
  load: Effect.fn("loadGrokSession")(function* (input) {
    const parsed = yield* readGrokSessionFromDir(input.nativePath);
    if (Option.isNone(parsed)) {
      return yield* new TeleportDiscoveryError({
        message: `Native Grok session '${input.externalSessionId}' could not be read.`,
      });
    }
    return parsed.value;
  }),
  write: (input) =>
    writeGrokSession({
      sessionsRoot: input.homes.grokSessionsRoot,
      session: input.session,
      ...(input.existingNativePath !== undefined
        ? { existingNativePath: input.existingNativePath }
        : {}),
    }),
  requireUnlocked: (input) => requireGrokSessionUnlocked(input.nativePath),
  resumeCursor: (externalSessionId) => ({ schemaVersion: 1, sessionId: externalSessionId }),
  readExternalSessionId: (resumeCursor) =>
    isRecord(resumeCursor) ? nonEmptyString(resumeCursor.sessionId) : undefined,
});
