// @effect-diagnostics nodeBuiltinImport:off globalDate:off preferSchemaOverJson:off
import * as NodeSqlite from "node:sqlite";

import {
  TELEPORT_NATIVE_FORMAT_VERSION,
  TeleportDiscoveryError,
  TeleportFileLockedError,
  TeleportLockProbeError,
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

import {
  openCodeDirectoryMayMatch,
  opencodeSessionMatchesProjectCwd,
  teleportCwdsMatch,
} from "../cwd.ts";
import { requireNativePathUnlocked } from "../fileLock.ts";
import {
  firstUserTitle,
  isRecord,
  isSafeTeleportSessionId,
  nativeSessionText,
  nonEmptyString,
  parseJsonObject,
} from "../json.ts";
import {
  nativeTextMessage,
  parsedNativeSession,
  teleportCandidateFields,
  type NativeTextMessage,
  type ParsedNativeSession,
} from "../types.ts";
import { createOpenCodeId, ensureOpenCodeId } from "./opencodeIds.ts";
import { registerTeleportFormat } from "./registry.ts";

export { createOpenCodeId, ensureOpenCodeId } from "./opencodeIds.ts";

const OPENCODE = ProviderDriverKind.make("opencode");
const OPENCODE_SESSION_VERSION = "1.15.13";
const OPENCODE_GLOBAL_PROJECT_ID = "global";

function dateFromMillis(value: unknown): string | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? new Date(value).toISOString()
    : undefined;
}

function millisFromIso(value: string | undefined): number {
  if (!value) {
    return Date.now();
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function normalizeOpenCodeText(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "string") {
      return parsed;
    }
  } catch {
    // OpenCode sometimes stores plain text.
  }
  return text;
}

function textFromOpenCodePartRecord(record: Record<string, unknown>): string | undefined {
  if (record.type !== undefined && record.type !== "text") {
    return undefined;
  }
  const text = nonEmptyString(record.text);
  return text === undefined ? undefined : normalizeOpenCodeText(text);
}

function textFromPartData(data: unknown): string | undefined {
  if (isRecord(data)) {
    return textFromOpenCodePartRecord(data);
  }
  if (typeof data !== "string") {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(data);
    if (isRecord(parsed)) {
      return textFromOpenCodePartRecord(parsed);
    }
    if (typeof parsed === "string") {
      return nonEmptyString(parsed);
    }
    return undefined;
  } catch {
    return nonEmptyString(data);
  }
}

export function opencodeDbPath(
  opencodeRoot: string,
  join: (left: string, ...rest: string[]) => string,
): string {
  return join(opencodeRoot, "opencode.db");
}

export function isOpenCodeSharedStorePath(nativePath: string): boolean {
  const normalized = nativePath.replaceAll("\\", "/");
  return normalized.endsWith("/opencode.db");
}

export const requireOpenCodeSessionUnlocked = Effect.fn("requireOpenCodeSessionUnlocked")(
  function* (input: { readonly nativePath: string; readonly opencodeRoot: string }) {
    // T3's idle OpenCode process keeps opencode.db open. Treat that as the live
    // store, not a foreign lock. Only refuse when the session JSON itself is held.
    const path = yield* Path.Path;
    if (
      isOpenCodeSharedStorePath(input.nativePath) ||
      teleportCwdsMatch(input.nativePath, opencodeDbPath(input.opencodeRoot, path.join))
    ) {
      return;
    }
    yield* requireNativePathUnlocked(input.nativePath);
  },
);

export const listOpenCodeSessions = Effect.fn("listOpenCodeSessions")(function* (input: {
  readonly opencodeRoot: string;
  readonly cwd: string;
}) {
  const sqliteSessions = yield* readOpenCodeSqliteSessions({
    opencodeRoot: input.opencodeRoot,
    cwd: input.cwd,
  });
  const jsonSessions = yield* readOpenCodeJsonSessions(input.opencodeRoot);
  const byId = new Map<string, ParsedNativeSession>();
  for (const session of jsonSessions) {
    byId.set(session.externalSessionId, session);
  }
  for (const session of sqliteSessions) {
    byId.set(session.externalSessionId, session);
  }
  const sessions: ParsedNativeSession[] = [];
  for (const session of byId.values()) {
    if (yield* opencodeSessionMatchesProjectCwd(session.cwd, input.cwd)) {
      sessions.push(session);
    }
  }
  return sessions;
});

