# Phase A: Pipedream Plumbing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the foundation for Pipedream Connect: the per-user OAuth/account-connection flow, supervisor storage for those connections, and a short-lived-token mint endpoint for the frontend popup. After this phase, a user can click "Connect an app" in our UI, grant access via Pipedream's popup, and the resulting `account_id` lands in our supervisor SQLite keyed on `(user_id, app_slug)`. Nothing actually *uses* those credentials yet — that's Phase B (gateway routing).

**Architecture:**
- No Pipedream Node SDK on the server — the backend dance is 2 simple HTTP endpoints (`POST /oauth/token` for the bearer + `POST /connect/{projectId}/tokens` for the connect token), so we call them with raw `fetch`. Keeps the CF Workers bundle clean and avoids SDK runtime-compat risk.
- The Pipedream OAuth bearer access_token (the one WE get in exchange for client_id/client_secret) has a 1h TTL — we cache it in a module-level Map keyed on the client_id. Each DO isolate gets its own cache copy; cold refresh on miss.
- New supervisor SQLite table `connected_accounts (user_id, app_slug, account_id, connected_at)`.
- Three new HTTP routes on the existing Hono app: token mint, account persist, accounts list. All scoped by path userId (matches the existing `/api/user/:userId/...` convention).
- Frontend: install `@pipedream/sdk` (browser code), add a Connections panel inside the existing ops sidebar, wire the `connectAccount()` popup flow. SDK → our token endpoint → Pipedream OAuth → callback → our account endpoint.

**Tech Stack:** Hono routes, Cloudflare Workers, Durable Object SQL, Vitest + pool-workers for backend tests, React + `@pipedream/sdk` on the frontend.

**Branch:** `feat/pipedream` (already created).

---

## File Structure

**New files:**
- `src/pipedream/api.ts` — Pure pipedream-facing HTTP calls: `getAccessToken(env)`, `createConnectToken(env, accessToken, externalUserId)`. No caching — just the network dance.
- `src/pipedream/token-cache.ts` — Module-level cache for the bearer access_token. Exposes `getCachedAccessToken(env)` that returns a valid token, refreshing if expired.
- `src/pipedream/index.ts` — Re-exports for a clean import surface.
- `src/db/connected-accounts.ts` — CRUD helpers for the `connected_accounts` table: `upsertConnectedAccount`, `listConnectedAccounts`, `deleteConnectedAccount`.
- `src/pipedream/api.test.ts` — Unit tests for the HTTP calls (fetch mocked).
- `src/pipedream/token-cache.test.ts` — Unit tests for cache hit/miss/expiry.
- `src/db/connected-accounts.test.ts` — CRUD unit tests using the fake SQL helper pattern the codebase already uses.
- `src/ui/ConnectionsPanel.tsx` — React component: lists user's connections + an "Add connection" button that opens the SDK popup.
- `src/ui/useConnections.ts` — React hook: fetches `/api/user/:userId/pipedream/accounts`; auto-refetches on `syncChangeTick`.

**Modified files:**
- `src/db/schema.ts` — add `connected_accounts` table to the migration array.
- `src/db/types.ts` — add `ConnectedAccount` + `NewConnectedAccount` types.
- `src/server.ts` — register three new Hono routes: `GET /api/user/:userId/pipedream/accounts`, `POST /api/user/:userId/pipedream/token`, `POST /api/user/:userId/pipedream/account`.
- `src/app.tsx` — render the `ConnectionsPanel` inside the existing `SyncPanel` sidebar.
- `package.json` — add `@pipedream/sdk` as a dep.

**Infrastructure (not a code task, handled manually between deploy steps):**
- `wrangler secret put PIPEDREAM_PROJECT_ID/CLIENT_ID/CLIENT_SECRET/ENVIRONMENT` — done after Phase F deploy, not part of this plan's automation.

---

## Task 1: DB schema — `connected_accounts` table

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/db/types.ts`

**Context:** Supervisor SQLite already has `syncs` and `sync_errors` tables. `applySchemaMigrations` is called idempotently on every DO start. We add one more table using the same pattern.

- [ ] **Step 1: Add the type**

In `src/db/types.ts`, append:

```ts
export interface ConnectedAccount {
  user_id: string;
  app_slug: string;        // e.g., "github", "slack", "notion"
  account_id: string;      // Pipedream's account id, e.g., "apn_XxxXxxx"
  connected_at: number;    // Unix ms
}

