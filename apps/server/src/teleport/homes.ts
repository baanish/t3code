// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";

import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  ProviderInstanceId,
  type ClaudeSettings,
  type CodexSettings,
  type ServerSettings,
  type TeleportProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { expandHomePath } from "../pathExpansion.ts";
import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";

const CODEX_DRIVER = ProviderDriverKind.make("codex");
const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");

export interface TeleportInstanceRoot {
  readonly root: string;
  readonly instanceId: ProviderInstanceId;
}

export interface TeleportHomes {
  readonly codexSessionsRoot: string;
  readonly extraCodexSessionsRoots: ReadonlyArray<TeleportInstanceRoot>;
  readonly claudeProjectsRoot: string;
  readonly extraClaudeProjectsRoots: ReadonlyArray<TeleportInstanceRoot>;
  readonly opencodeRoot: string;
  readonly grokSessionsRoot: string;
}

function uniqueInstanceRoots(
  roots: ReadonlyArray<TeleportInstanceRoot>,
): ReadonlyArray<TeleportInstanceRoot> {
  const seen = new Set<string>();
  const unique: TeleportInstanceRoot[] = [];
  for (const root of roots) {
    if (seen.has(root.root)) {
      continue;
    }
    seen.add(root.root);
    unique.push(root);
  }
  return unique;
}

export function codexSearchRoots(homes: TeleportHomes): ReadonlyArray<TeleportInstanceRoot> {
  return uniqueInstanceRoots([
    {
      root: homes.codexSessionsRoot,
      instanceId: defaultInstanceIdForDriver(CODEX_DRIVER),
    },
    ...homes.extraCodexSessionsRoots,
  ]);
}

export function resolveCodexSessionsRoot(
  homes: TeleportHomes,
  instanceId: ProviderInstanceId,
): string {
  return (
    homes.extraCodexSessionsRoots.find((root) => root.instanceId === instanceId)?.root ??
    homes.codexSessionsRoot
  );
}

export function resolveClaudeProjectsRootForInstance(
  homes: TeleportHomes,
  instanceId: ProviderInstanceId,
): string {
  return (
    homes.extraClaudeProjectsRoots.find((root) => root.instanceId === instanceId)?.root ??
    homes.claudeProjectsRoot
  );
}

export function teleportNativeRootFor(
  homes: TeleportHomes,
  provider: TeleportProvider,
  instanceId: ProviderInstanceId,
): string {
  switch (provider) {
    case "codex":
      return resolveCodexSessionsRoot(homes, instanceId);
    case "claudeAgent":
      return resolveClaudeProjectsRootForInstance(homes, instanceId);
    case "opencode":
      return homes.opencodeRoot;
    case "grok":
      return homes.grokSessionsRoot;
    default: {
      const _exhaustive: never = provider;
      return _exhaustive;
    }
  }
}

