import { TeleportFileLockedError, TeleportLockProbeError } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";

import * as ProcessRunner from "../processRunner.ts";

function nodeErrorCode(cause: unknown): string | undefined {
  if (typeof cause !== "object" || cause === null) {
    return undefined;
  }
  if ("code" in cause && typeof (cause as { code?: unknown }).code === "string") {
    return (cause as { code: string }).code;
  }
  if ("reason" in cause) {
    const nested = (cause as { reason?: { cause?: unknown } }).reason?.cause;
    return nodeErrorCode(nested);
  }
  return undefined;
}

function platformErrorTag(cause: unknown): string | undefined {
  if (cause instanceof PlatformError.PlatformError) {
    return cause.reason._tag;
  }
  return undefined;
}

function isUnlockedOpenError(cause: unknown): boolean {
  const tag = platformErrorTag(cause);
  if (tag === "NotFound") {
    return true;
  }
  const code = nodeErrorCode(cause);
  return code === "ENOENT" || code === "EISDIR";
}

function isLockedOpenError(cause: unknown): boolean {
  const tag = platformErrorTag(cause);
  if (tag === "Busy" || tag === "PermissionDenied") {
    return true;
  }
  const code = nodeErrorCode(cause);
  return code === "EBUSY" || code === "EPERM" || code === "EACCES";
}

function lockProbeError(nativePath: string, cause: unknown): TeleportLockProbeError {
  return new TeleportLockProbeError({
    nativePath,
    message: `Failed to check whether ${nativePath} is locked.`,
    cause,
  });
}

const isWindowsPathInUse = Effect.fn("isWindowsPathInUse")(function* (nativePath: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* Effect.scoped(fs.open(nativePath, { flag: "r+" })).pipe(
    Effect.as(false),
    Effect.catch((cause: PlatformError.PlatformError) => {
      if (isUnlockedOpenError(cause)) {
        return Effect.succeed(false);
      }
      if (isLockedOpenError(cause)) {
        return Effect.succeed(true);
      }
      return Effect.fail(lockProbeError(nativePath, cause));
    }),
  );
});

const isUnixPathInUse = Effect.fn("isUnixPathInUse")(function* (nativePath: string) {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const result = yield* processRunner
    .run({
      command: "lsof",
      args: ["-t", nativePath],
      timeout: Duration.seconds(2),
      maxOutputBytes: 64 * 1024,
      outputMode: "truncate",
    })
    .pipe(
      Effect.catchTags({
        ProcessSpawnError: (cause) => lockProbeError(nativePath, cause),
        ProcessStdinError: (cause) => lockProbeError(nativePath, cause),
        ProcessOutputLimitError: (cause) => lockProbeError(nativePath, cause),
        ProcessReadError: (cause) => lockProbeError(nativePath, cause),
        ProcessTimeoutError: (cause) => lockProbeError(nativePath, cause),
      }),
    );
  if (result.code === 0 || result.code === 1) {
    return result.stdout.trim().length > 0;
  }
  return yield* lockProbeError(nativePath, result);
});

export const isNativePathLocked = Effect.fn("isNativePathLocked")(function* (nativePath: string) {
  const platform = yield* HostProcessPlatform;
  if (platform === "win32") {
    // `lsof` is not a Windows tool. Exclusive locks from a native CLI show up
    // as EBUSY/EPERM/EACCES on a write-open instead.
    return yield* isWindowsPathInUse(nativePath);
  }
  return yield* isUnixPathInUse(nativePath);
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
