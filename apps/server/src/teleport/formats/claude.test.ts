// Native session fixtures are JSON/JSONL records, not Effect schemas.
// @effect-diagnostics preferSchemaOverJson:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, TELEPORT_NATIVE_FORMAT_VERSION } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

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
} from "./claude.ts";

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

  it.effect("reads a Claude session id from a Windows native path", () =>
    Effect.gen(function* () {
      const parsed = yield* parseClaudeSessionContents({
        nativePath: "C:\\Users\\Foo\\.claude\\projects\\proj\\abc-session.jsonl",
        contents: `${JSON.stringify({
          type: "user",
          cwd: "C:\\Users\\Foo\\proj",
          timestamp: TELEPORT_TEST_CREATED_AT,
          message: { role: "user", content: [{ type: "text", text: "hello" }] },
        })}\n`,
      });
      assert.equal(parsed._tag, "Some");
      if (parsed._tag === "Some") {
        assert.equal(parsed.value.externalSessionId, "abc-session");
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
        }),
        runtimePayload: null,
      }),
      TELEPORT_TEST_SESSION_ID,
    );
  });
});
