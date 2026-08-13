import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  ModelSelection,
  ProviderInteractionMode,
  RuntimeMode,
} from "./orchestration.ts";

export const TeleportImportSessionInput = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  provider: Schema.optional(ProviderDriverKind),
  externalSessionId: TrimmedNonEmptyString,
  cwd: TrimmedNonEmptyString,
  projectId: Schema.optional(ProjectId),
  threadId: Schema.optional(ThreadId),
  title: Schema.optional(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE))),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  modelSelection: Schema.optional(ModelSelection),
  startSession: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
});
export type TeleportImportSessionInput = typeof TeleportImportSessionInput.Type;

export const TeleportImportSessionResult = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  provider: ProviderDriverKind,
  providerInstanceId: ProviderInstanceId,
  externalSessionId: TrimmedNonEmptyString,
  resumeCursor: Schema.Unknown,
  started: Schema.Boolean,
});
export type TeleportImportSessionResult = typeof TeleportImportSessionResult.Type;

export const TeleportListSessionsInput = Schema.Struct({
  providers: Schema.optional(Schema.Array(ProviderDriverKind)),
});
export type TeleportListSessionsInput = typeof TeleportListSessionsInput.Type;

export const TeleportSessionAvailability = Schema.Literals(["idle", "stopped", "unknown"]);
export type TeleportSessionAvailability = typeof TeleportSessionAvailability.Type;

export const TeleportSessionCandidate = Schema.Struct({
  provider: ProviderDriverKind,
  providerInstanceId: ProviderInstanceId,
  externalSessionId: TrimmedNonEmptyString,
  cwd: TrimmedNonEmptyString,
  title: Schema.optional(TrimmedNonEmptyString),
  modelSelection: Schema.optional(ModelSelection),
  availability: TeleportSessionAvailability.pipe(
    Schema.withDecodingDefault(Effect.succeed("unknown" as const)),
  ),
  createdAt: Schema.optional(IsoDateTime),
  updatedAt: Schema.optional(IsoDateTime),
});
export type TeleportSessionCandidate = typeof TeleportSessionCandidate.Type;

export const TeleportListSessionsResult = Schema.Struct({
  sessions: Schema.Array(TeleportSessionCandidate),
});
export type TeleportListSessionsResult = typeof TeleportListSessionsResult.Type;

export const TeleportLaunchExternalSessionInput = Schema.Struct({
  threadId: ThreadId,
});
export type TeleportLaunchExternalSessionInput = typeof TeleportLaunchExternalSessionInput.Type;

export const TeleportLaunchExternalSessionResult = Schema.Struct({
  provider: ProviderDriverKind,
  providerInstanceId: ProviderInstanceId,
  externalSessionId: TrimmedNonEmptyString,
  cwd: TrimmedNonEmptyString,
  command: TrimmedNonEmptyString,
  launched: Schema.Boolean,
});
export type TeleportLaunchExternalSessionResult = typeof TeleportLaunchExternalSessionResult.Type;

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

export class TeleportProjectResolutionError extends Schema.TaggedErrorClass<TeleportProjectResolutionError>()(
  "TeleportProjectResolutionError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class TeleportProviderStartError extends Schema.TaggedErrorClass<TeleportProviderStartError>()(
  "TeleportProviderStartError",
  {
    provider: ProviderDriverKind,
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class TeleportOpenCodeUnsupportedResumeError extends Schema.TaggedErrorClass<TeleportOpenCodeUnsupportedResumeError>()(
  "TeleportOpenCodeUnsupportedResumeError",
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

export class TeleportExternalLaunchError extends Schema.TaggedErrorClass<TeleportExternalLaunchError>()(
  "TeleportExternalLaunchError",
  {
    provider: ProviderDriverKind,
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const TeleportImportError = Schema.Union([
  TeleportInvalidInputError,
  TeleportUnsupportedProviderError,
  TeleportProjectResolutionError,
  TeleportProviderStartError,
  TeleportOpenCodeUnsupportedResumeError,
]);
export type TeleportImportError = typeof TeleportImportError.Type;

export const TeleportListSessionsError = Schema.Union([
  TeleportInvalidInputError,
  TeleportDiscoveryError,
]);
export type TeleportListSessionsError = typeof TeleportListSessionsError.Type;

export const TeleportLaunchExternalSessionError = Schema.Union([
  TeleportInvalidInputError,
  TeleportUnsupportedProviderError,
  TeleportProjectResolutionError,
  TeleportExternalLaunchError,
]);
export type TeleportLaunchExternalSessionError = typeof TeleportLaunchExternalSessionError.Type;
