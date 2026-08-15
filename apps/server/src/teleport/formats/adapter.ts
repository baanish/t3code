import {
  TeleportDiscoveryError,
  TeleportFileLockedError,
  TeleportNativeWriteError,
  TeleportSchemaVersionError,
  type TeleportProvider,
  type TeleportSessionCandidate,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

import type { TeleportHomes } from "../homes.ts";
import type { ParsedNativeSession } from "../types.ts";

export interface TeleportFormatAdapter {
  readonly provider: TeleportProvider;
  readonly list: (input: {
    readonly homes: TeleportHomes;
    readonly cwd: string;
  }) => Effect.Effect<
    ReadonlyArray<TeleportSessionCandidate>,
    TeleportSchemaVersionError | TeleportDiscoveryError,
    FileSystem.FileSystem | Path.Path
  >;
  readonly load: (input: {
    readonly homes: TeleportHomes;
    readonly cwd: string;
    readonly externalSessionId: string;
    readonly nativePath: string;
  }) => Effect.Effect<
    ParsedNativeSession,
    TeleportSchemaVersionError | TeleportDiscoveryError,
    FileSystem.FileSystem | Path.Path
  >;
  readonly write: (input: {
    readonly homes: TeleportHomes;
    readonly session: ParsedNativeSession;
    readonly existingNativePath?: string;
  }) => Effect.Effect<
    string,
    TeleportNativeWriteError | TeleportFileLockedError | TeleportSchemaVersionError,
    FileSystem.FileSystem | Path.Path
  >;
  readonly requireUnlocked: (input: {
    readonly homes: TeleportHomes;
    readonly nativePath: string;
  }) => Effect.Effect<void, TeleportFileLockedError, FileSystem.FileSystem | Path.Path>;
  readonly resumeCursor: (externalSessionId: string) => unknown;
  readonly readExternalSessionId: (resumeCursor: unknown) => string | undefined;
}
