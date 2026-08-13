// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
import {
  ProviderDriverKind,
  defaultInstanceIdForDriver,
  type TeleportListSessionsInput,
  type TeleportSessionCandidate,
} from "@t3tools/contracts";
import { createReadStream, type Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";

const CODEX_PROVIDER = ProviderDriverKind.make("codex");
const OPENCODE_PROVIDER = ProviderDriverKind.make("opencode");
const CURSOR_PROVIDER = ProviderDriverKind.make("cursor");
const TELEPORT_DISCOVERY_PROVIDERS = [CODEX_PROVIDER, OPENCODE_PROVIDER, CURSOR_PROVIDER] as const;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu;
const OPENCODE_SQLITE_SESSION_LIMIT = 1_000;

export interface TeleportDiscoveryOptions {
  readonly homeDir?: string;
  readonly input?: TeleportListSessionsInput | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function dateFromMillis(value: unknown): string | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? new Date(value).toISOString()
    : undefined;
}

function millisFromIso(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
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
    if (text) parts.push(text);
  }
  return nonEmptyString(parts.join("\n"));
}

function truncateTitle(input: string): string {
  const normalized = input.replace(/\s+/gu, " ").trim();
  if (normalized.length <= 80) {
    return normalized;
  }
  return `${normalized.slice(0, 77).trimEnd()}...`;
}

function normalizeOpenCodeText(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "string") {
      return parsed;
    }
  } catch {
    // OpenCode stores text parts as either plain text or JSON-encoded strings.
  }
  return text;
}

function isBoilerplateTitleLine(line: string): boolean {
  const normalized = line.trim().toLowerCase();
  if (!normalized) return true;
  if (normalized.startsWith("# agents.md instructions for")) return true;
  if (normalized.startsWith("# codex global instructions")) return true;
  if (normalized === "<instructions>" || normalized === "</instructions>") return true;
  if (normalized.startsWith("# files mentioned by the user")) return true;
  if (normalized.startsWith("<image")) return true;
  if (normalized.startsWith("</image")) return true;
  if (normalized.startsWith("<environment_context")) return true;
  if (normalized.startsWith("</environment_context")) return true;
  if (normalized.startsWith("## ") && normalized.includes(": /")) return true;
  return false;
}

function isInjectedCodexContextMessage(input: string): boolean {
  const normalized = input.trim().toLowerCase();
  return (
    normalized.startsWith("# agents.md instructions for") ||
    normalized.startsWith("# codex global instructions") ||
    (normalized.includes("<instructions>") && normalized.includes("<environment_context>"))
  );
}

function firstMeaningfulTitleLine(input: string): string | undefined {
  for (const rawLine of input.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!isBoilerplateTitleLine(line)) {
      return line;
    }
  }
  return undefined;
}

function requestSectionFromCodexUserText(input: string): string | undefined {
  const match = /(?:^|\n)##?\s*My request for Codex:\s*/iu.exec(input);
  if (!match) {
    return undefined;
  }
  const start = match.index + match[0].length;
  const afterMarker = input.slice(start);
  const mediaIndex = afterMarker.search(/\n\s*<image\b/iu);
  const requestText = mediaIndex >= 0 ? afterMarker.slice(0, mediaIndex) : afterMarker;
  return firstMeaningfulTitleLine(requestText) ?? nonEmptyString(requestText);
}

function titleFromCodexUserText(input: string): string | undefined {
  const requestSection = requestSectionFromCodexUserText(input);
  if (requestSection) {
    return truncateTitle(requestSection);
  }
  if (isInjectedCodexContextMessage(input)) {
    return undefined;
  }
  const firstLine = firstMeaningfulTitleLine(input);
  return firstLine ? truncateTitle(firstLine) : undefined;
}

function readCodexSessionId(filePath: string, payload: unknown): string | undefined {
  if (isRecord(payload)) {
    const id = nonEmptyString(payload.id);
    if (id) return id;
  }
  return filePath.match(UUID_RE)?.[0];
}

