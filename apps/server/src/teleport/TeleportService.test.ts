import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../config.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBinding,
} from "../provider/Services/ProviderSessionDirectory.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import { allocateCodexSessionPath, serializeCodexSession } from "./formats/codex.ts";
import * as TeleportFormatRegistry from "./formats/registry.ts";
import {
  nativeForkThreadId,
  observeNativeRevision,
  shouldWatchNativeRevision,
} from "./nativeRevision.ts";
import { sampleTeleportSession, TELEPORT_TEST_SESSION_ID } from "./testFixtures.ts";
import { TeleportService, make as makeTeleportService } from "./TeleportService.ts";

const PROJECT_ID = ProjectId.make("project-teleport-fork");
const NOW = "2026-08-14T06:00:00.000Z";

function memoryDirectory() {
  const bindings = new Map<string, ProviderRuntimeBinding>();
  return {
    upsert: (binding: ProviderRuntimeBinding) =>
      Effect.sync(() => {
        bindings.set(binding.threadId, binding);
      }),
    getProvider: (threadId: ThreadId) => {
      const binding = bindings.get(threadId);
      return binding === undefined
        ? Effect.die(new Error(`no provider for ${threadId}`))
        : Effect.succeed(binding.provider);
    },
    getBinding: (threadId: ThreadId) => {
      const binding = bindings.get(threadId);
      return Effect.succeed(binding === undefined ? Option.none() : Option.some(binding));
    },
    listThreadIds: () => Effect.succeed([...bindings.keys()] as ThreadId[]),
    listBindings: () =>
      Effect.succeed(
        [...bindings.values()].map((binding) => ({
          ...binding,
          lastSeenAt: "2026-08-14T22:00:00.000Z",
        })),
      ),
  } satisfies ProviderSessionDirectory["Service"];
}

const unlockedProcessRunner: ProcessRunner.ProcessRunner["Service"] = {
  run: () =>
    Effect.succeed({
      stdout: "",
      stderr: "",
      code: 1 as ProcessRunner.ProcessRunOutput["code"],
      timedOut: false,
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutInvalidUtf8: false,
      stderrInvalidUtf8: false,
    }),
};

const unusedProviderService: ProviderService["Service"] = {
  startSession: () => Effect.die("ProviderService.startSession unused"),
  sendTurn: () => Effect.die("ProviderService.sendTurn unused"),
  interruptTurn: () => Effect.die("ProviderService.interruptTurn unused"),
  respondToRequest: () => Effect.die("ProviderService.respondToRequest unused"),
  respondToUserInput: () => Effect.die("ProviderService.respondToUserInput unused"),
  stopSession: () => Effect.void,
  listSessions: () => Effect.succeed([]),
  getCapabilities: () => Effect.die("ProviderService.getCapabilities unused"),
  getInstanceInfo: () => Effect.die("ProviderService.getInstanceInfo unused"),
  rollbackConversation: () => Effect.die("ProviderService.rollbackConversation unused"),
  streamEvents: Stream.empty,
};

const unusedInstanceRegistry: ProviderInstanceRegistry["Service"] = {
  getInstance: () => Effect.succeed(undefined),
  listInstances: Effect.succeed([]),
  listUnavailable: Effect.succeed([]),
  streamChanges: Stream.empty,
  subscribeChanges: Effect.die("ProviderInstanceRegistry.subscribeChanges unused"),
};

function teleportServiceLayer(input: {
  readonly workspaceRoot: string;
  readonly codexHome: string;
  readonly directory: ReturnType<typeof memoryDirectory>;
}) {
  const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-teleport-service-test-",
  });
  const orchestrationLayer = Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
  ).pipe(
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfigLayer),
    Layer.provideMerge(NodeServices.layer),
  );
  return Layer.effect(TeleportService, makeTeleportService).pipe(
    Layer.provide(TeleportFormatRegistry.layer),
    Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, unlockedProcessRunner)),
    Layer.provideMerge(orchestrationLayer),
    Layer.provideMerge(
      ServerSettings.layerTest({
        providers: {
          codex: {
            homePath: input.codexHome,
          },
        },
      }),
    ),
    Layer.provideMerge(Layer.succeed(ProviderSessionDirectory, input.directory)),
    Layer.provideMerge(Layer.succeed(ProviderInstanceRegistry, unusedInstanceRegistry)),
    Layer.provideMerge(Layer.succeed(ProviderService, unusedProviderService)),
    Layer.provideMerge(Layer.succeed(HostProcessPlatform, "linux")),
    Layer.provideMerge(NodeServices.layer),
  );
}