export const readOpenCodeSessionById = Effect.fn("readOpenCodeSessionById")(function* (input: {
  readonly opencodeRoot: string;
  readonly sessionId: string;
}): Effect.fn.Return<
  Option.Option<ParsedNativeSession>,
  TeleportSchemaVersionError,
  FileSystem.FileSystem | Path.Path
> {
  if (!isSafeTeleportSessionId(input.sessionId)) {
    return Option.none();
  }
  const sqlite = yield* readOpenCodeSqliteSessions({
    opencodeRoot: input.opencodeRoot,
    cwd: "",
    sessionId: input.sessionId,
  });
  const fromSqlite = sqlite.find((session) => session.externalSessionId === input.sessionId);
  if (fromSqlite) {
    return Option.some(fromSqlite);
  }
  const jsonSessions = yield* readOpenCodeJsonSessions(input.opencodeRoot);
  const fromJson = jsonSessions.find((session) => session.externalSessionId === input.sessionId);
  return fromJson ? Option.some(fromJson) : Option.none();
});

const readOpenCodeSqliteSessions = Effect.fn("readOpenCodeSqliteSessions")(function* (input: {
  readonly opencodeRoot: string;
  readonly cwd: string;
  readonly sessionId?: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dbPath = opencodeDbPath(input.opencodeRoot, path.join);
  const exists = yield* fs.exists(dbPath).pipe(Effect.orElseSucceed(() => false));
  if (!exists) {
    return [] as ParsedNativeSession[];
  }

  return yield* Effect.sync(() => {
    try {
      const db = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
      try {
        const rows = (
          input.sessionId === undefined
            ? db
                .prepare(
                  `
                  SELECT
                    s.id,
                    s.directory,
                    s.title,
                    s.time_created,
                    s.time_updated
                  FROM session s
                  WHERE s.time_archived IS NULL
                  ORDER BY s.time_updated DESC
                `,
                )
                .all()
            : db
                .prepare(
                  `
                    SELECT
                      s.id,
                      s.directory,
                      s.title,
                      s.time_created,
                      s.time_updated
                    FROM session s
                    WHERE s.time_archived IS NULL
                      AND s.id = ?
                    ORDER BY s.time_updated DESC
                  `,
                )
                .all(input.sessionId)
        ) as ReadonlyArray<Record<string, unknown>>;

        const sessions: ParsedNativeSession[] = [];
        for (const row of rows) {
          const id = nonEmptyString(row.id);
          const cwd = nonEmptyString(row.directory);
          if (!id || !cwd || !isSafeTeleportSessionId(id)) {
            continue;
          }
          if (input.sessionId === undefined && !openCodeDirectoryMayMatch(cwd, input.cwd)) {
            continue;
          }
          const messageRows = db
            .prepare(
              `
                SELECT m.id, m.data, m.time_created, p.data AS part_data
                FROM message m
                JOIN part p ON p.message_id = m.id
                WHERE m.session_id = ?
                ORDER BY m.time_created ASC, p.time_created ASC
              `,
            )
            .all(id) as ReadonlyArray<Record<string, unknown>>;
          const messages: NativeTextMessage[] = [];
          const messageIndexById = new Map<string, number>();
          for (const messageRow of messageRows) {
            const data =
              parseJsonObject(typeof messageRow.data === "string" ? messageRow.data : "") ??
              (isRecord(messageRow.data) ? messageRow.data : undefined);
            const role =
              data?.role === "user" || data?.role === "assistant" ? data.role : undefined;
            const text = textFromPartData(messageRow.part_data);
            if (!role || !text) {
              continue;
            }
            const id = nonEmptyString(messageRow.id);
            const existingIndex = id === undefined ? undefined : messageIndexById.get(id);
            if (existingIndex !== undefined) {
              const existing = messages[existingIndex];
              if (existing) {
                messages[existingIndex] = nativeTextMessage({
                  role: existing.role,
                  text: `${existing.text}\n${text}`,
                  createdAt: existing.createdAt,
                  id: existing.id,
                });
              }
              continue;
            }
            if (id !== undefined) {
              messageIndexById.set(id, messages.length);
            }
            messages.push(
              nativeTextMessage({
                role,
                text,
                createdAt: dateFromMillis(messageRow.time_created),
                id,
              }),
            );
          }
          sessions.push(
            parsedNativeSession({
              provider: "opencode",
              externalSessionId: id,
              cwd,
              nativePath: dbPath,
              nativeFormatVersion: TELEPORT_NATIVE_FORMAT_VERSION,
              title: nonEmptyString(row.title) ?? firstUserTitle(messages),
              createdAt: dateFromMillis(row.time_created),
              updatedAt: dateFromMillis(row.time_updated),
              messages,
            }),
          );
        }
        return sessions;
      } finally {
        db.close();
      }
    } catch {
      return [] as ParsedNativeSession[];
    }
  });
});

const readOpenCodeJsonSessions = Effect.fn("readOpenCodeJsonSessions")(function* (
  opencodeRoot: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sessionRoot = path.join(opencodeRoot, "storage", "session");
  const files = yield* walkJson(sessionRoot);
  const sessions: ParsedNativeSession[] = [];

  for (const filePath of files) {
    const contents = yield* fs.readFileString(filePath).pipe(Effect.orElseSucceed(() => ""));
    const parsed = parseJsonObject(contents);
    if (!parsed) {
      continue;
    }
    const declaredVersion = parsed.nativeFormatVersion;
    if (typeof declaredVersion === "number" && declaredVersion > TELEPORT_NATIVE_FORMAT_VERSION) {
      return yield* new TeleportSchemaVersionError({
        provider: "opencode",
        nativePath: filePath,
        foundVersion: declaredVersion,
        supportedVersion: TELEPORT_NATIVE_FORMAT_VERSION,
        message: `Unsupported OpenCode session format version ${declaredVersion} in ${filePath}.`,
      });
    }
    const id = nonEmptyString(parsed.id);
    const cwd = nonEmptyString(parsed.directory) ?? nonEmptyString(parsed.cwd);
    if (!id || !cwd || !isSafeTeleportSessionId(id)) {
      continue;
    }
    const messages = yield* readOpenCodeJsonMessages(opencodeRoot, id);
    const createdAt =
      dateFromMillis(isRecord(parsed.time) ? parsed.time.created : parsed.time_created) ??
      nonEmptyString(parsed.createdAt);
    const updatedAt =
      dateFromMillis(isRecord(parsed.time) ? parsed.time.updated : parsed.time_updated) ??
      nonEmptyString(parsed.updatedAt);
    sessions.push(
      parsedNativeSession({
        provider: "opencode",
        externalSessionId: id,
        cwd,
        nativePath: filePath,
        nativeFormatVersion: TELEPORT_NATIVE_FORMAT_VERSION,
        title: nonEmptyString(parsed.title) ?? firstUserTitle(messages),
        createdAt,
        updatedAt,
        messages,
      }),
    );
  }

  return sessions;
});

const readOpenCodeJsonMessages = Effect.fn("readOpenCodeJsonMessages")(function* (
  opencodeRoot: string,
  sessionId: string,
) {
  if (!isSafeTeleportSessionId(sessionId)) {
    return [] as NativeTextMessage[];
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const messageRoot = path.join(opencodeRoot, "storage", "message", sessionId);
  const files = yield* walkJson(messageRoot);
  const messages: NativeTextMessage[] = [];
  for (const filePath of files) {
    const contents = yield* fs.readFileString(filePath).pipe(Effect.orElseSucceed(() => ""));
    const parsed = parseJsonObject(contents);
    if (!parsed) {
      continue;
    }
    const role = parsed.role === "user" || parsed.role === "assistant" ? parsed.role : undefined;
    const id = nonEmptyString(parsed.id);
    if (!role || !id || !isSafeTeleportSessionId(id)) {
      continue;
    }
    const text = yield* readOpenCodePartText(opencodeRoot, id);
    if (!text) {
      continue;
    }
    const createdAt = dateFromMillis(isRecord(parsed.time) ? parsed.time.created : undefined);
    messages.push(
      nativeTextMessage({
        role,
        text,
        createdAt,
        id,
      }),
    );
  }
  return messages.toSorted((left, right) =>
    (left.createdAt ?? "").localeCompare(right.createdAt ?? ""),
  );
});

const readOpenCodePartText = Effect.fn("readOpenCodePartText")(function* (
  opencodeRoot: string,
  messageId: string,
) {
  if (!isSafeTeleportSessionId(messageId)) {
    return undefined;
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const partRoot = path.join(opencodeRoot, "storage", "part", messageId);
  const files = yield* walkJson(partRoot);
  const parts: Array<{ readonly created: number; readonly name: string; readonly text: string }> =
    [];
  for (const filePath of files) {
    const contents = yield* fs.readFileString(filePath).pipe(Effect.orElseSucceed(() => ""));
    const parsed = parseJsonObject(contents);
    const text = textFromPartData(parsed ?? contents);
    if (!text) {
      continue;
    }
    const createdRaw = isRecord(parsed?.time) ? parsed.time.created : parsed?.time_created;
    const created = typeof createdRaw === "number" && Number.isFinite(createdRaw) ? createdRaw : 0;
    parts.push({ created, name: filePath, text });
  }
  parts.sort((left, right) => left.created - right.created || left.name.localeCompare(right.name));
  return nativeSessionText(parts.map((part) => part.text).join("\n"));
});

export const writeOpenCodeSession = Effect.fn("writeOpenCodeSession")(function* (input: {
  readonly opencodeRoot: string;
  readonly session: ParsedNativeSession;
}): Effect.fn.Return<
  string,
  TeleportNativeWriteError | TeleportFileLockedError | TeleportLockProbeError,
  FileSystem.FileSystem | Path.Path
> {
  if (!isSafeTeleportSessionId(input.session.externalSessionId)) {
    return yield* new TeleportNativeWriteError({
      nativePath: input.opencodeRoot,
      message: `Refusing to write an OpenCode session with an unsafe id '${input.session.externalSessionId}'.`,
    });
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sessionDir = path.join(input.opencodeRoot, "storage", "session", "t3");
  const sessionPath = path.join(sessionDir, `${input.session.externalSessionId}.json`);
  const created = millisFromIso(input.session.createdAt);
  const updated = millisFromIso(input.session.updatedAt ?? input.session.createdAt);
  const mapWriteError = (message: string) => (cause: unknown) =>
    new TeleportNativeWriteError({
      nativePath: sessionPath,
      message,
      cause,
    });
  yield* requireOpenCodeSessionUnlocked({
    nativePath: sessionPath,
    opencodeRoot: input.opencodeRoot,
  });
  yield* fs
    .makeDirectory(sessionDir, { recursive: true })
    .pipe(
      Effect.mapError(
        mapWriteError(`Failed to create OpenCode session directory for ${sessionPath}.`),
      ),
    );
  const messageRecords = input.session.messages.map((message) => {
    const messageId = ensureOpenCodeId("msg", message.id);
    return {
      message,
      messageId,
      partId: createOpenCodeId("prt"),
    };
  });

  yield* writeOpenCodeSqliteSession({
    opencodeRoot: input.opencodeRoot,
    session: input.session,
    created,
    updated,
    messages: messageRecords,
  });

  yield* fs
    .writeFileString(
      sessionPath,
      `${JSON.stringify({
        nativeFormatVersion: TELEPORT_NATIVE_FORMAT_VERSION,
        id: input.session.externalSessionId,
        directory: input.session.cwd,
        cwd: input.session.cwd,
        title:
          input.session.title ??
          firstUserTitle(input.session.messages) ??
          input.session.externalSessionId,
        time: { created, updated },
      })}\n`,
    )
    .pipe(Effect.mapError(mapWriteError(`Failed to write OpenCode session ${sessionPath}.`)));

  const messageRoot = path.join(
    input.opencodeRoot,
    "storage",
    "message",
    input.session.externalSessionId,
  );
  const existingMessageFiles = yield* walkJson(messageRoot);
  for (const filePath of existingMessageFiles) {
    const contents = yield* fs.readFileString(filePath).pipe(Effect.orElseSucceed(() => ""));
    const parsed = parseJsonObject(contents);
    const messageId = parsed ? nonEmptyString(parsed.id) : undefined;
    if (messageId && isSafeTeleportSessionId(messageId)) {
      yield* fs
        .remove(path.join(input.opencodeRoot, "storage", "part", messageId), { recursive: true })
        .pipe(Effect.orElseSucceed(() => undefined));
    }
  }
  yield* fs.remove(messageRoot, { recursive: true }).pipe(Effect.orElseSucceed(() => undefined));
  yield* fs
    .makeDirectory(messageRoot, { recursive: true })
    .pipe(
      Effect.mapError(
        mapWriteError(`Failed to create OpenCode message directory for ${sessionPath}.`),
      ),
    );
  for (const record of messageRecords) {
    yield* fs
      .writeFileString(
        path.join(messageRoot, `${record.messageId}.json`),
        `${JSON.stringify({
          id: record.messageId,
          sessionID: input.session.externalSessionId,
          role: record.message.role,
          time: { created: millisFromIso(record.message.createdAt) },
          path: { cwd: input.session.cwd },
        })}\n`,
      )
      .pipe(
        Effect.mapError(mapWriteError(`Failed to write OpenCode message ${record.messageId}.`)),
      );
    const partRoot = path.join(input.opencodeRoot, "storage", "part", record.messageId);
    yield* fs
      .makeDirectory(partRoot, { recursive: true })
      .pipe(
        Effect.mapError(
          mapWriteError(`Failed to create OpenCode part directory for ${record.messageId}.`),
        ),
      );
    yield* fs
      .writeFileString(
        path.join(partRoot, `${record.partId}.json`),
        `${JSON.stringify({
          id: record.partId,
          sessionID: input.session.externalSessionId,
          messageID: record.messageId,
          type: "text",
          text: record.message.text,
        })}\n`,
      )
      .pipe(
        Effect.mapError(mapWriteError(`Failed to write OpenCode part for ${record.messageId}.`)),
      );
  }

  return sessionPath;
});

function sqliteTableExists(db: NodeSqlite.DatabaseSync, name: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name) as { readonly name?: unknown } | undefined;
  return nonEmptyString(row?.name) === name;
}

function ensureOpenCodeProjectId(
  db: NodeSqlite.DatabaseSync,
  directory: string,
  now: number,
): string {
  if (!sqliteTableExists(db, "project")) {
    throw new Error("OpenCode sqlite store is missing the project table.");
  }
  const byWorktree = db
    .prepare(`SELECT id FROM project WHERE worktree = ? LIMIT 1`)
    .get(directory) as { readonly id?: unknown } | undefined;
  const existing = nonEmptyString(byWorktree?.id);
  if (existing) {
    return existing;
  }
  const globalRow = db
    .prepare(`SELECT id FROM project WHERE id = ? LIMIT 1`)
    .get(OPENCODE_GLOBAL_PROJECT_ID) as { readonly id?: unknown } | undefined;
  if (nonEmptyString(globalRow?.id) === OPENCODE_GLOBAL_PROJECT_ID) {
    return OPENCODE_GLOBAL_PROJECT_ID;
  }
  db.prepare(
    `
      INSERT INTO project (id, worktree, sandboxes, time_created, time_updated)
      VALUES (?, ?, ?, ?, ?)
    `,
  ).run(OPENCODE_GLOBAL_PROJECT_ID, "/", "[]", now, now);
  return OPENCODE_GLOBAL_PROJECT_ID;
}

function openCodeSessionSlug(sessionId: string): string {
  const compact = sessionId.replace(/[^a-zA-Z0-9]/gu, "");
  return compact.length > 0 ? compact.slice(-12).toLowerCase() : "t3teleport";
}

const writeOpenCodeSqliteSession = Effect.fn("writeOpenCodeSqliteSession")(function* (input: {
  readonly opencodeRoot: string;
  readonly session: ParsedNativeSession;
  readonly created: number;
  readonly updated: number;
  readonly messages: ReadonlyArray<{
    readonly message: NativeTextMessage;
    readonly messageId: string;
    readonly partId: string;
  }>;
}) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const dbPath = opencodeDbPath(input.opencodeRoot, path.join);
  const exists = yield* fs.exists(dbPath).pipe(Effect.orElseSucceed(() => false));
  if (!exists) {
    return;
  }
  const sessionId = input.session.externalSessionId;
  const title =
    input.session.title ??
    firstUserTitle(input.session.messages) ??
    input.session.externalSessionId;
  yield* Effect.try({
    try: () => {
      const db = new NodeSqlite.DatabaseSync(dbPath);
      try {
        db.exec("BEGIN");
        try {
          const projectId = ensureOpenCodeProjectId(db, input.session.cwd, input.updated);
          db.prepare(
            `DELETE FROM part WHERE message_id IN (SELECT id FROM message WHERE session_id = ?)`,
          ).run(sessionId);
          db.prepare(`DELETE FROM message WHERE session_id = ?`).run(sessionId);
          db.prepare(`DELETE FROM session WHERE id = ?`).run(sessionId);
          db.prepare(
            `
              INSERT INTO session (
                id, project_id, slug, directory, title, version,
                time_created, time_updated, cost,
                tokens_input, tokens_output, tokens_reasoning,
                tokens_cache_read, tokens_cache_write
              )
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0)
            `,
          ).run(
            sessionId,
            projectId,
            openCodeSessionSlug(sessionId),
            input.session.cwd,
            title,
            OPENCODE_SESSION_VERSION,
            input.created,
            input.updated,
          );
          for (const record of input.messages) {
            const created = millisFromIso(record.message.createdAt);
            db.prepare(
              `
                INSERT INTO message (id, session_id, time_created, time_updated, data)
                VALUES (?, ?, ?, ?, ?)
              `,
            ).run(
              record.messageId,
              sessionId,
              created,
              created,
              JSON.stringify({
                role: record.message.role,
                time: { created },
                path: { cwd: input.session.cwd },
              }),
            );
            db.prepare(
              `
                INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
                VALUES (?, ?, ?, ?, ?, ?)
              `,
            ).run(
              record.partId,
              record.messageId,
              sessionId,
              created,
              created,
              JSON.stringify({ type: "text", text: record.message.text }),
            );
          }
          db.exec("COMMIT");
        } catch (error) {
          try {
            db.exec("ROLLBACK");
          } catch {
            // The original INSERT failure is the one to report.
          }
          throw error;
        }
      } finally {
        db.close();
      }
    },
    catch: (cause) =>
      new TeleportNativeWriteError({
        nativePath: dbPath,
        message: `Failed to write OpenCode sqlite session '${sessionId}'.`,
        cause,
      }),
  });
});

export function toOpenCodeCandidate(session: ParsedNativeSession): TeleportSessionCandidate {
  return {
    provider: "opencode",
    providerInstanceId: defaultInstanceIdForDriver(OPENCODE),
    externalSessionId: session.externalSessionId,
    cwd: session.cwd,
    nativePath: session.nativePath,
    nativeFormatVersion: session.nativeFormatVersion,
    ...teleportCandidateFields(session),
  };
}

const walkJson = Effect.fn("walkOpenCodeJson")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const exists = yield* fs.exists(root).pipe(Effect.orElseSucceed(() => false));
  if (!exists) {
    return [] as string[];
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
      } else if (stat.type === "File" && entryPath.endsWith(".json")) {
        files.push(entryPath);
      }
    }
  }
  return files;
});