export function nativePathIsUnderRoot(nativePath: string, root: string): boolean {
  const normalizedPath = nativePath.replaceAll("\\", "/");
  const normalizedRoot = root.replaceAll("\\", "/").replace(/\/+$/u, "");
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

export function claudeSearchRoots(homes: TeleportHomes): ReadonlyArray<TeleportInstanceRoot> {
  return uniqueInstanceRoots([
    {
      root: homes.claudeProjectsRoot,
      instanceId: defaultInstanceIdForDriver(CLAUDE_DRIVER),
    },
    ...homes.extraClaudeProjectsRoots,
  ]);
}

function instanceConfigString(config: unknown, key: string): string | undefined {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    return undefined;
  }
  const value = (config as Record<string, unknown>)[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function instanceIdsForDriver(
  settings: ServerSettings,
  driver: ProviderDriverKind,
): ReadonlyArray<ProviderInstanceId> {
  const ids = [defaultInstanceIdForDriver(driver)];
  const seen = new Set<string>(ids);
  for (const [instanceId, envelope] of Object.entries(settings.providerInstances)) {
    if (envelope.driver !== driver || seen.has(instanceId)) {
      continue;
    }
    seen.add(instanceId);
    ids.push(ProviderInstanceId.make(instanceId));
  }
  return ids;
}

function codexSettingsForInstance(
  settings: ServerSettings,
  instanceId: ProviderInstanceId,
): CodexSettings {
  const envelope = settings.providerInstances[instanceId];
  if (envelope === undefined || envelope.driver !== CODEX_DRIVER) {
    return settings.providers.codex;
  }
  return {
    ...settings.providers.codex,
    homePath:
      instanceConfigString(envelope.config, "homePath") ?? settings.providers.codex.homePath,
    shadowHomePath:
      instanceConfigString(envelope.config, "shadowHomePath") ??
      settings.providers.codex.shadowHomePath,
  };
}

function claudeSettingsForInstance(
  settings: ServerSettings,
  instanceId: ProviderInstanceId,
): Pick<ClaudeSettings, "homePath"> {
  const envelope = settings.providerInstances[instanceId];
  if (envelope === undefined || envelope.driver !== CLAUDE_DRIVER) {
    return settings.providers.claudeAgent;
  }
  return {
    homePath:
      instanceConfigString(envelope.config, "homePath") ?? settings.providers.claudeAgent.homePath,
  };
}

const resolveClaudeProjectsRoot = Effect.fn("resolveClaudeProjectsRoot")(function* (
  claudeHome: string,
): Effect.fn.Return<string, never, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const nestedClaude = path.join(claudeHome, ".claude", "projects");
  const nestedExists = yield* fs.exists(nestedClaude).pipe(Effect.orElseSucceed(() => false));
  return nestedExists ? nestedClaude : path.join(claudeHome, "projects");
});

export const resolveTeleportHomes = Effect.fn("resolveTeleportHomes")(function* (
  settings: ServerSettings,
): Effect.fn.Return<TeleportHomes, never, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  const defaultCodexId = defaultInstanceIdForDriver(CODEX_DRIVER);
  const defaultClaudeId = defaultInstanceIdForDriver(CLAUDE_DRIVER);

  let codexSessionsRoot = "";
  const extraCodexSessionsRoots: TeleportInstanceRoot[] = [];
  for (const instanceId of instanceIdsForDriver(settings, CODEX_DRIVER)) {
    const layout = yield* resolveCodexHomeLayout(codexSettingsForInstance(settings, instanceId));
    const sessionsRoot = path.join(layout.sharedHomePath, "sessions");
    if (instanceId === defaultCodexId) {
      codexSessionsRoot = sessionsRoot;
      continue;
    }
    extraCodexSessionsRoots.push({ root: sessionsRoot, instanceId });
  }

  let claudeProjectsRoot = "";
  const extraClaudeProjectsRoots: TeleportInstanceRoot[] = [];
  for (const instanceId of instanceIdsForDriver(settings, CLAUDE_DRIVER)) {
    const claudeHome = yield* resolveClaudeHomePath(
      claudeSettingsForInstance(settings, instanceId),
    );
    const projectsRoot = yield* resolveClaudeProjectsRoot(claudeHome);
    if (instanceId === defaultClaudeId) {
      claudeProjectsRoot = projectsRoot;
      continue;
    }
    extraClaudeProjectsRoots.push({ root: projectsRoot, instanceId });
  }

  // OpenCode stores sessions at ~/.local/share/opencode on macOS/Linux and
  // %USERPROFILE%\.local\share\opencode on Windows. XDG_DATA_HOME still wins.
  const xdgData =
    process.env.XDG_DATA_HOME && process.env.XDG_DATA_HOME.trim().length > 0
      ? expandHomePath(process.env.XDG_DATA_HOME)
      : path.join(NodeOS.homedir(), ".local", "share");

  return {
    codexSessionsRoot,
    extraCodexSessionsRoots: extraCodexSessionsRoots.filter(
      (root) => root.root !== codexSessionsRoot,
    ),
    claudeProjectsRoot,
    extraClaudeProjectsRoots: extraClaudeProjectsRoots.filter(
      (root) => root.root !== claudeProjectsRoot,
    ),
    opencodeRoot: path.join(xdgData, "opencode"),
    grokSessionsRoot: path.join(NodeOS.homedir(), ".grok", "sessions"),
  };
});
