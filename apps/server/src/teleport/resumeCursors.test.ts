import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";

import { resetTeleportFormats } from "./formats/registry.ts";
import { buildTeleportResumeCursor, readTeleportExternalSessionId } from "./resumeCursors.ts";
import { TELEPORT_TEST_SESSION_ID } from "./testFixtures.ts";

describe("teleport resume cursors", () => {
  it("prefers the teleport payload over a resume cursor", () => {
    resetTeleportFormats();
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

  it("falls back to a generic session id when no format is registered", () => {
    resetTeleportFormats();
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
