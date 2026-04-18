import type { ModelMessage } from "ai";
import { listSyncs } from "../db/syncs";
import { getSyncErrorStats } from "../db/sync-errors";
import type { Sync, SyncErrorStat, SqlTag } from "../db/types";

const ERROR_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const ERROR_MESSAGE_TRUNCATE = 160;

/**
 * Build the two ambient context messages injected before the chat
 * history on every turn. Both tags are present every turn — empty
 * state is conveyed by a clear stub message rather than omitting the
 * block, so the agent can always rely on their presence.
 */
export function buildContextMessages(sql: SqlTag): ModelMessage[] {
  const syncs = listSyncs(sql);
  const errorStats = getSyncErrorStats(sql, Date.now() - ERROR_WINDOW_MS);
  return [
    { role: "user", content: formatActiveSyncs(syncs) },
    { role: "user", content: formatSyncErrors(errorStats) }
  ];
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
