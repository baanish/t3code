import { WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

export const teleportEnvironment = {
  exportSession: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:teleport:export-session",
    tag: WS_METHODS.teleportExportSession,
  }),
  importSession: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:teleport:import-session",
    tag: WS_METHODS.teleportImportSession,
  }),
};
