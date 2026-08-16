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
        archivedAt: null,
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
});
