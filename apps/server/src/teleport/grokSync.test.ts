// @effect-diagnostics preferSchemaOverJson:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { TeleportError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { parseGrokSessionDirectory, parseGrokUpdates, writeGrokSession } from "./grokSync.ts";

const isTeleportError = Schema.is(TeleportError);

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const chunk = (text: string, ts: number) =>
  JSON.stringify({
    timestamp: ts,
    method: "session/update",
    params: {
      sessionId: SESSION_ID,
      update: { sessionUpdate: "user_message_chunk", content: { type: "text", text } },
    },
  });

describe("grok session sync", () => {
  it.effect(
    "roundtrips Grok directories, concatenates chunks, and fails closed on newer formats",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "grok-sync-" });
        const nativePath = yield* writeGrokSession({
          sessionsRoot: root,
          cwd: "/workspace",
          sessionId: SESSION_ID,
          title: "Fix the flaky matcher",
          createdAt: "2026-08-14T06:00:00.000Z",
          updatedAt: "2026-08-14T06:01:00.000Z",
          messages: [
            { role: "user", text: "Fix the flaky matcher" },
            { role: "assistant", text: "I'll tighten the path comparison." },
          ],
        });
        assert.equal(nativePath.endsWith(`%2Fworkspace/${SESSION_ID}`), true);
        const parsed = parseGrokSessionDirectory({
          summaryContents: yield* fs.readFileString(path.join(nativePath, "summary.json")),
          updatesContents: yield* fs.readFileString(path.join(nativePath, "updates.jsonl")),
          nativePath,
        });
        assert.equal(parsed.sessionId, SESSION_ID);
        assert.equal(
          parsed.messages.map((message) => message.text).join("|"),
          "Fix the flaky matcher|I'll tighten the path comparison.",
        );
        assert.equal(
          parseGrokUpdates(
            `${chunk("Hello ", 1_782_000_000)}\n${chunk("world", 1_782_000_001)}\n`,
          )[0]?.text,
          "Hello world",
        );
        const unsupported = yield* Effect.try({
          try: () =>
            parseGrokSessionDirectory({
              summaryContents: JSON.stringify({
                info: { id: SESSION_ID, cwd: "/workspace" },
                chat_format_version: 2,
              }),
              updatesContents: "",
              nativePath: "/tmp/new-grok",
            }),
          catch: (error) =>
            isTeleportError(error)
              ? error
              : new TeleportError({ message: "expected a TeleportError" }),
        }).pipe(Effect.flip);
        assert.equal(isTeleportError(unsupported), true);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
