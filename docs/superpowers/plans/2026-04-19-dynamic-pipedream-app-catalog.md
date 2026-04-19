# Dynamic Pipedream App Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hardcoded 5-entry `APP_OPTIONS` dropdown in `ConnectionsPanel.tsx` with Pipedream Connect's full catalog (~3000 apps) sourced live via `GET /v1/connect/apps`.

**Architecture:** Server-side endpoint `GET /api/pipedream/apps` walks Pipedream's cursor-paginated apps API once and caches the result at module scope for 24h. Client swaps `<select>` for Kumo's `<Combobox>` with built-in typeahead filtering — the catalog ships to the client in one payload and Combobox handles in-memory filtering.

**Tech Stack:** Cloudflare Workers + Hono route, module-level LRU-ish cache, `@cloudflare/kumo/components/combobox` (base-ui-backed typeahead), existing `getCachedAccessToken` for Pipedream auth.

**Branch:** `feat/auth-and-allowlist` (folding into the existing Phase F PR).

---

## Why This Exists

Phases A–F shipped an agent that writes its own webhook handlers, discovers API contracts via `fetch_docs`, and declares its own egress allowlist. But the front-door — the **Connections** panel — still gates users to 5 hardcoded integrations (Linear, GitHub, Slack, Notion, Google Sheets). If a user wants to connect PagerDuty, Stripe, Shopify, Intercom, or any of the other ~2995 apps Pipedream supports, they can't reach them through the UI.

This is the Phase F plan's ["Dynamic app catalog from Pipedream's `/v1/apps`"](./2026-04-19-phase-f-auth-and-agent-declared-hosts.md) Future Work item, lifted into scope because (a) it's UI-only + backend endpoint (zero gateway/auth surface impact), (b) the hardcoded list contradicts the thesis that motivated Phase F ("agent integrates new apps by itself — why does the user need a code change to see them?"), and (c) the Combobox-makes-this-easy discovery: Kumo ships an autocomplete component we don't have to build.

Confirmed via `WebFetch` against Pipedream's `/v1/connect/apps` reference (see "API shape" below). Confirmed via Kumo package introspection that `Combobox` exists, supports typeahead, and handles the 3000-item case cleanly.

---

## Scope

**In scope:**

- New backend endpoint serving the full Pipedream app catalog.
- Module-level cache with a 24-hour TTL; falls back to last-good on Pipedream outage.
- Frontend replaces hardcoded `APP_OPTIONS` with the live list via a Kumo Combobox.

**Out of scope:**

- Background refresh / warm-up on cold-start (skipped per user preference; cache populates on first request).
- Server-side search or fuzzy matching (Combobox filters client-side from the full list).
- Logo/image rendering for each app (optional polish — include if trivial; skip if it bloats the combobox).
- Category filtering, favorites, or "recently connected" pinning.

---

## API Shape (confirmed)

**Endpoint:** `GET https://api.pipedream.com/v1/connect/apps`
**Auth:** `Authorization: Bearer <access_token>` — same token `getCachedAccessToken(env)` returns.

**Query params (all optional):**

- `after` / `before` — cursor pagination.
- `limit` — page size (use default).
- `q`, `sort_key`, `sort_direction`, `category_ids`, etc. — not used.

**Response:**

```json
{
  "data": [ { "name_slug": "slack", "name": "Slack", "img_src": "https://...", "description": "...", "auth_type": "oauth", "categories": [...], "featured_weight": 10 } ],
  "page_info": {
    "count": 100,
    "total_count": 3000,
    "start_cursor": "cursor_abc",
    "end_cursor": "cursor_xyz"
  }
}
```

**Pagination loop:** keep calling with `after=<end_cursor>` until the response has `end_cursor: null` OR `data` is empty.

---

## Kumo Combobox (confirmed)

**Import:** `import { Combobox } from "@cloudflare/kumo/components/combobox"`.

**Shape:** compound component.

