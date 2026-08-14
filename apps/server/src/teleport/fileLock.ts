// @effect-diagnostics nodeBuiltinImport:off
import * as ChildProcess from "node:child_process";
import * as NodeUtil from "node:util";

import { TeleportFileLockedError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

const execFile = NodeUtil.promisify(ChildProcess.execFile);

export const isNativePathLocked = Effect.fn("isNativePathLocked")(function* (nativePath: string) {
  const result = yield* Effect.tryPromise({
    try: () => execFile("lsof", ["-t", nativePath], { timeout: 2_000 }),
    catch: (cause) => cause,
  }).pipe(Effect.result);

  if (result._tag === "Failure") {
    const cause = result.failure;
    if (isCommandMissing(cause) || isNoMatchingProcess(cause)) {
      return false;
    }
    return false;
  }

  return result.success.stdout.trim().length > 0;
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

function isCommandMissing(cause: unknown): boolean {
  return isRecord(cause) && (cause.code === "ENOENT" || cause.code === "ENOTDIR");
}

function isNoMatchingProcess(cause: unknown): boolean {
  return isRecord(cause) && cause.code === 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
