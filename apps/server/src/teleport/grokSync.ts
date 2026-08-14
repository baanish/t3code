// Native Grok sessions live at ~/.grok/sessions/<cwd>/<id>/.
// @effect-diagnostics globalDate:off preferSchemaOverJson:off nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import {
  CommandId,
  MessageId,
  ProviderDriverKind,
  TeleportError,
  defaultInstanceIdForDriver,
  type OrchestrationMessage,
  type TeleportSessionInput,
  type TeleportSessionResult,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";

const GROK = ProviderDriverKind.make("grok");
const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
type NativeMsg = { role: "user" | "assistant"; text: string };
const fail = (message: string) => new TeleportError({ message });
const isRec = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
const isTeleportError = Schema.is(TeleportError);
const mapError = (cause: unknown): TeleportError =>
  isTeleportError(cause)
    ? cause
    : fail(
        cause instanceof Error && cause.message.trim()
          ? cause.message
          : "Grok session sync failed.",
      );

function teleportMeta(cursor: unknown, payload: unknown) {
  const teleport = isRec(payload) && isRec(payload.teleport) ? payload.teleport : undefined;
  return {
    sessionId:
      str(teleport?.externalSessionId) ?? (isRec(cursor) ? str(cursor.sessionId) : undefined),
    nativePath: str(teleport?.nativePath),
  };
}

export function grokPath(cwd: string, id: string, root?: string): string {
  return NodePath.join(
    root ?? NodePath.join(NodeOS.homedir(), ".grok", "sessions"),
    encodeURIComponent(normalizeProjectPathForComparison(cwd)),
    id,
  );
}

export function parseGrokUpdates(contents: string): NativeMsg[] {
  const messages: NativeMsg[] = [];
  let current: NativeMsg | undefined;
  const flush = (): void => {
    if (current && current.text.length > 0) messages.push(current);
    current = undefined;
  };
  for (const raw of contents.split("\n")) {
    if (raw.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const update =
      isRec(parsed) && isRec(parsed.params) && isRec(parsed.params.update)
        ? parsed.params.update
        : undefined;
    const role =
      update?.sessionUpdate === "user_message_chunk"
        ? "user"
        : update?.sessionUpdate === "agent_message_chunk"
          ? "assistant"
          : undefined;
    const content = update?.content;
    const text =
      typeof content === "string"
        ? content
        : isRec(content) && typeof content.text === "string"
          ? content.text
          : undefined;
    if (!role || !text) continue;
    if (current?.role === role) {
      current.text += text;
      continue;
    }
    flush();
    current = { role, text };
  }
  flush();
  return messages.slice(-2_000);
}

export function parseGrokSessionDirectory(input: {
  readonly summaryContents: string;
  readonly updatesContents: string;
  readonly nativePath: string;
}): { sessionId: string; cwd: string; messages: NativeMsg[] } {
  let summary: unknown;
  try {
    summary = JSON.parse(input.summaryContents);
  } catch {
    throw fail(`Grok summary is not JSON: ${input.nativePath}`);
  }
  if (!isRec(summary)) throw fail(`Grok summary is not an object: ${input.nativePath}`);
  const format = typeof summary.chat_format_version === "number" ? summary.chat_format_version : 1;
  if (format > 1) {
    throw fail(`Unsupported Grok session format ${format} in ${input.nativePath}.`);
  }
  const info = isRec(summary.info) ? summary.info : undefined;
  const sessionId = str(info?.id) ?? NodePath.basename(input.nativePath);
  const cwd = str(info?.cwd) ?? str(summary.cwd);
  if (!sessionId || !cwd) throw fail(`Grok session is missing id/cwd: ${input.nativePath}`);
  return { sessionId, cwd, messages: parseGrokUpdates(input.updatesContents) };
}

function serializeSession(
  sessionId: string,
  cwd: string,
  title: string,
  createdAt: string,
  updatedAt: string,
  messages: ReadonlyArray<NativeMsg>,
): { summary: string; updates: string } {
  const updates = messages.map((message, index) =>
    JSON.stringify({
      timestamp: Math.floor(Date.now() / 1000),
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: message.role === "user" ? "user_message_chunk" : "agent_message_chunk",
          content: { type: "text", text: message.text },
          _meta: { promptIndex: index, modelId: "grok" },
        },
      },
    }),
  );
  return {
    summary: `${JSON.stringify({
      info: { id: sessionId, cwd },
      session_summary: title,
      generated_title: title,
      created_at: createdAt,
      updated_at: updatedAt,
      num_messages: messages.length,
      chat_format_version: 1,
    })}\n`,
    updates: updates.length > 0 ? `${updates.join("\n")}\n` : "",
  };
}

