// @effect-diagnostics nodeBuiltinImport:off
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  type OrchestrationCommand,
  type OrchestrationProject,
  type OrchestrationProjectShell,
  type OrchestrationShellSnapshot,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderSession,
  ThreadId,
} from "@t3tools/contracts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBinding,
  type ProviderSessionDirectoryShape,
} from "../../provider/Services/ProviderSessionDirectory.ts";
import { ExternalLauncher, type ExternalLauncherShape } from "../../process/externalLauncher.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../orchestration/Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { TeleportService } from "../Services/TeleportService.ts";
import { TeleportServiceLive } from "./TeleportService.ts";

interface TestState {
  readonly dispatches: OrchestrationCommand[];
  readonly bindings: ProviderRuntimeBinding[];
  readonly starts: Array<Parameters<ProviderServiceShape["startSession"]>>;
  readonly stops: ThreadId[];
  readonly terminalLaunches: string[];
  readonly providerDisplayName?: string;
  readonly startFailure?: Error;
  readonly existingThread?: OrchestrationThread;
  readonly existingBinding?: ProviderRuntimeBinding;
  readonly existingProject?: OrchestrationProjectShell;
  returnedResumeCursor: unknown;
}

const iso = "2026-05-25T12:00:00.000Z";
let previousHome: string | undefined;
let testHome: string;

function makeProviderSession(input: {
  readonly threadId: ThreadId;
  readonly provider: string;
  readonly instanceId: string;
  readonly resumeCursor: unknown;
}): ProviderSession {
  return {
    provider: ProviderDriverKind.make(input.provider),
    providerInstanceId: ProviderInstanceId.make(input.instanceId),
    status: "ready",
    runtimeMode: "full-access",
    threadId: input.threadId,
    resumeCursor: input.resumeCursor,
    createdAt: iso,
    updatedAt: iso,
  };
}

function makeExistingThread(
  input: Partial<OrchestrationThread> & { readonly id: ThreadId },
): OrchestrationThread {
  return {
    id: input.id,
    projectId: input.projectId ?? ProjectId.make("project-existing"),
    title: input.title ?? "Existing thread",
    modelSelection: input.modelSelection ?? {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4-mini",
    },
    runtimeMode: input.runtimeMode ?? "full-access",
    interactionMode: input.interactionMode ?? "default",
    branch: input.branch ?? null,
    worktreePath: input.worktreePath ?? null,
    latestTurn: input.latestTurn ?? null,
    createdAt: input.createdAt ?? iso,
    updatedAt: input.updatedAt ?? iso,
    archivedAt: input.archivedAt ?? null,
    deletedAt: input.deletedAt ?? null,
    messages: input.messages ?? [],
    proposedPlans: input.proposedPlans ?? [],
    activities: input.activities ?? [],
    checkpoints: input.checkpoints ?? [],
    session: input.session ?? null,
  };
}

function makeExistingProject(
  input: Partial<OrchestrationProjectShell> & { readonly id: ProjectId },
): OrchestrationProjectShell {
  return {
    id: input.id,
    title: input.title ?? "Existing project",
    workspaceRoot: input.workspaceRoot ?? "/tmp/t3-project",
    repositoryIdentity: input.repositoryIdentity ?? null,
    defaultModelSelection: input.defaultModelSelection ?? null,
    scripts: input.scripts ?? [],
    createdAt: input.createdAt ?? iso,
    updatedAt: input.updatedAt ?? iso,
  };
}

