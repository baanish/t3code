import type { ServerSettings, ServerSettingsPatch } from "@t3tools/contracts";

export const MASKED_API_KEY_VALUE = "********";

function maskApiKey(value: string): string {
  return value.trim().length > 0 ? MASKED_API_KEY_VALUE : "";
}

function stripMaskedApiKeyValue<T extends { customApiKey?: string }>(value: T): T {
  if (value.customApiKey !== MASKED_API_KEY_VALUE) {
    return value;
  }

  const { customApiKey: _customApiKey, ...rest } = value;
  return rest as T;
}

export function sanitizeServerSettingsForTransport(settings: ServerSettings): ServerSettings {
  return {
    ...settings,
    providers: {
      ...settings.providers,
      claudeAgent: {
        ...settings.providers.claudeAgent,
        customApiKey: maskApiKey(settings.providers.claudeAgent.customApiKey),
      },
    },
  };
}

export function stripMaskedSecretsFromPatch(patch: ServerSettingsPatch): ServerSettingsPatch {
  if (!patch.providers?.claudeAgent) {
    return patch;
  }

  return {
    ...patch,
    providers: {
      ...patch.providers,
      claudeAgent: stripMaskedApiKeyValue(patch.providers.claudeAgent),
    },
  };
}
