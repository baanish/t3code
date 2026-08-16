// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import { isNativePathLocked, requireNativePathUnlocked } from "./fileLock.ts";

describe("teleport file locks", () => {
  it.effect("treats a missing lock probe as TeleportLockProbeError, not a lock", () =>
    Effect.gen(function* () {
      const previousPath = process.env.PATH;
      process.env.PATH = "/tmp/teleport-missing-lock-probe-bin";
      try {
        const error = yield* isNativePathLocked("/tmp/teleport-lock-probe-missing").pipe(
          Effect.flip,
        );
        assert.equal(error._tag, "TeleportLockProbeError");
      } finally {
        if (previousPath === undefined) {
          delete process.env.PATH;
        } else {
          process.env.PATH = previousPath;
        }
      }
    }).pipe(Effect.provideService(HostProcessPlatform, "linux")),
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
      Effect.provide(NodeServices.layer),
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
      Effect.provide(NodeServices.layer),
      Effect.provideService(HostProcessPlatform, "linux"),
    ),
  );
});