async function parseCodexSession(filePath: string): Promise<TeleportSessionCandidate | undefined> {
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let title: string | undefined;
  let createdAt: string | undefined;
  let updatedAt: string | undefined;
  let lineCount = 0;
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of reader) {
      lineCount += 1;
      if (!line.trim()) continue;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(event)) continue;

      const timestamp = nonEmptyString(event.timestamp);
      if (timestamp) {
        updatedAt = timestamp;
      }

      if (event.type === "session_meta") {
        const payload = isRecord(event.payload) ? event.payload : undefined;
        sessionId = sessionId ?? readCodexSessionId(filePath, payload);
        cwd = cwd ?? nonEmptyString(payload?.cwd);
        const metadataTitle = nonEmptyString(payload?.title);
        if (!title && metadataTitle) {
          title = truncateTitle(metadataTitle);
        }
        createdAt = createdAt ?? nonEmptyString(payload?.timestamp) ?? timestamp;
      }

      if (event.type === "turn_context") {
        const payload = isRecord(event.payload) ? event.payload : undefined;
        cwd = cwd ?? nonEmptyString(payload?.cwd);
      }

      if (!title && event.type === "response_item") {
        const payload = isRecord(event.payload) ? event.payload : undefined;
        if (payload?.type === "message" && payload.role === "user") {
          const text = collectTextParts(payload.content);
          if (text) {
            title = titleFromCodexUserText(text);
          }
        }
      }

      if (sessionId && cwd && title) {
        break;
      }
      if (lineCount >= 250 && sessionId && cwd) {
        break;
      }
    }
  } finally {
    reader.close();
    stream.destroy();
  }

  if (!sessionId || !cwd) {
    return undefined;
  }

  const stat = await fs.stat(filePath).catch(() => undefined);
  const statUpdatedAt = stat ? stat.mtime.toISOString() : undefined;
  return {
    provider: CODEX_PROVIDER,
    providerInstanceId: defaultInstanceIdForDriver(CODEX_PROVIDER),
    externalSessionId: sessionId,
    cwd,
    ...(title ? { title } : {}),
    availability: "stopped",
    ...(createdAt ? { createdAt } : {}),
    updatedAt: latestTimestamp(updatedAt, statUpdatedAt),
  };
}

interface SqliteRowsClient {
  readonly all: (sql: string, params?: ReadonlyArray<unknown>) => ReadonlyArray<unknown>;
  readonly close: () => void;
}

async function openReadonlySqlite(dbPath: string): Promise<SqliteRowsClient | undefined> {
  try {
    const sqlite = await import("node:sqlite");
    const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    return {
      all: (sql, params = []) => {
        const statement = db.prepare(sql) as unknown as {
          all: (...params: ReadonlyArray<unknown>) => ReadonlyArray<unknown>;
        };
        return statement.all(...params);
      },
      close: () => db.close(),
    };
  } catch {
    try {
      const sqlite = await import("bun:sqlite");
      const db = new sqlite.Database(dbPath, { readonly: true });
      return {
        all: (sql, params = []) => {
          const query = db.query(sql) as unknown as {
            all: (...params: ReadonlyArray<unknown>) => ReadonlyArray<unknown>;
          };
          return query.all(...params);
        },
        close: () => db.close(),
      };
    } catch {
      return undefined;
    }
  }
}

async function discoverCodexSessions(homeDir: string): Promise<TeleportSessionCandidate[]> {
  const root = path.join(homeDir, ".codex", "sessions");
  const files = await walkFiles(root, (filePath) => filePath.endsWith(".jsonl"));
  const parsed = await Promise.all(files.map((filePath) => parseCodexSession(filePath)));
  return parsed.filter(
    (candidate): candidate is TeleportSessionCandidate => candidate !== undefined,
  );
}

async function parseOpenCodeSession(
  filePath: string,
): Promise<TeleportSessionCandidate | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) {
    return undefined;
  }
  const id = nonEmptyString(parsed.id);
  const cwd = nonEmptyString(parsed.directory);
  if (!id || !cwd) {
    return undefined;
  }
  const time = isRecord(parsed.time) ? parsed.time : undefined;
  const stat = await fs.stat(filePath).catch(() => undefined);
  return {
    provider: OPENCODE_PROVIDER,
    providerInstanceId: defaultInstanceIdForDriver(OPENCODE_PROVIDER),
    externalSessionId: id,
    cwd,
    ...(nonEmptyString(parsed.title) ? { title: nonEmptyString(parsed.title) } : {}),
    availability: "stopped",
    ...(dateFromMillis(time?.created) ? { createdAt: dateFromMillis(time?.created) } : {}),
    updatedAt: dateFromMillis(time?.updated) ?? (stat ? stat.mtime.toISOString() : undefined),
  };
}

type OpenCodeMessageRole = "user" | "assistant";

interface OpenCodeMessageSummary {
  readonly id: string;
  readonly role?: OpenCodeMessageRole | undefined;
  readonly cwd?: string | undefined;
  readonly createdAt?: string | undefined;
  readonly updatedAt?: string | undefined;
  readonly sortMillis: number;
}

