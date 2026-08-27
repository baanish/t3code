import { TeleportThreadState } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));
const decodeTeleportJson = Schema.decodeUnknownSync(Schema.fromJsonString(TeleportThreadState));
const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const TELEPORT_PAYLOAD = encodeUnknownJson({
  teleport: {
    presence: "t3",
    lastSyncDirection: "import",
    externalSessionId: "session-1",
    nativePath: "/tmp/native",
    lastSyncedAt: "2026-08-14T22:00:00.000Z",
  },
});

layer("044_ProjectionThreadsTeleport", (it) => {
  it.effect("backfills only schema-valid TeleportProvider rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 43 });

      for (const [threadId, providerName] of [
        ["thread-codex", "codex"],
        ["thread-claude", "claudeAgent"],
        ["thread-opencode", "opencode"],
        ["thread-grok", "grok"],
      ] as const) {
        yield* sql`
          INSERT INTO projection_threads (
            thread_id,
            project_id,
            title,
            model_selection_json,
            runtime_mode,
            interaction_mode,
            pending_approval_count,
            pending_user_input_count,
            has_actionable_proposed_plan,
            created_at,
            updated_at,
            deleted_at
          )
          VALUES (
            ${threadId},
            ${"project-1"},
            ${threadId},
            ${'{"provider":"codex","model":"gpt-5-codex"}'},
            ${"full-access"},
            ${"default"},
            0,
            0,
            0,
            ${"2026-08-14T00:00:00.000Z"},
            ${"2026-08-14T00:00:00.000Z"},
            NULL
          )
        `;
        yield* sql`
          INSERT INTO provider_session_runtime (
            thread_id,
            provider_name,
            adapter_key,
            runtime_mode,
            status,
            last_seen_at,
            runtime_payload_json
          )
          VALUES (
            ${threadId},
            ${providerName},
            ${providerName},
            ${"full-access"},
            ${"stopped"},
            ${"2026-08-14T22:00:00.000Z"},
            ${TELEPORT_PAYLOAD}
          )
        `;
      }

      yield* runMigrations({ toMigrationInclusive: 44 });

      const rows = yield* sql<{
        readonly threadId: string;
        readonly teleportJson: string | null;
      }>`
        SELECT
          thread_id AS "threadId",
          teleport_json AS "teleportJson"
        FROM projection_threads
        ORDER BY thread_id
      `;

      const byThread = Object.fromEntries(rows.map((row) => [row.threadId, row.teleportJson]));

      assert.ok(byThread["thread-codex"]);
      const codexTeleport = decodeTeleportJson(byThread["thread-codex"]);
      assert.equal(codexTeleport.provider, "codex");
      assert.equal(codexTeleport.presence, "t3");
      assert.equal(codexTeleport.externalSessionId, "session-1");

      assert.ok(byThread["thread-claude"]);
      const claudeTeleport = decodeTeleportJson(byThread["thread-claude"]);
      assert.equal(claudeTeleport.provider, "claudeAgent");
      assert.equal(claudeTeleport.presence, "t3");

      assert.equal(byThread["thread-opencode"], null);
      assert.equal(byThread["thread-grok"], null);
    }),
  );
});
