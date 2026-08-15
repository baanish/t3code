// @effect-diagnostics nodeBuiltinImport:off globalDate:off preferSchemaOverJson:off
import * as NodeSqlite from "node:sqlite";

import {
  TELEPORT_NATIVE_FORMAT_VERSION,
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

import { opencodeSessionMatchesProjectCwd } from "../cwd.ts";
import { requireNativePathUnlocked } from "../fileLock.ts";
import { firstUserTitle, isRecord, nonEmptyString, parseJsonObject } from "../json.ts";
import {
  nativeTextMessage,
  parsedNativeSession,
  teleportCandidateFields,
  type NativeTextMessage,
  type ParsedNativeSession,
} from "../types.ts";

const OPENCODE = ProviderDriverKind.make("opencode");

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

export const requireOpenCodeSessionUnlocked = Effect.fn("requireOpenCodeSessionUnlocked")(
  function* (input: { readonly nativePath: string; readonly opencodeRoot: string }) {
    // T3's idle OpenCode process keeps opencode.db open. Treat that as the live
    // store, not a foreign lock. Only refuse when the session JSON itself is held.
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
    pathsMatch: () => true,
  });
  const candidates =
    sqliteSessions.length > 0
      ? sqliteSessions
      : yield* readOpenCodeJsonSessions(input.opencodeRoot);
  const sessions: ParsedNativeSession[] = [];
  for (const session of candidates) {
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
  const sqlite = yield* readOpenCodeSqliteSessions({
    opencodeRoot: input.opencodeRoot,
    cwd: "",
    pathsMatch: () => true,
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
  readonly pathsMatch: (left: string, right: string) => boolean;
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
        const rows = db
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
              LIMIT 1000
            `,
          )
          .all() as ReadonlyArray<Record<string, unknown>>;

        const sessions: ParsedNativeSession[] = [];
        for (const row of rows) {
          const id = nonEmptyString(row.id);
          const cwd = nonEmptyString(row.directory);
          if (!id || !cwd) {
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
    if (!id || !cwd) {
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
    if (!role || !id) {
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
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const partRoot = path.join(opencodeRoot, "storage", "part", messageId);
  const files = yield* walkJson(partRoot);
  const texts: string[] = [];
  for (const filePath of files) {
    const contents = yield* fs.readFileString(filePath).pipe(Effect.orElseSucceed(() => ""));
    const parsed = parseJsonObject(contents);
    const text = textFromPartData(parsed ?? contents);
    if (text) {
      texts.push(text);
    }
  }
  return nonEmptyString(texts.join("\n"));
});

export const writeOpenCodeSession = Effect.fn("writeOpenCodeSession")(function* (input: {
  readonly opencodeRoot: string;
  readonly session: ParsedNativeSession;
}): Effect.fn.Return<string, TeleportNativeWriteError, FileSystem.FileSystem | Path.Path> {
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
  }).pipe(Effect.mapError(mapWriteError(`Native OpenCode session is locked: ${sessionPath}`)));
  yield* fs
    .makeDirectory(sessionDir, { recursive: true })
    .pipe(
      Effect.mapError(
        mapWriteError(`Failed to create OpenCode session directory for ${sessionPath}.`),
      ),
    );
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
  yield* fs
    .makeDirectory(messageRoot, { recursive: true })
    .pipe(
      Effect.mapError(
        mapWriteError(`Failed to create OpenCode message directory for ${sessionPath}.`),
      ),
    );
  for (const [index, message] of input.session.messages.entries()) {
    const messageId = message.id ?? `${input.session.externalSessionId}-m${index}`;
    yield* fs
      .writeFileString(
        path.join(messageRoot, `${messageId}.json`),
        `${JSON.stringify({
          id: messageId,
          sessionID: input.session.externalSessionId,
          role: message.role,
          time: { created: millisFromIso(message.createdAt) },
          path: { cwd: input.session.cwd },
        })}\n`,
      )
      .pipe(Effect.mapError(mapWriteError(`Failed to write OpenCode message ${messageId}.`)));
    const partRoot = path.join(input.opencodeRoot, "storage", "part", messageId);
    yield* fs
      .makeDirectory(partRoot, { recursive: true })
      .pipe(
        Effect.mapError(
          mapWriteError(`Failed to create OpenCode part directory for ${messageId}.`),
        ),
      );
    yield* fs
      .writeFileString(
        path.join(partRoot, `${messageId}-text.json`),
        `${JSON.stringify({ type: "text", text: message.text })}\n`,
      )
      .pipe(Effect.mapError(mapWriteError(`Failed to write OpenCode part for ${messageId}.`)));
  }

  yield* writeOpenCodeSqliteSession({
    opencodeRoot: input.opencodeRoot,
    session: input.session,
    created,
    updated,
  }).pipe(Effect.orElseSucceed(() => undefined));

  return sessionPath;
});

const writeOpenCodeSqliteSession = Effect.fn("writeOpenCodeSqliteSession")(function* (input: {
  readonly opencodeRoot: string;
  readonly session: ParsedNativeSession;
  readonly created: number;
  readonly updated: number;
}) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const dbPath = opencodeDbPath(input.opencodeRoot, path.join);
  const exists = yield* fs.exists(dbPath).pipe(Effect.orElseSucceed(() => false));
  if (!exists) {
    return;
  }
  yield* Effect.sync(() => {
    try {
      const db = new NodeSqlite.DatabaseSync(dbPath);
      try {
        db.exec("BEGIN");
        db.prepare(
          `
            INSERT OR REPLACE INTO session (id, directory, title, time_created, time_updated)
            VALUES (?, ?, ?, ?, ?)
          `,
        ).run(
          input.session.externalSessionId,
          input.session.cwd,
          input.session.title ??
            firstUserTitle(input.session.messages) ??
            input.session.externalSessionId,
          input.created,
          input.updated,
        );
        for (const [index, message] of input.session.messages.entries()) {
          const messageId = message.id ?? `${input.session.externalSessionId}-m${index}`;
          const created = millisFromIso(message.createdAt);
          db.prepare(
            `
              INSERT OR REPLACE INTO message (id, session_id, time_created, data)
              VALUES (?, ?, ?, ?)
            `,
          ).run(
            messageId,
            input.session.externalSessionId,
            created,
            JSON.stringify({
              role: message.role,
              time: { created },
              path: { cwd: input.session.cwd },
            }),
          );
          db.prepare(
            `
              INSERT OR REPLACE INTO part (id, message_id, time_created, data)
              VALUES (?, ?, ?, ?)
            `,
          ).run(
            `${messageId}-text`,
            messageId,
            created,
            JSON.stringify({ type: "text", text: message.text }),
          );
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      } finally {
        db.close();
      }
    } catch {
      // JSON files are the export source of truth; SQLite is best-effort.
    }
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
