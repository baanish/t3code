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
  teleportSessionBelongsToProject,
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

  it.effect("treats a T3 worktree cwd as part of the project when listed as extra", () =>
    teleportSessionBelongsToProject({
      sessionCwd: "/home/user/.t3/worktrees/repo/feature",
      projectCwd: "/home/user/projects/repo",
      extraCwds: ["/home/user/.t3/worktrees/repo/feature"],
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.map((matched) => {
        assert.equal(matched, true);
      }),
    ),
  );

  it.effect("treats a project subdirectory cwd as part of the project", () =>
    teleportSessionBelongsToProject({
      sessionCwd: "/home/user/projects/repo/packages/app",
      projectCwd: "/home/user/projects/repo",
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.map((matched) => {
        assert.equal(matched, true);
      }),
    ),
  );

  it.effect("does not treat an ancestor cwd as part of the project", () =>
    teleportSessionBelongsToProject({
      sessionCwd: "/",
      projectCwd: "/home/user/projects/repo",
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.map((matched) => {
        assert.equal(matched, false);
      }),
    ),
  );

  it.effect("does not treat a dot-dot sibling as part of the project", () =>
    teleportSessionBelongsToProject({
      sessionCwd: "/home/user/projects/repo/../other",
      projectCwd: "/home/user/projects/repo",
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.map((matched) => {
        assert.equal(matched, false);
      }),
    ),
  );

  it.effect("does not treat an unrelated worktree as part of the project", () =>
    teleportSessionBelongsToProject({
      sessionCwd: "/home/user/.t3/worktrees/other/feature",
      projectCwd: "/home/user/projects/repo",
      extraCwds: ["/home/user/.t3/worktrees/repo/feature"],
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.map((matched) => {
        assert.equal(matched, false);
      }),
    ),
  );
});
