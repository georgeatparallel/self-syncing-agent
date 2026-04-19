# Pipedream Catalog Snapshot + Combobox Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Fix two UX regressions in the just-shipped dynamic Pipedream catalog feature:

1. **Cold-fetch takes ~1.5 minutes.** First request to `/api/pipedream/apps` walks ~30 Pipedream pages serially before responding. Subsequent requests within 24h are instant (server cache), but the first-load experience is unusable.
2. **Combobox renders only a truncated prefix of the catalog** (visible items stop around "Fiserv" — letter F). `Combobox.List` renders every item as a DOM node; ~3000 items × several wrapper elements per item exceeds what the browser handles gracefully. Items like Linear, Notion, Slack (L/N/S) never appear in the dropdown.

**Architecture:** ship the catalog as a committed static JSON snapshot (`public/pipedream-apps.json`) refreshed by a CLI script; the frontend fetches the static file directly (zero server roundtrips, no walk). The Combobox renders a filtered-by-query, capped-at-N subset of results so the DOM stays small.

**Tech Stack:** Vite's `public/` static assets (served as-is by Cloudflare Workers Assets), a Node CLI script that reuses the existing `walkPipedreamApps` helper, React state for the combobox query + filter.

**Branch:** `feat/auth-and-allowlist` (folding into the existing Phase F PR).

---

## Why This Exists

The previous iteration (plan: `2026-04-19-dynamic-pipedream-app-catalog.md`) shipped a live-walk endpoint with a 24h module-level cache. Correct for a "no hardcoded catalog" thesis, but the first-load UX is a 1.5-min spinner. User QA surfaced this immediately.

The honest fix mirrors how most production systems handle public third-party catalogs: **fetch once out-of-band, commit the result, refresh occasionally.** Pipedream's app list changes on the order of weeks; real-time freshness has zero value for a "pick an app to connect" dropdown. Shipping the JSON as a static asset removes the Pipedream API from the hot path entirely — users hit a single 600-700KB static file, browser caches it for the session, done.

Paired with that: Kumo's `Combobox.List` isn't virtualized — it maps `items` to DOM nodes 1:1. For ~3000 apps that blows through browser render budgets and silently truncates the visible list. The fix is application-level: filter `items` by the typed query, cap results, render ≤50 nodes at any given moment.

---

## Scope

**In scope:**

- A committed static snapshot of Pipedream's Connect app catalog at `public/pipedream-apps.json`.
- A `pnpm refresh:apps` script that re-fetches and re-writes the file, reusing the existing walker.
- Frontend swap to fetch the static file directly.
- Client-side filter + top-N cap on Combobox items.
- Removal of the now-unused `GET /api/pipedream/apps` route and `listConnectApps` export (the walker helper stays — the refresh script imports it).

**Out of scope:**

- Automated refresh schedule (GitHub Action, cron, etc.). Manual `pnpm refresh:apps` is enough for the trial; weekly manual runs are fine.
- Diff-based incremental updates. We re-fetch the full catalog on every refresh.
- Virtualizing the full 3000-item Combobox via `Combobox.Collection`. The filter-and-cap approach is simpler and sufficient.
- Moving the catalog to KV or R2.

---

## Phase 1: Static snapshot + refresh script

**Files:**

- Create: `public/pipedream-apps.json` — the committed snapshot (~600-700KB JSON).
- Create: `scripts/refresh-pipedream-apps.ts` — Node CLI that calls Pipedream and writes the snapshot.
- Modify: `package.json` — add `refresh:apps` script.
- Modify: `src/server.ts` — delete the `GET /api/pipedream/apps` route. No replacement; frontend fetches the static file directly.
- Modify: `src/pipedream/apps.ts` — export `walkPipedreamApps` (currently private). Rename for clarity if useful, but preserve tests. Keep `AppEntry` type. Delete the caching layer (`listConnectApps`, cache variables, `__resetAppsCacheForTests`) AND its tests — the runtime path doesn't use them anymore; only the refresh script uses the walker.
- Modify: `src/pipedream/index.ts` — remove `listConnectApps` export; keep `AppEntry` (types are still used by the frontend via type-only import).

### `scripts/refresh-pipedream-apps.ts` — CLI

