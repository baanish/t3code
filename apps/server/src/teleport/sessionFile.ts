import { TeleportSchemaVersionError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import { isOversizeTeleportSession, type ParsedNativeSession } from "./types.ts";

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
  const fs = yield* FileSystem.FileSystem;
  const stat = yield* fs.stat(input.nativePath).pipe(Effect.orElseSucceed(() => null));
  if (stat === null || stat.type !== "File") {
    return Option.none();
  }
  if (isOversizeTeleportSession(stat.size)) {
    return Option.none();
  }
  const contents = yield* fs.readFileString(input.nativePath).pipe(Effect.orElseSucceed(() => ""));
  if (contents.length === 0) {
    return Option.none();
  }
  return yield* input.parse({ contents, nativePath: input.nativePath });
});
