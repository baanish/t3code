// Native Codex files store wall-clock ISO timestamps and JSONL event records.
// @effect-diagnostics globalDate:off preferSchemaOverJson:off
import {
  TELEPORT_NATIVE_FORMAT_VERSION,
  TeleportDiscoveryError,
  TeleportNativeWriteError,
  TeleportSchemaVersionError,
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ProviderInstanceId,
  type TeleportSessionCandidate,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { teleportSessionBelongsToProject } from "../cwd.ts";
import {
  canonicalizeTeleportNativePath,
  canonicalizeTeleportNativeWritePath,
  codexSearchRoots,
  nativePathIsUnderRoot,
  resolveCodexSessionsRoot,
} from "../homes.ts";
import { readNativeSessionFile } from "../sessionFile.ts";
import { requireNativePathUnlocked } from "../fileLock.ts";
import { walkTeleportFiles } from "../walk.ts";
import {
  definedField,
  firstUserTitle,
  isRecord,
  isSafeTeleportSessionId,
  isSyntheticNativeUserText,
  nativeSessionText,
  nonEmptyString,
  parseJsonObject,
  uuidFromPath,
} from "../json.ts";
import { writeNativeSessionAtomically } from "../nativeWrite.ts";
import type { TeleportFormatAdapter } from "./adapter.ts";
import {
  nativeTextMessage,
  parsedNativeSession,
  teleportCandidateFields,
  type NativeTextMessage,
  type ParsedNativeSession,
} from "../types.ts";

const CODEX = ProviderDriverKind.make("codex");

function isForkedSessionMeta(payload: Record<string, unknown>): boolean {
  if (typeof payload.forked_from_id === "string" || typeof payload.parent_thread_id === "string") {
    return true;
  }
  const source = payload.source;
  if (!isRecord(source)) {
    return false;
  }
  const subagent = source.subagent;
  if (!isRecord(subagent)) {
    return false;
  }
  const spawn = subagent.thread_spawn;
  if (!isRecord(spawn)) {
    return false;
  }
  return typeof spawn.parent_thread_id === "string";
}

function extractMessage(event: Record<string, unknown>): NativeTextMessage | undefined {
  if (event.type !== "response_item") {
    return undefined;
  }
  const payload = isRecord(event.payload) ? event.payload : undefined;
  if (payload?.type !== "message") {
    return undefined;
  }
  const role = payload.role === "user" || payload.role === "assistant" ? payload.role : undefined;
  if (!role) {
    return undefined;
  }
  const text = collectCodexText(payload.content);
  if (!text) {
    return undefined;
  }
  if (role === "user" && isSyntheticNativeUserText(text)) {
    return undefined;
  }
  return nativeTextMessage({
    role,
    text,
    createdAt: nonEmptyString(event.timestamp),
    id: undefined,
  });
}

function collectCodexText(content: unknown): string | undefined {
  if (typeof content === "string") {
    return nativeSessionText(content);
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const parts: string[] = [];
  for (const part of content) {
    if (!isRecord(part)) {
      continue;
    }
    const text = nativeSessionText(part.text);
    if (text) {
      parts.push(text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

export function parseCodexSessionContents(input: {
  readonly contents: string;
  readonly nativePath: string;
}): Effect.Effect<Option.Option<ParsedNativeSession>, TeleportSchemaVersionError> {
  const lines = input.contents.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return Effect.succeed(Option.none());
  }

  let sessionId: string | undefined;
  let sessionCwd: string | undefined;
  let turnCwd: string | undefined;
  let createdAt: string | undefined;
  let title: string | undefined;
  let nativeFormatVersion: number = TELEPORT_NATIVE_FORMAT_VERSION;
  let forked = false;
  let sessionMetaSeen = false;
  const messages: NativeTextMessage[] = [];

  for (const line of lines) {
    const event = parseJsonObject(line);
    if (!event) {
      continue;
    }
    const declaredVersion = event.nativeFormatVersion;
    if (typeof declaredVersion === "number" && Number.isInteger(declaredVersion)) {
      nativeFormatVersion = declaredVersion;
    }
    if (nativeFormatVersion > TELEPORT_NATIVE_FORMAT_VERSION) {
      return Effect.fail(
        new TeleportSchemaVersionError({
          provider: "codex",
          nativePath: input.nativePath,
          foundVersion: nativeFormatVersion,
          supportedVersion: TELEPORT_NATIVE_FORMAT_VERSION,
        }),
      );
    }

    if (event.type === "session_meta") {
      if (sessionMetaSeen) {
        continue;
      }
      sessionMetaSeen = true;
      const payload = isRecord(event.payload) ? event.payload : undefined;
      if (!payload) {
        continue;
      }
      if (isForkedSessionMeta(payload)) {
        forked = true;
        continue;
      }
      sessionId = nonEmptyString(payload.id) ?? nonEmptyString(payload.session_id) ?? sessionId;
      sessionCwd = nonEmptyString(payload.cwd) ?? sessionCwd;
      createdAt = nonEmptyString(event.timestamp) ?? nonEmptyString(payload.timestamp) ?? createdAt;
      title = nonEmptyString(payload.title) ?? title;
      continue;
    }

    if (event.type === "turn_context") {
      const payload = isRecord(event.payload) ? event.payload : undefined;
      turnCwd = nonEmptyString(payload?.cwd) ?? turnCwd;
      continue;
    }

    const message = extractMessage(event);
    if (message) {
      messages.push(message);
    }
  }

  if (forked) {
    return Effect.succeed(Option.none());
  }

  const externalSessionId = sessionId ?? uuidFromPath(input.nativePath);
  const cwd = sessionCwd ?? turnCwd;
  if (!externalSessionId || !cwd) {
    return Effect.succeed(Option.none());
  }

  const updatedAt = messages.at(-1)?.createdAt ?? createdAt;
  return Effect.succeed(
    Option.some(
      parsedNativeSession({
        provider: "codex",
        externalSessionId,
        cwd,
        nativePath: input.nativePath,
        nativeFormatVersion,
        title: title ?? firstUserTitle(messages),
        createdAt,
        updatedAt,
        messages,
      }),
    ),
  );
}

const CODEX_EXPORT_ORIGINATOR = "t3-teleport";
const CODEX_EXPORT_CLI_VERSION = "0.0.0";

/**
 * Codex TUI bootstrap requires the first parseable rollout line to be
 * `session_meta`. Extra top-level fields (including our format version) make
 * that line fail serde, so resume then treats the first `response_item` as
 * the header and errors with "does not start with session metadata".
 * `cli_version` is required on SessionMeta.
 */
export function serializeCodexSession(session: ParsedNativeSession): string {
  const timestamp = session.createdAt ?? new Date().toISOString();
  let ordinal = 0;
  const lines: string[] = [
    JSON.stringify({
      timestamp,
      ordinal: ordinal++,
      type: "session_meta",
      payload: {
        id: session.externalSessionId,
        session_id: session.externalSessionId,
        timestamp,
        cwd: session.cwd,
        originator: CODEX_EXPORT_ORIGINATOR,
        cli_version: CODEX_EXPORT_CLI_VERSION,
        source: "cli",
        thread_source: "user",
      },
    }),
    JSON.stringify({
      timestamp,
      ordinal: ordinal++,
      type: "turn_context",
      payload: {
        cwd: session.cwd,
      },
    }),
  ];

  for (const message of session.messages) {
    const at = message.createdAt ?? timestamp;
    lines.push(
      JSON.stringify({
        timestamp: at,
        ordinal: ordinal++,
        type: "response_item",
        payload: {
          type: "message",
          role: message.role,
          content: [
            {
              type: message.role === "user" ? "input_text" : "output_text",
              text: message.text,
            },
          ],
        },
      }),
    );
  }

  return `${lines.join("\n")}\n`;
}

export function allocateCodexSessionPath(input: {
  readonly sessionsRoot: string;
  readonly sessionId: string;
  readonly createdAt: string;
  readonly join: (left: string, ...rest: string[]) => string;
}): string {
  const created = new Date(input.createdAt);
  const safeDate = Number.isNaN(created.getTime()) ? new Date() : created;
  const year = String(safeDate.getUTCFullYear());
  const month = String(safeDate.getUTCMonth() + 1).padStart(2, "0");
  const day = String(safeDate.getUTCDate()).padStart(2, "0");
  const stamp = safeDate.toISOString().slice(0, 19).replaceAll(":", "-");
  return input.join(
    input.sessionsRoot,
    year,
    month,
    day,
    `rollout-${stamp}-${input.sessionId}.jsonl`,
  );
}

export const listCodexJsonlFiles = Effect.fn("listCodexJsonlFiles")(function* (
  sessionsRoot: string,
) {
  return yield* walkFiles(sessionsRoot, (filePath) => filePath.endsWith(".jsonl"));
});

export function toCodexCandidate(
  session: ParsedNativeSession,
  instanceId: ProviderInstanceId = defaultInstanceIdForDriver(CODEX),
): TeleportSessionCandidate {
  return {
    provider: "codex",
    providerInstanceId: instanceId,
    externalSessionId: session.externalSessionId,
    cwd: session.cwd,
    nativePath: session.nativePath,
    nativeFormatVersion: session.nativeFormatVersion,
    ...teleportCandidateFields(session),
  };
}

const walkFiles = (root: string, predicate: (filePath: string) => boolean) =>
  walkTeleportFiles(root, {
    shouldCollectFile: (_name, entryPath) => predicate(entryPath),
  });

export const codexTeleportFormat: TeleportFormatAdapter = {
  provider: "codex",
  list: Effect.fn("listCodexSessions")(function* (input) {
    const sessions = new Map<string, TeleportSessionCandidate>();
    const seen = new Set<string>();
    for (const home of codexSearchRoots(input.homes)) {
      const files = yield* listCodexJsonlFiles(home.root);
      for (const nativePath of files) {
        if (seen.has(nativePath)) {
          continue;
        }
        const parsed = yield* readNativeSessionFile({
          nativePath,
          parse: parseCodexSessionContents,
        }).pipe(
          Effect.catchTags({
            TeleportSchemaVersionError: (error) =>
              Effect.logWarning("teleport.codex.unsupported-session-skipped", {
                nativePath,
                foundVersion: error.foundVersion,
              }).pipe(Effect.as(Option.none<ParsedNativeSession>())),
          }),
        );
        if (
          Option.isNone(parsed) ||
          !isSafeTeleportSessionId(parsed.value.externalSessionId) ||
          !parsed.value.messages.some((message) => message.role === "user")
        ) {
          continue;
        }
        if (
          !(yield* teleportSessionBelongsToProject({
            sessionCwd: parsed.value.cwd,
            projectCwd: input.cwd,
            ...definedField("extraCwds", input.extraCwds),
          }))
        ) {
          continue;
        }
        seen.add(nativePath);
        const candidate = toCodexCandidate(parsed.value, home.instanceId);
        const key = `${candidate.providerInstanceId}\0${candidate.externalSessionId}`;
        const existing = sessions.get(key);
        const candidateAt = candidate.updatedAt ?? candidate.createdAt ?? "";
        const existingAt = existing?.updatedAt ?? existing?.createdAt ?? "";
        if (
          existing === undefined ||
          candidateAt > existingAt ||
          (candidateAt === existingAt && candidate.nativePath > existing.nativePath)
        ) {
          sessions.set(key, candidate);
        }
      }
    }
    return [...sessions.values()];
  }),
  load: Effect.fn("loadCodexSession")(function* (input) {
    const parsed = yield* readNativeSessionFile({
      nativePath: input.nativePath,
      parse: parseCodexSessionContents,
    });
    if (Option.isNone(parsed)) {
      return yield* new TeleportDiscoveryError({
        reason: `Native Codex session '${input.externalSessionId}' could not be parsed.`,
      });
    }
    if (!parsed.value.messages.some((message) => message.role === "user")) {
      return yield* new TeleportDiscoveryError({
        reason: `Native Codex session '${input.externalSessionId}' contains no importable user text.`,
      });
    }
    return parsed.value;
  }),
  write: Effect.fn("writeCodexSession")(function* (input) {
    const path = yield* Path.Path;
    const instanceId = input.session.providerInstanceId ?? defaultInstanceIdForDriver(CODEX);
    const sessionsRoot = resolveCodexSessionsRoot(input.homes, instanceId);
    if (sessionsRoot === undefined) {
      return yield* new TeleportNativeWriteError({
        stage: "unknown-instance",
        sessionId: instanceId,
      });
    }
    if (!isSafeTeleportSessionId(input.session.externalSessionId)) {
      return yield* new TeleportNativeWriteError({
        nativePath: sessionsRoot,
        stage: "unsafe-session-id",
        sessionId: input.session.externalSessionId,
      });
    }
    const now = yield* DateTime.now;
    let nativePath: string;
    if (input.existingNativePath === undefined) {
      nativePath = allocateCodexSessionPath({
        sessionsRoot,
        sessionId: input.session.externalSessionId,
        createdAt: input.session.createdAt ?? input.session.updatedAt ?? DateTime.formatIso(now),
        join: path.join,
      });
    } else {
      const canonicalRoot = yield* canonicalizeTeleportNativePath(sessionsRoot);
      nativePath = yield* canonicalizeTeleportNativeWritePath(input.existingNativePath);
      if (!nativePathIsUnderRoot(nativePath, canonicalRoot)) {
        return yield* new TeleportNativeWriteError({
          nativePath,
          stage: "unsafe-native-path",
        });
      }
    }
    const contents = serializeCodexSession({ ...input.session, nativePath });
    yield* writeNativeSessionAtomically({
      filePath: nativePath,
      contents,
      verify: (written) =>
        parseCodexSessionContents({ contents: written, nativePath }).pipe(
          Effect.flatMap((parsed) =>
            Option.isSome(parsed)
              ? Effect.void
              : new TeleportNativeWriteError({
                  nativePath,
                  stage: "verify",
                }),
          ),
          Effect.catchTags({
            TeleportSchemaVersionError: (error) =>
              new TeleportNativeWriteError({
                nativePath,
                stage: "verify",
                cause: error,
              }),
          }),
        ),
    });
    return nativePath;
  }),
  requireUnlocked: (input) => requireNativePathUnlocked(input.nativePath),
  resumeCursor: (externalSessionId) => ({ threadId: externalSessionId }),
  readExternalSessionId: (resumeCursor) =>
    isRecord(resumeCursor) ? nonEmptyString(resumeCursor.threadId) : undefined,
};
