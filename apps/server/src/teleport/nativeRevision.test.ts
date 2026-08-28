import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  teleportNativeRevisionBlocksMutation,
  ThreadId,
  type TeleportNativeRevision,
  type TeleportThreadState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { serializeClaudeSession } from "./formats/claude.ts";
import { serializeCodexSession } from "./formats/codex.ts";
import {
  classifyNativeRevision,
  findCoveringNativeFork,
  nativeForkThreadId,
  nativeRevisionFromBytes,
  nativeRevisionsEqual,
  observeNativeRevision,
  resolveNativeForkPlan,
  reuseNativeForkAfterCreateConflict,
  shouldWatchNativeRevision,
  turnStartRequiresNativeRevisionCheck,
} from "./nativeRevision.ts";
import { readNativeSessionFile } from "./sessionFile.ts";
import { sampleTeleportSession } from "./testFixtures.ts";

const NOW = "2026-08-14T22:00:00.000Z";
const SOURCE_THREAD = ThreadId.make("thread-source");
const FORK_THREAD = ThreadId.make("thread-fork");

function revision(digest: string, byteLength: number): TeleportNativeRevision {
  return {
    algorithm: "sha256",
    digest,
    byteLength,
  };
}

function t3Teleport(input: {
  readonly nativeRevision?: TeleportNativeRevision;
  readonly forkedFromThreadId?: ThreadId;
}): TeleportThreadState {
  return {
    presence: "t3",
    provider: "codex",
    externalSessionId: "session-1",
    nativePath: "/tmp/session.jsonl",
    lastSyncedAt: NOW,
    ...(input.nativeRevision === undefined ? {} : { nativeRevision: input.nativeRevision }),
    ...(input.forkedFromThreadId === undefined
      ? {}
      : { forkedFromThreadId: input.forkedFromThreadId }),
  };
}

const SAME_SIZE_LEFT = "hello-native-session-v1";
const SAME_SIZE_RIGHT = "hello-native-session-v2";