```ts
#!/usr/bin/env node
/**
 * Refresh public/pipedream-apps.json from Pipedream's Connect app API.
 *
 * Usage: pnpm refresh:apps
 *
 * Reads PIPEDREAM_CLIENT_ID, PIPEDREAM_CLIENT_SECRET, PIPEDREAM_PROJECT_ID,
 * PIPEDREAM_ENVIRONMENT from .dev.vars (same as the Worker runtime). Writes
 * the full app catalog as JSON to public/pipedream-apps.json.
 *
 * Run whenever you want to refresh the committed snapshot — e.g., before
 * a release, or when a new integration Pipedream added matters for a demo.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

interface AppEntry {
  name_slug: string;
  name: string;
  img_src: string;
  description: string | null;
  auth_type: "keys" | "oauth" | "none" | null;
  categories: string[];
  featured_weight: number;
}

function loadDotDevVars(): Record<string, string> {
  const path = resolve(process.cwd(), ".dev.vars");
  const content = readFileSync(path, "utf-8");
  const vars: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return vars;
}

async function fetchAccessToken(env: Record<string, string>): Promise<string> {
  const res = await fetch("https://api.pipedream.com/v1/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: env.PIPEDREAM_CLIENT_ID,
      client_secret: env.PIPEDREAM_CLIENT_SECRET
    })
  });
  if (!res.ok) {
    throw new Error(`token fetch failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { access_token: string };
  return body.access_token;
}