function openCodeMessageRole(value: unknown): OpenCodeMessageRole | undefined {
  return value === "user" || value === "assistant" ? value : undefined;
}

function millisFromOpenCodeTime(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function numberFromSqliteInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "bigint") {
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : undefined;
  }
  return undefined;
}

function projectPathFromOpenCodeValue(value: unknown): string | undefined {
  const maybePath = nonEmptyString(value);
  if (!maybePath) {
    return undefined;
  }
  return path.parse(maybePath).root === maybePath ? undefined : maybePath;
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

function textFromOpenCodePartData(data: unknown): string | undefined {
  const raw = nonEmptyString(data);
  if (!raw) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) {
    return undefined;
  }
  if (parsed.type !== "text") {
    return undefined;
  }
  const text = nonEmptyString(parsed.text);
  return text ? normalizeOpenCodeText(text) : undefined;
}

function titleFromOpenCodeText(text: string): string | undefined {
  const title = firstMeaningfulTitleLine(text) ?? text;
  return truncateTitle(title);
}

async function parseOpenCodeMessageFile(
  sessionId: string,
  filePath: string,
): Promise<OpenCodeMessageSummary | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) {
    return undefined;
  }

  const declaredSessionId = nonEmptyString(parsed.sessionID);
  if (declaredSessionId && declaredSessionId !== sessionId) {
    return undefined;
  }

  const id = nonEmptyString(parsed.id);
  if (!id) {
    return undefined;
  }

  const time = isRecord(parsed.time) ? parsed.time : undefined;
  const createdMillis = millisFromOpenCodeTime(time?.created);
  const updatedMillis = millisFromOpenCodeTime(time?.updated);
  const stat = await fs.stat(filePath).catch(() => undefined);
  const messagePath = isRecord(parsed.path) ? parsed.path : undefined;
  const cwd =
    projectPathFromOpenCodeValue(messagePath?.cwd) ??
    projectPathFromOpenCodeValue(messagePath?.root);

  return {
    id,
    ...(openCodeMessageRole(parsed.role) ? { role: openCodeMessageRole(parsed.role) } : {}),
    ...(cwd ? { cwd } : {}),
    ...(dateFromMillis(createdMillis) ? { createdAt: dateFromMillis(createdMillis) } : {}),
    ...(dateFromMillis(updatedMillis) ? { updatedAt: dateFromMillis(updatedMillis) } : {}),
    sortMillis: createdMillis ?? updatedMillis ?? stat?.mtimeMs ?? 0,
  };
}

async function titleFromOpenCodeMessages(
  homeDir: string,
  messages: ReadonlyArray<OpenCodeMessageSummary>,
): Promise<string | undefined> {
  for (const message of messages) {
    if (message.role !== "user") continue;
    const text = await readOpenCodePartText(homeDir, message.id);
    if (!text) continue;
    return titleFromOpenCodeText(text);
  }
  return undefined;
}

function cwdFromOpenCodeMessages(
  messages: ReadonlyArray<OpenCodeMessageSummary>,
): string | undefined {
  for (const message of messages.toReversed()) {
    if (message.cwd) {
      return message.cwd;
    }
  }
  return undefined;
}

function firstTimestamp(messages: ReadonlyArray<OpenCodeMessageSummary>): string | undefined {
  for (const message of messages) {
    if (message.createdAt) {
      return message.createdAt;
    }
  }
  return undefined;
}

function lastTimestamp(messages: ReadonlyArray<OpenCodeMessageSummary>): string | undefined {
  for (const message of messages.toReversed()) {
    if (message.updatedAt) return message.updatedAt;
    if (message.createdAt) return message.createdAt;
  }
  return undefined;
}

async function parseOpenCodeMessageSession(
  homeDir: string,
  sessionId: string,
): Promise<TeleportSessionCandidate | undefined> {
  const root = path.join(homeDir, ".local", "share", "opencode", "storage", "message", sessionId);
  const files = await walkFiles(root, (filePath) => filePath.endsWith(".json"));
  const parsed = await Promise.all(
    files.map((filePath) => parseOpenCodeMessageFile(sessionId, filePath)),
  );
  const messages = parsed
    .filter((message): message is OpenCodeMessageSummary => message !== undefined)
    .toSorted((left, right) => left.sortMillis - right.sortMillis);
  const cwd = cwdFromOpenCodeMessages(messages);
  if (!cwd) {
    return undefined;
  }
  const title = await titleFromOpenCodeMessages(homeDir, messages);
  const createdAt = firstTimestamp(messages);
  const updatedAt = lastTimestamp(messages);

  return {
    provider: OPENCODE_PROVIDER,
    providerInstanceId: defaultInstanceIdForDriver(OPENCODE_PROVIDER),
    externalSessionId: sessionId,
    cwd,
    ...(title ? { title } : {}),
    availability: "stopped",
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  };
}

