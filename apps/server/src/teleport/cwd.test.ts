import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import {
  isForeignOpenCodeProjectFolder,
  isGenericTeleportCwd,
  isTeleportCwdWithin,
  opencodeSessionMatchesProjectCwd,
  resolveTeleportCwdPath,
  teleportCwdsEquivalent,
  teleportCwdsMatch,
} from "./cwd.ts";

describe("teleport cwd matching", () => {
  it("treats trailing slashes as the same project", () => {
    assert.equal(teleportCwdsMatch("/workspace", "/workspace/"), true);
    assert.equal(teleportCwdsMatch("/workspace", "/other"), false);
  });

  it("treats a project folder as inside its OpenCode launch cwd", () => {
    assert.equal(
      isTeleportCwdWithin(
        "/home/ubuntu/baanish-testing/native/opencode",
        "/home/ubuntu/baanish-testing/native",
      ),
      true,
    );
    assert.equal(isTeleportCwdWithin("/tmp/oc-wire-test", "/tmp"), true);
    assert.equal(isTeleportCwdWithin("/foobar", "/foo"), false);
  });

  it("rejects home and temp roots as OpenCode launch directories", () => {
    assert.equal(isGenericTeleportCwd("/"), true);
    assert.equal(isGenericTeleportCwd("/tmp"), true);
    assert.equal(isGenericTeleportCwd("/home/ubuntu"), true);
    assert.equal(isGenericTeleportCwd("/home/ubuntu/baanish-testing/native"), false);
    assert.equal(isGenericTeleportCwd("C:\\Users\\Foo"), true);
    assert.equal(isGenericTeleportCwd("C:\\Users\\Foo\\proj"), false);
  });

  it.effect("matches an OpenCode session whose cwd is a parent of the project", () =>
    opencodeSessionMatchesProjectCwd(
      "/home/ubuntu/baanish-testing/native",
      "/home/ubuntu/baanish-testing/native/opencode",
    ).pipe(
      Effect.provideService(HostProcessPlatform, "linux"),
      Effect.provide(NodeServices.layer),
      Effect.map((matched) => {
        assert.equal(matched, true);
      }),
    ),
  );

  it.effect("does not match an OpenCode session launched from /tmp", () =>
    opencodeSessionMatchesProjectCwd("/tmp", "/tmp/oc-wire-test").pipe(
      Effect.provideService(HostProcessPlatform, "linux"),
      Effect.provide(NodeServices.layer),
      Effect.map((matched) => {
        assert.equal(matched, false);
      }),
    ),
  );

  it("does not treat sibling harness folders as OpenCode parent matches", () => {
    assert.equal(isForeignOpenCodeProjectFolder("/home/ubuntu/baanish-testing/native/codex"), true);
    assert.equal(
      isForeignOpenCodeProjectFolder("/home/ubuntu/baanish-testing/native/claude"),
      true,
    );
    assert.equal(
      isForeignOpenCodeProjectFolder("/home/ubuntu/baanish-testing/native/opencode"),
      false,
    );
  });

  it.effect("does not list a parent OpenCode session under a Codex project folder", () =>
    opencodeSessionMatchesProjectCwd(
      "/home/ubuntu/baanish-testing/native",
      "/home/ubuntu/baanish-testing/native/codex",
    ).pipe(
      Effect.provideService(HostProcessPlatform, "linux"),
      Effect.provide(NodeServices.layer),
      Effect.map((matched) => {
        assert.equal(matched, false);
      }),
    ),
  );

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