export type NewConnectedAccount = ConnectedAccount;
```

- [ ] **Step 2: Add the migration**

In `src/db/schema.ts`, find the existing `MIGRATIONS` / `applySchemaMigrations` logic. Append a new migration step that creates the table (using the same pattern as the existing `syncs` table migration — should be `CREATE TABLE IF NOT EXISTS`):

```sql
CREATE TABLE IF NOT EXISTS connected_accounts (
  user_id TEXT NOT NULL,
  app_slug TEXT NOT NULL,
  account_id TEXT NOT NULL,
  connected_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, app_slug)
);
```

The primary key `(user_id, app_slug)` means "one account per user per app" — re-connecting the same app overwrites (via `INSERT OR REPLACE`). Multi-account-per-app (e.g., two Slack workspaces) is out of scope for Phase A.

- [ ] **Step 3: Run the full check to confirm the migration compiles**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npm run check`
Expected: PASS (including tests that invoke `applySchemaMigrations`).

- [ ] **Step 4: Commit**

```bash
git add src/db/schema.ts src/db/types.ts
git commit -m "feat(pipedream): connected_accounts table + types"
```

---

## Task 2: DB CRUD helpers

**Files:**
- Create: `src/db/connected-accounts.ts`
- Create: `src/db/connected-accounts.test.ts`

**Context:** Three helpers — `upsertConnectedAccount(sql, row)`, `listConnectedAccounts(sql, user_id)`, `deleteConnectedAccount(sql, user_id, app_slug)`. Follow the style used in `src/db/syncs.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/db/connected-accounts.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:test";
import { ChatAgent } from "../server";
import { applySchemaMigrations } from "./schema";
import {
  upsertConnectedAccount,
  listConnectedAccounts,
  deleteConnectedAccount
} from "./connected-accounts";
import type { ConnectedAccount } from "./types";

function sample(partial: Partial<ConnectedAccount> = {}): ConnectedAccount {
  return {
    user_id: "u-1",
    app_slug: "github",
    account_id: "apn_abc",
    connected_at: 1_000,
    ...partial
  };
}

async function withFreshDO<T>(fn: (sql: (s: TemplateStringsArray, ...v: unknown[]) => unknown) => T): Promise<T> {
  const id = env.ChatAgent.idFromName(crypto.randomUUID());
  const stub = env.ChatAgent.get(id);
  return runInDurableObject(stub, async (instance) => {
    const sql = (instance as unknown as { sql: unknown }).sql as never;
    applySchemaMigrations(sql);
    return fn(sql);
  });
}

describe("connected_accounts CRUD", () => {
  it("upsert inserts a new row", async () => {
    await withFreshDO((sql) => {
      upsertConnectedAccount(sql, sample());
      const rows = listConnectedAccounts(sql, "u-1");
      expect(rows).toEqual([sample()]);
    });
  });

  it("upsert replaces on (user_id, app_slug) collision", async () => {
    await withFreshDO((sql) => {
      upsertConnectedAccount(sql, sample({ account_id: "apn_old", connected_at: 1 }));
      upsertConnectedAccount(sql, sample({ account_id: "apn_new", connected_at: 2 }));
      const rows = listConnectedAccounts(sql, "u-1");
      expect(rows).toEqual([sample({ account_id: "apn_new", connected_at: 2 })]);
    });
  });

  it("listConnectedAccounts scopes by user_id", async () => {
    await withFreshDO((sql) => {
      upsertConnectedAccount(sql, sample({ user_id: "u-1", app_slug: "github" }));
      upsertConnectedAccount(sql, sample({ user_id: "u-2", app_slug: "github" }));
      expect(listConnectedAccounts(sql, "u-1")).toHaveLength(1);
      expect(listConnectedAccounts(sql, "u-1")[0].user_id).toBe("u-1");
    });
  });

  it("delete removes the matching row", async () => {
    await withFreshDO((sql) => {
      upsertConnectedAccount(sql, sample());
      expect(listConnectedAccounts(sql, "u-1")).toHaveLength(1);
      deleteConnectedAccount(sql, "u-1", "github");
      expect(listConnectedAccounts(sql, "u-1")).toHaveLength(0);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npx vitest run src/db/connected-accounts.test.ts`
Expected: FAIL with "Cannot find module './connected-accounts'".

- [ ] **Step 3: Write the implementation**

```ts
// src/db/connected-accounts.ts
import type { ConnectedAccount, NewConnectedAccount, SqlTag } from "./types";

export function upsertConnectedAccount(
  sql: SqlTag,
  row: NewConnectedAccount
): void {
  sql`
    INSERT OR REPLACE INTO connected_accounts
      (user_id, app_slug, account_id, connected_at)
    VALUES (${row.user_id}, ${row.app_slug}, ${row.account_id}, ${row.connected_at})
  `;
}

export function listConnectedAccounts(
  sql: SqlTag,
  user_id: string
): ConnectedAccount[] {
  return sql<ConnectedAccount>`
    SELECT user_id, app_slug, account_id, connected_at
    FROM connected_accounts
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
```

If the `sql` tag's type parameterization in this codebase differs (e.g., `SqlTag` is a different shape), inspect `src/db/syncs.ts` and mirror its style exactly.

- [ ] **Step 4: Run tests to verify they pass**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npx vitest run src/db/connected-accounts.test.ts`
Expected: PASS (4/4).

