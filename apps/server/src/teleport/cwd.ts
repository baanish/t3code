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

export function isTeleportCwdWithin(inner: string, outer: string): boolean {
  const innerCwd = normalizeTeleportCwd(inner);
  const outerCwd = normalizeTeleportCwd(outer);
  if (innerCwd === outerCwd) {
    return true;
  }
  const separator = innerCwd.includes("\\") || outerCwd.includes("\\") ? "\\" : "/";
  const prefix = outerCwd.endsWith(separator) ? outerCwd : `${outerCwd}${separator}`;
  return innerCwd.startsWith(prefix);
}

/**
 * Home folders, temp roots, and drive roots. OpenCode often records the
 * process cwd, which can be a parent of the T3 project — but matching `/tmp`
 * or `/home/user` would pull in unrelated sessions.
 */
export function isGenericTeleportCwd(cwd: string): boolean {
  const posix = normalizeTeleportCwd(cwd).replaceAll("\\", "/").replace(/\/+$/u, "");
  const lowered = posix.toLowerCase();
  if (lowered === "" || lowered === "/") {
    return true;
  }
  if (
    lowered === "/tmp" ||
    lowered === "/private/tmp" ||
    lowered === "/var" ||
    lowered === "/var/tmp" ||
    lowered === "/private/var" ||
    lowered === "/private/var/tmp" ||
    lowered === "/home" ||
    lowered === "/users" ||
    lowered === "/root"
  ) {
    return true;
  }
  const parts = lowered.split("/").filter((part) => part.length > 0);
  if (posix.startsWith("//") && parts.length <= 2) {
    return true;
  }
  const first = parts[0];
  if (first === undefined) {
    return true;
  }
  if (first === "home" || first === "users") {
    return parts.length <= 2;
  }
  if (first === "root") {
    return parts.length <= 1;
  }
  if (/^[a-z]:$/u.test(first)) {
    if (parts.length <= 1) {
      return true;
    }
    if (parts[1] === "users") {
      return parts.length <= 3;
    }
    if (parts[1] === "windows") {
      return parts.length <= 2;
    }
  }
  return false;
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

const FOREIGN_OPENCODE_PROJECT_FOLDERS = new Set([
  "codex",
  "claude",
  "grok",
  "claude-code",
  "claudeagent",
]);

export function isForeignOpenCodeProjectFolder(projectCwd: string): boolean {
  const posix = normalizeTeleportCwd(projectCwd).replaceAll("\\", "/");
  const lastSlash = posix.lastIndexOf("/");
  const base = (lastSlash === -1 ? posix : posix.slice(lastSlash + 1)).toLowerCase();
  return base.length > 0 && FOREIGN_OPENCODE_PROJECT_FOLDERS.has(base);
}

/**
 * Cheap sqlite prefilter: keep session rows that might belong to this T3
 * project. Generic launch directories are dropped here; foreign harness
 * folders and symlink spellings are decided by `opencodeSessionMatchesProjectCwd`.
 */
export function openCodeDirectoryMayMatch(sessionCwd: string, projectCwd: string): boolean {
  if (teleportCwdsMatch(sessionCwd, projectCwd)) {
    return true;
  }
  // Only drop generic launch directories here. Foreign harness folders and
  // symlink spellings are decided by `opencodeSessionMatchesProjectCwd`.
  return !isGenericTeleportCwd(sessionCwd);
}

export const opencodeSessionMatchesProjectCwd = Effect.fn("opencodeSessionMatchesProjectCwd")(
  function* (sessionCwd: string, projectCwd: string) {
    if (yield* teleportCwdsEquivalent(sessionCwd, projectCwd)) {
      return true;
    }
    const sessionCanon = yield* canonicalizeTeleportCwd(sessionCwd);
    const projectCanon = yield* canonicalizeTeleportCwd(projectCwd);
    if (isGenericTeleportCwd(sessionCanon) || isForeignOpenCodeProjectFolder(projectCanon)) {
      return false;
    }
    return isTeleportCwdWithin(projectCanon, sessionCanon);
  },
);
