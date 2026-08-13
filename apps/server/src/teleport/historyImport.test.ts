// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { ProviderDriverKind } from "@t3tools/contracts";
import { readTeleportHistory } from "./historyImport.ts";

async function makeHome(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "t3-teleport-history-"));
}

async function writeOpenCodeMessage(input: {
  readonly home: string;
  readonly sessionId: string;
  readonly messageId: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly created?: number;
}) {
  const messageRoot = path.join(
    input.home,
    ".local",
    "share",
    "opencode",
    "storage",
    "message",
    input.sessionId,
  );
  await fs.mkdir(messageRoot, { recursive: true });
  await fs.writeFile(
    path.join(messageRoot, `${input.messageId}.json`),
    JSON.stringify({
      id: input.messageId,
      sessionID: input.sessionId,
      role: input.role,
      ...(input.created ? { time: { created: input.created } } : {}),
    }),
  );
  const partRoot = path.join(
    input.home,
    ".local",
    "share",
    "opencode",
    "storage",
    "part",
    input.messageId,
  );
  await fs.mkdir(partRoot, { recursive: true });
  await fs.writeFile(
    path.join(partRoot, `${input.messageId}-part.json`),
    JSON.stringify({
      id: `${input.messageId}-part`,
      type: "text",
      text: input.text,
    }),
  );
}

describe("readTeleportHistory", () => {
  it("reads user and assistant messages from a Codex JSONL session", async () => {
    const home = await makeHome();
    const sessionDir = path.join(home, ".codex", "sessions", "2026", "05", "25");
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, "rollout-codex-history-session-1.jsonl"),
      [
        JSON.stringify({
          timestamp: "2026-05-25T12:00:00.000Z",
          type: "session_meta",
          payload: { id: "codex-history-session-1", cwd: "/tmp/project" },
        }),
        JSON.stringify({
          timestamp: "2026-05-25T12:01:00.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Original CLI request" }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-25T12:02:00.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Original Codex answer" }],
          },
        }),
      ].join("\n"),
    );

    await expect(
      readTeleportHistory({
        homeDir: home,
        provider: ProviderDriverKind.make("codex"),
        externalSessionId: "codex-history-session-1",
      }),
    ).resolves.toEqual([
      {
        role: "user",
        text: "Original CLI request",
        createdAt: "2026-05-25T12:01:00.000Z",
      },
      {
        role: "assistant",
        text: "Original Codex answer",
        createdAt: "2026-05-25T12:02:00.000Z",
      },
    ]);
  });

  it("reads OpenCode message parts by session id", async () => {
    const home = await makeHome();
    const sessionId = "ses_history";
    const messageRoot = path.join(
      home,
      ".local",
      "share",
      "opencode",
      "storage",
      "message",
      sessionId,
    );
    await fs.mkdir(messageRoot, { recursive: true });
    await fs.writeFile(
      path.join(messageRoot, "msg_user.json"),
      JSON.stringify({
        id: "msg_user",
        sessionID: sessionId,
        role: "user",
        time: { created: 1_779_705_600_000 },
      }),
    );
    await fs.writeFile(
      path.join(messageRoot, "msg_assistant.json"),
      JSON.stringify({
        id: "msg_assistant",
        sessionID: sessionId,
        role: "assistant",
        time: { created: 1_779_705_660_000 },
      }),
    );
    await fs.mkdir(path.join(home, ".local", "share", "opencode", "storage", "part", "msg_user"), {
      recursive: true,
    });
    await fs.mkdir(
      path.join(home, ".local", "share", "opencode", "storage", "part", "msg_assistant"),
      { recursive: true },
    );
    await fs.writeFile(
      path.join(
        home,
        ".local",
        "share",
        "opencode",
        "storage",
        "part",
        "msg_user",
        "prt_user.json",
      ),
      JSON.stringify({
        id: "prt_user",
        type: "text",
        text: JSON.stringify("Original OpenCode request"),
      }),
    );
    await fs.writeFile(
      path.join(
        home,
        ".local",
        "share",
        "opencode",
        "storage",
        "part",
        "msg_assistant",
        "prt_assistant.json",
      ),
      JSON.stringify({
        id: "prt_assistant",
        type: "text",
        text: "Original OpenCode answer",
      }),
    );

    await expect(
      readTeleportHistory({
        homeDir: home,
        provider: ProviderDriverKind.make("opencode"),
        externalSessionId: sessionId,
      }),
    ).resolves.toEqual([
      {
        role: "user",
        text: "Original OpenCode request",
        createdAt: "2026-05-25T10:40:00.000Z",
      },
      {
        role: "assistant",
        text: "Original OpenCode answer",
        createdAt: "2026-05-25T10:41:00.000Z",
      },
    ]);
  });

  it("sorts OpenCode history deterministically when some timestamps are missing", async () => {
    const home = await makeHome();
    const sessionId = "ses_partial_timestamps";
    await writeOpenCodeMessage({
      home,
      sessionId,
      messageId: "msg_no_time",
      role: "assistant",
      text: "Undated answer",
    });
    await writeOpenCodeMessage({
      home,
      sessionId,
      messageId: "msg_user",
      role: "user",
      text: "Dated request",
      created: 1_779_705_600_000,
    });

    await expect(
      readTeleportHistory({
        homeDir: home,
        provider: ProviderDriverKind.make("opencode"),
        externalSessionId: sessionId,
      }),
    ).resolves.toMatchObject([
      { role: "user", text: "Dated request" },
      { role: "assistant", text: "Undated answer" },
    ]);
  });

  it("keeps truncated provider history within the total character budget", async () => {
    const home = await makeHome();
    const sessionId = "ses_large_history";
    for (let index = 0; index < 6; index += 1) {
      await writeOpenCodeMessage({
        home,
        sessionId,
        messageId: `msg_${index}`,
        role: index % 2 === 0 ? "user" : "assistant",
        text: "x".repeat(30_000),
        created: 1_779_705_600_000 + index,
      });
    }

    const history = await readTeleportHistory({
      homeDir: home,
      provider: ProviderDriverKind.make("opencode"),
      externalSessionId: sessionId,
    });
    const totalChars = history.reduce((sum, message) => sum + message.text.length, 0);

    expect(totalChars).toBeLessThanOrEqual(100_000);
  });
});
