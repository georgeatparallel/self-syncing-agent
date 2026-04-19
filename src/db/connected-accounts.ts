import type { ConnectedAccount, NewConnectedAccount, SqlTag } from "./types";

/**
 * Upsert a connected account. Composite primary key on (user_id, app_slug)
 * means re-connecting the same app overwrites the existing row — one
 * account per user per app in V1.
 */
export function upsertConnectedAccount(
  sql: SqlTag,
  input: NewConnectedAccount
): void {
  sql`
    INSERT OR REPLACE INTO connected_accounts (
      user_id, app_slug, account_id, connected_at
    ) VALUES (
      ${input.user_id}, ${input.app_slug},
      ${input.account_id}, ${input.connected_at}
    )
  `;
}

export function listConnectedAccounts(
  sql: SqlTag,
  user_id: string
): ConnectedAccount[] {
  return sql<ConnectedAccount>`
    SELECT * FROM connected_accounts
    WHERE user_id = ${user_id}
    ORDER BY connected_at DESC
  `;
}

/**
 * Look up a single connected account by (user_id, app_slug). Returns null
 * if the user hasn't linked that app. Used by the gateway's resolveEgress
 * RPC to pick the account_id for an outbound fetch's declared X-Pd-App
 * slug — per-fetch, on the hot path, so it's a targeted single-row query
 * rather than a full list + filter.
 */
export function getConnectedAccountBySlug(
  sql: SqlTag,
  userId: string,
  appSlug: string
): ConnectedAccount | null {
  const rows = sql<ConnectedAccount>`
    SELECT * FROM connected_accounts
    WHERE user_id = ${userId} AND app_slug = ${appSlug}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export function deleteConnectedAccount(
  sql: SqlTag,
  user_id: string,
  app_slug: string
): void {
  sql`
    DELETE FROM connected_accounts
    WHERE user_id = ${user_id} AND app_slug = ${app_slug}
  `;
}
