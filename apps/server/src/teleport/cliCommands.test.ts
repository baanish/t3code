import { describe, expect, it } from "vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";

import { buildTeleportExternalCliCommand, shellQuote, toLaunchResult } from "./cliCommands.ts";

describe("buildTeleportExternalCliCommand", () => {
  it("builds provider resume commands without an initial turn", () => {
    expect(
      buildTeleportExternalCliCommand({
        provider: ProviderDriverKind.make("codex"),
        externalSessionId: "019e5e6e-6a3f-7b90-bb41-7bf17abf0e14",
        cwd: "/tmp/codex-project",
      }),
    ).toBe("cd '/tmp/codex-project' && codex resume '019e5e6e-6a3f-7b90-bb41-7bf17abf0e14'");

    expect(
      buildTeleportExternalCliCommand({
        provider: ProviderDriverKind.make("opencode"),
        externalSessionId: "ses_1a1915268ffedTT62Wp32wLxOd",
        cwd: "/tmp/opencode-project",
      }),
    ).toBe(
      "cd '/tmp/opencode-project' && opencode --session 'ses_1a1915268ffedTT62Wp32wLxOd' '/tmp/opencode-project'",
    );

    expect(
      buildTeleportExternalCliCommand({
        provider: ProviderDriverKind.make("cursor"),
        externalSessionId: "cursor-session-1",
        cwd: "/tmp/cursor-project",
      }),
    ).toBe("cd '/tmp/cursor-project' && cursor-agent --resume 'cursor-session-1'");
  });

  it("quotes shell metacharacters", () => {
    expect(shellQuote("/tmp/it's here")).toBe("'/tmp/it'\"'\"'s here'");
  });

  it("builds Windows cmd-compatible resume commands", () => {
    expect(
      buildTeleportExternalCliCommand({
        provider: ProviderDriverKind.make("codex"),
        externalSessionId: "thread 1",
        cwd: "C:\\Users\\Name With Spaces\\project",
        platform: "win32",
      }),
    ).toBe('cd /d "C:\\Users\\Name With Spaces\\project" && codex resume "thread 1"');
  });
});

describe("toLaunchResult", () => {
  it("creates a typed launch result", () => {
    expect(
      toLaunchResult({
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        externalSessionId: "thread-1",
        cwd: "/tmp/project",
        command: "cd '/tmp/project' && codex resume 'thread-1'",
      }),
    ).toMatchObject({
      provider: "codex",
      providerInstanceId: "codex",
      externalSessionId: "thread-1",
      launched: true,
    });
  });
});
