import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";

import {
  buildTeleportResumeCursor,
  readTeleportExternalSessionId,
  teleportRuntimePayloadFromThreadState,
} from "./resumeCursors.ts";
import { TELEPORT_TEST_SESSION_ID } from "./testFixtures.ts";

describe("teleport resume cursors", () => {
  it("prefers the teleport payload over a resume cursor", () => {
    assert.equal(
      readTeleportExternalSessionId({
        provider: ProviderDriverKind.make("grok"),
        resumeCursor: { schemaVersion: 1, sessionId: "other" },
        runtimePayload: {
          teleport: { externalSessionId: TELEPORT_TEST_SESSION_ID },
        },
      }),
      TELEPORT_TEST_SESSION_ID,
    );
  });

  it("rebuilds a runtime payload from persisted thread teleport state", () => {
    assert.deepEqual(
      teleportRuntimePayloadFromThreadState(
        {
          presence: "t3",
          provider: "codex",
          externalSessionId: TELEPORT_TEST_SESSION_ID,
          nativePath: "/tmp/native.jsonl",
          lastSyncedAt: "2026-08-14T22:00:00.000Z",
          nativeRevision: {
            algorithm: "sha256",
            digest: "abc",
            byteLength: 12,
          },
        },
        {
          lastSyncDirection: "import",
          nativeFormatVersion: 1,
        },
      ),
      {
        schemaVersion: 1,
        externalSessionId: TELEPORT_TEST_SESSION_ID,
        nativePath: "/tmp/native.jsonl",
        lastSyncDirection: "import",
        lastSyncedAt: "2026-08-14T22:00:00.000Z",
        nativeFormatVersion: 1,
        presence: "t3",
        nativeRevision: {
          algorithm: "sha256",
          digest: "abc",
          byteLength: 12,
        },
      },
    );
  });

  it("falls back to a generic session id when no format adapter is supplied", () => {
    assert.deepStrictEqual(
      buildTeleportResumeCursor({
        provider: "codex",
        externalSessionId: TELEPORT_TEST_SESSION_ID,
      }),
      { sessionId: TELEPORT_TEST_SESSION_ID },
    );
    assert.equal(
      readTeleportExternalSessionId({
        provider: ProviderDriverKind.make("codex"),
        resumeCursor: { threadId: TELEPORT_TEST_SESSION_ID },
        runtimePayload: null,
      }),
      undefined,
    );
  });
});
