import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Backfill `projection_threads.teleport_json` from provider runtime payloads.
 *
 * `TeleportProvider` is only `"codex" | "claudeAgent"`. Unsupported
 * `provider_name` values (including leftover `opencode` / `grok` bindings)
 * are skipped so snapshot decode cannot fail on an invalid provider literal.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "teleport_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN teleport_json TEXT
    `;
  }

  yield* sql`
    UPDATE projection_threads
    SET
      teleport_json = (
        SELECT
          json_object(
            'presence',
            CASE
              WHEN json_extract(runtime.runtime_payload_json, '$.teleport.presence') IS NOT NULL THEN json_extract(
                runtime.runtime_payload_json,
                '$.teleport.presence'
              )
              WHEN json_extract(runtime.runtime_payload_json, '$.teleport.lastSyncDirection') = 'export' THEN 'native'
              ELSE 't3'
            END,
            'provider',
            runtime.provider_name,
            'externalSessionId',
            json_extract(runtime.runtime_payload_json, '$.teleport.externalSessionId'),
            'nativePath',
            json_extract(runtime.runtime_payload_json, '$.teleport.nativePath'),
            'lastSyncedAt',
            json_extract(runtime.runtime_payload_json, '$.teleport.lastSyncedAt')
          )
        FROM provider_session_runtime AS runtime
        WHERE
          runtime.thread_id = projection_threads.thread_id
          AND runtime.provider_name IN ('codex', 'claudeAgent')
          AND json_extract(runtime.runtime_payload_json, '$.teleport.externalSessionId') IS NOT NULL
          AND json_extract(runtime.runtime_payload_json, '$.teleport.nativePath') IS NOT NULL
          AND json_extract(runtime.runtime_payload_json, '$.teleport.lastSyncedAt') IS NOT NULL
      )
    WHERE
      teleport_json IS NULL
      AND EXISTS (
        SELECT
          1
        FROM provider_session_runtime AS runtime
        WHERE
          runtime.thread_id = projection_threads.thread_id
          AND runtime.provider_name IN ('codex', 'claudeAgent')
          AND json_extract(runtime.runtime_payload_json, '$.teleport.externalSessionId') IS NOT NULL
          AND json_extract(runtime.runtime_payload_json, '$.teleport.nativePath') IS NOT NULL
          AND json_extract(runtime.runtime_payload_json, '$.teleport.lastSyncedAt') IS NOT NULL
      )
  `;
});
