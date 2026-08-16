import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId, ServerSettings } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { resolveTeleportHomes } from "./homes.ts";

const decodeServerSettings = Schema.decodeSync(ServerSettings);

describe("resolveTeleportHomes", () => {
  it.effect("includes extra Codex instance homes that use a custom homePath", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "teleport-homes-" });
      const defaultHome = path.join(root, "codex-default");
      const workHome = path.join(root, "codex-work");
      const homes = yield* resolveTeleportHomes(
        decodeServerSettings({
          providers: {
            codex: { homePath: defaultHome },
          },
          providerInstances: {
            [ProviderInstanceId.make("codex_work")]: {
              driver: "codex",
              config: { homePath: workHome },
            },
          },
        }),
      );

      assert.equal(homes.codexSessionsRoot, path.join(defaultHome, "sessions"));
      assert.equal(homes.extraCodexSessionsRoots.length, 1);
      assert.equal(homes.extraCodexSessionsRoots[0]?.instanceId, "codex_work");
      assert.equal(homes.extraCodexSessionsRoots[0]?.root, path.join(workHome, "sessions"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("does not duplicate Codex homes that resolve to the same sessions root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "teleport-homes-dup-" });
      const sharedHome = path.join(root, "codex-shared");
      const homes = yield* resolveTeleportHomes(
        decodeServerSettings({
          providers: {
            codex: { homePath: sharedHome },
          },
          providerInstances: {
            [ProviderInstanceId.make("codex_work")]: {
              driver: "codex",
              config: { homePath: sharedHome },
            },
          },
        }),
      );

      assert.equal(homes.codexSessionsRoot, path.join(sharedHome, "sessions"));
      assert.deepStrictEqual(homes.extraCodexSessionsRoots, []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("includes extra Claude instance homes that use a custom homePath", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "teleport-claude-homes-" });
      const defaultHome = path.join(root, "claude-default");
      const workHome = path.join(root, "claude-work");
      yield* fs.makeDirectory(path.join(workHome, ".claude", "projects"), { recursive: true });
      const homes = yield* resolveTeleportHomes(
        decodeServerSettings({
          providers: {
            claudeAgent: { homePath: defaultHome },
          },
          providerInstances: {
            [ProviderInstanceId.make("claude_work")]: {
              driver: "claudeAgent",
              config: { homePath: workHome },
            },
          },
        }),
      );

      assert.equal(homes.claudeProjectsRoot, path.join(defaultHome, "projects"));
      assert.equal(homes.extraClaudeProjectsRoots.length, 1);
      assert.equal(homes.extraClaudeProjectsRoots[0]?.instanceId, "claude_work");
      assert.equal(
        homes.extraClaudeProjectsRoots[0]?.root,
        path.join(workHome, ".claude", "projects"),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
