// Native session fixtures are JSON/JSONL records, not Effect schemas.
// @effect-diagnostics preferSchemaOverJson:off nodeBuiltinImport:off
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, TELEPORT_NATIVE_FORMAT_VERSION } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import {
  isGenericTeleportCwd,
  isTeleportCwdWithin,
  opencodeSessionMatchesProjectCwd,
  resolveTeleportCwdPath,
  teleportCwdsEquivalent,
  teleportCwdsMatch,
} from "./cwd.ts";
import { discoverTeleportSessions } from "./discovery.ts";
import {
  encodeClaudeProjectPath,
  listClaudeJsonlFiles,
  parseClaudeSessionContents,
  serializeClaudeSession,
} from "./formats/claude.ts";
import { parseCodexSessionContents, serializeCodexSession } from "./formats/codex.ts";
import {
  encodeGrokCwdGroup,
  parseGrokSessionDirectory,
  requireGrokSessionUnlocked,
  writeGrokSession,
} from "./formats/grok.ts";
import {
  listOpenCodeSessions,
  readOpenCodeSessionById,
  writeOpenCodeSession,
} from "./formats/opencode.ts";
import type { TeleportHomes } from "./homes.ts";
import { buildTeleportResumeCursor, readTeleportExternalSessionId } from "./resumeCursors.ts";
import type { ParsedNativeSession } from "./types.ts";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const CREATED_AT = "2026-08-14T06:00:00.000Z";

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

function sampleSession(
  provider: ParsedNativeSession["provider"],
  cwd = "/workspace",
): ParsedNativeSession {
  return {
    provider,
    externalSessionId: SESSION_ID,
    cwd,
    nativePath: `/tmp/${provider}.session`,
    nativeFormatVersion: TELEPORT_NATIVE_FORMAT_VERSION,
    title: "Fix the flaky matcher",
    createdAt: CREATED_AT,
    updatedAt: "2026-08-14T06:01:00.000Z",
    messages: [
      {
        role: "user",
        text: "Fix the flaky matcher",
        createdAt: CREATED_AT,
        id: "user-1",
      },
      {
        role: "assistant",
        text: "I'll tighten the path comparison and add a realpath fallback.",
        createdAt: "2026-08-14T06:01:00.000Z",
        id: "assistant-1",
      },
    ],
  };
}

