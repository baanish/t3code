import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverTeleportSessions } from "./discovery.ts";
import { resetTeleportFormats } from "./formats/registry.ts";
import type { TeleportHomes } from "./homes.ts";

describe("teleport discovery", () => {
  it.effect("lists nothing when no native formats are registered", () =>
    Effect.gen(function* () {
      resetTeleportFormats();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "teleport-empty-registry-" });
      const homes: TeleportHomes = {
        codexSessionsRoot: path.join(root, "codex", "sessions"),
        claudeProjectsRoot: path.join(root, "claude", "projects"),
        opencodeRoot: path.join(root, "opencode"),
        grokSessionsRoot: path.join(root, "grok", "sessions"),
      };
      const listed = yield* discoverTeleportSessions({
        homes,
        cwd: "/workspace",
      });
      assert.deepStrictEqual(listed.sessions, []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
