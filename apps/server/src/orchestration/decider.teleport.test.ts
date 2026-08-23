import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type TeleportThreadState,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";

const NATIVE_TELEPORT: TeleportThreadState = {
  presence: "native",
  provider: "codex",
  externalSessionId: "01a00270-6f96-7ce3-9244-ab159194e668",
  nativePath: "/home/user/.codex/sessions/session.jsonl",
  lastSyncedAt: NOW,
};

function makeReadModel(input: {
  readonly teleport?: OrchestrationThread["teleport"];
  readonly session?: OrchestrationThread["session"];
  readonly messages?: OrchestrationThread["messages"];
  readonly archivedAt?: OrchestrationThread["archivedAt"];
}): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: input.archivedAt ?? null,
        settledOverride: null,
        settledAt: null,
        deletedAt: null,
        messages: input.messages ?? [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: input.session ?? null,
        ...(input.teleport !== undefined ? { teleport: input.teleport } : {}),
      },
    ],
    updatedAt: NOW,
  };
}

it.layer(NodeServices.layer)("teleport thread decider", (it) => {
  it.effect("sets teleport presence on a thread", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.teleport.set",
          commandId: CommandId.make("cmd-teleport-set"),
          threadId: ThreadId.make("thread-1"),
          teleport: NATIVE_TELEPORT,
          createdAt: NOW,
        },
        readModel: makeReadModel({}),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("thread.teleported");
      if (events[0]?.type === "thread.teleported") {
        expect(events[0].payload.teleport).toEqual(NATIVE_TELEPORT);
        expect(events[0].payload.updatedAt).toBe(NOW);
      }
    }),
  );

  it.effect("rejects turn start on an archived thread", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-archived"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: MessageId.make("message-1"),
            role: "user",
            text: "hello",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: NOW,
        },
        readModel: makeReadModel({ archivedAt: NOW }),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      if (error._tag === "OrchestrationCommandInvariantError") {
        expect(error.detail).toContain("archived");
      }
    }),
  );

  it.effect("rejects turn start while the thread is in the native CLI", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-start"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: MessageId.make("message-1"),
            role: "user",
            text: "hello",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: NOW,
        },
        readModel: makeReadModel({ teleport: NATIVE_TELEPORT }),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      if (error._tag === "OrchestrationCommandInvariantError") {
        expect(error.detail).toContain("native CLI");
      }
    }),
  );

  it.effect("allows turn start while the thread is owned by T3", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-start"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: MessageId.make("message-1"),
            role: "user",
            text: "hello",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: NOW,
        },
        readModel: makeReadModel({
          teleport: {
            ...NATIVE_TELEPORT,
            presence: "t3",
          },
        }),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events.map((entry) => entry.type)).toContain("thread.turn-start-requested");
    }),
  );

  it.effect("rejects native teleport while the T3 session is running", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.teleport.set",
          commandId: CommandId.make("cmd-teleport-busy"),
          threadId: ThreadId.make("thread-1"),
          teleport: NATIVE_TELEPORT,
          createdAt: NOW,
        },
        readModel: makeReadModel({
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "running",
            providerName: "codex",
            providerInstanceId: ProviderInstanceId.make("codex"),
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: NOW,
          },
        }),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      if (error._tag === "OrchestrationCommandInvariantError") {
        expect(error.detail).toContain("starting or running");
      }
    }),
  );

  it.effect("allows immediate export after importing recent native history", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.teleport.set",
          commandId: CommandId.make("cmd-export-after-import"),
          threadId: ThreadId.make("thread-1"),
          teleport: NATIVE_TELEPORT,
          createdAt: "2026-01-01T00:00:01.000Z",
        },
        readModel: makeReadModel({
          teleport: {
            ...NATIVE_TELEPORT,
            presence: "t3",
          },
          messages: [
            {
              id: MessageId.make("imported-user"),
              role: "user",
              text: "imported prompt",
              turnId: null,
              streaming: false,
              createdAt: NOW,
              updatedAt: NOW,
            },
          ],
        }),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events[0]?.type).toBe("thread.teleported");
    }),
  );

  it.effect("still rejects export when a T3 turn queued after the last import", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.teleport.set",
          commandId: CommandId.make("cmd-export-queued"),
          threadId: ThreadId.make("thread-1"),
          teleport: NATIVE_TELEPORT,
          createdAt: "2026-01-01T00:00:02.000Z",
        },
        readModel: makeReadModel({
          teleport: {
            ...NATIVE_TELEPORT,
            presence: "t3",
          },
          messages: [
            {
              id: MessageId.make("queued-user"),
              role: "user",
              text: "queued prompt",
              turnId: null,
              streaming: false,
              createdAt: "2026-01-01T00:00:01.000Z",
              updatedAt: "2026-01-01T00:00:01.000Z",
            },
          ],
        }),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      if (error._tag === "OrchestrationCommandInvariantError") {
        expect(error.detail).toContain("queued");
      }
    }),
  );

  it.effect("allows re-import fencing from native presence with recent history", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.teleport.set",
          commandId: CommandId.make("cmd-reimport-native"),
          threadId: ThreadId.make("thread-1"),
          teleport: {
            ...NATIVE_TELEPORT,
            presence: "importing",
            restorePresence: "native",
          },
          createdAt: "2026-01-01T00:00:01.000Z",
        },
        readModel: makeReadModel({
          teleport: NATIVE_TELEPORT,
          messages: [
            {
              id: MessageId.make("native-user"),
              role: "user",
              text: "native prompt",
              turnId: null,
              streaming: false,
              createdAt: NOW,
              updatedAt: NOW,
            },
          ],
        }),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events[0]?.type).toBe("thread.teleported");
    }),
  );

  it.effect("rejects history replace while the T3 session is running", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.history.replace",
          commandId: CommandId.make("cmd-history-busy"),
          threadId: ThreadId.make("thread-1"),
          messages: [],
          createdAt: NOW,
        },
        readModel: makeReadModel({
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "running",
            providerName: "codex",
            providerInstanceId: ProviderInstanceId.make("codex"),
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: NOW,
          },
        }),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      if (error._tag === "OrchestrationCommandInvariantError") {
        expect(error.detail).toContain("starting or running");
      }
    }),
  );

  it.effect("rejects turn start while a native import is in progress", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-importing"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: MessageId.make("message-1"),
            role: "user",
            text: "hello",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: NOW,
        },
        readModel: makeReadModel({
          teleport: {
            ...NATIVE_TELEPORT,
            presence: "importing",
            restorePresence: "native",
          },
        }),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      if (error._tag === "OrchestrationCommandInvariantError") {
        expect(error.detail).toContain("being imported");
      }
    }),
  );

  it.effect("imports native history, T3 ownership, and unarchive as one command", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.teleport.import",
          commandId: CommandId.make("cmd-teleport-import"),
          threadId: ThreadId.make("thread-1"),
          teleport: {
            ...NATIVE_TELEPORT,
            presence: "t3",
          },
          messages: [
            {
              id: MessageId.make("imported-1"),
              role: "user",
              text: "imported",
              turnId: null,
              streaming: false,
              createdAt: NOW,
              updatedAt: NOW,
            },
          ],
          createdAt: NOW,
        },
        readModel: makeReadModel({
          teleport: NATIVE_TELEPORT,
          archivedAt: NOW,
          messages: [
            {
              id: MessageId.make("old-1"),
              role: "user",
              text: "old",
              turnId: null,
              streaming: false,
              createdAt: "2025-12-01T00:00:00.000Z",
              updatedAt: "2025-12-01T00:00:00.000Z",
            },
          ],
        }),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.map((event) => event.type)).toEqual([
        "thread.unarchived",
        "thread.teleported",
        "thread.history-replaced",
      ]);
      expect(new Set(events.map((event) => event.commandId)).size).toBe(1);
      const teleported = events[1];
      const replaced = events[2];
      expect(teleported?.type).toBe("thread.teleported");
      if (teleported?.type === "thread.teleported") {
        expect(teleported.payload.teleport?.presence).toBe("t3");
        expect(teleported.payload.teleport?.restorePresence).toBeUndefined();
      }
      expect(replaced?.type).toBe("thread.history-replaced");
      if (replaced?.type === "thread.history-replaced") {
        expect(replaced.payload.messages).toHaveLength(1);
        expect(replaced.payload.messages[0]?.text).toBe("imported");
      }
    }),
  );

  it.effect("keeps the persisted native revision on import commit", () =>
    Effect.gen(function* () {
      const nativeRevision = {
        algorithm: "sha256" as const,
        digest: "abc",
        byteLength: 12,
      };
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.teleport.import",
          commandId: CommandId.make("cmd-teleport-import-revision"),
          threadId: ThreadId.make("thread-1"),
          teleport: {
            ...NATIVE_TELEPORT,
            presence: "t3",
            nativeRevision,
            forkedFromThreadId: ThreadId.make("thread-source"),
          },
          messages: [],
          createdAt: NOW,
        },
        readModel: makeReadModel({ teleport: NATIVE_TELEPORT }),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      const teleported = events.find((event) => event.type === "thread.teleported");
      expect(teleported?.type).toBe("thread.teleported");
      if (teleported?.type === "thread.teleported") {
        expect(teleported.payload.teleport?.nativeRevision).toEqual(nativeRevision);
        expect(teleported.payload.teleport?.forkedFromThreadId).toBe("thread-source");
      }
    }),
  );

  it.effect("rejects native history import while the T3 session is running", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.teleport.import",
          commandId: CommandId.make("cmd-import-busy"),
          threadId: ThreadId.make("thread-1"),
          teleport: {
            ...NATIVE_TELEPORT,
            presence: "t3",
          },
          messages: [],
          createdAt: NOW,
        },
        readModel: makeReadModel({
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "running",
            providerName: "codex",
            providerInstanceId: ProviderInstanceId.make("codex"),
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: NOW,
          },
        }),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      if (error._tag === "OrchestrationCommandInvariantError") {
        expect(error.detail).toContain("starting or running");
      }
    }),
  );

  it.effect("clears teleport without replacing history", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.teleport.clear",
          commandId: CommandId.make("cmd-teleport-clear"),
          threadId: ThreadId.make("thread-1"),
          createdAt: NOW,
        },
        readModel: makeReadModel({
          teleport: {
            ...NATIVE_TELEPORT,
            presence: "importing",
            restorePresence: "t3",
            nativeRevision: {
              algorithm: "sha256",
              digest: "uncommitted",
              byteLength: 12,
            },
          },
          messages: [
            {
              id: MessageId.make("original"),
              role: "user",
              text: "original t3 history",
              turnId: null,
              streaming: false,
              createdAt: NOW,
              updatedAt: NOW,
            },
          ],
        }),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("thread.teleported");
      if (events[0]?.type === "thread.teleported") {
        expect(events[0].payload.teleport).toBeNull();
      }
    }),
  );
});
