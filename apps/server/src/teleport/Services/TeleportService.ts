import type {
  TeleportLaunchExternalSessionError,
  TeleportLaunchExternalSessionInput,
  TeleportLaunchExternalSessionResult,
  TeleportImportError,
  TeleportImportSessionInput,
  TeleportImportSessionResult,
  TeleportListSessionsError,
  TeleportListSessionsInput,
  TeleportListSessionsResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface TeleportServiceShape {
  readonly listSessions: (
    input?: TeleportListSessionsInput,
  ) => Effect.Effect<TeleportListSessionsResult, TeleportListSessionsError>;

  readonly importSession: (
    input: TeleportImportSessionInput,
  ) => Effect.Effect<TeleportImportSessionResult, TeleportImportError>;

  readonly launchExternalSession: (
    input: TeleportLaunchExternalSessionInput,
  ) => Effect.Effect<TeleportLaunchExternalSessionResult, TeleportLaunchExternalSessionError>;
}

export class TeleportService extends Context.Service<TeleportService, TeleportServiceShape>()(
  "t3/teleport/Services/TeleportService",
) {}