```tsx
<Combobox
  items={apps}
  value={selectedApp}
  onValueChange={(v) => setSelectedApp(v as string)}
  label="App"
>
  <Combobox.TriggerInput placeholder="Search apps…" />
  <Combobox.Content>
    <Combobox.List>
      {(app: AppEntry) => (
        <Combobox.Item value={app.name_slug}>{app.name}</Combobox.Item>
      )}
    </Combobox.List>
    <Combobox.Empty>No apps match.</Combobox.Empty>
  </Combobox.Content>
</Combobox>
```

Typeahead filtering is built in — Combobox filters `items` by the trigger input's text.

---

## File Structure

**New files:**

- `src/pipedream/apps.ts` — `listConnectApps(env)` helper. Module-scoped `{ apps: AppEntry[]; fetchedAt: number } | null` cache with a 24h TTL. Walks `/v1/connect/apps` via cursor until exhaustion. Defensive: on fetch failure with a stale cache, log + return stale; on failure with no cache, throw.
- `src/pipedream/apps.test.ts` — mocks `fetch` / `getCachedAccessToken`. Cases: single-page, multi-page stitching, cache hit within TTL skips fetch, cache miss past TTL re-fetches, fetch failure with stale cache returns stale, fetch failure with no cache throws.

**Modified files:**

- `src/server.ts` — new route `GET /api/pipedream/apps` wrapped in `requireAuth` (catalog is public but we gate everything under Access anyway for consistency). Returns `{ apps: AppEntry[] }`.
- `src/ui/ConnectionsPanel.tsx` — replace `APP_OPTIONS` + `<select>` with a live-fetched Combobox.
- `src/pipedream/index.ts` — add `listConnectApps` export alongside existing helpers.

**Deleted:**

- Nothing (the hardcoded `APP_OPTIONS` array just goes away; no standalone file to delete).

---

## Task 1: Backend — catalog fetch + caching + route

**Files:**

- Create: `src/pipedream/apps.ts`, `src/pipedream/apps.test.ts`.
- Modify: `src/server.ts` (new route), `src/pipedream/index.ts` (new export).

**Context:** Fetch all Pipedream apps once per 24h per isolate, serve from cache otherwise. One outbound Pipedream API walk per TTL boundary; all subsequent requests within the window are free. Cache falls back to stale on upstream failure so the UI never hard-breaks.

### `src/pipedream/apps.ts` — types + core

```ts
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
 * The module-level cache is per-isolate; under Workers' cold-start model
 * this means the first request after a new isolate spin-up pays the
 * ~30-page walk (~3-10s). Acceptable given the 24h TTL amortization.
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
  for (let i = 0; i < 100 /* hard cap; Pipedream has ~3k apps */; i++) {
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
 * Test-only reset. Module-scoped cache persists across test cases; call
 * this in `beforeEach` to get a clean slate. Do NOT export to
 * pipedream/index.ts — not production surface.
 */
export function __resetAppsCacheForTests(): void {
  cache = null;
}
```

Notes for the implementer:

- **Do NOT add `__resetAppsCacheForTests` to `src/pipedream/index.ts`.** It exists solely for test isolation. If the repo has a convention for test-only exports (e.g., a `*.test-helpers.ts` file or a `/** @internal */` marker), use that instead.
- **The hard cap of 100 iterations** is a safety valve against a runaway cursor loop (unknown shape bugs). At ~100 apps/page, this supports ~10k apps — well above Pipedream's ~3k catalog.
- **Fetch uses `globalThis.fetch`** (Workers runtime provides it). Do not import it.

### `src/server.ts` — new route

Place this with the other `/api/user/:userId/pipedream/*` routes or near them. Wrap in `requireAuth` (no `:userId` param; the catalog is user-agnostic):

```ts
import { listConnectApps } from "./pipedream/apps";

app.get("/api/pipedream/apps", requireAuth, async (c) => {
  try {
    const apps = await listConnectApps(c.env);
    return c.json({ apps });
  } catch (err) {
    return c.json(
      {
        error: "catalog_unavailable",
        message: err instanceof Error ? err.message : String(err)
      },
      503
    );
  }
});
```

Note: the `run_worker_first` allowlist in `wrangler.jsonc` already covers `/api/*`, so no config change needed.

