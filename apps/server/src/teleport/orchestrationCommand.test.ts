import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "../orchestration/decider.ts";
import { createEmptyReadModel, projectEvent } from "../orchestration/projector.ts";

const asEventId = (value: string): EventId => EventId.make(value);
const asMessageId = (value: string): MessageId => MessageId.make(value);
const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");

async function createTeleportTargetReadModel(now: string) {
  const withProject = await Effect.runPromise(
    projectEvent(createEmptyReadModel(now), {
      sequence: 1,
      eventId: asEventId("evt-project-create-helper"),
      aggregateKind: "project",
      aggregateId: projectId,
      type: "project.created",
      occurredAt: now,
      commandId: CommandId.make("cmd-project-create-helper"),
      causationEventId: null,
      correlationId: CommandId.make("cmd-project-create-helper"),
      metadata: {},
      payload: {
        projectId,
        title: "Project",
        workspaceRoot: "/tmp/project",
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      },
    }),
  );

  return Effect.runPromise(
    projectEvent(withProject, {
      sequence: 2,
      eventId: asEventId("evt-thread-create-helper"),
      aggregateKind: "thread",
      aggregateId: threadId,
      type: "thread.created",
      occurredAt: now,
      commandId: CommandId.make("cmd-thread-create-helper"),
      causationEventId: null,
      correlationId: CommandId.make("cmd-thread-create-helper"),
      metadata: {},
      payload: {
        threadId,
        projectId,
        title: "Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt: now,
        updatedAt: now,
      },
    }),
  );
}

describe("teleport orchestration command support", () => {
  it("emits historical message events without starting a provider turn", async () => {
    const now = "2026-01-01T00:00:00.000Z";
    const readModel = await createTeleportTargetReadModel(now);

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.message.append",
          commandId: CommandId.make("cmd-message-append"),
          threadId,
          message: {
            id: asMessageId("message-history-1"),
            role: "user",
            text: "historical user request",
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
          createdAt: now,
        },
        readModel,
      }),
    );

    const event = Array.isArray(result) ? result[0] : result;
    expect(event).toMatchObject({
      type: "thread.message-sent",
      metadata: { teleportHistory: true },
      payload: {
        threadId,
        messageId: asMessageId("message-history-1"),
        role: "user",
        text: "historical user request",
        attachments: [],
        turnId: null,
        streaming: false,
      },
    });
  });
});
