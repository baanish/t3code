import {
  ProviderDriverKind,
  type ModelSelection,
  type TeleportSessionCandidate,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import { sortProviderInstanceEntries, type ProviderInstanceEntry } from "../../providerInstances";

const SUPPORTED_TELEPORT_DRIVERS = new Set(["codex", "cursor", "opencode"]);

export function isTeleportProviderEntry(entry: ProviderInstanceEntry): boolean {
  return (
    entry.enabled &&
    entry.installed &&
    entry.isAvailable &&
    SUPPORTED_TELEPORT_DRIVERS.has(String(entry.driverKind))
  );
}

export function filterTeleportProviderEntries(
  entries: ReadonlyArray<ProviderInstanceEntry>,
): ReadonlyArray<ProviderInstanceEntry> {
  return sortProviderInstanceEntries(entries.filter(isTeleportProviderEntry));
}

export function buildTeleportModelSelection(input: {
  readonly provider: ProviderInstanceEntry;
  readonly model: string;
  readonly fallback?: ModelSelection | null | undefined;
}): ModelSelection | undefined {
  const model = input.model.trim();
  if (model) {
    return createModelSelection(input.provider.instanceId, model);
  }
  if (input.fallback?.instanceId === input.provider.instanceId) {
    return input.fallback;
  }
  return undefined;
}

export function buildTeleportCandidateModelSelection(input: {
  readonly provider: ProviderInstanceEntry;
  readonly candidateModelSelection?: ModelSelection | undefined;
  readonly model: string;
  readonly fallback?: ModelSelection | null | undefined;
}): ModelSelection | undefined {
  const explicitSelection = buildTeleportModelSelection({
    provider: input.provider,
    model: input.model,
    fallback: undefined,
  });
  if (explicitSelection) {
    return explicitSelection;
  }
  if (input.candidateModelSelection) {
    return createModelSelection(
      input.provider.instanceId,
      input.candidateModelSelection.model,
      input.candidateModelSelection.options,
    );
  }
  return buildTeleportModelSelection({
    provider: input.provider,
    model: "",
    fallback: input.fallback,
  });
}

export function providerSessionIdLabel(provider: ProviderDriverKind): string {
  return provider === ProviderDriverKind.make("codex")
    ? "External thread id"
    : "External session id";
}

export function prioritizeTeleportSessions(
  sessions: ReadonlyArray<TeleportSessionCandidate>,
  selectedProviderInstanceId: string | undefined,
): ReadonlyArray<TeleportSessionCandidate> {
  if (!selectedProviderInstanceId) {
    return sessions;
  }
  return sessions.toSorted((left, right) => {
    const leftMatches = left.providerInstanceId === selectedProviderInstanceId ? 1 : 0;
    const rightMatches = right.providerInstanceId === selectedProviderInstanceId ? 1 : 0;
    return rightMatches - leftMatches;
  });
}

function shortTeleportSessionId(externalSessionId: string): string {
  return externalSessionId.length > 8 ? externalSessionId.slice(0, 8) : externalSessionId;
}

export function formatTeleportSessionSubtitle(input: {
  readonly providerLabel: string;
  readonly session: TeleportSessionCandidate;
}): string {
  return `${input.providerLabel} · ${shortTeleportSessionId(input.session.externalSessionId)} · ${
    input.session.cwd
  }`;
}