- [ ] **Step 5: Commit**

```bash
git add src/db/connected-accounts.ts src/db/connected-accounts.test.ts
git commit -m "feat(pipedream): connected_accounts CRUD helpers"
```

---

## Task 3: Pipedream HTTP dance — `src/pipedream/api.ts`

**Files:**
- Create: `src/pipedream/api.ts`
- Create: `src/pipedream/api.test.ts`

**Context:** Two pure async functions that hit Pipedream's REST API directly (no SDK). No caching here — caching is Task 4.

API contract for both endpoints, from Pipedream docs:

**1. `POST https://api.pipedream.com/v1/oauth/token`**
Body: `{grant_type: "client_credentials", client_id, client_secret}`
Response: `{access_token: string, expires_in: number, token_type: "Bearer"}`

**2. `POST https://api.pipedream.com/v1/connect/{projectId}/tokens`**
Headers: `Authorization: Bearer {accessToken}`, `Content-Type: application/json`, `X-PD-Environment: development | production`
Body: `{external_user_id: string, allowed_origins?: string[]}`
Response: `{token: string, expires_at: string, connect_link_url: string}` (token fields may vary slightly — normalize to `{token, connect_link_url}` in our return).

- [ ] **Step 1: Write failing tests (fetch mocked)**

```ts
// src/pipedream/api.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { getAccessToken, createConnectToken } from "./api";

const makeEnv = (): Env =>
  ({
    PIPEDREAM_CLIENT_ID: "cid",
    PIPEDREAM_CLIENT_SECRET: "csec",
    PIPEDREAM_PROJECT_ID: "proj_xyz",
    PIPEDREAM_ENVIRONMENT: "development"
  }) as unknown as Env;

describe("getAccessToken", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs to /v1/oauth/token and returns the token + expiry", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "pd_access_xyz",
          expires_in: 3600,
          token_type: "Bearer"
        }),
        { status: 200 }
      )
    );
    const res = await getAccessToken(makeEnv());
    expect(res).toEqual({ accessToken: "pd_access_xyz", expiresInSeconds: 3600 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://api.pipedream.com/v1/oauth/token");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({
      grant_type: "client_credentials",
      client_id: "cid",
      client_secret: "csec"
    });
  });

  it("throws on non-2xx response with body context", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("bad creds", { status: 401 })
    );
    await expect(getAccessToken(makeEnv())).rejects.toThrow(/401/);
  });
});

describe("createConnectToken", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs to /v1/connect/{projectId}/tokens with bearer + env header", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          token: "ctok_abc",
          expires_at: "2099-01-01T00:00:00Z",
          connect_link_url: "https://pipedream.com/_static/connect.html?token=ctok_abc"
        }),
        { status: 200 }
      )
    );
    const res = await createConnectToken(makeEnv(), "pd_access_xyz", "external-user-1");
    expect(res).toEqual({
      token: "ctok_abc",
      connectLinkUrl: "https://pipedream.com/_static/connect.html?token=ctok_abc"
    });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://api.pipedream.com/v1/connect/proj_xyz/tokens");
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer pd_access_xyz");
    expect(headers.get("X-PD-Environment")).toBe("development");
    expect(JSON.parse(init?.body as string)).toEqual({
      external_user_id: "external-user-1"
    });
  });

  it("throws on non-2xx response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("nope", { status: 500 })
    );
    await expect(
      createConnectToken(makeEnv(), "pd_access_xyz", "u-1")
    ).rejects.toThrow(/500/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npx vitest run src/pipedream/api.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write the implementation**

```ts
// src/pipedream/api.ts

/**
 * Low-level Pipedream REST calls. No caching — see token-cache.ts for
 * the cached bearer access_token dance. Kept pure so unit tests can
 * mock `fetch` without touching cache state.
 *
 * Refs:
 * - POST /v1/oauth/token: https://pipedream.com/docs/rest-api/auth/#oauth
 * - POST /v1/connect/{projectId}/tokens: https://pipedream.com/docs/connect/managed-auth/tokens
 */

export interface AccessTokenResult {
  accessToken: string;
  expiresInSeconds: number;
}

export interface ConnectTokenResult {
  token: string;
  connectLinkUrl: string;
}

