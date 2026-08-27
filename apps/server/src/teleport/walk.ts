import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/**
 * Depth-first file walk that follows directory metadata but never re-enters a
 * canonical directory. A symlink to an ancestor would otherwise loop forever
 * because `stat` reports the target as `Directory`.
 */
export const walkTeleportFiles = Effect.fn("walkTeleportFiles")(function* (
  root: string,
  options: {
    readonly shouldEnterDirectory?: (name: string) => boolean;
    readonly shouldCollectFile: (name: string, entryPath: string) => boolean;
  },
): Effect.fn.Return<ReadonlyArray<string>, never, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const exists = yield* fs.exists(root).pipe(Effect.orElseSucceed(() => false));
  if (!exists) {
    return [];
  }

  const files: string[] = [];
  const visited = new Set<string>();
  const rootCanonical = yield* fs.realPath(root).pipe(Effect.orElseSucceed(() => root));
  visited.add(rootCanonical);
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    const entries = yield* fs.readDirectory(current).pipe(Effect.orElseSucceed(() => []));
    for (const name of entries) {
      const entryPath = path.join(current, name);
      const stat = yield* fs.stat(entryPath).pipe(Effect.orElseSucceed(() => null));
      if (stat === null) {
        continue;
      }
      if (stat.type === "Directory") {
        if (options.shouldEnterDirectory !== undefined && !options.shouldEnterDirectory(name)) {
          continue;
        }
        const canonical = yield* fs.realPath(entryPath).pipe(Effect.orElseSucceed(() => entryPath));
        if (visited.has(canonical)) {
          continue;
        }
        visited.add(canonical);
        stack.push(entryPath);
        continue;
      }
      if (stat.type === "File" && options.shouldCollectFile(name, entryPath)) {
        files.push(entryPath);
      }
    }
  }
  return files;
});
