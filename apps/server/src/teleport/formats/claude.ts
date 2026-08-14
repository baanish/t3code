// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  TELEPORT_NATIVE_FORMAT_VERSION,
  TeleportSchemaVersionError,
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type TeleportSessionCandidate,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import {
  collectTextParts,
  firstUserTitle,
  isRecord,
  nonEmptyString,
  parseJsonObject,
} from "../json.ts";
import type { NativeTextMessage, ParsedNativeSession } from "../types.ts";

const CLAUDE = ProviderDriverKind.make("claudeAgent");

export function encodeClaudeProjectPath(cwd: string): string {
  const encoded = cwd.replace(/[^a-zA-Z0-9]/gu, "-");
  if (encoded.length <= 200) {
    return encoded;
  }
  const digest = NodeCrypto.createHash("sha256").update(cwd).digest("hex").slice(0, 16);
  return `${encoded.slice(0, 200)}${digest}`;
}

function extractClaudeMessage(record: Record<string, unknown>): NativeTextMessage | undefined {
  if (record.isSidechain === true) {
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
  return {
    role,
    text,
    ...(nonEmptyString(record.timestamp) ? { createdAt: nonEmptyString(record.timestamp) } : {}),
    ...(nonEmptyString(record.uuid) ? { id: nonEmptyString(record.uuid) } : {}),
  };
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
  let nativeFormatVersion = TELEPORT_NATIVE_FORMAT_VERSION;
  const messages: NativeTextMessage[] = [];

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
          message: `Unsupported Claude session format version ${nativeFormatVersion} in ${input.nativePath}.`,
        }),
      );
    }
    sessionId = nonEmptyString(record.sessionId) ?? sessionId;
    cwd = nonEmptyString(record.cwd) ?? cwd;
    createdAt = createdAt ?? nonEmptyString(record.timestamp);
    const message = extractClaudeMessage(record);
    if (message) {
      messages.push(message);
    }
  }

  const externalSessionId = sessionId ?? fileStem(input.nativePath);
  if (!externalSessionId || !cwd) {
    return Effect.succeed(Option.none());
  }

  const updatedAt = messages.at(-1)?.createdAt ?? createdAt;
  return Effect.succeed(
    Option.some({
      provider: "claudeAgent",
      externalSessionId,
      cwd,
      nativePath: input.nativePath,
      nativeFormatVersion: TELEPORT_NATIVE_FORMAT_VERSION,
      ...(firstUserTitle(messages) ? { title: firstUserTitle(messages) } : {}),
      ...(createdAt ? { createdAt } : {}),
      ...(updatedAt ? { updatedAt } : {}),
      messages,
    }),
  );
}

export function serializeClaudeSession(session: ParsedNativeSession): string {
  const lines: string[] = [];
  let parentUuid: string | null = null;
  for (const [index, message] of session.messages.entries()) {
    const uuid = message.id ?? `${session.externalSessionId}-${index}`;
    const timestamp = message.createdAt ?? session.createdAt ?? new Date().toISOString();
    lines.push(
      JSON.stringify({
        type: message.role,
        nativeFormatVersion: TELEPORT_NATIVE_FORMAT_VERSION,
        uuid,
        parentUuid,
        sessionId: session.externalSessionId,
        cwd: session.cwd,
        timestamp,
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
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const encodedDir = path.join(projectsRoot, encodeClaudeProjectPath(cwd));
  const encodedExists = yield* fs.exists(encodedDir).pipe(Effect.orElseSucceed(() => false));
  const roots = encodedExists ? [encodedDir] : [projectsRoot];
  const files: string[] = [];
  for (const root of roots) {
    files.push(...(yield* walkJsonl(root)));
  }
  return files;
});

export function toClaudeCandidate(session: ParsedNativeSession): TeleportSessionCandidate {
  return {
    provider: "claudeAgent",
    providerInstanceId: defaultInstanceIdForDriver(CLAUDE),
    externalSessionId: session.externalSessionId,
    cwd: session.cwd,
    nativePath: session.nativePath,
    nativeFormatVersion: session.nativeFormatVersion,
    ...(session.title ? { title: session.title } : {}),
    ...(session.createdAt ? { createdAt: session.createdAt } : {}),
    ...(session.updatedAt ? { updatedAt: session.updatedAt } : {}),
  };
}

function fileStem(filePath: string): string | undefined {
  const base = filePath.split("/").at(-1) ?? filePath;
  return nonEmptyString(base.replace(/\.jsonl$/u, ""));
}

const walkJsonl = Effect.fn("walkClaudeJsonl")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const exists = yield* fs.exists(root).pipe(Effect.orElseSucceed(() => false));
  if (!exists) {
    return [] as string[];
  }
  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    const entries = yield* fs.readDirectory(current).pipe(Effect.orElseSucceed(() => []));
    for (const name of entries) {
      const entryPath = path.join(current, name);
      const stat = yield* fs.stat(entryPath).pipe(Effect.orElseSucceed(() => null));
      if (stat === null) {
        continue;
      }
      if (stat.type === "Directory") {
        stack.push(entryPath);
      } else if (stat.type === "File" && entryPath.endsWith(".jsonl")) {
        files.push(entryPath);
      }
    }
  }
  return files;
});