export async function getAccessToken(env: Env): Promise<AccessTokenResult> {
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
    const detail = await res.text().catch(() => "");
    throw new Error(
      `Pipedream getAccessToken failed: ${res.status} ${res.statusText} — ${detail.slice(0, 200)}`
    );
  }
  const body = (await res.json()) as {
    access_token: string;
    expires_in: number;
  };
  return { accessToken: body.access_token, expiresInSeconds: body.expires_in };
}

export async function createConnectToken(
  env: Env,
  accessToken: string,
  externalUserId: string
): Promise<ConnectTokenResult> {
  const res = await fetch(
    `https://api.pipedream.com/v1/connect/${env.PIPEDREAM_PROJECT_ID}/tokens`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
        "X-PD-Environment": env.PIPEDREAM_ENVIRONMENT
      },
      body: JSON.stringify({ external_user_id: externalUserId })
    }
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `Pipedream createConnectToken failed: ${res.status} ${res.statusText} — ${detail.slice(0, 200)}`
    );
  }
  const body = (await res.json()) as {
    token: string;
    connect_link_url: string;
  };
  return { token: body.token, connectLinkUrl: body.connect_link_url };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npx vitest run src/pipedream/api.test.ts`
Expected: PASS (4/4).

- [ ] **Step 5: Commit**

```bash
git add src/pipedream/api.ts src/pipedream/api.test.ts
git commit -m "feat(pipedream): low-level REST API calls (token + connect-token)"
```

---

## Task 4: Bearer token cache

**Files:**
- Create: `src/pipedream/token-cache.ts`
- Create: `src/pipedream/token-cache.test.ts`

**Context:** Pipedream's bearer access_token has an `expires_in` (typically 3600s). Fetching on every request wastes ~200ms + a fetch budget. Cache it per-isolate in a module-level Map keyed on `PIPEDREAM_CLIENT_ID`, refresh on miss or near-expiry. Each DO isolate gets its own copy; that's fine — cache miss cost is one HTTP call.

Refresh threshold: 60 seconds before expiry. Avoids a race where we hand out a token that expires mid-flight.

- [ ] **Step 1: Write failing tests**

```ts
// src/pipedream/token-cache.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { getCachedAccessToken, _clearCacheForTests } from "./token-cache";
import * as api from "./api";

const makeEnv = (): Env =>
  ({
    PIPEDREAM_CLIENT_ID: "cid",
    PIPEDREAM_CLIENT_SECRET: "csec",
    PIPEDREAM_PROJECT_ID: "proj_xyz",
    PIPEDREAM_ENVIRONMENT: "development"
  }) as unknown as Env;

