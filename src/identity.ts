/**
 * Per-user identity, client-minted. No auth; the userId is the capability.
 * Sharing the /user/<id> URL = sharing the agent.
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
 * Resolve the user's ID. If the caller passes `fromUrl` (extracted from the
 * pathname), that wins and is persisted to localStorage. Otherwise return
 * the stored ID, or mint a new UUIDv4 on first visit.
 */
export function getOrMintUserId(fromUrl?: string | null): string {
  if (fromUrl) {
    localStorage.setItem(USER_ID_KEY, fromUrl);
    return fromUrl;
  }
  const stored = localStorage.getItem(USER_ID_KEY);
  if (stored) return stored;
  const minted = crypto.randomUUID();
  localStorage.setItem(USER_ID_KEY, minted);
  return minted;
}
