import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

export const TELEPORT_SCHEMA_VERSION = 1 as const;
export const TELEPORT_NATIVE_FORMAT_VERSION = 1 as const;

export const TeleportProvider = Schema.Literals(["codex", "claudeAgent", "opencode", "grok"]);
export type TeleportProvider = typeof TeleportProvider.Type;

export const TeleportSyncDirection = Schema.Literals(["import", "export"]);
export type TeleportSyncDirection = typeof TeleportSyncDirection.Type;

export const TeleportPresence = Schema.Literals(["t3", "native"]);
export type TeleportPresence = typeof TeleportPresence.Type;

export const TeleportThreadState = Schema.Struct({
  presence: TeleportPresence,
  provider: TeleportProvider,
  externalSessionId: TrimmedNonEmptyString,
  nativePath: TrimmedNonEmptyString,
  lastSyncedAt: IsoDateTime,
});
export type TeleportThreadState = typeof TeleportThreadState.Type;

export const TeleportSessionRef = Schema.Struct({
  provider: TeleportProvider,
  externalSessionId: TrimmedNonEmptyString,
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
  return value === "codex" || value === "claudeAgent" || value === "opencode" || value === "grok";
}

export function resolveTeleportPresence(
  payload: Pick<TeleportRuntimePayload, "presence" | "lastSyncDirection"> | null | undefined,
): TeleportPresence {
  if (payload?.presence) {
    return payload.presence;
  }
  return payload?.lastSyncDirection === "export" ? "native" : "t3";
}

export function isTeleportedOut(teleport: TeleportThreadState | null | undefined): boolean {
  return teleport?.presence === "native";
}

export class TeleportInvalidInputError extends Schema.TaggedErrorClass<TeleportInvalidInputError>()(
  "TeleportInvalidInputError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class TeleportUnsupportedProviderError extends Schema.TaggedErrorClass<TeleportUnsupportedProviderError>()(
  "TeleportUnsupportedProviderError",
  {
    provider: ProviderDriverKind,
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class TeleportSchemaVersionError extends Schema.TaggedErrorClass<TeleportSchemaVersionError>()(
  "TeleportSchemaVersionError",
  {
    provider: Schema.optional(TeleportProvider),
    nativePath: Schema.optional(TrimmedNonEmptyString),
    foundVersion: Schema.optional(Schema.Int),
    supportedVersion: Schema.Int,
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class TeleportFileLockedError extends Schema.TaggedErrorClass<TeleportFileLockedError>()(
  "TeleportFileLockedError",
  {
    nativePath: TrimmedNonEmptyString,
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class TeleportIdentityConflictError extends Schema.TaggedErrorClass<TeleportIdentityConflictError>()(
  "TeleportIdentityConflictError",
  {
    provider: TeleportProvider,
    externalSessionId: TrimmedNonEmptyString,
    existingThreadId: ThreadId,
    existingProjectId: ProjectId,
    message: TrimmedNonEmptyString,
  },
) {}

export class TeleportProjectResolutionError extends Schema.TaggedErrorClass<TeleportProjectResolutionError>()(
  "TeleportProjectResolutionError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class TeleportDiscoveryError extends Schema.TaggedErrorClass<TeleportDiscoveryError>()(
  "TeleportDiscoveryError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class TeleportNativeWriteError extends Schema.TaggedErrorClass<TeleportNativeWriteError>()(
  "TeleportNativeWriteError",
  {
    nativePath: TrimmedNonEmptyString,
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

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
  TeleportProjectResolutionError,
  TeleportNativeWriteError,
]);
export type TeleportExportError = typeof TeleportExportError.Type;
