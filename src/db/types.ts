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

/**
 * Integration label stored on each sync row. Widened to `string` after
 * Phase D — the agent can now target any app slug reachable through
 * Pipedream Connect, and the value is free-form metadata rather than a
 * closed enum. Kept as a named alias for readability at call sites.
 */
export type Integration = string;

/**
 * Shape of `this.sql` exposed by the Cloudflare Agents SDK on the Agent
 * base class. Tagged template that returns an array of rows.
 *
 * This mirrors the SDK's internal `SqlTaggedTemplate` type at
 * node_modules/agents/dist/chat/index.d.ts:230 verbatim. That type is
 * defined without `export` ("Minimal SQL interface ... without depending
 * on the full Agent class" per the comment), so we cannot import it —
 * this is the best we can do until it's made public. If the SDK ever
 * diverges from the signature below, expect tsc to catch it where
 * `this.sql` is passed to the repo functions.
 *
 * Declared once and shared across all repo modules.
 */
export type SqlTag = <T = Record<string, unknown>>(
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

export interface ConnectedAccount {
  user_id: string;
  app_slug: string; // e.g., "github", "slack", "notion"
  account_id: string; // Pipedream's account id, e.g., "apn_XxxXxxx"
  connected_at: number; // Unix ms
}

export type NewConnectedAccount = ConnectedAccount;
