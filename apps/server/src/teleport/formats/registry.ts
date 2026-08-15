import type { TeleportProvider } from "@t3tools/contracts";

import type { TeleportFormatAdapter } from "./adapter.ts";

const adapters = new Map<TeleportProvider, TeleportFormatAdapter>();

export function registerTeleportFormat(adapter: TeleportFormatAdapter): void {
  adapters.set(adapter.provider, adapter);
}

export function getTeleportFormat(provider: TeleportProvider): TeleportFormatAdapter | undefined {
  return adapters.get(provider);
}

export function listRegisteredTeleportProviders(): ReadonlyArray<TeleportProvider> {
  return [...adapters.keys()];
}

export function resetTeleportFormats(): void {
  adapters.clear();
}
