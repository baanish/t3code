import {
  TeleportDiscoveryError,
  TeleportFileLockedError,
  TeleportLockProbeError,
  TeleportNativeWriteError,
  TeleportSchemaVersionError,
  type TeleportProvider,
  type TeleportSessionCandidate,
} from "@t3tools/contracts";
import type * as Crypto from "effect/Crypto";
import type * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

import type * as ProcessRunner from "../../processRunner.ts";
import type { TeleportHomes } from "../homes.ts";
import type { ParsedNativeSession } from "../types.ts";

export interface TeleportFormatAdapter {
  readonly provider: TeleportProvider;
  readonly list: (input: {
    readonly homes: TeleportHomes;
    readonly cwd: string;
    readonly extraCwds?: ReadonlyArray<string>;
  }) => Effect.Effect<
    ReadonlyArray<TeleportSessionCandidate>,
    TeleportSchemaVersionError | TeleportDiscoveryError,
    FileSystem.FileSystem | Path.Path | Crypto.Crypto
  >;
  readonly load: (input: {
    readonly homes: TeleportHomes;
    readonly cwd: string;
    readonly externalSessionId: string;
    readonly nativePath: string;
  }) => Effect.Effect<
    ParsedNativeSession,
    TeleportSchemaVersionError | TeleportDiscoveryError,
    FileSystem.FileSystem | Path.Path | Crypto.Crypto
  >;
  readonly write: (input: {
    readonly homes: TeleportHomes;
    readonly session: ParsedNativeSession;
    readonly existingNativePath?: string;
  }) => Effect.Effect<
    string,
    | TeleportNativeWriteError
    | TeleportFileLockedError
    | TeleportLockProbeError
    | TeleportSchemaVersionError,
    FileSystem.FileSystem | Path.Path | ProcessRunner.ProcessRunner
  >;
  readonly requireUnlocked: (input: {
    readonly homes: TeleportHomes;
    readonly nativePath: string;
  }) => Effect.Effect<
    void,
    TeleportFileLockedError | TeleportLockProbeError,
    FileSystem.FileSystem | Path.Path | ProcessRunner.ProcessRunner
  >;
  readonly resumeCursor: (externalSessionId: string) => unknown;
  readonly readExternalSessionId: (resumeCursor: unknown) => string | undefined;
}