describe("getCachedAccessToken", () => {
  beforeEach(() => {
    _clearCacheForTests();
    vi.restoreAllMocks();
  });

  it("calls getAccessToken on first request", async () => {
    const spy = vi.spyOn(api, "getAccessToken").mockResolvedValue({
      accessToken: "t1",
      expiresInSeconds: 3600
    });
    const tok = await getCachedAccessToken(makeEnv());
    expect(tok).toBe("t1");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("returns cached token on second request within TTL", async () => {
    const spy = vi.spyOn(api, "getAccessToken").mockResolvedValue({
      accessToken: "t1",
      expiresInSeconds: 3600
    });
    await getCachedAccessToken(makeEnv());
    await getCachedAccessToken(makeEnv());
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("refreshes when the token is within 60s of expiry", async () => {
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValue(0);
    const apiSpy = vi
      .spyOn(api, "getAccessToken")
      .mockResolvedValueOnce({ accessToken: "t1", expiresInSeconds: 60 })
      .mockResolvedValueOnce({ accessToken: "t2", expiresInSeconds: 3600 });
    await getCachedAccessToken(makeEnv()); // token expires at 60s
    nowSpy.mockReturnValue(5_000); // advance to 5s — cached
    await getCachedAccessToken(makeEnv());
    expect(apiSpy).toHaveBeenCalledTimes(1);
    nowSpy.mockReturnValue(10_000); // advance to 10s — still 50s to go, under threshold, refresh
    const tok = await getCachedAccessToken(makeEnv());
    expect(tok).toBe("t2");
    expect(apiSpy).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npx vitest run src/pipedream/token-cache.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write the implementation**

```ts
// src/pipedream/token-cache.ts
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
    usableUntilMs: Date.now() + fresh.expiresInSeconds * 1000 - REFRESH_MARGIN_MS
  });
  return fresh.accessToken;
}

/** Test-only escape hatch. Never use from production code. */
export function _clearCacheForTests(): void {
  cache.clear();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npx vitest run src/pipedream/token-cache.test.ts`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add src/pipedream/token-cache.ts src/pipedream/token-cache.test.ts
git commit -m "feat(pipedream): module-level bearer access_token cache"
```

---

## Task 5: Pipedream module index

**Files:**
- Create: `src/pipedream/index.ts`

Re-exports for clean consumer imports.

- [ ] **Step 1: Write the file**

```ts
// src/pipedream/index.ts
export { getAccessToken, createConnectToken } from "./api";
export type { AccessTokenResult, ConnectTokenResult } from "./api";
export { getCachedAccessToken } from "./token-cache";
```

- [ ] **Step 2: Verify compile**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/pipedream/index.ts
git commit -m "feat(pipedream): module barrel"
```

---

## Task 6: Hono routes — token / account / accounts

**Files:**
- Modify: `src/server.ts`
- Modify: `src/server.ts` (same file, different test) OR `tests/pipedream-routes.test.ts`
- Create: `tests/pipedream-routes.test.ts`

**Context:** Three new routes, all under `/api/user/:userId/pipedream/*`:

1. `POST /api/user/:userId/pipedream/token` — mints a short-lived Pipedream connect token for `:userId`. Returns `{token, connectLinkUrl}`.
2. `POST /api/user/:userId/pipedream/account` — body `{app_slug, account_id}`; upserts into `connected_accounts`. Returns `{ok: true}`.
3. `GET /api/user/:userId/pipedream/accounts` — returns `{accounts: ConnectedAccount[]}` for the user.

Existing routes like `/api/user/:userId/syncs-summary` are the model — look at their Hono handler shape in `src/server.ts` (the Hono app section) and mirror it.

**Note:** The connected-accounts routes route to the supervisor DO (which owns the SQLite). The pattern from ops-panel routes already uses a DO RPC call. For token minting, the DO doesn't strictly need to be involved — token minting is pure fetch — but routing through the DO keeps user scoping consistent. Decide based on the existing pattern.

- [ ] **Step 1: Write failing integration tests**

```ts
// tests/pipedream-routes.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { SELF } from "cloudflare:test";

// Mock the pipedream api module so we don't hit the network.
vi.mock("../src/pipedream/api", () => ({
  getAccessToken: vi.fn().mockResolvedValue({
    accessToken: "pd_access_test",
    expiresInSeconds: 3600
  }),
  createConnectToken: vi.fn().mockResolvedValue({
    token: "ctok_test",
    connectLinkUrl: "https://pipedream.com/_static/connect.html?token=ctok_test"
  })
}));

describe("Pipedream HTTP routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("POST /api/user/:userId/pipedream/token returns {token, connectLinkUrl}", async () => {
    const userId = crypto.randomUUID();
    const res = await SELF.fetch(
      `https://test/api/user/${userId}/pipedream/token`,
      { method: "POST" }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      token: "ctok_test",
      connectLinkUrl:
        "https://pipedream.com/_static/connect.html?token=ctok_test"
    });
  });

  it("POST /api/user/:userId/pipedream/account persists the mapping", async () => {
    const userId = crypto.randomUUID();
    const res = await SELF.fetch(
      `https://test/api/user/${userId}/pipedream/account`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          app_slug: "github",
          account_id: "apn_gh"
        })
      }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("GET /api/user/:userId/pipedream/accounts returns prior upserts", async () => {
    const userId = crypto.randomUUID();
    // Seed via POST
    await SELF.fetch(`https://test/api/user/${userId}/pipedream/account`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_slug: "slack", account_id: "apn_sl" })
    });
    const res = await SELF.fetch(
      `https://test/api/user/${userId}/pipedream/accounts`
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      accounts: Array<{ app_slug: string; account_id: string }>;
    };
    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0]).toMatchObject({
      app_slug: "slack",
      account_id: "apn_sl"
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npx vitest run tests/pipedream-routes.test.ts`
Expected: FAIL (404 or route not registered).

- [ ] **Step 3: Wire up the three routes in `src/server.ts`**

Locate the existing Hono `app` definition in `src/server.ts` where `/api/user/:userId/syncs-summary` and similar are defined. Add three new routes. The pattern for DO-backed routes follows the existing ones — call into a ChatAgent method via `env.ChatAgent.get(idFromName(userId))`. Add three new `ChatAgent` methods to match:

```ts
// In ChatAgent class:

async mintPipedreamToken(userId: string): Promise<{ token: string; connectLinkUrl: string }> {
  await this.setName(userId);
  const { getCachedAccessToken, createConnectToken } = await import("./pipedream");
  const accessToken = await getCachedAccessToken(this.env);
  return createConnectToken(this.env, accessToken, userId);
}

async persistPipedreamAccount(
  userId: string,
  app_slug: string,
  account_id: string
): Promise<void> {
  await this.setName(userId);
  const { upsertConnectedAccount } = await import("./db/connected-accounts");
  upsertConnectedAccount(this.sql.bind(this), {
    user_id: userId,
    app_slug,
    account_id,
    connected_at: Date.now()
  });
  this.#bumpChangeTick();
}

async listPipedreamAccounts(userId: string): Promise<ConnectedAccount[]> {
  await this.setName(userId);
  const { listConnectedAccounts } = await import("./db/connected-accounts");
  return listConnectedAccounts(this.sql.bind(this), userId);
}
```

Then three Hono handlers in the app definition:

```ts
app.post("/api/user/:userId/pipedream/token", async (c) => {
  const userId = c.req.param("userId");
  const stub = env.ChatAgent.get(env.ChatAgent.idFromName(userId));
  const result = await stub.mintPipedreamToken(userId);
  return c.json(result);
});

app.post("/api/user/:userId/pipedream/account", async (c) => {
  const userId = c.req.param("userId");
  const body = await c.req.json<{ app_slug: string; account_id: string }>();
  if (!body.app_slug || !body.account_id) {
    return c.json({ error: "missing_fields" }, 400);
  }
  const stub = env.ChatAgent.get(env.ChatAgent.idFromName(userId));
  await stub.persistPipedreamAccount(userId, body.app_slug, body.account_id);
  return c.json({ ok: true });
});

app.get("/api/user/:userId/pipedream/accounts", async (c) => {
  const userId = c.req.param("userId");
  const stub = env.ChatAgent.get(env.ChatAgent.idFromName(userId));
  const accounts = await stub.listPipedreamAccounts(userId);
  return c.json({ accounts });
});
```

**Gotcha:** `env` isn't a magic variable in Hono — the existing routes pull it from the context `c.env`. Mirror whatever the existing `/api/user/:userId/syncs-summary` route does. Also: import `ConnectedAccount` type in server.ts.

- [ ] **Step 4: Run tests to verify they pass**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npx vitest run tests/pipedream-routes.test.ts`
Expected: PASS (3/3).

- [ ] **Step 5: Run full check**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npm run check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server.ts tests/pipedream-routes.test.ts
git commit -m "feat(pipedream): HTTP routes for token mint + account persist + list"
```

---

## Task 7: Frontend — install `@pipedream/sdk`

**Files:**
- Modify: `package.json` (implicit via `npm install`)
- Modify: `package-lock.json` (implicit)

- [ ] **Step 1: Install**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npm install @pipedream/sdk`
Expected: installed without peer-dep warnings that break the build.

- [ ] **Step 2: Confirm the frontend bundle still builds**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npx vite build 2>&1 | tail -20`
Expected: builds successfully. If Pipedream's SDK references Node-only APIs in browser-targeted imports, we'll need a different client path — flag as BLOCKED.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat(pipedream): install @pipedream/sdk for frontend"
```

---

## Task 8: `useConnections` hook

**Files:**
- Create: `src/ui/useConnections.ts`

**Context:** Mirrors the pattern of `src/ui/useSyncsSummary.ts`. Fetches `/api/user/:userId/pipedream/accounts`, refetches on `syncChangeTick` changes (so when a new connection is persisted, the UI updates).

- [ ] **Step 1: Write the hook**

```ts
// src/ui/useConnections.ts
import { useCallback, useEffect, useState } from "react";

export interface ConnectionSummary {
  app_slug: string;
  account_id: string;
  connected_at: number;
}

export function useConnections(userId: string, syncChangeTick: number) {
  const [connections, setConnections] = useState<ConnectionSummary[] | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/user/${userId}/pipedream/accounts`);
      if (!res.ok) {
        setError(`HTTP ${res.status}`);
        return;
      }
      const body = (await res.json()) as { accounts: ConnectionSummary[] };
      setConnections(body.accounts);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [userId]);

  useEffect(() => {
    void refetch();
  }, [refetch, syncChangeTick]);

  return { connections, error, refetch };
}
```

- [ ] **Step 2: Verify compile**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/ui/useConnections.ts
git commit -m "feat(pipedream): useConnections hook"
```