### `src/pipedream/index.ts` — export

Add `listConnectApps` alongside existing exports. Do not export `__resetAppsCacheForTests`.

### Tests (`src/pipedream/apps.test.ts`)

Use the repo's existing mock pattern for `fetch` + `getCachedAccessToken` (inspect `src/pipedream/proxy.test.ts` for the canonical shape). Test cases:

1. **Single-page walk.** Mock `/v1/connect/apps` to return `{ data: [A], page_info: { end_cursor: null } }`. Assert `listConnectApps(env)` returns `[A]`.
2. **Multi-page stitch.** Mock two pages: first returns `{ data: [A,B], page_info: { end_cursor: "c1" } }`, second (with `after=c1`) returns `{ data: [C], page_info: { end_cursor: null } }`. Assert result is `[A,B,C]` in order.
3. **Cache hit within TTL.** Call twice back-to-back; assert `fetch` was called exactly once (second call hits cache).
4. **Cache miss past TTL.** Mock `Date.now` (or use `vi.useFakeTimers`) to advance past 24h between calls; assert `fetch` was called twice.
5. **Upstream failure with stale cache.** First call succeeds + populates cache. Advance past TTL. Second call mocks `fetch` to reject. Assert the second call returns the cached data (not throw).
6. **Upstream failure with no cache.** First call mocks `fetch` to reject. Assert the call throws.

Remember to call `__resetAppsCacheForTests()` in `beforeEach`.

### Steps

- [ ] Step 1: Read `src/pipedream/proxy.ts` + `src/pipedream/token-cache.ts` to understand the Env type shape, fetch patterns, and test mocking conventions.
- [ ] Step 2: Write failing tests (all 6 cases) in `src/pipedream/apps.test.ts`.
- [ ] Step 3: Implement `src/pipedream/apps.ts`.
- [ ] Step 4: Run `src/pipedream/apps.test.ts` — PASS.
- [ ] Step 5: Add the `GET /api/pipedream/apps` route to `src/server.ts`.
- [ ] Step 6: Add `listConnectApps` export to `src/pipedream/index.ts`.
- [ ] Step 7: `pnpm check` fully green.
- [ ] Step 8: Commit.

```bash
git add src/pipedream/apps.ts src/pipedream/apps.test.ts src/pipedream/index.ts src/server.ts
git commit -m "feat(pipedream): dynamic app catalog endpoint with 24h cache"
```

---

## Task 2: Frontend — Combobox replaces hardcoded dropdown

**Files:**

- Modify: `src/ui/ConnectionsPanel.tsx` (drop `APP_OPTIONS`, fetch catalog, swap in Combobox).

**Context:** `ConnectionsPanel.tsx` currently renders a `<select>` with 5 hardcoded options that feeds `selectedApp` → `client.connectAccount({ app: selectedApp })`. Replace with a Kumo Combobox sourced from the new endpoint. Selection still sets `selectedApp` to a `name_slug` string so the downstream connect flow is untouched.

### State additions

```tsx
interface AppEntry {
  name_slug: string;
  name: string;
  img_src: string;
  description: string | null;
  auth_type: "keys" | "oauth" | "none" | null;
  categories: string[];
  featured_weight: number;
}

const [apps, setApps] = useState<AppEntry[]>([]);
const [catalogError, setCatalogError] = useState<string | null>(null);
const [catalogLoading, setCatalogLoading] = useState(true);

useEffect(() => {
  let cancelled = false;
  (async () => {
    try {
      const res = await fetch("/api/pipedream/apps");
      if (!res.ok) throw new Error(`${res.status}`);
      const body = (await res.json()) as { apps: AppEntry[] };
      if (!cancelled) {
        setApps(body.apps);
        setCatalogLoading(false);
      }
    } catch (e) {
      if (!cancelled) {
        setCatalogError(e instanceof Error ? e.message : String(e));
        setCatalogLoading(false);
      }
    }
  })();
  return () => {
    cancelled = true;
  };
}, []);
```

### Combobox render

