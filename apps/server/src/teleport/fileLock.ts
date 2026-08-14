// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";

import { TeleportFileLockedError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

export const isNativePathLocked = Effect.fn("isNativePathLocked")(function* (nativePath: string) {
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
