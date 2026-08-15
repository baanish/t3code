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

describe("teleport OpenCode format", () => {
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
            id: "ses_meal",
            directory: "/home/ubuntu/baanish-testing/native",
            title: "Weekly meal planning webapp",
            messages: [
              {
                id: "msg_user",
                role: "user",
                parts: [{ type: "text", text: "Make light mode pastel themed" }],
              },
              {
                id: "msg_assistant",
                role: "assistant",
                parts: [
                  { type: "step-start" },
                  { type: "reasoning", text: "I will restyle the page." },
                  { type: "text", text: "Updated the palette to pastels." },
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
        sessionId: "ses_meal",
      });
      assert.equal(Option.isSome(parsed), true);
      if (Option.isSome(parsed)) {
        assert.deepStrictEqual(
          parsed.value.messages.map((message) => ({ role: message.role, text: message.text })),
          [
            { role: "user", text: "Make light mode pastel themed" },
            { role: "assistant", text: "Updated the palette to pastels." },
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
            directory: "/home/ubuntu/baanish-testing/native",
            title: "Weekly meal planning webapp",
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
        cwd: "/home/ubuntu/baanish-testing/native/opencode",
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
        cwd: "/home/ubuntu/baanish-testing/native/codex",
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
    assert.equal(isOpenCodeSharedStorePath("/home/ubuntu/.local/share/opencode/opencode.db"), true);
    assert.equal(
      isOpenCodeSharedStorePath("/home/ubuntu/.local/share/opencode/storage/session/t3/abc.json"),
      false,
    );
  });

  it.effect("does not refuse import when T3 already has opencode.db open", () =>
    requireOpenCodeSessionUnlocked({
      nativePath: "/home/ubuntu/.local/share/opencode/opencode.db",
      opencodeRoot: "/home/ubuntu/.local/share/opencode",
    }).pipe(
      Effect.provideService(HostProcessPlatform, "linux"),
      Effect.provide(NodeServices.layer),
    ),
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
