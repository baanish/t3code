import * as NodeOS from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId, ServerSettings } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  resolveClaudeProjectsRootForInstance,
  resolveCodexSessionsRoot,
  resolveTeleportHomes,
  codexSearchRoots,
} from "./homes.ts";

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
      assert.equal(
        resolveCodexSessionsRoot(homes, ProviderInstanceId.make("codex_work")),
        path.join(workHome, "sessions"),
      );
      assert.equal(
        resolveCodexSessionsRoot(homes, ProviderInstanceId.make("codex")),
        path.join(defaultHome, "sessions"),
      );
      assert.equal(
        resolveCodexSessionsRoot(homes, ProviderInstanceId.make("codex_missing")),
        undefined,
      );
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
      assert.equal(homes.extraCodexSessionsRoots.length, 1);
      assert.equal(homes.extraCodexSessionsRoots[0]?.instanceId, "codex_work");
      assert.equal(homes.extraCodexSessionsRoots[0]?.root, path.join(sharedHome, "sessions"));
      assert.equal(
        resolveCodexSessionsRoot(homes, ProviderInstanceId.make("codex_work")),
        path.join(sharedHome, "sessions"),
      );
      assert.equal(codexSearchRoots(homes).length, 1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("includes extra Claude instance homes that use a custom homePath", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "teleport-claude-homes-" });
      const defaultHome = path.join(root, "claude-default");
      const workHome = path.join(root, "claude-work");
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
      assert.equal(homes.extraClaudeProjectsRoots[0]?.root, path.join(workHome, "projects"));
      assert.equal(
        resolveClaudeProjectsRootForInstance(homes, ProviderInstanceId.make("claude_work")),
        path.join(workHome, "projects"),
      );
      assert.equal(
        resolveClaudeProjectsRootForInstance(homes, ProviderInstanceId.make("claudeAgent")),
        path.join(defaultHome, "projects"),
      );
      assert.equal(
        resolveClaudeProjectsRootForInstance(homes, ProviderInstanceId.make("claude_missing")),
        undefined,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("uses the native Claude config root regardless of directory existence", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const homes = yield* resolveTeleportHomes(
        decodeServerSettings({
          providers: {
            claudeAgent: { homePath: "" },
          },
        }),
      );
      assert.equal(homes.claudeProjectsRoot, path.join(NodeOS.homedir(), ".claude", "projects"));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("treats an explicit Claude homePath as CLAUDE_CONFIG_DIR", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "teleport-claude-config-" });
      yield* fs.makeDirectory(path.join(root, ".claude", "projects"), { recursive: true });
      yield* fs.makeDirectory(path.join(root, "projects"), { recursive: true });
      const homes = yield* resolveTeleportHomes(
        decodeServerSettings({
          providers: {
            claudeAgent: { homePath: root },
          },
        }),
      );
      assert.equal(homes.claudeProjectsRoot, path.join(root, "projects"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("does not inherit legacy homePath from an explicit default-instance envelope", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "teleport-homes-envelope-" });
      const legacyHome = path.join(root, "codex-legacy");
      const homes = yield* resolveTeleportHomes(
        decodeServerSettings({
          providers: {
            codex: { homePath: legacyHome },
          },
          providerInstances: {
            [ProviderInstanceId.make("codex")]: {
              driver: "codex",
              config: {},
            },
          },
        }),
      );

      assert.equal(homes.codexSessionsRoot, path.join(NodeOS.homedir(), ".codex", "sessions"));
      assert.notEqual(homes.codexSessionsRoot, path.join(legacyHome, "sessions"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("uses the provider default home when an extra instance sets an empty homePath", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "teleport-homes-empty-" });
      const defaultHome = path.join(root, "codex-default");
      const homes = yield* resolveTeleportHomes(
        decodeServerSettings({
          providers: {
            codex: { homePath: defaultHome },
          },
          providerInstances: {
            [ProviderInstanceId.make("codex_work")]: {
              driver: "codex",
              config: { homePath: "" },
            },
          },
        }),
      );

      assert.equal(homes.codexSessionsRoot, path.join(defaultHome, "sessions"));
      assert.equal(homes.extraCodexSessionsRoots.length, 1);
      assert.equal(homes.extraCodexSessionsRoots[0]?.instanceId, "codex_work");
      assert.equal(
        homes.extraCodexSessionsRoots[0]?.root,
        path.join(NodeOS.homedir(), ".codex", "sessions"),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
