import {
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  EventId,
  MessageId,
  ProjectId,
  PROVIDER_DISPLAY_NAMES,
  ProviderDriverKind,
  ProviderInstanceId,
  TeleportImportSessionInput,
  TeleportDiscoveryError,
  TeleportExternalLaunchError,
  TeleportInvalidInputError,
  TeleportLaunchExternalSessionInput,
  TeleportListSessionsInput,
  TeleportOpenCodeUnsupportedResumeError,
  TeleportProjectResolutionError,
  TeleportProviderStartError,
  TeleportUnsupportedProviderError,
  ThreadId,
  type ModelSelection as ModelSelectionType,
  type OrchestrationProject,
  type OrchestrationProjectShell,
  type OrchestrationThread,
  type OrchestrationCommand,
  type TeleportImportError,
  type TeleportLaunchExternalSessionError,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderSessionDirectory } from "../../provider/Services/ProviderSessionDirectory.ts";
import type { ProviderRuntimeBinding } from "../../provider/Services/ProviderSessionDirectory.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ExternalLauncher } from "../../process/externalLauncher.ts";
import { buildTeleportExternalCliCommand, toLaunchResult } from "../cliCommands.ts";
import {
  buildTeleportResumeCursor,
  isTeleportSupportedProvider,
  readTeleportProviderSessionId,
} from "../providerResumeCursors.ts";
import { readTeleportHistory, type TeleportHistoryMessage } from "../historyImport.ts";
import { discoverTeleportSessions } from "../sessionDiscovery.ts";
import { TeleportService, type TeleportServiceShape } from "../Services/TeleportService.ts";

const decodeTeleportImportInput = Schema.decodeUnknownEffect(TeleportImportSessionInput);
const decodeTeleportListSessionsInput = Schema.decodeUnknownEffect(TeleportListSessionsInput);
const decodeTeleportLaunchExternalInput = Schema.decodeUnknownEffect(
  TeleportLaunchExternalSessionInput,
);
const isTeleportProjectResolutionError = Schema.is(TeleportProjectResolutionError);
const formatSchemaIssue = SchemaIssue.makeFormatterDefault();

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

class TeleportHistoryReadError extends Data.TaggedError("TeleportHistoryReadError")<{
  readonly cause: unknown;
}> {}

function commandId(tag: string): CommandId {
  return CommandId.make(`teleport:${tag}:${crypto.randomUUID()}`);
}

function displayProvider(provider: ProviderDriverKind, fallback?: string): string {
  return fallback ?? PROVIDER_DISPLAY_NAMES[provider] ?? String(provider);
}

function defaultProjectTitle(cwd: string): string {
  const basename = cwd.split(/[\\/]/u).findLast((part) => part.length > 0) ?? "";
  return basename.trim() || cwd;
}

function defaultThreadTitle(input: {
  readonly provider: ProviderDriverKind;
  readonly displayName?: string | undefined;
  readonly externalSessionId: string;
}): string {
  const sessionSuffix = input.externalSessionId.slice(0, 10);
  return `Imported ${displayProvider(input.provider, input.displayName)} ${sessionSuffix}`;
}

function importActivitySummary(input: {
  readonly providerName: string;
  readonly externalSessionId: string;
  readonly historyMessageCount: number;
}): string {
  if (input.historyMessageCount > 0) {
    const noun = input.historyMessageCount === 1 ? "message" : "messages";
    return `Imported ${input.providerName} session ${input.externalSessionId}. Rendered ${input.historyMessageCount} prior provider ${noun}; earlier history may be omitted, and the next turn will continue from the imported provider session.`;
  }
  return `Imported ${input.providerName} session ${input.externalSessionId}. Previous provider history may not be fully rendered, but the next turn will continue from the imported provider session.`;
}

