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
import { normalizeProjectPathForDispatch } from "@t3tools/shared/path";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import {
  listingTeleportCwds,
  resolveTeleportCwdPath,
  teleportSessionBelongsToProject,
} from "../cwd.ts";
import {
  canonicalizeTeleportNativePath,
  canonicalizeTeleportNativeWritePath,
  claudeSearchRoots,
  nativePathIsUnderRoot,
  resolveClaudeProjectsRootForInstance,
} from "../homes.ts";
import { requireNativePathUnlocked } from "../fileLock.ts";
import { writeNativeSessionAtomically } from "../nativeWrite.ts";
import { readNativeSessionFile } from "../sessionFile.ts";
import { walkTeleportFiles } from "../walk.ts";
import type { TeleportFormatAdapter } from "./adapter.ts";
import {
  collectTextParts,
  definedField,
  firstUserTitle,
  isRecord,
  isSafeTeleportSessionId,
  isSyntheticNativeUserText,
  nonEmptyString,
  parseJsonObject,
} from "../json.ts";
import {
  nativeTextMessage,
  parsedNativeSession,
  teleportCandidateFields,
  type NativeTextMessage,
  type ParsedNativeSession,
} from "../types.ts";

const CLAUDE = ProviderDriverKind.make("claudeAgent");
const CLAUDE_SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type ClaudeSessionRecord = {
  readonly raw: Record<string, unknown>;
  readonly message: NativeTextMessage | undefined;
  readonly uuid: string | undefined;
};

function isToolResultOnlyContent(content: unknown): boolean {
  if (!Array.isArray(content) || content.length === 0) {
    return false;
  }
  return content.every(
    (part) => isRecord(part) && (part.type === "tool_result" || part.type === "tool_use"),
  );
}

function isClaudeSessionId(value: string): boolean {
  return CLAUDE_SESSION_ID_RE.test(value);
}

