import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { runPersistenceMigrations } from "./migrator";
import { openPersistenceSqliteDatabase } from "./sqliteLayer";

describe("persistence sqlite layer", () => {
  test("opens sqlite database and runs migrations idempotently", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-persistence-sqlite-layer-"));
    const dbPath = path.join(dir, "state.sqlite");
    try {
      const db = openPersistenceSqliteDatabase(dbPath);
      try {
        runPersistenceMigrations(db);
        runPersistenceMigrations(db);

        db.prepare(
          "INSERT INTO metadata (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json;",
        ).run("app.settings.v1", JSON.stringify({ theme: "dark" }));

        const row = db.prepare("SELECT value_json FROM metadata WHERE key = ? LIMIT 1;").get(
          "app.settings.v1",
        ) as { value_json?: string } | undefined;
        expect(row?.value_json).toBe(JSON.stringify({ theme: "dark" }));
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
