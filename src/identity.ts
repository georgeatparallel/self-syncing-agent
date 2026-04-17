/**
 * Per-user identity, client-minted. No auth; the userId is the capability.
 *
 * Storage semantics: localStorage holds THIS visitor's own minted userId,
 * nothing else. Visiting a /user/<other> shared link lets you view that
 * other agent for the session (React prefers the URL when present) but
 * does NOT overwrite your own stored identity. Navigate to / to return to
 * your own agent.
 */

export const USER_ID_KEY = "self-syncing-agent:user-id";

/**
 * Extract a userId from a pathname like `/user/:id`.
 * Returns null for any path that does not match exactly.
 */
export function userIdFromPath(pathname: string): string | null {
  const trimmed = pathname.replace(/\/+$/, "");
  const match = trimmed.match(/^\/user\/([^/]+)$/);
  return match ? match[1] : null;
}

/**
 * Build the canonical URL path for a userId.
 */
export function userPath(userId: string): string {
  return `/user/${userId}`;
}

/**
 * Return the visitor's own persisted userId, minting and storing a new
 * UUIDv4 on first visit. Does NOT read from the URL — that's the React
 * layer's job. This function is purely about "who am I (the visitor)."
 */
export function getOrMintUserId(): string {
  const stored = localStorage.getItem(USER_ID_KEY);
  if (stored) return stored;
  const minted = crypto.randomUUID();
  localStorage.setItem(USER_ID_KEY, minted);
  return minted;
}