---

## Task 9: `ConnectionsPanel` component

**Files:**
- Create: `src/ui/ConnectionsPanel.tsx`

**Context:** Visual surface. Lists the user's connected apps + an "Add connection" button that opens the Pipedream SDK popup. Follows the Kumo design system used elsewhere in the app (see `src/ui/SyncPanel.tsx` for reference).

The SDK flow:
1. Component calls our backend `/api/user/:userId/pipedream/token` to mint a token.
2. Initialize `PipedreamClient` (frontend SDK) with `{externalUserId, tokenCallback: () => token, projectEnvironment: "development"}`.
3. Call `client.connectAccount({app: "github" | ..., onSuccess, onError})`.
4. On success: POST to `/api/user/:userId/pipedream/account` with `{app_slug, account_id}`.
5. Trigger re-fetch of connections.

For Phase A we don't need a polished app-picker — a simple dropdown of 3-4 common apps (github, slack, notion, google_sheets) is enough.

- [ ] **Step 1: Write the component**

```tsx
// src/ui/ConnectionsPanel.tsx
import { useCallback, useState } from "react";
import { createFrontendClient } from "@pipedream/sdk/browser";
import { useConnections, type ConnectionSummary } from "./useConnections";

const APP_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "github", label: "GitHub" },
  { value: "slack", label: "Slack" },
  { value: "notion", label: "Notion" },
  { value: "google_sheets", label: "Google Sheets" }
];

interface Props {
  userId: string;
  syncChangeTick: number;
  onConnectionAdded: () => void;
}

export function ConnectionsPanel({
  userId,
  syncChangeTick,
  onConnectionAdded
}: Props) {
  const { connections, error } = useConnections(userId, syncChangeTick);
  const [pending, setPending] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [selectedApp, setSelectedApp] = useState<string>(APP_OPTIONS[0].value);

  const handleConnect = useCallback(async () => {
    setConnectError(null);
    setPending(selectedApp);
    try {
      const client = createFrontendClient({
        externalUserId: userId,
        tokenCallback: async () => {
          const res = await fetch(`/api/user/${userId}/pipedream/token`, {
            method: "POST"
          });
          if (!res.ok) throw new Error(`token mint failed: ${res.status}`);
          const body = (await res.json()) as { token: string };
          return body.token;
        }
      });
      await new Promise<void>((resolve, reject) => {
        client.connectAccount({
          app: selectedApp,
          onSuccess: async (account: { id: string }) => {
            try {
              const res = await fetch(
                `/api/user/${userId}/pipedream/account`,
                {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    app_slug: selectedApp,
                    account_id: account.id
                  })
                }
              );
              if (!res.ok) throw new Error(`persist failed: ${res.status}`);
              onConnectionAdded();
              resolve();
            } catch (e) {
              reject(e);
            }
          },
          onError: (err: { message: string }) => {
            reject(new Error(err.message));
          }
        });
      });
    } catch (e) {
      setConnectError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(null);
    }
  }, [userId, selectedApp, onConnectionAdded]);

  return (
    <div className="px-3 py-4 border-t border-kumo-line">
      <div className="mb-2 text-xs uppercase tracking-wide text-kumo-muted">
        Connections
      </div>
      {error && (
        <div className="text-xs text-red-500 mb-2">Error: {error}</div>
      )}
      <ul className="space-y-1 mb-3">
        {(connections ?? []).length === 0 ? (
          <li className="text-xs text-kumo-muted">No connections yet.</li>
        ) : (
          (connections ?? []).map((c: ConnectionSummary) => (
            <li key={`${c.app_slug}:${c.account_id}`} className="text-xs">
              <span className="text-kumo-text">{c.app_slug}</span>
              <span className="text-kumo-muted ml-2">{c.account_id}</span>
            </li>
          ))
        )}
      </ul>
      <div className="flex items-center gap-2">
        <select
          className="flex-1 text-xs bg-kumo-base border border-kumo-line rounded px-2 py-1"
          value={selectedApp}
          onChange={(e) => setSelectedApp(e.target.value)}
          disabled={pending !== null}
        >
          {APP_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={handleConnect}
          disabled={pending !== null}
          className="text-xs px-2 py-1 rounded bg-kumo-accent text-kumo-base disabled:opacity-50"
        >
          {pending === selectedApp ? "Connecting…" : "Connect"}
        </button>
      </div>
      {connectError && (
        <div className="text-xs text-red-500 mt-1">
          Connect failed: {connectError}
        </div>
      )}
    </div>
  );
}
```

