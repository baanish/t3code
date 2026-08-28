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
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import * as ProcessRunner from "../../processRunner.ts";
import { discoverTeleportSessions, loadTeleportSession } from "../discovery.ts";
import type { TeleportHomes } from "../homes.ts";
import { buildTeleportResumeCursor, readTeleportExternalSessionId } from "../resumeCursors.ts";
import * as TeleportFormatRegistry from "./registry.ts";
import {
  sampleTeleportSession,
  TELEPORT_TEST_CREATED_AT,
  TELEPORT_TEST_SESSION_ID,
} from "../testFixtures.ts";
import {
  allocateCodexSessionPath,
  codexTeleportFormat,
  parseCodexSessionContents,
  serializeCodexSession,
} from "./codex.ts";

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

  it("allocates a rollout filename Codex can discover", () => {
    assert.equal(
      allocateCodexSessionPath({
        sessionsRoot: "/tmp/sessions",
        sessionId: TELEPORT_TEST_SESSION_ID,
        createdAt: TELEPORT_TEST_CREATED_AT,
        join: (...parts) => parts.join("/"),
      }),
      `/tmp/sessions/2026/08/14/rollout-2026-08-14T06-00-00-${TELEPORT_TEST_SESSION_ID}.jsonl`,
    );
  });

  it.effect("keeps assistant text that starts with a synthetic user wrapper", () =>
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
          content: [{ type: "input_text", text: "KEEP_NAT_CODEX_U1_CEDAR: add a --json flag" }],
        },
      })}\n${JSON.stringify({
        timestamp: TELEPORT_TEST_CREATED_AT,
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "<environment_context>\nThis is a real assistant reply about wrappers.",
            },
          ],
        },
      })}\n`;
      const parsed = yield* parseCodexSessionContents({
        contents,
        nativePath: "/tmp/codex-assistant-env.jsonl",
      });
      assert.equal(Option.isSome(parsed), true);
      if (Option.isSome(parsed)) {
        assert.equal(parsed.value.messages.length, 2);
        assert.equal(parsed.value.messages[0]?.role, "user");
        assert.equal(parsed.value.messages[1]?.role, "assistant");
        assert.equal(
          parsed.value.messages[1]?.text,
          "<environment_context>\nThis is a real assistant reply about wrappers.",
        );
      }
    }),
  );

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

  it.effect("skips Codex subagent sessions with parent_thread_id", () =>
    Effect.gen(function* () {
      const contents = `${JSON.stringify({
        timestamp: TELEPORT_TEST_CREATED_AT,
        type: "session_meta",
        payload: {
          id: TELEPORT_TEST_SESSION_ID,
          cwd: "/workspace",
          parent_thread_id: "parent-session",
        },
      })}\n`;
      const parsed = yield* parseCodexSessionContents({
        contents,
        nativePath: "/tmp/subagent.jsonl",
      });
      assert.equal(Option.isNone(parsed), true);
    }),
  );

  it.effect("uses the first Codex session_meta identity and cwd", () =>
    Effect.gen(function* () {
      const contents = [
        {
          timestamp: TELEPORT_TEST_CREATED_AT,
          type: "session_meta",
          payload: { id: TELEPORT_TEST_SESSION_ID, cwd: "/workspace" },
        },
        {
          timestamp: TELEPORT_TEST_CREATED_AT,
          type: "turn_context",
          payload: { cwd: "/" },
        },
        {
          timestamp: TELEPORT_TEST_CREATED_AT,
          type: "session_meta",
          payload: {
            id: "22222222-2222-4222-8222-222222222222",
            cwd: "/other-project",
            parent_thread_id: "poison",
          },
        },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n");
      const parsed = yield* parseCodexSessionContents({
        contents,
        nativePath: "/tmp/first-meta.jsonl",
      });
      assert.equal(Option.isSome(parsed), true);
      if (Option.isSome(parsed)) {
        assert.equal(parsed.value.externalSessionId, TELEPORT_TEST_SESSION_ID);
        assert.equal(parsed.value.cwd, "/workspace");
      }
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
          adapter: codexTeleportFormat,
        }),
        runtimePayload: null,
        adapter: codexTeleportFormat,
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
      yield* fs.writeFileString(
        path.join(path.dirname(codexPath), "future.jsonl"),
        `${JSON.stringify({
          type: "session_meta",
          nativeFormatVersion: TELEPORT_NATIVE_FORMAT_VERSION + 1,
          payload: {
            id: "22222222-2222-4222-8222-222222222222",
            cwd: "/workspace",
          },
        })}\n`,
      );
      const listed = yield* discoverTeleportSessions({
        homes,
        cwd: "/workspace",
      });
      assert.equal(listed.sessions.length, 1);
      assert.equal(listed.sessions[0]?.provider, "codex");
      assert.equal(listed.sessions[0]?.externalSessionId, TELEPORT_TEST_SESSION_ID);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.merge(NodeServices.layer, TeleportFormatRegistry.layer)),
    ),
  );

  it.effect("lists only the newest immutable Codex rollout for a thread", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "teleport-codex-rollouts-" });
      const homes: TeleportHomes = {
        codexSessionsRoot: path.join(root, "codex", "sessions"),
        extraCodexSessionsRoots: [],
        claudeProjectsRoot: path.join(root, "claude", "projects"),
        extraClaudeProjectsRoots: [],
      };
      const oldPath = path.join(
        homes.codexSessionsRoot,
        "2026",
        "08",
        "14",
        `rollout-2026-08-14T06-00-00-${TELEPORT_TEST_SESSION_ID}.jsonl`,
      );
      const newPath = path.join(
        homes.codexSessionsRoot,
        "2026",
        "08",
        "15",
        `rollout-2026-08-15T06-00-00-${TELEPORT_TEST_SESSION_ID}_22222222-2222-4222-8222-222222222222.jsonl`,
      );
      yield* fs.makeDirectory(path.dirname(oldPath), { recursive: true });
      yield* fs.makeDirectory(path.dirname(newPath), { recursive: true });
      yield* fs.writeFileString(oldPath, serializeCodexSession(sampleTeleportSession("codex")));
      yield* fs.writeFileString(
        newPath,
        serializeCodexSession({
          ...sampleTeleportSession("codex"),
          createdAt: "2026-08-15T06:00:00.000Z",
          messages: [
            {
              role: "user",
              text: "new rollout",
              createdAt: "2026-08-15T06:01:00.000Z",
            },
          ],
        }),
      );

      const listed = yield* discoverTeleportSessions({
        homes,
        cwd: "/workspace",
        providers: ["codex"],
      });
      assert.equal(listed.sessions.length, 1);
      assert.equal(listed.sessions[0]?.nativePath, newPath);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.merge(NodeServices.layer, TeleportFormatRegistry.layer)),
    ),
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
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.merge(NodeServices.layer, TeleportFormatRegistry.layer)),
    ),
  );

  it.effect("lists Codex sessions from a project worktree cwd", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "teleport-codex-worktree-" });
      const homes: TeleportHomes = {
        codexSessionsRoot: path.join(root, "codex", "sessions"),
        extraCodexSessionsRoots: [],
        claudeProjectsRoot: path.join(root, "claude", "projects"),
        extraClaudeProjectsRoots: [],
      };
      const worktreeCwd = path.join(root, "worktrees", "feature");
      const projectCwd = path.join(root, "project");
      const nativePath = path.join(
        homes.codexSessionsRoot,
        "2026",
        "08",
        "14",
        `rollout-2026-08-14T06-00-00-${TELEPORT_TEST_SESSION_ID}.jsonl`,
      );
      yield* fs.makeDirectory(path.dirname(nativePath), { recursive: true });
      yield* fs.writeFileString(
        nativePath,
        serializeCodexSession(sampleTeleportSession("codex", worktreeCwd)),
      );
      const hidden = yield* discoverTeleportSessions({
        homes,
        cwd: projectCwd,
        providers: ["codex"],
      });
      assert.equal(hidden.sessions.length, 0);
      const listed = yield* discoverTeleportSessions({
        homes,
        cwd: projectCwd,
        extraCwds: [worktreeCwd],
        providers: ["codex"],
      });
      assert.equal(listed.sessions.length, 1);
      assert.equal(listed.sessions[0]?.cwd, worktreeCwd);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.merge(NodeServices.layer, TeleportFormatRegistry.layer)),
    ),
  );

  it.effect("lists Codex sessions started in a project subdirectory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "teleport-codex-subdir-" });
      const homes: TeleportHomes = {
        codexSessionsRoot: path.join(root, "codex", "sessions"),
        extraCodexSessionsRoots: [],
        claudeProjectsRoot: path.join(root, "claude", "projects"),
        extraClaudeProjectsRoots: [],
      };
      const projectCwd = path.join(root, "project");
      const nestedCwd = path.join(projectCwd, "packages", "app");
      const nativePath = path.join(
        homes.codexSessionsRoot,
        "2026",
        "08",
        "14",
        `rollout-2026-08-14T06-00-00-${TELEPORT_TEST_SESSION_ID}.jsonl`,
      );
      yield* fs.makeDirectory(path.dirname(nativePath), { recursive: true });
      yield* fs.writeFileString(
        nativePath,
        serializeCodexSession(sampleTeleportSession("codex", nestedCwd)),
      );
      const listed = yield* discoverTeleportSessions({
        homes,
        cwd: projectCwd,
        providers: ["codex"],
      });
      assert.equal(listed.sessions.length, 1);
      assert.equal(listed.sessions[0]?.cwd, nestedCwd);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.merge(NodeServices.layer, TeleportFormatRegistry.layer)),
    ),
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
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.merge(NodeServices.layer, TeleportFormatRegistry.layer)),
    ),
  );

  it.effect("loads a shared-home custom instance from the default listing label", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "teleport-codex-shared-home-" });
      const sharedRoot = path.join(root, "codex", "sessions");
      const homes: TeleportHomes = {
        codexSessionsRoot: sharedRoot,
        extraCodexSessionsRoots: [
          {
            root: sharedRoot,
            instanceId: ProviderInstanceId.make("codex_work"),
          },
        ],
        claudeProjectsRoot: path.join(root, "claude", "projects"),
        extraClaudeProjectsRoots: [],
      };
      const nativePath = path.join(
        sharedRoot,
        "2026",
        "08",
        "14",
        `rollout-2026-08-14T06-00-00-${TELEPORT_TEST_SESSION_ID}.jsonl`,
      );
      yield* fs.makeDirectory(path.dirname(nativePath), { recursive: true });
      yield* fs.writeFileString(nativePath, serializeCodexSession(sampleTeleportSession("codex")));
      const parsed = yield* loadTeleportSession({
        homes,
        provider: "codex",
        externalSessionId: TELEPORT_TEST_SESSION_ID,
        cwd: "/workspace",
        providerInstanceId: ProviderInstanceId.make("codex_work"),
      });
      assert.equal(parsed.nativePath, nativePath);
      assert.equal(parsed.providerInstanceId, "codex_work");
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.merge(NodeServices.layer, TeleportFormatRegistry.layer)),
    ),
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
      };
      const adapter = codexTeleportFormat;
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
      Effect.provide(
        Layer.merge(
          NodeServices.layer,
          Layer.merge(
            TeleportFormatRegistry.layer,
            ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)),
          ),
        ),
      ),
      Effect.provideService(HostProcessPlatform, "linux"),
    ),
  );

  it.effect("refuses to replace a Codex session outside its configured home", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "teleport-codex-sandbox-" });
      const homes: TeleportHomes = {
        codexSessionsRoot: path.join(root, "codex", "sessions"),
        extraCodexSessionsRoots: [],
        claudeProjectsRoot: path.join(root, "claude", "projects"),
        extraClaudeProjectsRoots: [],
      };
      const outside = path.join(root, "outside.jsonl");
      const result = yield* codexTeleportFormat
        .write({
          homes,
          session: sampleTeleportSession("codex"),
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
