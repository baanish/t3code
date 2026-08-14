// Native session fixtures are JSON/JSONL records, not Effect schemas.
// @effect-diagnostics preferSchemaOverJson:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, TELEPORT_NATIVE_FORMAT_VERSION } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { teleportCwdsMatch } from "./cwd.ts";
import { discoverTeleportSessions } from "./discovery.ts";
import { parseClaudeSessionContents, serializeClaudeSession } from "./formats/claude.ts";
import { parseCodexSessionContents, serializeCodexSession } from "./formats/codex.ts";
import { parseGrokSessionDirectory, writeGrokSession } from "./formats/grok.ts";
import { readOpenCodeSessionById, writeOpenCodeSession } from "./formats/opencode.ts";
import type { TeleportHomes } from "./homes.ts";
import { buildTeleportResumeCursor, readTeleportExternalSessionId } from "./resumeCursors.ts";
import type { ParsedNativeSession } from "./types.ts";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const CREATED_AT = "2026-08-14T06:00:00.000Z";

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
});

describe("teleport cwd matching", () => {
  it("treats trailing slashes as the same project", () => {
    assert.equal(teleportCwdsMatch("/workspace", "/workspace/"), true);
    assert.equal(teleportCwdsMatch("/workspace", "/other"), false);
  });
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
