import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverTeleportSessions, loadTeleportSession } from "./discovery.ts";
import { serializeCodexSession } from "./formats/codex.ts";
import {
  getTeleportFormat,
  listRegisteredTeleportProviders,
  registerTeleportFormat,
  resetTeleportFormats,
} from "./formats/registry.ts";
import type { TeleportHomes } from "./homes.ts";
import { sampleTeleportSession, TELEPORT_TEST_SESSION_ID } from "./testFixtures.ts";

function homesFor(root: string, path: Path.Path): TeleportHomes {
  return {
    codexSessionsRoot: path.join(root, "codex", "sessions"),
    extraCodexSessionsRoots: [],
    claudeProjectsRoot: path.join(root, "claude", "projects"),
    extraClaudeProjectsRoots: [],
    opencodeRoot: path.join(root, "opencode"),
    grokSessionsRoot: path.join(root, "grok", "sessions"),
  };
}

describe("teleport discovery", () => {
  it.effect("lists nothing when no native formats are registered", () =>
    Effect.gen(function* () {
      const snapshot = listRegisteredTeleportProviders()
        .map((provider) => getTeleportFormat(provider))
        .filter((adapter) => adapter !== undefined);
      resetTeleportFormats();
      try {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "teleport-empty-registry-" });
        const listed = yield* discoverTeleportSessions({
          homes: homesFor(root, path),
          cwd: "/workspace",
        });
        assert.deepStrictEqual(listed.sessions, []);
      } finally {
        for (const adapter of snapshot) {
          registerTeleportFormat(adapter);
        }
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
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
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
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
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
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
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
