// Native session fixtures are JSON/JSONL records, not Effect schemas.
// @effect-diagnostics preferSchemaOverJson:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, TELEPORT_NATIVE_FORMAT_VERSION } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { discoverTeleportSessions } from "../discovery.ts";
import type { TeleportHomes } from "../homes.ts";
import { buildTeleportResumeCursor, readTeleportExternalSessionId } from "../resumeCursors.ts";
import { sampleTeleportSession, TELEPORT_TEST_SESSION_ID } from "../testFixtures.ts";
import {
  encodeGrokCwdGroup,
  parseGrokSessionDirectory,
  requireGrokSessionUnlocked,
  writeGrokSession,
} from "./grok.ts";

describe("teleport Grok format", () => {
  it.effect("roundtrips Grok session directories", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "teleport-grok-" });
      const session = sampleTeleportSession("grok", "/workspace");
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
        assert.equal(parsed.value.externalSessionId, TELEPORT_TEST_SESSION_ID);
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
          info: { id: TELEPORT_TEST_SESSION_ID, cwd: "/workspace" },
          chat_format_version: 1,
        }),
        updatesContents: `${JSON.stringify({
          timestamp: 1_782_000_000,
          method: "session/update",
          params: {
            sessionId: TELEPORT_TEST_SESSION_ID,
            update: {
              sessionUpdate: "user_message_chunk",
              content: { type: "text", text: "Hello " },
            },
          },
        })}\n${JSON.stringify({
          timestamp: 1_782_000_001,
          method: "session/update",
          params: {
            sessionId: TELEPORT_TEST_SESSION_ID,
            update: {
              sessionUpdate: "user_message_chunk",
              content: { type: "text", text: "world" },
            },
          },
        })}\n${JSON.stringify({
          timestamp: 1_782_000_002,
          method: "session/update",
          params: {
            sessionId: TELEPORT_TEST_SESSION_ID,
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
          info: { id: TELEPORT_TEST_SESSION_ID, cwd: "/workspace" },
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
          info: { id: TELEPORT_TEST_SESSION_ID, cwd: "/workspace" },
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
        session: sampleTeleportSession("grok"),
      });
      yield* requireGrokSessionUnlocked(nativePath);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
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

  it("roundtrips Grok resume cursors", () => {
    assert.equal(
      readTeleportExternalSessionId({
        provider: ProviderDriverKind.make("grok"),
        resumeCursor: buildTeleportResumeCursor({
          provider: "grok",
          externalSessionId: TELEPORT_TEST_SESSION_ID,
        }),
        runtimePayload: null,
      }),
      TELEPORT_TEST_SESSION_ID,
    );
  });

  it.effect("lists matching Grok sessions and skips other project cwds", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "teleport-grok-homes-" });
      const homes: TeleportHomes = {
        codexSessionsRoot: path.join(root, "codex", "sessions"),
        extraCodexSessionsRoots: [],
        claudeProjectsRoot: path.join(root, "claude", "projects"),
        extraClaudeProjectsRoots: [],
        opencodeRoot: path.join(root, "opencode"),
        grokSessionsRoot: path.join(root, "grok", "sessions"),
      };
      yield* writeGrokSession({
        sessionsRoot: homes.grokSessionsRoot,
        session: sampleTeleportSession("grok"),
      });
      yield* writeGrokSession({
        sessionsRoot: homes.grokSessionsRoot,
        session: sampleTeleportSession("grok", "/other-project"),
      });
      const listed = yield* discoverTeleportSessions({
        homes,
        cwd: "/workspace",
        providers: ["grok"],
      });
      assert.equal(listed.sessions.length, 1);
      assert.equal(listed.sessions[0]?.provider, "grok");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("fails the whole list when a Grok session is a newer schema", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "teleport-grok-newer-" });
      const homes: TeleportHomes = {
        codexSessionsRoot: path.join(root, "codex", "sessions"),
        extraCodexSessionsRoots: [],
        claudeProjectsRoot: path.join(root, "claude", "projects"),
        extraClaudeProjectsRoots: [],
        opencodeRoot: path.join(root, "opencode"),
        grokSessionsRoot: path.join(root, "grok", "sessions"),
      };
      const grokPath = path.join(homes.grokSessionsRoot, "%2Fworkspace", TELEPORT_TEST_SESSION_ID);
      yield* fs.makeDirectory(grokPath, { recursive: true });
      yield* fs.writeFileString(
        path.join(grokPath, "summary.json"),
        JSON.stringify({
          info: { id: TELEPORT_TEST_SESSION_ID, cwd: "/workspace" },
          chat_format_version: TELEPORT_NATIVE_FORMAT_VERSION + 1,
        }),
      );
      yield* fs.writeFileString(path.join(grokPath, "updates.jsonl"), "");
      const result = yield* discoverTeleportSessions({
        homes,
        cwd: "/workspace",
        providers: ["grok"],
      }).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