describe("teleport formats", () => {
  it.effect("roundtrips Codex jsonl", () =>
    Effect.gen(function* () {
      const session = sampleSession("codex");
      const parsed = yield* parseCodexSessionContents({
        contents: serializeCodexSession(session),
        nativePath: session.nativePath,
      });
      assert.equal(Option.isSome(parsed), true);
      if (Option.isSome(parsed)) {
        assert.equal(parsed.value.externalSessionId, SESSION_ID);
        assert.equal(parsed.value.cwd, "/workspace");
        assert.equal(parsed.value.messages.length, 2);
        assert.equal(parsed.value.messages[0]?.text, "Fix the flaky matcher");
        assert.equal(
          parsed.value.messages[1]?.text,
          "I'll tighten the path comparison and add a realpath fallback.",
        );
      }
    }),
  );

  it.effect("skips Codex environment_context user wrappers", () =>
    Effect.gen(function* () {
      const contents = `${JSON.stringify({
        timestamp: CREATED_AT,
        type: "session_meta",
        payload: { id: SESSION_ID, cwd: "/workspace" },
      })}\n${JSON.stringify({
        timestamp: CREATED_AT,
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "<environment_context>\n  <cwd>/workspace</cwd>\n" },
          ],
        },
      })}\n${JSON.stringify({
        timestamp: CREATED_AT,
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "KEEP_NAT_CODEX_U1_CEDAR: add a --json flag" }],
        },
      })}\n`;
      const parsed = yield* parseCodexSessionContents({
        contents,
        nativePath: "/tmp/codex-env.jsonl",
      });
      assert.equal(Option.isSome(parsed), true);
      if (Option.isSome(parsed)) {
        assert.equal(parsed.value.messages.length, 1);
        assert.equal(parsed.value.messages[0]?.text, "KEEP_NAT_CODEX_U1_CEDAR: add a --json flag");
        assert.equal(parsed.value.title, "KEEP_NAT_CODEX_U1_CEDAR: add a --json flag");
      }
    }),
  );

  it.effect("skips forked Codex sessions", () =>
    Effect.gen(function* () {
      const contents = `${JSON.stringify({
        timestamp: CREATED_AT,
        type: "session_meta",
        payload: {
          id: SESSION_ID,
          cwd: "/workspace",
          forked_from_id: "parent-session",
        },
      })}\n`;
      const parsed = yield* parseCodexSessionContents({
        contents,
        nativePath: "/tmp/fork.jsonl",
      });
      assert.equal(Option.isNone(parsed), true);
    }),
  );

  it.effect("fails closed on a newer Codex format version", () =>
    Effect.gen(function* () {
      const contents = `${JSON.stringify({
        timestamp: CREATED_AT,
        type: "session_meta",
        nativeFormatVersion: TELEPORT_NATIVE_FORMAT_VERSION + 1,
        payload: { id: SESSION_ID, cwd: "/workspace" },
      })}\n`;
      const result = yield* parseCodexSessionContents({
        contents,
        nativePath: "/tmp/new-codex.jsonl",
      }).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure._tag, "TeleportSchemaVersionError");
      }
    }),
  );

  it.effect("skips Claude tool_result-only user records", () =>
    Effect.gen(function* () {
      const contents = `${JSON.stringify({
        type: "user",
        sessionId: SESSION_ID,
        cwd: "/workspace",
        timestamp: CREATED_AT,
        message: { role: "user", content: "KEEP_NAT_CLAUDE_U1_PINE: create receipts/.gitkeep" },
      })}\n${JSON.stringify({
        type: "user",
        sessionId: SESSION_ID,
        cwd: "/workspace",
        timestamp: CREATED_AT,
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call-1", content: "ok" }],
        },
      })}\n${JSON.stringify({
        type: "assistant",
        sessionId: SESSION_ID,
        cwd: "/workspace",
        timestamp: CREATED_AT,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Created the gitkeep file." }],
        },
      })}\n`;
      const parsed = yield* parseClaudeSessionContents({
        contents,
        nativePath: "/tmp/claude-tools.jsonl",
      });
      assert.equal(Option.isSome(parsed), true);
      if (Option.isSome(parsed)) {
        assert.equal(parsed.value.messages.length, 2);
        assert.equal(
          parsed.value.messages[0]?.text,
          "KEEP_NAT_CLAUDE_U1_PINE: create receipts/.gitkeep",
        );
        assert.equal(parsed.value.messages[1]?.role, "assistant");
      }
    }),
  );

  it.effect("roundtrips Claude jsonl", () =>
    Effect.gen(function* () {
      const session = sampleSession("claudeAgent");
      const parsed = yield* parseClaudeSessionContents({
        contents: serializeClaudeSession(session),
        nativePath: session.nativePath,
      });
      assert.equal(Option.isSome(parsed), true);
      if (Option.isSome(parsed)) {
        assert.equal(parsed.value.externalSessionId, SESSION_ID);
        assert.equal(parsed.value.messages.length, 2);
      }
    }),
  );

  it.effect("fails closed on a newer Claude format version", () =>
    Effect.gen(function* () {
      const contents = `${JSON.stringify({
        type: "user",
        nativeFormatVersion: TELEPORT_NATIVE_FORMAT_VERSION + 1,
        sessionId: SESSION_ID,
        cwd: "/workspace",
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
      })}\n`;
      const result = yield* parseClaudeSessionContents({
        contents,
        nativePath: "/tmp/new-claude.jsonl",
      }).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
    }),
  );

  it.effect("roundtrips Grok session directories", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "teleport-grok-" });
      const session = sampleSession("grok", "/workspace");
      const nativePath = yield* writeGrokSession({
        sessionsRoot: root,
        session,
      });
      const summary = yield* fs.readFileString(path.join(nativePath, "summary.json"));
      const updates = yield* fs.readFileString(path.join(nativePath, "updates.jsonl"));
      const parsed = yield* parseGrokSessionDirectory({
        summaryContents: summary,
        updatesContents: updates,
        nativePath,
      });
      assert.equal(Option.isSome(parsed), true);
      if (Option.isSome(parsed)) {
        assert.equal(parsed.value.externalSessionId, SESSION_ID);
        assert.equal(parsed.value.cwd, "/workspace");
        assert.equal(parsed.value.messages.length, 2);
        assert.equal(parsed.value.messages[0]?.text, "Fix the flaky matcher");
        assert.equal(
          parsed.value.messages[1]?.text,
          "I'll tighten the path comparison and add a realpath fallback.",
        );
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("concatenates consecutive Grok message chunks", () =>
    Effect.gen(function* () {
      const parsed = yield* parseGrokSessionDirectory({
        nativePath: "/tmp/grok-session",
        summaryContents: JSON.stringify({
          info: { id: SESSION_ID, cwd: "/workspace" },
          chat_format_version: 1,
        }),
        updatesContents: `${JSON.stringify({
          timestamp: 1_782_000_000,
          method: "session/update",
          params: {
            sessionId: SESSION_ID,
            update: {
              sessionUpdate: "user_message_chunk",
              content: { type: "text", text: "Hello " },
            },
          },
        })}\n${JSON.stringify({
          timestamp: 1_782_000_001,
          method: "session/update",
          params: {
            sessionId: SESSION_ID,
            update: {
              sessionUpdate: "user_message_chunk",
              content: { type: "text", text: "world" },
            },
          },
        })}\n${JSON.stringify({
          timestamp: 1_782_000_002,
          method: "session/update",
          params: {
            sessionId: SESSION_ID,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "Hi" },
            },
          },
        })}\n`,
      });
      assert.equal(Option.isSome(parsed), true);
      if (Option.isSome(parsed)) {
        assert.equal(parsed.value.messages.length, 2);
        assert.equal(parsed.value.messages[0]?.text, "Hello world");
        assert.equal(parsed.value.messages[1]?.text, "Hi");
      }
    }),
  );

  it.effect("fails closed on a newer Grok format version", () =>
    Effect.gen(function* () {
      const result = yield* parseGrokSessionDirectory({
        summaryContents: JSON.stringify({
          info: { id: SESSION_ID, cwd: "/workspace" },
          chat_format_version: 2,
        }),
        updatesContents: "",
        nativePath: "/tmp/new-grok",
      }).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure._tag, "TeleportSchemaVersionError");
      }
    }),
  );

  it.effect("parses an empty Grok transcript as zero messages", () =>
    Effect.gen(function* () {
      const parsed = yield* parseGrokSessionDirectory({
        summaryContents: JSON.stringify({
          info: { id: SESSION_ID, cwd: "/workspace" },
          chat_format_version: 1,
        }),
        updatesContents: "",
        nativePath: "/tmp/empty-grok",
      });
      assert.equal(Option.isSome(parsed), true);
      if (Option.isSome(parsed)) {
        assert.equal(parsed.value.messages.length, 0);
      }
    }),
  );

  it.effect("treats unlocked Grok session files as writable", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "teleport-grok-unlocked-" });
      const nativePath = yield* writeGrokSession({
        sessionsRoot: root,
        session: sampleSession("grok"),
      });
      yield* requireGrokSessionUnlocked(nativePath);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("roundtrips OpenCode json storage", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "teleport-opencode-" });
      const session = sampleSession("opencode", "/workspace");
      const nativePath = yield* writeOpenCodeSession({
        opencodeRoot: root,
        session,
      });
      const parsed = yield* readOpenCodeSessionById({
        opencodeRoot: root,
        sessionId: SESSION_ID,
      });
      assert.equal(Option.isSome(parsed), true);
      if (Option.isSome(parsed)) {
        assert.equal(parsed.value.cwd, "/workspace");
        assert.equal(parsed.value.messages.length, 2);
        assert.equal(path.basename(nativePath), `${SESSION_ID}.json`);
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
    }).pipe(
      Effect.scoped,
      Effect.provideService(HostProcessPlatform, "linux"),
      Effect.provide(NodeServices.layer),
    ),
  );
});

