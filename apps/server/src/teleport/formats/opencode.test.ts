// Native session fixtures are JSON/JSONL records, not Effect schemas.
// @effect-diagnostics preferSchemaOverJson:off nodeBuiltinImport:off
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import { buildTeleportResumeCursor, readTeleportExternalSessionId } from "../resumeCursors.ts";
import { sampleTeleportSession, TELEPORT_TEST_SESSION_ID } from "../testFixtures.ts";
import {
  isOpenCodeSharedStorePath,
  listOpenCodeSessions,
  readOpenCodeSessionById,
  requireOpenCodeSessionUnlocked,
  writeOpenCodeSession,
  createOpenCodeId,
} from "./opencode.ts";

function writeOpenCodeSqliteFixture(input: {
  readonly dbPath: string;
  readonly sessions: ReadonlyArray<{
    readonly id: string;
    readonly directory: string;
    readonly title: string;
    readonly messages: ReadonlyArray<{
      readonly id: string;
      readonly role: "user" | "assistant";
      readonly parts: ReadonlyArray<unknown>;
    }>;
  }>;
}): void {
  const db = new NodeSqlite.DatabaseSync(input.dbPath);
  try {
    db.exec(`
      CREATE TABLE session (
        id TEXT,
        directory TEXT,
        title TEXT,
        time_created INTEGER,
        time_updated INTEGER,
        time_archived INTEGER
      );
      CREATE TABLE message (
        id TEXT,
        session_id TEXT,
        time_created INTEGER,
        data TEXT
      );
      CREATE TABLE part (
        id TEXT,
        message_id TEXT,
        time_created INTEGER,
        data TEXT
      );
    `);
    let time = 1;
    for (const session of input.sessions) {
      db.prepare(
        `
          INSERT INTO session (id, directory, title, time_created, time_updated, time_archived)
          VALUES (?, ?, ?, ?, ?, NULL)
        `,
      ).run(session.id, session.directory, session.title, time, time);
      for (const message of session.messages) {
        time += 1;
        db.prepare(
          `INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)`,
        ).run(message.id, session.id, time, JSON.stringify({ role: message.role }));
        for (const [index, part] of message.parts.entries()) {
          time += 1;
          db.prepare(
            `INSERT INTO part (id, message_id, time_created, data) VALUES (?, ?, ?, ?)`,
          ).run(`${message.id}-p${index}`, message.id, time, JSON.stringify(part));
        }
      }
    }
  } finally {
    db.close();
  }
}

