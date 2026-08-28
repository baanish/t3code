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

const isPathInUseByOpen = Effect.fn("isPathInUseByOpen")(function* (nativePath: string) {
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
      return Effect.fail(new TeleportLockProbeError({ nativePath, cause }));
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
        // `lsof` is the Unix lock source of truth. Advisory `open(r+)` is not
        // a substitute: it often succeeds while a CLI still has the file.
        ProcessSpawnError: () => Effect.succeed(null),
        ProcessStdinError: (cause) => new TeleportLockProbeError({ nativePath, cause }),
        ProcessOutputLimitError: (cause) => new TeleportLockProbeError({ nativePath, cause }),
        ProcessReadError: (cause) => new TeleportLockProbeError({ nativePath, cause }),
        ProcessTimeoutError: (cause) => new TeleportLockProbeError({ nativePath, cause }),
      }),
    );
  if (result === null) {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs
      .exists(nativePath)
      .pipe(Effect.mapError((cause) => new TeleportLockProbeError({ nativePath, cause })));
    if (!exists) {
      // First export create: the target file is not there yet.
      return false;
    }
    return yield* new TeleportLockProbeError({
      nativePath,
      cause: new Error("lsof is unavailable; cannot prove the native file is unlocked"),
    });
  }
  if (result.code === 0 || result.code === 1) {
    return result.stdout.trim().length > 0;
  }
  return yield* new TeleportLockProbeError({ nativePath, cause: result });
});

export const isNativePathLocked = Effect.fn("isNativePathLocked")(function* (nativePath: string) {
  const platform = yield* HostProcessPlatform;
  if (platform === "win32") {
    // `lsof` is not a Windows tool. Exclusive locks from a native CLI show up
    // as EBUSY/EPERM/EACCES on a write-open instead.
    return yield* isPathInUseByOpen(nativePath);
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
    });
  }
});