function modelSelectionForImport(input: {
  readonly requested: ModelSelectionType | undefined;
  readonly projectDefault: ModelSelectionType | null | undefined;
  readonly provider: ProviderDriverKind;
  readonly providerInstanceId: ProviderInstanceId;
}): Effect.Effect<ModelSelectionType, TeleportImportError> {
  if (input.requested && input.requested.instanceId !== input.providerInstanceId) {
    return Effect.fail(
      new TeleportInvalidInputError({
        message: `Model selection is bound to provider instance '${input.requested.instanceId}', expected '${input.providerInstanceId}'.`,
      }),
    );
  }
  if (input.requested) {
    return Effect.succeed(input.requested);
  }
  if (input.projectDefault && input.projectDefault.instanceId === input.providerInstanceId) {
    return Effect.succeed(input.projectDefault);
  }
  return Effect.succeed(
    createModelSelection(
      input.providerInstanceId,
      DEFAULT_MODEL_BY_PROVIDER[input.provider] ?? DEFAULT_MODEL,
    ),
  );
}

function persistedResumeSessionId(input: {
  readonly provider: ProviderDriverKind;
  readonly binding: ProviderRuntimeBinding | undefined;
}): string | undefined {
  const cursor = input.binding?.resumeCursor;
  if (cursor === null || cursor === undefined) {
    return undefined;
  }
  return readTeleportProviderSessionId({
    provider: input.provider,
    resumeCursor: cursor,
  });
}

function persistedCwd(binding: ProviderRuntimeBinding | undefined): string | undefined {
  const payload = binding?.runtimePayload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const cwd = "cwd" in payload ? payload.cwd : undefined;
  return typeof cwd === "string" && cwd.trim().length > 0 ? cwd.trim() : undefined;
}

function ensureCompatibleExistingBinding(input: {
  readonly provider: ProviderDriverKind;
  readonly providerInstanceId: ProviderInstanceId;
  readonly binding: ProviderRuntimeBinding | undefined;
  readonly externalSessionId: string;
}): Effect.Effect<void, TeleportImportError> {
  const binding = input.binding;
  if (!binding) {
    return Effect.void;
  }
  if (
    binding.provider !== input.provider ||
    binding.providerInstanceId !== input.providerInstanceId
  ) {
    return Effect.fail(
      new TeleportInvalidInputError({
        message: `Thread already has a provider binding for '${binding.providerInstanceId ?? binding.provider}', not '${input.providerInstanceId}'.`,
      }),
    );
  }
  const existingSessionId = persistedResumeSessionId({
    provider: input.provider,
    binding,
  });
  if (existingSessionId !== undefined && existingSessionId !== input.externalSessionId) {
    return Effect.fail(
      new TeleportInvalidInputError({
        message: `Thread is already bound to provider session '${existingSessionId}', not '${input.externalSessionId}'.`,
      }),
    );
  }
  return Effect.void;
}

function ensureThreadCanLaunchExternal(
  thread: OrchestrationThread | undefined,
): Effect.Effect<OrchestrationThread, TeleportLaunchExternalSessionError> {
  if (!thread) {
    return Effect.fail(
      new TeleportInvalidInputError({
        message: "Thread was not found.",
      }),
    );
  }
  if (!thread.session || thread.session.status === "stopped" || thread.session.status === "ready") {
    return Effect.succeed(thread);
  }
  return Effect.fail(
    new TeleportInvalidInputError({
      message: `Thread '${thread.id}' is ${thread.session.status}; wait for it to become idle before teleporting out.`,
    }),
  );
}

function ensureThreadCanImport(
  thread: OrchestrationThread | undefined,
): Effect.Effect<void, TeleportImportError> {
  if (!thread?.session) {
    return Effect.void;
  }
  if (thread.session.status === "stopped" || thread.session.status === "error") {
    return Effect.void;
  }
  return Effect.fail(
    new TeleportInvalidInputError({
      message: `Thread '${thread.id}' has an active provider session (${thread.session.status}); stop it before importing.`,
    }),
  );
}

function toProviderStartError(input: {
  readonly provider: ProviderDriverKind;
  readonly cause: unknown;
}): TeleportImportError {
  const message = input.cause instanceof Error ? input.cause.message : String(input.cause);
  if (
    input.provider === ProviderDriverKind.make("opencode") &&
    message.includes("cannot resume sessions by id")
  ) {
    return new TeleportOpenCodeUnsupportedResumeError({
      message: "Installed OpenCode SDK/server cannot resume sessions by id.",
      cause: input.cause,
    });
  }
  return new TeleportProviderStartError({
    provider: input.provider,
    message: message.trim() ? message : "Provider strict resume failed.",
    cause: input.cause,
  });
}

