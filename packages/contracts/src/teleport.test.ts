import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";

import {
  TeleportImportSessionInput,
  TeleportImportSessionResult,
  TeleportLaunchExternalSessionInput,
  TeleportLaunchExternalSessionResult,
  TeleportListSessionsInput,
  TeleportListSessionsResult,
  TeleportExternalLaunchError,
  TeleportInvalidInputError,
  TeleportOpenCodeUnsupportedResumeError,
  TeleportSessionCandidate,
  TeleportUnsupportedProviderError,
} from "./teleport.ts";

const decodeInput = Schema.decodeUnknownSync(TeleportImportSessionInput);
const decodeResult = Schema.decodeUnknownSync(TeleportImportSessionResult);
const decodeListInput = Schema.decodeUnknownSync(TeleportListSessionsInput);
const decodeSessionCandidate = Schema.decodeUnknownSync(TeleportSessionCandidate);
const decodeListResult = Schema.decodeUnknownSync(TeleportListSessionsResult);
const decodeLaunchInput = Schema.decodeUnknownSync(TeleportLaunchExternalSessionInput);
const decodeLaunchResult = Schema.decodeUnknownSync(TeleportLaunchExternalSessionResult);
const decodeUnsupportedProvider = Schema.decodeUnknownSync(TeleportUnsupportedProviderError);
const decodeInvalidInput = Schema.decodeUnknownSync(TeleportInvalidInputError);
const decodeOpenCodeUnsupported = Schema.decodeUnknownSync(TeleportOpenCodeUnsupportedResumeError);
const decodeExternalLaunch = Schema.decodeUnknownSync(TeleportExternalLaunchError);

describe("TeleportImportSessionInput", () => {
  it("accepts strict import fields and decodes defaults", () => {
    const parsed = decodeInput({
      providerInstanceId: "codex",
      provider: "codex",
      externalSessionId: "codex-thread-1",
      cwd: "/tmp/project",
    });

    expect(parsed.providerInstanceId).toBe("codex");
    expect(parsed.provider).toBe("codex");
    expect(parsed.externalSessionId).toBe("codex-thread-1");
    expect(parsed.runtimeMode).toBe("full-access");
    expect(parsed.interactionMode).toBe("default");
    expect(parsed.startSession).toBe(true);
  });

  it("accepts optional model, title, and explicit thread/project bindings", () => {
    const parsed = decodeInput({
      providerInstanceId: "cursor",
      provider: "cursor",
      externalSessionId: "cursor-session-1",
      cwd: "/tmp/project",
      projectId: "project-1",
      threadId: "thread-1",
      title: "Imported Cursor thread",
      runtimeMode: "approval-required",
      interactionMode: "plan",
      startSession: false,
      modelSelection: {
        instanceId: "cursor",
        model: "composer-2",
      },
    });

    expect(parsed.projectId).toBe("project-1");
    expect(parsed.threadId).toBe("thread-1");
    expect(parsed.title).toBe("Imported Cursor thread");
    expect(parsed.runtimeMode).toBe("approval-required");
    expect(parsed.interactionMode).toBe("plan");
    expect(parsed.startSession).toBe(false);
    expect(parsed.modelSelection?.model).toBe("composer-2");
  });

  it("rejects blank external session ids", () => {
    expect(() =>
      decodeInput({
        providerInstanceId: "opencode",
        provider: "opencode",
        externalSessionId: " ",
        cwd: "/tmp/project",
      }),
    ).toThrow();
  });
});

describe("TeleportImportSessionResult", () => {
  it("preserves opaque provider resume cursors", () => {
    const parsed = decodeResult({
      threadId: "thread-1",
      projectId: "project-1",
      provider: "opencode",
      providerInstanceId: "opencode",
      externalSessionId: "session-1",
      resumeCursor: { schemaVersion: 1, sessionId: "session-1" },
      started: true,
    });

    expect(parsed.resumeCursor).toEqual({ schemaVersion: 1, sessionId: "session-1" });
  });
});

describe("Teleport session discovery", () => {
  it("accepts optional provider filters", () => {
    const parsed = decodeListInput({ providers: ["codex", "opencode", "cursor"] });

    expect(parsed.providers).toEqual(["codex", "opencode", "cursor"]);
  });

  it("decodes discovered session candidates with default availability", () => {
    const parsed = decodeSessionCandidate({
      provider: "opencode",
      providerInstanceId: "opencode",
      externalSessionId: "ses_123",
      cwd: "/tmp/project",
      title: "Imported work",
      updatedAt: "2026-05-25T13:00:00.000Z",
      modelSelection: {
        instanceId: "opencode",
        model: "cliproxy/Kimi-K2.6-Turbo",
      },
    });

    expect(parsed.availability).toBe("unknown");
    expect(parsed.modelSelection?.model).toBe("cliproxy/Kimi-K2.6-Turbo");
  });

  it("wraps candidates in list results", () => {
    const parsed = decodeListResult({
      sessions: [
        {
          provider: "codex",
          providerInstanceId: "codex",
          externalSessionId: "019e5e6e-6a3f-7b90-bb41-7bf17abf0e14",
          cwd: "/tmp/project",
          availability: "stopped",
        },
      ],
    });

    expect(parsed.sessions[0]?.provider).toBe("codex");
  });
});

describe("Teleport external launch", () => {
  it("decodes launch inputs and results", () => {
    expect(decodeLaunchInput({ threadId: "thread-1" }).threadId).toBe("thread-1");

    const result = decodeLaunchResult({
      provider: "cursor",
      providerInstanceId: "cursor",
      externalSessionId: "cursor-session-1",
      cwd: "/tmp/project",
      command: "cd /tmp/project && cursor-agent --resume cursor-session-1",
      launched: true,
    });

    expect(result.launched).toBe(true);
    expect(result.provider).toBe("cursor");
  });
});

describe("Teleport errors", () => {
  it("decode typed error payloads", () => {
    expect(
      decodeUnsupportedProvider({
        _tag: "TeleportUnsupportedProviderError",
        provider: "claudeAgent",
        message: "Teleport import does not support provider 'claudeAgent'.",
      }).provider,
    ).toBe("claudeAgent");

    expect(
      decodeInvalidInput({
        _tag: "TeleportInvalidInputError",
        message: "Invalid import request.",
      }).message,
    ).toBe("Invalid import request.");

    expect(
      decodeOpenCodeUnsupported({
        _tag: "TeleportOpenCodeUnsupportedResumeError",
        message: "Installed OpenCode SDK/server cannot resume sessions by id.",
      }).message,
    ).toContain("OpenCode");

    expect(
      decodeExternalLaunch({
        _tag: "TeleportExternalLaunchError",
        provider: "opencode",
        message: "Failed to launch OpenCode.",
      }).provider,
    ).toBe("opencode");
  });
});