const requireUnlocked = Effect.fn("requireGrokPathUnlocked")(function* (nativePath: string) {
  const locked = yield* Effect.tryPromise({
    try: () => execFile("lsof", ["-t", nativePath], { timeout: 2_000 }),
    catch: () => undefined,
  }).pipe(
    Effect.map((result) => (result?.stdout.trim().length ?? 0) > 0),
    Effect.orElseSucceed(() => false),
  );
  if (locked) return yield* fail(`Native Grok session is locked: ${nativePath}`);
});

export const writeGrokSession = Effect.fn("writeGrokSession")(function* (input: {
  readonly cwd: string;
  readonly sessionId: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly messages: ReadonlyArray<NativeMsg>;
  readonly existingNativePath?: string;
  readonly sessionsRoot?: string;
}) {
  const nativePath =
    input.existingNativePath ?? grokPath(input.cwd, input.sessionId, input.sessionsRoot);
  const files = serializeSession(
    input.sessionId,
    input.cwd,
    input.title,
    input.createdAt,
    input.updatedAt,
    input.messages,
  );
  yield* Effect.try({
    try: () =>
      parseGrokSessionDirectory({
        summaryContents: files.summary,
        updatesContents: files.updates,
        nativePath,
      }),
    catch: mapError,
  });
  yield* requireUnlocked(nativePath);
  yield* requireUnlocked(NodePath.join(nativePath, "updates.jsonl"));
  yield* Effect.tryPromise({
    try: async () => {
      await NodeFSP.mkdir(nativePath, { recursive: true });
      for (const [name, body] of [
        ["summary.json", files.summary],
        ["updates.jsonl", files.updates],
      ] as const) {
        const dest = NodePath.join(nativePath, name);
        await NodeFSP.writeFile(`${dest}.tmp`, body);
        await NodeFSP.rename(`${dest}.tmp`, dest);
      }
    },
    catch: mapError,
  });
  return nativePath;
});

const loadIdleGrokThread = Effect.fn("loadIdleGrokThread")(function* (
  threadId: TeleportSessionInput["threadId"],
  action: "in" | "out",
) {
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const directory = yield* ProviderSessionDirectory;
  const thread = yield* snapshots.getThreadDetailById(threadId).pipe(Effect.mapError(mapError));
  if (Option.isNone(thread)) return yield* fail(`Thread '${threadId}' was not found.`);
  const status = thread.value.session?.status;
  if (status === "starting" || status === "running") {
    return yield* fail(`Cannot teleport ${action} while this thread is running.`);
  }
  const bound = Option.getOrUndefined(
    yield* directory.getBinding(threadId).pipe(Effect.mapError(mapError)),
  );
  const grok =
    bound?.provider === GROK ||
    thread.value.session?.providerName === "grok" ||
    thread.value.modelSelection.instanceId === defaultInstanceIdForDriver(GROK);
  if (!grok) return yield* fail("Teleport currently supports Grok threads only.");
  const project = yield* snapshots
    .getProjectShellById(thread.value.projectId)
    .pipe(Effect.mapError(mapError));
  if (Option.isNone(project)) return yield* fail("The thread's project was not found.");
  return { thread: thread.value, bound, project: project.value };
});

const bindGrokSession = Effect.fn("bindGrokSession")(function* (
  threadId: TeleportSessionInput["threadId"],
  sessionId: string,
  nativePath: string,
  providerInstanceId?: ReturnType<typeof defaultInstanceIdForDriver>,
) {
  const directory = yield* ProviderSessionDirectory;
  yield* directory
    .upsert({
      threadId,
      provider: GROK,
      providerInstanceId: providerInstanceId ?? defaultInstanceIdForDriver(GROK),
      status: "stopped",
      resumeCursor: { schemaVersion: 1, sessionId },
      runtimePayload: { teleport: { nativePath, externalSessionId: sessionId } },
    })
    .pipe(Effect.mapError(mapError));
});

