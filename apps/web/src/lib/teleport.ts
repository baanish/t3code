import type { TeleportProvider } from "@t3tools/contracts";

export function teleportProviderLabel(provider: TeleportProvider): string {
  switch (provider) {
    case "codex":
      return "Codex";
    case "claudeAgent":
      return "Claude";
    case "opencode":
      return "OpenCode";
    case "grok":
      return "Grok";
    default: {
      const _exhaustive: never = provider;
      return _exhaustive;
    }
  }
}

export function teleportFailureMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message.trim().length > 0
  ) {
    return error.message;
  }
  return "Teleport failed.";
}
