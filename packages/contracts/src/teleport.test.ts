import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ProjectId, ThreadId } from "./baseSchemas.ts";
import { ProviderDriverKind } from "./providerInstance.ts";
import {
  isTeleportedOut,
  isTeleportProvider,
  resolveTeleportPresence,
  TELEPORTED_OUT_SEND_DISABLED_REASON,
  TELEPORT_IMPORTING_SEND_DISABLED_REASON,
  isTeleportSendDisabledReason,
  isTeleportNativeRevisionSendDisabledReason,
  isCanonicalTeleportBinding,
  teleportNativeRevisionBlocksMutation,
  teleportNativeRevisionSendDisabledReason,
  teleportSendDisabledReason,
  TELEPORT_NATIVE_DIVERGENCE_SEND_DISABLED_REASON,
  TELEPORT_NATIVE_MISSING_SEND_DISABLED_REASON,
  TELEPORT_NATIVE_OVERSIZE_SEND_DISABLED_REASON,
  TeleportNativeDivergenceError,
  TeleportDiscoveryError,
  TeleportExportError,
  TeleportFileLockedError,
  TeleportIdentityConflictError,
  TeleportInvalidInputError,
  TeleportLockProbeError,
  TeleportNativeWriteError,
  TeleportRuntimePayload,
  TeleportSchemaVersionError,
  TeleportThreadState,
  TeleportUnsupportedProviderError,
} from "./teleport.ts";

const decodeTeleportThreadState = Schema.decodeUnknownSync(TeleportThreadState);
const decodeTeleportRuntimePayload = Schema.decodeUnknownSync(TeleportRuntimePayload);
const decodeTeleportExportError = Schema.decodeUnknownSync(TeleportExportError);

describe("teleport providers", () => {
  it("supports Codex and Claude native CLIs only", () => {
    expect(isTeleportProvider("codex")).toBe(true);
    expect(isTeleportProvider("claudeAgent")).toBe(true);
    expect(isTeleportProvider("grok")).toBe(false);
    expect(isTeleportProvider("opencode")).toBe(false);
  });
});

