import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import type * as PlatformError from "effect/PlatformError";

import { isOversizeTeleportSession, MAX_TELEPORT_SESSION_BYTES } from "./types.ts";

export type BoundedNativeSessionBytes =
  | { readonly status: "missing" }
  | { readonly status: "oversize"; readonly byteLength: number }
  | { readonly status: "observed"; readonly bytes: Uint8Array };

/**
 * Enforce the 20 MiB session cap while reading. A post-stat `readFile` can
 * still allocate an arbitrarily larger replacement or append.
 */
export const readBoundedNativeSessionBytes = Effect.fn("readBoundedNativeSessionBytes")(function* (
  nativePath: string,
  options?: { readonly maxBytes?: number },
): Effect.fn.Return<BoundedNativeSessionBytes, PlatformError.PlatformError, FileSystem.FileSystem> {
  const maxBytes = options?.maxBytes ?? MAX_TELEPORT_SESSION_BYTES;
  const fs = yield* FileSystem.FileSystem;
  const stat = yield* fs.stat(nativePath).pipe(Effect.orElseSucceed(() => null));
  if (stat === null || stat.type !== "File") {
    return { status: "missing" as const };
  }
  const statedBytes = typeof stat.size === "bigint" ? Number(stat.size) : stat.size;
  if (isOversizeTeleportSession(stat.size)) {
    return { status: "oversize" as const, byteLength: statedBytes };
  }

  const limit = maxBytes + 1;
  const collected = yield* fs.stream(nativePath, { bytesToRead: limit }).pipe(
    Stream.runFold(
      (): { chunks: Uint8Array[]; bytes: number } => ({ chunks: [], bytes: 0 }),
      (state, chunk) => {
        state.chunks.push(chunk);
        return { chunks: state.chunks, bytes: state.bytes + chunk.byteLength };
      },
    ),
  );
  if (collected.bytes === 0) {
    return { status: "missing" as const };
  }
  if (collected.bytes > maxBytes) {
    return { status: "oversize" as const, byteLength: collected.bytes };
  }
  return {
    status: "observed" as const,
    bytes: Buffer.concat(collected.chunks, collected.bytes),
  };
});