async function walk(token: string): Promise<AppEntry[]> {
  const out: AppEntry[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 100; i++) {
    const url = new URL("https://api.pipedream.com/v1/connect/apps");
    if (cursor) url.searchParams.set("after", cursor);
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}` }
    });
    if (!res.ok) {
      throw new Error(
        `/v1/connect/apps page ${i} failed: ${res.status} ${await res.text()}`
      );
    }
    const body = (await res.json()) as {
      data: AppEntry[];
      page_info: { end_cursor: string | null };
    };
    out.push(...body.data);
    process.stderr.write(
      `  page ${i + 1}: +${body.data.length} apps (total ${out.length})\n`
    );
    if (!body.page_info.end_cursor) break;
    cursor = body.page_info.end_cursor;
  }
  return out;
}

async function main() {
  const env = loadDotDevVars();
  for (const key of [
    "PIPEDREAM_CLIENT_ID",
    "PIPEDREAM_CLIENT_SECRET"
  ] as const) {
    if (!env[key]) {
      throw new Error(`missing ${key} in .dev.vars`);
    }
  }
  process.stderr.write("minting access token…\n");
  const token = await fetchAccessToken(env);
  process.stderr.write("walking /v1/connect/apps…\n");
  const apps = await walk(token);
  const outPath = resolve(process.cwd(), "public/pipedream-apps.json");
  const sorted = apps.sort((a, b) => a.name.localeCompare(b.name));
  writeFileSync(outPath, JSON.stringify({ apps: sorted }, null, 2));
  process.stderr.write(`wrote ${sorted.length} apps to ${outPath}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

**Notes:**

- The script intentionally mirrors `walkPipedreamApps`'s logic rather than importing from `src/` — the `src/` code is Workers-flavored (uses `Env` interface, workers runtime globals) and can't run cleanly under Node without ceremony. Duplication of ~30 lines is the lesser evil here; both walkers are tiny.
- Alphabetical sort on output keeps diffs readable when we refresh later.
- Pretty-prints with 2-space indent — makes the committed file's git history legible.

### `package.json` script

```json
{
  "scripts": {
    "refresh:apps": "node --experimental-strip-types scripts/refresh-pipedream-apps.ts"
  }
}
```

Node 22 supports `--experimental-strip-types` natively. If the team prefers compiled JS, swap to `tsx scripts/...` (dev dep). Either works.

### `src/server.ts` — remove the route

Delete the `app.get("/api/pipedream/apps", ...)` block. Remove the import of `listConnectApps`.

### `src/pipedream/apps.ts` — trim

Keep `AppEntry` type. Delete:

- `listConnectApps` (was the runtime-cached accessor)
- `cache` / `CacheState` / `TTL_MS` (module cache)
- `__resetAppsCacheForTests`
- `walkPipedreamApps` (private helper — moved semantically into the CLI)

Or, alternatively: delete the entire file. The only consumers at runtime are the frontend (which now fetches static JSON) and the CLI (which has its own walker). Types (`AppEntry`) can live in a new file `src/pipedream/app-types.ts`, or inline in the frontend.

**Recommendation:** delete `src/pipedream/apps.ts` and `src/pipedream/apps.test.ts` entirely. Move `AppEntry` to `src/pipedream/app-types.ts` (new, tiny file with just the type). Frontend imports from there.

### `src/pipedream/index.ts`

Remove `listConnectApps` + `AppEntry` exports, add `AppEntry` export from `./app-types` if the types file is the new home.

### `public/pipedream-apps.json` — initial snapshot

Committed as the first version after the refresh script runs locally. Size: ~600-700KB. Pretty-printed JSON.

### Steps (Phase 1)

- [ ] Step 1: Create `scripts/refresh-pipedream-apps.ts` with the script above.
- [ ] Step 2: Add `refresh:apps` to `package.json` scripts.
- [ ] Step 3: Create `src/pipedream/app-types.ts` with just the `AppEntry` interface.
- [ ] Step 4: Delete `src/pipedream/apps.ts` + `src/pipedream/apps.test.ts`. Remove the `GET /api/pipedream/apps` route from `src/server.ts`. Update `src/pipedream/index.ts` exports.
- [ ] Step 5: User-driven: run `pnpm refresh:apps` and commit `public/pipedream-apps.json`. (Implementer may generate a stub file with ~5 entries to make dev smoke work without a real token; user replaces later.)
- [ ] Step 6: Update `src/ui/ConnectionsPanel.tsx` to fetch `/pipedream-apps.json` instead of `/api/pipedream/apps`. (This is a one-line URL swap; still here to make sure nothing else breaks in this file.)
- [ ] Step 7: Run `pnpm check` — ~6 tests gone (the apps.test.ts suite), so baseline drops from 212 to 206. Still fully green.
- [ ] Step 8: Commit.

```bash
git add scripts/refresh-pipedream-apps.ts \
  src/pipedream/app-types.ts \
  src/pipedream/index.ts \
  src/server.ts \
  src/ui/ConnectionsPanel.tsx \
  package.json
git rm src/pipedream/apps.ts src/pipedream/apps.test.ts
# plus the committed JSON snapshot if refreshed locally
git commit -m "feat(pipedream): ship app catalog as static snapshot; drop live walk"
```

---

## Phase 2: Client-side filter + top-N cap

**Files:**

- Modify: `src/ui/ConnectionsPanel.tsx` — add query-driven filter + cap on the Combobox items.

**Context:** `Combobox.List` renders every item in `items` as a DOM node. At ~3000 items this overwhelms the browser (items cut off around letter F in QA). The fix is to filter the `items` array before passing it to Combobox, so at most N items are ever rendered.

### Approach

Kumo's Combobox wraps base-ui's Combobox. The base-ui API provides an `onInputValueChange` callback on the Root that fires as the user types. We track that value in state, filter `apps` against it, and cap to a top-N slice (50 is a reasonable ceiling).

```tsx
const [query, setQuery] = useState("");

const filteredApps = useMemo(() => {
  if (apps.length === 0) return [];
  if (query.trim().length === 0) {
    // No query — render only a tiny prefix so the dropdown isn't empty
    // but also doesn't try to mount 3000 DOM nodes.
    return apps.slice(0, 50);
  }
  const q = query.trim().toLowerCase();
  return apps
    .filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        a.name_slug.toLowerCase().includes(q)
    )
    .slice(0, 50);
}, [apps, query]);
```

Then in the Combobox:

```tsx
<Combobox
  items={filteredApps}
  value={selectedApp}
  onValueChange={(v) => {
    if (typeof v === "string") setSelectedApp(v);
  }}
  onInputValueChange={(v) => setQuery(v ?? "")}
  disabled={pending !== null || catalogLoading}
>
  ...
</Combobox>
```

(Verify the `onInputValueChange` prop exists on the Kumo wrapper; if Kumo passes through base-ui props, it does. If the wrapper strips it, fall back to tracking the input via an `onChange` handler on `Combobox.TriggerInput`. Implementer should inspect `node_modules/@cloudflare/kumo/dist/src/components/combobox/combobox.d.ts` to confirm.)

**Why not use Combobox's built-in filter:**

base-ui exposes a `filter` prop that pre-filters items, but it still renders the full filtered set. The fix isn't "filter better" — it's "cap the rendered DOM." Slicing to 50 post-filter is the cheapest way to do that.

**Empty-query UX:**

Showing the first 50 apps alphabetically when the input is empty is a reasonable compromise between "show something useful" and "don't freeze the browser." An alternative: show an empty list with a hint ("Start typing to search N apps"). Pick whichever feels better after you see it; the code is tiny either way.

### Steps (Phase 2)

- [ ] Step 1: Add `query` state + `filteredApps` useMemo to `ConnectionsPanel.tsx`.
- [ ] Step 2: Wire `onInputValueChange` (or input-level `onChange`) to `setQuery`. Confirm the Kumo prop name first.
- [ ] Step 3: Pass `filteredApps` (not `apps`) to the Combobox's `items` prop.
- [ ] Step 4: Run `pnpm check` — 206/206 still green.
- [ ] Step 5: Commit.

```bash
git add src/ui/ConnectionsPanel.tsx
git commit -m "feat(ui): filter + cap combobox items to avoid browser-overload render"
```

---

## Considered and Rejected

### 1. `Combobox.Collection` (base-ui's virtualized list)

- **What it looks like:** Use `<Combobox.Collection>` instead of `<Combobox.List>`; base-ui handles virtualization internally.
- **Rejected because:** Kumo doesn't document or demo Collection usage, and the base-ui Collection API requires explicit item-height measurement + scroll management. Filter-and-cap is ~10 LOC; Collection is ~50 LOC plus rollback risk if the integration has quirks. The trial value of the fancier approach is zero.

### 2. Keep the server endpoint with a snapshot on disk

- **What it looks like:** `GET /api/pipedream/apps` continues to exist, but reads from `public/pipedream-apps.json` instead of walking Pipedream.
- **Rejected because:** Adds a route-layer indirection for zero benefit. The frontend fetching the static file directly is strictly simpler — one fewer thing to auth-wrap, one fewer thing to test, one fewer thing to cache-invalidate.

### 3. Server-side search proxy (live)

- **What it looks like:** Frontend sends the query on each keystroke, server proxies `/v1/connect/apps?q=<query>` to Pipedream, returns the filtered result.
- **Rejected because:** Introduces network round-trips per keystroke (or per debounced keystroke), Pipedream rate-limit risk under fast typing, and the typical search latency story is WORSE than an in-memory client filter. The 3000-item catalog is small enough to filter client-side instantly.

### 4. Automated snapshot refresh

- **What it looks like:** GitHub Action or Cloudflare Cron that hits `pnpm refresh:apps` on a schedule, opens a PR (or pushes directly).
- **Rejected because:** Overengineering for the trial. Pipedream adds integrations on the order of a few per month; a manual refresh every release is fine. Can add automation post-trial if desired.

### 5. Ship a tiny hardcoded fallback + live-fetch on background

- **What it looks like:** Tiny hardcoded list (say, top 20 apps) renders immediately; a background fetch populates the full catalog after mount.
- **Rejected because:** Resurrects the hardcoded-list problem Phase F killed. If the background fetch fails, users see a truncated list they can't escape. The static snapshot achieves the same "instant load" goal without reintroducing hardcoded data.

---

## Self-Review

**Phase 1:**

- ✅ Static snapshot ships with the build, zero cold-start cost.
- ✅ Refresh script reuses `.dev.vars` so it runs locally without extra setup.
- ✅ `GET /api/pipedream/apps` deleted; no lingering dead endpoint.
- ✅ `AppEntry` type preserved for the frontend's type-safe JSON parse.
- ✅ Tests that exercised the live walker are deleted (they tested runtime code that no longer exists).

**Phase 2:**

- ✅ Combobox renders at most 50 DOM nodes regardless of catalog size.
- ✅ Empty-query default (first 50 alphabetical) is better than empty dropdown.
- ✅ Filter matches both `name` and `name_slug` (users search by either).
- ✅ Memoized via `useMemo` keyed on `[apps, query]` — re-filter only when inputs change.

**What could go wrong:**

- Refresh script fails (network error, bad credentials) → user sees a stack trace; the committed snapshot stays at its previous good state. No runtime impact.
- Pipedream deprecates `/v1/connect/apps` → refresh script fails; existing committed snapshot keeps working until a schema-compatible replacement ships.
- Static file cache issues: browsers may aggressively cache `/pipedream-apps.json`. If the snapshot is refreshed in a release, users might serve a stale copy until their browser cache invalidates. For the trial this is acceptable; future work could add a hash to the filename (e.g., `/pipedream-apps-<hash>.json` + build-time resolution) if it becomes an issue.
- Query string with regex metacharacters → `includes` treats them as literal strings, not regex, so no crash.

---

## Future Work (post-trial)

- **Automated catalog refresh** (weekly GitHub Action).
- **Content-addressed snapshot URL** so browser cache invalidation is implicit on update.
- **Move to `Combobox.Collection`** if the UX requires scrolling a very long filtered list.
- **Fuzzy search** instead of substring match (e.g., `match-sorter` or a tiny Levenshtein). Substring is fine for the trial.
- **Show app logos** (`img_src`) and/or categories alongside names.
