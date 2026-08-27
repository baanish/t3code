import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { readBoundedNativeSessionBytes } from "./boundedRead.ts";

describe("readBoundedNativeSessionBytes", () => {
  it.effect("stops reading once the cap is exceeded", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "teleport-bounded-read-" });
      const nativePath = path.join(root, "session.jsonl");
      yield* fs.writeFileString(nativePath, "abcdefghij");

      const oversize = yield* readBoundedNativeSessionBytes(nativePath, { maxBytes: 4 });
      assert.equal(oversize.status, "oversize");
      if (oversize.status === "oversize") {
        assert.equal(oversize.byteLength, 5);
      }

      const observed = yield* readBoundedNativeSessionBytes(nativePath, { maxBytes: 16 });
      assert.equal(observed.status, "observed");
      if (observed.status === "observed") {
        assert.equal(Buffer.from(observed.bytes).toString("utf8"), "abcdefghij");
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
