import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { listCodexJsonlFiles } from "./formats/codex.ts";
import { walkTeleportFiles } from "./walk.ts";

describe("walkTeleportFiles", () => {
  it.effect("returns when a directory symlink points at an ancestor", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "teleport-walk-loop-" });
      const sessions = path.join(root, "sessions");
      yield* fs.makeDirectory(sessions);
      yield* fs.writeFileString(path.join(sessions, "session.jsonl"), "ok\n");
      yield* fs.symlink(sessions, path.join(sessions, "loop"));

      const files = yield* walkTeleportFiles(sessions, {
        shouldCollectFile: (_name, entryPath) => entryPath.endsWith(".jsonl"),
      });
      assert.equal(files.length, 1);
      assert.equal(files[0], path.join(sessions, "session.jsonl"));

      const listed = yield* listCodexJsonlFiles(sessions);
      assert.deepEqual(listed, files);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
