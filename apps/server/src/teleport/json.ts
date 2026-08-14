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

export function parseJsonObject(raw: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return isRecord(parsed) ? parsed : undefined;
}

export function collectTextParts(content: unknown): string | undefined {
  if (typeof content === "string") {
    return nonEmptyString(content);
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const parts: string[] = [];
  for (const part of content) {
    if (!isRecord(part)) {
      continue;
    }
    const text = nonEmptyString(part.text);
    if (text) {
      parts.push(text);
    }
  }
  return nonEmptyString(parts.join("\n"));
}

export function truncateTitle(input: string): string {
  const normalized = input.replace(/\s+/gu, " ").trim();
  if (normalized.length <= 80) {
    return normalized;
  }
  return `${normalized.slice(0, 77).trimEnd()}...`;
}

export function firstUserTitle(
  messages: ReadonlyArray<{ role: string; text: string }>,
): string | undefined {
  for (const message of messages) {
    if (message.role !== "user") {
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
  return filePath.match(UUID_RE)?.[0]?.toLowerCase();
}
