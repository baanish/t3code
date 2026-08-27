import {
  TELEPORT_SCHEMA_VERSION,
  TeleportDiscoveryError,
  TeleportNativeDivergenceError,
  type TeleportCheckNativeRevisionResult,
  type TeleportNativeRevision,
  type TeleportNativeRevisionStatus,
  type TeleportThreadState,
  ThreadId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";

import { readBoundedNativeSessionBytes } from "./boundedRead.ts";
import { isPendingTeleportNativePath } from "./exportPresence.ts";

/**
 * Detection is a SHA-256 digest of the native file bytes, persisted on
 * TeleportThreadState at import. mtime is never consulted.
 *
 * Proven boundaries: import commit, thread refresh (`checkNativeRevision`),
 * and `thread.turn.start` (server-side abort). There is no file watcher.
 *
 * Remaining race: the CLI can write between the send-time hash and the
 * admitted turn. Holding the native file across a T3 turn would fight the
 * CLI, and a process-local lock cannot prove the file is frozen.
 */

export type NativeRevisionObservation =
  | { readonly status: "missing" }
  | { readonly status: "oversize"; readonly byteLength: number }
  | { readonly status: "observed"; readonly revision: TeleportNativeRevision };

export interface ClassifiedNativeRevision {
  readonly status: TeleportNativeRevisionStatus;
  readonly persistedRevision?: TeleportNativeRevision;
  readonly observedRevision?: TeleportNativeRevision;
  readonly forkedThreadId?: ThreadId;
}

export function nativeRevisionsEqual(
  left: TeleportNativeRevision,
  right: TeleportNativeRevision,
): boolean {
  return (
    left.algorithm === right.algorithm &&
    left.digest === right.digest &&
    left.byteLength === right.byteLength
  );
}

export function shouldWatchNativeRevision(
  teleport: TeleportThreadState | null | undefined,
): boolean {
  return (
    teleport != null &&
    teleport.presence === "t3" &&
    teleport.forkedFromThreadId === undefined &&
    teleport.nativePath.length > 0 &&
    !isPendingTeleportNativePath(teleport.nativePath)
  );
}

export function turnStartRequiresNativeRevisionCheck(
  command: {
    readonly type: string;
    readonly bootstrap?:
      | {
          readonly createThread?: unknown;
          readonly prepareWorktree?: unknown;
        }
      | undefined;
  },
  threadExists?: boolean,
): boolean {
  if (command.type !== "thread.turn.start") {
    return false;
  }
  // Skip only when bootstrap.createThread is minting a thread that is not
  // present yet. HTTP dispatches turn.start as-is and the decider ignores
  // bootstrap, so an existing-thread createThread payload must still be gated.
  // WS omits `threadExists` and keeps the payload-only skip because it runs
  // thread.create first (existing ids fail closed before the turn starts).
  if (command.bootstrap?.createThread !== undefined && threadExists !== true) {
    return false;
  }
  return true;
}

export function findCoveringNativeFork<T extends { readonly id: ThreadId }>(input: {
  readonly sourceThreadId: ThreadId;
  readonly observedDigest: string;
  readonly threads: ReadonlyArray<
    T & { readonly teleport?: TeleportThreadState | null | undefined }
  >;
}): T | undefined {
  return input.threads.find((thread) => {
    const teleport = thread.teleport;
    return (
      teleport?.forkedFromThreadId === input.sourceThreadId &&
      teleport.nativeRevision?.digest === input.observedDigest
    );
  });
}

/**
 * Durable fork identity shared across retries and replicas. `thread.create`
 * rejects an existing id, so a second replica that loses the create race can
 * reload this id and reuse the winner instead of allocating another thread.
 */
export function nativeForkThreadId(sourceThreadId: ThreadId, observedDigest: string): ThreadId {
  return ThreadId.make(`teleport-fork:${sourceThreadId}:${observedDigest}`);
}

export function reuseNativeForkAfterCreateConflict<T extends { readonly id: ThreadId }>(input: {
  readonly existing?: T & { readonly teleport?: TeleportThreadState | null | undefined };
  readonly sourceThreadId: ThreadId;
  readonly observedDigest: string;
}): T | undefined {
  if (input.existing === undefined) {
    return undefined;
  }
  return findCoveringNativeFork({
    sourceThreadId: input.sourceThreadId,
    observedDigest: input.observedDigest,
    threads: [input.existing],
  });
}

export function classifyNativeRevision(input: {
  readonly teleport: TeleportThreadState | null | undefined;
  readonly observation: NativeRevisionObservation | null;
  readonly coveringForkThreadId?: ThreadId;
}): ClassifiedNativeRevision {
  if (!shouldWatchNativeRevision(input.teleport)) {
    return { status: "not-applicable" };
  }
  const persistedRevision = input.teleport?.nativeRevision;
  if (persistedRevision === undefined) {
    return { status: "untracked" };
  }
  if (input.observation === null) {
    return {
      status: "untracked",
      persistedRevision,
    };
  }
  if (input.observation.status === "missing") {
    return {
      status: "missing",
      persistedRevision,
    };
  }
  if (input.observation.status === "oversize") {
    return {
      status: "oversize",
      persistedRevision,
    };
  }
  const observedRevision = input.observation.revision;
  if (nativeRevisionsEqual(persistedRevision, observedRevision)) {
    return {
      status: "unchanged",
      persistedRevision,
      observedRevision,
    };
  }
  if (input.coveringForkThreadId !== undefined) {
    return {
      status: "forked",
      persistedRevision,
      observedRevision,
      forkedThreadId: input.coveringForkThreadId,
    };
  }
  return {
    status: "diverged",
    persistedRevision,
    observedRevision,
  };
}

export function nativeRevisionCheckResult(input: {
  readonly threadId: ThreadId;
  readonly nativePath?: string;
  readonly classified: ClassifiedNativeRevision;
}): TeleportCheckNativeRevisionResult {
  return {
    schemaVersion: TELEPORT_SCHEMA_VERSION,
    threadId: input.threadId,
    status: input.classified.status,
    ...(input.nativePath === undefined ? {} : { nativePath: input.nativePath }),
    ...(input.classified.persistedRevision === undefined
      ? {}
      : { persistedRevision: input.classified.persistedRevision }),
    ...(input.classified.observedRevision === undefined
      ? {}
      : { observedRevision: input.classified.observedRevision }),
    ...(input.classified.forkedThreadId === undefined
      ? {}
      : { forkedThreadId: input.classified.forkedThreadId }),
  };
}

export type NativeForkPlan =
  | { readonly action: "reuse"; readonly threadId: ThreadId }
  | { readonly action: "create" }
  | {
      readonly action: "reject";
      readonly reason: "unchanged" | "missing" | "oversize" | "unavailable";
    };

export function resolveNativeForkPlan(classified: ClassifiedNativeRevision): NativeForkPlan {
  switch (classified.status) {
    case "forked":
      return classified.forkedThreadId === undefined
        ? { action: "create" }
        : { action: "reuse", threadId: classified.forkedThreadId };
    case "diverged":
      return classified.observedRevision === undefined
        ? { action: "reject", reason: "unavailable" }
        : { action: "create" };
    case "unchanged":
      return { action: "reject", reason: "unchanged" };
    case "missing":
      return { action: "reject", reason: "missing" };
    case "oversize":
      return { action: "reject", reason: "oversize" };
    case "not-applicable":
    case "untracked":
      return { action: "reject", reason: "unavailable" };
    default: {
      const _exhaustive: never = classified.status;
      return _exhaustive;
    }
  }
}

function nativeRevisionDivergenceKind(
  status: TeleportNativeRevisionStatus,
): TeleportNativeDivergenceError["kind"] {
  switch (status) {
    case "missing":
      return "missing";
    case "oversize":
      return "oversize";
    case "diverged":
    case "not-applicable":
    case "untracked":
    case "unchanged":
    case "forked":
      return "diverged";
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

export function nativeRevisionDivergenceError(input: {
  readonly threadId: ThreadId;
  readonly nativePath: string;
  readonly classified: ClassifiedNativeRevision;
}): TeleportNativeDivergenceError {
  return new TeleportNativeDivergenceError({
    threadId: input.threadId,
    kind: nativeRevisionDivergenceKind(input.classified.status),
    nativePath: input.nativePath,
    ...(input.classified.persistedRevision === undefined
      ? {}
      : { persistedDigest: input.classified.persistedRevision.digest }),
    ...(input.classified.observedRevision === undefined
      ? {}
      : {
          observedDigest: input.classified.observedRevision.digest,
          observedByteLength: input.classified.observedRevision.byteLength,
        }),
    ...(input.classified.forkedThreadId === undefined
      ? {}
      : { forkedThreadId: input.classified.forkedThreadId }),
  });
}

export function nativeRevisionFromBytes(
  bytes: Uint8Array,
): Effect.Effect<TeleportNativeRevision, TeleportDiscoveryError, Crypto.Crypto> {
  return Crypto.Crypto.pipe(
    Effect.flatMap((crypto) => crypto.digest("SHA-256", bytes)),
    Effect.map((digest) => ({
      algorithm: "sha256" as const,
      digest: Encoding.encodeHex(digest),
      byteLength: bytes.byteLength,
    })),
    Effect.mapError(
      (cause) =>
        new TeleportDiscoveryError({
          reason: "Failed to hash the imported native session file.",
          cause,
        }),
    ),
  );
}

export const observeNativeRevision = (
  nativePath: string,
): Effect.Effect<
  NativeRevisionObservation,
  TeleportDiscoveryError,
  FileSystem.FileSystem | Crypto.Crypto
> =>
  Effect.gen(function* () {
    const read = yield* readBoundedNativeSessionBytes(nativePath).pipe(
      Effect.mapError(
        (cause) =>
          new TeleportDiscoveryError({
            reason: "Failed to read the imported native session file.",
            cause,
          }),
      ),
    );
    if (read.status === "missing") {
      return { status: "missing" as const };
    }
    if (read.status === "oversize") {
      return { status: "oversize" as const, byteLength: read.byteLength };
    }
    const revision = yield* nativeRevisionFromBytes(read.bytes);
    return { status: "observed" as const, revision };
  });
