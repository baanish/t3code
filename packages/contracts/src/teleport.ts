import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

export const TELEPORT_SCHEMA_VERSION = 1 as const;
export const TELEPORT_NATIVE_FORMAT_VERSION = 1 as const;

export const TeleportProvider = Schema.Literals(["codex", "claudeAgent"]);
export type TeleportProvider = typeof TeleportProvider.Type;

export const TeleportSyncDirection = Schema.Literals(["import", "export"]);
export type TeleportSyncDirection = typeof TeleportSyncDirection.Type;

export const TeleportPresence = Schema.Literals(["t3", "native", "importing"]);
export type TeleportPresence = typeof TeleportPresence.Type;

export const TeleportRestorePresence = Schema.Literals(["t3", "native"]);
export type TeleportRestorePresence = typeof TeleportRestorePresence.Type;

export const TeleportThreadState = Schema.Struct({
  presence: TeleportPresence,
  provider: TeleportProvider,
  providerInstanceId: Schema.optional(ProviderInstanceId),
  externalSessionId: TrimmedNonEmptyString,
  nativePath: TrimmedNonEmptyString,
  lastSyncedAt: IsoDateTime,
  // Set only while presence is "importing". Restart recovery restores this
  // presence so a crashed import cannot strand the thread.
  restorePresence: Schema.optional(TeleportRestorePresence),
});
export type TeleportThreadState = typeof TeleportThreadState.Type;

export const TeleportSessionRef = Schema.Struct({
  provider: TeleportProvider,
  providerInstanceId: Schema.optional(ProviderInstanceId),
  externalSessionId: TrimmedNonEmptyString,
  nativePath: Schema.optional(TrimmedNonEmptyString),
});
export type TeleportSessionRef = typeof TeleportSessionRef.Type;

export const TeleportListSessionsInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  providers: Schema.optional(Schema.Array(TeleportProvider)),
});
export type TeleportListSessionsInput = typeof TeleportListSessionsInput.Type;

export const TeleportSessionCandidate = Schema.Struct({
  provider: TeleportProvider,
  providerInstanceId: ProviderInstanceId,
  externalSessionId: TrimmedNonEmptyString,
  cwd: TrimmedNonEmptyString,
  nativePath: TrimmedNonEmptyString,
  nativeFormatVersion: Schema.Int,
  title: Schema.optional(TrimmedNonEmptyString),
  createdAt: Schema.optional(IsoDateTime),
  updatedAt: Schema.optional(IsoDateTime),
});
export type TeleportSessionCandidate = typeof TeleportSessionCandidate.Type;

export const TeleportListSessionsResult = Schema.Struct({
  schemaVersion: Schema.Literal(TELEPORT_SCHEMA_VERSION).pipe(
    Schema.withDecodingDefault(Effect.succeed(TELEPORT_SCHEMA_VERSION)),
  ),
  sessions: Schema.Array(TeleportSessionCandidate),
});
export type TeleportListSessionsResult = typeof TeleportListSessionsResult.Type;

/**
 * Import is atomic per listed session, not all-or-nothing for the batch.
 * If a later session fails, earlier successful imports are retained and the
 * RPC still fails.
 */
export const TELEPORT_IMPORT_BATCH_SEMANTICS = "per-session" as const;

export const TeleportImportSessionsInput = Schema.Struct({
  projectId: ProjectId,
  cwd: TrimmedNonEmptyString,
  sessions: Schema.Array(TeleportSessionRef).check(Schema.isMinLength(1)),
});
export type TeleportImportSessionsInput = typeof TeleportImportSessionsInput.Type;

export const TeleportImportedSession = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  provider: TeleportProvider,
  providerInstanceId: ProviderInstanceId,
  externalSessionId: TrimmedNonEmptyString,
  updatedInPlace: Schema.Boolean,
});
export type TeleportImportedSession = typeof TeleportImportedSession.Type;

export const TeleportImportSessionsResult = Schema.Struct({
  schemaVersion: Schema.Literal(TELEPORT_SCHEMA_VERSION).pipe(
    Schema.withDecodingDefault(Effect.succeed(TELEPORT_SCHEMA_VERSION)),
  ),
  imported: Schema.Array(TeleportImportedSession),
});
export type TeleportImportSessionsResult = typeof TeleportImportSessionsResult.Type;

export const TeleportExportSessionInput = Schema.Struct({
  threadId: ThreadId,
});
export type TeleportExportSessionInput = typeof TeleportExportSessionInput.Type;

