/**
 * Supervisor SQLite schema. Called by ChatAgent.onStart() — runs on every
 * DO wake-up. Idempotent via CREATE TABLE IF NOT EXISTS; safe to call any
 * number of times.
 *
 * When adding columns later (e.g., a V2 `connections` table or an extra
 * column on `syncs`), follow the Agents SDK convention of ALTER TABLE
 * with an `addColumnIfNotExists` guard rather than editing these CREATE
 * statements — existing DOs already have the old tables.
 */

import type { SqlTag } from "./types";

export function applySchemaMigrations(sql: SqlTag): void {
  sql`
    CREATE TABLE IF NOT EXISTS syncs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      integration TEXT NOT NULL,
      handler_code TEXT NOT NULL,
      schema_ddl TEXT NOT NULL,
      filter_description TEXT,
      webhook_secret TEXT NOT NULL,
      upstream_webhook_id TEXT,
      code_id TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `;

  sql`
    CREATE TABLE IF NOT EXISTS sync_errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sync_id TEXT NOT NULL,
      occurred_at INTEGER NOT NULL,
      payload_preview TEXT,
      error_message TEXT NOT NULL,
      stack_trace TEXT,
      handler_version INTEGER NOT NULL,
      FOREIGN KEY (sync_id) REFERENCES syncs(id) ON DELETE CASCADE
    )
  `;

  sql`
    CREATE INDEX IF NOT EXISTS idx_sync_errors_sync_id_occurred_at
      ON sync_errors(sync_id, occurred_at DESC)
  `;
}
