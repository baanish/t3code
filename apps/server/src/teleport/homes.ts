// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";

import type { ServerSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { expandHomePath } from "../pathExpansion.ts";
import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";

export interface TeleportHomes {
  readonly codexSessionsRoot: string;
  readonly claudeProjectsRoot: string;
  readonly opencodeRoot: string;
  readonly grokSessionsRoot: string;
}

export const resolveTeleportHomes = Effect.fn("resolveTeleportHomes")(function* (
  settings: ServerSettings,
): Effect.fn.Return<TeleportHomes, never, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const codexLayout = yield* resolveCodexHomeLayout(settings.providers.codex);
  const claudeHome = yield* resolveClaudeHomePath(settings.providers.claudeAgent);
  const nestedClaude = path.join(claudeHome, ".claude", "projects");
  const nestedExists = yield* fs.exists(nestedClaude).pipe(Effect.orElseSucceed(() => false));
  const claudeProjectsRoot = nestedExists ? nestedClaude : path.join(claudeHome, "projects");
  const xdgData =
    process.env.XDG_DATA_HOME && process.env.XDG_DATA_HOME.trim().length > 0
      ? expandHomePath(process.env.XDG_DATA_HOME)
      : path.join(NodeOS.homedir(), ".local", "share");

  return {
    codexSessionsRoot: path.join(codexLayout.sharedHomePath, "sessions"),
    claudeProjectsRoot,
    opencodeRoot: path.join(xdgData, "opencode"),
    grokSessionsRoot: path.join(NodeOS.homedir(), ".grok", "sessions"),
  };
});
