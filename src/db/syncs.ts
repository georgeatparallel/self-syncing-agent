import type { Sync, NewSync, SyncPatch, SqlTag } from "./types";

/**
 * SQLite returns `api_hosts` as the raw JSON-encoded TEXT we stored. Every
 * caller wants `string[]`, so we decode once at the repo boundary. The row
 * type on the SELECT matches `Sync` with `api_hosts` widened to string —
 * kept local to avoid leaking the encoded shape into the public type.
 */
type SyncRow = Omit<Sync, "api_hosts"> & { api_hosts: string };

function decodeSync(row: SyncRow): Sync {
  let hosts: string[] = [];
  try {
    const parsed = JSON.parse(row.api_hosts);
    if (Array.isArray(parsed))
      hosts = parsed.filter((x) => typeof x === "string");
  } catch {
    // Corrupt JSON shouldn't brick the read; treat as empty allowlist so
    // the gateway denies everything rather than faulting the whole DO.
    hosts = [];
  }
  return { ...row, api_hosts: hosts };
}

export function createSync(sql: SqlTag, input: NewSync): Sync {
  const now = Date.now();
  const apiHosts = JSON.stringify(input.api_hosts ?? []);
  sql`
    INSERT INTO syncs (
      id, name, integration, handler_code, schema_ddl,
      filter_description, webhook_secret, upstream_webhook_id,
      code_id, version, api_hosts, created_at, updated_at
    ) VALUES (
      ${input.id}, ${input.name}, ${input.integration},
      ${input.handler_code}, ${input.schema_ddl},
      ${input.filter_description ?? null},
      ${input.webhook_secret},
      ${input.upstream_webhook_id ?? null},
      ${input.code_id}, 1, ${apiHosts}, ${now}, ${now}
    )
  `;
  const row = getSyncById(sql, input.id);
  if (!row)
    throw new Error(
      `createSync: insert did not persist row for id=${input.id}`
    );
  return row;
}

export function getSyncById(sql: SqlTag, id: string): Sync | null {
  const rows = sql<SyncRow>`SELECT * FROM syncs WHERE id = ${id}`;
  return rows[0] ? decodeSync(rows[0]) : null;
}

export function getSyncByName(sql: SqlTag, name: string): Sync | null {
  const rows = sql<SyncRow>`SELECT * FROM syncs WHERE name = ${name}`;
  return rows[0] ? decodeSync(rows[0]) : null;
}

export function listSyncs(sql: SqlTag): Sync[] {
  const rows = sql<SyncRow>`SELECT * FROM syncs ORDER BY created_at ASC`;
  return rows.map(decodeSync);
}

export function updateSync(sql: SqlTag, id: string, patch: SyncPatch): Sync {
  const existing = getSyncById(sql, id);
  if (!existing) throw new Error(`updateSync: no sync with id=${id}`);

  // api_hosts: `undefined` preserves, `[]` explicitly clears, `[hosts]`
  // replaces. Mirror the JSON-encode pattern from createSync so decodeSync
  // sees the same shape on read.
  const nextApiHosts =
    patch.api_hosts === undefined ? existing.api_hosts : patch.api_hosts;
  const apiHostsEncoded = JSON.stringify(nextApiHosts);

  const next: Sync = {
    ...existing,
    handler_code: patch.handler_code ?? existing.handler_code,
    schema_ddl: patch.schema_ddl ?? existing.schema_ddl,
    filter_description:
      patch.filter_description === undefined
        ? existing.filter_description
        : patch.filter_description,
    webhook_secret: patch.webhook_secret ?? existing.webhook_secret,
    upstream_webhook_id:
      patch.upstream_webhook_id === undefined
        ? existing.upstream_webhook_id
        : patch.upstream_webhook_id,
    code_id: patch.code_id ?? existing.code_id,
    version: patch.version ?? existing.version,
    api_hosts: nextApiHosts,
    updated_at: Date.now()
  };

  sql`
    UPDATE syncs SET
      handler_code = ${next.handler_code},
      schema_ddl = ${next.schema_ddl},
      filter_description = ${next.filter_description},
      webhook_secret = ${next.webhook_secret},
      upstream_webhook_id = ${next.upstream_webhook_id},
      code_id = ${next.code_id},
      version = ${next.version},
      api_hosts = ${apiHostsEncoded},
      updated_at = ${next.updated_at}
    WHERE id = ${id}
  `;

  const row = getSyncById(sql, id);
  if (!row) throw new Error(`updateSync: row vanished after update id=${id}`);
  return row;
}

export function deleteSync(sql: SqlTag, id: string): void {
  sql`DELETE FROM syncs WHERE id = ${id}`;
}

/**
 * Count sync_errors rows for a given sync since a ms-epoch cutoff. Used
 * by the ops-panel summary endpoint to surface a red badge when a sync
 * has produced errors in the last hour. The schema column is
 * `occurred_at`; the parameter name stays `sinceMs` to read cleanly at
 * the call site.
 */
export function getSyncErrorCountSince(
  sql: SqlTag,
  sync_id: string,
  sinceMs: number
): number {
  const rows = sql<{ c: number }>`
    SELECT COUNT(*) as c FROM sync_errors
    WHERE sync_id = ${sync_id} AND occurred_at >= ${sinceMs}
  `;
  return rows[0]?.c ?? 0;
}

/**
 * Touch the sync's `updated_at` to now. Called after every successful
 * webhook delivery so the ops-panel summary's relative timestamp reflects
 * actual activity (not just create_sync/update_sync calls). Cheap single-
 * row UPDATE on the supervisor SQLite — the facet is not involved.
 */
export function touchSyncUpdatedAt(sql: SqlTag, sync_id: string): void {
  sql`UPDATE syncs SET updated_at = ${Date.now()} WHERE id = ${sync_id}`;
}