Replace the existing `<select>` block (and the `APP_OPTIONS` const) with:

```tsx
import { Combobox } from "@cloudflare/kumo/components/combobox";

// ...

<Combobox
  items={apps}
  value={selectedApp}
  onValueChange={(v) => {
    if (typeof v === "string") setSelectedApp(v);
  }}
  disabled={pending !== null || catalogLoading}
>
  <Combobox.TriggerInput
    placeholder={catalogLoading ? "Loading apps…" : "Search apps…"}
  />
  <Combobox.Content>
    <Combobox.List>
      {(app: AppEntry) => (
        <Combobox.Item value={app.name_slug}>{app.name}</Combobox.Item>
      )}
    </Combobox.List>
    <Combobox.Empty>No apps match.</Combobox.Empty>
  </Combobox.Content>
</Combobox>;
```

### Error surface

Below the Combobox, if `catalogError` is set, render a small error line ("Failed to load app catalog: …"). Don't block the rest of the panel — the already-connected accounts list stays useful even if the catalog fetch fails.

### Default selection

`selectedApp` initializes to `APP_OPTIONS[0].value` today (`"linear"`). Change that initializer to `""` (empty — user must pick). The `Connect` button's `disabled` guard should also check `selectedApp !== ""` so the user can't fire `connectAccount` with an empty slug.

### Gotchas

- **`Combobox.Item value` must be a primitive** (string) for selection to round-trip cleanly. We're using `name_slug`. The `children` render the human name.
- **Don't pass the full `AppEntry` as `value`** — that changes the shape of `selectedApp` and breaks the connect flow.
- **Kumo's Combobox filters items internally** by a default matcher that searches the item's `children` / stringified value. That's fine for us (users search by name). If the default matcher misses — e.g., search "google sheets" doesn't match an item whose children is just "Google Sheets" — investigate via Combobox's `filter` prop. Don't prematurely add one.
- **No `img_src` in the initial pass.** If easy to add (Combobox.Item children can be arbitrary JSX), inline a small `<img>`. If it causes layout jank or Combobox filter gets confused, skip — the name alone is enough for the trial.

### Tests

No new UI tests required for this task. The `/api/pipedream/apps` endpoint is covered by Task 1's server tests. Combobox's behavior is Kumo's responsibility. If the existing ConnectionsPanel has a test file (check), update any assertions that reference `APP_OPTIONS` or the 5 hardcoded values.

### Steps

- [ ] Step 1: Read `src/ui/ConnectionsPanel.tsx` end-to-end to identify every reference to `APP_OPTIONS` and the `<select>` element.
- [ ] Step 2: Add the catalog-fetch `useEffect` + state.
- [ ] Step 3: Replace `<select>` with `<Combobox>`. Initialize `selectedApp` to `""`. Guard the `Connect` button on `selectedApp !== ""`.
- [ ] Step 4: Add the `catalogError` display below the Combobox.
- [ ] Step 5: Delete the `APP_OPTIONS` const.
- [ ] Step 6: Update any existing tests that referenced `APP_OPTIONS` (probably none — check `src/ui/` + `tests/`).
- [ ] Step 7: `pnpm check` green.
- [ ] Step 8: Commit.

```bash
git add src/ui/ConnectionsPanel.tsx
git commit -m "feat(ui): replace hardcoded app dropdown with live Pipedream catalog combobox"
```

---

## Task 3: Smoke

Manual user-driven, not dispatched to an agent.

- [ ] Step 1: Restart dev server.
- [ ] Step 2: Open the Connections panel. Typeahead should populate after ~3-10 seconds on first load (cache cold). Type "slack" → Slack should be the top result. Type "pager" → PagerDuty / PagerTree / etc.
- [ ] Step 3: Select an app not in the old hardcoded list (e.g., PagerDuty or Sentry). Click Connect. Pipedream OAuth popup should open with that app's branding.
- [ ] Step 4: Close the panel and reopen — second fetch should be instant (cache hit).
- [ ] Step 5: Open DevTools → Network → filter on `/api/pipedream/apps`. First load: 200, ~500KB response. Second load: 200, same size (cached on server).
- [ ] Step 6: Rebuild the agent loop for the new app — agent should see the newly-connected slug in `<connected_accounts>` context on its next turn.

