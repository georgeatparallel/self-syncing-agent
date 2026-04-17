import type { Sync, NewSync, SyncPatch } from "./types";

type SqlTag = <T = Record<string, string | number | boolean | null>>(
  strings: TemplateStringsArray,
  ...values: (string | number | boolean | null)[]
) => T[];

export function createSync(sql: SqlTag, input: NewSync): Sync {
  const now = Date.now();
  sql`
    INSERT INTO syncs (
      id, name, integration, handler_code, schema_ddl,
      filter_description, webhook_secret, upstream_webhook_id,
      code_id, version, created_at, updated_at
    ) VALUES (
      ${input.id}, ${input.name}, ${input.integration},
      ${input.handler_code}, ${input.schema_ddl},
      ${input.filter_description ?? null},
      ${input.webhook_secret},
      ${input.upstream_webhook_id ?? null},
      ${input.code_id}, 1, ${now}, ${now}
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
  const rows = sql<Sync>`SELECT * FROM syncs WHERE id = ${id}`;
  return rows[0] ?? null;
}

export function getSyncByName(sql: SqlTag, name: string): Sync | null {
  const rows = sql<Sync>`SELECT * FROM syncs WHERE name = ${name}`;
  return rows[0] ?? null;
}

export function listSyncs(sql: SqlTag): Sync[] {
  return sql<Sync>`SELECT * FROM syncs ORDER BY created_at ASC`;
}

export function updateSync(sql: SqlTag, id: string, patch: SyncPatch): Sync {
  const existing = getSyncById(sql, id);
  if (!existing) throw new Error(`updateSync: no sync with id=${id}`);

  const next: Sync = {
    ...existing,
    handler_code: patch.handler_code ?? existing.handler_code,
    schema_ddl: patch.schema_ddl ?? existing.schema_ddl,
    filter_description:
      patch.filter_description === undefined
        ? existing.filter_description
        : patch.filter_description,
    upstream_webhook_id:
      patch.upstream_webhook_id === undefined
        ? existing.upstream_webhook_id
        : patch.upstream_webhook_id,
    code_id: patch.code_id ?? existing.code_id,
    version: patch.version ?? existing.version,
    updated_at: Date.now()
  };

  sql`
    UPDATE syncs SET
      handler_code = ${next.handler_code},
      schema_ddl = ${next.schema_ddl},
      filter_description = ${next.filter_description},
      upstream_webhook_id = ${next.upstream_webhook_id},
      code_id = ${next.code_id},
      version = ${next.version},
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