export function encodeClaudeProjectPath(cwd: string): string {
  const normalized = normalizeProjectPathForDispatch(cwd);
  const encoded = normalized.replace(/[^a-zA-Z0-9]/g, "-");
  if (encoded.length <= 200) {
    return encoded;
  }
  let hash = 0;
  for (let index = 0; index < normalized.length; index += 1) {
    hash = ((hash << 5) - hash + normalized.charCodeAt(index)) | 0;
  }
  return `${encoded.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}

function extractClaudeMessage(record: Record<string, unknown>): NativeTextMessage | undefined {
  if (record.isSidechain === true || record.isMeta === true) {
    return undefined;
  }
  const type = record.type;
  if (type !== "user" && type !== "assistant") {
    return undefined;
  }
  const message = isRecord(record.message) ? record.message : undefined;
  const role =
    message?.role === "user" || message?.role === "assistant"
      ? message.role
      : type === "user" || type === "assistant"
        ? type
        : undefined;
  if (!role) {
    return undefined;
  }
  const text = collectTextParts(message?.content) ?? collectTextParts(record.content);
  if (!text) {
    return undefined;
  }
  if (role === "user" && isToolResultOnlyContent(message?.content ?? record.content)) {
    return undefined;
  }
  if (role === "user" && isSyntheticNativeUserText(text)) {
    return undefined;
  }
  return nativeTextMessage({
    role,
    text,
    createdAt: nonEmptyString(record.timestamp),
    id: nonEmptyString(record.uuid),
  });
}

function isClaudeConversationRecord(record: Record<string, unknown>): boolean {
  return (
    record.isSidechain !== true &&
    record.isMeta !== true &&
    (record.type === "user" || record.type === "assistant")
  );
}

function messagesOnPrimaryClaudeBranch(records: ReadonlyArray<ClaudeSessionRecord>) {
  const allMessages = records.flatMap((record) =>
    record.message === undefined ? [] : [record.message],
  );
  const conversationRecords = records.filter((record) => isClaudeConversationRecord(record.raw));
  if (
    conversationRecords.length === 0 ||
    conversationRecords.some((record) => record.uuid === undefined)
  ) {
    return allMessages;
  }

  const recordsByUuid = new Map<string, ClaudeSessionRecord>();
  for (const record of records) {
    if (record.uuid === undefined) {
      continue;
    }
    if (recordsByUuid.has(record.uuid)) {
      return allMessages;
    }
    recordsByUuid.set(record.uuid, record);
  }

  const parentOf = (record: ClaudeSessionRecord): string | null | undefined => {
    const parentUuid = nonEmptyString(record.raw.parentUuid);
    if (parentUuid !== undefined && recordsByUuid.has(parentUuid)) {
      return parentUuid;
    }
    const logicalParentUuid = nonEmptyString(record.raw.logicalParentUuid);
    if (logicalParentUuid !== undefined && recordsByUuid.has(logicalParentUuid)) {
      return logicalParentUuid;
    }
    if (parentUuid !== undefined || logicalParentUuid !== undefined) {
      return undefined;
    }
    return null;
  };

  const primaryUuids = new Set<string>();
  let current: ClaudeSessionRecord | undefined;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    const leafUuid =
      record?.raw.type === "summary" ? nonEmptyString(record.raw.leafUuid) : undefined;
    if (leafUuid !== undefined) {
      current = recordsByUuid.get(leafUuid);
      if (current !== undefined) {
        break;
      }
    }
  }
  current ??= conversationRecords.findLast((record) => record.message !== undefined);
  if (current === undefined) {
    return allMessages;
  }
  while (current?.uuid !== undefined) {
    if (primaryUuids.has(current.uuid)) {
      return allMessages;
    }
    primaryUuids.add(current.uuid);
    const parentUuid = parentOf(current);
    if (parentUuid === undefined) {
      return allMessages;
    }
    current = parentUuid === null ? undefined : recordsByUuid.get(parentUuid);
  }

  for (const record of conversationRecords) {
    if (record.uuid === undefined || primaryUuids.has(record.uuid)) {
      continue;
    }
    const visited = new Set<string>();
    let branchRecord: ClaudeSessionRecord | undefined = record;
    let rejoinsPrimary = false;
    while (branchRecord?.uuid !== undefined) {
      if (primaryUuids.has(branchRecord.uuid)) {
        rejoinsPrimary = true;
        break;
      }
      if (visited.has(branchRecord.uuid)) {
        return allMessages;
      }
      visited.add(branchRecord.uuid);
      const parentUuid = parentOf(branchRecord);
      if (parentUuid === undefined) {
        return allMessages;
      }
      branchRecord = parentUuid === null ? undefined : recordsByUuid.get(parentUuid);
    }
    if (!rejoinsPrimary) {
      // Multiple disconnected roots can be produced by compaction or corrupt
      // native files. Flattening is safer than silently dropping history.
      return allMessages;
    }
  }

  return records.flatMap((record) =>
    record.uuid !== undefined && primaryUuids.has(record.uuid) && record.message !== undefined
      ? [record.message]
      : [],
  );
}

export function parseClaudeSessionContents(input: {
  readonly contents: string;
  readonly nativePath: string;
}): Effect.Effect<Option.Option<ParsedNativeSession>, TeleportSchemaVersionError> {
  const lines = input.contents.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return Effect.succeed(Option.none());
  }

  let sessionId: string | undefined;
  let cwd: string | undefined;
  let createdAt: string | undefined;
  let nativeFormatVersion: number = TELEPORT_NATIVE_FORMAT_VERSION;
  const records: ClaudeSessionRecord[] = [];

  for (const line of lines) {
    const record = parseJsonObject(line);
    if (!record) {
      continue;
    }
    const declaredVersion = record.nativeFormatVersion;
    if (typeof declaredVersion === "number" && Number.isInteger(declaredVersion)) {
      nativeFormatVersion = declaredVersion;
    }
    if (nativeFormatVersion > TELEPORT_NATIVE_FORMAT_VERSION) {
      return Effect.fail(
        new TeleportSchemaVersionError({
          provider: "claudeAgent",
          nativePath: input.nativePath,
          foundVersion: nativeFormatVersion,
          supportedVersion: TELEPORT_NATIVE_FORMAT_VERSION,
        }),
      );
    }
    if (
      sessionId === undefined &&
      (isClaudeConversationRecord(record) || record.type === "session")
    ) {
      sessionId = nonEmptyString(record.sessionId);
    }
    cwd = nonEmptyString(record.cwd) ?? cwd;
    createdAt = createdAt ?? nonEmptyString(record.timestamp);
    const message = extractClaudeMessage(record);
    records.push({ raw: record, message, uuid: nonEmptyString(record.uuid) });
  }

  const externalSessionId = sessionId ?? fileStem(input.nativePath);
  if (!externalSessionId || !cwd) {
    return Effect.succeed(Option.none());
  }

  const messages = messagesOnPrimaryClaudeBranch(records);
  const updatedAt = messages.at(-1)?.createdAt ?? createdAt;
  return Effect.succeed(
    Option.some(
      parsedNativeSession({
        provider: "claudeAgent",
        externalSessionId,
        cwd,
        nativePath: input.nativePath,
        nativeFormatVersion,
        title: firstUserTitle(messages),
        createdAt,
        updatedAt,
        messages,
      }),
    ),
  );
}

export function serializeClaudeSession(session: ParsedNativeSession): string {
  const lines: string[] = [];
  const timestamp = session.createdAt ?? new Date().toISOString();
  if (session.messages.length === 0) {
    lines.push(
      JSON.stringify({
        type: "session",
        uuid: session.externalSessionId,
        parentUuid: null,
        sessionId: session.externalSessionId,
        cwd: session.cwd,
        timestamp,
      }),
    );
    return `${lines.join("\n")}\n`;
  }
  let parentUuid: string | null = null;
  for (const [index, message] of session.messages.entries()) {
    const uuid = message.id ?? `${session.externalSessionId}-${index}`;
    const at = message.createdAt ?? timestamp;
    lines.push(
      JSON.stringify({
        type: message.role,
        uuid,
        parentUuid,
        sessionId: session.externalSessionId,
        cwd: session.cwd,
        timestamp: at,
        message: {
          role: message.role,
          content: [{ type: "text", text: message.text }],
        },
      }),
    );
    parentUuid = uuid;
  }
  return `${lines.join("\n")}\n`;
}

export function allocateClaudeSessionPath(input: {
  readonly projectsRoot: string;
  readonly cwd: string;
  readonly sessionId: string;
  readonly join: (left: string, ...rest: string[]) => string;
}): string {
  return input.join(
    input.projectsRoot,
    encodeClaudeProjectPath(input.cwd),
    `${input.sessionId}.jsonl`,
  );
}

export const listClaudeJsonlFiles = Effect.fn("listClaudeJsonlFiles")(function* (
  projectsRoot: string,
  cwd: string,
  options?: { readonly includeGlobalFallback?: boolean },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resolved = yield* resolveTeleportCwdPath(cwd);
  const encodedNames = [
    ...new Set([encodeClaudeProjectPath(cwd), encodeClaudeProjectPath(resolved)]),
  ];
  const roots: string[] = [];
  for (const encoded of encodedNames) {
    const encodedDir = path.join(projectsRoot, encoded);
    if (yield* fs.exists(encodedDir).pipe(Effect.orElseSucceed(() => false))) {
      roots.push(encodedDir);
    }
  }
  // Claude can pin a custom project directory name, and long-path hashing
  // has changed across releases. Search sibling directories too unless the
  // caller already walks `projectsRoot` once for every cwd.
  if ((options?.includeGlobalFallback ?? true) && !roots.includes(projectsRoot)) {
    roots.push(projectsRoot);
  }
  const files = new Set<string>();
  for (const root of roots) {
    for (const file of yield* walkJsonl(root)) {
      files.add(file);
    }
  }
  return [...files];
});

export function toClaudeCandidate(
  session: ParsedNativeSession,
  instanceId: ProviderInstanceId = defaultInstanceIdForDriver(CLAUDE),
): TeleportSessionCandidate {
  return {
    provider: "claudeAgent",
    providerInstanceId: instanceId,
    externalSessionId: session.externalSessionId,
    cwd: session.cwd,
    nativePath: session.nativePath,
    nativeFormatVersion: session.nativeFormatVersion,
    ...teleportCandidateFields(session),
  };
}

function fileStem(filePath: string): string | undefined {
  const base = filePath.replaceAll("\\", "/").split("/").at(-1) ?? filePath;
  return nonEmptyString(base.replace(/\.jsonl$/u, ""));
}

const walkJsonl = (root: string) =>
  walkTeleportFiles(root, {
    shouldEnterDirectory: (name) =>
      name !== "subagents" && name !== "tool-results" && name !== "workflows",
    shouldCollectFile: (name, entryPath) =>
      entryPath.endsWith(".jsonl") && !name.startsWith("agent-"),
  });

export const claudeTeleportFormat: TeleportFormatAdapter = {
  provider: "claudeAgent",
  list: Effect.fn("listClaudeSessions")(function* (input) {
    const sessions = [];
    const seen = new Set<string>();
    for (const home of claudeSearchRoots(input.homes)) {
      const files: string[] = [];
      for (const cwd of listingTeleportCwds(input.cwd, input.extraCwds)) {
        files.push(
          ...(yield* listClaudeJsonlFiles(home.root, cwd, { includeGlobalFallback: false })),
        );
      }
      // Hash-mismatched and custom project folders live as siblings under
      // `projectsRoot`. Walk that tree once per home, not once per worktree.
      files.push(...(yield* walkJsonl(home.root)));
      for (const nativePath of files) {
        if (seen.has(nativePath)) {
          continue;
        }
        const parsed = yield* readNativeSessionFile({
          nativePath,
          parse: parseClaudeSessionContents,
        }).pipe(
          Effect.catchTags({
            TeleportSchemaVersionError: (error) =>
              Effect.logWarning("teleport.claude.unsupported-session-skipped", {
                nativePath,
                foundVersion: error.foundVersion,
              }).pipe(Effect.as(Option.none<ParsedNativeSession>())),
          }),
        );
        if (
          Option.isNone(parsed) ||
          !isSafeTeleportSessionId(parsed.value.externalSessionId) ||
          !isClaudeSessionId(parsed.value.externalSessionId) ||
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
        sessions.push(toClaudeCandidate(parsed.value, home.instanceId));
      }
    }
    return sessions;
  }),
  load: Effect.fn("loadClaudeSession")(function* (input) {
    const parsed = yield* readNativeSessionFile({
      nativePath: input.nativePath,
      parse: parseClaudeSessionContents,
    });
    if (Option.isNone(parsed)) {
      return yield* new TeleportDiscoveryError({
        reason: `Native Claude session '${input.externalSessionId}' could not be parsed.`,
      });
    }
    if (!isClaudeSessionId(parsed.value.externalSessionId)) {
      return yield* new TeleportDiscoveryError({
        reason: `Native Claude session '${input.externalSessionId}' has an invalid session id.`,
      });
    }
    if (!parsed.value.messages.some((message) => message.role === "user")) {
      return yield* new TeleportDiscoveryError({
        reason: `Native Claude session '${input.externalSessionId}' contains no importable user text.`,
      });
    }
    return parsed.value;
  }),
  write: Effect.fn("writeClaudeSession")(function* (input) {
    const path = yield* Path.Path;
    const instanceId = input.session.providerInstanceId ?? defaultInstanceIdForDriver(CLAUDE);
    const projectsRoot = resolveClaudeProjectsRootForInstance(input.homes, instanceId);
    if (projectsRoot === undefined) {
      return yield* new TeleportNativeWriteError({
        stage: "unknown-instance",
        sessionId: instanceId,
      });
    }
    if (!isSafeTeleportSessionId(input.session.externalSessionId)) {
      return yield* new TeleportNativeWriteError({
        nativePath: projectsRoot,
        stage: "unsafe-session-id",
        sessionId: input.session.externalSessionId,
      });
    }
    let nativePath: string;
    if (input.existingNativePath === undefined) {
      nativePath = allocateClaudeSessionPath({
        projectsRoot,
        cwd: input.session.cwd,
        sessionId: input.session.externalSessionId,
        join: path.join,
      });
    } else {
      const canonicalRoot = yield* canonicalizeTeleportNativePath(projectsRoot);
      nativePath = yield* canonicalizeTeleportNativeWritePath(input.existingNativePath);
      if (!nativePathIsUnderRoot(nativePath, canonicalRoot)) {
        return yield* new TeleportNativeWriteError({
          nativePath,
          stage: "unsafe-native-path",
        });
      }
    }
    const contents = serializeClaudeSession({ ...input.session, nativePath });
    yield* writeNativeSessionAtomically({
      filePath: nativePath,
      contents,
      verify: (written) =>
        parseClaudeSessionContents({ contents: written, nativePath }).pipe(
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
  resumeCursor: (externalSessionId) => ({ resume: externalSessionId }),
  readExternalSessionId: (resumeCursor) =>
    isRecord(resumeCursor)
      ? (nonEmptyString(resumeCursor.resume) ?? nonEmptyString(resumeCursor.threadId))
      : undefined,
};
