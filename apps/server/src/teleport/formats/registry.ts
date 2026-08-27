import type { TeleportProvider } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

import type { TeleportFormatAdapter } from "./adapter.ts";
import { claudeTeleportFormat } from "./claude.ts";
import { codexTeleportFormat } from "./codex.ts";

export class TeleportFormatRegistry extends Context.Service<
  TeleportFormatRegistry,
  {
    readonly get: (provider: TeleportProvider) => TeleportFormatAdapter | undefined;
    readonly providers: ReadonlyArray<TeleportProvider>;
  }
>()("t3/teleport/formats/registry/TeleportFormatRegistry") {}

/** Exported for tests, which stand a registry up from adapters they supply themselves. */
export function fromAdapters(
  adapters: ReadonlyArray<TeleportFormatAdapter>,
): TeleportFormatRegistry["Service"] {
  const byProvider = new Map(adapters.map((adapter) => [adapter.provider, adapter]));
  return {
    get: (provider) => byProvider.get(provider),
    providers: adapters.map((adapter) => adapter.provider),
  };
}

export const layer = Layer.succeed(
  TeleportFormatRegistry,
  fromAdapters([codexTeleportFormat, claudeTeleportFormat]),
);
