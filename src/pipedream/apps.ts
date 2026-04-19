import { getCachedAccessToken } from "./token-cache";

export interface AppEntry {
  name_slug: string;
  name: string;
  img_src: string;
  description: string | null;
  auth_type: "keys" | "oauth" | "none" | null;
  categories: string[];
  featured_weight: number;
}

interface CacheState {
  apps: AppEntry[];
  fetchedAt: number;
}

const TTL_MS = 24 * 60 * 60 * 1000;
let cache: CacheState | null = null;

/**
 * List the full Pipedream Connect app catalog. Walks /v1/connect/apps
 * via cursor pagination, stitches all pages. Cached at module scope for
 * 24h. On fetch failure, returns stale cache if available; else throws.
 *
 * The module-level cache is per-isolate; under Workers' cold-start
 * model this means the first request after a new isolate spin-up pays
 * the ~30-page walk (~3-10s). Acceptable given the 24h TTL amortization.
 */
export async function listConnectApps(env: Env): Promise<AppEntry[]> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < TTL_MS) {
    return cache.apps;
  }
  try {
    const apps = await walkPipedreamApps(env);
    cache = { apps, fetchedAt: now };
    return apps;
  } catch (err) {
    if (cache) {
      // Stale-while-error: UI stays alive on transient upstream issues.
      return cache.apps;
    }
    throw err;
  }
}

async function walkPipedreamApps(env: Env): Promise<AppEntry[]> {
  const token = await getCachedAccessToken(env);
  const out: AppEntry[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 100 /* hard cap */; i++) {
    const url = new URL("https://api.pipedream.com/v1/connect/apps");
    if (cursor) url.searchParams.set("after", cursor);
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}` }
    });
    if (!res.ok) {
      throw new Error(
        `pipedream /v1/connect/apps ${res.status}: ${await res.text()}`
      );
    }
    const body = (await res.json()) as {
      data: AppEntry[];
      page_info: { end_cursor: string | null };
    };
    out.push(...body.data);
    if (!body.page_info.end_cursor) break;
    cursor = body.page_info.end_cursor;
  }
  return out;
}

/**
 * Test-only reset. Module-scoped cache persists across test cases;
 * call this in `beforeEach` to get a clean slate. Do NOT export from
 * pipedream/index.ts — not production surface.
 */
export function __resetAppsCacheForTests(): void {
  cache = null;
}