function makeTestLayer(state: TestState) {
  const providerService: ProviderServiceShape = {
    startSession: (threadId, input) =>
      Effect.gen(function* () {
        state.starts.push([threadId, input]);
        if (state.startFailure) {
          return yield* Effect.fail(state.startFailure as never);
        }
        return makeProviderSession({
          threadId,
          provider: input.provider ?? "codex",
          instanceId: String(input.providerInstanceId ?? "codex"),
          resumeCursor: state.returnedResumeCursor,
        });
      }),
    sendTurn: () => Effect.die("sendTurn is not used"),
    interruptTurn: () => Effect.die("interruptTurn is not used"),
    respondToRequest: () => Effect.die("respondToRequest is not used"),
    respondToUserInput: () => Effect.die("respondToUserInput is not used"),
    stopSession: (input) =>
      Effect.sync(() => {
        state.stops.push(input.threadId);
      }),
    listSessions: () => Effect.succeed([]),
    getCapabilities: () => Effect.die("getCapabilities is not used"),
    getInstanceInfo: (instanceId) =>
      Effect.succeed({
        instanceId,
        driverKind: ProviderDriverKind.make(String(instanceId)),
        displayName: state.providerDisplayName ?? String(instanceId),
        enabled: true,
        continuationIdentity: {
          driverKind: ProviderDriverKind.make(String(instanceId)),
          continuationKey: `${String(instanceId)}:test`,
        },
      }),
    rollbackConversation: () => Effect.die("rollbackConversation is not used"),
    streamEvents: Stream.empty,
  };

  const directory: ProviderSessionDirectoryShape = {
    upsert: (binding) =>
      Effect.sync(() => {
        state.bindings.push(binding);
      }),
    getProvider: () => Effect.die("getProvider is not used"),
    getBinding: () =>
      Effect.succeed(state.existingBinding ? Option.some(state.existingBinding) : Option.none()),
    listThreadIds: () => Effect.succeed([]),
    listBindings: () => Effect.succeed([]),
  };

  const orchestrationEngine: OrchestrationEngineShape = {
    readEvents: () => Stream.empty,
    dispatch: (command) =>
      Effect.sync(() => {
        state.dispatches.push(command);
        return { sequence: state.dispatches.length };
      }),
    streamDomainEvents: Stream.empty,
  };

  const projection: ProjectionSnapshotQueryShape = {
    getCommandReadModel: () => Effect.die("getCommandReadModel is not used"),
    getSnapshot: () => Effect.die("getSnapshot is not used"),
    getShellSnapshot: () => Effect.die("getShellSnapshot is not used"),
    getArchivedShellSnapshot: () =>
      Effect.succeed({
        snapshotSequence: 0,
        projects: [],
        threads: [],
        updatedAt: iso,
      } satisfies OrchestrationShellSnapshot),
    getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
    getCounts: () => Effect.succeed({ projectCount: 0, threadCount: 0 }),
    getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none<OrchestrationProject>()),
    getProjectShellById: () =>
      Effect.succeed(state.existingProject ? Option.some(state.existingProject) : Option.none()),
    getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
    getThreadCheckpointContext: () => Effect.succeed(Option.none()),
    getFullThreadDiffContext: () => Effect.succeed(Option.none()),
    getThreadShellById: () => Effect.succeed(Option.none<OrchestrationThreadShell>()),
    getThreadDetailById: () =>
      Effect.succeed(state.existingThread ? Option.some(state.existingThread) : Option.none()),
  };

  const externalLauncher: ExternalLauncherShape = {
    launchBrowser: () => Effect.die("launchBrowser is not used"),
    launchEditor: () => Effect.die("launchEditor is not used"),
    launchTerminalCommand: (input) =>
      Effect.sync(() => {
        state.terminalLaunches.push(input.command);
      }),
  };

  return TeleportServiceLive.pipe(
    Layer.provideMerge(Layer.succeed(ProviderService, providerService)),
    Layer.provideMerge(Layer.succeed(ProviderSessionDirectory, directory)),
    Layer.provideMerge(Layer.succeed(OrchestrationEngineService, orchestrationEngine)),
    Layer.provideMerge(Layer.succeed(ProjectionSnapshotQuery, projection)),
    Layer.provideMerge(Layer.succeed(ExternalLauncher, externalLauncher)),
  );
}

