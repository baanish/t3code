// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import { TeleportSchemaVersionError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import { readBoundedNativeSessionBytes } from "./boundedRead.ts";
import type { ParsedNativeSession } from "./types.ts";

export const readNativeSessionFile = Effect.fn("readNativeSessionFile")(function* (input: {
  readonly nativePath: string;
  readonly parse: (args: {
    readonly contents: string;
    readonly nativePath: string;
  }) => Effect.Effect<Option.Option<ParsedNativeSession>, TeleportSchemaVersionError>;
}): Effect.fn.Return<
  Option.Option<ParsedNativeSession>,
  TeleportSchemaVersionError,
  FileSystem.FileSystem
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
  const parsed = yield* input.parse({ contents, nativePath: input.nativePath });
  return Option.map(parsed, (session) => ({
    ...session,
    nativeRevision: {
      algorithm: "sha256" as const,
      digest: NodeCrypto.createHash("sha256").update(read.bytes).digest("hex"),
      byteLength: read.bytes.byteLength,
    },
  }));
});
