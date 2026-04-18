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
