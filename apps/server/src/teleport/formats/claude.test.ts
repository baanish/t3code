// Native session fixtures are JSON/JSONL records, not Effect schemas.
// @effect-diagnostics preferSchemaOverJson:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, TELEPORT_NATIVE_FORMAT_VERSION } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import * as ProcessRunner from "../../processRunner.ts";
import { discoverTeleportSessions } from "../discovery.ts";
import type { TeleportHomes } from "../homes.ts";
import { buildTeleportResumeCursor, readTeleportExternalSessionId } from "../resumeCursors.ts";
import {
  sampleTeleportSession,
  TELEPORT_TEST_CREATED_AT,
  TELEPORT_TEST_SESSION_ID,
} from "../testFixtures.ts";
import {
  encodeClaudeProjectPath,
  listClaudeJsonlFiles,
  parseClaudeSessionContents,
  serializeClaudeSession,
  claudeTeleportFormat,
} from "./claude.ts";
import * as TeleportFormatRegistry from "./registry.ts";

describe("teleport Claude format", () => {
  it.effect("skips Claude tool_result-only user records", () =>
    Effect.gen(function* () {
      const contents = `${JSON.stringify({
        type: "user",
        sessionId: TELEPORT_TEST_SESSION_ID,
        cwd: "/workspace",
        timestamp: TELEPORT_TEST_CREATED_AT,
        message: { role: "user", content: "KEEP_NAT_CLAUDE_U1_PINE: create receipts/.gitkeep" },
      })}\n${JSON.stringify({
        type: "user",
        sessionId: TELEPORT_TEST_SESSION_ID,
        cwd: "/workspace",
        timestamp: TELEPORT_TEST_CREATED_AT,
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call-1", content: "ok" }],
        },
      })}\n${JSON.stringify({
        type: "assistant",
        sessionId: TELEPORT_TEST_SESSION_ID,
        cwd: "/workspace",
        timestamp: TELEPORT_TEST_CREATED_AT,
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

  it.effect("imports only the latest Claude rewind branch", () =>
    Effect.gen(function* () {
      const record = (input: {
        readonly type: "user" | "assistant";
        readonly uuid: string;
        readonly parentUuid: string | null;
        readonly text: string;
      }) =>
        JSON.stringify({
          type: input.type,
          uuid: input.uuid,
          parentUuid: input.parentUuid,
          sessionId: TELEPORT_TEST_SESSION_ID,
          cwd: "/workspace",
          timestamp: TELEPORT_TEST_CREATED_AT,
          message: {
            role: input.type,
            content: [{ type: "text", text: input.text }],
          },
        });
      const contents = [
        record({ type: "user", uuid: "root", parentUuid: null, text: "root prompt" }),
        record({ type: "assistant", uuid: "base", parentUuid: "root", text: "base answer" }),
        record({ type: "user", uuid: "old-user", parentUuid: "base", text: "abandoned prompt" }),
        record({
          type: "assistant",
          uuid: "old-assistant",
          parentUuid: "old-user",
          text: "abandoned answer",
        }),
        record({ type: "user", uuid: "new-user", parentUuid: "base", text: "kept prompt" }),
        record({
          type: "assistant",
          uuid: "new-assistant",
          parentUuid: "new-user",
          text: "kept answer",
        }),
      ].join("\n");

      const parsed = yield* parseClaudeSessionContents({
        contents,
        nativePath: "/tmp/claude-rewind.jsonl",
      });
      assert.equal(Option.isSome(parsed), true);
      if (Option.isSome(parsed)) {
        assert.deepEqual(
          parsed.value.messages.map((message) => message.text),
          ["root prompt", "base answer", "kept prompt", "kept answer"],
        );
      }
    }),
  );

  it.effect("does not let a late tool result select an abandoned Claude branch", () =>
    Effect.gen(function* () {
      const records = [
        {
          type: "user",
          uuid: "root",
          parentUuid: null,
          sessionId: TELEPORT_TEST_SESSION_ID,
          cwd: "/workspace",
          message: { role: "user", content: "root" },
        },
        {
          type: "assistant",
          uuid: "abandoned",
          parentUuid: "root",
          sessionId: TELEPORT_TEST_SESSION_ID,
          cwd: "/workspace",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "abandoned answer" },
              { type: "tool_use", id: "call-1", name: "Bash", input: {} },
            ],
          },
        },
        {
          type: "user",
          uuid: "kept-user",
          parentUuid: "root",
          sessionId: TELEPORT_TEST_SESSION_ID,
          cwd: "/workspace",
          message: { role: "user", content: "kept prompt" },
        },
        {
          type: "assistant",
          uuid: "kept-assistant",
          parentUuid: "kept-user",
          sessionId: TELEPORT_TEST_SESSION_ID,
          cwd: "/workspace",
          message: { role: "assistant", content: "kept answer" },
        },
        {
          type: "user",
          uuid: "late-tool-result",
          parentUuid: "abandoned",
          sessionId: TELEPORT_TEST_SESSION_ID,
          cwd: "/workspace",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "call-1", content: "ok" }],
          },
        },
      ];
      const parsed = yield* parseClaudeSessionContents({
        contents: records.map((record) => JSON.stringify(record)).join("\n"),
        nativePath: "/tmp/claude-late-tool.jsonl",
      });
      assert.equal(Option.isSome(parsed), true);
      if (Option.isSome(parsed)) {
        assert.deepEqual(
          parsed.value.messages.map((message) => message.text),
          ["root", "kept prompt", "kept answer"],
        );
      }
    }),
  );

  it.effect("uses Claude summary leafUuid instead of a later abandoned sibling", () =>
    Effect.gen(function* () {
      const records = [
        {
          type: "user",
          uuid: "root",
          parentUuid: null,
          sessionId: TELEPORT_TEST_SESSION_ID,
          cwd: "/workspace",
          message: { role: "user", content: "root" },
        },
        {
          type: "assistant",
          uuid: "kept",
          parentUuid: "root",
          sessionId: TELEPORT_TEST_SESSION_ID,
          cwd: "/workspace",
          message: { role: "assistant", content: "kept answer" },
        },
        {
          type: "assistant",
          uuid: "abandoned",
          parentUuid: "root",
          sessionId: TELEPORT_TEST_SESSION_ID,
          cwd: "/workspace",
          message: { role: "assistant", content: "abandoned answer" },
        },
        {
          type: "summary",
          leafUuid: "kept",
          sessionId: TELEPORT_TEST_SESSION_ID,
          cwd: "/workspace",
        },
      ];
      const parsed = yield* parseClaudeSessionContents({
        contents: records.map((record) => JSON.stringify(record)).join("\n"),
        nativePath: "/tmp/claude-summary-leaf.jsonl",
      });
      assert.equal(Option.isSome(parsed), true);
      if (Option.isSome(parsed)) {
        assert.deepEqual(
          parsed.value.messages.map((message) => message.text),
          ["root", "kept answer"],
        );
      }
    }),
  );

  it.effect("selects the primary path across many generated Claude rewind branches", () =>
    Effect.gen(function* () {
      const records: Record<string, unknown>[] = [
        {
          type: "user",
          uuid: "root",
          parentUuid: null,
          sessionId: TELEPORT_TEST_SESSION_ID,
          cwd: "/workspace",
          message: { role: "user", content: "root prompt" },
        },
        {
          type: "assistant",
          uuid: "fork",
          parentUuid: "root",
          sessionId: TELEPORT_TEST_SESSION_ID,
          cwd: "/workspace",
          message: { role: "assistant", content: "fork answer" },
        },
      ];
      for (let branch = 0; branch < 128; branch += 1) {
        records.push(
          {
            type: "user",
            uuid: `user-${branch}`,
            parentUuid: "fork",
            sessionId: TELEPORT_TEST_SESSION_ID,
            cwd: "/workspace",
            message: { role: "user", content: `prompt-${branch}` },
          },
          {
            type: "assistant",
            uuid: `assistant-${branch}`,
            parentUuid: `user-${branch}`,
            sessionId: TELEPORT_TEST_SESSION_ID,
            cwd: "/workspace",
            message: { role: "assistant", content: `answer-${branch}` },
          },
        );
      }

      const parsed = yield* parseClaudeSessionContents({
        contents: records.map((record) => JSON.stringify(record)).join("\n"),
        nativePath: "/tmp/claude-many-rewinds.jsonl",
      });
      assert.equal(Option.isSome(parsed), true);
      if (Option.isSome(parsed)) {
        assert.deepEqual(
          parsed.value.messages.map((message) => message.text),
          ["root prompt", "fork answer", "prompt-127", "answer-127"],
        );
      }
    }),
  );

  it.effect("falls back to the flat Claude transcript when parent links are incomplete", () =>
    Effect.gen(function* () {
      const contents = [
        {
          type: "user",
          uuid: "root",
          parentUuid: null,
          sessionId: TELEPORT_TEST_SESSION_ID,
          cwd: "/workspace",
          message: { role: "user", content: "first root" },
        },
        {
          type: "assistant",
          uuid: "detached",
          parentUuid: "missing-parent",
          sessionId: TELEPORT_TEST_SESSION_ID,
          cwd: "/workspace",
          message: { role: "assistant", content: "still preserve me" },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n");

      const parsed = yield* parseClaudeSessionContents({
        contents,
        nativePath: "/tmp/claude-broken-chain.jsonl",
      });
      assert.equal(Option.isSome(parsed), true);
      if (Option.isSome(parsed)) {
        assert.deepEqual(
          parsed.value.messages.map((message) => message.text),
          ["first root", "still preserve me"],
        );
      }
    }),
  );

  it.effect("stitches Claude compact boundaries through logicalParentUuid", () =>
    Effect.gen(function* () {
      const records = [
        {
          type: "user",
          uuid: "root",
          parentUuid: null,
          sessionId: TELEPORT_TEST_SESSION_ID,
          cwd: "/workspace",
          message: { role: "user", content: "before compact" },
        },
        {
          type: "assistant",
          uuid: "before-boundary",
          parentUuid: "root",
          sessionId: TELEPORT_TEST_SESSION_ID,
          cwd: "/workspace",
          message: { role: "assistant", content: "before answer" },
        },
        {
          type: "system",
          subtype: "compact_boundary",
          uuid: "boundary",
          parentUuid: null,
          logicalParentUuid: "before-boundary",
          sessionId: TELEPORT_TEST_SESSION_ID,
          cwd: "/workspace",
        },
        {
          type: "user",
          uuid: "after-boundary",
          parentUuid: "boundary",
          sessionId: TELEPORT_TEST_SESSION_ID,
          cwd: "/workspace",
          message: { role: "user", content: "after compact" },
        },
      ];
      const parsed = yield* parseClaudeSessionContents({
        contents: records.map((record) => JSON.stringify(record)).join("\n"),
        nativePath: "/tmp/claude-compact.jsonl",
      });
      assert.equal(Option.isSome(parsed), true);
      if (Option.isSome(parsed)) {
        assert.deepEqual(
          parsed.value.messages.map((message) => message.text),
          ["before compact", "before answer", "after compact"],
        );
      }
    }),
  );

  it.effect("does not let Claude system records replace the session identity", () =>
    Effect.gen(function* () {
      const contents = [
        {
          type: "user",
          uuid: "root",
          parentUuid: null,
          sessionId: TELEPORT_TEST_SESSION_ID,
          cwd: "/workspace",
          message: { role: "user", content: "hello" },
        },
        {
          type: "system",
          subtype: "compact_boundary",
          uuid: "boundary",
          parentUuid: "root",
          sessionId: "22222222-2222-4222-8222-222222222222",
          cwd: "/workspace",
        },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n");
      const parsed = yield* parseClaudeSessionContents({
        contents,
        nativePath: `/tmp/${TELEPORT_TEST_SESSION_ID}.jsonl`,
      });
      assert.equal(Option.isSome(parsed), true);
      if (Option.isSome(parsed)) {
        assert.equal(parsed.value.externalSessionId, TELEPORT_TEST_SESSION_ID);
      }
    }),
  );

  it.effect("preserves leading and trailing whitespace in Claude message text", () =>
    Effect.gen(function* () {
      const contents = `${JSON.stringify({
        type: "user",
        sessionId: TELEPORT_TEST_SESSION_ID,
        cwd: "/workspace",
        timestamp: TELEPORT_TEST_CREATED_AT,
        message: { role: "user", content: [{ type: "text", text: "  keep indent  \n" }] },
      })}\n`;
      const parsed = yield* parseClaudeSessionContents({
        contents,
        nativePath: "/tmp/claude-whitespace.jsonl",
      });
      assert.equal(Option.isSome(parsed), true);
      if (Option.isSome(parsed)) {
        assert.equal(parsed.value.messages[0]?.text, "  keep indent  \n");
      }
    }),
  );

  it.effect("skips Claude meta and slash-command caveat records", () =>
    Effect.gen(function* () {
      const contents = `${JSON.stringify({
        type: "user",
        isMeta: true,
        sessionId: TELEPORT_TEST_SESSION_ID,
        cwd: "/workspace",
        timestamp: TELEPORT_TEST_CREATED_AT,
        message: { role: "user", content: "<command-name>/init</command-name>" },
      })}\n${JSON.stringify({
        type: "user",
        sessionId: TELEPORT_TEST_SESSION_ID,
        cwd: "/workspace",
        timestamp: TELEPORT_TEST_CREATED_AT,
        message: {
          role: "user",
          content:
            "<local-command-caveat>Caveat: The messages below were generated by the user.</local-command-caveat>",
        },
      })}\n${JSON.stringify({
        type: "user",
        sessionId: TELEPORT_TEST_SESSION_ID,
        cwd: "/workspace",
        timestamp: TELEPORT_TEST_CREATED_AT,
        message: { role: "user", content: "KEEP_NAT_CLAUDE_U1_PINE: real prompt" },
      })}\n`;
      const parsed = yield* parseClaudeSessionContents({
        contents,
        nativePath: "/tmp/claude-meta.jsonl",
      });
      assert.equal(Option.isSome(parsed), true);
      if (Option.isSome(parsed)) {
        assert.equal(parsed.value.messages.length, 1);
        assert.equal(parsed.value.messages[0]?.text, "KEEP_NAT_CLAUDE_U1_PINE: real prompt");
      }
    }),
  );

  it.effect("does not list Claude subagent jsonl files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "teleport-claude-subagents-" });
      const projectDir = path.join(root, encodeClaudeProjectPath("/workspace"));
      const subagentsDir = path.join(projectDir, TELEPORT_TEST_SESSION_ID, "subagents");
      const toolResultsDir = path.join(projectDir, "tool-results");
      yield* fs.makeDirectory(subagentsDir, { recursive: true });
      yield* fs.makeDirectory(toolResultsDir, { recursive: true });
      const parentPath = path.join(projectDir, `${TELEPORT_TEST_SESSION_ID}.jsonl`);
      const childPath = path.join(subagentsDir, "agent-1.jsonl");
      const legacyAgentPath = path.join(projectDir, "agent-deadbeef.jsonl");
      const toolResultPath = path.join(toolResultsDir, "result.jsonl");
      const record = `${JSON.stringify({
        type: "user",
        sessionId: TELEPORT_TEST_SESSION_ID,
        cwd: "/workspace",
        timestamp: TELEPORT_TEST_CREATED_AT,
        message: { role: "user", content: "hello" },
      })}\n`;
      yield* fs.writeFileString(parentPath, record);
      yield* fs.writeFileString(childPath, record);
      yield* fs.writeFileString(legacyAgentPath, record);
      yield* fs.writeFileString(toolResultPath, record);
      const files = yield* listClaudeJsonlFiles(root, "/workspace");
      assert.equal(files.includes(parentPath), true);
      assert.equal(files.includes(childPath), false);
      assert.equal(files.includes(legacyAgentPath), false);
      assert.equal(files.includes(toolResultPath), false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("roundtrips Claude jsonl", () =>
    Effect.gen(function* () {
      const session = sampleTeleportSession("claudeAgent");
      const parsed = yield* parseClaudeSessionContents({
        contents: serializeClaudeSession(session),
        nativePath: session.nativePath,
      });
      assert.equal(Option.isSome(parsed), true);
      if (Option.isSome(parsed)) {
        assert.equal(parsed.value.externalSessionId, TELEPORT_TEST_SESSION_ID);
        assert.equal(parsed.value.messages.length, 2);
      }
    }),
  );

  it.effect("serializes an empty Claude session with metadata the parser can resume", () =>
    Effect.gen(function* () {
      const session = sampleTeleportSession("claudeAgent");
      const empty = { ...session, messages: [] };
      const parsed = yield* parseClaudeSessionContents({
        contents: serializeClaudeSession(empty),
        nativePath: session.nativePath,
      });
      assert.equal(Option.isSome(parsed), true);
      if (Option.isSome(parsed)) {
        assert.equal(parsed.value.externalSessionId, TELEPORT_TEST_SESSION_ID);
        assert.equal(parsed.value.cwd, "/workspace");
        assert.equal(parsed.value.messages.length, 0);
      }
    }),
  );

  it.effect("fails closed on a newer Claude format version", () =>
    Effect.gen(function* () {
      const contents = `${JSON.stringify({
        type: "user",
        nativeFormatVersion: TELEPORT_NATIVE_FORMAT_VERSION + 1,
        sessionId: TELEPORT_TEST_SESSION_ID,
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

  it("encodes Claude project folders without a trailing separator", () => {
    assert.equal(encodeClaudeProjectPath("/workspace/"), encodeClaudeProjectPath("/workspace"));
    assert.equal(
      encodeClaudeProjectPath("C:\\Users\\Foo\\proj\\"),
      encodeClaudeProjectPath("C:\\Users\\Foo\\proj"),
    );
    const longPath = `/${"long-segment/".repeat(30)}project`;
    assert.equal(encodeClaudeProjectPath(`${longPath}/`), encodeClaudeProjectPath(longPath));
  });

  it("matches Claude project folder encoding for emoji and long paths", () => {
    assert.equal(encodeClaudeProjectPath("/tmp/proj-😀-x"), "-tmp-proj----x");
    assert.equal(encodeClaudeProjectPath(`/${"a".repeat(210)}`), `-${"a".repeat(199)}-djaaup`);
  });

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
      const nativePath = path.join(realDir, `${TELEPORT_TEST_SESSION_ID}.jsonl`);
      yield* fs.writeFileString(
        nativePath,
        `${JSON.stringify({
          type: "user",
          sessionId: TELEPORT_TEST_SESSION_ID,
          cwd: real,
          timestamp: TELEPORT_TEST_CREATED_AT,
          message: { role: "user", content: [{ type: "text", text: "hello" }] },
        })}\n`,
      );
      const files = yield* listClaudeJsonlFiles(projectsRoot, link);
      assert.equal(files.includes(nativePath), true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("lists Claude sessions from a custom sibling project folder", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "teleport-claude-custom-" });
      const encodedDir = path.join(root, encodeClaudeProjectPath("/workspace"));
      const customDir = path.join(root, "pinned-project");
      yield* fs.makeDirectory(encodedDir, { recursive: true });
      yield* fs.makeDirectory(customDir, { recursive: true });
      const nativePath = path.join(customDir, `${TELEPORT_TEST_SESSION_ID}.jsonl`);
      yield* fs.writeFileString(
        nativePath,
        serializeClaudeSession(sampleTeleportSession("claudeAgent")),
      );
      const files = yield* listClaudeJsonlFiles(root, "/workspace");
      assert.equal(files.includes(nativePath), true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("skips the global Claude projects walk when the caller already did it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "teleport-claude-once-" });
      const encodedDir = path.join(root, encodeClaudeProjectPath("/workspace"));
      const customDir = path.join(root, "pinned-project");
      yield* fs.makeDirectory(encodedDir, { recursive: true });
      yield* fs.makeDirectory(customDir, { recursive: true });
      const encodedPath = path.join(encodedDir, `${TELEPORT_TEST_SESSION_ID}.jsonl`);
      const customPath = path.join(customDir, `${TELEPORT_TEST_SESSION_ID}.jsonl`);
      yield* fs.writeFileString(
        encodedPath,
        serializeClaudeSession(sampleTeleportSession("claudeAgent")),
      );
      yield* fs.writeFileString(
        customPath,
        serializeClaudeSession(sampleTeleportSession("claudeAgent")),
      );
      const files = yield* listClaudeJsonlFiles(root, "/workspace", {
        includeGlobalFallback: false,
      });
      assert.equal(files.includes(encodedPath), true);
      assert.equal(files.includes(customPath), false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("lists Claude sessions from a project worktree cwd", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "teleport-claude-worktree-" });
      const projectCwd = path.join(root, "project");
      const worktreeCwd = path.join(root, "worktrees", "feature");
      const homes: TeleportHomes = {
        codexSessionsRoot: path.join(root, "codex", "sessions"),
        extraCodexSessionsRoots: [],
        claudeProjectsRoot: path.join(root, "claude", "projects"),
        extraClaudeProjectsRoots: [],
      };
      const nativePath = path.join(
        homes.claudeProjectsRoot,
        encodeClaudeProjectPath(worktreeCwd),
        `${TELEPORT_TEST_SESSION_ID}.jsonl`,
      );
      yield* fs.makeDirectory(path.dirname(nativePath), { recursive: true });
      yield* fs.writeFileString(
        nativePath,
        serializeClaudeSession(sampleTeleportSession("claudeAgent", worktreeCwd)),
      );
      yield* fs.writeFileString(
        path.join(path.dirname(nativePath), "future.jsonl"),
        `${JSON.stringify({
          type: "user",
          nativeFormatVersion: TELEPORT_NATIVE_FORMAT_VERSION + 1,
          sessionId: "22222222-2222-4222-8222-222222222222",
          cwd: worktreeCwd,
          message: { role: "user", content: "future" },
        })}\n`,
      );
      const hidden = yield* discoverTeleportSessions({
        homes,
        cwd: projectCwd,
        providers: ["claudeAgent"],
      });
      assert.equal(hidden.sessions.length, 0);
      const listed = yield* discoverTeleportSessions({
        homes,
        cwd: projectCwd,
        extraCwds: [worktreeCwd],
        providers: ["claudeAgent"],
      });
      assert.equal(listed.sessions.length, 1);
      assert.equal(listed.sessions[0]?.cwd, worktreeCwd);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.merge(NodeServices.layer, TeleportFormatRegistry.layer)),
    ),
  );

  it.effect("reads a Claude session id from a Windows native path", () =>
    Effect.gen(function* () {
      const parsed = yield* parseClaudeSessionContents({
        nativePath: `C:\\Users\\Foo\\.claude\\projects\\proj\\${TELEPORT_TEST_SESSION_ID}.jsonl`,
        contents: `${JSON.stringify({
          type: "user",
          cwd: "C:\\Users\\Foo\\proj",
          timestamp: TELEPORT_TEST_CREATED_AT,
          message: { role: "user", content: [{ type: "text", text: "hello" }] },
        })}\n`,
      });
      assert.equal(parsed._tag, "Some");
      if (parsed._tag === "Some") {
        assert.equal(parsed.value.externalSessionId, TELEPORT_TEST_SESSION_ID);
      }
    }),
  );

  it("roundtrips Claude resume cursors", () => {
    assert.equal(
      readTeleportExternalSessionId({
        provider: ProviderDriverKind.make("claudeAgent"),
        resumeCursor: buildTeleportResumeCursor({
          provider: "claudeAgent",
          externalSessionId: TELEPORT_TEST_SESSION_ID,
          adapter: claudeTeleportFormat,
        }),
        runtimePayload: null,
        adapter: claudeTeleportFormat,
      }),
      TELEPORT_TEST_SESSION_ID,
    );
  });

  it.effect("refuses to replace a Claude session outside its configured home", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "teleport-claude-sandbox-" });
      const homes: TeleportHomes = {
        codexSessionsRoot: path.join(root, "codex", "sessions"),
        extraCodexSessionsRoots: [],
        claudeProjectsRoot: path.join(root, "claude", "projects"),
        extraClaudeProjectsRoots: [],
      };
      const outside = path.join(root, "outside.jsonl");
      const result = yield* claudeTeleportFormat
        .write({
          homes,
          session: sampleTeleportSession("claudeAgent"),
          existingNativePath: outside,
        })
        .pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure._tag, "TeleportNativeWriteError");
        if (result.failure._tag === "TeleportNativeWriteError") {
          assert.equal(result.failure.stage, "unsafe-native-path");
        }
      }
      assert.equal(yield* fs.exists(outside), false);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.merge(
          NodeServices.layer,
          ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)),
        ),
      ),
      Effect.provideService(HostProcessPlatform, "linux"),
    ),
  );
});
