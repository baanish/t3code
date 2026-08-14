import { TeleportFileLockedError, TeleportNativeWriteError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { requireNativePathUnlocked } from "./fileLock.ts";

export const writeNativeSessionAtomically = Effect.fn("writeNativeSessionAtomically")(
  function* (input: {
    readonly filePath: string;
    readonly contents: string;
    readonly verify: (contents: string) => Effect.Effect<unknown, TeleportNativeWriteError>;
  }): Effect.fn.Return<
    void,
    TeleportNativeWriteError | TeleportFileLockedError,
    FileSystem.FileSystem | Path.Path
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
            message: `Failed to create directory for ${input.filePath}.`,
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
                  message: `Failed to create a temp file for ${input.filePath}.`,
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
                message: `Failed to write temp session file for ${input.filePath}.`,
                cause,
              }),
          ),
        );
        const written = yield* fs.readFileString(tempPath).pipe(
          Effect.mapError(
            (cause) =>
              new TeleportNativeWriteError({
                nativePath: input.filePath,
                message: `Failed to re-read temp session file for ${input.filePath}.`,
                cause,
              }),
          ),
        );
        yield* input.verify(written);
        yield* requireNativePathUnlocked(input.filePath);
        yield* fs.rename(tempPath, input.filePath).pipe(
          Effect.mapError((cause) => {
            if (isBusy(cause)) {
              return new TeleportFileLockedError({
                nativePath: input.filePath,
                message: `Native session file is locked: ${input.filePath}`,
                cause,
              });
            }
            return new TeleportNativeWriteError({
              nativePath: input.filePath,
              message: `Failed to replace ${input.filePath}.`,
              cause,
            });
          }),
        );
      }),
    );
  },
);

function isBusy(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause as { code?: unknown }).code === "EBUSY"
  );
}
