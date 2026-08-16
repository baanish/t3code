// Native session fixtures are JSON/JSONL records, not Effect schemas.
// @effect-diagnostics preferSchemaOverJson:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  TELEPORT_NATIVE_FORMAT_VERSION,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import { discoverTeleportSessions, loadTeleportSession } from "../discovery.ts";
import type { TeleportHomes } from "../homes.ts";
import { buildTeleportResumeCursor, readTeleportExternalSessionId } from "../resumeCursors.ts";
import { getTeleportFormat } from "./registry.ts";
import {
  sampleTeleportSession,
  TELEPORT_TEST_CREATED_AT,
  TELEPORT_TEST_SESSION_ID,
} from "../testFixtures.ts";
import { parseCodexSessionContents, serializeCodexSession } from "./codex.ts";

describe("teleport Codex format", () => {
  it.effect("roundtrips Codex jsonl", () =>
    Effect.gen(function* () {
      const session = sampleTeleportSession("codex");
      const parsed = yield* parseCodexSessionContents({
        contents: serializeCodexSession(session),
        nativePath: session.nativePath,
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
    }),
  );

  it("writes Codex session_meta the CLI can resume", () => {
    const contents = serializeCodexSession(sampleTeleportSession("codex"));
    const firstLine = contents.split("\n")[0] ?? "";
    const event = JSON.parse(firstLine) as {
      type?: unknown;
      ordinal?: unknown;
      nativeFormatVersion?: unknown;
      payload?: {
        id?: unknown;
        session_id?: unknown;
        cwd?: unknown;
        originator?: unknown;
        cli_version?: unknown;
        source?: unknown;
      };
    };
    assert.equal(event.type, "session_meta");
    assert.equal(event.ordinal, 0);
    assert.equal(event.nativeFormatVersion, undefined);
    assert.equal(event.payload?.id, TELEPORT_TEST_SESSION_ID);
    assert.equal(event.payload?.session_id, TELEPORT_TEST_SESSION_ID);
    assert.equal(event.payload?.cwd, "/workspace");
    assert.equal(typeof event.payload?.cli_version, "string");
    assert.notEqual(event.payload?.cli_version, "");
    assert.equal(event.payload?.originator, "t3-teleport");
    assert.equal(event.payload?.source, "cli");
  });

  it.effect("skips Codex environment_context user wrappers", () =>
    Effect.gen(function* () {
      const contents = `${JSON.stringify({
        timestamp: TELEPORT_TEST_CREATED_AT,
        type: "session_meta",
        payload: { id: TELEPORT_TEST_SESSION_ID, cwd: "/workspace" },
      })}\n${JSON.stringify({
        timestamp: TELEPORT_TEST_CREATED_AT,
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "<environment_context>\n  <cwd>/workspace</cwd>\n" },
          ],
        },
      })}\n${JSON.stringify({
        timestamp: TELEPORT_TEST_CREATED_AT,
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

  it.effect("preserves leading and trailing whitespace in Codex message text", () =>
    Effect.gen(function* () {
      const contents = `${JSON.stringify({
        timestamp: TELEPORT_TEST_CREATED_AT,
        type: "session_meta",
        payload: { id: TELEPORT_TEST_SESSION_ID, cwd: "/workspace" },
      })}\n${JSON.stringify({
        timestamp: TELEPORT_TEST_CREATED_AT,
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "  keep indent  \n" }],
        },
      })}\n`;
      const parsed = yield* parseCodexSessionContents({
        contents,
        nativePath: "/tmp/codex-whitespace.jsonl",
      });
      assert.equal(Option.isSome(parsed), true);
      if (Option.isSome(parsed)) {
        assert.equal(parsed.value.messages[0]?.text, "  keep indent  \n");
      }
    }),
  );

  it.effect("skips forked Codex sessions", () =>
    Effect.gen(function* () {
      const contents = `${JSON.stringify({
        timestamp: TELEPORT_TEST_CREATED_AT,
        type: "session_meta",
        payload: {
          id: TELEPORT_TEST_SESSION_ID,
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
        timestamp: TELEPORT_TEST_CREATED_AT,
        type: "session_meta",
        nativeFormatVersion: TELEPORT_NATIVE_FORMAT_VERSION + 1,
        payload: { id: TELEPORT_TEST_SESSION_ID, cwd: "/workspace" },
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

  it("roundtrips Codex resume cursors", () => {
    assert.equal(
      readTeleportExternalSessionId({
        provider: ProviderDriverKind.make("codex"),
        resumeCursor: buildTeleportResumeCursor({
          provider: "codex",
          externalSessionId: TELEPORT_TEST_SESSION_ID,
        }),
        runtimePayload: null,
      }),
      TELEPORT_TEST_SESSION_ID,
    );
  });

  it.effect("lists matching Codex sessions and skips unreadable files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "teleport-codex-homes-" });
      const homes: TeleportHomes = {
        codexSessionsRoot: path.join(root, "codex", "sessions"),
        extraCodexSessionsRoots: [],
        claudeProjectsRoot: path.join(root, "claude", "projects"),
        extraClaudeProjectsRoots: [],
        opencodeRoot: path.join(root, "opencode"),
        grokSessionsRoot: path.join(root, "grok", "sessions"),
      };
      const codexPath = path.join(
        homes.codexSessionsRoot,
        "2026",
        "08",
        "14",
        `rollout-2026-08-14T06-00-00-${TELEPORT_TEST_SESSION_ID}.jsonl`,
      );
      yield* fs.makeDirectory(path.dirname(codexPath), { recursive: true });
      yield* fs.writeFileString(codexPath, serializeCodexSession(sampleTeleportSession("codex")));
      yield* fs.writeFileString(path.join(path.dirname(codexPath), "garbage.jsonl"), "not-json\n");
      const listed = yield* discoverTeleportSessions({
        homes,
        cwd: "/workspace",
      });
      assert.equal(listed.sessions.length, 1);
      assert.equal(listed.sessions[0]?.provider, "codex");
      assert.equal(listed.sessions[0]?.externalSessionId, TELEPORT_TEST_SESSION_ID);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("lists Codex sessions from extra instance homePaths", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "teleport-codex-extra-" });
      const workSessionId = "22222222-2222-4222-8222-222222222222";
      const extraRoot = path.join(root, "codex-work", "sessions");
      const homes: TeleportHomes = {
        codexSessionsRoot: path.join(root, "codex", "sessions"),
        extraCodexSessionsRoots: [
          {
            root: extraRoot,
            instanceId: ProviderInstanceId.make("codex_work"),
          },
        ],
        claudeProjectsRoot: path.join(root, "claude", "projects"),
        extraClaudeProjectsRoots: [],
        opencodeRoot: path.join(root, "opencode"),
        grokSessionsRoot: path.join(root, "grok", "sessions"),
      };
      const extraPath = path.join(
        extraRoot,
        "2026",
        "08",
        "14",
        `rollout-2026-08-14T06-00-00-${workSessionId}.jsonl`,
      );
      yield* fs.makeDirectory(path.dirname(extraPath), { recursive: true });
      yield* fs.writeFileString(
        extraPath,
        serializeCodexSession({
          ...sampleTeleportSession("codex"),
          externalSessionId: workSessionId,
        }),
      );
      const listed = yield* discoverTeleportSessions({
        homes,
        cwd: "/workspace",
        providers: ["codex"],
      });
      assert.equal(listed.sessions.length, 1);
      assert.equal(listed.sessions[0]?.externalSessionId, workSessionId);
      assert.equal(listed.sessions[0]?.providerInstanceId, "codex_work");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("loads the Codex session for the requested instance when ids collide", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "teleport-codex-collide-" });
      const extraRoot = path.join(root, "codex-work", "sessions");
      const defaultRoot = path.join(root, "codex", "sessions");
      const homes: TeleportHomes = {
        codexSessionsRoot: defaultRoot,
        extraCodexSessionsRoots: [
          {
            root: extraRoot,
            instanceId: ProviderInstanceId.make("codex_work"),
          },
        ],
        claudeProjectsRoot: path.join(root, "claude", "projects"),
        extraClaudeProjectsRoots: [],
        opencodeRoot: path.join(root, "opencode"),
        grokSessionsRoot: path.join(root, "grok", "sessions"),
      };
      const defaultPath = path.join(
        defaultRoot,
        "2026",
        "08",
        "14",
        `rollout-2026-08-14T06-00-00-${TELEPORT_TEST_SESSION_ID}.jsonl`,
      );
      const extraPath = path.join(
        extraRoot,
        "2026",
        "08",
        "14",
        `rollout-2026-08-14T06-00-00-${TELEPORT_TEST_SESSION_ID}.jsonl`,
      );
      const defaultSession = sampleTeleportSession("codex");
      const workSession = {
        ...sampleTeleportSession("codex"),
        messages: [
          {
            role: "user" as const,
            text: "Fix the flaky matcher",
            createdAt: TELEPORT_TEST_CREATED_AT,
            id: "user-1",
          },
          {
            role: "assistant" as const,
            text: "Work instance transcript",
            createdAt: "2026-08-14T06:01:00.000Z",
            id: "assistant-work",
          },
        ],
      };
      yield* fs.makeDirectory(path.dirname(defaultPath), { recursive: true });
      yield* fs.makeDirectory(path.dirname(extraPath), { recursive: true });
      yield* fs.writeFileString(defaultPath, serializeCodexSession(defaultSession));
      yield* fs.writeFileString(extraPath, serializeCodexSession(workSession));
      const parsed = yield* loadTeleportSession({
        homes,
        provider: "codex",
        externalSessionId: TELEPORT_TEST_SESSION_ID,
        cwd: "/workspace",
        providerInstanceId: ProviderInstanceId.make("codex_work"),
      });
      assert.equal(parsed.nativePath, extraPath);
      assert.equal(parsed.providerInstanceId, "codex_work");
      assert.equal(parsed.messages[1]?.text, "Work instance transcript");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("writes a new Codex session under the selected instance home", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "teleport-codex-write-" });
      const extraRoot = path.join(root, "codex-work", "sessions");
      const defaultRoot = path.join(root, "codex", "sessions");
      const homes: TeleportHomes = {
        codexSessionsRoot: defaultRoot,
        extraCodexSessionsRoots: [
          {
            root: extraRoot,
            instanceId: ProviderInstanceId.make("codex_work"),
          },
        ],
        claudeProjectsRoot: path.join(root, "claude", "projects"),
        extraClaudeProjectsRoots: [],
        opencodeRoot: path.join(root, "opencode"),
        grokSessionsRoot: path.join(root, "grok", "sessions"),
      };
      const adapter = getTeleportFormat("codex");
      assert.ok(adapter);
      const nativePath = yield* adapter.write({
        homes,
        session: {
          ...sampleTeleportSession("codex"),
          providerInstanceId: ProviderInstanceId.make("codex_work"),
        },
      });
      assert.equal(nativePath.startsWith(`${extraRoot}${path.sep}`), true);
      assert.equal(nativePath.startsWith(`${defaultRoot}${path.sep}`), false);
      assert.equal(yield* fs.exists(nativePath), true);
    }).pipe(
      Effect.scoped,
      Effect.provide(NodeServices.layer),
      Effect.provideService(HostProcessPlatform, "linux"),
    ),
  );
});
