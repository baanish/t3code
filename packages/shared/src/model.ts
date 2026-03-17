import {
  CODEX_REASONING_EFFORT_OPTIONS,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_REASONING_EFFORT_BY_PROVIDER,
  MODEL_OPTIONS_BY_PROVIDER,
  MODEL_SLUG_ALIASES_BY_PROVIDER,
  REASONING_EFFORT_OPTIONS_BY_PROVIDER,
  type CodexReasoningEffort,
  type ModelSlug,
  type ProviderKind,
} from "@t3tools/contracts";

const MODEL_SLUG_SET_BY_PROVIDER: Record<ProviderKind, ReadonlySet<ModelSlug>> = {
  claudeAgent: new Set(MODEL_OPTIONS_BY_PROVIDER.claudeAgent.map((option) => option.slug)),
  codex: new Set(MODEL_OPTIONS_BY_PROVIDER.codex.map((option) => option.slug)),
};

export function getModelOptions(provider: ProviderKind = "codex") {
  return MODEL_OPTIONS_BY_PROVIDER[provider];
}

export function getDefaultModel(provider: ProviderKind = "codex"): ModelSlug {
  return DEFAULT_MODEL_BY_PROVIDER[provider];
}

export function normalizeModelSlug(
  model: string | null | undefined,
  provider: ProviderKind = "codex",
): ModelSlug | null {
  if (typeof model !== "string") {
    return null;
  }

  const trimmed = model.trim();
  if (!trimmed) {
    return null;
  }

  const aliases = MODEL_SLUG_ALIASES_BY_PROVIDER[provider] as Record<string, ModelSlug>;
  const aliased = Object.prototype.hasOwnProperty.call(aliases, trimmed)
    ? aliases[trimmed]
    : undefined;
  return typeof aliased === "string" ? aliased : (trimmed as ModelSlug);
}

export function resolveModelSlug(
  model: string | null | undefined,
  provider: ProviderKind = "codex",
): ModelSlug {
  const normalized = normalizeModelSlug(model, provider);
  if (!normalized) {
    return DEFAULT_MODEL_BY_PROVIDER[provider];
  }

  return MODEL_SLUG_SET_BY_PROVIDER[provider].has(normalized)
    ? normalized
    : DEFAULT_MODEL_BY_PROVIDER[provider];
}

export function resolveModelSlugForProvider(
  provider: ProviderKind,
  model: string | null | undefined,
): ModelSlug {
  return resolveModelSlug(model, provider);
}

export function inferProviderForModel(
  model: string | null | undefined,
  fallback: ProviderKind = "codex",
): ProviderKind {
  const normalizedClaude = normalizeModelSlug(model, "claudeAgent");
  if (normalizedClaude && MODEL_SLUG_SET_BY_PROVIDER.claudeAgent.has(normalizedClaude)) {
    return "claudeAgent";
  }

  const normalizedCodex = normalizeModelSlug(model, "codex");
  if (normalizedCodex && MODEL_SLUG_SET_BY_PROVIDER.codex.has(normalizedCodex)) {
    return "codex";
  }

  return typeof model === "string" && model.trim().startsWith("claude-") ? "claudeAgent" : fallback;
}

export function getReasoningEffortOptions(
  provider: ProviderKind = "codex",
): ReadonlyArray<CodexReasoningEffort> {
  return REASONING_EFFORT_OPTIONS_BY_PROVIDER[provider];
}

export function getDefaultReasoningEffort(provider: "codex"): CodexReasoningEffort;
export function getDefaultReasoningEffort(provider: ProviderKind): CodexReasoningEffort | null;
export function getDefaultReasoningEffort(
  provider: ProviderKind = "codex",
): CodexReasoningEffort | null {
  return DEFAULT_REASONING_EFFORT_BY_PROVIDER[provider];
}

export { CODEX_REASONING_EFFORT_OPTIONS };
