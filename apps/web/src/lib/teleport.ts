import {
  isTeleportProvider,
  isTeleportedOut,
  TELEPORTED_OUT_SEND_DISABLED_REASON,
  TELEPORT_IMPORTING_SEND_DISABLED_REASON,
  TELEPORT_NATIVE_DIVERGENCE_SEND_DISABLED_REASON,
  TELEPORT_NATIVE_MISSING_SEND_DISABLED_REASON,
  TELEPORT_NATIVE_OVERSIZE_SEND_DISABLED_REASON,
  isTeleportNativeRevisionSendDisabledReason,
  isTeleportSendDisabledReason,
  teleportNativeRevisionBlocksMutation,
  teleportNativeRevisionSendDisabledReason,
  teleportSendDisabledReason,
  type ExecutionEnvironmentCapabilities,
  type ProviderInstanceId,
  type TeleportProvider,
} from "@t3tools/contracts";

export {
  isTeleportedOut,
  TELEPORTED_OUT_SEND_DISABLED_REASON,
  TELEPORT_IMPORTING_SEND_DISABLED_REASON,
  TELEPORT_NATIVE_DIVERGENCE_SEND_DISABLED_REASON,
  TELEPORT_NATIVE_MISSING_SEND_DISABLED_REASON,
  TELEPORT_NATIVE_OVERSIZE_SEND_DISABLED_REASON,
  isTeleportNativeRevisionSendDisabledReason,
  isTeleportSendDisabledReason,
  teleportNativeRevisionBlocksMutation,
  teleportNativeRevisionSendDisabledReason,
  teleportSendDisabledReason,
};

export function environmentSupportsTeleport(
  capabilities: ExecutionEnvironmentCapabilities | null | undefined,
): boolean {
  return capabilities?.teleport === true;
}

export function threadSupportsTeleportExport(input: {
  readonly teleportedOut: boolean;
  readonly providerName: string | undefined;
  readonly instanceId: string;
  readonly providers: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId | string;
    readonly driver: string;
  }>;
}): boolean {
  if (input.teleportedOut) {
    return true;
  }
  if (typeof input.providerName === "string" && isTeleportProvider(input.providerName)) {
    return true;
  }
  const instance = input.providers.find((provider) => provider.instanceId === input.instanceId);
  const driver = instance?.driver ?? input.instanceId;
  return isTeleportProvider(driver);
}

export function teleportProviderLabel(provider: TeleportProvider): string {
  switch (provider) {
    case "codex":
      return "Codex";
    case "claudeAgent":
      return "Claude";
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