describe("teleport presence", () => {
  it("decodes a complete thread teleport state", () => {
    const parsed = decodeTeleportThreadState({
      presence: "native",
      provider: "codex",
      externalSessionId: "session-1",
      nativePath: "/home/user/.codex/sessions/session-1",
      lastSyncedAt: "2026-08-14T22:00:00.000Z",
    });
    expect(parsed.presence).toBe("native");
    expect(parsed.provider).toBe("codex");
  });

  it("decodes importing presence and restorePresence", () => {
    const parsed = decodeTeleportThreadState({
      presence: "importing",
      provider: "codex",
      externalSessionId: "session-1",
      nativePath: "/tmp/session.jsonl",
      lastSyncedAt: "2026-08-14T22:00:00.000Z",
      restorePresence: "native",
    });
    expect(parsed.presence).toBe("importing");
    expect(parsed.restorePresence).toBe("native");
  });

  it("uses an explicit presence on the runtime payload", () => {
    const parsed = decodeTeleportRuntimePayload({
      schemaVersion: 1,
      externalSessionId: "session-1",
      nativePath: "/tmp/session.jsonl",
      lastSyncDirection: "export",
      lastSyncedAt: "2026-08-14T22:00:00.000Z",
      nativeFormatVersion: 1,
      presence: "t3",
    });
    expect(resolveTeleportPresence(parsed)).toBe("t3");
  });

  it("treats a legacy export as native presence", () => {
    const parsed = decodeTeleportRuntimePayload({
      schemaVersion: 1,
      externalSessionId: "session-1",
      nativePath: "/tmp/session.jsonl",
      lastSyncDirection: "export",
      lastSyncedAt: "2026-08-14T22:00:00.000Z",
      nativeFormatVersion: 1,
    });
    expect(parsed.presence).toBeUndefined();
    expect(resolveTeleportPresence(parsed)).toBe("native");
  });

  it("treats a legacy import as t3 presence", () => {
    expect(
      resolveTeleportPresence({
        lastSyncDirection: "import",
      }),
    ).toBe("t3");
  });

  it("reports native presence as teleported out", () => {
    expect(
      isTeleportedOut({
        presence: "native",
        provider: "codex",
        externalSessionId: "session-1",
        nativePath: "/tmp/session.jsonl",
        lastSyncedAt: "2026-08-14T22:00:00.000Z",
      }),
    ).toBe(true);
    expect(TELEPORTED_OUT_SEND_DISABLED_REASON.length).toBeGreaterThan(0);
  });

  it("treats importing presence as teleported-out for composer and import retry", () => {
    expect(
      isTeleportedOut({
        presence: "importing",
        provider: "codex",
        externalSessionId: "session-1",
        nativePath: "/tmp/session.jsonl",
        lastSyncedAt: "2026-08-14T22:00:00.000Z",
        restorePresence: "native",
      }),
    ).toBe(true);
  });

  it("uses a distinct send-disabled reason while import is in progress", () => {
    expect(
      teleportSendDisabledReason({
        presence: "importing",
        provider: "codex",
        externalSessionId: "session-1",
        nativePath: "/tmp/session.jsonl",
        lastSyncedAt: "2026-08-14T22:00:00.000Z",
      }),
    ).toBe(TELEPORT_IMPORTING_SEND_DISABLED_REASON);
    expect(
      teleportSendDisabledReason({
        presence: "native",
        provider: "codex",
        externalSessionId: "session-1",
        nativePath: "/tmp/session.jsonl",
        lastSyncedAt: "2026-08-14T22:00:00.000Z",
      }),
    ).toBe(TELEPORTED_OUT_SEND_DISABLED_REASON);
  });

  it("identifies teleport send-disabled reasons for post-await composer guards", () => {
    expect(isTeleportSendDisabledReason(TELEPORTED_OUT_SEND_DISABLED_REASON)).toBe(true);
    expect(isTeleportSendDisabledReason(TELEPORT_IMPORTING_SEND_DISABLED_REASON)).toBe(true);
    expect(isTeleportSendDisabledReason("Messages loading")).toBe(false);
    expect(isTeleportSendDisabledReason(null)).toBe(false);
  });

  it("decodes a persisted native revision and a fork pointer", () => {
    const parsed = decodeTeleportThreadState({
      presence: "t3",
      provider: "claudeAgent",
      externalSessionId: "session-1",
      nativePath: "/tmp/session.jsonl",
      lastSyncedAt: "2026-08-14T22:00:00.000Z",
      nativeRevision: {
        algorithm: "sha256",
        digest: "abc",
        byteLength: 12,
      },
      forkedFromThreadId: "thread-source",
    });
    expect(parsed.nativeRevision?.digest).toBe("abc");
    expect(parsed.forkedFromThreadId).toBe("thread-source");
    expect(isCanonicalTeleportBinding(parsed)).toBe(false);
  });

  it("blocks send for diverged or missing native files without locking teleported-out drafts", () => {
    expect(teleportNativeRevisionBlocksMutation("diverged")).toBe(true);
    expect(teleportNativeRevisionBlocksMutation("missing")).toBe(true);
    expect(teleportNativeRevisionBlocksMutation("oversize")).toBe(true);
    expect(teleportNativeRevisionBlocksMutation("unchanged")).toBe(false);
    expect(teleportNativeRevisionBlocksMutation("forked")).toBe(false);
    expect(teleportNativeRevisionSendDisabledReason("diverged")).toBe(
      TELEPORT_NATIVE_DIVERGENCE_SEND_DISABLED_REASON,
    );
    expect(teleportNativeRevisionSendDisabledReason("missing")).toBe(
      TELEPORT_NATIVE_MISSING_SEND_DISABLED_REASON,
    );
    expect(teleportNativeRevisionSendDisabledReason("oversize")).toBe(
      TELEPORT_NATIVE_OVERSIZE_SEND_DISABLED_REASON,
    );
    expect(
      isTeleportNativeRevisionSendDisabledReason(TELEPORT_NATIVE_DIVERGENCE_SEND_DISABLED_REASON),
    ).toBe(true);
    expect(isTeleportSendDisabledReason(TELEPORT_NATIVE_DIVERGENCE_SEND_DISABLED_REASON)).toBe(
      false,
    );
  });

  it("derives TeleportNativeDivergenceError.message from the kind", () => {
    const diverged = new TeleportNativeDivergenceError({
      threadId: ThreadId.make("thread-1"),
      kind: "diverged",
      nativePath: "/tmp/session.jsonl",
      persistedDigest: "abc",
      observedDigest: "def",
    });
    expect(diverged.message).toBe(TELEPORT_NATIVE_DIVERGENCE_SEND_DISABLED_REASON);
    const missing = new TeleportNativeDivergenceError({
      threadId: ThreadId.make("thread-1"),
      kind: "missing",
      nativePath: "/tmp/session.jsonl",
    });
    expect(missing.message).toBe(TELEPORT_NATIVE_MISSING_SEND_DISABLED_REASON);
    const oversize = new TeleportNativeDivergenceError({
      threadId: ThreadId.make("thread-1"),
      kind: "oversize",
      nativePath: "/tmp/session.jsonl",
    });
    expect(oversize.message).toBe(TELEPORT_NATIVE_OVERSIZE_SEND_DISABLED_REASON);
  });
});

