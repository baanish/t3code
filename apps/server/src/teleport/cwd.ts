import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export function normalizeTeleportCwd(value: string): string {
  return normalizeProjectPathForComparison(value);
}

export const canonicalizeTeleportCwd = Effect.fn("canonicalizeTeleportCwd")(function* (
  value: string,
): Effect.fn.Return<string, never, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resolved = path.resolve(value.trim());
  const real = yield* fs.realPath(resolved).pipe(Effect.orElseSucceed(() => resolved));
  return normalizeTeleportCwd(real);
});

export function teleportCwdsMatch(left: string, right: string): boolean {
  return normalizeTeleportCwd(left) === normalizeTeleportCwd(right);
}