describe("teleport cwd matching", () => {
  it("treats trailing slashes as the same project", () => {
    assert.equal(teleportCwdsMatch("/workspace", "/workspace/"), true);
    assert.equal(teleportCwdsMatch("/workspace", "/other"), false);
  });

  it("treats a project folder as inside its OpenCode launch cwd", () => {
    assert.equal(
      isTeleportCwdWithin(
        "/home/ubuntu/baanish-testing/native/opencode",
        "/home/ubuntu/baanish-testing/native",
      ),
      true,
    );
    assert.equal(isTeleportCwdWithin("/tmp/oc-wire-test", "/tmp"), true);
    assert.equal(isTeleportCwdWithin("/foobar", "/foo"), false);
  });

  it("rejects home and temp roots as OpenCode launch directories", () => {
    assert.equal(isGenericTeleportCwd("/"), true);
    assert.equal(isGenericTeleportCwd("/tmp"), true);
    assert.equal(isGenericTeleportCwd("/home/ubuntu"), true);
    assert.equal(isGenericTeleportCwd("/home/ubuntu/baanish-testing/native"), false);
    assert.equal(isGenericTeleportCwd("C:\\Users\\Foo"), true);
    assert.equal(isGenericTeleportCwd("C:\\Users\\Foo\\proj"), false);
  });

  it.effect("matches an OpenCode session whose cwd is a parent of the project", () =>
    opencodeSessionMatchesProjectCwd(
      "/home/ubuntu/baanish-testing/native",
      "/home/ubuntu/baanish-testing/native/opencode",
    ).pipe(
      Effect.provideService(HostProcessPlatform, "linux"),
      Effect.provide(NodeServices.layer),
      Effect.map((matched) => {
        assert.equal(matched, true);
      }),
    ),
  );

  it.effect("does not match an OpenCode session launched from /tmp", () =>
    opencodeSessionMatchesProjectCwd("/tmp", "/tmp/oc-wire-test").pipe(
      Effect.provideService(HostProcessPlatform, "linux"),
      Effect.provide(NodeServices.layer),
      Effect.map((matched) => {
        assert.equal(matched, false);
      }),
    ),
  );

  it("encodes Grok cwd groups from the persisted spelling, not the comparison form", () => {
    assert.equal(encodeGrokCwdGroup("/workspace/"), encodeURIComponent("/workspace"));
    assert.equal(
      encodeGrokCwdGroup("C:\\Users\\Foo\\proj"),
      encodeURIComponent("C:\\Users\\Foo\\proj"),
    );
    assert.notEqual(
      encodeGrokCwdGroup("C:\\Users\\Foo\\proj"),
      encodeURIComponent("c:\\users\\foo\\proj"),
    );
  });

  it("encodes Claude project folders without a trailing separator", () => {
    assert.equal(encodeClaudeProjectPath("/workspace/"), encodeClaudeProjectPath("/workspace"));
    assert.equal(
      encodeClaudeProjectPath("C:\\Users\\Foo\\proj\\"),
      encodeClaudeProjectPath("C:\\Users\\Foo\\proj"),
    );
  });

  it.effect("treats a symlink cwd as the same project", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "teleport-cwd-" });
      const real = path.join(root, "real-project");
      const link = path.join(root, "link-project");
      yield* fs.makeDirectory(real, { recursive: true });
      yield* fs.symlink(real, link);
      assert.equal(yield* teleportCwdsEquivalent(real, link), true);
      assert.equal(yield* teleportCwdsEquivalent(real, path.join(root, "other")), false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("treats macOS cwd spellings as the same when they differ only by case", () =>
    teleportCwdsEquivalent("/Users/Alex/proj", "/Users/alex/proj").pipe(
      Effect.provideService(HostProcessPlatform, "darwin"),
      Effect.provide(NodeServices.layer),
      Effect.map((matched) => {
        assert.equal(matched, true);
      }),
    ),
  );

  it.effect("does not case-fold missing Unix paths on Linux", () =>
    teleportCwdsEquivalent("/Users/Alex/proj", "/Users/alex/proj").pipe(
      Effect.provideService(HostProcessPlatform, "linux"),
      Effect.provide(NodeServices.layer),
      Effect.map((matched) => {
        assert.equal(matched, false);
      }),
    ),
  );

  it.effect("lists Claude sessions from the realpath-encoded folder", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "teleport-claude-cwd-" });
      const real = path.join(root, "real-project");
      const link = path.join(root, "link-project");
      const projectsRoot = path.join(root, "projects");
      yield* fs.makeDirectory(real, { recursive: true });
      yield* fs.symlink(real, link);
      const lexicalDir = path.join(projectsRoot, encodeClaudeProjectPath(link));
      const realDir = path.join(projectsRoot, encodeClaudeProjectPath(real));
      yield* fs.makeDirectory(lexicalDir, { recursive: true });
      yield* fs.makeDirectory(realDir, { recursive: true });
      const nativePath = path.join(realDir, `${SESSION_ID}.jsonl`);
      yield* fs.writeFileString(
        nativePath,
        `${JSON.stringify({
          type: "user",
          sessionId: SESSION_ID,
          cwd: real,
          timestamp: CREATED_AT,
          message: { role: "user", content: [{ type: "text", text: "hello" }] },
        })}\n`,
      );
      const files = yield* listClaudeJsonlFiles(projectsRoot, link);
      assert.equal(files.includes(nativePath), true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("resolves a persist cwd without lowercasing Unix paths", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "teleport-persist-cwd-" });
      const project = path.join(root, "MixedCase");
      yield* fs.makeDirectory(project, { recursive: true });
      const resolved = yield* resolveTeleportCwdPath(`${project}/`);
      assert.equal(resolved, yield* fs.realPath(project));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reads a Claude session id from a Windows native path", () =>
    Effect.gen(function* () {
      const parsed = yield* parseClaudeSessionContents({
        nativePath: "C:\\Users\\Foo\\.claude\\projects\\proj\\abc-session.jsonl",
        contents: `${JSON.stringify({
          type: "user",
          cwd: "C:\\Users\\Foo\\proj",
          timestamp: CREATED_AT,
          message: { role: "user", content: [{ type: "text", text: "hello" }] },
        })}\n`,
      });
      assert.equal(parsed._tag, "Some");
      if (parsed._tag === "Some") {
        assert.equal(parsed.value.externalSessionId, "abc-session");
      }
    }),
  );
});

