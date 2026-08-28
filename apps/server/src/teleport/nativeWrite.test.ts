import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { TeleportNativeWriteError } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import * as ProcessRunner from "../processRunner.ts";
import { replaceNativeFile, writeNativeSessionAtomically } from "./nativeWrite.ts";

const unlockedProcessRunner: ProcessRunner.ProcessRunner["Service"] = {
  run: () =>
    Effect.succeed({
      stdout: "",
      stderr: "",
      code: 1 as ProcessRunner.ProcessRunOutput["code"],
      timedOut: false,
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutInvalidUtf8: false,
      stderrInvalidUtf8: false,
    }),
};

const unixWriteLayer = Layer.mergeAll(
  NodeServices.layer,
  Layer.succeed(ProcessRunner.ProcessRunner, unlockedProcessRunner),
  Layer.succeed(HostProcessPlatform, "linux"),
);

function alreadyExists(path: string) {
  return PlatformError.systemError({
    _tag: "AlreadyExists",
    module: "FileSystem",
    method: "rename",
    pathOrDescriptor: path,
  });
}

function replaceFailed(path: string) {
  return PlatformError.systemError({
    _tag: "PermissionDenied",
    module: "FileSystem",
    method: "rename",
    pathOrDescriptor: path,
    description: "replacement rename failed",
  });
}

function windowsRenameFileSystem(
  inner: FileSystem.FileSystem,
  options?: {
    readonly failReplacementTo?: string;
    readonly failRestoreFromBak?: boolean;
  },
): FileSystem.FileSystem {
  const exists = inner.exists.bind(inner);
  const rename = inner.rename.bind(inner);
  return {
    ...inner,
    rename: (from: string, to: string) =>
      exists(to).pipe(
        Effect.flatMap((alreadyThere) => {
          if (alreadyThere) {
            return Effect.fail(alreadyExists(to));
          }
          if (options?.failRestoreFromBak === true && from.endsWith(".teleport-bak")) {
            return Effect.fail(replaceFailed(to));
          }
          if (
            options?.failReplacementTo !== undefined &&
            to === options.failReplacementTo &&
            !from.endsWith(".teleport-bak")
          ) {
            return Effect.fail(replaceFailed(to));
          }
          return rename(from, to);
        }),
      ),
  };
}

describe("teleport native writes", () => {
  it.effect("replaces the target on Unix and removes the temp file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "teleport-write-unix-" });
      const filePath = path.join(root, "session.jsonl");
      const tempPath = path.join(root, "contents.tmp");
      yield* fs.writeFileString(filePath, "original\n");
      yield* fs.writeFileString(tempPath, "replacement\n");
      yield* replaceNativeFile({ from: tempPath, to: filePath });
      assert.equal(yield* fs.readFileString(filePath), "replacement\n");
      assert.equal(yield* fs.exists(tempPath), false);
    }).pipe(Effect.scoped, Effect.provide(unixWriteLayer)),
  );

  it.effect("does not clobber the target when verify fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "teleport-write-verify-" });
      const filePath = path.join(root, "session.jsonl");
      yield* fs.writeFileString(filePath, "original\n");
      const error = yield* writeNativeSessionAtomically({
        filePath,
        contents: "should-not-land\n",
        verify: () =>
          new TeleportNativeWriteError({
            nativePath: filePath,
            stage: "verify",
          }),
      }).pipe(Effect.flip);
      assert.equal(error._tag, "TeleportNativeWriteError");
      if (error._tag === "TeleportNativeWriteError") {
        assert.equal(error.stage, "verify");
      }
      assert.equal(yield* fs.readFileString(filePath), "original\n");
      const leftovers = yield* fs.readDirectory(root);
      assert.equal(
        leftovers.some((name) => name.endsWith(".teleport-bak") || name.includes("contents.tmp")),
        false,
      );
    }).pipe(Effect.scoped, Effect.provide(unixWriteLayer)),
  );

  it.effect("writes through a Windows bak rename and removes the bak", () =>
    Effect.gen(function* () {
      const inner = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* inner.makeTempDirectoryScoped({ prefix: "teleport-write-win-" });
      const filePath = path.join(root, "session.jsonl");
      const tempPath = path.join(root, "contents.tmp");
      yield* inner.writeFileString(filePath, "original\n");
      yield* inner.writeFileString(tempPath, "replacement\n");
      const fs = windowsRenameFileSystem(inner);
      yield* replaceNativeFile({ from: tempPath, to: filePath }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
      );
      assert.equal(yield* inner.readFileString(filePath), "replacement\n");
      assert.equal(yield* inner.exists(`${filePath}.teleport-bak`), false);
      assert.equal(yield* inner.exists(tempPath), false);
    }).pipe(
      Effect.scoped,
      Effect.provide(NodeServices.layer),
      Effect.provideService(HostProcessPlatform, "win32"),
    ),
  );

  it.effect("restores the original from bak when the Windows replacement rename fails", () =>
    Effect.gen(function* () {
      const inner = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* inner.makeTempDirectoryScoped({ prefix: "teleport-write-win-restore-" });
      const filePath = path.join(root, "session.jsonl");
      const tempPath = path.join(root, "contents.tmp");
      yield* inner.writeFileString(filePath, "original\n");
      yield* inner.writeFileString(tempPath, "replacement\n");
      const fs = windowsRenameFileSystem(inner, { failReplacementTo: filePath });
      const error = yield* replaceNativeFile({ from: tempPath, to: filePath }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.flip,
      );
      assert.equal(error._tag, "TeleportNativeWriteError");
      assert.equal(yield* inner.readFileString(filePath), "original\n");
      assert.equal(yield* inner.exists(`${filePath}.teleport-bak`), false);
    }).pipe(
      Effect.scoped,
      Effect.provide(NodeServices.layer),
      Effect.provideService(HostProcessPlatform, "win32"),
    ),
  );

  it.effect("fails the Windows replace when the original cannot be restored from bak", () =>
    Effect.gen(function* () {
      const inner = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* inner.makeTempDirectoryScoped({
        prefix: "teleport-write-win-restore-fail-",
      });
      const filePath = path.join(root, "session.jsonl");
      const tempPath = path.join(root, "contents.tmp");
      yield* inner.writeFileString(filePath, "original\n");
      yield* inner.writeFileString(tempPath, "replacement\n");
      const fs = windowsRenameFileSystem(inner, {
        failReplacementTo: filePath,
        failRestoreFromBak: true,
      });
      const error = yield* replaceNativeFile({ from: tempPath, to: filePath }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.flip,
      );
      assert.equal(error._tag, "TeleportNativeWriteError");
      if (error._tag === "TeleportNativeWriteError") {
        assert.equal(error.stage, "replace");
      }
      assert.equal(yield* inner.exists(filePath), false);
      assert.equal(yield* inner.exists(`${filePath}.teleport-bak`), true);
      assert.equal(yield* inner.readFileString(`${filePath}.teleport-bak`), "original\n");
    }).pipe(
      Effect.scoped,
      Effect.provide(NodeServices.layer),
      Effect.provideService(HostProcessPlatform, "win32"),
    ),
  );
});
