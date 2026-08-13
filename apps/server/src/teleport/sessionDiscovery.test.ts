// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { ProviderDriverKind } from "@t3tools/contracts";
import { discoverTeleportSessions } from "./sessionDiscovery.ts";

async function makeHome(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "t3-teleport-discovery-"));
}

function makeOpenCodeDatabase(home: string): DatabaseSync {
  const dbPath = path.join(home, ".local", "share", "opencode", "opencode.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE project (
      id text PRIMARY KEY,
      worktree text NOT NULL,
      time_created integer NOT NULL,
      time_updated integer NOT NULL,
      sandboxes text NOT NULL
    );
    CREATE TABLE session (
      id text PRIMARY KEY,
      project_id text NOT NULL,
      directory text NOT NULL,
      title text NOT NULL,
      time_created integer NOT NULL,
      time_updated integer NOT NULL,
      time_archived integer,
      model text
    );
    CREATE TABLE message (
      id text PRIMARY KEY,
      session_id text NOT NULL,
      time_created integer NOT NULL,
      time_updated integer NOT NULL,
      data text NOT NULL
    );
    CREATE TABLE part (
      id text PRIMARY KEY,
      message_id text NOT NULL,
      session_id text NOT NULL,
      time_created integer NOT NULL,
      time_updated integer NOT NULL,
      data text NOT NULL
    );
  `);
  return db;
}

describe("discoverTeleportSessions", () => {
  it("discovers Codex sessions from JSONL metadata", async () => {
    const home = await makeHome();
    const sessionDir = path.join(home, ".codex", "sessions", "2026", "05", "25");
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      path.join(
        sessionDir,
        "rollout-2026-05-25T12-00-00-019e5e6e-6a3f-7b90-bb41-7bf17abf0e14.jsonl",
      ),
      [
        JSON.stringify({
          timestamp: "2026-05-25T12:00:00.000Z",
          type: "session_meta",
          payload: {
            id: "019e5e6e-6a3f-7b90-bb41-7bf17abf0e14",
            cwd: "/tmp/codex-project",
            timestamp: "2026-05-25T12:00:00.000Z",
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-25T12:01:00.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Fix the teleport importer" }],
          },
        }),
      ].join("\n"),
    );

    const sessions = await discoverTeleportSessions({ homeDir: home });

    expect(sessions).toContainEqual(
      expect.objectContaining({
        provider: "codex",
        providerInstanceId: "codex",
        externalSessionId: "019e5e6e-6a3f-7b90-bb41-7bf17abf0e14",
        cwd: "/tmp/codex-project",
        title: "Fix the teleport importer",
        availability: "stopped",
      }),
    );
  });

  it("derives Codex titles from the user request instead of injected AGENTS context", async () => {
    const home = await makeHome();
    const sessionDir = path.join(home, ".codex", "sessions", "2026", "05", "25");
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, "rollout-codex-context-heavy.jsonl"),
      [
        JSON.stringify({
          timestamp: "2026-05-25T12:00:00.000Z",
          type: "session_meta",
          payload: {
            id: "codex-context-heavy",
            cwd: "/tmp/codex-project",
            timestamp: "2026-05-25T12:00:00.000Z",
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-25T12:01:00.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: [
                  "# AGENTS.md instructions for /Volumes/Delos/Development/pingdotgg/t3code",
                  "",
                  "<INSTRUCTIONS>",
                  "Use the project conventions.",
                  "</INSTRUCTIONS>",
                  "",
                  "# Files mentioned by the user:",
                  "",
                  "## CleanShot 2026-05-25 at 13.44.27@2x.png: /tmp/screenshot.png",
                  "",
                  "## My request for Codex:",
                  "Improve Teleport session titles.",
                  "<image name=[Image #1]>",
                ].join("\n"),
              },
            ],
          },
        }),
      ].join("\n"),
    );

    const sessions = await discoverTeleportSessions({ homeDir: home });

    expect(sessions).toContainEqual(
      expect.objectContaining({
        externalSessionId: "codex-context-heavy",
        title: "Improve Teleport session titles.",
      }),
    );
  });

  it("skips injected Codex context messages before deriving a title", async () => {
    const home = await makeHome();
    const sessionDir = path.join(home, ".codex", "sessions", "2026", "05", "25");
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, "rollout-codex-context-only-first.jsonl"),
      [
        JSON.stringify({
          timestamp: "2026-05-25T12:00:00.000Z",
          type: "session_meta",
          payload: {
            id: "codex-context-only-first",
            cwd: "/tmp/codex-project",
            timestamp: "2026-05-25T12:00:00.000Z",
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-25T12:01:00.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: [
                  "# AGENTS.md instructions for /Volumes/Delos/Development/Garbage",
                  "",
                  "<INSTRUCTIONS>",
                  "# Codex Global Instructions",
                  "",
                  "## PR Quality Bar",
                  "",
                  "PRs must be minimal and tightly scoped.",
                  "</INSTRUCTIONS>",
                  "<environment_context>",
                  "  <cwd>/Volumes/Delos/Development/Garbage</cwd>",
                  "</environment_context>",
                ].join("\n"),
              },
            ],
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-25T12:02:00.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: "I'm testing something. Make a quick LeetCode easy project.",
              },
            ],
          },
        }),
      ].join("\n"),
    );

    const sessions = await discoverTeleportSessions({ homeDir: home });

    expect(sessions).toContainEqual(
      expect.objectContaining({
        externalSessionId: "codex-context-only-first",
        title: "I'm testing something. Make a quick LeetCode easy project.",
      }),
    );
  });

  it("sorts Codex sessions by latest activity after the title has been discovered", async () => {
    const home = await makeHome();
    const sessionDir = path.join(home, ".codex", "sessions", "2026", "05", "25");
    await fs.mkdir(sessionDir, { recursive: true });
    const laterActivityPath = path.join(sessionDir, "rollout-codex-later-activity.jsonl");
    await fs.writeFile(
      laterActivityPath,
      [
        JSON.stringify({
          timestamp: "2026-05-25T12:00:00.000Z",
          type: "session_meta",
          payload: {
            id: "codex-later-activity",
            cwd: "/tmp/codex-project",
            timestamp: "2026-05-25T12:00:00.000Z",
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-25T12:01:00.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Start the Codex task" }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-25T14:00:00.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Finished later work" }],
          },
        }),
      ].join("\n"),
    );
    const laterActivitySeconds = Date.parse("2026-05-25T14:00:00.000Z") / 1_000;
    await fs.utimes(laterActivityPath, laterActivitySeconds, laterActivitySeconds);
    const middleActivityPath = path.join(sessionDir, "rollout-codex-middle-activity.jsonl");
    await fs.writeFile(
      middleActivityPath,
      [
        JSON.stringify({
          timestamp: "2026-05-25T13:00:00.000Z",
          type: "session_meta",
          payload: {
            id: "codex-middle-activity",
            cwd: "/tmp/codex-project",
            timestamp: "2026-05-25T13:00:00.000Z",
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-25T13:01:00.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Start a newer-looking Codex task" }],
          },
        }),
      ].join("\n"),
    );
    const middleActivitySeconds = Date.parse("2026-05-25T13:01:00.000Z") / 1_000;
    await fs.utimes(middleActivityPath, middleActivitySeconds, middleActivitySeconds);

    const sessions = await discoverTeleportSessions({ homeDir: home });

    expect(sessions.slice(0, 2).map((session) => session.externalSessionId)).toEqual([
      "codex-later-activity",
      "codex-middle-activity",
    ]);
    expect(sessions[0]?.updatedAt).toBe("2026-05-25T14:00:00.000Z");
  });

  it("discovers OpenCode and Cursor session metadata", async () => {
    const home = await makeHome();
    await fs.mkdir(
      path.join(home, ".local", "share", "opencode", "storage", "session", "project-1"),
      { recursive: true },
    );
    await fs.writeFile(
      path.join(
        home,
        ".local",
        "share",
        "opencode",
        "storage",
        "session",
        "project-1",
        "ses_1a1915268ffedTT62Wp32wLxOd.json",
      ),
      JSON.stringify({
        id: "ses_1a1915268ffedTT62Wp32wLxOd",
        directory: "/tmp/opencode-project",
        title: "OpenCode import QA",
        time: {
          created: 1_779_705_600_000,
          updated: 1_779_705_660_000,
        },
      }),
    );

    await fs.mkdir(path.join(home, ".cursor", "acp-sessions", "cursor-session-1"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(home, ".cursor", "acp-sessions", "cursor-session-1", "meta.json"),
      JSON.stringify({
        schemaVersion: 1,
        cwd: "/tmp/cursor-project",
        title: "Cursor import QA",
      }),
    );

    const sessions = await discoverTeleportSessions({ homeDir: home });

    expect(sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "opencode",
          externalSessionId: "ses_1a1915268ffedTT62Wp32wLxOd",
          cwd: "/tmp/opencode-project",
          title: "OpenCode import QA",
        }),
        expect.objectContaining({
          provider: "cursor",
          externalSessionId: "cursor-session-1",
          cwd: "/tmp/cursor-project",
          title: "Cursor import QA",
        }),
      ]),
    );
  });

  it("discovers recent OpenCode sessions from the SQLite store before legacy JSON sessions", async () => {
    const home = await makeHome();
    await fs.mkdir(path.join(home, ".local", "share", "opencode"), { recursive: true });
    await fs.mkdir(path.join(home, ".local", "share", "opencode", "storage", "session", "global"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(
        home,
        ".local",
        "share",
        "opencode",
        "storage",
        "session",
        "global",
        "ses_legacy_acp.json",
      ),
      JSON.stringify({
        id: "ses_legacy_acp",
        directory: "/tmp/legacy-opencode-project",
        title: "ACP Session stale",
        time: {
          created: 1_779_705_600_000,
          updated: 1_779_705_660_000,
        },
      }),
    );
    const db = makeOpenCodeDatabase(home);
    try {
      db.prepare(
        "INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES (?, ?, ?, ?, ?)",
      ).run("global", "/", 1_779_800_000_000, 1_779_800_000_000, "[]");
      db.prepare(
        "INSERT INTO session (id, project_id, directory, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(
        "ses_recent_sqlite",
        "global",
        "/tmp/recent-opencode-project",
        "New session - 2026-05-25T17:41:56.432Z",
        1_779_800_000_000,
        1_779_800_600_000,
      );
      db.prepare(
        "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
      ).run(
        "msg_recent_user",
        "ses_recent_sqlite",
        1_779_800_000_100,
        1_779_800_000_100,
        JSON.stringify({ role: "user" }),
      );
      db.prepare(
        "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(
        "prt_recent_user",
        "msg_recent_user",
        "ses_recent_sqlite",
        1_779_800_000_200,
        1_779_800_000_200,
        JSON.stringify({ type: "text", text: "Build the SQLite-backed scanner" }),
      );
    } finally {
      db.close();
    }

    const sessions = await discoverTeleportSessions({ homeDir: home });

    expect(sessions.slice(0, 2).map((session) => session.externalSessionId)).toEqual([
      "ses_recent_sqlite",
      "ses_legacy_acp",
    ]);
    expect(sessions[0]).toEqual(
      expect.objectContaining({
        provider: "opencode",
        cwd: "/tmp/recent-opencode-project",
        title: "Build the SQLite-backed scanner",
        updatedAt: "2026-05-26T13:03:20.000Z",
      }),
    );
  });

  it("discovers OpenCode sessions from message storage when session metadata is absent", async () => {
    const home = await makeHome();
    const sessionId = "ses_message_only";
    const userMessageId = "msg_user";
    const assistantMessageId = "msg_assistant";
    await fs.mkdir(
      path.join(home, ".local", "share", "opencode", "storage", "message", sessionId),
      {
        recursive: true,
      },
    );
    await fs.mkdir(
      path.join(home, ".local", "share", "opencode", "storage", "part", userMessageId),
      {
        recursive: true,
      },
    );
    await fs.writeFile(
      path.join(
        home,
        ".local",
        "share",
        "opencode",
        "storage",
        "message",
        sessionId,
        `${userMessageId}.json`,
      ),
      JSON.stringify({
        id: userMessageId,
        sessionID: sessionId,
        role: "user",
        time: { created: 1_779_705_600_000 },
      }),
    );
    await fs.writeFile(
      path.join(
        home,
        ".local",
        "share",
        "opencode",
        "storage",
        "message",
        sessionId,
        `${assistantMessageId}.json`,
      ),
      JSON.stringify({
        id: assistantMessageId,
        sessionID: sessionId,
        role: "assistant",
        path: { cwd: "/tmp/opencode-message-project", root: "/" },
        time: { created: 1_779_705_660_000 },
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
        userMessageId,
        "prt_user.json",
      ),
      JSON.stringify({
        type: "text",
        text: JSON.stringify("Build the OpenCode scanner"),
      }),
    );

    const sessions = await discoverTeleportSessions({ homeDir: home });

    expect(sessions).toContainEqual(
      expect.objectContaining({
        provider: "opencode",
        providerInstanceId: "opencode",
        externalSessionId: sessionId,
        cwd: "/tmp/opencode-message-project",
        title: "Build the OpenCode scanner",
        availability: "stopped",
      }),
    );
  });

  it("honors provider filters", async () => {
    const home = await makeHome();
    await fs.mkdir(path.join(home, ".cursor", "acp-sessions", "cursor-session-1"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(home, ".cursor", "acp-sessions", "cursor-session-1", "meta.json"),
      JSON.stringify({ cwd: "/tmp/cursor-project" }),
    );

    const sessions = await discoverTeleportSessions({
      homeDir: home,
      input: { providers: [ProviderDriverKind.make("codex")] },
    });

    expect(sessions).toHaveLength(0);
  });
});