describe("teleport resume cursors", () => {
  it("roundtrips provider session ids", () => {
    assert.equal(
      readTeleportExternalSessionId({
        provider: ProviderDriverKind.make("codex"),
        resumeCursor: buildTeleportResumeCursor({
          provider: "codex",
          externalSessionId: SESSION_ID,
        }),
        runtimePayload: null,
      }),
      SESSION_ID,
    );
    assert.equal(
      readTeleportExternalSessionId({
        provider: ProviderDriverKind.make("claudeAgent"),
        resumeCursor: buildTeleportResumeCursor({
          provider: "claudeAgent",
          externalSessionId: SESSION_ID,
        }),
        runtimePayload: null,
      }),
      SESSION_ID,
    );
    assert.equal(
      readTeleportExternalSessionId({
        provider: ProviderDriverKind.make("opencode"),
        resumeCursor: buildTeleportResumeCursor({
          provider: "opencode",
          externalSessionId: SESSION_ID,
        }),
        runtimePayload: null,
      }),
      SESSION_ID,
    );
    assert.equal(
      readTeleportExternalSessionId({
        provider: ProviderDriverKind.make("grok"),
        resumeCursor: { schemaVersion: 1, sessionId: "other" },
        runtimePayload: {
          teleport: { externalSessionId: SESSION_ID },
        },
      }),
      SESSION_ID,
    );
  });
});