export const TeleportExportSessionResult = Schema.Struct({
  schemaVersion: Schema.Literal(TELEPORT_SCHEMA_VERSION).pipe(
    Schema.withDecodingDefault(Effect.succeed(TELEPORT_SCHEMA_VERSION)),
  ),
  provider: TeleportProvider,
  providerInstanceId: ProviderInstanceId,
  externalSessionId: TrimmedNonEmptyString,
  nativePath: TrimmedNonEmptyString,
  cwd: TrimmedNonEmptyString,
});
export type TeleportExportSessionResult = typeof TeleportExportSessionResult.Type;

export const TeleportRuntimePayload = Schema.Struct({
  schemaVersion: Schema.Literal(TELEPORT_SCHEMA_VERSION),
  externalSessionId: TrimmedNonEmptyString,
  nativePath: TrimmedNonEmptyString,
  lastSyncDirection: TeleportSyncDirection,
  lastSyncedAt: IsoDateTime,
  nativeFormatVersion: Schema.Int,
  presence: Schema.optional(TeleportPresence),
});
export type TeleportRuntimePayload = typeof TeleportRuntimePayload.Type;

export function isTeleportProvider(value: string): value is TeleportProvider {
  return value === "codex" || value === "claudeAgent";
}

export function resolveTeleportPresence(
  payload: Pick<TeleportRuntimePayload, "presence" | "lastSyncDirection"> | null | undefined,
): TeleportPresence {
  if (payload?.presence) {
    switch (payload.presence) {
      case "t3":
      case "native":
      case "importing":
        return payload.presence;
      default: {
        const _exhaustive: never = payload.presence;
        return _exhaustive;
      }
    }
  }
  return payload?.lastSyncDirection === "export" ? "native" : "t3";
}

export function teleportPresenceBlocksThreadTurnStart(
  presence: TeleportPresence | null | undefined,
): boolean {
  return presence === "native" || presence === "importing";
}

export function isTeleportedOut(teleport: TeleportThreadState | null | undefined): boolean {
  return teleportPresenceBlocksThreadTurnStart(teleport?.presence);
}

export const TELEPORTED_OUT_SEND_DISABLED_REASON =
  "This thread is in the native CLI. Import it to keep chatting here.";

export const TELEPORT_IMPORTING_SEND_DISABLED_REASON =
  "This thread is being imported from the native CLI.";

export function isTeleportSendDisabledReason(
  reason: string | null | undefined,
): reason is
  | typeof TELEPORTED_OUT_SEND_DISABLED_REASON
  | typeof TELEPORT_IMPORTING_SEND_DISABLED_REASON {
  return (
    reason === TELEPORTED_OUT_SEND_DISABLED_REASON ||
    reason === TELEPORT_IMPORTING_SEND_DISABLED_REASON
  );
}

export function teleportSendDisabledReason(
  teleport: TeleportThreadState | null | undefined,
): string | null {
  if (teleport == null) {
    return null;
  }
  switch (teleport.presence) {
    case "native":
      return TELEPORTED_OUT_SEND_DISABLED_REASON;
    case "importing":
      return TELEPORT_IMPORTING_SEND_DISABLED_REASON;
    case "t3":
      return null;
    default: {
      const _exhaustive: never = teleport.presence;
      return _exhaustive;
    }
  }
}

export class TeleportInvalidInputError extends Schema.TaggedErrorClass<TeleportInvalidInputError>()(
  "TeleportInvalidInputError",
  {
    reason: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason;
  }
}

export class TeleportUnsupportedProviderError extends Schema.TaggedErrorClass<TeleportUnsupportedProviderError>()(
  "TeleportUnsupportedProviderError",
  {
    provider: ProviderDriverKind,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Teleport does not support provider '${this.provider}'.`;
  }
}

export class TeleportSchemaVersionError extends Schema.TaggedErrorClass<TeleportSchemaVersionError>()(
  "TeleportSchemaVersionError",
  {
    provider: Schema.optional(TeleportProvider),
    nativePath: Schema.optional(TrimmedNonEmptyString),
    foundVersion: Schema.optional(Schema.Int),
    supportedVersion: Schema.Int,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    let kind = "native";
    if (this.provider !== undefined) {
      switch (this.provider) {
        case "codex":
          kind = "Codex";
          break;
        case "claudeAgent":
          kind = "Claude";
          break;
        default: {
          const _exhaustive: never = this.provider;
          return _exhaustive;
        }
      }
    }
    const version = this.foundVersion === undefined ? "" : ` ${this.foundVersion}`;
    const location = this.nativePath === undefined ? "" : ` in ${this.nativePath}`;
    return `Unsupported ${kind} session format version${version}${location}.`;
  }
}

export class TeleportFileLockedError extends Schema.TaggedErrorClass<TeleportFileLockedError>()(
  "TeleportFileLockedError",
  {
    nativePath: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Native session file is locked: ${this.nativePath}`;
  }
}

