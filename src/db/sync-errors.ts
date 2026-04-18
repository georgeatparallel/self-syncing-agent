import type { SyncError, NewSyncError, SyncErrorStat, SqlTag } from "./types";

export function logSyncError(sql: SqlTag, input: NewSyncError): void {
  sql`
    INSERT INTO sync_errors (
      sync_id, occurred_at, payload_preview, error_message,
      stack_trace, handler_version
    ) VALUES (
      ${input.sync_id}, ${Date.now()},
      ${input.payload_preview ?? null},
      ${input.error_message},
      ${input.stack_trace ?? null},
      ${input.handler_version}
    )
  `;
}

export function listSyncErrors(
  sql: SqlTag,
  syncId: string,
  limit: number = 20
): SyncError[] {
  return sql<SyncError>`
    SELECT * FROM sync_errors
    WHERE sync_id = ${syncId}
    ORDER BY occurred_at DESC
    LIMIT ${limit}
  `;
}

/**
 * Fetch the most recent sync_errors rows for a sync, newest first. Used
 * by the ops-panel details endpoint. Similar to `listSyncErrors` but
 * callers expecting plan-phrased naming can use this entry point; the
 * SQL ordering matches `listSyncErrors` (by `occurred_at DESC`).
 */
export function getRecentSyncErrors(
  sql: SqlTag,
  sync_id: string,
  limit: number
): SyncError[] {
  return sql<SyncError>`
    SELECT * FROM sync_errors
    WHERE sync_id = ${sync_id}
    ORDER BY occurred_at DESC
    LIMIT ${limit}
  `;
}

export function getSyncErrorStats(
  sql: SqlTag,
  sinceMs: number
): SyncErrorStat[] {
  return sql<SyncErrorStat>`
    SELECT
      sync_id,
      COUNT(*) as error_count,
      MAX(occurred_at) as last_occurred_at,
      (
        SELECT error_message FROM sync_errors s2
        WHERE s2.sync_id = s1.sync_id AND s2.occurred_at >= ${sinceMs}
        ORDER BY occurred_at DESC, id DESC LIMIT 1
      ) as last_error_message
    FROM sync_errors s1
    WHERE occurred_at >= ${sinceMs}
    GROUP BY sync_id
    ORDER BY last_occurred_at DESC
  `;
}
