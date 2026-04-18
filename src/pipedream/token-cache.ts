import { getAccessToken } from "./api";

/**
 * Module-level cache of Pipedream bearer access_tokens, keyed on
 * PIPEDREAM_CLIENT_ID so multiple tenants / client configs don't collide
 * (even though V1 ships one workspace). Each CF Workers isolate gets
 * its own Map — cache misses are a single HTTP call, acceptable.
 *
 * Refresh threshold: 60 seconds before expiry. This avoids handing out
 * a token that expires mid-flight during an outbound proxy call.
 */
interface CachedEntry {
  token: string;
  /** Epoch ms when the cached token stops being usable (expiry minus safety margin). */
  usableUntilMs: number;
}

const REFRESH_MARGIN_MS = 60_000;

const cache = new Map<string, CachedEntry>();

export async function getCachedAccessToken(env: Env): Promise<string> {
  const key = env.PIPEDREAM_CLIENT_ID;
  const existing = cache.get(key);
  if (existing && existing.usableUntilMs > Date.now()) {
    return existing.token;
  }
  const fresh = await getAccessToken(env);
  cache.set(key, {
    token: fresh.accessToken,
    usableUntilMs:
      Date.now() + fresh.expiresInSeconds * 1000 - REFRESH_MARGIN_MS
  });
  return fresh.accessToken;
}

/** Test-only escape hatch. Never use from production code. */
export function _clearCacheForTests(): void {
  cache.clear();
}