function projectFromShell(
  shell: OrchestrationProjectShell,
): Pick<OrchestrationProject, "id" | "defaultModelSelection"> {
  return {
    id: shell.id,
    defaultModelSelection: shell.defaultModelSelection,
  };
}

function readHistoryBestEffort(input: {
  readonly provider: ProviderDriverKind;
  readonly externalSessionId: string;
  readonly shouldRead: boolean;
}): Effect.Effect<TeleportHistoryMessage[]> {
  if (!input.shouldRead) {
    return Effect.succeed([]);
  }
  return Effect.tryPromise({
    try: () =>
      readTeleportHistory({
        provider: input.provider,
        externalSessionId: input.externalSessionId,
      }),
    catch: (cause) => new TeleportHistoryReadError({ cause }),
  }).pipe(Effect.catch(() => Effect.succeed([])));
}

const makeTeleportService = Effect.gen(function* () {
  const providerService = yield* ProviderService;
  const directory = yield* ProviderSessionDirectory;
  const orchestration = yield* OrchestrationEngineService;
  const projection = yield* ProjectionSnapshotQuery;
  const externalLauncher = yield* ExternalLauncher;

  const dispatch = (command: OrchestrationCommand) =>
    orchestration.dispatch(command).pipe(
      Effect.mapError(
        (cause) =>
          new TeleportProjectResolutionError({
            message: cause instanceof Error ? cause.message : "Failed to update imported thread.",
            cause,
          }),
      ),
    );

  const upsertBinding = (binding: ProviderRuntimeBinding) =>
    directory.upsert(binding).pipe(
      Effect.mapError(
        (cause) =>
          new TeleportProjectResolutionError({
            message: cause instanceof Error ? cause.message : "Failed to persist provider binding.",
            cause,
          }),
      ),
    );

  const listSessions: TeleportServiceShape["listSessions"] = (rawInput = {}) =>
    Effect.gen(function* () {
      const input = yield* decodeTeleportListSessionsInput(rawInput).pipe(
        Effect.mapError(
          (cause) =>
            new TeleportInvalidInputError({
              message: formatSchemaIssue(cause.issue),
              cause,
            }),
        ),
      );
      return yield* Effect.tryPromise({
        try: () => discoverTeleportSessions({ input }),
        catch: (cause) =>
          new TeleportDiscoveryError({
            message:
              cause instanceof Error
                ? cause.message
                : "Failed to discover Teleport provider sessions.",
            cause,
          }),
      }).pipe(Effect.map((sessions) => ({ sessions })));
    });

  const importSession: TeleportServiceShape["importSession"] = (rawInput) =>
    Effect.gen(function* () {
      const input = yield* decodeTeleportImportInput(rawInput).pipe(
        Effect.mapError(
          (cause) =>
            new TeleportInvalidInputError({
              message: formatSchemaIssue(cause.issue),
              cause,
            }),
        ),
      );
      const cwd = input.cwd.trim();
      const instance = yield* providerService.getInstanceInfo(input.providerInstanceId).pipe(
        Effect.mapError(
          (cause) =>
            new TeleportInvalidInputError({
              message: cause.message,
              cause,
            }),
        ),
      );
      const provider = instance.driverKind;
      if (input.provider !== undefined && input.provider !== provider) {
        return yield* new TeleportInvalidInputError({
          message: `Provider instance '${input.providerInstanceId}' belongs to '${provider}', not '${input.provider}'.`,
        });
      }
      if (!instance.enabled) {
        return yield* new TeleportInvalidInputError({
          message: `Provider instance '${input.providerInstanceId}' is disabled in T3 Code settings.`,
        });
      }
      if (!isTeleportSupportedProvider(provider)) {
        return yield* new TeleportUnsupportedProviderError({
          provider,
          message: `Teleport import does not support provider '${provider}'.`,
        });
      }

      const resumeCursor = yield* buildTeleportResumeCursor({
        provider,
        externalSessionId: input.externalSessionId,
      });

      const createdAt = yield* nowIso;
      const project = yield* Effect.gen(function* () {
        if (input.projectId !== undefined) {
          const existingProject = yield* projection.getProjectShellById(input.projectId);
          if (Option.isNone(existingProject)) {
            return yield* new TeleportProjectResolutionError({
              message: `Project '${input.projectId}' was not found.`,
            });
          }
          return projectFromShell(existingProject.value);
        }

        const existingProject = yield* projection.getActiveProjectByWorkspaceRoot(cwd);
        if (Option.isSome(existingProject)) {
          return existingProject.value;
        }

        const projectId = ProjectId.make(crypto.randomUUID());
        yield* dispatch({
          type: "project.create",
          commandId: commandId("project-create"),
          projectId,
          title: defaultProjectTitle(cwd),
          workspaceRoot: cwd,
          defaultModelSelection: input.modelSelection ?? null,
          createdAt,
        });
        return {
          id: projectId,
          defaultModelSelection: input.modelSelection ?? null,
        };
      }).pipe(
        Effect.mapError((cause) =>
          isTeleportProjectResolutionError(cause)
            ? cause
            : new TeleportProjectResolutionError({
                message: cause instanceof Error ? cause.message : "Failed to resolve project.",
                cause,
              }),
        ),
      );

      const modelSelection = yield* modelSelectionForImport({
        requested: input.modelSelection,
        projectDefault: project.defaultModelSelection,
        provider,
        providerInstanceId: input.providerInstanceId,
      });

      const threadId = input.threadId ?? ThreadId.make(crypto.randomUUID());
      const existingThread = Option.getOrUndefined(
        yield* projection.getThreadDetailById(threadId).pipe(
          Effect.mapError(
            (cause) =>
              new TeleportProjectResolutionError({
                message: `Failed to inspect thread '${threadId}'.`,
                cause,
              }),
          ),
        ),
      );
      yield* ensureThreadCanImport(existingThread);
      yield* ensureCompatibleExistingBinding({
        provider,
        providerInstanceId: input.providerInstanceId,
        binding: Option.getOrUndefined(
          yield* directory.getBinding(threadId).pipe(
            Effect.mapError(
              (cause) =>
                new TeleportProjectResolutionError({
                  message: `Failed to inspect provider binding for thread '${threadId}'.`,
                  cause,
                }),
            ),
          ),
        ),
        externalSessionId: input.externalSessionId,
      });

      if (!existingThread) {
        yield* dispatch({
          type: "thread.create",
          commandId: commandId("thread-create"),
          threadId,
          projectId: project.id,
          title:
            input.title ??
            defaultThreadTitle({
              provider,
              displayName: instance.displayName,
              externalSessionId: input.externalSessionId,
            }),
          modelSelection,
          runtimeMode: input.runtimeMode,
          interactionMode: input.interactionMode,
          branch: null,
          worktreePath: null,
          createdAt,
        });
      }

      yield* upsertBinding({
        threadId,
        provider,
        providerInstanceId: input.providerInstanceId,
        status: input.startSession ? "starting" : "stopped",
        resumeCursor,
        runtimeMode: input.runtimeMode,
        runtimePayload: {
          cwd,
          modelSelection,
          teleport: {
            importedAt: createdAt,
            externalSessionId: input.externalSessionId,
            provider,
          },
        },
      });

      let started = false;
      if (input.startSession) {
        const session = yield* providerService
          .startSession(threadId, {
            threadId,
            provider,
            providerInstanceId: input.providerInstanceId,
            cwd,
            modelSelection,
            resumeCursor,
            runtimeMode: input.runtimeMode,
            strictResume: true,
          })
          .pipe(
            Effect.mapError((cause) => toProviderStartError({ provider, cause })),
            Effect.tapError((cause) =>
              upsertBinding({
                threadId,
                provider,
                providerInstanceId: input.providerInstanceId,
                status: "error",
                resumeCursor,
                runtimeMode: input.runtimeMode,
                runtimePayload: {
                  cwd,
                  modelSelection,
                  teleport: {
                    importedAt: createdAt,
                    externalSessionId: input.externalSessionId,
                    provider,
                  },
                  lastError: cause.message,
                },
              }).pipe(Effect.ignore),
            ),
          );
        const returnedSessionId = readTeleportProviderSessionId({
          provider,
          resumeCursor: session.resumeCursor,
        });
        if (returnedSessionId !== input.externalSessionId) {
          yield* providerService.stopSession({ threadId }).pipe(Effect.ignore);
          yield* upsertBinding({
            threadId,
            provider,
            providerInstanceId: input.providerInstanceId,
            status: "error",
            resumeCursor,
            runtimeMode: input.runtimeMode,
            runtimePayload: {
              cwd,
              modelSelection,
              teleport: {
                importedAt: createdAt,
                externalSessionId: input.externalSessionId,
                provider,
              },
              lastError: `Provider returned session '${returnedSessionId ?? "<missing>"}' for requested import '${input.externalSessionId}'.`,
            },
          }).pipe(Effect.ignore);
          return yield* new TeleportProviderStartError({
            provider,
            message: `Provider returned session '${returnedSessionId ?? "<missing>"}' for requested import '${input.externalSessionId}'.`,
          });
        }
        started = true;
      }

      const historyMessages = yield* readHistoryBestEffort({
        provider,
        externalSessionId: input.externalSessionId,
        shouldRead: !existingThread || existingThread.messages.length === 0,
      });
      for (const historyMessage of historyMessages) {
        const messageCreatedAt = historyMessage.createdAt ?? createdAt;
        yield* dispatch({
          type: "thread.message.append",
          commandId: commandId("thread-message-append"),
          threadId,
          message: {
            id: MessageId.make(`teleport-history:${crypto.randomUUID()}`),
            role: historyMessage.role,
            text: historyMessage.text,
            attachments: [],
            turnId: null,
            streaming: false,
            createdAt: messageCreatedAt,
            updatedAt: messageCreatedAt,
          },
          createdAt: messageCreatedAt,
        });
      }

      const providerDisplayName = displayProvider(provider, instance.displayName);
      yield* dispatch({
        type: "thread.session.set",
        commandId: commandId("thread-session-set"),
        threadId,
        session: {
          threadId,
          status: started ? "ready" : "stopped",
          providerName: provider,
          providerInstanceId: input.providerInstanceId,
          runtimeMode: input.runtimeMode,
          activeTurnId: null,
          lastError: null,
          updatedAt: yield* nowIso,
        },
        createdAt: yield* nowIso,
      });

      yield* dispatch({
        type: "thread.activity.append",
        commandId: commandId("thread-activity-append"),
        threadId,
        activity: {
          id: EventId.make(crypto.randomUUID()),
          tone: "info",
          kind: "teleport.imported",
          summary: importActivitySummary({
            providerName: providerDisplayName,
            externalSessionId: input.externalSessionId,
            historyMessageCount: historyMessages.length,
          }),
          payload: {
            provider,
            providerInstanceId: input.providerInstanceId,
            externalSessionId: input.externalSessionId,
            cwd,
            started,
            historyMessageCount: historyMessages.length,
          },
          turnId: null,
          createdAt: yield* nowIso,
        },
        createdAt: yield* nowIso,
      });

      return {
        threadId,
        projectId: project.id,
        provider,
        providerInstanceId: input.providerInstanceId,
        externalSessionId: input.externalSessionId,
        resumeCursor,
        started,
      };
    });

  const launchExternalSession: TeleportServiceShape["launchExternalSession"] = (rawInput) =>
    Effect.gen(function* () {
      const input = yield* decodeTeleportLaunchExternalInput(rawInput).pipe(
        Effect.mapError(
          (cause) =>
            new TeleportInvalidInputError({
              message: formatSchemaIssue(cause.issue),
              cause,
            }),
        ),
      );
      const thread = yield* projection.getThreadDetailById(input.threadId).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.mapError(
          (cause) =>
            new TeleportProjectResolutionError({
              message: `Failed to inspect thread '${input.threadId}'.`,
              cause,
            }),
        ),
      );
      const launchableThread = yield* ensureThreadCanLaunchExternal(thread);
      const binding = Option.getOrUndefined(
        yield* directory.getBinding(input.threadId).pipe(
          Effect.mapError(
            (cause) =>
              new TeleportProjectResolutionError({
                message: `Failed to inspect provider binding for thread '${input.threadId}'.`,
                cause,
              }),
          ),
        ),
      );
      if (!binding) {
        return yield* new TeleportInvalidInputError({
          message: `Thread '${input.threadId}' has no provider session to teleport out.`,
        });
      }
      if (!isTeleportSupportedProvider(binding.provider)) {
        return yield* new TeleportUnsupportedProviderError({
          provider: binding.provider,
          message: `Teleport out does not support provider '${binding.provider}'.`,
        });
      }
      const providerInstanceId = binding.providerInstanceId;
      if (!providerInstanceId) {
        return yield* new TeleportInvalidInputError({
          message: `Thread '${input.threadId}' has no provider instance binding.`,
        });
      }
      const externalSessionId = persistedResumeSessionId({
        provider: binding.provider,
        binding,
      });
      if (!externalSessionId) {
        return yield* new TeleportInvalidInputError({
          message: `Thread '${input.threadId}' has no provider resume id to launch.`,
        });
      }
      const project = yield* projection.getProjectShellById(launchableThread.projectId).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.mapError(
          (cause) =>
            new TeleportProjectResolutionError({
              message: `Failed to inspect project '${launchableThread.projectId}'.`,
              cause,
            }),
        ),
      );
      const cwd = persistedCwd(binding) ?? project?.workspaceRoot;
      if (!cwd) {
        return yield* new TeleportProjectResolutionError({
          message: `Thread '${input.threadId}' has no project folder to launch.`,
        });
      }
      if (launchableThread.session?.status === "ready") {
        yield* providerService.stopSession({ threadId: input.threadId }).pipe(
          Effect.mapError(
            (cause) =>
              new TeleportExternalLaunchError({
                provider: binding.provider,
                message:
                  cause instanceof Error
                    ? cause.message
                    : "Failed to stop the T3 provider session before launching the CLI.",
                cause,
              }),
          ),
        );
        yield* dispatch({
          type: "thread.session.set",
          commandId: commandId("thread-session-teleport-out"),
          threadId: input.threadId,
          session: {
            threadId: input.threadId,
            status: "stopped",
            providerName: binding.provider,
            providerInstanceId,
            runtimeMode: binding.runtimeMode ?? launchableThread.runtimeMode,
            activeTurnId: null,
            lastError: null,
            updatedAt: yield* nowIso,
          },
          createdAt: yield* nowIso,
        });
      }
      const command = buildTeleportExternalCliCommand({
        provider: binding.provider,
        externalSessionId,
        cwd,
      });
      yield* externalLauncher.launchTerminalCommand({ command }).pipe(
        Effect.mapError(
          (cause) =>
            new TeleportExternalLaunchError({
              provider: binding.provider,
              message: cause.message,
              cause,
            }),
        ),
      );
      yield* dispatch({
        type: "thread.activity.append",
        commandId: commandId("thread-activity-teleport-out"),
        threadId: input.threadId,
        activity: {
          id: EventId.make(crypto.randomUUID()),
          tone: "info",
          kind: "teleport.exported",
          summary: `Launched ${displayProvider(binding.provider)} session ${externalSessionId} in the CLI.`,
          payload: {
            provider: binding.provider,
            providerInstanceId,
            externalSessionId,
            cwd,
            command,
          },
          turnId: null,
          createdAt: yield* nowIso,
        },
        createdAt: yield* nowIso,
      });
      return toLaunchResult({
        provider: binding.provider,
        providerInstanceId,
        externalSessionId,
        cwd,
        command,
      });
    });

  return { listSessions, importSession, launchExternalSession } satisfies TeleportServiceShape;
});

export const TeleportServiceLive = Layer.effect(TeleportService, makeTeleportService);
