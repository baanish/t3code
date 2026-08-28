import {
  TeleportFileLockedError,
  TeleportLockProbeError,
  TeleportNativeWriteError,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";

import type * as ProcessRunner from "../processRunner.ts";
import { requireNativePathUnlocked } from "./fileLock.ts";

function platformErrorTag(cause: unknown): string | undefined {
  if (typeof cause !== "object" || cause === null) {
    return undefined;
  }
  if ("reason" in cause) {
    const reason = (cause as { reason?: { _tag?: unknown } }).reason;
    if (reason && typeof reason._tag === "string") {
      return reason._tag;
    }
  }
  if ("_tag" in cause && typeof (cause as { _tag?: unknown })._tag === "string") {
    return (cause as { _tag: string })._tag;
  }
  return undefined;
}

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

export function isNativeFileBusy(cause: unknown): boolean {
  const tag = platformErrorTag(cause);
  if (tag === "Busy") {
    return true;
  }
  const code = nodeErrorCode(cause);
  return code === "EBUSY";
}

function isReplaceConflict(cause: unknown): boolean {
  const tag = platformErrorTag(cause);
  if (tag === "AlreadyExists" || tag === "PermissionDenied") {
    return true;
  }
  const code = nodeErrorCode(cause);
  return code === "EEXIST" || code === "EPERM" || code === "EACCES";
}

/**
 * Rename `from` onto `to`. Unix rename replaces an existing file; Windows
 * throws if the destination exists, so we move the destination aside, then
 * rename. If the replacement rename fails, the original is restored. A locked
 * destination becomes `TeleportFileLockedError`.
 */
export const replaceNativeFile = Effect.fn("replaceNativeFile")(function* (input: {
  readonly from: string;
  readonly to: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* HostProcessPlatform;
  const locked = (cause: unknown) =>
    new TeleportFileLockedError({
      nativePath: input.to,
      cause,
    });
  const failed = (cause: unknown) =>
    new TeleportNativeWriteError({
      nativePath: input.to,
      stage: "replace",
      cause,
    });

  const asReplaceError = (cause: unknown): TeleportFileLockedError | TeleportNativeWriteError =>
    isNativeFileBusy(cause) ? locked(cause) : failed(cause);

  const rename = fs.rename(input.from, input.to);
  return yield* rename.pipe(
    Effect.catch(
      (
        cause: PlatformError.PlatformError,
      ): Effect.Effect<void, TeleportFileLockedError | TeleportNativeWriteError> => {
        if (platform === "win32" && isReplaceConflict(cause) && !isNativeFileBusy(cause)) {
          const backupPath = `${input.to}.teleport-bak`;
          return fs.rename(input.to, backupPath).pipe(
            Effect.mapError(asReplaceError),
            Effect.andThen(
              rename.pipe(
                Effect.tapError(() =>
                  fs.rename(backupPath, input.to).pipe(
                    Effect.mapError(
                      (cause) =>
                        new TeleportNativeWriteError({
                          nativePath: input.to,
                          stage: "replace",
                          cause,
                        }),
                    ),
                  ),
                ),
                Effect.mapError(asReplaceError),
                Effect.andThen(fs.remove(backupPath).pipe(Effect.catch(() => Effect.void))),
              ),
            ),
          );
        }
        return Effect.fail(asReplaceError(cause));
      },
    ),
  );
});

export const writeNativeSessionAtomically = Effect.fn("writeNativeSessionAtomically")(
  function* (input: {
    readonly filePath: string;
    readonly contents: string;
    readonly verify: (contents: string) => Effect.Effect<unknown, TeleportNativeWriteError>;
  }): Effect.fn.Return<
    void,
    TeleportNativeWriteError | TeleportFileLockedError | TeleportLockProbeError,
    FileSystem.FileSystem | Path.Path | ProcessRunner.ProcessRunner
  > {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const targetDirectory = path.dirname(input.filePath);

    yield* requireNativePathUnlocked(input.filePath);

    const exists = yield* fs.exists(input.filePath).pipe(Effect.orElseSucceed(() => false));
    if (exists) {
      yield* requireNativePathUnlocked(input.filePath);
    }

    yield* fs.makeDirectory(targetDirectory, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new TeleportNativeWriteError({
            nativePath: input.filePath,
            stage: "create-directory",
            cause,
          }),
      ),
    );

    yield* Effect.scoped(
      Effect.gen(function* () {
        const tempDirectory = yield* fs
          .makeTempDirectoryScoped({
            directory: targetDirectory,
            prefix: `${path.basename(input.filePath)}.`,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new TeleportNativeWriteError({
                  nativePath: input.filePath,
                  stage: "create-temp",
                  cause,
                }),
            ),
          );
        const tempPath = path.join(tempDirectory, "contents.tmp");
        yield* fs.writeFileString(tempPath, input.contents).pipe(
          Effect.mapError(
            (cause) =>
              new TeleportNativeWriteError({
                nativePath: input.filePath,
                stage: "write-temp",
                cause,
              }),
          ),
        );
        const written = yield* fs.readFileString(tempPath).pipe(
          Effect.mapError(
            (cause) =>
              new TeleportNativeWriteError({
                nativePath: input.filePath,
                stage: "read-temp",
                cause,
              }),
          ),
        );
        yield* input.verify(written);
        yield* requireNativePathUnlocked(input.filePath);
        yield* replaceNativeFile({ from: tempPath, to: input.filePath });
      }),
    );
  },
);
