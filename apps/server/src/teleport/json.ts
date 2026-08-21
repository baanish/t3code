export function definedField<K extends string, V>(
  key: K,
  value: V | undefined,
): Record<PropertyKey, never> | { readonly [P in K]: V } {
  if (value === undefined) {
    return {};
  }
  return { [key]: value } as { readonly [P in K]: V };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Message text from a native session. Empty-after-trim is skipped, but
 * leading/trailing whitespace on real content is preserved so export can
 * round-trip the original transcript.
 */
export function nativeSessionText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return value.trim().length > 0 ? value : undefined;
}

export function isSafeTeleportSessionId(value: string): boolean {
  if (value.length === 0 || value.length > 200) {
    return false;
  }
  if (value.includes("\0") || value.includes("/") || value.includes("\\")) {
    return false;
  }
  return value !== "." && value !== "..";
}

export function parseJsonObject(raw: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.startsWith("\uFEFF") ? raw.slice(1) : raw);
  } catch {
    return undefined;
  }
  return isRecord(parsed) ? parsed : undefined;
}

export function collectTextParts(content: unknown): string | undefined {
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
  return nativeSessionText(parts.join("\n"));
}

export function truncateTitle(input: string): string {
  const normalized = input.replace(/\s+/gu, " ").trim();
  if (normalized.length <= 80) {
    return normalized;
  }
  return `${normalized.slice(0, 77).trimEnd()}...`;
}

export function isSyntheticNativeUserText(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.startsWith("<environment_context>") ||
    trimmed.startsWith("<skills_instructions>") ||
    trimmed.startsWith("<permissions instructions>") ||
    trimmed.startsWith("<local-command-caveat>") ||
    trimmed.startsWith("<command-name>") ||
    trimmed.startsWith("<system-reminder>") ||
    trimmed.startsWith("<local-command-stdout>")
  );
}

export function firstUserTitle(
  messages: ReadonlyArray<{ role: string; text: string }>,
): string | undefined {
  for (const message of messages) {
    if (message.role !== "user") {
      continue;
    }
    if (isSyntheticNativeUserText(message.text)) {
      continue;
    }
    const line = message.text
      .split("\n")
      .map((entry) => entry.trim())
      .find((entry) => entry.length > 0);
    if (line) {
      return truncateTitle(line);
    }
  }
  return undefined;
}

export const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu;

export function uuidFromPath(filePath: string): string | undefined {
  const fileName = filePath.replaceAll("\\", "/").split("/").at(-1) ?? filePath;
  return fileName.match(UUID_RE)?.[0]?.toLowerCase();
}