describe("native revision classification", () => {
  it("does not watch native or pending-export threads", () => {
    assert.equal(
      shouldWatchNativeRevision({
        presence: "native",
        provider: "codex",
        externalSessionId: "session-1",
        nativePath: "/tmp/session.jsonl",
        lastSyncedAt: NOW,
      }),
      false,
    );
    assert.equal(
      shouldWatchNativeRevision({
        presence: "t3",
        provider: "codex",
        externalSessionId: "session-1",
        nativePath: "teleport-pending:codex:session-1",
        lastSyncedAt: NOW,
      }),
      false,
    );
    assert.equal(
      shouldWatchNativeRevision(
        t3Teleport({
          nativeRevision: revision("fork", 12),
          forkedFromThreadId: SOURCE_THREAD,
        }),
      ),
      false,
    );
  });

  it("skips the turn-start revision check only when bootstrap creates a missing thread", () => {
    assert.equal(
      turnStartRequiresNativeRevisionCheck({
        type: "thread.turn.start",
      }),
      true,
    );
    assert.equal(
      turnStartRequiresNativeRevisionCheck({
        type: "thread.turn.start",
        bootstrap: {
          prepareWorktree: {},
        },
      }),
      true,
    );
    assert.equal(
      turnStartRequiresNativeRevisionCheck({
        type: "thread.turn.start",
        bootstrap: {
          createThread: {},
        },
      }),
      false,
    );
    assert.equal(
      turnStartRequiresNativeRevisionCheck(
        {
          type: "thread.turn.start",
          bootstrap: {
            createThread: {},
          },
        },
        false,
      ),
      false,
    );
    assert.equal(
      turnStartRequiresNativeRevisionCheck(
        {
          type: "thread.turn.start",
          bootstrap: {
            createThread: {},
          },
        },
        true,
      ),
      true,
    );
    assert.equal(
      turnStartRequiresNativeRevisionCheck({
        type: "thread.meta.update",
      }),
      false,
    );
  });

  it("treats a missing persisted digest as untracked, not a conflict", () => {
    const classified = classifyNativeRevision({
      teleport: t3Teleport({}),
      observation: { status: "observed", revision: revision("abc", 12) },
    });
    assert.equal(classified.status, "untracked");
    assert.equal(teleportNativeRevisionBlocksMutation(classified.status), false);
  });

  it("classifies an unchanged file", () => {
    const persisted = revision("abc", 12);
    const classified = classifyNativeRevision({
      teleport: t3Teleport({ nativeRevision: persisted }),
      observation: { status: "observed", revision: persisted },
    });
    assert.equal(classified.status, "unchanged");
    assert.equal(teleportNativeRevisionBlocksMutation(classified.status), false);
    assert.equal(resolveNativeForkPlan(classified).action, "reject");
  });

  it("classifies a changed file as a blocking conflict", () => {
    const classified = classifyNativeRevision({
      teleport: t3Teleport({ nativeRevision: revision("abc", 12) }),
      observation: { status: "observed", revision: revision("def", 16) },
    });
    assert.equal(classified.status, "diverged");
    assert.equal(teleportNativeRevisionBlocksMutation(classified.status), true);
    assert.deepEqual(resolveNativeForkPlan(classified), { action: "create" });
  });

  it("classifies same-size content changes as diverged", () => {
    assert.equal(SAME_SIZE_LEFT.length, SAME_SIZE_RIGHT.length);
    const classified = classifyNativeRevision({
      teleport: t3Teleport({ nativeRevision: revision("left", SAME_SIZE_LEFT.length) }),
      observation: {
        status: "observed",
        revision: revision("right", SAME_SIZE_RIGHT.length),
      },
    });
    assert.equal(classified.status, "diverged");
    assert.equal(teleportNativeRevisionBlocksMutation(classified.status), true);
  });

  it("classifies a missing native file as a blocking conflict that cannot fork", () => {
    const classified = classifyNativeRevision({
      teleport: t3Teleport({ nativeRevision: revision("abc", 12) }),
      observation: { status: "missing" },
    });
    assert.equal(classified.status, "missing");
    assert.equal(teleportNativeRevisionBlocksMutation(classified.status), true);
    assert.deepEqual(resolveNativeForkPlan(classified), { action: "reject", reason: "missing" });
  });

  it("classifies an oversize native file as a blocking conflict that cannot fork", () => {
    const classified = classifyNativeRevision({
      teleport: t3Teleport({ nativeRevision: revision("abc", 12) }),
      observation: { status: "oversize", byteLength: 30 * 1024 * 1024 },
    });
    assert.equal(classified.status, "oversize");
    assert.equal(classified.observedRevision, undefined);
    assert.equal(teleportNativeRevisionBlocksMutation(classified.status), true);
    assert.deepEqual(resolveNativeForkPlan(classified), { action: "reject", reason: "oversize" });
  });

  it("refuses to fork a diverged result that has no observed revision", () => {
    assert.deepEqual(
      resolveNativeForkPlan({
        status: "diverged",
        persistedRevision: revision("abc", 12),
      }),
      { action: "reject", reason: "unavailable" },
    );
  });

  it("treats a covering fork as resolved without mutating the source revision", () => {
    const persisted = revision("import", 10);
    const observed = revision("native-later", 20);
    const classified = classifyNativeRevision({
      teleport: t3Teleport({ nativeRevision: persisted }),
      observation: { status: "observed", revision: observed },
      coveringForkThreadId: FORK_THREAD,
    });
    assert.equal(classified.status, "forked");
    assert.equal(classified.forkedThreadId, FORK_THREAD);
    assert.equal(nativeRevisionsEqual(classified.persistedRevision!, persisted), true);
    assert.equal(teleportNativeRevisionBlocksMutation(classified.status), false);
    assert.deepEqual(resolveNativeForkPlan(classified), {
      action: "reuse",
      threadId: FORK_THREAD,
    });
  });
});

