import type {
  TeleportNativeRevision,
  TeleportProvider,
  TeleportSessionCandidate,
} from "@t3tools/contracts";

import { definedField } from "./json.ts";

export interface NativeTextMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt?: string;
  readonly id?: string;
}

export interface ParsedNativeSession {
  readonly provider: TeleportProvider;
  readonly externalSessionId: string;
  readonly cwd: string;
  readonly nativePath: string;
  readonly nativeFormatVersion: number;
  readonly title?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly messages: ReadonlyArray<NativeTextMessage>;
  readonly providerInstanceId?: TeleportSessionCandidate["providerInstanceId"];
  readonly nativeRevision?: TeleportNativeRevision;
}

export function nativeTextMessage(input: {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: string | undefined;
  readonly id: string | undefined;
}): NativeTextMessage {
  return {
    role: input.role,
    text: input.text,
    ...definedField("createdAt", input.createdAt),
    ...definedField("id", input.id),
  };
}

export function parsedNativeSession(input: {
  readonly provider: TeleportProvider;
  readonly externalSessionId: string;
  readonly cwd: string;
  readonly nativePath: string;
  readonly nativeFormatVersion: number;
  readonly title: string | undefined;
  readonly createdAt: string | undefined;
  readonly updatedAt: string | undefined;
  readonly messages: ReadonlyArray<NativeTextMessage>;
}): ParsedNativeSession {
  return {
    provider: input.provider,
    externalSessionId: input.externalSessionId,
    cwd: input.cwd,
    nativePath: input.nativePath,
    nativeFormatVersion: input.nativeFormatVersion,
    ...definedField("title", input.title),
    ...definedField("createdAt", input.createdAt),
    ...definedField("updatedAt", input.updatedAt),
    messages: input.messages,
  };
}

export function teleportCandidateFields(
  session: ParsedNativeSession,
): Pick<TeleportSessionCandidate, "title" | "createdAt" | "updatedAt"> {
  return {
    ...definedField("title", session.title),
    ...definedField("createdAt", session.createdAt),
    ...definedField("updatedAt", session.updatedAt),
  };
}

export const MAX_TELEPORT_MESSAGES = 2_000;
export const MAX_TELEPORT_MESSAGE_CHARS = 100_000;
export const MAX_TELEPORT_SESSION_BYTES = 20 * 1024 * 1024;

export function isOversizeTeleportSession(size: number | bigint): boolean {
  const bytes = typeof size === "bigint" ? size : BigInt(size);
  return bytes > BigInt(MAX_TELEPORT_SESSION_BYTES);
}
