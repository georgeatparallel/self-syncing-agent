/**
 * Row shapes for the supervisor SQLite (per-user ChatAgent DO).
 *
 * `syncs` registers every agent-created sync and carries everything the
 * supervisor needs to route webhooks (webhook_secret, upstream_webhook_id)
 * and reload facet code on restart (code_id, handler_code).
 *
 * `sync_errors` captures handler runtime failures so the next chat turn's
 * ambient context can surface them to the agent for recovery.
 */

export type Integration = "linear" | "github";

/**
 * Shape of `this.sql` exposed by the Cloudflare Agents SDK on the Agent
 * base class. Tagged template that returns an array of rows. Narrowed
 * here to what SQLite-in-DO can actually bind: string | number | boolean | null.
 *
 * Declared once and shared across all repo modules; importing this from
 * src/db/types.ts keeps the three repo files in lockstep whenever the
 * SDK's signature drifts.
 */
export type SqlTag = <T = Record<string, string | number | boolean | null>>(
  strings: TemplateStringsArray,
  ...values: (string | number | boolean | null)[]
) => T[];

export interface Sync {
  id: string;
  name: string;
  integration: Integration;
  handler_code: string;
  schema_ddl: string;
  filter_description: string | null;
  webhook_secret: string;
  upstream_webhook_id: string | null;
  code_id: string;
  version: number;
  created_at: number;
  updated_at: number;
}

export interface NewSync {
  id: string;
  name: string;
  integration: Integration;
  handler_code: string;
  schema_ddl: string;
  filter_description?: string | null;
  webhook_secret: string;
  upstream_webhook_id?: string | null;
  code_id: string;
}

export interface SyncPatch {
  handler_code?: string;
  schema_ddl?: string;
  filter_description?: string | null;
  upstream_webhook_id?: string | null;
  code_id?: string;
  version?: number;
}

export interface SyncError {
  id: number;
  sync_id: string;
  occurred_at: number;
  payload_preview: string | null;
  error_message: string;
  stack_trace: string | null;
  handler_version: number;
}

export interface NewSyncError {
  sync_id: string;
  payload_preview?: string | null;
  error_message: string;
  stack_trace?: string | null;
  handler_version: number;
}

export interface SyncErrorStat {
  sync_id: string;
  error_count: number;
  last_error_message: string;
  last_occurred_at: number;
}
