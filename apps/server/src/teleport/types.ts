import type { TeleportProvider } from "@t3tools/contracts";

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
}

export const MAX_TELEPORT_MESSAGES = 2_000;
export const MAX_TELEPORT_MESSAGE_CHARS = 100_000;
export const MAX_TELEPORT_SESSION_BYTES = 20 * 1024 * 1024;
