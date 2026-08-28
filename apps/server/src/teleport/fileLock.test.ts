// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import * as ProcessRunner from "../processRunner.ts";
import { isNativePathLocked, requireNativePathUnlocked } from "./fileLock.ts";

const lockProbeLayer = Layer.merge(
  NodeServices.layer,
  ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)),
);

describe("teleport file locks", () => {
  const noLsofLayer = Layer.merge(
    NodeServices.layer,
    Layer.succeed(ProcessRunner.ProcessRunner, {
      run: () =>
        new ProcessRunner.ProcessSpawnError({
          command: "lsof",
          argumentCount: 2,
          cause: new Error("ENOENT"),
        }),
    }),
  );

  it.effect("fails closed when lsof cannot be spawned and the file exists", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "teleport-lock-nolsof-" });
      const filePath = path.join(root, "session.jsonl");
      yield* fs.writeFileString(filePath, "ok\n");
      const locked = yield* isNativePathLocked(filePath).pipe(Effect.flip);
      assert.equal(locked._tag, "TeleportLockProbeError");
      const required = yield* requireNativePathUnlocked(filePath).pipe(Effect.flip);
      assert.equal(required._tag, "TeleportLockProbeError");
    }).pipe(
      Effect.scoped,
      Effect.provideService(HostProcessPlatform, "linux"),
      Effect.provide(noLsofLayer),
    ),
  );

  it.effect("treats a missing file as unlocked when lsof cannot be spawned", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "teleport-lock-nolsof-missing-" });
      const filePath = path.join(root, "session.jsonl");
      assert.equal(yield* isNativePathLocked(filePath), false);
      yield* requireNativePathUnlocked(filePath);
    }).pipe(
      Effect.scoped,
      Effect.provideService(HostProcessPlatform, "linux"),
      Effect.provide(noLsofLayer),
    ),
  );

  it.effect("treats an unused file as unlocked when the lock probe succeeds", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "teleport-lock-free-" });
      const filePath = path.join(root, "session.jsonl");
      yield* fs.writeFileString(filePath, "ok\n");
      assert.equal(yield* isNativePathLocked(filePath), false);
      yield* requireNativePathUnlocked(filePath);
    }).pipe(
      Effect.scoped,
      Effect.provide(lockProbeLayer),
      Effect.provideService(HostProcessPlatform, "linux"),
    ),
  );

  it.effect("reports a held file as locked, not as a probe failure", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "teleport-lock-held-" });
      const filePath = path.join(root, "session.jsonl");
      yield* fs.writeFileString(filePath, "ok\n");
      const handle = yield* Effect.tryPromise(() => NodeFSP.open(filePath, "r+"));
      try {
        assert.equal(yield* isNativePathLocked(filePath), true);
        const error = yield* requireNativePathUnlocked(filePath).pipe(Effect.flip);
        assert.equal(error._tag, "TeleportFileLockedError");
      } finally {
        yield* Effect.promise(() => handle.close());
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(lockProbeLayer),
      Effect.provideService(HostProcessPlatform, "linux"),
    ),
  );
});