async function discoverOpenCodeMessageSessions(
  homeDir: string,
): Promise<TeleportSessionCandidate[]> {
  const root = path.join(homeDir, ".local", "share", "opencode", "storage", "message");
  if (!(await pathExists(root))) {
    return [];
  }
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const parsed = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => parseOpenCodeMessageSession(homeDir, entry.name)),
  );
  return parsed.filter(
    (candidate): candidate is TeleportSessionCandidate => candidate !== undefined,
  );
}

interface OpenCodeSqliteSessionRow {
  readonly id?: unknown;
  readonly directory?: unknown;
  readonly title?: unknown;
  readonly time_created?: unknown;
  readonly time_updated?: unknown;
  readonly model?: unknown;
  readonly first_part_data?: unknown;
}

function parseOpenCodeSqliteModelSelection(
  model: unknown,
): TeleportSessionCandidate["modelSelection"] {
  const raw = nonEmptyString(model);
  if (!raw) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) {
    return undefined;
  }
  const providerId = nonEmptyString(parsed.providerID);
  const modelId = nonEmptyString(parsed.id) ?? nonEmptyString(parsed.modelID);
  if (!providerId || !modelId) {
    return undefined;
  }
  return {
    instanceId: defaultInstanceIdForDriver(OPENCODE_PROVIDER),
    model: `${providerId}/${modelId}`,
  };
}

function parseOpenCodeSqliteSessionRow(
  row: OpenCodeSqliteSessionRow,
): TeleportSessionCandidate | undefined {
  const id = nonEmptyString(row.id);
  const cwd = projectPathFromOpenCodeValue(row.directory);
  if (!id || !cwd) {
    return undefined;
  }
  const createdMillis = numberFromSqliteInteger(row.time_created);
  const updatedMillis = numberFromSqliteInteger(row.time_updated);
  const userText = textFromOpenCodePartData(row.first_part_data);
  const title = userText ? titleFromOpenCodeText(userText) : nonEmptyString(row.title);
  const modelSelection = parseOpenCodeSqliteModelSelection(row.model);
  return {
    provider: OPENCODE_PROVIDER,
    providerInstanceId: defaultInstanceIdForDriver(OPENCODE_PROVIDER),
    externalSessionId: id,
    cwd,
    ...(title ? { title: truncateTitle(title) } : {}),
    ...(modelSelection ? { modelSelection } : {}),
    availability: "stopped",
    ...(dateFromMillis(createdMillis) ? { createdAt: dateFromMillis(createdMillis) } : {}),
    ...(dateFromMillis(updatedMillis) ? { updatedAt: dateFromMillis(updatedMillis) } : {}),
  };
}

async function discoverOpenCodeSqliteSessions(
  homeDir: string,
): Promise<TeleportSessionCandidate[]> {
  const dbPath = path.join(homeDir, ".local", "share", "opencode", "opencode.db");
  if (!(await pathExists(dbPath))) {
    return [];
  }

  const db = await openReadonlySqlite(dbPath);
  if (!db) {
    return [];
  }

  try {
    const sessionRows = db.all(
      `
        SELECT
          s.id,
          s.directory,
          s.title,
          s.time_created,
          s.time_updated,
          s.model,
          (
            SELECT p.data
            FROM message m
            JOIN part p ON p.message_id = m.id
            WHERE m.session_id = s.id
              AND json_extract(m.data, '$.role') = 'user'
              AND json_extract(p.data, '$.type') = 'text'
            ORDER BY m.time_created ASC, p.time_created ASC
            LIMIT 1
          ) AS first_part_data
        FROM session s
        WHERE s.time_archived IS NULL
        ORDER BY s.time_updated DESC, s.id ASC
        LIMIT ?
      `,
      [OPENCODE_SQLITE_SESSION_LIMIT],
    ) as ReadonlyArray<OpenCodeSqliteSessionRow>;
    return sessionRows
      .map(parseOpenCodeSqliteSessionRow)
      .filter((candidate): candidate is TeleportSessionCandidate => candidate !== undefined);
  } catch {
    return [];
  } finally {
    db.close();
  }
}

function latestTimestamp(left: string | undefined, right: string | undefined): string | undefined {
  if (!left) return right;
  if (!right) return left;
  const leftTime = millisFromIso(left) ?? 0;
  const rightTime = millisFromIso(right) ?? 0;
  return rightTime > leftTime ? right : left;
}

