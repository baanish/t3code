import { createTeleportEnvironmentAtoms } from "@t3tools/client-runtime/state/teleport";

import { connectionAtomRuntime } from "../connection/runtime";

export const teleportEnvironment = createTeleportEnvironmentAtoms(connectionAtomRuntime);
