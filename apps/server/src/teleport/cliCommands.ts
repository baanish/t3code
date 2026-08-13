import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderDriverKind,
  type TeleportLaunchExternalSessionResult,
} from "@t3tools/contracts";

export function shellQuote(input: string): string {
  return `'${input.replaceAll("'", `'"'"'`)}'`;
}

function cmdQuote(input: string): string {
  return `"${input.replaceAll('"', '""')}"`;
}

export function buildTeleportExternalCliCommand(input: {
  readonly provider: ProviderDriverKind;
  readonly externalSessionId: string;
  readonly cwd: string;
  readonly platform?: NodeJS.Platform;
}): string {
  const platform = input.platform ?? process.platform;
  const quote = platform === "win32" ? cmdQuote : shellQuote;
  const cwd = quote(input.cwd);
  const sessionId = quote(input.externalSessionId);
  const cd = platform === "win32" ? `cd /d ${cwd}` : `cd ${cwd}`;

  switch (input.provider) {
    case "codex":
      return `${cd} && codex resume ${sessionId}`;
    case "opencode":
      return `${cd} && opencode --session ${sessionId} ${cwd}`;
    case "cursor":
      return `${cd} && cursor-agent --resume ${sessionId}`;
    default:
      throw new Error(
        `Teleport out does not support provider '${PROVIDER_DISPLAY_NAMES[input.provider] ?? input.provider}'.`,
      );
  }
}

export function toLaunchResult(input: {
  readonly provider: ProviderDriverKind;
  readonly providerInstanceId: TeleportLaunchExternalSessionResult["providerInstanceId"];
  readonly externalSessionId: string;
  readonly cwd: string;
  readonly command: string;
}): TeleportLaunchExternalSessionResult {
  return {
    provider: input.provider,
    providerInstanceId: input.providerInstanceId,
    externalSessionId: input.externalSessionId,
    cwd: input.cwd,
    command: input.command,
    launched: true,
  };
}