**Note:** the `@pipedream/sdk/browser` import path is a guess — verify via `ls node_modules/@pipedream/sdk/dist/` to find the right browser entry. If the SDK exports differ (e.g., `createFrontendClient` vs `PipedreamClient`), adapt to the actual shape. If the SDK doesn't have a browser bundle at all (sometimes their SDK is Node-only), fall back to the Pipedream Connect Link URL flow: instead of popup, window.open(connectLinkUrl) and poll the accounts API for completion. Flag with DONE_WITH_CONCERNS if the SDK can't be used client-side.

- [ ] **Step 2: Verify compile**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/ui/ConnectionsPanel.tsx
git commit -m "feat(pipedream): ConnectionsPanel UI component"
```

---

## Task 10: Mount `ConnectionsPanel` inside the sidebar

**Files:**
- Modify: `src/app.tsx` (or `src/ui/SyncPanel.tsx` depending on layout)

**Context:** The panel needs to render below the existing syncs list in the left sidebar.

- [ ] **Step 1: Find the sidebar definition**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" grep -n "SyncPanel\|<aside" src/app.tsx src/ui/SyncPanel.tsx`
Identify where the syncs list is rendered so you can mount `ConnectionsPanel` directly after it.

- [ ] **Step 2: Import and render**

Import `ConnectionsPanel` into the file that renders the sidebar. Render it after the syncs list, passing `userId`, `syncChangeTick`, and an `onConnectionAdded` callback that triggers whatever refetch mechanism the sidebar already uses (e.g., a manual setter that increments a local counter, or call the existing useSyncsSummary refetch).

