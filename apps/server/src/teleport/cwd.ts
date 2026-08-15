import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import {
  normalizeProjectPathForComparison,
  normalizeProjectPathForDispatch,
} from "@t3tools/shared/path";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export function normalizeTeleportCwd(value: string): string {
  return normalizeProjectPathForComparison(value);
}

/**
 * On-disk cwd spelling for native session files and folder names.
 * Comparison-normalize lowercases Windows paths; the native CLIs look up
 * the persisted case and separators instead.
 */
export const resolveTeleportCwdPath = Effect.fn("resolveTeleportCwdPath")(function* (
  value: string,
): Effect.fn.Return<string, never, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resolved = path.resolve(normalizeProjectPathForDispatch(value));
  return yield* fs.realPath(resolved).pipe(Effect.orElseSucceed(() => resolved));
});

export const canonicalizeTeleportCwd = Effect.fn("canonicalizeTeleportCwd")(function* (
  value: string,
): Effect.fn.Return<string, never, FileSystem.FileSystem | Path.Path> {
  return normalizeTeleportCwd(yield* resolveTeleportCwdPath(value));
});

export function teleportCwdsMatch(left: string, right: string): boolean {
  return normalizeTeleportCwd(left) === normalizeTeleportCwd(right);
}

/**
 * Same location, including macOS `/tmp` → `/private/tmp` and case-insensitive
 * default volumes. Lexical equality short-circuits; otherwise both sides go
 * through `realpath` so a native CLI cwd and a T3 project root still match.
 */
export const teleportCwdsEquivalent = Effect.fn("teleportCwdsEquivalent")(function* (
  left: string,
  right: string,
) {
  if (teleportCwdsMatch(left, right)) {
    return true;
  }
  const leftCanon = yield* canonicalizeTeleportCwd(left);
  const rightCanon = yield* canonicalizeTeleportCwd(right);
  if (leftCanon === rightCanon) {
    return true;
  }
  const platform = yield* HostProcessPlatform;
  // Default macOS volumes are case-insensitive. realpath keeps on-disk case
  // when the path exists; missing paths fall back to the input spelling.
  if (platform === "darwin") {
    return leftCanon.toLowerCase() === rightCanon.toLowerCase();
  }
  return false;
});
