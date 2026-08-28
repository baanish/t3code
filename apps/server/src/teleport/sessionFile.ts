import { TeleportDiscoveryError, TeleportSchemaVersionError } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import { readBoundedNativeSessionBytes } from "./boundedRead.ts";
import { nativeRevisionFromBytes } from "./nativeRevision.ts";
import type { ParsedNativeSession } from "./types.ts";

export const readNativeSessionFile = Effect.fn("readNativeSessionFile")(function* (input: {
  readonly nativePath: string;
  readonly parse: (args: {
    readonly contents: string;
    readonly nativePath: string;
  }) => Effect.Effect<Option.Option<ParsedNativeSession>, TeleportSchemaVersionError>;
}): Effect.fn.Return<
  Option.Option<ParsedNativeSession>,
  TeleportSchemaVersionError | TeleportDiscoveryError,
  FileSystem.FileSystem | Crypto.Crypto
> {
  const read = yield* readBoundedNativeSessionBytes(input.nativePath).pipe(
    Effect.orElseSucceed(() => ({ status: "missing" as const })),
  );
  if (read.status !== "observed") {
    return Option.none();
  }
  const contents = Buffer.from(read.bytes).toString("utf8");
  if (contents.length === 0) {
    return Option.none();
  }
  const nativeRevision = yield* nativeRevisionFromBytes(read.bytes);
  const parsed = yield* input.parse({ contents, nativePath: input.nativePath });
  return Option.map(parsed, (session) => ({
    ...session,
    nativeRevision,
  }));
});