registerTeleportFormat({
  provider: "opencode",
  list: Effect.fn("listOpenCodeTeleportSessions")(function* (input) {
    const parsedSessions = yield* listOpenCodeSessions({
      opencodeRoot: input.homes.opencodeRoot,
      cwd: input.cwd,
    });
    return parsedSessions.map(toOpenCodeCandidate);
  }),
  load: Effect.fn("loadOpenCodeSession")(function* (input) {
    const parsed = yield* readOpenCodeSessionById({
      opencodeRoot: input.homes.opencodeRoot,
      sessionId: input.externalSessionId,
    });
    if (Option.isNone(parsed)) {
      return yield* new TeleportDiscoveryError({
        reason: `Native OpenCode session '${input.externalSessionId}' could not be read.`,
      });
    }
    return parsed.value;
  }),
  write: (input) =>
    writeOpenCodeSession({
      opencodeRoot: input.homes.opencodeRoot,
      session: input.session,
    }),
  requireUnlocked: (input) =>
    requireOpenCodeSessionUnlocked({
      nativePath: input.nativePath,
      opencodeRoot: input.homes.opencodeRoot,
    }),
  resumeCursor: (externalSessionId) => ({ schemaVersion: 1, sessionId: externalSessionId }),
  readExternalSessionId: (resumeCursor) =>
    isRecord(resumeCursor) ? nonEmptyString(resumeCursor.sessionId) : undefined,
});