export class TeleportLockProbeError extends Schema.TaggedErrorClass<TeleportLockProbeError>()(
  "TeleportLockProbeError",
  {
    nativePath: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to check whether ${this.nativePath} is locked.`;
  }
}

export class TeleportIdentityConflictError extends Schema.TaggedErrorClass<TeleportIdentityConflictError>()(
  "TeleportIdentityConflictError",
  {
    provider: TeleportProvider,
    externalSessionId: TrimmedNonEmptyString,
    existingThreadId: ThreadId,
    existingProjectId: ProjectId,
  },
) {
  override get message(): string {
    return `Session '${this.externalSessionId}' is already bound to another T3 project.`;
  }
}

export class TeleportProjectResolutionError extends Schema.TaggedErrorClass<TeleportProjectResolutionError>()(
  "TeleportProjectResolutionError",
  {
    reason: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason;
  }
}

export class TeleportDiscoveryError extends Schema.TaggedErrorClass<TeleportDiscoveryError>()(
  "TeleportDiscoveryError",
  {
    reason: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason;
  }
}

export const TeleportNativeWriteStage = Schema.Literals([
  "create-directory",
  "create-temp",
  "write-temp",
  "read-temp",
  "replace",
  "verify",
  "unsafe-session-id",
  "unsafe-native-path",
  "bind",
  "read-settings",
  "filesystem",
]);
export type TeleportNativeWriteStage = typeof TeleportNativeWriteStage.Type;

export class TeleportNativeWriteError extends Schema.TaggedErrorClass<TeleportNativeWriteError>()(
  "TeleportNativeWriteError",
  {
    nativePath: Schema.optional(TrimmedNonEmptyString),
    stage: TeleportNativeWriteStage,
    sessionId: Schema.optional(TrimmedNonEmptyString),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const nativePath = this.nativePath ?? "native session";
    switch (this.stage) {
      case "create-directory":
        return `Failed to create directory for ${nativePath}.`;
      case "create-temp":
        return `Failed to create a temp file for ${nativePath}.`;
      case "write-temp":
        return `Failed to write temp session file for ${nativePath}.`;
      case "read-temp":
        return `Failed to re-read temp session file for ${nativePath}.`;
      case "replace":
        return `Failed to replace ${nativePath}.`;
      case "verify":
        return `Exported session failed verification: ${nativePath}`;
      case "unsafe-session-id":
        return this.sessionId === undefined
          ? "Refusing to write a native session with an unsafe id."
          : `Refusing to write a native session with an unsafe id '${this.sessionId}'.`;
      case "unsafe-native-path":
        return `Refusing to write outside the configured native session directory: ${nativePath}`;
      case "bind":
        return "Failed to bind the exported native session.";
      case "read-settings":
        return "Server settings could not be read for teleport export.";
      case "filesystem":
        return "Native filesystem error during teleport export.";
      default: {
        const _exhaustive: never = this.stage;
        return _exhaustive;
      }
    }
  }
}

export const TeleportListSessionsError = Schema.Union([
  TeleportInvalidInputError,
  TeleportDiscoveryError,
  TeleportSchemaVersionError,
]);
export type TeleportListSessionsError = typeof TeleportListSessionsError.Type;

export const TeleportImportError = Schema.Union([
  TeleportInvalidInputError,
  TeleportUnsupportedProviderError,
  TeleportSchemaVersionError,
  TeleportFileLockedError,
  TeleportLockProbeError,
  TeleportIdentityConflictError,
  TeleportProjectResolutionError,
  TeleportDiscoveryError,
]);
export type TeleportImportError = typeof TeleportImportError.Type;

export const TeleportExportError = Schema.Union([
  TeleportInvalidInputError,
  TeleportUnsupportedProviderError,
  TeleportSchemaVersionError,
  TeleportFileLockedError,
  TeleportLockProbeError,
  TeleportProjectResolutionError,
  TeleportNativeWriteError,
]);
export type TeleportExportError = typeof TeleportExportError.Type;
