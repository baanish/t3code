import {
  ProviderDriverKind,
  ProviderInstanceId,
  type TeleportSessionCandidate,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import type { ProviderInstanceEntry } from "../../providerInstances";
import {
  buildTeleportCandidateModelSelection,
  buildTeleportModelSelection,
  filterTeleportProviderEntries,
  formatTeleportSessionSubtitle,
  providerSessionIdLabel,
  prioritizeTeleportSessions,
} from "./teleportForm";

function makeProviderEntry(
  input: Omit<Partial<ProviderInstanceEntry>, "instanceId" | "driverKind"> & {
    readonly instanceId: string;
    readonly driverKind: string;
  },
): ProviderInstanceEntry {
  const { instanceId, driverKind, ...overrides } = input;
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driverKind: ProviderDriverKind.make(driverKind),
    displayName: instanceId,
    enabled: true,
    installed: true,
    status: "ready",
    isDefault: false,
    isAvailable: true,
    snapshot: {} as ProviderInstanceEntry["snapshot"],
    models: [],
    ...overrides,
  };
}

function makeCandidate(input: {
  readonly provider: string;
  readonly externalSessionId: string;
  readonly cwd?: string;
}): TeleportSessionCandidate {
  return {
    provider: ProviderDriverKind.make(input.provider),
    providerInstanceId: ProviderInstanceId.make(input.provider),
    externalSessionId: input.externalSessionId,
    cwd: input.cwd ?? "/tmp/project",
    availability: "stopped",
  };
}

describe("teleportForm", () => {
  it("keeps only installed, enabled, available Teleport providers", () => {
    const entries = filterTeleportProviderEntries([
      makeProviderEntry({ instanceId: "codex", driverKind: "codex" }),
      makeProviderEntry({ instanceId: "cursor", driverKind: "cursor", installed: false }),
      makeProviderEntry({ instanceId: "opencode", driverKind: "opencode", enabled: false }),
      makeProviderEntry({
        instanceId: "claudeAgent",
        driverKind: "claudeAgent",
      }),
      makeProviderEntry({
        instanceId: "codex_shadow",
        driverKind: "codex",
        isAvailable: false,
      }),
    ]);

    expect(entries.map((entry) => entry.instanceId)).toEqual([ProviderInstanceId.make("codex")]);
  });

  it("builds model selections for the chosen provider instance", () => {
    const provider = makeProviderEntry({
      instanceId: "opencode",
      driverKind: "opencode",
    });

    expect(
      buildTeleportModelSelection({
        provider,
        model: "cpamc/Kimi-K2.6-Turbo",
      }),
    ).toEqual({
      instanceId: ProviderInstanceId.make("opencode"),
      model: "cpamc/Kimi-K2.6-Turbo",
    });

    expect(
      buildTeleportModelSelection({
        provider,
        model: " ",
        fallback: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4-mini",
        },
      }),
    ).toBeUndefined();
  });

  it("rebinds scanned session models to the provider instance used for import", () => {
    const provider = makeProviderEntry({
      instanceId: "opencode_custom",
      driverKind: "opencode",
    });

    expect(
      buildTeleportCandidateModelSelection({
        provider,
        candidateModelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "openrouter/moonshotai/kimi-k2.6-turbo",
        },
        model: " ",
      }),
    ).toEqual({
      instanceId: ProviderInstanceId.make("opencode_custom"),
      model: "openrouter/moonshotai/kimi-k2.6-turbo",
    });
  });

  it("uses provider-specific external id labels", () => {
    expect(providerSessionIdLabel(ProviderDriverKind.make("codex"))).toBe("External thread id");
    expect(providerSessionIdLabel(ProviderDriverKind.make("opencode"))).toBe("External session id");
  });

  it("prioritizes scanned sessions for the selected provider instance", () => {
    const sessions = [
      makeCandidate({ provider: "codex", externalSessionId: "codex-1" }),
      makeCandidate({ provider: "opencode", externalSessionId: "opencode-1" }),
      makeCandidate({ provider: "cursor", externalSessionId: "cursor-1" }),
      makeCandidate({ provider: "opencode", externalSessionId: "opencode-2" }),
    ];

    expect(
      prioritizeTeleportSessions(sessions, ProviderInstanceId.make("opencode")).map(
        (session) => session.externalSessionId,
      ),
    ).toEqual(["opencode-1", "opencode-2", "codex-1", "cursor-1"]);
  });

  it("formats session subtitles with a short id for disambiguation", () => {
    expect(
      formatTeleportSessionSubtitle({
        providerLabel: "Codex",
        session: makeCandidate({
          provider: "codex",
          externalSessionId: "019e6047-7385-7113-b3ae-7a065113c18b",
          cwd: "/tmp/project",
        }),
      }),
    ).toBe("Codex · 019e6047 · /tmp/project");
  });
});