function changedNativeSession(cwd: string) {
  const original = sampleTeleportSession("codex", cwd);
  return {
    ...original,
    messages: [
      ...original.messages,
      {
        role: "user" as const,
        text: "Also fix the timeout",
        createdAt: "2026-08-14T06:02:00.000Z",
        id: "user-2",
      },
      {
        role: "assistant" as const,
        text: "Timeout retry is in place.",
        createdAt: "2026-08-14T06:03:00.000Z",
        id: "assistant-2",
      },
    ],
  };
}

describe("TeleportService.forkNativeDivergence", () => {
  it.effect("creates a new thread, leaves the source unchanged, and retries the same fork", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "teleport-fork-svc-" });
      const workspaceRoot = path.join(root, "workspace");
      const codexHome = path.join(root, "codex");
      const nativePath = allocateCodexSessionPath({
        sessionsRoot: path.join(codexHome, "sessions"),
        sessionId: TELEPORT_TEST_SESSION_ID,
        createdAt: NOW,
        join: path.join,
      });
      yield* fs.makeDirectory(workspaceRoot, { recursive: true });
      yield* fs.makeDirectory(path.dirname(nativePath), { recursive: true });
      yield* fs.writeFileString(
        nativePath,
        serializeCodexSession(sampleTeleportSession("codex", workspaceRoot)),
      );
      const directory = memoryDirectory();

      yield* Effect.gen(function* () {
        const service = yield* TeleportService;
        const engine = yield* OrchestrationEngineService;
        const snapshotQuery = yield* ProjectionSnapshotQuery;

        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("cmd-project-create"),
          projectId: PROJECT_ID,
          title: "Teleport Fork Project",
          workspaceRoot,
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          createdAt: NOW,
        });

        const imported = yield* service.importSessions({
          projectId: PROJECT_ID,
          cwd: workspaceRoot,
          sessions: [
            {
              provider: "codex",
              externalSessionId: TELEPORT_TEST_SESSION_ID,
              nativePath,
            },
          ],
        });
        assert.equal(imported.imported.length, 1);
        const sourceThreadId = imported.imported[0]?.threadId;
        assert.ok(sourceThreadId);

        yield* service.requireNativeRevisionForTurn(sourceThreadId);

        yield* fs.writeFileString(
          nativePath,
          serializeCodexSession(changedNativeSession(workspaceRoot)),
        );
        const divergedObservation = yield* observeNativeRevision(nativePath);
        assert.equal(divergedObservation.status, "observed");
        if (divergedObservation.status !== "observed") {
          return;
        }

        const blocked = yield* service
          .requireNativeRevisionForTurn(sourceThreadId)
          .pipe(Effect.result);
        assert.equal(blocked._tag, "Failure");
        if (blocked._tag !== "Failure") {
          return;
        }
        assert.equal(blocked.failure._tag, "TeleportNativeDivergenceError");
        if (blocked.failure._tag === "TeleportNativeDivergenceError") {
          assert.equal(blocked.failure.kind, "diverged");
        }

        const sourceBefore = yield* snapshotQuery.getThreadDetailById(sourceThreadId);
        assert.equal(Option.isSome(sourceBefore), true);
        if (Option.isNone(sourceBefore)) {
          return;
        }

        const forked = yield* service.forkNativeDivergence({ threadId: sourceThreadId });
        assert.equal(forked.replayed, false);
        assert.notEqual(forked.threadId, sourceThreadId);
        assert.equal(
          forked.threadId,
          nativeForkThreadId(sourceThreadId, divergedObservation.revision.digest),
        );

        const sourceAfter = yield* snapshotQuery.getThreadDetailById(sourceThreadId);
        assert.equal(Option.isSome(sourceAfter), true);
        if (Option.isNone(sourceAfter)) {
          return;
        }
        assert.equal(sourceAfter.value.title, sourceBefore.value.title);
        assert.deepEqual(sourceAfter.value.messages, sourceBefore.value.messages);
        assert.deepEqual(sourceAfter.value.teleport, sourceBefore.value.teleport);
        assert.equal(shouldWatchNativeRevision(sourceAfter.value.teleport), true);

        const forkedThread = yield* snapshotQuery.getThreadDetailById(forked.threadId);
        assert.equal(Option.isSome(forkedThread), true);
        if (Option.isNone(forkedThread)) {
          return;
        }
        assert.equal(forkedThread.value.teleport?.forkedFromThreadId, sourceThreadId);
        assert.equal(shouldWatchNativeRevision(forkedThread.value.teleport), false);
        assert.ok(
          forkedThread.value.messages.some((message) => message.text === "Also fix the timeout"),
        );
        assert.equal(
          forkedThread.value.messages.some((message) =>
            sourceBefore.value.messages.some((source) => source.id === message.id),
          ),
          false,
        );

        const bindings = yield* directory.listBindings();
        assert.deepEqual(
          bindings.map((binding) => binding.threadId),
          [sourceThreadId],
        );

        const retried = yield* service.forkNativeDivergence({ threadId: sourceThreadId });
        assert.equal(retried.replayed, true);
        assert.equal(retried.threadId, forked.threadId);

        yield* service.requireNativeRevisionForTurn(sourceThreadId);
        yield* service.requireNativeRevisionForTurn(forked.threadId);

        const sourceStatus = yield* service.checkNativeRevision({ threadId: sourceThreadId });
        const forkStatus = yield* service.checkNativeRevision({ threadId: forked.threadId });
        assert.equal(sourceStatus.status, "forked");
        assert.equal(sourceStatus.forkedThreadId, forked.threadId);
        assert.equal(forkStatus.status, "not-applicable");
      }).pipe(Effect.provide(teleportServiceLayer({ workspaceRoot, codexHome, directory })));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reuses a covering fork already persisted under the deterministic id", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "teleport-fork-replica-" });
      const workspaceRoot = path.join(root, "workspace");
      const codexHome = path.join(root, "codex");
      const nativePath = allocateCodexSessionPath({
        sessionsRoot: path.join(codexHome, "sessions"),
        sessionId: TELEPORT_TEST_SESSION_ID,
        createdAt: NOW,
        join: path.join,
      });
      yield* fs.makeDirectory(workspaceRoot, { recursive: true });
      yield* fs.makeDirectory(path.dirname(nativePath), { recursive: true });
      yield* fs.writeFileString(
        nativePath,
        serializeCodexSession(sampleTeleportSession("codex", workspaceRoot)),
      );
      const directory = memoryDirectory();

      yield* Effect.gen(function* () {
        const service = yield* TeleportService;
        const engine = yield* OrchestrationEngineService;
        const snapshotQuery = yield* ProjectionSnapshotQuery;

        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("cmd-project-replica"),
          projectId: PROJECT_ID,
          title: "Teleport Fork Project",
          workspaceRoot,
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          createdAt: NOW,
        });

        const imported = yield* service.importSessions({
          projectId: PROJECT_ID,
          cwd: workspaceRoot,
          sessions: [
            {
              provider: "codex",
              externalSessionId: TELEPORT_TEST_SESSION_ID,
              nativePath,
            },
          ],
        });
        const sourceThreadId = imported.imported[0]?.threadId;
        assert.ok(sourceThreadId);

        yield* fs.writeFileString(
          nativePath,
          serializeCodexSession(changedNativeSession(workspaceRoot)),
        );
        const observation = yield* observeNativeRevision(nativePath);
        assert.equal(observation.status, "observed");
        if (observation.status !== "observed") {
          return;
        }
        const replicaThreadId = nativeForkThreadId(sourceThreadId, observation.revision.digest);
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-replica-fork-create"),
          threadId: replicaThreadId,
          projectId: PROJECT_ID,
          title: "Replica fork",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: NOW,
        });
        yield* engine.dispatch({
          type: "thread.teleport.set",
          commandId: CommandId.make("cmd-replica-fork-teleport"),
          threadId: replicaThreadId,
          teleport: {
            presence: "t3",
            provider: "codex",
            externalSessionId: TELEPORT_TEST_SESSION_ID,
            nativePath,
            lastSyncedAt: NOW,
            nativeRevision: observation.revision,
            forkedFromThreadId: sourceThreadId,
          },
          createdAt: NOW,
        });

        const forked = yield* service.forkNativeDivergence({ threadId: sourceThreadId });
        assert.equal(forked.replayed, true);
        assert.equal(forked.threadId, replicaThreadId);

        const threads = yield* snapshotQuery.getShellSnapshot();
        assert.equal(threads.threads.filter((thread) => thread.id !== sourceThreadId).length, 1);
      }).pipe(Effect.provide(teleportServiceLayer({ workspaceRoot, codexHome, directory })));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("does not overwrite an unrelated thread that collides with the fork id", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "teleport-fork-collision-" });
      const workspaceRoot = path.join(root, "workspace");
      const codexHome = path.join(root, "codex");
      const nativePath = allocateCodexSessionPath({
        sessionsRoot: path.join(codexHome, "sessions"),
        sessionId: TELEPORT_TEST_SESSION_ID,
        createdAt: NOW,
        join: path.join,
      });
      yield* fs.makeDirectory(workspaceRoot, { recursive: true });
      yield* fs.makeDirectory(path.dirname(nativePath), { recursive: true });
      yield* fs.writeFileString(
        nativePath,
        serializeCodexSession(sampleTeleportSession("codex", workspaceRoot)),
      );
      const directory = memoryDirectory();

      yield* Effect.gen(function* () {
        const service = yield* TeleportService;
        const engine = yield* OrchestrationEngineService;
        const snapshotQuery = yield* ProjectionSnapshotQuery;

        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("cmd-project-collision"),
          projectId: PROJECT_ID,
          title: "Teleport Fork Project",
          workspaceRoot,
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          createdAt: NOW,
        });

        const imported = yield* service.importSessions({
          projectId: PROJECT_ID,
          cwd: workspaceRoot,
          sessions: [
            {
              provider: "codex",
              externalSessionId: TELEPORT_TEST_SESSION_ID,
              nativePath,
            },
          ],
        });
        const sourceThreadId = imported.imported[0]?.threadId;
        assert.ok(sourceThreadId);

        yield* fs.writeFileString(
          nativePath,
          serializeCodexSession(changedNativeSession(workspaceRoot)),
        );
        const observation = yield* observeNativeRevision(nativePath);
        assert.equal(observation.status, "observed");
        if (observation.status !== "observed") {
          return;
        }
        const collisionThreadId = nativeForkThreadId(sourceThreadId, observation.revision.digest);
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-collision-create"),
          threadId: collisionThreadId,
          projectId: PROJECT_ID,
          title: "Unrelated collision",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: NOW,
        });

        const sourceBefore = yield* snapshotQuery.getThreadDetailById(sourceThreadId);
        const failed = yield* service
          .forkNativeDivergence({ threadId: sourceThreadId })
          .pipe(Effect.result);
        assert.equal(failed._tag, "Failure");
        if (failed._tag !== "Failure") {
          return;
        }
        assert.equal(failed.failure._tag, "TeleportInvalidInputError");

        const sourceAfter = yield* snapshotQuery.getThreadDetailById(sourceThreadId);
        const collision = yield* snapshotQuery.getThreadDetailById(collisionThreadId);
        assert.equal(Option.isSome(sourceBefore) && Option.isSome(sourceAfter), true);
        if (Option.isNone(sourceBefore) || Option.isNone(sourceAfter) || Option.isNone(collision)) {
          return;
        }
        assert.deepEqual(sourceAfter.value.teleport, sourceBefore.value.teleport);
        assert.deepEqual(sourceAfter.value.messages, sourceBefore.value.messages);
        assert.equal(collision.value.title, "Unrelated collision");
        assert.equal(collision.value.teleport, undefined);
      }).pipe(Effect.provide(teleportServiceLayer({ workspaceRoot, codexHome, directory })));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("TeleportService.requireNativeRevisionForTurn", () => {
  it.effect("fails closed when the thread cannot be loaded", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "teleport-turn-gate-" });
      const workspaceRoot = path.join(root, "workspace");
      const codexHome = path.join(root, "codex");
      yield* fs.makeDirectory(workspaceRoot, { recursive: true });
      const directory = memoryDirectory();

      yield* Effect.gen(function* () {
        const service = yield* TeleportService;
        const result = yield* service
          .requireNativeRevisionForTurn(ThreadId.make("missing-thread"))
          .pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        if (result._tag !== "Failure") {
          return;
        }
        assert.equal(result.failure._tag, "TeleportInvalidInputError");
      }).pipe(Effect.provide(teleportServiceLayer({ workspaceRoot, codexHome, directory })));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
