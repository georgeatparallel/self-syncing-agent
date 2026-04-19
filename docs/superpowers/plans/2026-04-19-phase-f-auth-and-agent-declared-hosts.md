# Phase F: Cloudflare Access + Agent-Declared Egress Allowlist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the last two hardcoded surfaces in the system by making them infrastructure + agent-authored — lock down the trust boundary with Cloudflare Access (config, not code) so the hardcoded host allowlist can move to DB rows where the agent declares new entries at `create_sync`.

Two deliverables, one plan:

1. **Cloudflare Access** replaces the localStorage-UUID userId. After this, the user authenticates at the Cloudflare Access edge (Google IdP, Cloudflare handles the whole OAuth dance), and every request to the Worker carries `cf-access-authenticated-user-email`. We set `workers_dev: false` so the Access-protected custom domain is the only entry point — meaning the header is trusted. The `userId = email` is unforgeable. The localStorage impersonation vector goes away.
2. **Agent-declared egress allowlist** replaces the hardcoded `HOST_TO_APP_SLUG` map. `connected_accounts` and `syncs` each grow an `api_hosts TEXT` JSON column. At Pipedream-connect time, pre-populated from a curated JSON catalog of ~20 well-known apps. At `create_sync` time, the agent can declare ADDITIONAL hosts its handler will call. Gateway walks DB rows instead of a TS enum — zero hardcoded hosts in supervisor code.

**Why both in one phase:** the thesis-pure answer to "no hardcoded host map" requires the agent to declare hosts, which requires trusting the agent's declarations, which requires trusting the prompt source, which requires real auth. They're coupled — we do them together.

**Why Cloudflare Access vs hand-rolled OAuth:** Access is ~5 lines of Worker code + 15 min of dashboard config. Hand-rolled Google OAuth is ~500 lines across 6 tasks. For a trial submission with a custom domain already available, Access is the right shape — authentication is infrastructure, not code.

**Architecture:**

