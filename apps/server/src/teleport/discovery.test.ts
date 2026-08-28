import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { discoverTeleportSessions, loadTeleportSession } from "./discovery.ts";
import { serializeCodexSession } from "./formats/codex.ts";
import * as TeleportFormatRegistry from "./formats/registry.ts";
import type { TeleportHomes } from "./homes.ts";
import { sampleTeleportSession, TELEPORT_TEST_SESSION_ID } from "./testFixtures.ts";

function homesFor(root: string, path: Path.Path): TeleportHomes {
  return {
    codexSessionsRoot: path.join(root, "codex", "sessions"),
    extraCodexSessionsRoots: [],
    claudeProjectsRoot: path.join(root, "claude", "projects"),
    extraClaudeProjectsRoots: [],
  };
}

describe("teleport discovery", () => {
  it.effect("lists nothing when no native formats are registered", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "teleport-empty-registry-" });
      const listed = yield* discoverTeleportSessions({
        homes: homesFor(root, path),
        cwd: "/workspace",
      });
      assert.deepStrictEqual(listed.sessions, []);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.merge(
          NodeServices.layer,
          Layer.succeed(
            TeleportFormatRegistry.TeleportFormatRegistry,
            TeleportFormatRegistry.fromAdapters([]),
          ),
        ),
      ),
    ),
  );

  it.effect("registers Codex and Claude native formats", () =>
    Effect.gen(function* () {
      const formats = yield* TeleportFormatRegistry.TeleportFormatRegistry;
      assert.deepStrictEqual([...formats.providers].toSorted(), ["claudeAgent", "codex"]);
    }).pipe(Effect.provide(TeleportFormatRegistry.layer)),
  );

  it.effect("refuses a client nativePath outside the configured instance root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "teleport-path-sandbox-" });
      const homes = homesFor(root, path);
      const outsidePath = path.join(root, "outside.jsonl");
      yield* fs.writeFileString(outsidePath, serializeCodexSession(sampleTeleportSession("codex")));
      const result = yield* loadTeleportSession({
        homes,
        provider: "codex",
        externalSessionId: TELEPORT_TEST_SESSION_ID,
        cwd: "/workspace",
        nativePath: outsidePath,
      }).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.merge(NodeServices.layer, TeleportFormatRegistry.layer)),
    ),
  );

  it.effect("refuses a nativePath that symlink-escapes the instance root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "teleport-symlink-escape-" });
      const homes = homesFor(root, path);
      const outsidePath = path.join(root, "secret.jsonl");
      const insideLink = path.join(homes.codexSessionsRoot, "escape.jsonl");
      yield* fs.writeFileString(outsidePath, serializeCodexSession(sampleTeleportSession("codex")));
      yield* fs.makeDirectory(homes.codexSessionsRoot, { recursive: true });
      yield* fs.symlink(outsidePath, insideLink);
      const result = yield* loadTeleportSession({
        homes,
        provider: "codex",
        externalSessionId: TELEPORT_TEST_SESSION_ID,
        cwd: "/workspace",
        nativePath: insideLink,
      }).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.merge(NodeServices.layer, TeleportFormatRegistry.layer)),
    ),
  );

  it.effect("refuses a fabricated provider instance id even when the default root matches", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "teleport-fake-instance-" });
      const homes = homesFor(root, path);
      const nativePath = path.join(
        homes.codexSessionsRoot,
        "2026",
        "08",
        "14",
        `rollout-2026-08-14T06-00-00-${TELEPORT_TEST_SESSION_ID}.jsonl`,
      );
      yield* fs.makeDirectory(path.dirname(nativePath), { recursive: true });
      yield* fs.writeFileString(nativePath, serializeCodexSession(sampleTeleportSession("codex")));
      const result = yield* loadTeleportSession({
        homes,
        provider: "codex",
        externalSessionId: TELEPORT_TEST_SESSION_ID,
        cwd: "/workspace",
        providerInstanceId: ProviderInstanceId.make("codex_bogus"),
        nativePath,
      }).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.merge(NodeServices.layer, TeleportFormatRegistry.layer)),
    ),
  );

  it.effect("loads a worktree session when that worktree is an extra project cwd", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "teleport-worktree-load-" });
      const homes = homesFor(root, path);
      const worktreeCwd = path.join(root, "worktrees", "feature");
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
      const parsed = yield* loadTeleportSession({
        homes,
        provider: "codex",
        externalSessionId: TELEPORT_TEST_SESSION_ID,
        cwd: path.join(root, "project"),
        extraCwds: [worktreeCwd],
        nativePath,
      });
      assert.equal(parsed.cwd, worktreeCwd);
      const listed = yield* loadTeleportSession({
        homes,
        provider: "codex",
        externalSessionId: TELEPORT_TEST_SESSION_ID,
        cwd: path.join(root, "project"),
        extraCwds: [worktreeCwd],
      });
      assert.equal(listed.nativePath, nativePath);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.merge(NodeServices.layer, TeleportFormatRegistry.layer)),
    ),
  );

  it.effect("refuses a native session whose cwd is an ancestor of the project", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "teleport-ancestor-cwd-" });
      const homes = homesFor(root, path);
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
        serializeCodexSession(sampleTeleportSession("codex", "/")),
      );
      const result = yield* loadTeleportSession({
        homes,
        provider: "codex",
        externalSessionId: TELEPORT_TEST_SESSION_ID,
        cwd: path.join(root, "project"),
        nativePath,
      }).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.merge(NodeServices.layer, TeleportFormatRegistry.layer)),
    ),
  );
});