describe("native fork idempotency", () => {
  it("derives a stable thread id from the source and observed digest", () => {
    const left = nativeForkThreadId(SOURCE_THREAD, "native-later");
    const right = nativeForkThreadId(SOURCE_THREAD, "native-later");
    assert.equal(left, right);
    assert.equal(left, "teleport-fork:thread-source:native-later");
    assert.notEqual(nativeForkThreadId(SOURCE_THREAD, "native-even-later"), left);
    assert.notEqual(nativeForkThreadId(ThreadId.make("thread-other"), "native-later"), left);
  });

  it("reuses a covering fork after a create conflict and ignores unrelated collisions", () => {
    const covering = reuseNativeForkAfterCreateConflict({
      existing: {
        id: nativeForkThreadId(SOURCE_THREAD, "native-later"),
        teleport: t3Teleport({
          nativeRevision: revision("native-later", 20),
          forkedFromThreadId: SOURCE_THREAD,
        }),
      },
      sourceThreadId: SOURCE_THREAD,
      observedDigest: "native-later",
    });
    assert.equal(covering?.id, nativeForkThreadId(SOURCE_THREAD, "native-later"));
    assert.equal(
      reuseNativeForkAfterCreateConflict({
        existing: {
          id: nativeForkThreadId(SOURCE_THREAD, "native-later"),
          teleport: t3Teleport({ nativeRevision: revision("other", 8) }),
        },
        sourceThreadId: SOURCE_THREAD,
        observedDigest: "native-later",
      }),
      undefined,
    );
    assert.equal(
      reuseNativeForkAfterCreateConflict({
        sourceThreadId: SOURCE_THREAD,
        observedDigest: "native-later",
      }),
      undefined,
    );
  });

  it("reuses a fork for the same observed digest and ignores the source thread", () => {
    const covering = findCoveringNativeFork({
      sourceThreadId: SOURCE_THREAD,
      observedDigest: "native-later",
      threads: [
        {
          id: SOURCE_THREAD,
          teleport: t3Teleport({ nativeRevision: revision("import", 10) }),
        },
        {
          id: FORK_THREAD,
          teleport: t3Teleport({
            nativeRevision: revision("native-later", 20),
            forkedFromThreadId: SOURCE_THREAD,
          }),
        },
      ],
    });
    assert.equal(covering?.id, FORK_THREAD);
    assert.notEqual(covering?.id, SOURCE_THREAD);
  });

  it("creates a new fork when the native digest changed again", () => {
    const covering = findCoveringNativeFork({
      sourceThreadId: SOURCE_THREAD,
      observedDigest: "native-even-later",
      threads: [
        {
          id: FORK_THREAD,
          teleport: t3Teleport({
            nativeRevision: revision("native-later", 20),
            forkedFromThreadId: SOURCE_THREAD,
          }),
        },
      ],
    });
    assert.equal(covering, undefined);
    assert.deepEqual(
      resolveNativeForkPlan({
        status: "diverged",
        persistedRevision: revision("import", 10),
        observedRevision: revision("native-even-later", 24),
      }),
      { action: "create" },
    );
  });
});

