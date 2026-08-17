import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import {
  isTeleportCwdWithin,
  resolveTeleportCwdPath,
  teleportCwdsEquivalent,
  teleportCwdsMatch,
} from "./cwd.ts";

describe("teleport cwd matching", () => {
  it("treats trailing slashes as the same project", () => {
    assert.equal(teleportCwdsMatch("/workspace", "/workspace/"), true);
    assert.equal(teleportCwdsMatch("/workspace", "/other"), false);
  });

  it("treats a nested project folder as inside its parent cwd", () => {
    assert.equal(
      isTeleportCwdWithin("/home/user/projects/native/codex", "/home/user/projects/native"),
      true,
    );
    assert.equal(isTeleportCwdWithin("/tmp/wire-test", "/tmp"), true);
    assert.equal(isTeleportCwdWithin("/foobar", "/foo"), false);
  });

  it.effect("treats a symlink cwd as the same project", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "teleport-cwd-" });
      const real = path.join(root, "real-project");
      const link = path.join(root, "link-project");
      yield* fs.makeDirectory(real, { recursive: true });
      yield* fs.symlink(real, link);
      assert.equal(yield* teleportCwdsEquivalent(real, link), true);
      assert.equal(yield* teleportCwdsEquivalent(real, path.join(root, "other")), false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("treats macOS cwd spellings as the same when they differ only by case", () =>
    teleportCwdsEquivalent("/Users/Alex/proj", "/Users/alex/proj").pipe(
      Effect.provideService(HostProcessPlatform, "darwin"),
      Effect.provide(NodeServices.layer),
      Effect.map((matched) => {
        assert.equal(matched, true);
      }),
    ),
  );

  it.effect("does not case-fold missing Unix paths on Linux", () =>
    teleportCwdsEquivalent("/Users/Alex/proj", "/Users/alex/proj").pipe(
      Effect.provideService(HostProcessPlatform, "linux"),
      Effect.provide(NodeServices.layer),
      Effect.map((matched) => {
        assert.equal(matched, false);
      }),
    ),
  );

  it.effect("resolves a persist cwd without lowercasing Unix paths", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "teleport-persist-cwd-" });
      const project = path.join(root, "MixedCase");
      yield* fs.makeDirectory(project, { recursive: true });
      const resolved = yield* resolveTeleportCwdPath(`${project}/`);
      assert.equal(resolved, yield* fs.realPath(project));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