Example (adapt to actual file):

```tsx
<ConnectionsPanel
  userId={userId}
  syncChangeTick={syncChangeTick}
  onConnectionAdded={() => {
    // the syncChangeTick bump from the DO's persistPipedreamAccount
    // should trigger useConnections' refetch; no explicit call needed
  }}
/>
```

- [ ] **Step 3: Verify the dev server renders it**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npm run dev 2>&1 | head -20` in the background; hit `http://localhost:5173/` (or whatever port Vite picks), visit `/user/<any-id>`, confirm the Connections panel renders below the syncs list.

Shut down dev server after confirming.

- [ ] **Step 4: Commit**

```bash
git add src/app.tsx src/ui/SyncPanel.tsx
git commit -m "feat(pipedream): mount ConnectionsPanel in sidebar"
```

---

## Task 11: Manual smoke test end-to-end locally

**Files:**
- None (manual verification)

- [ ] **Step 1: Start dev server with .dev.vars loaded**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npm run dev`
Expected: Vite + Cloudflare dev environment up.

- [ ] **Step 2: Open the app, pick a user, click Connect**

- Visit `http://localhost:5173/`
- A userId should be auto-generated (follow existing routing behavior — likely redirect to `/user/<uuid>`).
- Click **Connect** in the Connections panel with "GitHub" selected.
- Pipedream SDK popup opens → grant GitHub access.
- Popup closes → the `github` connection appears in the Connections panel within ~1 second.

- [ ] **Step 3: Verify via API**

```bash
curl -s "http://localhost:5173/api/user/<USERID>/pipedream/accounts" | jq .
```
Expected:
```json
{ "accounts": [{ "user_id": "...", "app_slug": "github", "account_id": "apn_...", "connected_at": ... }] }
```

If anything in the flow fails (popup doesn't open, connection doesn't persist), capture the error from the browser console or server logs and escalate before pushing.

- [ ] **Step 4: Push to the remote feat/pipedream branch**

```bash
git push origin feat/pipedream
```

No CI will fire (deploy.yml is main-only; sanity-check.yml fires on push to main + PRs to main, but not on feature branches directly). The PR itself will trigger sanity-check when we open it at the end of all phases.

---

## Self-Review Checklist

**1. Spec coverage:**
- ✅ Per-user OAuth/connection flow (Task 11 manual test proves the loop).
- ✅ Connection persistence scoped to supervisor user (Task 2 + 6).
- ✅ Access-token caching (Task 4).
- ✅ Frontend UI with connect popup (Tasks 7-10).
- ✅ Integration points for Phase B (HttpGateway) are the `connected_accounts` rows + the cached bearer token.

**2. Placeholder scan:**
- Task 10 Step 2 says "adapt to actual file" — this is intentional because I don't know whether `ConnectionsPanel` should mount in `src/app.tsx` or `src/ui/SyncPanel.tsx`. The implementer should grep for "SyncPanel" use site. Not a placeholder in the sense of "TBD" — it's explicit instruction to read the file.
- Task 9 Step 1 flags `@pipedream/sdk/browser` as a guess pending `ls node_modules` check — that's honest, not a placeholder.

**3. Type consistency:**
- `ConnectedAccount` defined in Task 1, consumed in Task 2 (tests + impl), Task 6 (server.ts list method), Task 8 (hook return shape).
- `AccessTokenResult` / `ConnectTokenResult` defined in Task 3, consumed in Task 4 (cache) and Task 6 (route handler).
- `ConnectionSummary` in Task 8 structurally matches `ConnectedAccount` — same field names. No drift.

---

## Future Work (noted, not planned here)

- **OAuth token revocation on the Pipedream side.** If a user disconnects an app via Pipedream's dashboard, our local `connected_accounts` drifts. Consider a TTL + background reconciliation pass.
- **Per-user multiple accounts per app** (e.g., two Slack workspaces). The current schema primary-key is `(user_id, app_slug)`. Relaxing is a one-field change but adds UI complexity (account picker when making requests).
- **Production environment split.** Today we use `PIPEDREAM_ENVIRONMENT=development` everywhere. Phase B or F should toggle to `production` for prod deploys.