describe("native file observation", () => {
  it.effect("binds the persisted revision to the exact bytes parsed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "teleport-revision-parse-" });
      const nativePath = path.join(root, "session.jsonl");
      const contents = "native snapshot";
      yield* fs.writeFileString(nativePath, contents);
      const parsed = yield* readNativeSessionFile({
        nativePath,
        parse: () =>
          Effect.succeed(
            Option.some({
              ...sampleTeleportSession("codex"),
              nativePath,
            }),
          ),
      });
      const expected = yield* nativeRevisionFromBytes(new TextEncoder().encode(contents));
      assert.equal(Option.isSome(parsed), true);
      if (Option.isSome(parsed)) {
        assert.deepEqual(parsed.value.nativeRevision, expected);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("hashes unchanged, changed, same-size, and missing files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "teleport-revision-" });
      const nativePath = path.join(root, "session.jsonl");
      yield* fs.writeFileString(nativePath, SAME_SIZE_LEFT);
      const first = yield* observeNativeRevision(nativePath);
      assert.equal(first.status, "observed");
      if (first.status !== "observed") {
        return;
      }
      const persisted = first.revision;

      const unchanged = yield* observeNativeRevision(nativePath);
      assert.equal(unchanged.status, "observed");
      if (unchanged.status === "observed") {
        assert.equal(nativeRevisionsEqual(persisted, unchanged.revision), true);
        assert.equal(
          classifyNativeRevision({
            teleport: t3Teleport({ nativeRevision: persisted }),
            observation: unchanged,
          }).status,
          "unchanged",
        );
      }

      yield* fs.writeFileString(nativePath, SAME_SIZE_RIGHT);
      const sameSize = yield* observeNativeRevision(nativePath);
      assert.equal(sameSize.status, "observed");
      if (sameSize.status === "observed") {
        assert.equal(sameSize.revision.byteLength, persisted.byteLength);
        assert.equal(sameSize.revision.digest === persisted.digest, false);
        assert.equal(
          classifyNativeRevision({
            teleport: t3Teleport({ nativeRevision: persisted }),
            observation: sameSize,
          }).status,
          "diverged",
        );
      }

      yield* fs.writeFileString(nativePath, `${SAME_SIZE_RIGHT}\nextra`);
      const grown = yield* observeNativeRevision(nativePath);
      assert.equal(grown.status, "observed");
      if (grown.status === "observed") {
        assert.equal(grown.revision.byteLength === persisted.byteLength, false);
        assert.equal(
          classifyNativeRevision({
            teleport: t3Teleport({ nativeRevision: persisted }),
            observation: grown,
          }).status,
          "diverged",
        );
      }

      yield* fs.remove(nativePath);
      const missing = yield* observeNativeRevision(nativePath);
      assert.equal(missing.status, "missing");
      assert.equal(
        classifyNativeRevision({
          teleport: t3Teleport({ nativeRevision: persisted }),
          observation: missing,
        }).status,
        "missing",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("re-detects divergence after process restart from the persisted revision", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "teleport-revision-restart-" });
      const nativePath = path.join(root, "session.jsonl");
      yield* fs.writeFileString(nativePath, "imported-contents");
      const imported = yield* observeNativeRevision(nativePath);
      assert.equal(imported.status, "observed");
      if (imported.status !== "observed") {
        return;
      }
      const persistedTeleport = t3Teleport({ nativeRevision: imported.revision });
      // Simulate a new process: only the persisted TeleportThreadState remains.
      yield* fs.writeFileString(nativePath, "cli-wrote-more");
      const afterRestart = yield* observeNativeRevision(nativePath);
      assert.equal(
        classifyNativeRevision({
          teleport: persistedTeleport,
          observation: afterRestart,
        }).status,
        "diverged",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("detects same-size Codex and Claude native transcript edits", () =>
    Effect.gen(function* () {
      const hash = (contents: string) =>
        nativeRevisionFromBytes(new TextEncoder().encode(contents));
      const changedSession = (provider: "codex" | "claudeAgent") => ({
        ...sampleTeleportSession(provider),
        messages: sampleTeleportSession(provider).messages.map((message, index) =>
          index === 0 ? { ...message, text: "Fix the shaky matcher" } : message,
        ),
      });

      const originalCodex = serializeCodexSession(sampleTeleportSession("codex"));
      const changedCodex = serializeCodexSession(changedSession("codex"));
      const originalClaude = serializeClaudeSession(sampleTeleportSession("claudeAgent"));
      const changedClaude = serializeClaudeSession(changedSession("claudeAgent"));

      const [codexLeft, codexRight, claudeLeft, claudeRight] = yield* Effect.all([
        hash(originalCodex),
        hash(changedCodex),
        hash(originalClaude),
        hash(changedClaude),
      ]);

      assert.equal(codexLeft.digest === codexRight.digest, false);
      assert.equal(claudeLeft.digest === claudeRight.digest, false);
      assert.equal(
        classifyNativeRevision({
          teleport: { ...t3Teleport({ nativeRevision: codexLeft }), provider: "codex" },
          observation: { status: "observed", revision: codexRight },
        }).status,
        "diverged",
      );
      assert.equal(
        classifyNativeRevision({
          teleport: { ...t3Teleport({ nativeRevision: claudeLeft }), provider: "claudeAgent" },
          observation: { status: "observed", revision: claudeRight },
        }).status,
        "diverged",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