---

## Considered and Rejected

### 1. Server-side search via `q` param on every keystroke

- **What it would look like:** Client sends query string → server proxies to `/v1/connect/apps?q=<text>` → returns filtered subset.
- **Rejected because:** Round-trip latency on every keystroke, Pipedream rate-limit risk under fast typing, and Combobox's client-side filter is already in-memory and instantaneous. One-time 500KB payload beats per-keystroke round-trips.

### 2. KV cache instead of module-level cache

- **What it would look like:** Store the catalog in Workers KV with a 24h TTL. Shared across isolates.
- **Rejected because:** Module-level is enough. Per-isolate cache is slightly wasteful (each cold-start pays a walk) but total cold-starts per day are low. KV adds a binding to manage and no meaningful user-facing improvement for the trial.

### 3. Warm the cache at Worker cold-start via `ctx.waitUntil`

- **What it would look like:** The first request to the Worker kicks off a background catalog fetch; subsequent UI requests get the cached version.
- **Rejected because:** The first UI request already triggers the fetch (eager). The "warm background" approach only matters if you want the VERY FIRST request to skip the 3-10s cold-walk. For a trial demo, the user tolerates the first-load wait. Skipped per user preference.

### 4. Hardcoded Tier-1 fallback list baked into client

- **What it would look like:** Client keeps a copy of the 20-ish most common apps; uses them if `/api/pipedream/apps` fails.
- **Rejected because:** It's a maintenance bill (same one we killed in the Phase F catalog debate) for a failure mode that's handled server-side by the stale-cache fallback. If Pipedream is down AND our server has never fetched the catalog, the UI shows an error. That's acceptable for a trial.

---

## Self-Review

**Spec coverage:**

- ✅ Full Pipedream Connect catalog (~3000 apps) loadable via a single endpoint.
- ✅ 24h module-level cache with stale-on-error fallback.
- ✅ Frontend swaps `<select>` for Kumo Combobox; typeahead filtering works out of the box.
- ✅ No new hardcoded app list anywhere; `APP_OPTIONS` deleted.
- ✅ Existing `client.connectAccount({ app: selectedApp })` flow unchanged — selection semantics identical (a `name_slug` string).
- ✅ `run_worker_first` allowlist already covers `/api/*`.

**Type consistency:**

- `AppEntry` type defined once (in `src/pipedream/apps.ts`) and re-declared minimally in `ConnectionsPanel.tsx` (or imported — prefer import to keep a single source of truth).
- `selectedApp` is `string` (app_slug) throughout. Combobox's `onValueChange` returns `unknown` by default; guard with `typeof === "string"` before setting.

**What could go wrong (and why it's handled):**

- Pipedream apps endpoint changes shape → server walker throws, cache falls back to stale if available → UI renders last-known-good; error is logged. Zero-cache case → 503 surfaces as a visible error in the panel, rest of UI still works.
- Access token expires mid-walk → `getCachedAccessToken` handles refresh; our code just consumes the current token per request.
- User types faster than render → Combobox's filter is in-memory and instant; no debounce needed.
- 3000-item Combobox render performance → base-ui virtualizes the list; verified in Kumo's own demos.
- Catalog fetch fails on first isolate start (no cache) → UI shows "Failed to load app catalog". User can retry by refreshing. For trial, acceptable.

---

## Future Work (post-trial)

- **`ctx.waitUntil`-based background warmup.** Cold-start users wait 3-10s on first load. A warmup could eliminate this.
- **Category filtering / "popular apps" pinning.** Pipedream's `featured_weight` field gives us a natural sort; we currently don't use it. Top-10 apps could be pinned above the search list for UX polish.
- **Logo rendering.** `img_src` on each app. Trivial to add — optional polish.
- **Server-side search API** if the 500KB payload becomes an issue at scale (it won't for the trial; might for production).
- **Share cache across isolates via KV** if cold-start costs become meaningful.