describe("teleport lock probe errors", () => {
  it("are part of the export error union", () => {
    const parsed = decodeTeleportExportError({
      _tag: "TeleportLockProbeError",
      nativePath: "/tmp/session.jsonl",
    });
    expect(parsed._tag).toBe("TeleportLockProbeError");
    expect(parsed).toBeInstanceOf(TeleportLockProbeError);
    expect(parsed.message).toBe("Failed to check whether /tmp/session.jsonl is locked.");
  });
});

describe("teleport tagged errors", () => {
  it("derives TeleportInvalidInputError.message from reason", () => {
    const error = new TeleportInvalidInputError({
      reason: "Cannot export while this T3 session is running.",
    });
    expect(error.message).toBe("Cannot export while this T3 session is running.");
    const parsed = decodeTeleportExportError({
      _tag: "TeleportInvalidInputError",
      reason: "Cannot export while this T3 session is running.",
    });
    expect(parsed).toBeInstanceOf(TeleportInvalidInputError);
    expect(parsed.message).toBe("Cannot export while this T3 session is running.");
  });

  it("derives TeleportDiscoveryError.message from reason", () => {
    const error = new TeleportDiscoveryError({
      reason: "Native session was not found for this project.",
    });
    expect(error.message).toBe("Native session was not found for this project.");
  });

  it("derives TeleportFileLockedError.message from nativePath", () => {
    const error = new TeleportFileLockedError({
      nativePath: "/tmp/session.jsonl",
    });
    expect(error.message).toBe("Native session file is locked: /tmp/session.jsonl");
  });

  it("derives TeleportSchemaVersionError.message from provider and version", () => {
    const error = new TeleportSchemaVersionError({
      provider: "codex",
      nativePath: "/tmp/session.jsonl",
      foundVersion: 2,
      supportedVersion: 1,
    });
    expect(error.message).toBe("Unsupported Codex session format version 2 in /tmp/session.jsonl.");
  });

  it("derives TeleportIdentityConflictError.message from the session id", () => {
    const error = new TeleportIdentityConflictError({
      provider: "codex",
      externalSessionId: "session-1",
      existingThreadId: ThreadId.make("thread-1"),
      existingProjectId: ProjectId.make("project-1"),
    });
    expect(error.message).toBe("Session 'session-1' is already bound to another T3 project.");
  });

  it("derives TeleportUnsupportedProviderError.message from the provider", () => {
    const error = new TeleportUnsupportedProviderError({
      provider: ProviderDriverKind.make("grok"),
    });
    expect(error.message).toBe("Teleport does not support provider 'grok'.");
  });

  it("derives TeleportNativeWriteError.message from stage and path", () => {
    const error = new TeleportNativeWriteError({
      nativePath: "/tmp/session.jsonl",
      stage: "verify",
    });
    expect(error.message).toBe("Exported session failed verification: /tmp/session.jsonl");
    expect(
      new TeleportNativeWriteError({
        stage: "unknown-instance",
        sessionId: "codex_work",
      }).message,
    ).toBe(
      "Provider instance 'codex_work' is no longer configured; cannot write a native session for it.",
    );
    const parsed = decodeTeleportExportError({
      _tag: "TeleportNativeWriteError",
      stage: "filesystem",
    });
    expect(parsed).toBeInstanceOf(TeleportNativeWriteError);
    expect(parsed.message).toBe("Native filesystem error during teleport export.");
  });
});