- **Auth infra (dashboard, no Worker code):** domain `ronit.one` migrated to Cloudflare DNS. Subdomain `sauna.ronit.one` bound to the Worker as a custom domain. Cloudflare Access application attached to that hostname with Google as the identity provider and an allow-list policy (user's email + reviewer's email). `workers_dev: false` in `wrangler.jsonc` removes the `*.workers.dev` fallback so Access is the only front door.
- **Auth code (minimal):** middleware reads `cf-access-authenticated-user-email` header, sets `c.var.userId = email`. Runs before every protected route. Webhook routes (`/webhook/:userId/:syncId`) stay unauth — Access's configured "bypass" policy lets upstream POSTs through without sign-in. Dev mode (`npm run dev` on localhost) skips the auth header requirement; a configured `DEV_FALLBACK_USER` env var provides the userId.
- **Existing `:userId` in URL paths:** kept as-is. Middleware adds a defense-in-depth check that the path-userId matches the authenticated email, preventing `/api/user/<other>/` enumeration. (Strictly redundant with Access's policy enforcement, but cheap and catches developer mistakes if policies ever loosen.)
- **Schema migration:** `connected_accounts.api_hosts TEXT NOT NULL DEFAULT '[]'` and `syncs.api_hosts TEXT NOT NULL DEFAULT '[]'`. Both hold JSON-encoded `string[]`.
- **Catalog:** `src/pipedream/app-hosts.json` with ~20 Tier 1/2 app → hostname[] entries. Loaded once at module init.
- **Populate at connect time:** `persistPipedreamAccount` looks up `appHostsCatalog[app_slug]` and inserts into the new row's `api_hosts`. Unknown slug → `[]`, can be enriched later.
- **Agent declaration at `create_sync`:** optional `api_hosts: string[]` input. Agent drafts based on its `fetch_docs` research. Supervisor persists on the sync row.
- **Gateway egress resolution (new flow):**
  1. **SSRF denylist (non-negotiable):** reject private IPs (127/8, 10/8, 172.16/12, 192.168/16, 169.254/16 covers cloud metadata), IPv6 loopback + ULA, `localhost`, `.internal`, `.local`. 403 `denied_host` regardless of allowlist.
  2. **Primary:** walk user's `connected_accounts`. Match hostname against each row's `api_hosts`. First match → that row's `account_id`.
  3. **Secondary (agent-declared):** walk user's `syncs`. Match hostname against each sync's `api_hosts`. If match → look up `connected_accounts WHERE app_slug = sync.integration`, use that account.
  4. No match → 403 `unknown_host`.
- **`HOST_TO_APP_SLUG` deleted.** Entries migrate into the JSON catalog.

**Tech Stack:** Cloudflare Access (config via dashboard), Cloudflare Workers custom domains, Hono middleware, Web Crypto for… nothing, actually (no JWT to verify), Vitest for unit tests.

**Branch:** `feat/auth-and-allowlist` (new branch off `main`).

**Migration note:** localStorage-UUID users get orphaned. For the trial this is fine — fresh slate for the Loom demo.

---

## Prerequisite (user action, before Task 1)

1. **Migrate `ronit.one` to Cloudflare:**
   - dash.cloudflare.com → Add Site → `ronit.one` → Free plan → import DNS.
   - Recreate the LinkedIn redirect as a Cloudflare Single Redirect rule BEFORE switching nameservers.
   - Change nameservers at Spaceship to the Cloudflare pair.
   - Wait for propagation (usually 5-30 min).

2. **Add Worker custom domain.** In `wrangler.jsonc` add:

   ```jsonc
   "workers_dev": false,
   "routes": [{ "pattern": "sauna.ronit.one", "custom_domain": true }]
   ```

   Redeploy: `npx wrangler deploy`. Cloudflare auto-creates the DNS record + TLS cert.

3. **Configure Cloudflare Access:**
   - dash.cloudflare.com → Zero Trust → Access → Applications → Add application → Self-hosted.
   - Application domain: `sauna.ronit.one`.
   - Identity providers: add Google (one-click).
   - **Policy 1 "users":** Action = Allow, Include = Emails ∈ {your email, reviewer's email}. Applies to everything by default.
   - **Policy 2 "webhook bypass":** Action = Bypass, Include = Everyone, Path filter = `/webhook/*`. Lets upstream webhooks POST without authentication.
   - Save.

4. **Test auth works:**
   - Open `https://sauna.ronit.one` in incognito → Google sign-in via Cloudflare → app loads.
   - `curl https://sauna.ronit.one/webhook/test/test` returns 404 (bypass works, auth not required).

5. **Add a reviewer-access plan.** For the trial demo video, either:
   - Add `@anthropic.com` to the allow rule (broadest; reviewer uses their work email).
   - Pre-record the demo on Loom and hand over a link (no reviewer interaction needed).
   - Generate a Service Token in Access for programmatic access (advanced; skip).

6. **Set `DEV_FALLBACK_USER` on dev** (local-only; not needed on prod since Access always sets the header):
   ```bash
   echo 'DEV_FALLBACK_USER=your-email@example.com' >> .dev.vars
   ```
   This lets `npm run dev` on localhost work without Access headers.

Implementer CONFIRMS with the user that prereq steps 1-5 are done and the incognito test passes before starting Task 1.

---

## File Structure

**New files:**

- `src/auth/middleware.ts` — Hono middleware `requireAuth(c, next)` that reads `cf-access-authenticated-user-email` header (falls back to `env.DEV_FALLBACK_USER` when header absent and running locally); sets `c.var.userId`; returns 401 if neither is available. Plus `requireAuthAndUserIdMatch(c, next)` for path-`:userId` routes.
- `src/auth/middleware.test.ts` — header-set case, header-missing-with-fallback, header-missing-no-fallback (prod 401 path), path-mismatch 403.
- `src/pipedream/app-hosts.json` — catalog map `{appSlug: string[]}` with ~20 entries.
- `src/pipedream/app-hosts.ts` — loader + `getCatalogHosts(appSlug)` + `SSRF_DENYLIST_PATTERNS` + `isDeniedHost(hostname)`.
- `src/pipedream/app-hosts.test.ts` — catalog roundtrip, SSRF denylist for private IPs / localhost / metadata endpoints.

**Modified files:**

- `wrangler.jsonc` — `workers_dev: false`, `routes: [{pattern: "sauna.ronit.one", custom_domain: true}]`.
- `src/server.ts` — import auth middleware; wrap `/api/user/:userId/*` routes with `requireAuthAndUserIdMatch`; webhook routes stay as-is. Update `persistPipedreamAccount` to populate `api_hosts` from the catalog.
- `src/db/schema.ts` — `ALTER TABLE` to add `api_hosts` to both tables. Idempotent via `addColumnIfNotExists` helper.
- `src/db/types.ts` — add `api_hosts: string[]` to `ConnectedAccount` and `Sync`.
- `src/db/connected-accounts.ts`, `src/db/syncs.ts` — persist + decode JSON.
- `src/proxy/http-gateway.ts` — new `resolveEgressAccount` via ChatAgent RPC, replace `resolveAppSlug` static lookup, add SSRF denylist as first check, new error code `denied_host`.
- `src/pipedream/index.ts` — remove `resolveAppSlug, HOST_TO_APP_SLUG`; add `getCatalogHosts, isDeniedHost`.
- `src/agent/tools/write/create-sync.ts` — add optional `api_hosts` input. Persist on sync row. Update tool description.
- `src/agent/tools/write/update-sync.ts` — add optional `api_hosts` input.
- `src/agent/system-prompt.ts` — new bullet on declaring api_hosts under "## Creating a sync."
- `src/ui/App.tsx` (or root entry) — remove localStorage userId resolution. Read userId from `/api/auth/me` (new endpoint that returns the authenticated email).
- `src/ui/useConnections.ts`, `src/ui/useSyncsSummary.ts`, `src/ui/useSyncDetails.ts`, `src/ui/ConnectionsPanel.tsx` — thread the userId from auth context instead of prop.

**Deleted files:**

- `src/identity.ts`
- `src/identity.test.ts`
- `src/pipedream/host-mapping.ts`
- `src/pipedream/host-mapping.test.ts`

---

## Task 1: Auth middleware + /api/auth/me + wire protection

**Files:**

- Create: `src/auth/middleware.ts`, `src/auth/middleware.test.ts`
- Modify: `src/server.ts` (add `/api/auth/me` endpoint, wrap protected routes), `wrangler.jsonc` (workers_dev: false + custom_domain route)

**Context:** This task lands auth end-to-end on the server. ~50 lines of middleware + route wrapping. The heavy lifting (OAuth, JWT, cookies, session storage) is done by Cloudflare Access at the infrastructure layer.

### Middleware

Three behaviors we need:

1. **Read the authenticated email** from `cf-access-authenticated-user-email` header. Present on every request routed through Access (prod).
2. **Dev-mode fallback:** when the header is missing AND `env.DEV_FALLBACK_USER` is set, use that. This is ONLY for `npm run dev` on localhost where Access doesn't apply. On prod, the header is always set because `workers_dev: false` means Access is the only entry.
3. **Path-userId cross-check:** for routes that take `:userId` in the path, reject if it doesn't match the authenticated email. Defense-in-depth against developer mistakes in Access policies.

```ts
// src/auth/middleware.ts
import { createMiddleware } from "hono/factory";

export const CF_ACCESS_HEADER = "cf-access-authenticated-user-email";

type AuthedEnv = {
  Bindings: { DEV_FALLBACK_USER?: string };
  Variables: { userId: string };
};

function resolveAuthenticatedEmail(c: {
  req: { header: (k: string) => string | undefined };
  env: { DEV_FALLBACK_USER?: string };
}): string | null {
  const fromAccess = c.req.header(CF_ACCESS_HEADER);
  if (fromAccess) return fromAccess.toLowerCase();
  const dev = c.env.DEV_FALLBACK_USER;
  if (dev) return dev.toLowerCase();
  return null;
}

export const requireAuth = createMiddleware<AuthedEnv>(async (c, next) => {
  const email = resolveAuthenticatedEmail(c);
  if (!email) return c.json({ error: "unauthenticated" }, 401);
  c.set("userId", email);
  await next();
});

export const requireAuthAndUserIdMatch = createMiddleware<AuthedEnv>(
  async (c, next) => {
    const email = resolveAuthenticatedEmail(c);
    if (!email) return c.json({ error: "unauthenticated" }, 401);
    const pathUserId = c.req.param("userId");
    if (pathUserId && pathUserId !== email) {
      return c.json({ error: "user_id_mismatch" }, 403);
    }
    c.set("userId", email);
    await next();
  }
);
```

### Tests

```ts
// src/auth/middleware.test.ts
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { requireAuth, requireAuthAndUserIdMatch } from "./middleware";

type Env = {
  Bindings: { DEV_FALLBACK_USER?: string };
  Variables: { userId: string };
};

function makeApp() {
  const app = new Hono<Env>();
  app.get("/protected", requireAuth, (c) => c.json({ userId: c.var.userId }));
  app.get("/user/:userId/resource", requireAuthAndUserIdMatch, (c) =>
    c.json({ userId: c.var.userId })
  );
  return app;
}

describe("auth middleware", () => {
  it("requireAuth: 401 when header absent and no DEV_FALLBACK_USER", async () => {
    const app = makeApp();
    const res = await app.request("/protected", {}, {});
    expect(res.status).toBe(401);
  });

  it("requireAuth: 200 with Access header; sets c.var.userId lowercase", async () => {
    const app = makeApp();
    const res = await app.request(
      "/protected",
      { headers: { "cf-access-authenticated-user-email": "User@Example.com" } },
      {}
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: "user@example.com" });
  });

  it("requireAuth: dev fallback used when header absent", async () => {
    const app = makeApp();
    const res = await app.request(
      "/protected",
      {},
      { DEV_FALLBACK_USER: "dev@local" }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: "dev@local" });
  });

  it("requireAuth: Access header wins over dev fallback", async () => {
    const app = makeApp();
    const res = await app.request(
      "/protected",
      { headers: { "cf-access-authenticated-user-email": "real@user.com" } },
      { DEV_FALLBACK_USER: "dev@local" }
    );
    expect(await res.json()).toEqual({ userId: "real@user.com" });
  });

  it("requireAuthAndUserIdMatch: 403 when path userId differs", async () => {
    const app = makeApp();
    const res = await app.request(
      "/user/other@user.com/resource",
      { headers: { "cf-access-authenticated-user-email": "me@user.com" } },
      {}
    );
    expect(res.status).toBe(403);
  });

  it("requireAuthAndUserIdMatch: 200 when path userId matches", async () => {
    const app = makeApp();
    const res = await app.request(
      "/user/me@user.com/resource",
      { headers: { "cf-access-authenticated-user-email": "me@user.com" } },
      {}
    );
    expect(res.status).toBe(200);
  });
});
```

### Server.ts changes

Add `GET /api/auth/me`:

```ts
import { requireAuth, requireAuthAndUserIdMatch } from "./auth/middleware";

app.get("/api/auth/me", requireAuth, (c) => c.json({ userId: c.var.userId }));
```

Wrap existing `/api/user/:userId/*` routes:

```ts
app.get("/api/user/:userId/syncs-summary", requireAuthAndUserIdMatch, async (c) => { ... });
app.get("/api/user/:userId/syncs/:syncId/details", requireAuthAndUserIdMatch, async (c) => { ... });
app.post("/api/user/:userId/pipedream/token", requireAuthAndUserIdMatch, async (c) => { ... });
app.post("/api/user/:userId/pipedream/account", requireAuthAndUserIdMatch, async (c) => { ... });
app.get("/api/user/:userId/pipedream/accounts", requireAuthAndUserIdMatch, async (c) => { ... });
```

`/webhook/:userId/:syncId` stays unauth.

### wrangler.jsonc

```jsonc
{
  // ... existing config ...
  "workers_dev": false,
  "routes": [{ "pattern": "sauna.ronit.one", "custom_domain": true }]
}
```

Place `workers_dev` and `routes` as sibling keys to `name`, `main`, etc. Do NOT add inside any nested object. The `"custom_domain": true` flag is critical — without it, Wrangler expects a pre-existing DNS record instead of auto-creating one.

### Test file updates

`tests/pipedream-routes.test.ts` calls `/api/user/:userId/pipedream/*` routes. Post-middleware, they now require an Access header. Update the `SELF.fetch` calls to include `{headers: {"cf-access-authenticated-user-email": userId}}`. Same userId you're passing in the URL — the middleware checks for match.

- [ ] **Step 1: Write failing middleware tests**

- [ ] **Step 2: Implement middleware**

- [ ] **Step 3: Run middleware tests — PASS**

- [ ] **Step 4: Update wrangler.jsonc** (workers_dev: false + route)

- [ ] **Step 5: Add /api/auth/me and wrap protected routes in server.ts**

- [ ] **Step 6: Update `tests/pipedream-routes.test.ts`** to pass the Access header

- [ ] **Step 7: Add `DEV_FALLBACK_USER` to Env type** — `npx wrangler types env.d.ts --include-runtime false`

- [ ] **Step 8: Run full check — fully green**

- [ ] **Step 9: Commit**

```bash
git add src/auth/middleware.ts src/auth/middleware.test.ts src/server.ts wrangler.jsonc tests/pipedream-routes.test.ts env.d.ts
git commit -m "feat(auth): Cloudflare Access middleware + protect /api/user/:userId/*"
```

---

## Task 2: Schema migration + bootstrap host catalog + SSRF denylist

**Files:**

- Create: `src/pipedream/app-hosts.json`, `src/pipedream/app-hosts.ts`, `src/pipedream/app-hosts.test.ts`
- Modify: `src/db/schema.ts`, `src/db/types.ts`, `src/db/connected-accounts.ts`, `src/db/syncs.ts`
- Delete: `src/pipedream/host-mapping.ts`, `src/pipedream/host-mapping.test.ts`
- Modify: `src/pipedream/index.ts`

**Context:** Everything the gateway will need to resolve hosts lives in DB rows now. This task lays that data foundation + the curated catalog that pre-populates it at connection time.

### `app-hosts.json`

```json
{
  "github": [
    "api.github.com",
    "uploads.github.com",
    "raw.githubusercontent.com"
  ],
  "linear": ["api.linear.app"],
  "slack": ["slack.com", "hooks.slack.com"],
  "notion": ["api.notion.com"],
  "stripe": ["api.stripe.com", "files.stripe.com"],
  "shopify": ["myshopify.com"],
  "hubspot": ["api.hubapi.com"],
  "intercom": ["api.intercom.io"],
  "vercel": ["api.vercel.com"],
  "gitlab": ["gitlab.com"],
  "pagerduty": ["api.pagerduty.com"],
  "sentry": ["sentry.io"],
  "twilio": ["api.twilio.com"],
  "typeform": ["api.typeform.com"],
  "calendly": ["api.calendly.com"],
  "mailgun": ["api.mailgun.net"],
  "zendesk": ["zendesk.com"],
  "jira": ["atlassian.net"],
  "bitbucket": ["api.bitbucket.org"],
  "clickup": ["api.clickup.com"],
  "google_sheets": ["sheets.googleapis.com"],
  "google_drive": ["www.googleapis.com"]
}
```

Shopify / Jira / Zendesk use tenant subdomains — the catalog stores the suffix (`myshopify.com`), gateway match uses `hostname === catalog[i] || hostname.endsWith("." + catalog[i])`.

### `app-hosts.ts`

```ts
// src/pipedream/app-hosts.ts
import catalog from "./app-hosts.json";

const raw = catalog as Record<string, string[]>;

export const appHostsCatalog: ReadonlyMap<string, readonly string[]> = new Map(
  Object.entries(raw)
);

export function getCatalogHosts(appSlug: string): readonly string[] {
  return appHostsCatalog.get(appSlug) ?? [];
}

/**
 * SSRF denylist. Rejected hostnames never reach Pipedream regardless of
 * catalog or agent declaration. Covers: private IPv4 ranges (incl.
 * 169.254/16 which contains cloud metadata endpoints), IPv6 loopback +
 * unique-local addresses, localhost, cloud-internal suffixes.
 */
const PRIVATE_IPV4_CIDRS: Array<[number, number]> = [
  [0x7f000000, 0xff000000], // 127/8
  [0x0a000000, 0xff000000], // 10/8
  [0xac100000, 0xfff00000], // 172.16/12
  [0xc0a80000, 0xffff0000], // 192.168/16
  [0xa9fe0000, 0xffff0000] // 169.254/16 — link-local incl. AWS/GCP metadata
];

function ipv4ToUint32(hostname: string): number | null {
  const parts = hostname.split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    out = ((out << 8) | n) >>> 0;
  }
  return out;
}

export function isDeniedHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h === "ip6-localhost") return true;
  if (h.endsWith(".internal") || h.endsWith(".local")) return true;
  if (h === "::1") return true;
  if (/^(fc|fd)[0-9a-f]{2}:/.test(h)) return true; // IPv6 ULA
  const v4 = ipv4ToUint32(h);
  if (v4 !== null) {
    for (const [base, mask] of PRIVATE_IPV4_CIDRS) {
      if ((v4 & mask) === base) return true;
    }
  }
  return false;
}
```

### Schema migration

In `src/db/schema.ts`:

```ts
function addColumnIfNotExists(
  sqlExec: (stmt: string) => void,
  sqlQuery: <T>(stmt: string) => T[],
  table: string,
  column: string,
  defSql: string
): void {
  const rows = sqlQuery<{ name: string }>(`PRAGMA table_info(${table})`);
  if (rows.some((r) => r.name === column)) return;
  sqlExec(`ALTER TABLE ${table} ADD COLUMN ${column} ${defSql}`);
}
```

The existing `applySchemaMigrations` uses the SqlTag interface. You may need to inspect how the DB helper exposes raw exec; if raw exec isn't available, fall back to `try { sqlTag\`ALTER TABLE ...\` } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }`. Check the existing patterns in `src/db/schema.ts` before implementing.

Add after existing CREATE TABLEs:

```ts
addColumnIfNotExists(..., "connected_accounts", "api_hosts", "TEXT NOT NULL DEFAULT '[]'");
addColumnIfNotExists(..., "syncs", "api_hosts", "TEXT NOT NULL DEFAULT '[]'");
```

### Type + persist-layer updates

`src/db/types.ts`:

```ts
export interface ConnectedAccount {
  user_id: string;
  app_slug: string;
  account_id: string;
  connected_at: number;
  api_hosts: string[]; // NEW
}

// Similar on Sync interface — add api_hosts: string[].
```

`src/db/connected-accounts.ts` — encode on insert, decode on read:

```ts
export function upsertConnectedAccount(
  sql: SqlTag,
  input: NewConnectedAccount & { api_hosts?: string[] }
): void {
  const hosts = JSON.stringify(input.api_hosts ?? []);
  sql`
    INSERT INTO connected_accounts (user_id, app_slug, account_id, connected_at, api_hosts)
    VALUES (${input.user_id}, ${input.app_slug}, ${input.account_id}, ${Date.now()}, ${hosts})
    ON CONFLICT(user_id, app_slug) DO UPDATE SET
      account_id = excluded.account_id,
      connected_at = excluded.connected_at,
      api_hosts = excluded.api_hosts
  `;
}

export function listConnectedAccounts(
  sql: SqlTag,
  user_id: string
): ConnectedAccount[] {
  const rows = sql<ConnectedAccount & { api_hosts: string }>`
    SELECT * FROM connected_accounts WHERE user_id = ${user_id}
  `;
  return rows.map((r) => ({ ...r, api_hosts: JSON.parse(r.api_hosts) }));
}
```

Same pattern for `src/db/syncs.ts` (`createSync`, `listSyncs`, `getSyncById` — all decode JSON).

### `persistPipedreamAccount` populates from catalog

In `src/server.ts`:

```ts
import { getCatalogHosts } from "./pipedream/app-hosts";

// Inside persistPipedreamAccount:
upsertConnectedAccount(sql, {
  user_id: userId,
  app_slug,
  account_id,
  api_hosts: [...getCatalogHosts(app_slug)]
});
```

### Delete `host-mapping.ts`

Grep for `HOST_TO_APP_SLUG`, `resolveAppSlug`, `host-mapping` across `src/` and `tests/`. Replace all callers. Task 3 owns the main one (`http-gateway.ts`). Remove exports from `src/pipedream/index.ts`; add `getCatalogHosts, isDeniedHost`.

### Tests

`src/pipedream/app-hosts.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { getCatalogHosts, isDeniedHost, appHostsCatalog } from "./app-hosts";

describe("app-hosts catalog", () => {
  it("returns known hosts for github", () => {
    expect(getCatalogHosts("github")).toContain("api.github.com");
    expect(getCatalogHosts("github")).toContain("uploads.github.com");
  });
  it("returns empty for unknown slug", () => {
    expect(getCatalogHosts("nonexistent_app")).toEqual([]);
  });
  it("catalog contains the ~20 Tier 1/2 entries", () => {
    expect(appHostsCatalog.size).toBeGreaterThanOrEqual(20);
  });
});

describe("isDeniedHost (SSRF)", () => {
  it("blocks IPv4 loopback", () => {
    expect(isDeniedHost("127.0.0.1")).toBe(true);
    expect(isDeniedHost("127.255.255.255")).toBe(true);
  });
  it("blocks private IPv4 ranges", () => {
    expect(isDeniedHost("10.0.0.1")).toBe(true);
    expect(isDeniedHost("172.16.0.1")).toBe(true);
    expect(isDeniedHost("172.31.255.255")).toBe(true);
    expect(isDeniedHost("192.168.1.1")).toBe(true);
  });
  it("blocks cloud metadata endpoints (169.254/16)", () => {
    expect(isDeniedHost("169.254.169.254")).toBe(true);
  });
  it("blocks localhost and cloud-internal suffixes", () => {
    expect(isDeniedHost("localhost")).toBe(true);
    expect(isDeniedHost("foo.internal")).toBe(true);
    expect(isDeniedHost("foo.local")).toBe(true);
  });
  it("blocks IPv6 loopback and ULA", () => {
    expect(isDeniedHost("::1")).toBe(true);
    expect(isDeniedHost("fc00::1")).toBe(true);
    expect(isDeniedHost("fd12:3456::1")).toBe(true);
  });
  it("allows public hostnames", () => {
    expect(isDeniedHost("api.github.com")).toBe(false);
    expect(isDeniedHost("8.8.8.8")).toBe(false);
  });
});
```

- [ ] **Steps 1-8:** write catalog/denylist + tests, update schema, update types + DB helpers, update `persistPipedreamAccount`, delete `host-mapping.ts`, run tests, commit.

```bash
git commit -m "feat(pipedream): host catalog + api_hosts columns + SSRF denylist"
```

---

## Task 3: Gateway rewrite to DB-backed resolution

**Files:**

- Modify: `src/proxy/http-gateway.ts`, `src/proxy/http-gateway.test.ts`
- Modify: `src/server.ts` (add ChatAgent RPC)

**Context:** Replace `resolveAppSlug(host)` single-lookup path with:

1. `isDeniedHost(host)` — hard reject.
2. RPC into user's ChatAgent DO — walk `connected_accounts.api_hosts` then `syncs.api_hosts`, return `{accountId, appSlug}` for first match.
3. No match → 403 `unknown_host`.

### New ChatAgent RPC

```ts
// src/server.ts, inside ChatAgent class:
async resolveEgressAccount(
  userId: string,
  hostname: string
): Promise<{ accountId: string; appSlug: string } | null> {
  await this.setName(userId);
  this.#ensureSchema();
  const sql = this.sql.bind(this);
  const host = hostname.toLowerCase();

  const accounts = listConnectedAccounts(sql, userId);
  for (const acc of accounts) {
    if (matchesHost(acc.api_hosts, host)) {
      return { accountId: acc.account_id, appSlug: acc.app_slug };
    }
  }

  const syncs = listSyncs(sql, userId);
  for (const sync of syncs) {
    if (matchesHost(sync.api_hosts, host)) {
      const acc = accounts.find((a) => a.app_slug === sync.integration);
      if (acc) return { accountId: acc.account_id, appSlug: acc.app_slug };
    }
  }

  return null;
}

function matchesHost(declared: string[], actual: string): boolean {
  for (const d of declared) {
    if (actual === d || actual.endsWith("." + d)) return true;
  }
  return false;
}
```

### Gateway rewrite

```ts
// src/proxy/http-gateway.ts
import { WorkerEntrypoint } from "cloudflare:workers";
import { isDeniedHost } from "../pipedream/app-hosts";
import { proxiedFetch } from "../pipedream/proxy";
import { getCachedAccessToken } from "../pipedream/token-cache";

export interface HttpGatewayProps {
  userId?: string;
}
type Forwarder = (r: Request) => Promise<Response>;

export type EgressLookup = (
  userId: string,
  hostname: string
) => Promise<{ accountId: string; appSlug: string } | null>;

export interface HandleGatewayRequestOptions {
  forwarder?: Forwarder;
  egressLookup?: EgressLookup;
}

export async function handleGatewayRequest(
  request: Request,
  env: Env,
  props: HttpGatewayProps,
  options: HandleGatewayRequestOptions = {}
): Promise<Response> {
  const forwarder = options.forwarder ?? fetch;
  const url = new URL(request.url);
  const host = url.hostname.toLowerCase();

  if (isDeniedHost(host)) {
    return new Response(
      JSON.stringify({
        error: "denied_host",
        host,
        message:
          "Host is on the SSRF denylist (private IP, loopback, cloud metadata, or *.internal/*.local)."
      }),
      { status: 403, headers: { "content-type": "application/json" } }
    );
  }

  if (!props.userId || !options.egressLookup) {
    return new Response(JSON.stringify({ error: "no_user_context", host }), {
      status: 403,
      headers: { "content-type": "application/json" }
    });
  }

  const resolved = await options.egressLookup(props.userId, host);
  if (!resolved) {
    return new Response(
      JSON.stringify({
        error: "unknown_host",
        host,
        message:
          "No connected account or sync declares this host. Connect the app in the Connections panel, or declare it at create_sync via api_hosts."
      }),
      { status: 403, headers: { "content-type": "application/json" } }
    );
  }

  const accessToken = await getCachedAccessToken(env);
  return proxiedFetch({
    env,
    accessToken,
    accountId: resolved.accountId,
    externalUserId: props.userId,
    request,
    forwarder
  });
}

export class HttpGateway extends WorkerEntrypoint<Env, HttpGatewayProps> {
  async fetch(request: Request): Promise<Response> {
    const egressLookup: EgressLookup = async (userId, hostname) => {
      const stub = this.env.ChatAgent.get(
        this.env.ChatAgent.idFromName(userId)
      );
      return (
        stub as unknown as {
          resolveEgressAccount: (
            u: string,
            h: string
          ) => Promise<{ accountId: string; appSlug: string } | null>;
        }
      ).resolveEgressAccount(userId, hostname);
    };
    return handleGatewayRequest(request, this.env, this.ctx.props, {
      egressLookup
    });
  }
}
```

### Test updates

Extend `src/proxy/http-gateway.test.ts`:

- **SSRF denylist:** `http://127.0.0.1/x`, `http://169.254.169.254/latest/meta-data/`, `http://10.5.5.5/` → 403 `denied_host`. `forwarder` and `egressLookup` NOT called.
- **Connected-account match:** `egressLookup` returns `{accountId: "apn_1", appSlug: "github"}`, request to `https://api.github.com/user` → proxied. Forwarder URL contains `api.pipedream.com/v1/connect/.../proxy/` and `account_id=apn_1`.
- **Unknown host:** `egressLookup` returns null → 403 `unknown_host`.
- **Suffix match test:** add an RPC-level test that tenant subdomain `mystore.myshopify.com` matches catalog's `myshopify.com`.

Also add a test for `resolveEgressAccount` in a DO-level test (the `runInDurableObject` pattern). Seed `connected_accounts` row with `api_hosts: ["api.github.com"]`, call `resolveEgressAccount("userX", "api.github.com")`, assert `{accountId, appSlug: "github"}`. Seed `syncs` row with `api_hosts: ["api.stripe.com"]` + matching connected_accounts row for `stripe`, assert `api.stripe.com` resolves via sync path.

- [ ] **Steps 1-6:** add RPC, rewrite gateway, update tests, run check, commit.

```bash
git commit -m "feat(gateway): DB-backed egress resolution + SSRF denylist"
```

---

## Task 4: Agent declaration at create_sync + tool descriptions + system prompt

**Files:**

- Modify: `src/agent/tools/write/create-sync.ts`, `src/agent/tools/write/update-sync.ts`
- Modify: `src/agent/system-prompt.ts`
- Modify: `src/agent/tools/write/create-sync.test.ts`, `src/agent/tools/write/update-sync.test.ts`

**Context:** Agent declares `api_hosts` at create_sync. Persisted on sync row. Gateway picks up via Task 3's sync walk.

### Input additions

`create_sync`:

```ts
api_hosts: z.array(z.string().min(1))
  .optional()
  .describe(
    "Additional hostnames your handler code needs to fetch, beyond what's already in the connected account's default catalog. Example: ['api.stripe.com'] if the handler calls fetch('https://api.stripe.com/v1/webhook_endpoints'). Use fetch_docs on the upstream's API reference to discover the hosts. Over-declaring is fine; under-declaring 403s at the gateway."
  );
```

`update_sync` gets the same field (optional; omit to preserve existing).

### Persist

In `create_sync.ts`: include `api_hosts: api_hosts ?? []` in both the preliminary NewSync AND finalNewSync. In `update_sync.ts`: if `api_hosts !== undefined`, update; else preserve.

### Tool description update

In `create_sync`'s description, add to the handler-contract section:

```
**Declare your api_hosts.** If your handler calls hosts beyond the connected app's default catalog, declare them at create_sync via the `api_hosts` input. The gateway walks your declared hosts when routing outbound fetches — undeclared hosts 403. Use `fetch_docs` on the upstream's API reference to find the exact hostnames (often more than one: main API + webhook registration + uploads). The connected account's default hosts are already included, so if you're only hitting well-known catalog hosts for a Tier 1 app (GitHub, Linear, Stripe, Slack, Shopify, Notion, etc.), you can leave this unset.
```

### System prompt update

Under "## Creating a sync", add a new bullet:

```
N. **Declare the hosts your handler will call.** Before drafting create_sync, use fetch_docs to read the upstream's API reference and identify every hostname your registerWebhook / handleWebhook code will fetch(). Pass them as api_hosts: [...]. Missing declarations 403 at the gateway.
```

### Tests

`create-sync.test.ts`: call with `api_hosts: ["api.stripe.com"]`, verify persisted sync has that value.
`update-sync.test.ts`: call with new `api_hosts`, verify update replaces old value; omit and verify old value preserved.

- [ ] **Steps 1-5:** implement, test, commit.

```bash
git commit -m "feat(agent): api_hosts declaration at create_sync + docs"
```

---

## Task 5: Frontend cleanup + smoke

**Files:**

- Delete: `src/identity.ts`, `src/identity.test.ts`
- Modify: `src/ui/App.tsx` (or root entry), `src/ui/useConnections.ts`, `src/ui/useSyncsSummary.ts`, `src/ui/useSyncDetails.ts`, `src/ui/ConnectionsPanel.tsx`
- Modify: `.dev.vars.example`

**Context:** With Access doing the auth work, the frontend needs zero sign-in UI. The user hits `sauna.ronit.one`, Cloudflare's identity flow fires, they land in the app authenticated. Frontend just needs to know the userId.

### App.tsx

Replace the `getOrMintUserId()` / `userIdFromPath` logic at the top with a one-shot fetch to `/api/auth/me`:

```tsx
const [userId, setUserId] = useState<string | null>(null);

useEffect(() => {
  fetch("/api/auth/me")
    .then((r) => (r.ok ? r.json() : null))
    .then((body) => setUserId(body?.userId ?? null));
}, []);

if (userId === null) return <div>Loading…</div>;
// Then pass userId down as before.
```

If `/api/auth/me` returns 401 in prod, that would mean Access is misconfigured (shouldn't happen once the custom domain + Access app are live). In dev, `DEV_FALLBACK_USER` ensures 200.

### Hook updates

`useConnections(userId, syncChangeTick)` stays — just fed from the App-level userId. Same for other hooks. Minimal change: deprecate any call site that was deriving userId from the URL path.

### `.dev.vars.example`

Add:

```
DEV_FALLBACK_USER=your-email@example.com
```

### Smoke

- [ ] **Step 1: Start dev server**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npm run dev
```

- [ ] **Step 2: Test dev-mode auth fallback**

Hit http://localhost:5173 in a fresh incognito. Expect app loads normally using `DEV_FALLBACK_USER` as the userId. If sync list is empty → good, fresh user.

- [ ] **Step 3: Deploy to prod**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npx wrangler deploy
```

Confirm the deploy output shows the custom domain `sauna.ronit.one`, and that the workers.dev URL is DISABLED (because of `workers_dev: false`).

- [ ] **Step 4: Test prod auth**

Hit `https://sauna.ronit.one` in a fresh incognito. Expect Cloudflare's Access sign-in page → Google OAuth → back to app with your email as userId.

- [ ] **Step 5: Test path-userId mismatch defense-in-depth**

While signed in as `me@domain.com`, open browser devtools, run:

```js
fetch("/api/user/someone-else@domain.com/syncs-summary").then((r) => r.status);
```

Expect 403 (user_id_mismatch).

- [ ] **Step 6: Test SSRF denylist**

Ask agent: "Use run_in_sync to fetch('http://169.254.169.254/latest/meta-data/') — I'm verifying SSRF protection." Expect 403 `denied_host` surfaced through the tool result.

- [ ] **Step 7: Test agent-declared hosts end-to-end**

Pick a new integration not in the Tier 1 catalog (e.g., PostHog, PagerDuty). Connect it via Pipedream (if it's in Pipedream's 2500+ catalog). Ask agent:

> "Create a sync for PostHog webhooks tracking event_captured. Use fetch_docs to find the signing algorithm and the API hostnames. Declare the hosts at create_sync."

Expected: agent calls fetch_docs on PostHog's docs, drafts all four handler exports, declares `api_hosts: ["app.posthog.com", ...]`, create_sync fires, webhook registers via Pipedream, event lands.

- [ ] **Step 8: Push branch + open PR**

```bash
git push -u origin feat/auth-and-allowlist
gh pr create --title "feat: Cloudflare Access + agent-declared egress allowlist" --body "..."
```

- [ ] **Step 9: Clean up prod secrets**

Old `LINEAR_ACCESS_TOKEN` was removed in Phase D. No new secrets needed from this phase — Cloudflare Access uses Cloudflare's own identity infrastructure, not secrets we manage.

---

## Self-Review Checklist

**1. Spec coverage:**

- ✅ Cloudflare Access handles auth — unforgeable userId, no secrets to manage in the Worker.
- ✅ `workers_dev: false` closes the backdoor so the Access-protected custom domain is the only front door.
- ✅ Webhook routes stay open via Access's bypass policy (upstreams POST without auth).
- ✅ Defense-in-depth path-userId check catches developer mistakes.
- ✅ Dev-mode fallback lets `npm run dev` work without Access.
- ✅ `api_hosts` columns on `connected_accounts` and `syncs`.
- ✅ Catalog populates at connect time.
- ✅ Agent declares additional hosts at create_sync.
- ✅ SSRF denylist absolute floor.
- ✅ Zero hardcoded host enums in supervisor (`host-mapping.ts` deleted).

**2. Type consistency:**

- `userId` is the authenticated email everywhere — URL paths, DO name (`idFromName(email)`), connected_accounts rows, session context.
- `api_hosts` is `string[]` in the type, `TEXT` (JSON) in SQLite. Encode/decode at the helper-layer boundary.
- `resolveEgressAccount` returns `{accountId, appSlug} | null` consistently.

**3. Trust-model coverage:**

- Trust boundary: user ↔ their authenticated agent (Access-verified).
- Agent-declared hosts are still approval-gated at create_sync (user sees them before anything runs).
- SSRF denylist is an absolute floor — no declaration can weaken it.
- Webhook endpoints authenticate via per-sync signature (Phase C).

**4. What could go wrong (and doesn't):**

- Reviewer can't sign in → fixed by adding their email to the Access policy.
- Dev-mode testing without Access → `DEV_FALLBACK_USER` provides the userId.
- Someone hits the `*.workers.dev` URL directly to bypass Access → blocked by `workers_dev: false`.
- Agent declares `evil.com` as api_host → user sees it in approval dialog, refuses.
- Access outage → app unreachable (acceptable risk; Cloudflare Access has very high uptime).

---

## Future Work (noted, not planned here)

- **Verify `cf-access-jwt-assertion` JWT instead of trusting the email header.** The JWT is RS256-signed by Cloudflare and has `iss`, `aud`, `sub`, `email` claims. Belt-and-suspenders even if `workers_dev: false` is in place. Adds ~30 lines (fetch JWKs, jose.jwtVerify). Skipped here because `workers_dev: false` is sufficient.
- **Dynamic app catalog from Pipedream `/v1/apps`.** UI dropdown still uses static APP_OPTIONS from Phase A. Fetching the 2500+ app list at mount would be thesis-pure. Low-risk, 1-hour follow-up.
- **Stable userId (sub) instead of email.** Email can change at the IdP. Using Cloudflare Access's user UUID would be more stable. For the trial email is fine.
- **Per-sync egress constraint.** Any sync's declared hosts are reachable from any other sync (user-scoped). A stricter model would scope declarations to the declaring sync only. Blocks the cross-integration pattern (Linear handler calling GitHub); we deliberately left this enabled per Phase B's threat-model.
- **Link existing UUID-keyed data to Google email.** Current plan orphans old syncs. One-time linking flow could migrate; out of scope.
- **Rate-limit Access sign-in attempts.** Cloudflare does this at the edge by default; no action needed in the Worker.
