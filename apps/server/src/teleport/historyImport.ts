// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
import { ProviderDriverKind } from "@t3tools/contracts";
import { createReadStream, type Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";

const CODEX_PROVIDER = ProviderDriverKind.make("codex");
const OPENCODE_PROVIDER = ProviderDriverKind.make("opencode");
const CURSOR_PROVIDER = ProviderDriverKind.make("cursor");
const MAX_HISTORY_MESSAGES = 20;
const MAX_HISTORY_MESSAGE_CHARS = 20_000;
const MAX_HISTORY_TOTAL_CHARS = 100_000;

type TeleportHistoryRole = "user" | "assistant";

export interface TeleportHistoryMessage {
  readonly role: TeleportHistoryRole;
  readonly text: string;
  readonly createdAt?: string;
}

export interface ReadTeleportHistoryOptions {
  readonly provider: ProviderDriverKind;
  readonly externalSessionId: string;
  readonly homeDir?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function historyRole(value: unknown): TeleportHistoryRole | undefined {
  return value === "user" || value === "assistant" ? value : undefined;
}

function dateFromMillis(value: unknown): string | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? new Date(value).toISOString()
    : undefined;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function walkFiles(
  root: string,
  predicate: (filePath: string) => boolean,
): Promise<string[]> {
  if (!(await pathExists(root))) {
    return [];
  }

  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    let entries: Array<Dirent>;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
      } else if (entry.isFile() && predicate(entryPath)) {
        files.push(entryPath);
      }
    }
  }
  return files;
}

function collectTextParts(content: unknown): string | undefined {
  if (typeof content === "string") {
    return nonEmptyString(content);
  }
  if (!Array.isArray(content)) {
    return undefined;
  }

  const parts: string[] = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    const text = nonEmptyString(part.text);
    if (text) {
      parts.push(text);
    }
  }
  return nonEmptyString(parts.join("\n"));
}

function normalizeOpenCodeText(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "string") {
      return parsed;
    }
  } catch {
    // OpenCode sometimes stores plain text and sometimes a JSON-encoded string.
  }
  return text;
}

const TRUNCATED_SUFFIX = "\n\n[truncated]";

function limitHistory(messages: ReadonlyArray<TeleportHistoryMessage>): TeleportHistoryMessage[] {
  const tail = messages.slice(-MAX_HISTORY_MESSAGES);
  const limited: TeleportHistoryMessage[] = [];
  let totalChars = 0;

  for (const message of tail) {
    const text = message.text.trim();
    if (!text) continue;
    const remaining = MAX_HISTORY_TOTAL_CHARS - totalChars;
    if (remaining <= 0) break;
    const maxChars = Math.min(MAX_HISTORY_MESSAGE_CHARS, remaining);
    const clipped =
      text.length > maxChars
        ? maxChars <= TRUNCATED_SUFFIX.length
          ? text.slice(0, maxChars)
          : `${text.slice(0, maxChars - TRUNCATED_SUFFIX.length).trimEnd()}${TRUNCATED_SUFFIX}`
        : text;
    limited.push({
      ...message,
      text: clipped,
    });
    totalChars += clipped.length;
  }

  return limited;
}

function compareHistoryCreatedAt(
  left: TeleportHistoryMessage,
  right: TeleportHistoryMessage,
): number {
  const leftTime = left.createdAt ? Date.parse(left.createdAt) : Number.NaN;
  const rightTime = right.createdAt ? Date.parse(right.createdAt) : Number.NaN;
  const leftValid = Number.isFinite(leftTime);
  const rightValid = Number.isFinite(rightTime);
  if (leftValid && rightValid) {
    return leftTime - rightTime;
  }
  if (leftValid !== rightValid) {
    return leftValid ? -1 : 1;
  }
  return 0;
}

function readCodexSessionId(filePath: string, payload: unknown): string | undefined {
  if (isRecord(payload)) {
    const id = nonEmptyString(payload.id);
    if (id) return id;
  }
  return filePath.includes(".jsonl") ? filePath.match(/[0-9a-f-]{36}/iu)?.[0] : undefined;
}

function extractCodexMessage(event: Record<string, unknown>): TeleportHistoryMessage | undefined {
  if (event.type !== "response_item") {
    return undefined;
  }
  const payload = isRecord(event.payload) ? event.payload : undefined;
  if (payload?.type !== "message") {
    return undefined;
  }
  const role = historyRole(payload.role);
  if (!role) {
    return undefined;
  }
  const text = collectTextParts(payload.content);
  if (!text) {
    return undefined;
  }
  const createdAt = nonEmptyString(event.timestamp);
  return {
    role,
    text,
    ...(createdAt ? { createdAt } : {}),
  };
}