function mergeOpenCodeSessionCandidates(
  candidates: ReadonlyArray<TeleportSessionCandidate>,
): TeleportSessionCandidate[] {
  const byId = new Map<string, TeleportSessionCandidate>();
  for (const candidate of candidates) {
    const existing = byId.get(candidate.externalSessionId);
    if (!existing) {
      byId.set(candidate.externalSessionId, candidate);
      continue;
    }
    byId.set(candidate.externalSessionId, {
      ...candidate,
      ...existing,
      title: existing.title ?? candidate.title,
      createdAt: existing.createdAt ?? candidate.createdAt,
      updatedAt: latestTimestamp(existing.updatedAt, candidate.updatedAt),
    });
  }
  return [...byId.values()];
}

async function discoverOpenCodeSessions(homeDir: string): Promise<TeleportSessionCandidate[]> {
  const root = path.join(homeDir, ".local", "share", "opencode", "storage", "session");
  const files = await walkFiles(root, (filePath) => filePath.endsWith(".json"));
  const [sqliteCandidates, metadataParsed, messageCandidates] = await Promise.all([
    discoverOpenCodeSqliteSessions(homeDir),
    Promise.all(files.map((filePath) => parseOpenCodeSession(filePath))),
    discoverOpenCodeMessageSessions(homeDir),
  ]);
  const metadataCandidates = metadataParsed.filter(
    (candidate): candidate is TeleportSessionCandidate => candidate !== undefined,
  );
  return mergeOpenCodeSessionCandidates([
    ...sqliteCandidates,
    ...metadataCandidates,
    ...messageCandidates,
  ]);
}

async function parseCursorAcpSession(
  sessionId: string,
  metaPath: string,
): Promise<TeleportSessionCandidate | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(metaPath, "utf8"));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) {
    return undefined;
  }
  const cwd = nonEmptyString(parsed.cwd);
  if (!cwd) {
    return undefined;
  }
  const stat = await fs.stat(metaPath).catch(() => undefined);
  return {
    provider: CURSOR_PROVIDER,
    providerInstanceId: defaultInstanceIdForDriver(CURSOR_PROVIDER),
    externalSessionId: sessionId,
    cwd,
    ...(nonEmptyString(parsed.title) ? { title: nonEmptyString(parsed.title) } : {}),
    availability: "unknown",
    updatedAt: stat ? stat.mtime.toISOString() : undefined,
  };
}

async function discoverCursorSessions(homeDir: string): Promise<TeleportSessionCandidate[]> {
  const root = path.join(homeDir, ".cursor", "acp-sessions");
  if (!(await pathExists(root))) {
    return [];
  }
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const parsed = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => parseCursorAcpSession(entry.name, path.join(root, entry.name, "meta.json"))),
  );
  return parsed.filter(
    (candidate): candidate is TeleportSessionCandidate => candidate !== undefined,
  );
}

function shouldDiscoverProvider(
  provider: (typeof TELEPORT_DISCOVERY_PROVIDERS)[number],
  input: TeleportListSessionsInput | undefined,
): boolean {
  return input?.providers === undefined || input.providers.includes(provider);
}

export function sortTeleportSessionCandidates(
  sessions: ReadonlyArray<TeleportSessionCandidate>,
): TeleportSessionCandidate[] {
  return sessions.toSorted((left, right) => {
    const leftTime = left.updatedAt ? Date.parse(left.updatedAt) : 0;
    const rightTime = right.updatedAt ? Date.parse(right.updatedAt) : 0;
    if (leftTime !== rightTime) return rightTime - leftTime;
    return left.externalSessionId.localeCompare(right.externalSessionId);
  });
}

export async function discoverTeleportSessions(
  options: TeleportDiscoveryOptions = {},
): Promise<TeleportSessionCandidate[]> {
  const homeDir = options.homeDir ?? os.homedir();
  const batches = await Promise.all([
    shouldDiscoverProvider(CODEX_PROVIDER, options.input) ? discoverCodexSessions(homeDir) : [],
    shouldDiscoverProvider(OPENCODE_PROVIDER, options.input)
      ? discoverOpenCodeSessions(homeDir)
      : [],
    shouldDiscoverProvider(CURSOR_PROVIDER, options.input) ? discoverCursorSessions(homeDir) : [],
  ]);
  const byProviderSession = new Map<string, TeleportSessionCandidate>();
  for (const session of batches.flat()) {
    byProviderSession.set(`${session.provider}:${session.externalSessionId}`, session);
  }
  return sortTeleportSessionCandidates([...byProviderSession.values()]);
}