describe("TeleportService", () => {
  beforeEach(async () => {
    previousHome = process.env.HOME;
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "t3-teleport-service-home-"));
    process.env.HOME = testHome;
  });

  afterEach(() => {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  });

  it("backfills recoverable Codex history before the import activity", async () => {
    const sessionDir = path.join(testHome, ".codex", "sessions", "2026", "05", "25");
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, "rollout-codex-history-session-1.jsonl"),
      [
        JSON.stringify({
          timestamp: "2026-05-25T12:00:00.000Z",
          type: "session_meta",
          payload: {
            id: "codex-history-session-1",
            cwd: "/tmp/t3-teleport",
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-25T12:01:00.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Original CLI request" }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-25T12:02:00.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Original Codex answer" }],
          },
        }),
      ].join("\n"),
    );
    const state: TestState = {
      dispatches: [],
      bindings: [],
      starts: [],
      stops: [],
      terminalLaunches: [],
      returnedResumeCursor: { threadId: "codex-history-session-1" },
    };

    await Effect.runPromise(
      Effect.gen(function* () {
        const teleport = yield* TeleportService;
        return yield* teleport.importSession({
          providerInstanceId: ProviderInstanceId.make("codex"),
          provider: ProviderDriverKind.make("codex"),
          externalSessionId: "codex-history-session-1",
          cwd: "/tmp/t3-teleport",
          runtimeMode: "full-access",
          interactionMode: "default",
          startSession: true,
        });
      }).pipe(Effect.provide(makeTestLayer(state))),
    );

    expect(state.dispatches.map((command) => command.type)).toEqual([
      "project.create",
      "thread.create",
      "thread.message.append",
      "thread.message.append",
      "thread.session.set",
      "thread.activity.append",
    ]);
    expect(state.dispatches.filter((command) => command.type === "thread.message.append")).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({
          role: "user",
          text: "Original CLI request",
          streaming: false,
        }),
      }),
      expect.objectContaining({
        message: expect.objectContaining({
          role: "assistant",
          text: "Original Codex answer",
          streaming: false,
        }),
      }),
    ]);
    expect(
      state.dispatches.find(
        (command) =>
          command.type === "thread.activity.append" &&
          command.activity.kind === "teleport.imported",
      ),
    ).toMatchObject({
      activity: {
        summary:
          "Imported codex session codex-history-session-1. Rendered 2 prior provider messages; earlier history may be omitted, and the next turn will continue from the imported provider session.",
        payload: {
          historyMessageCount: 2,
        },
      },
    });
  });

  it("imports a Codex session into a new T3 thread with strict provider resume", async () => {
    const state: TestState = {
      dispatches: [],
      bindings: [],
      starts: [],
      stops: [],
      terminalLaunches: [],
      returnedResumeCursor: { threadId: "codex-external-thread" },
    };

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const teleport = yield* TeleportService;
        return yield* teleport.importSession({
          providerInstanceId: ProviderInstanceId.make("codex"),
          provider: ProviderDriverKind.make("codex"),
          externalSessionId: "codex-external-thread",
          cwd: "/tmp/t3-teleport",
          runtimeMode: "full-access",
          interactionMode: "default",
          startSession: true,
        });
      }).pipe(Effect.provide(makeTestLayer(state))),
    );

    expect(result.threadId).toBeDefined();
    expect(result.projectId).toBeDefined();
    expect(state.dispatches.map((command) => command.type)).toEqual([
      "project.create",
      "thread.create",
      "thread.session.set",
      "thread.activity.append",
    ]);
    expect(state.starts).toHaveLength(1);
    expect(state.starts[0]?.[1]).toMatchObject({
      provider: "codex",
      providerInstanceId: "codex",
      cwd: "/tmp/t3-teleport",
      resumeCursor: { threadId: "codex-external-thread" },
      strictResume: true,
    });
    expect(state.bindings[0]).toMatchObject({
      provider: "codex",
      providerInstanceId: "codex",
      status: "starting",
      resumeCursor: { threadId: "codex-external-thread" },
    });
    expect(
      state.dispatches.find(
        (command) =>
          command.type === "thread.activity.append" &&
          command.activity.kind === "teleport.imported",
      ),
    ).toMatchObject({
      activity: {
        summary:
          "Imported codex session codex-external-thread. Previous provider history may not be fully rendered, but the next turn will continue from the imported provider session.",
      },
    });
  });

  it("stores the provider driver id on imported sessions when the provider has a display name", async () => {
    const state: TestState = {
      dispatches: [],
      bindings: [],
      starts: [],
      stops: [],
      terminalLaunches: [],
      providerDisplayName: "Codex",
      returnedResumeCursor: { threadId: "codex-external-thread" },
    };

    await Effect.runPromise(
      Effect.gen(function* () {
        const teleport = yield* TeleportService;
        return yield* teleport.importSession({
          providerInstanceId: ProviderInstanceId.make("codex"),
          provider: ProviderDriverKind.make("codex"),
          externalSessionId: "codex-external-thread",
          cwd: "/tmp/t3-teleport",
          runtimeMode: "full-access",
          interactionMode: "default",
          startSession: true,
        });
      }).pipe(Effect.provide(makeTestLayer(state))),
    );

    expect(state.dispatches.find((command) => command.type === "thread.session.set")).toMatchObject(
      {
        session: {
          providerName: "codex",
          providerInstanceId: "codex",
        },
      },
    );
    expect(
      state.dispatches.find(
        (command) =>
          command.type === "thread.activity.append" &&
          command.activity.kind === "teleport.imported",
      ),
    ).toMatchObject({
      activity: {
        summary:
          "Imported Codex session codex-external-thread. Previous provider history may not be fully rendered, but the next turn will continue from the imported provider session.",
      },
    });
  });

  it("marks the binding as errored when provider strict resume fails", async () => {
    const state: TestState = {
      dispatches: [],
      bindings: [],
      starts: [],
      stops: [],
      terminalLaunches: [],
      startFailure: new Error("thread/resume failed"),
      returnedResumeCursor: { threadId: "codex-external-thread" },
    };

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const teleport = yield* TeleportService;
          return yield* teleport.importSession({
            providerInstanceId: ProviderInstanceId.make("codex"),
            provider: ProviderDriverKind.make("codex"),
            externalSessionId: "codex-external-thread",
            cwd: "/tmp/t3-teleport",
            runtimeMode: "full-access",
            interactionMode: "default",
            startSession: true,
          });
        }).pipe(Effect.provide(makeTestLayer(state))),
      ),
    ).rejects.toMatchObject({ _tag: "TeleportProviderStartError" });

    expect(state.bindings.at(-1)).toMatchObject({
      status: "error",
      runtimePayload: {
        lastError: "thread/resume failed",
      },
    });
    expect(state.dispatches.map((command) => command.type)).toEqual([
      "project.create",
      "thread.create",
    ]);
  });

  it("cleans up and fails when strict provider resume returns a different session id", async () => {
    const state: TestState = {
      dispatches: [],
      bindings: [],
      starts: [],
      stops: [],
      terminalLaunches: [],
      returnedResumeCursor: { threadId: "different-codex-thread" },
    };

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const teleport = yield* TeleportService;
          return yield* teleport.importSession({
            providerInstanceId: ProviderInstanceId.make("codex"),
            provider: ProviderDriverKind.make("codex"),
            externalSessionId: "codex-external-thread",
            cwd: "/tmp/t3-teleport",
            runtimeMode: "full-access",
            interactionMode: "default",
            startSession: true,
          });
        }).pipe(Effect.provide(makeTestLayer(state))),
      ),
    ).rejects.toMatchObject({ _tag: "TeleportProviderStartError" });

    expect(state.starts).toHaveLength(1);
    expect(state.stops).toEqual([state.starts[0]?.[0]]);
    expect(state.bindings.at(-1)).toMatchObject({
      status: "error",
      runtimePayload: {
        lastError:
          "Provider returned session 'different-codex-thread' for requested import 'codex-external-thread'.",
      },
    });
  });

  it("rejects active target T3 threads", async () => {
    const threadId = ThreadId.make("thread-active");
    const state: TestState = {
      dispatches: [],
      bindings: [],
      starts: [],
      stops: [],
      terminalLaunches: [],
      existingThread: makeExistingThread({
        id: threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: iso,
        },
      }),
      returnedResumeCursor: { threadId: "codex-external-thread" },
    };

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const teleport = yield* TeleportService;
          return yield* teleport.importSession({
            providerInstanceId: ProviderInstanceId.make("codex"),
            provider: ProviderDriverKind.make("codex"),
            externalSessionId: "codex-external-thread",
            cwd: "/tmp/t3-teleport",
            threadId,
            runtimeMode: "full-access",
            interactionMode: "default",
            startSession: true,
          });
        }).pipe(Effect.provide(makeTestLayer(state))),
      ),
    ).rejects.toMatchObject({ _tag: "TeleportInvalidInputError" });

    expect(state.starts).toHaveLength(0);
    expect(state.bindings).toHaveLength(0);
  });

  it("rejects incompatible existing provider bindings", async () => {
    const threadId = ThreadId.make("thread-bound");
    const state: TestState = {
      dispatches: [],
      bindings: [],
      starts: [],
      stops: [],
      terminalLaunches: [],
      existingThread: makeExistingThread({ id: threadId }),
      existingBinding: {
        threadId,
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        status: "stopped",
        runtimeMode: "full-access",
        resumeCursor: { threadId: "other-codex-thread" },
        runtimePayload: null,
      },
      returnedResumeCursor: { threadId: "codex-external-thread" },
    };

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const teleport = yield* TeleportService;
          return yield* teleport.importSession({
            providerInstanceId: ProviderInstanceId.make("codex"),
            provider: ProviderDriverKind.make("codex"),
            externalSessionId: "codex-external-thread",
            cwd: "/tmp/t3-teleport",
            threadId,
            runtimeMode: "full-access",
            interactionMode: "default",
            startSession: true,
          });
        }).pipe(Effect.provide(makeTestLayer(state))),
      ),
    ).rejects.toMatchObject({ _tag: "TeleportInvalidInputError" });

    expect(state.starts).toHaveLength(0);
    expect(state.bindings).toHaveLength(0);
  });

  it("teleports an idle T3 thread out to the provider CLI", async () => {
    const projectId = ProjectId.make("project-launch");
    const threadId = ThreadId.make("thread-launch");
    const state: TestState = {
      dispatches: [],
      bindings: [],
      starts: [],
      stops: [],
      terminalLaunches: [],
      existingProject: makeExistingProject({
        id: projectId,
        workspaceRoot: "/tmp/codex-project",
      }),
      existingThread: makeExistingThread({
        id: threadId,
        projectId,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: iso,
        },
      }),
      existingBinding: {
        threadId,
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        status: "running",
        runtimeMode: "full-access",
        resumeCursor: { threadId: "019e5e6e-6a3f-7b90-bb41-7bf17abf0e14" },
        runtimePayload: { cwd: "/tmp/codex-project" },
      },
      returnedResumeCursor: { threadId: "unused" },
    };

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const teleport = yield* TeleportService;
        return yield* teleport.launchExternalSession({ threadId });
      }).pipe(Effect.provide(makeTestLayer(state))),
    );

    expect(result).toMatchObject({
      provider: "codex",
      providerInstanceId: "codex",
      externalSessionId: "019e5e6e-6a3f-7b90-bb41-7bf17abf0e14",
      cwd: "/tmp/codex-project",
      command: "cd '/tmp/codex-project' && codex resume '019e5e6e-6a3f-7b90-bb41-7bf17abf0e14'",
      launched: true,
    });
    expect(state.stops).toEqual([threadId]);
    expect(state.terminalLaunches).toEqual([result.command]);
    expect(state.dispatches.map((command) => command.type)).toEqual([
      "thread.session.set",
      "thread.activity.append",
    ]);
  });

  it("rejects TeleportOut while the T3 thread is running", async () => {
    const threadId = ThreadId.make("thread-running");
    const state: TestState = {
      dispatches: [],
      bindings: [],
      starts: [],
      stops: [],
      terminalLaunches: [],
      existingThread: makeExistingThread({
        id: threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: iso,
        },
      }),
      existingBinding: {
        threadId,
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        status: "running",
        runtimeMode: "full-access",
        resumeCursor: { threadId: "codex-external-thread" },
        runtimePayload: { cwd: "/tmp/codex-project" },
      },
      returnedResumeCursor: { threadId: "unused" },
    };

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const teleport = yield* TeleportService;
          return yield* teleport.launchExternalSession({ threadId });
        }).pipe(Effect.provide(makeTestLayer(state))),
      ),
    ).rejects.toMatchObject({ _tag: "TeleportInvalidInputError" });

    expect(state.stops).toHaveLength(0);
    expect(state.terminalLaunches).toHaveLength(0);
  });
});