describe("teleport discovery", () => {
  it.effect("lists matching sessions and skips unreadable files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "teleport-homes-" });
      const homes: TeleportHomes = {
        codexSessionsRoot: path.join(root, "codex", "sessions"),
        claudeProjectsRoot: path.join(root, "claude", "projects"),
        opencodeRoot: path.join(root, "opencode"),
        grokSessionsRoot: path.join(root, "grok", "sessions"),
      };

      const codexPath = path.join(
        homes.codexSessionsRoot,
        "2026",
        "08",
        "14",
        `rollout-2026-08-14T06-00-00-${SESSION_ID}.jsonl`,
      );
      yield* fs.makeDirectory(path.dirname(codexPath), { recursive: true });
      yield* fs.writeFileString(codexPath, serializeCodexSession(sampleSession("codex")));
      yield* fs.writeFileString(path.join(path.dirname(codexPath), "garbage.jsonl"), "not-json\n");

      yield* writeGrokSession({
        sessionsRoot: homes.grokSessionsRoot,
        session: sampleSession("grok"),
      });
      yield* writeGrokSession({
        sessionsRoot: homes.grokSessionsRoot,
        session: sampleSession("grok", "/other-project"),
      });

      const listed = yield* discoverTeleportSessions({
        homes,
        cwd: "/workspace",
      });
      assert.equal(listed.sessions.length, 2);
      assert.deepStrictEqual(listed.sessions.map((session) => session.provider).toSorted(), [
        "codex",
        "grok",
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("fails the whole list when any selected file is a newer schema", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "teleport-newer-" });
      const homes: TeleportHomes = {
        codexSessionsRoot: path.join(root, "codex", "sessions"),
        claudeProjectsRoot: path.join(root, "claude", "projects"),
        opencodeRoot: path.join(root, "opencode"),
        grokSessionsRoot: path.join(root, "grok", "sessions"),
      };
      const grokPath = path.join(homes.grokSessionsRoot, "%2Fworkspace", SESSION_ID);
      yield* fs.makeDirectory(grokPath, { recursive: true });
      yield* fs.writeFileString(
        path.join(grokPath, "summary.json"),
        JSON.stringify({
          info: { id: SESSION_ID, cwd: "/workspace" },
          chat_format_version: TELEPORT_NATIVE_FORMAT_VERSION + 1,
        }),
      );
      yield* fs.writeFileString(path.join(grokPath, "updates.jsonl"), "");
      const result = yield* discoverTeleportSessions({
        homes,
        cwd: "/workspace",
      }).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