function writeOpenCodeV115SqliteSchema(dbPath: string): void {
  const db = new NodeSqlite.DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE project (
        id TEXT PRIMARY KEY,
        worktree TEXT NOT NULL,
        sandboxes TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL
      );
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        directory TEXT NOT NULL,
        title TEXT NOT NULL,
        version TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        time_archived INTEGER,
        cost REAL NOT NULL DEFAULT 0,
        tokens_input INTEGER NOT NULL DEFAULT 0,
        tokens_output INTEGER NOT NULL DEFAULT 0,
        tokens_reasoning INTEGER NOT NULL DEFAULT 0,
        tokens_cache_read INTEGER NOT NULL DEFAULT 0,
        tokens_cache_write INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE part (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL
      );
    `);
  } finally {
    db.close();
  }
}

describe("teleport OpenCode format", () => {
  it.effect("writes OpenCode sqlite rows with required columns and prefixed ids", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "teleport-opencode-sqlite-write-" });
      const dbPath = path.join(root, "opencode.db");
      writeOpenCodeV115SqliteSchema(dbPath);
      const sessionId = createOpenCodeId("ses");
      const session = {
        ...sampleTeleportSession("opencode", "/workspace"),
        externalSessionId: sessionId,
      };
      yield* writeOpenCodeSession({
        opencodeRoot: root,
        session,
      });
      const db = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
      try {
        const sessionRow = db.prepare(`SELECT * FROM session WHERE id = ?`).get(sessionId) as
          | Record<string, unknown>
          | undefined;
        assert.ok(sessionRow);
        assert.equal(typeof sessionRow.project_id, "string");
        assert.ok(String(sessionRow.project_id).length > 0);
        assert.equal(typeof sessionRow.slug, "string");
        assert.ok(String(sessionRow.slug).length > 0);
        assert.equal(sessionRow.version, "1.15.13");
        assert.equal(sessionRow.directory, "/workspace");
        const messageRows = db
          .prepare(`SELECT id, session_id, time_updated FROM message WHERE session_id = ?`)
          .all(sessionId) as ReadonlyArray<Record<string, unknown>>;
        assert.equal(messageRows.length, 2);
        for (const row of messageRows) {
          assert.match(String(row.id), /^msg_/u);
          assert.equal(row.session_id, sessionId);
          assert.equal(typeof row.time_updated, "number");
        }
        const partRows = db
          .prepare(`SELECT id, session_id, time_updated FROM part WHERE session_id = ?`)
          .all(sessionId) as ReadonlyArray<Record<string, unknown>>;
        assert.equal(partRows.length, 2);
        for (const row of partRows) {
          assert.match(String(row.id), /^prt_/u);
          assert.equal(row.session_id, sessionId);
          assert.equal(typeof row.time_updated, "number");
        }
      } finally {
        db.close();
      }
      const parsed = yield* readOpenCodeSessionById({
        opencodeRoot: root,
        sessionId,
      });
      assert.equal(Option.isSome(parsed), true);
      if (Option.isSome(parsed)) {
        assert.equal(parsed.value.messages.length, 2);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("fails OpenCode export when sqlite exists but rejects the session row", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "teleport-opencode-sqlite-fail-" });
      writeOpenCodeSqliteFixture({
        dbPath: path.join(root, "opencode.db"),
        sessions: [],
      });
      const result = yield* writeOpenCodeSession({
        opencodeRoot: root,
        session: sampleTeleportSession("opencode", "/workspace"),
      }).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it("creates OpenCode ids that match the ses_/msg_/prt_ contract", () => {
    assert.match(createOpenCodeId("ses"), /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/u);
    assert.match(createOpenCodeId("msg"), /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/u);
    assert.match(createOpenCodeId("prt"), /^prt_[0-9a-f]{12}[0-9A-Za-z]{14}$/u);
  });

  it.effect("roundtrips OpenCode json storage", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "teleport-opencode-" });
      const session = sampleTeleportSession("opencode", "/workspace");
      const nativePath = yield* writeOpenCodeSession({
        opencodeRoot: root,
        session,
      });
      const parsed = yield* readOpenCodeSessionById({
        opencodeRoot: root,
        sessionId: TELEPORT_TEST_SESSION_ID,
      });
      assert.equal(Option.isSome(parsed), true);
      if (Option.isSome(parsed)) {
        assert.equal(parsed.value.cwd, "/workspace");
        assert.equal(parsed.value.messages.length, 2);
        assert.equal(path.basename(nativePath), `${TELEPORT_TEST_SESSION_ID}.json`);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("imports OpenCode sqlite text parts and skips step-finish telemetry", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "teleport-opencode-sqlite-" });
      writeOpenCodeSqliteFixture({
        dbPath: path.join(root, "opencode.db"),
        sessions: [
          {
            id: "ses_sample",
            directory: "/home/user/projects/native",
            title: "Sample webapp",
            messages: [
              {
                id: "msg_user",
                role: "user",
                parts: [{ type: "text", text: "Use a light theme" }],
              },
              {
                id: "msg_assistant",
                role: "assistant",
                parts: [
                  { type: "step-start" },
                  { type: "reasoning", text: "I will restyle the page." },
                  { type: "text", text: "Updated the palette." },
                  { type: "tool", tool: "edit", state: { status: "completed" } },
                  {
                    type: "step-finish",
                    reason: "stop",
                    tokens: { total: 12, input: 8, output: 4 },
                    cost: 0,
                  },
                ],
              },
            ],
          },
        ],
      });
      const parsed = yield* readOpenCodeSessionById({
        opencodeRoot: root,
        sessionId: "ses_sample",
      });
      assert.equal(Option.isSome(parsed), true);
      if (Option.isSome(parsed)) {
        assert.deepStrictEqual(
          parsed.value.messages.map((message) => ({ role: message.role, text: message.text })),
          [
            { role: "user", text: "Use a light theme" },
            { role: "assistant", text: "Updated the palette." },
          ],
        );
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("lists OpenCode sessions launched from a parent project cwd", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "teleport-opencode-parent-" });
      writeOpenCodeSqliteFixture({
        dbPath: path.join(root, "opencode.db"),
        sessions: [
          {
            id: "ses_parent",
            directory: "/home/user/projects/native",
            title: "Sample webapp",
            messages: [
              {
                id: "msg_user",
                role: "user",
                parts: [{ type: "text", text: "make a simple webapp" }],
              },
            ],
          },
          {
            id: "ses_tmp",
            directory: "/tmp",
            title: "tmp session",
            messages: [
              {
                id: "msg_tmp",
                role: "user",
                parts: [{ type: "text", text: "should not match a tmp child project" }],
              },
            ],
          },
        ],
      });
      const listed = yield* listOpenCodeSessions({
        opencodeRoot: root,
        cwd: "/home/user/projects/native/opencode",
      });
      assert.deepStrictEqual(
        listed.map((session) => session.externalSessionId),
        ["ses_parent"],
      );
      const tmpListed = yield* listOpenCodeSessions({
        opencodeRoot: root,
        cwd: "/tmp/oc-wire-test",
      });
      assert.deepStrictEqual(
        tmpListed.map((session) => session.externalSessionId),
        [],
      );
      const codexListed = yield* listOpenCodeSessions({
        opencodeRoot: root,
        cwd: "/home/user/projects/native/codex",
      });
      assert.deepStrictEqual(
        codexListed.map((session) => session.externalSessionId),
        [],
      );
    }).pipe(
      Effect.scoped,
      Effect.provideService(HostProcessPlatform, "linux"),
      Effect.provide(NodeServices.layer),
    ),
  );

  it("treats opencode.db as the shared live store, not a session file", () => {
    assert.equal(isOpenCodeSharedStorePath("/home/user/.local/share/opencode/opencode.db"), true);
    assert.equal(
      isOpenCodeSharedStorePath("/home/user/.local/share/opencode/storage/session/t3/abc.json"),
      false,
    );
  });

  it.effect("does not refuse import when T3 already has opencode.db open", () =>
    requireOpenCodeSessionUnlocked({
      nativePath: "/home/user/.local/share/opencode/opencode.db",
      opencodeRoot: "/home/user/.local/share/opencode",
    }).pipe(
      Effect.provideService(HostProcessPlatform, "linux"),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("refuses to load a session id that would traverse out of the OpenCode root", () =>
    readOpenCodeSessionById({
      opencodeRoot: "/tmp/opencode-root",
      sessionId: "../../.codex/sessions",
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.map((parsed) => {
        assert.equal(Option.isNone(parsed), true);
      }),
    ),
  );

  it.effect("does not write OpenCode messages with traversing ids outside the session", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "teleport-opencode-msg-id-" });
      const session = {
        ...sampleTeleportSession("opencode", "/workspace"),
        messages: [
          {
            role: "user" as const,
            text: "stay inside the session",
            id: "../../outside",
          },
        ],
      };
      yield* writeOpenCodeSession({
        opencodeRoot: root,
        session,
      });
      const messageRoot = path.join(root, "storage", "message", TELEPORT_TEST_SESSION_ID);
      const files = yield* fs.readDirectory(messageRoot);
      assert.equal(
        files.some((name) => name.includes("..") || name.includes("outside")),
        false,
      );
      const escaped = yield* fs
        .exists(path.join(root, "outside.json"))
        .pipe(Effect.orElseSucceed(() => false));
      assert.equal(escaped, false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("replaces OpenCode json messages instead of leaving stale turns", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "teleport-opencode-replace-" });
      const first = sampleTeleportSession("opencode", "/workspace");
      yield* writeOpenCodeSession({
        opencodeRoot: root,
        session: first,
      });
      const shortened = {
        ...first,
        messages: first.messages.slice(0, 1),
      };
      yield* writeOpenCodeSession({
        opencodeRoot: root,
        session: shortened,
      });
      const parsed = yield* readOpenCodeSessionById({
        opencodeRoot: root,
        sessionId: TELEPORT_TEST_SESSION_ID,
      });
      assert.equal(Option.isSome(parsed), true);
      if (Option.isSome(parsed)) {
        assert.equal(parsed.value.messages.length, 1);
        assert.equal(parsed.value.messages[0]?.text, first.messages[0]?.text);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it("roundtrips OpenCode resume cursors", () => {
    assert.equal(
      readTeleportExternalSessionId({
        provider: ProviderDriverKind.make("opencode"),
        resumeCursor: buildTeleportResumeCursor({
          provider: "opencode",
          externalSessionId: TELEPORT_TEST_SESSION_ID,
        }),
        runtimePayload: null,
      }),
      TELEPORT_TEST_SESSION_ID,
    );
  });
});
