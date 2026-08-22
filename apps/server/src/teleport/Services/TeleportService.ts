import type {
  TeleportExportError,
  TeleportExportSessionInput,
  TeleportExportSessionResult,
  TeleportImportError,
  TeleportImportSessionsInput,
  TeleportImportSessionsResult,
  TeleportListSessionsError,
  TeleportListSessionsInput,
  TeleportListSessionsResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface TeleportServiceShape {
  readonly listSessions: (
    input: TeleportListSessionsInput,
  ) => Effect.Effect<TeleportListSessionsResult, TeleportListSessionsError>;

  readonly importSessions: (
    input: TeleportImportSessionsInput,
  ) => Effect.Effect<TeleportImportSessionsResult, TeleportImportError>;

  readonly exportSession: (
    input: TeleportExportSessionInput,
  ) => Effect.Effect<TeleportExportSessionResult, TeleportExportError>;
}

export class TeleportService extends Context.Service<TeleportService, TeleportServiceShape>()(
  "t3/teleport/Services/TeleportService",
) {}
