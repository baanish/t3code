import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { createEnvironmentRpcCommand } from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

export function createTeleportEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    listSessions: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:teleport:list-sessions",
      tag: WS_METHODS.teleportListSessions,
    }),
    importSessions: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:teleport:import-sessions",
      tag: WS_METHODS.teleportImportSessions,
    }),
    exportSession: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:teleport:export-session",
      tag: WS_METHODS.teleportExportSession,
    }),
    checkNativeRevision: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:teleport:check-native-revision",
      tag: WS_METHODS.teleportCheckNativeRevision,
    }),
    forkNativeDivergence: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:teleport:fork-native-divergence",
      tag: WS_METHODS.teleportForkNativeDivergence,
    }),
  };
}
