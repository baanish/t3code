// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeUtil from "node:util";

import { TeleportFileLockedError, TeleportLockProbeError } from "@t3tools/contracts";
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

function execExitStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  if ("status" in error && typeof (error as { status?: unknown }).status === "number") {
    return (error as { status: number }).status;
  }
  if ("code" in error && typeof (error as { code?: unknown }).code === "number") {
    return (error as { code: number }).code;
  }
  return undefined;
}

function execStdout(error: unknown): string {
  if (typeof error === "object" && error !== null && "stdout" in error) {
    const stdout = (error as { stdout?: unknown }).stdout;
    return typeof stdout === "string" ? stdout : "";
  }
  return "";
}

const isWindowsPathInUse = Effect.fn("isWindowsPathInUse")(function* (nativePath: string) {
  return yield* Effect.tryPromise({
    try: async () => {
      try {
        const handle = await NodeFSP.open(nativePath, "r+");
        await handle.close();
        return false;
      } catch (error) {
        const code = nodeErrorCode(error);
        if (code === "ENOENT" || code === "EISDIR") {
          return false;
        }
        if (code === "EBUSY" || code === "EPERM" || code === "EACCES") {
          return true;
        }
        throw error;
      }
    },
    catch: (cause) =>
      new TeleportLockProbeError({
        nativePath,
        message: `Failed to check whether ${nativePath} is locked.`,
        cause,
      }),
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
    try: async () => {
      try {
        const result = await execFile("lsof", ["-t", nativePath], { timeout: 2_000 });
        return result.stdout.trim().length > 0;
      } catch (error) {
        // lsof exits 1 when no process has the file open.
        if (execExitStatus(error) === 1) {
          return execStdout(error).trim().length > 0;
        }
        throw error;
      }
    },
    catch: (cause) =>
      new TeleportLockProbeError({
        nativePath,
        message: `Failed to check whether ${nativePath} is locked.`,
        cause,
      }),
  });
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
