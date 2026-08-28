import {
  ClaudeSettings,
  CodexSettings,
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings,
  type TeleportProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

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
): string | undefined {
  return configuredTeleportNativeRootFor(homes, "codex", instanceId);
}

export function resolveClaudeProjectsRootForInstance(
  homes: TeleportHomes,
  instanceId: ProviderInstanceId,
): string | undefined {
  return configuredTeleportNativeRootFor(homes, "claudeAgent", instanceId);
}

export function teleportNativeRootFor(
  homes: TeleportHomes,
  provider: TeleportProvider,
  instanceId: ProviderInstanceId,
): string {
  return (
    configuredTeleportNativeRootFor(homes, provider, instanceId) ??
    fallbackNativeRoot(homes, provider)
  );
}

export function configuredInstanceRootsForProvider(
  homes: TeleportHomes,
  provider: TeleportProvider,
): ReadonlyArray<TeleportInstanceRoot> {
  switch (provider) {
    case "codex":
      return [
        {
          root: homes.codexSessionsRoot,
          instanceId: defaultInstanceIdForDriver(CODEX_DRIVER),
        },
        ...homes.extraCodexSessionsRoots,
      ];
    case "claudeAgent":
      return [
        {
          root: homes.claudeProjectsRoot,
          instanceId: defaultInstanceIdForDriver(CLAUDE_DRIVER),
        },
        ...homes.extraClaudeProjectsRoots,
      ];
    default: {
      const _exhaustive: never = provider;
      return _exhaustive;
    }
  }
}

export function configuredTeleportNativeRootFor(
  homes: TeleportHomes,
  provider: TeleportProvider,
  instanceId: ProviderInstanceId,
): string | undefined {
  const match = configuredInstanceRootsForProvider(homes, provider).find(
    (root) => root.instanceId === instanceId,
  );
  return match?.root;
}

function fallbackNativeRoot(homes: TeleportHomes, provider: TeleportProvider): string {
  switch (provider) {
    case "codex":
      return homes.codexSessionsRoot;
    case "claudeAgent":
      return homes.claudeProjectsRoot;
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

export const canonicalizeTeleportNativePath = Effect.fn("canonicalizeTeleportNativePath")(
  function* (value: string): Effect.fn.Return<string, never, FileSystem.FileSystem | Path.Path> {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const resolved = path.resolve(value);
    return yield* fs.realPath(resolved).pipe(Effect.orElseSucceed(() => resolved));
  },
);

export const canonicalizeTeleportNativeWritePath = Effect.fn("canonicalizeTeleportNativeWritePath")(
  function* (value: string): Effect.fn.Return<string, never, FileSystem.FileSystem | Path.Path> {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const resolved = path.resolve(value);
    return yield* fs.realPath(resolved).pipe(
      Effect.catch(() =>
        fs.realPath(path.dirname(resolved)).pipe(
          Effect.orElseSucceed(() => path.dirname(resolved)),
          Effect.map((parent) => path.join(parent, path.basename(resolved))),
        ),
      ),
    );
  },
);

export function claudeSearchRoots(homes: TeleportHomes): ReadonlyArray<TeleportInstanceRoot> {
  return uniqueInstanceRoots([
    {
      root: homes.claudeProjectsRoot,
      instanceId: defaultInstanceIdForDriver(CLAUDE_DRIVER),
    },
    ...homes.extraClaudeProjectsRoots,
  ]);
}

function decodeCodexInstanceSettings(config: unknown): CodexSettings | undefined {
  return Option.getOrUndefined(Schema.decodeUnknownOption(CodexSettings)(config ?? {}));
}

function decodeClaudeInstanceSettings(config: unknown): ClaudeSettings | undefined {
  return Option.getOrUndefined(Schema.decodeUnknownOption(ClaudeSettings)(config ?? {}));
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
  return decodeCodexInstanceSettings(envelope.config) ?? settings.providers.codex;
}

function claudeSettingsForInstance(
  settings: ServerSettings,
  instanceId: ProviderInstanceId,
): Pick<ClaudeSettings, "homePath"> {
  const envelope = settings.providerInstances[instanceId];
  if (envelope === undefined || envelope.driver !== CLAUDE_DRIVER) {
    return settings.providers.claudeAgent;
  }
  return decodeClaudeInstanceSettings(envelope.config) ?? settings.providers.claudeAgent;
}

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
    const claudeSettings = claudeSettingsForInstance(settings, instanceId);
    const claudeHome = yield* resolveClaudeHomePath(claudeSettings);
    const projectsRoot =
      claudeSettings.homePath.trim().length === 0
        ? path.join(claudeHome, ".claude", "projects")
        : path.join(claudeHome, "projects");
    if (instanceId === defaultClaudeId) {
      claudeProjectsRoot = projectsRoot;
      continue;
    }
    extraClaudeProjectsRoots.push({ root: projectsRoot, instanceId });
  }

  return {
    codexSessionsRoot,
    extraCodexSessionsRoots,
    claudeProjectsRoot,
    extraClaudeProjectsRoots,
  };
});
