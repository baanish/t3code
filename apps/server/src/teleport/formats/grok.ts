// Native Grok files store wall-clock ISO timestamps and JSON session records.
// @effect-diagnostics globalDate:off preferSchemaOverJson:off
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

import { firstUserTitle, isRecord, nonEmptyString, parseJsonObject } from "../json.ts";
import {
  nativeTextMessage,
  parsedNativeSession,
  teleportCandidateFields,
  type NativeTextMessage,
  type ParsedNativeSession,
} from "../types.ts";

const GROK = ProviderDriverKind.make("grok");

export function parseGrokSessionContents(input: {
  readonly contents: string;
  readonly nativePath: string;
}): Effect.Effect<Option.Option<ParsedNativeSession>, TeleportSchemaVersionError> {
  const parsed = parseJsonObject(input.contents);
  if (!parsed) {
    return Effect.succeed(Option.none());
  }

  const nativeFormatVersion =
    typeof parsed.nativeFormatVersion === "number" && Number.isInteger(parsed.nativeFormatVersion)
      ? parsed.nativeFormatVersion
      : TELEPORT_NATIVE_FORMAT_VERSION;
  if (nativeFormatVersion > TELEPORT_NATIVE_FORMAT_VERSION) {
    return Effect.fail(
      new TeleportSchemaVersionError({
        provider: "grok",
        nativePath: input.nativePath,
        foundVersion: nativeFormatVersion,
        supportedVersion: TELEPORT_NATIVE_FORMAT_VERSION,
        message: `Unsupported Grok session format version ${nativeFormatVersion} in ${input.nativePath}.`,
      }),
    );
  }

  const externalSessionId = nonEmptyString(parsed.id);
  const cwd = nonEmptyString(parsed.cwd);
  if (!externalSessionId || !cwd) {
    return Effect.succeed(Option.none());
  }

  const messages: NativeTextMessage[] = [];
  if (Array.isArray(parsed.messages)) {
    for (const entry of parsed.messages) {
      if (!isRecord(entry)) {
        continue;
      }
      const role = entry.role === "user" || entry.role === "assistant" ? entry.role : undefined;
      const text = nonEmptyString(entry.text);
      if (!role || !text) {
        continue;
      }
      messages.push(
        nativeTextMessage({
          role,
          text,
          createdAt: nonEmptyString(entry.createdAt),
          id: nonEmptyString(entry.id),
        }),
      );
    }
  }

  return Effect.succeed(
    Option.some(
      parsedNativeSession({
        provider: "grok",
        externalSessionId,
        cwd,
        nativePath: input.nativePath,
        nativeFormatVersion,
        title: nonEmptyString(parsed.title) ?? firstUserTitle(messages),
        createdAt: nonEmptyString(parsed.createdAt),
        updatedAt: nonEmptyString(parsed.updatedAt),
        messages,
      }),
    ),
  );
}

export function serializeGrokSession(session: ParsedNativeSession): string {
  return `${JSON.stringify(
    {
      nativeFormatVersion: TELEPORT_NATIVE_FORMAT_VERSION,
      id: session.externalSessionId,
      cwd: session.cwd,
      ...(session.title ? { title: session.title } : {}),
      createdAt: session.createdAt ?? new Date().toISOString(),
      updatedAt: session.updatedAt ?? session.createdAt ?? new Date().toISOString(),
      messages: session.messages.map((message, index) => ({
        id: message.id ?? `${session.externalSessionId}-${index}`,
        role: message.role,
        text: message.text,
        createdAt: message.createdAt ?? session.createdAt ?? new Date().toISOString(),
      })),
    },
    null,
    2,
  )}\n`;
}

export function allocateGrokSessionPath(input: {
  readonly sessionsRoot: string;
  readonly sessionId: string;
  readonly join: (left: string, ...rest: string[]) => string;
}): string {
  return input.join(input.sessionsRoot, `${input.sessionId}.json`);
}

export const listGrokSessionFiles = Effect.fn("listGrokSessionFiles")(function* (
  sessionsRoot: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const exists = yield* fs.exists(sessionsRoot).pipe(Effect.orElseSucceed(() => false));
  if (!exists) {
    return [] as string[];
  }
  const entries = yield* fs.readDirectory(sessionsRoot).pipe(Effect.orElseSucceed(() => []));
  const files: string[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) {
      continue;
    }
    const entryPath = path.join(sessionsRoot, name);
    const stat = yield* fs.stat(entryPath).pipe(Effect.orElseSucceed(() => null));
    if (stat?.type === "File") {
      files.push(entryPath);
    }
  }
  return files;
});

export function toGrokCandidate(session: ParsedNativeSession): TeleportSessionCandidate {
  return {
    provider: "grok",
    providerInstanceId: defaultInstanceIdForDriver(GROK),
    externalSessionId: session.externalSessionId,
    cwd: session.cwd,
    nativePath: session.nativePath,
    nativeFormatVersion: session.nativeFormatVersion,
    ...teleportCandidateFields(session),
  };
}