export const exportGrokSession = Effect.fn("exportGrokSession")(function* (
  input: TeleportSessionInput,
) {
  const crypto = yield* Crypto.Crypto;
  const loaded = yield* loadIdleGrokThread(input.threadId, "out");
  const now = yield* Effect.map(DateTime.now, DateTime.formatIso);
  const meta = teleportMeta(loaded.bound?.resumeCursor, loaded.bound?.runtimePayload);
  const sessionId = meta.sessionId ?? (yield* crypto.randomUUIDv4);
  const nativePath = yield* writeGrokSession({
    cwd: normalizeProjectPathForComparison(loaded.project.workspaceRoot),
    sessionId,
    title: loaded.thread.title,
    createdAt: loaded.thread.createdAt,
    updatedAt: now,
    messages: loaded.thread.messages.flatMap((message: OrchestrationMessage) =>
      (message.role === "user" || message.role === "assistant") && message.text.trim()
        ? [{ role: message.role, text: message.text }]
        : [],
    ),
    ...(meta.nativePath ? { existingNativePath: meta.nativePath } : {}),
  });
  const stillIdle = yield* loadIdleGrokThread(input.threadId, "out");
  yield* bindGrokSession(
    input.threadId,
    sessionId,
    nativePath,
    stillIdle.bound?.providerInstanceId,
  );
  return { nativePath, externalSessionId: sessionId } satisfies TeleportSessionResult;
});

export const importGrokSession = Effect.fn("importGrokSession")(function* (
  input: TeleportSessionInput,
) {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const crypto = yield* Crypto.Crypto;
  const loaded = yield* loadIdleGrokThread(input.threadId, "in");
  const meta = teleportMeta(loaded.bound?.resumeCursor, loaded.bound?.runtimePayload);
  if (!meta.sessionId) {
    return yield* fail("Teleport this Grok thread out before importing it back.");
  }
  const nativePath = meta.nativePath ?? grokPath(loaded.project.workspaceRoot, meta.sessionId);
  yield* requireUnlocked(nativePath);
  yield* requireUnlocked(NodePath.join(nativePath, "updates.jsonl"));
  const parsed = yield* Effect.tryPromise({
    try: async () =>
      parseGrokSessionDirectory({
        summaryContents: await NodeFSP.readFile(NodePath.join(nativePath, "summary.json"), "utf8"),
        updatesContents: await NodeFSP.readFile(NodePath.join(nativePath, "updates.jsonl"), "utf8"),
        nativePath,
      }),
    catch: mapError,
  });
  if (parsed.messages.length === 0 && loaded.thread.messages.length > 0) {
    return yield* fail("Native Grok session has no messages; refusing to wipe this thread.");
  }
  const now = yield* Effect.map(DateTime.now, DateTime.formatIso);
  const ids = yield* Effect.forEach(parsed.messages, () => crypto.randomUUIDv4, { concurrency: 1 });
  yield* engine
    .dispatch({
      type: "thread.history.replace",
      commandId: CommandId.make(yield* crypto.randomUUIDv4),
      threadId: input.threadId,
      messages: parsed.messages.map((message, index) => ({
        id: MessageId.make(ids[index] ?? `${index}`),
        role: message.role,
        text: message.text,
        turnId: null,
        streaming: false,
        createdAt: now,
        updatedAt: now,
      })),
      createdAt: now,
    })
    .pipe(Effect.mapError(mapError));
  yield* bindGrokSession(
    input.threadId,
    parsed.sessionId,
    nativePath,
    loaded.bound?.providerInstanceId,
  );
  return { nativePath, externalSessionId: parsed.sessionId } satisfies TeleportSessionResult;
});

type TeleportCtx =
  | Crypto.Crypto
  | OrchestrationEngine.OrchestrationEngineService
  | ProjectionSnapshotQuery.ProjectionSnapshotQuery
  | ProviderSessionDirectory;

export class TeleportService extends Context.Service<
  TeleportService,
  {
    readonly exportSession: (
      input: TeleportSessionInput,
    ) => Effect.Effect<TeleportSessionResult, TeleportError>;
    readonly importSession: (
      input: TeleportSessionInput,
    ) => Effect.Effect<TeleportSessionResult, TeleportError>;
  }
>()("t3/teleport/grokSync/TeleportService") {}

export const TeleportServiceLive = Layer.effect(
  TeleportService,
  Effect.gen(function* () {
    const context = yield* Effect.context<TeleportCtx>();
    const busy = new Set<string>();
    const run = <A>(
      threadId: string,
      effect: Effect.Effect<A, TeleportError | PlatformError.PlatformError, TeleportCtx>,
    ): Effect.Effect<A, TeleportError> =>
      Effect.suspend(() => {
        if (busy.has(threadId)) {
          return fail("Teleport already in progress for this thread.");
        }
        busy.add(threadId);
        return effect.pipe(
          Effect.provideContext(context),
          Effect.mapError(mapError),
          Effect.ensuring(Effect.sync(() => busy.delete(threadId))),
        );
      });
    return TeleportService.of({
      exportSession: (input) => run(input.threadId, exportGrokSession(input)),
      importSession: (input) => run(input.threadId, importGrokSession(input)),
    });
  }),
);
