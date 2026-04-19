import type { ModelMessage } from "ai";
import { listConnectedAccounts } from "../db/connected-accounts";
import { listSyncs } from "../db/syncs";
import { getSyncErrorStats } from "../db/sync-errors";
import type {
  ConnectedAccount,
  Sync,
  SyncErrorStat,
  SqlTag
} from "../db/types";

const ERROR_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const ERROR_MESSAGE_TRUNCATE = 160;

/**
 * Build the three ambient context messages injected before the chat
 * history on every turn. All three tags are present every turn — empty
 * state is conveyed by a clear stub message rather than omitting the
 * block, so the agent can always rely on their presence.
 *
 * Block order matters: `<connected_accounts>` goes first so the agent
 * sees what integrations the user has linked BEFORE their syncs (which
 * reference those integrations by slug).
 */
export function buildContextMessages(
  sql: SqlTag,
  userId: string
): ModelMessage[] {
  const accounts = listConnectedAccounts(sql, userId);
  const syncs = listSyncs(sql);
  const errorStats = getSyncErrorStats(sql, Date.now() - ERROR_WINDOW_MS);
  return [
    { role: "user", content: formatConnectedAccounts(accounts) },
    { role: "user", content: formatActiveSyncs(syncs) },
    {
      role: "user",
      content: formatSyncErrors(errorStats),
      // Breakpoint b3: ambient context is stable across a chat session
      // in practice — sync creation and new errors arrive between
      // sessions, not mid-turn. Marking the trailing context block
      // caches `tools + system + context` as a single hit on most
      // follow-up turns. When it does invalidate, we pay one 25% write
      // and recover on the next request.
      providerOptions: {
        anthropic: { cacheControl: { type: "ephemeral" } }
      }
    }
  ];
}

export function formatConnectedAccounts(accounts: ConnectedAccount[]): string {
  if (accounts.length === 0) {
    return `<connected_accounts>No Pipedream integrations connected. The user must connect at least one app in the Connections panel before any handler's fetch() can succeed — the gateway will 403 with account_not_connected.</connected_accounts>`;
  }
  const rows = accounts.map((a) => `| ${a.app_slug} |`).join("\n");
  return `<connected_accounts>
These are the Pipedream app slugs available for handler fetch() calls. Set
header X-Pd-App: <slug> on each outbound fetch — the gateway uses this to
pick which user's OAuth token to inject via Pipedream Connect. Use the
slug exactly as listed; slugs not in this table will 403 account_not_connected.

| app_slug |
|---|
${rows}
</connected_accounts>`;
}

export function formatActiveSyncs(syncs: Sync[]): string {
  if (syncs.length === 0) {
    return "<active_syncs>No syncs registered yet.</active_syncs>";
  }
  const rows = syncs
    .map((s) => `| ${s.id} | ${s.name} | ${s.integration} |`)
    .join("\n");
  return `<active_syncs>
| sync_id | name | integration |
|---|---|---|
${rows}
</active_syncs>`;
}

export function formatSyncErrors(stats: SyncErrorStat[]): string {
  if (stats.length === 0) {
    return "<sync_errors>No recent errors (last hour).</sync_errors>";
  }
  const rows = stats
    .map((s) => {
      const msg = truncate(s.last_error_message, ERROR_MESSAGE_TRUNCATE);
      return `| ${s.sync_id} | ${s.error_count} | ${msg} |`;
    })
    .join("\n");
  return `<sync_errors>
| sync_id | errors_last_hour | last_error |
|---|---|---|
${rows}
</sync_errors>`;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}