async function parseCodexHistoryFile(
  filePath: string,
  externalSessionId: string,
): Promise<TeleportHistoryMessage[] | undefined> {
  let declaredSessionId: string | undefined;
  const messages: TeleportHistoryMessage[] = [];
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of reader) {
      if (!line.trim()) continue;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(event)) continue;

      if (event.type === "session_meta") {
        declaredSessionId = readCodexSessionId(filePath, event.payload);
      }

      const message = extractCodexMessage(event);
      if (message) {
        messages.push(message);
      }
    }
  } finally {
    reader.close();
    stream.destroy();
  }

  if (declaredSessionId && declaredSessionId !== externalSessionId) {
    return undefined;
  }
  if (!declaredSessionId && !filePath.includes(externalSessionId)) {
    return undefined;
  }
  return messages;
}

async function readCodexHistory(
  homeDir: string,
  externalSessionId: string,
): Promise<TeleportHistoryMessage[]> {
  const root = path.join(homeDir, ".codex", "sessions");
  const files = await walkFiles(root, (filePath) => filePath.endsWith(".jsonl"));
  const preferredFiles = files.toSorted((left, right) => {
    const leftMatch = left.includes(externalSessionId) ? 1 : 0;
    const rightMatch = right.includes(externalSessionId) ? 1 : 0;
    return rightMatch - leftMatch;
  });

  for (const filePath of preferredFiles) {
    const messages = await parseCodexHistoryFile(filePath, externalSessionId);
    if (messages !== undefined) {
      return limitHistory(messages);
    }
  }
  return [];
}

async function readOpenCodePartText(
  homeDir: string,
  messageId: string,
): Promise<string | undefined> {
  const root = path.join(homeDir, ".local", "share", "opencode", "storage", "part", messageId);
  const files = await walkFiles(root, (filePath) => filePath.endsWith(".json"));
  const texts: string[] = [];

  for (const filePath of files.toSorted()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    if (parsed.type !== "text") continue;
    const text = nonEmptyString(parsed.text);
    if (text) {
      texts.push(normalizeOpenCodeText(text));
    }
  }

  return nonEmptyString(texts.join("\n"));
}

async function readOpenCodeHistory(
  homeDir: string,
  externalSessionId: string,
): Promise<TeleportHistoryMessage[]> {
  const root = path.join(
    homeDir,
    ".local",
    "share",
    "opencode",
    "storage",
    "message",
    externalSessionId,
  );
  const files = await walkFiles(root, (filePath) => filePath.endsWith(".json"));
  const messages: TeleportHistoryMessage[] = [];

  for (const filePath of files) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    const role = historyRole(parsed.role);
    const messageId = nonEmptyString(parsed.id);
    if (!role || !messageId) continue;
    const text = await readOpenCodePartText(homeDir, messageId);
    if (!text) continue;
    const time = isRecord(parsed.time) ? parsed.time : undefined;
    const createdAt = dateFromMillis(time?.created);
    messages.push({
      role,
      text,
      ...(createdAt ? { createdAt } : {}),
    });
  }

  return limitHistory(messages.toSorted(compareHistoryCreatedAt));
}

function extractGenericCursorMessage(
  event: Record<string, unknown>,
): TeleportHistoryMessage | undefined {
  const payload = isRecord(event.payload) ? event.payload : event;
  const role = historyRole(payload.role);
  if (!role) {
    return undefined;
  }
  const text =
    nonEmptyString(payload.text) ??
    nonEmptyString(payload.content) ??
    collectTextParts(payload.content);
  if (!text) {
    return undefined;
  }
  const createdAt =
    nonEmptyString(event.timestamp) ??
    nonEmptyString(payload.timestamp) ??
    nonEmptyString(payload.createdAt);
  return {
    role,
    text,
    ...(createdAt ? { createdAt } : {}),
  };
}

async function readCursorHistory(
  homeDir: string,
  externalSessionId: string,
): Promise<TeleportHistoryMessage[]> {
  const root = path.join(homeDir, ".cursor", "acp-sessions", externalSessionId);
  const files = await walkFiles(root, (filePath) => filePath.endsWith(".jsonl"));
  const messages: TeleportHistoryMessage[] = [];

  for (const filePath of files.toSorted()) {
    const stream = createReadStream(filePath, { encoding: "utf8" });
    const reader = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of reader) {
        if (!line.trim()) continue;
        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (!isRecord(event)) continue;
        const message = extractGenericCursorMessage(event);
        if (message) {
          messages.push(message);
        }
      }
    } finally {
      reader.close();
      stream.destroy();
    }
  }

  return limitHistory(messages);
}

export async function readTeleportHistory(
  options: ReadTeleportHistoryOptions,
): Promise<TeleportHistoryMessage[]> {
  const homeDir = options.homeDir ?? os.homedir();
  if (options.provider === CODEX_PROVIDER) {
    return readCodexHistory(homeDir, options.externalSessionId);
  }
  if (options.provider === OPENCODE_PROVIDER) {
    return readOpenCodeHistory(homeDir, options.externalSessionId);
  }
  if (options.provider === CURSOR_PROVIDER) {
    return readCursorHistory(homeDir, options.externalSessionId);
  }
  return [];
}
