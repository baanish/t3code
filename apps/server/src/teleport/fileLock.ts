// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeUtil from "node:util";

import { TeleportFileLockedError } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

function nodeErrorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

const isWindowsPathInUse = Effect.fn("isWindowsPathInUse")(function* (nativePath: string) {
  // Succeed with a boolean. `Effect.tryPromise` `catch` is the error channel
  // and would leak `false` into export/import failures.
  return yield* Effect.promise(async () => {
    try {
      const handle = await NodeFSP.open(nativePath, "r+");
      await handle.close();
      return false;
    } catch (error) {
      const code = nodeErrorCode(error);
      if (code === "ENOENT" || code === "EISDIR") {
        return false;
      }
      return code === "EBUSY" || code === "EPERM" || code === "EACCES";
    }
  });
});

export const isNativePathLocked = Effect.fn("isNativePathLocked")(function* (nativePath: string) {
  const platform = yield* HostProcessPlatform;
  if (platform === "win32") {
    // `lsof` is not a Windows tool. Exclusive locks from a native CLI show up
    // as EBUSY/EPERM/EACCES on a write-open instead.
    return yield* isWindowsPathInUse(nativePath);
  }
  return yield* Effect.tryPromise({
    try: () => execFile("lsof", ["-t", nativePath], { timeout: 2_000 }),
    catch: () =>
      new TeleportFileLockedError({
        nativePath,
        message: `Failed to check whether ${nativePath} is locked.`,
      }),
  }).pipe(
    Effect.map((result) => result.stdout.trim().length > 0),
    Effect.orElseSucceed(() => false),
  );
});

export const requireNativePathUnlocked = Effect.fn("requireNativePathUnlocked")(function* (
  nativePath: string,
) {
  const locked = yield* isNativePathLocked(nativePath);
  if (locked) {
    return yield* new TeleportFileLockedError({
      nativePath,
      message: `Native session file is locked: ${nativePath}`,
    });
  }
});
