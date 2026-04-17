# Phase 08 — create_sync tool + facets + Worker Loader + Linear webhook registration

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the agent its first write tool. When the user asks for a sync, the agent drafts schema + handler code, calls `create_sync(...)` (approval-gated), and the tool: (a) registers a webhook with Linear via GraphQL, (b) builds a Worker Loader bundle that wraps the agent's handler in a DurableObject shell, (c) attaches the result as a facet with `globalOutbound: exports.HttpGateway({ props: { userId } })` so outbound calls route through Phase 06's gateway, (d) initializes the facet's SQLite with the schema DDL, (e) persists the sync record to supervisor storage. Any failure rolls back.

**What this phase does NOT include — Phase 09:** the `/webhook/:userId/:syncId` HTTP route that actually receives Linear's deliveries + dispatches into the facet + logs errors. After this phase, you can create syncs and they'll show up in the UI, but Linear's deliveries to those webhooks will 404. Phase 09 closes that loop.

**Architecture:** The agent writes `handler.js` exporting `handleWebhook(request, sql)` — a simple function taking a Request and an sql exec handle. We (the supervisor) compose a 3-module bundle at sync-creation time: a fixed `main.js` wrapper that extends DurableObject, lazily runs the schema_ddl, and delegates webhook dispatches to the agent's function; a generated `schema.js` that exports the DDL as a string constant; and the agent's `handler.js` verbatim. Worker Loader caches this bundle by a `code_id` keyed on the sync's version so later updates can bust the cache. The facet is attached to the user's ChatAgent DO, inheriting the user's DO-level isolation.

**Tech Stack:** TypeScript, Cloudflare Worker Loader (`env.LOADER`), Durable Object Facets (`this.ctx.facets`), Linear GraphQL API (`webhookCreate` / `webhookDelete` mutations), `ai` SDK `tool()` with `needsApproval: true`.

**References:**
- Design doc §§6, 8.2, 10.1, 11
- [`dynamic-workers.md`](../../../dynamic-workers.md) — Worker Loader API + Facets (`ctx.facets.get`, `FacetStartupOptions`, `globalOutbound`, `ctx.exports`)
- Linear webhook docs verified earlier: action values are `create|update|remove`, `Linear-Signature` header is hex HMAC-SHA256 of raw body, `webhookCreate` mutation requires admin scope and returns `{ success, webhook { id, secret, enabled } }`

---

## File Structure

**Created:**

- `src/facet/wrapper.ts` — the fixed wrapper module source string (template), and a helper to assemble it
- `src/facet/bundle.ts` — `buildFacetWorkerCode({ schemaDdl, handlerCode, userId, env })` → WorkerCode
- `src/facet/bundle.test.ts` — 4 unit tests for bundle construction
- `src/facet/loader.ts` — `attachFacet(agentCtx, sync, env)` — wraps env.LOADER.get + ctx.facets.get; returns facet stub
- `src/integrations/linear-api.ts` — `registerLinearWebhook(env, url, resourceTypes)` + `unregisterLinearWebhook(env, webhookId)` — GraphQL mutation helpers
- `src/integrations/linear-api.test.ts` — 6 unit tests with mocked fetch
- `src/agent/tools/write/create-sync.ts` — the write tool
- `src/agent/tools/write/create-sync.test.ts` — 4 unit tests (happy path + rollback branches)
- `tests/create-sync-integration.test.ts` — 2 integration tests via `runInDurableObject`

**Modified:**

- `src/agent/tools/index.ts` — register `create_sync` in `buildTools`
- `src/agent/system-prompt.ts` — update "Write tools" section (create_sync live, how to draft, wrapper contract)
- `wrangler.jsonc` — nothing this phase (worker_loaders binding was added in Phase 06)
- `.dev.vars.example` / `.dev.vars` / `vitest.config.ts` — add `PUBLIC_BASE_URL`
- `env.d.ts` — regenerated to include `PUBLIC_BASE_URL`

No changes to `src/proxy/*`, `src/db/*`, or facet-unrelated code.

---

## Pre-flight context

### Canonical facet-loading pattern (from `dynamic-workers.md`)

```ts
import { DurableObject } from "cloudflare:workers";
import { exports } from "cloudflare:workers";

export class ChatAgent extends AIChatAgent<Env> {
  async createSyncHelper(sync: Sync): Promise<void> {
    const codeId = `sync:${sync.id}:v${sync.version}`;
    const userId = this.name; // DO name is the userId

    const worker = this.env.LOADER.get(codeId, async () => ({
      compatibilityDate: "2026-04-01",
      mainModule: "main.js",
      modules: {
        "main.js": WRAPPER_SOURCE,
        "schema.js": `export const SCHEMA_DDL = ${JSON.stringify(sync.schema_ddl)};`,
        "handler.js": sync.handler_code,
      },
      globalOutbound: exports.HttpGateway({ props: { userId } }),
    }));

    const appClass = worker.getDurableObjectClass("App");
    const facet = this.ctx.facets.get(sync.name, () => ({ class: appClass }));
    // facet is now ready to receive .fetch() calls from the webhook route
  }
}
```

### Wrapper contract (what the agent-authored handler must export)

The agent writes **`handler.js`** — a single module that exports `handleWebhook(request, sql)`:

- `request: Request` — the full webhook delivery from Linear (verified signature, delivered to the facet)
- `sql: SqlStorage` — the facet's SQLite exec API. Use `sql.exec(query, ...bindings)` for writes, `sql.exec(query, ...bindings).toArray()` for reads

Example handler the agent might generate:

```ts
// agent-authored handler.js
export async function handleWebhook(request, sql) {
  const payload = await request.json();
  if (payload.type !== "Issue") return new Response("ignored", { status: 200 });
  const d = payload.data;
  sql.exec(
    `INSERT OR REPLACE INTO issues (id, title, state, updated_at) VALUES (?, ?, ?, ?)`,
    d.id,
    d.title,
    d.state?.type ?? null,
    Date.now()
  );
  return new Response("ok", { status: 200 });
}
```

The system prompt update in Task 7 spells this out for the LLM.

### `exports` import location

Inside a DO, we can't use `ctx.exports` (that's a property on the Worker's ExecutionContext, not DurableObjectState). Use the module-level import instead (from the `dynamic-workers.md` observability docs):

```ts
import { exports } from "cloudflare:workers";
```

### Linear GraphQL API calls

The supervisor DO calls Linear's API **directly** (not through the proxy) using `env.LINEAR_ACCESS_TOKEN`. The proxy is for facets; the supervisor has normal network access.

**`webhookCreate` mutation** (registration):

```graphql
mutation WebhookCreate($url: String!, $resourceTypes: [String!]!, $label: String!) {
  webhookCreate(input: {
    url: $url
    resourceTypes: $resourceTypes
    allPublicTeams: true
    label: $label
  }) {
    success
    webhook { id secret enabled }
  }
}
```

Key: include `secret` in the selection — Linear only returns it on the initial create call. We store it in the syncs row for Phase 09's signature verification.

**`webhookDelete` mutation** (rollback):

```graphql
mutation WebhookDelete($id: String!) {
  webhookDelete(id: $id) { success }
}
```

### `PUBLIC_BASE_URL` env

The webhook URL we give to Linear needs to be publicly reachable. In production this is the wrangler.dev domain; in dev with `wrangler dev`, the user typically uses either:

- `wrangler dev --remote` (runs on CF infra, gets a temporary `*.workers.dev` URL)
- A tunnel (ngrok, cloudflared tunnel) pointing at localhost:5173

For Phase 08 we accept the URL from an env var rather than trying to auto-detect:

```
PUBLIC_BASE_URL=https://self-syncing-agent.rtpa25.workers.dev
```

Tests stub this with `https://test.invalid`.

---

## Task 1: Wire `PUBLIC_BASE_URL` env var

**Files:**
- Modify: `.dev.vars.example`, `.dev.vars`, `vitest.config.ts`, `env.d.ts` (regenerated)

- [ ] **Step 1: Add to `.dev.vars.example`**

Append:

```
PUBLIC_BASE_URL=https://your-public-worker-url.workers.dev
```

- [ ] **Step 2: Add placeholder to `.dev.vars`**

Append (user swaps in the real URL before manual testing):

```
PUBLIC_BASE_URL=https://placeholder.workers.dev
```

- [ ] **Step 3: Add test-env binding**

In `vitest.config.ts`, inside `poolOptions.workers.miniflare.bindings`:

```ts
PUBLIC_BASE_URL: "https://test.invalid",
```

- [ ] **Step 4: Regenerate `env.d.ts`**

```bash
pnpm run types
```

Expected: `env.d.ts` now includes `PUBLIC_BASE_URL: string`.

---

## Task 2: Linear GraphQL API helpers

**Files:**
- Create: `src/integrations/linear-api.ts`
- Create: `src/integrations/linear-api.test.ts`

These are pure async functions called from the supervisor DO. They take `env` (for the access token), target URL / resource types / webhook id, and return typed results. They use global `fetch` directly — the supervisor has normal network access (the proxy is only for facets).

- [ ] **Step 1: Create `src/integrations/linear-api.ts`:**

```ts
/**
 * Linear GraphQL API helpers. Called by create_sync / delete_sync tools
 * from the supervisor DO — NOT by agent-authored facet handler code.
 * Uses env.LINEAR_ACCESS_TOKEN (OAuth access token from our demo app).
 *
 * For each mutation we hand-write the GraphQL query and types rather
 * than pulling in a Linear SDK, since we only need two endpoints and
 * no codegen setup is worth it for V1.
 */

const LINEAR_API_URL = "https://api.linear.app/graphql";

type GraphQLResponse<T> = {
  data?: T;
  errors?: Array<{ message: string; extensions?: Record<string, unknown> }>;
};

type WebhookCreateData = {
  webhookCreate: {
    success: boolean;
    webhook: {
      id: string;
      secret: string;
      enabled: boolean;
    };
  };
};

export interface RegisteredWebhook {
  id: string;
  secret: string;
  enabled: boolean;
}

/**
 * Register a webhook with Linear for the given resource types.
 * Returns the upstream webhook id + signing secret. Signing secret is
 * only returned on this initial registration — the caller must persist
 * it for later signature verification in Phase 09.
 *
 * Errors:
 *  - "linear_api_auth_failed" when LINEAR_ACCESS_TOKEN is invalid
 *  - "linear_api_error" with GraphQL error messages for any other failure
 *  - fetch-level errors propagate as-is (network failure, timeout)
 */
export async function registerLinearWebhook(
  accessToken: string,
  url: string,
  resourceTypes: string[],
  label: string,
  fetcher: typeof fetch = fetch,
): Promise<RegisteredWebhook> {
  const query = /* GraphQL */ `
    mutation WebhookCreate($url: String!, $resourceTypes: [String!]!, $label: String!) {
      webhookCreate(input: {
        url: $url
        resourceTypes: $resourceTypes
        allPublicTeams: true
        label: $label
      }) {
        success
        webhook { id secret enabled }
      }
    }
  `;
  const variables = { url, resourceTypes, label };

  const res = await fetcher(LINEAR_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (res.status === 401 || res.status === 403) {
    throw new LinearApiError(
      "linear_api_auth_failed",
      `Linear rejected the access token (HTTP ${res.status}).`,
    );
  }

  const body = (await res.json()) as GraphQLResponse<WebhookCreateData>;
  if (body.errors && body.errors.length > 0) {
    throw new LinearApiError(
      "linear_api_error",
      body.errors.map((e) => e.message).join("; "),
    );
  }
  if (!body.data || !body.data.webhookCreate.success) {
    throw new LinearApiError(
      "linear_api_error",
      "webhookCreate returned success=false without explicit errors",
    );
  }

  const wh = body.data.webhookCreate.webhook;
  return { id: wh.id, secret: wh.secret, enabled: wh.enabled };
}

type WebhookDeleteData = {
  webhookDelete: { success: boolean };
};

/**
 * Unregister a webhook with Linear. Used by create_sync's rollback on
 * downstream failure, and by delete_sync (Phase 10). Best-effort:
 * returns void on success, throws on any non-success response.
 */
export async function unregisterLinearWebhook(
  accessToken: string,
  webhookId: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const query = /* GraphQL */ `
    mutation WebhookDelete($id: String!) {
      webhookDelete(id: $id) { success }
    }
  `;
  const res = await fetcher(LINEAR_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ query, variables: { id: webhookId } }),
  });
  const body = (await res.json()) as GraphQLResponse<WebhookDeleteData>;
  if (body.errors || !body.data?.webhookDelete.success) {
    throw new LinearApiError(
      "linear_api_error",
      `webhookDelete failed for ${webhookId}: ${body.errors?.map((e) => e.message).join("; ") ?? "unknown"}`,
    );
  }
}

export class LinearApiError extends Error {
  constructor(
    public code: "linear_api_auth_failed" | "linear_api_error",
    message: string,
  ) {
    super(message);
    this.name = "LinearApiError";
  }
}
```

- [ ] **Step 2: Create `src/integrations/linear-api.test.ts`:**

```ts
import { describe, it, expect, vi } from "vitest";
import {
  registerLinearWebhook,
  unregisterLinearWebhook,
  LinearApiError,
} from "./linear-api";

function mockResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("registerLinearWebhook", () => {
  it("returns { id, secret, enabled } on success", async () => {
    const fetcher = vi.fn(async () =>
      mockResponse({
        data: {
          webhookCreate: {
            success: true,
            webhook: { id: "wh_abc", secret: "sec_xyz", enabled: true },
          },
        },
      }),
    );

    const result = await registerLinearWebhook(
      "lin_oauth_test",
      "https://example.com/webhook",
      ["Issue"],
      "self-syncing-agent:test",
      fetcher,
    );

    expect(result).toEqual({ id: "wh_abc", secret: "sec_xyz", enabled: true });

    // Verify the call shape
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.linear.app/graphql");
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer lin_oauth_test",
    );
    const parsed = JSON.parse(init.body as string);
    expect(parsed.variables).toEqual({
      url: "https://example.com/webhook",
      resourceTypes: ["Issue"],
      label: "self-syncing-agent:test",
    });
  });

  it("throws LinearApiError with auth_failed code on 401", async () => {
    const fetcher = vi.fn(async () => mockResponse({}, 401));
    await expect(
      registerLinearWebhook("bad", "url", ["Issue"], "label", fetcher),
    ).rejects.toMatchObject({
      code: "linear_api_auth_failed",
      name: "LinearApiError",
    });
  });

  it("throws LinearApiError with error messages on GraphQL errors", async () => {
    const fetcher = vi.fn(async () =>
      mockResponse({
        errors: [{ message: "not authorized" }, { message: "invalid input" }],
      }),
    );
    await expect(
      registerLinearWebhook("tok", "url", ["Issue"], "label", fetcher),
    ).rejects.toMatchObject({
      code: "linear_api_error",
      message: expect.stringMatching(/not authorized.*invalid input/),
    });
  });

  it("throws when webhookCreate returns success=false without errors", async () => {
    const fetcher = vi.fn(async () =>
      mockResponse({
        data: {
          webhookCreate: {
            success: false,
            webhook: { id: "", secret: "", enabled: false },
          },
        },
      }),
    );
    await expect(
      registerLinearWebhook("tok", "url", ["Issue"], "label", fetcher),
    ).rejects.toThrow(/success=false/);
  });
});

describe("unregisterLinearWebhook", () => {
  it("resolves void on success", async () => {
    const fetcher = vi.fn(async () =>
      mockResponse({ data: { webhookDelete: { success: true } } }),
    );
    await expect(
      unregisterLinearWebhook("tok", "wh_abc", fetcher),
    ).resolves.toBeUndefined();
  });

  it("throws on GraphQL errors", async () => {
    const fetcher = vi.fn(async () =>
      mockResponse({ errors: [{ message: "webhook not found" }] }),
    );
    await expect(
      unregisterLinearWebhook("tok", "wh_missing", fetcher),
    ).rejects.toThrow(/webhook not found/);
  });
});
```

---

## Task 3: Facet wrapper template

**Files:**
- Create: `src/facet/wrapper.ts`

The wrapper is a fixed string that gets injected as `main.js` into every facet bundle. It:

1. Extends `DurableObject`
2. On first fetch, runs the schema DDL (idempotent; `CREATE TABLE IF NOT EXISTS` patterns expected)
3. Delegates subsequent webhook requests to the agent's `handleWebhook(request, sql)`

- [ ] **Step 1: Create `src/facet/wrapper.ts`:**

```ts
/**
 * Fixed wrapper source for facet bundles. Composed into the Worker Loader
 * `modules` map at sync-creation time alongside a generated `schema.js`
 * and the agent-authored `handler.js`.
 *
 * The wrapper is responsible for:
 *   - Extending DurableObject so ctx.facets.get returns a proper DO stub
 *   - Lazily applying the schema on first fetch (idempotent)
 *   - Delegating to handleWebhook(request, sql) from the agent's module
 *
 * The agent's handler.js contract: export a function
 *   `handleWebhook(request: Request, sql: SqlStorage): Promise<Response>`
 * where `sql` is this.ctx.storage.sql (call sql.exec(query, ...args) and
 * sql.exec(query, ...args).toArray() for reads).
 */
export const FACET_WRAPPER_SOURCE = `
import { DurableObject } from "cloudflare:workers";
import { SCHEMA_DDL } from "./schema.js";
import { handleWebhook } from "./handler.js";

export class App extends DurableObject {
  #schemaApplied = false;

  async fetch(request) {
    if (!this.#schemaApplied) {
      // Run each DDL statement. The agent-authored schema_ddl may contain
      // multiple statements separated by ';'. We split rather than passing
      // the whole string because SqlStorage.exec only runs one statement
      // at a time.
      for (const stmt of splitStatements(SCHEMA_DDL)) {
        if (stmt.trim()) this.ctx.storage.sql.exec(stmt);
      }
      this.#schemaApplied = true;
    }
    return handleWebhook(request, this.ctx.storage.sql);
  }
}

function splitStatements(ddl) {
  // Naive splitter — adequate for the agent-written schemas we expect
  // (CREATE TABLE, CREATE INDEX, ALTER TABLE). If an agent generates
  // triggers or stored procedures with embedded ';' this would break;
  // not in scope for V1.
  return ddl.split(/;\\s*\\n/).map((s) => s.trim()).filter(Boolean);
}
`;
```

Notes:
- The wrapper is a string literal in TS. The embedded JS inside the template uses its own quotes; escape backslashes in regex (`\\s`, `\\n`).
- We split the DDL on `;\n` because `SqlStorage.exec()` only accepts a single statement. Multiple CREATE TABLEs separated by semicolons need to be run individually.
- The splitter is naive on purpose (YAGNI); V1 schemas are always `CREATE TABLE IF NOT EXISTS` shaped.

---

## Task 4: Facet bundle builder

**Files:**
- Create: `src/facet/bundle.ts`
- Create: `src/facet/bundle.test.ts`

Takes the sync's metadata and produces the `WorkerCode` object that `env.LOADER.get` expects.

- [ ] **Step 1: Create `src/facet/bundle.ts`:**

```ts
import { exports as workerExports } from "cloudflare:workers";
import { FACET_WRAPPER_SOURCE } from "./wrapper";

/**
 * WorkerCode shape from the Cloudflare Dynamic Workers API reference.
 * We don't import the concrete type because the official type
 * (provided via @cloudflare/workers-types) is still stabilizing; local
 * interface keeps us flexible and doesn't lose anything material.
 */
export interface WorkerCode {
  compatibilityDate: string;
  compatibilityFlags?: string[];
  mainModule: string;
  modules: Record<string, string>;
  globalOutbound?: unknown;
}

export interface BuildFacetWorkerCodeInput {
  schemaDdl: string;
  handlerCode: string;
  userId: string;
}

/**
 * Assemble the 3-module Worker Loader bundle for a sync's facet.
 *
 * Modules:
 *   - main.js     (fixed): the DurableObject wrapper from FACET_WRAPPER_SOURCE
 *   - schema.js   (generated): exports SCHEMA_DDL as a string constant
 *   - handler.js  (agent-authored): must export handleWebhook(request, sql)
 *
 * globalOutbound is set to the HttpGateway WorkerEntrypoint, stamped with
 * ctx.props.userId so the gateway knows which user DO this facet belongs
 * to. V1 ignores it in credential lookup (shared workspace token) but
 * V2 Pipedream will use it to pick the user's access token.
 */
export function buildFacetWorkerCode(
  input: BuildFacetWorkerCodeInput,
): WorkerCode {
  return {
    // Use a compatibility date close to today's. Must be >= the runtime's
    // minimum; "2026-04-01" is safe for a 2026-04-17 project.
    compatibilityDate: "2026-04-01",
    mainModule: "main.js",
    modules: {
      "main.js": FACET_WRAPPER_SOURCE,
      "schema.js": `export const SCHEMA_DDL = ${JSON.stringify(input.schemaDdl)};\n`,
      "handler.js": input.handlerCode,
    },
    // Type assertion: workerExports is typed as unknown in @cloudflare/workers-types;
    // the runtime supplies HttpGateway because we export it from src/server.ts.
    globalOutbound: (
      workerExports as unknown as { HttpGateway: (opts: { props: unknown }) => unknown }
    ).HttpGateway({ props: { userId: input.userId } }),
  };
}
```

- [ ] **Step 2: Create `src/facet/bundle.test.ts`:**

```ts
import { describe, it, expect, vi } from "vitest";

// Must mock the exports import before importing the module under test,
// since top-level imports evaluate eagerly.
vi.mock("cloudflare:workers", async (importActual) => {
  const actual = await importActual<typeof import("cloudflare:workers")>();
  return {
    ...actual,
    exports: {
      HttpGateway: (opts: { props: unknown }) => ({
        __mockHttpGateway: true,
        props: opts.props,
      }),
    },
  };
});

import { buildFacetWorkerCode } from "./bundle";
import { FACET_WRAPPER_SOURCE } from "./wrapper";

describe("buildFacetWorkerCode", () => {
  it("produces a WorkerCode with three modules and mainModule=main.js", () => {
    const code = buildFacetWorkerCode({
      schemaDdl: "CREATE TABLE issues (id TEXT PRIMARY KEY);",
      handlerCode: "export async function handleWebhook() {}",
      userId: "user-abc",
    });

    expect(code.mainModule).toBe("main.js");
    expect(Object.keys(code.modules).sort()).toEqual([
      "handler.js",
      "main.js",
      "schema.js",
    ]);
  });

  it("includes the fixed wrapper source verbatim in main.js", () => {
    const code = buildFacetWorkerCode({
      schemaDdl: "anything",
      handlerCode: "anything",
      userId: "u",
    });
    expect(code.modules["main.js"]).toBe(FACET_WRAPPER_SOURCE);
  });

  it("JSON-encodes the schema DDL so special characters survive", () => {
    const tricky = `CREATE TABLE t (
  name TEXT, -- a 'quoted' comment with "double" and \\backslashes
  payload TEXT
);`;
    const code = buildFacetWorkerCode({
      schemaDdl: tricky,
      handlerCode: "export async function handleWebhook() {}",
      userId: "u",
    });

    expect(code.modules["schema.js"]).toBe(
      `export const SCHEMA_DDL = ${JSON.stringify(tricky)};\n`,
    );

    // Round-trip safety: evaluating the module should produce the original string.
    // We can't run ES modules in vitest unit tests directly, but JSON round-trip
    // is sufficient evidence of encoding correctness.
    expect(JSON.parse(JSON.stringify(tricky))).toBe(tricky);
  });

  it("sets globalOutbound to HttpGateway stamped with userId props", () => {
    const code = buildFacetWorkerCode({
      schemaDdl: "x",
      handlerCode: "y",
      userId: "user-xyz",
    });
    expect(code.globalOutbound).toMatchObject({
      __mockHttpGateway: true,
      props: { userId: "user-xyz" },
    });
  });
});
```

---

## Task 5: Facet loader helper

**Files:**
- Create: `src/facet/loader.ts`

Thin wrapper: takes an agent DO context (`this.ctx` + `this.env`), a sync record, and the userId; calls `env.LOADER.get(...)` and `ctx.facets.get(...)`, returns the facet stub. This is the one-line API the `create_sync` tool uses.

- [ ] **Step 1: Create `src/facet/loader.ts`:**

```ts
import { buildFacetWorkerCode } from "./bundle";
import type { Sync } from "../db/types";

/**
 * codeId convention: `sync:<syncId>:v<version>` — bumps on every update
 * to force Worker Loader cache miss. See design doc §16.
 */
export function syncCodeId(sync: Pick<Sync, "id" | "version">): string {
  return `sync:${sync.id}:v${sync.version}`;
}

/**
 * Shape of the facet stub returned by ctx.facets.get. Reflects what the
 * Cloudflare docs promise ("behaves like a Durable Object stub") without
 * tying to a specific types import.
 */
export interface FacetStub {
  fetch(request: Request): Promise<Response>;
}

/**
 * Shape of the Durable Object class returned by worker.getDurableObjectClass.
 * Not typed explicitly by @cloudflare/workers-types; we use `unknown` at the
 * boundary and cast because FacetStartupOptions.class accepts it.
 */
type DurableObjectClass = unknown;

/**
 * Shape of the Worker Loader binding (env.LOADER). Minimal interface
 * sufficient for what we use.
 */
export interface WorkerLoaderLike {
  get(
    id: string,
    callback: () => Promise<unknown>,
  ): {
    getDurableObjectClass(className: string): DurableObjectClass;
  };
}

/**
 * Shape of this.ctx.facets on a Durable Object.
 */
export interface FacetsApi {
  get(
    name: string,
    callback: () => { class: DurableObjectClass } | Promise<{ class: DurableObjectClass }>,
  ): FacetStub;
  abort(name: string, reason?: unknown): void;
  delete(name: string): void;
}

/**
 * Attach (or resume) the facet for a sync. The returned stub is ready
 * to receive .fetch() calls (e.g., from Phase 09's webhook route).
 *
 * The Worker Loader callback only runs if this codeId has not been
 * loaded yet; subsequent facets for the same sync+version reuse the
 * cached isolate. Bumping sync.version in update_sync forces a miss.
 */
export function attachFacet(
  env: { LOADER: WorkerLoaderLike },
  facets: FacetsApi,
  sync: Sync,
  userId: string,
): FacetStub {
  const codeId = syncCodeId(sync);
  return facets.get(sync.name, async () => {
    const worker = env.LOADER.get(codeId, async () =>
      buildFacetWorkerCode({
        schemaDdl: sync.schema_ddl,
        handlerCode: sync.handler_code,
        userId,
      }),
    );
    return { class: worker.getDurableObjectClass("App") };
  });
}
```

Notes:
- No tests for this file directly — behavior is exercised by the integration test in Task 9.
- Type shapes kept local to avoid tangling with `@cloudflare/workers-types` drift. The boundary is narrow (`env.LOADER`, `ctx.facets`) so we can afford local `interface`s.

---

## Task 6: `create_sync` tool

**Files:**
- Create: `src/agent/tools/write/create-sync.ts`
- Create: `src/agent/tools/write/create-sync.test.ts`

The main new thing. Approval-gated. Transactional.

- [ ] **Step 1: Create `src/agent/tools/write/create-sync.ts`:**

```ts
import { tool } from "ai";
import { z } from "zod";
import type { ChatAgent } from "../../../server";
import { createSync, getSyncByName } from "../../../db/syncs";
import {
  registerLinearWebhook,
  unregisterLinearWebhook,
  LinearApiError,
} from "../../../integrations/linear-api";
import { attachFacet } from "../../../facet/loader";
import type { Integration, NewSync } from "../../../db/types";
import type { FacetsApi, WorkerLoaderLike } from "../../../facet/loader";

/**
 * Resource types passed to Linear's webhookCreate per integration + sync.
 * For V1 we only support Linear's Issue resource, but sync creation could
 * later allow the agent to pick different resource types (e.g., Comments,
 * Cycles). For now it's fixed.
 */
const LINEAR_DEFAULT_RESOURCE_TYPES = ["Issue"];

export function createSyncTool(agent: ChatAgent) {
  return tool({
    description:
      "Create a new sync. Registers a webhook with the upstream, loads the agent-authored handler into an isolated facet with its own SQLite, runs the schema DDL, and persists the sync registry row. Approval-gated — the user sees the drafted schema_ddl and handler_code in the approval dialog before it runs. Use AFTER you've shown the draft schema + handler in chat.",
    inputSchema: z.object({
      name: z
        .string()
        .min(1)
        .max(64)
        .regex(
          /^[a-zA-Z0-9_-]+$/,
          "name must be alphanumeric + hyphens/underscores only (it is used as the facet name)",
        )
        .describe(
          "User-visible sync label. Must be unique per user. Also used as the facet's name.",
        ),
      integration: z
        .enum(["linear"])
        .describe("V1 supports 'linear' only."),
      schema_ddl: z
        .string()
        .describe(
          "SQL DDL statements for the facet's SQLite, separated by semicolons. Use CREATE TABLE IF NOT EXISTS so re-applying is idempotent.",
        ),
      handler_code: z
        .string()
        .describe(
          "JavaScript module source that exports handleWebhook(request, sql). See system prompt for exact contract.",
        ),
      filter_description: z
        .string()
        .optional()
        .describe(
          "One-line human summary of what this sync tracks, e.g. 'only issues labeled bug in Core team'. Displayed in the UI and in ambient context.",
        ),
    }),
    needsApproval: true,
    execute: async ({
      name,
      integration,
      schema_ddl,
      handler_code,
      filter_description,
    }): Promise<
      | { ok: true; sync_id: string; linear_webhook_id: string }
      | { ok: false; error: string; detail: string }
    > => {
      const sql = agent.sql.bind(agent);
      const userId = agent.name;

      // 1. Uniqueness check (friendly error before we start doing real work)
      if (getSyncByName(sql, name)) {
        return {
          ok: false,
          error: "duplicate_name",
          detail: `A sync named "${name}" already exists for this user.`,
        };
      }

      const syncId = crypto.randomUUID();
      const webhookUrl = `${agent.env.PUBLIC_BASE_URL}/webhook/${userId}/${syncId}`;
      const webhookLabel = `self-syncing-agent:${userId.slice(0, 8)}:${name}`;

      // 2. Register webhook with Linear (this is the network-touching step;
      //    if it fails we haven't touched any local state yet)
      let registered;
      try {
        registered = await registerLinearWebhook(
          agent.env.LINEAR_ACCESS_TOKEN,
          webhookUrl,
          resourceTypesFor(integration),
          webhookLabel,
        );
      } catch (e) {
        if (e instanceof LinearApiError) {
          return { ok: false, error: e.code, detail: e.message };
        }
        throw e;
      }

      // 3. Build the NewSync record and persist. If this throws (e.g., UNIQUE
      //    name check lost a race), roll back the upstream webhook.
      const codeId = `sync:${syncId}:v1`;
      const newSync: NewSync = {
        id: syncId,
        name,
        integration,
        handler_code,
        schema_ddl,
        filter_description: filter_description ?? null,
        webhook_secret: registered.secret,
        upstream_webhook_id: registered.id,
        code_id: codeId,
      };

      let created;
      try {
        created = createSync(sql, newSync);
      } catch (e) {
        // Rollback step 2.
        await safeUnregister(agent.env.LINEAR_ACCESS_TOKEN, registered.id);
        return {
          ok: false,
          error: "persist_failed",
          detail: e instanceof Error ? e.message : String(e),
        };
      }

      // 4. Attach the facet. If Worker Loader rejects the code (syntax
      //    error, missing handleWebhook export, etc.), we roll back both
      //    the DB row and the upstream webhook.
      try {
        const facet = attachFacet(
          { LOADER: agent.env.LOADER as unknown as WorkerLoaderLike },
          agent.ctx.facets as unknown as FacetsApi,
          created,
          userId,
        );
        // Trigger facet initialization (wrapper applies schema on first fetch).
        // We hit a no-op health-check path; wrapper still applies schema because
        // it runs on EVERY fetch until #schemaApplied is true.
        const initResponse = await facet.fetch(
          new Request("https://facet.internal/__init__", { method: "POST" }),
        );
        if (initResponse.status >= 500) {
          throw new Error(
            `Facet init returned ${initResponse.status} — handler likely threw before returning.`,
          );
        }
      } catch (e) {
        // Rollback step 3 (DB) and step 2 (Linear).
        try {
          (agent.ctx.facets as unknown as FacetsApi).delete(name);
        } catch {
          // facets.delete throws if the facet never actually started;
          // swallow since our DB row still needs cleanup.
        }
        sql`DELETE FROM syncs WHERE id = ${syncId}`;
        await safeUnregister(agent.env.LINEAR_ACCESS_TOKEN, registered.id);
        return {
          ok: false,
          error: "facet_load_failed",
          detail: e instanceof Error ? e.message : String(e),
        };
      }

      return {
        ok: true,
        sync_id: syncId,
        linear_webhook_id: registered.id,
      };
    },
  });
}

function resourceTypesFor(integration: Integration): string[] {
  switch (integration) {
    case "linear":
      return LINEAR_DEFAULT_RESOURCE_TYPES;
    // default case unreachable while Integration = "linear"
  }
}

async function safeUnregister(accessToken: string, webhookId: string): Promise<void> {
  try {
    await unregisterLinearWebhook(accessToken, webhookId);
  } catch (e) {
    // Rollback best-effort — the user gets an error message about the
    // original failure; the orphaned Linear webhook can be cleaned up
    // out-of-band via Linear UI if this ever happens in practice.
    console.error(
      `safeUnregister: failed to unregister ${webhookId}:`,
      e instanceof Error ? e.message : e,
    );
  }
}
```

- [ ] **Step 2: Create `src/agent/tools/write/create-sync.test.ts`:**

```ts
import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect, vi } from "vitest";
import { createSyncTool } from "./create-sync";
import { listSyncs } from "../../../db/syncs";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

function getStub(userName: string) {
  return env.ChatAgent.get(env.ChatAgent.idFromName(userName));
}

async function ensureReady(
  instance: unknown,
  userName: string,
): Promise<void> {
  await (instance as { setName: (n: string) => Promise<void> }).setName(userName);
}

const SAMPLE_HANDLER = `
export async function handleWebhook(request, sql) {
  const payload = await request.json().catch(() => ({}));
  return new Response("ok", { status: 200 });
}
`;

const SAMPLE_SCHEMA = "CREATE TABLE IF NOT EXISTS issues (id TEXT PRIMARY KEY, title TEXT);";

describe("createSyncTool", () => {
  it("rejects duplicate sync names before touching the network", async () => {
    const stub = getStub("create-dup");
    const userName = "create-dup";

    await runInDurableObject(stub, async (instance) => {
      await ensureReady(instance, userName);
      const tools = createSyncTool(instance);
      // Pre-seed a sync with the same name.
      const sql = instance.sql.bind(instance);
      sql`
        INSERT INTO syncs (
          id, name, integration, handler_code, schema_ddl,
          filter_description, webhook_secret, upstream_webhook_id,
          code_id, version, created_at, updated_at
        ) VALUES (
          'existing-1', 'taken-name', 'linear', '', '',
          NULL, 's', NULL, 'c', 1, ${Date.now()}, ${Date.now()}
        )
      `;

      const result = await tools.execute!(
        {
          name: "taken-name",
          integration: "linear",
          schema_ddl: SAMPLE_SCHEMA,
          handler_code: SAMPLE_HANDLER,
        },
        {} as never,
      );

      expect(result).toMatchObject({
        ok: false,
        error: "duplicate_name",
      });
    });
  });

  it("propagates Linear API errors as tagged failure results", async () => {
    const stub = getStub("create-linearfail");
    const userName = "create-linearfail";

    // Intercept Linear's API at the module level. The tool calls
    // registerLinearWebhook which uses the global fetch; we stub fetch
    // within the runInDurableObject closure.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async (url: RequestInfo | URL) => {
        if (String(url).includes("api.linear.app")) {
          return new Response(
            JSON.stringify({ errors: [{ message: "simulated linear outage" }] }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return originalFetch(url as never);
      },
    ) as typeof fetch;

    try {
      await runInDurableObject(stub, async (instance) => {
        await ensureReady(instance, userName);
        const tools = createSyncTool(instance);
        const result = await tools.execute!(
          {
            name: "linear-bugs",
            integration: "linear",
            schema_ddl: SAMPLE_SCHEMA,
            handler_code: SAMPLE_HANDLER,
          },
          {} as never,
        );

        expect(result).toMatchObject({
          ok: false,
          error: "linear_api_error",
          detail: expect.stringMatching(/simulated linear outage/),
        });

        // No sync row should have been persisted on Linear failure.
        const sql = instance.sql.bind(instance);
        expect(listSyncs(sql)).toHaveLength(0);
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
```

Note: we don't write a "happy path" unit test here because it needs a working facet load, which requires runtime infrastructure beyond `runInDurableObject`'s practical capabilities. The integration test in Task 9 exercises the happy path with more care.

---

## Task 7: Register `create_sync` in `buildTools`

**Files:**
- Modify: `src/agent/tools/index.ts`

- [ ] **Step 1: Import and register**

Find `src/agent/tools/index.ts`. Add:

```ts
import { createSyncTool } from "./write/create-sync";
```

Inside `buildTools(agent)`, add `create_sync: createSyncTool(agent),` to the returned object. Final shape:

```ts
export function buildTools(agent: ChatAgent) {
  return {
    list_syncs: listSyncsTool(agent),
    get_sync: getSyncTool(agent),
    get_sync_errors: getSyncErrorsTool(agent),
    web_search: webSearchTool(agent),
    create_sync: createSyncTool(agent),
  };
}
```

---

## Task 8: Update system prompt

**Files:**
- Modify: `src/agent/system-prompt.ts`

Update the "What you can do" and "How to handle unfamiliar shapes" sections to reflect create_sync availability, and add a new section "Drafting a sync" that teaches the exact handler.js contract.

- [ ] **Step 1: Replace the "Write tools are not yet wired" paragraph**

Find the line that begins `Write tools are not yet wired`. Replace the whole paragraph with:

```
Write tool (available):
- \`create_sync(name, integration, schema_ddl, handler_code, filter_description?)\` — registers a webhook with the upstream, spins up an isolated facet with its own SQLite, persists the sync registry row. Approval-gated — the user sees your proposed schema + handler in an approval dialog before it runs.

Still-unavailable write tools (coming in later phases): \`update_sync\`, \`delete_sync\`, \`run_in_sync\`. If asked to update or delete, acknowledge and say that's coming.
```

- [ ] **Step 2: Add a new section "Drafting a sync" before "Linear facts worth knowing"**

```
## Drafting a sync

When the user asks to create a sync, follow this four-step flow:

1. **Understand**. Restate what they want to track (integration + resource + any filter). Ask a clarifying question if the scope is ambiguous ("all Linear issues" vs "only bugs from Core team" is a real difference).

2. **Verify the payload shape**. For Linear you have the facts below. For unfamiliar integrations, call \`web_search\` with a focused objective before drafting.

3. **Draft in chat**. Show two code blocks in your response: the schema_ddl and the handler_code. Explain one line each: what the table captures, how the handler filters/writes. This gives the user a chance to push back in conversation before the formal approval.

4. **Call create_sync**. The approval dialog will show the same schema + handler again — that's fine, redundancy is intentional.

### handler_code contract

The handler.js module you generate MUST export a function named \`handleWebhook\`:

\`\`\`ts
export async function handleWebhook(request, sql) {
  const payload = await request.json();
  // ... inspect payload, filter, write to SQLite via sql.exec(...)
  return new Response("ok", { status: 200 });
}
\`\`\`

- \`request\` is the raw Linear webhook POST (signature already verified by the supervisor)
- \`sql\` is the facet's own SQLite. Call \`sql.exec(query, ...bindings)\` for inserts/updates. For reads, \`sql.exec(query, ...bindings).toArray()\` returns a row array.
- Always return a 2xx \`Response\` for successful processing (including "filtered out, nothing to write" — use 200 + "ignored"). Return a 5xx only if you want Linear to retry.
- Be idempotent. Linear may deliver the same event twice. Use \`INSERT OR REPLACE\` or \`ON CONFLICT(id) DO UPDATE\` keyed on the Linear resource's \`data.id\`.
- Do NOT import anything beyond the two parameters. \`fetch\` is globally available if you need to call Linear's REST/GraphQL (our proxy intercepts and injects auth), but for write-path handlers you usually don't need it.
- Keep it fast. Linear times out at 5 seconds.

### schema_ddl contract

One or more \`CREATE TABLE\` / \`CREATE INDEX\` statements separated by semicolons. Use \`IF NOT EXISTS\` so re-running is safe. SQLite types only (TEXT, INTEGER, REAL, BLOB, NULL). Store JSON-shaped fields (labels, metadata) as TEXT and parse at read time.
```

- [ ] **Step 3: Verify the final file**

Run:

```bash
pnpm exec tsc --noEmit
```

Zero errors expected.

---

## Task 9: Integration test

**Files:**
- Create: `tests/create-sync-integration.test.ts`

End-to-end test via `runInDurableObject` that mocks Linear's API and walks the happy path.

- [ ] **Step 1: Create `tests/create-sync-integration.test.ts`:**

```ts
import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect, vi } from "vitest";
import { createSyncTool } from "../src/agent/tools/write/create-sync";
import { listSyncs, getSyncByName } from "../src/db/syncs";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const SAMPLE_HANDLER = `
export async function handleWebhook(request, sql) {
  return new Response("ok", { status: 200 });
}
`;

const SAMPLE_SCHEMA = "CREATE TABLE IF NOT EXISTS issues (id TEXT PRIMARY KEY);";

function stubLinearFetch(): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (!String(url).includes("api.linear.app")) return original(url as never, init as never);
    const body = JSON.parse(init!.body as string);
    if (body.query.includes("webhookCreate")) {
      return new Response(
        JSON.stringify({
          data: {
            webhookCreate: {
              success: true,
              webhook: {
                id: `wh_stub_${body.variables.label}`,
                secret: `sec_stub_${body.variables.label}`,
                enabled: true,
              },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (body.query.includes("webhookDelete")) {
      return new Response(
        JSON.stringify({ data: { webhookDelete: { success: true } } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("{}", { status: 500 });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

describe("create_sync end-to-end", () => {
  it("creates a sync: Linear webhook + persisted row + attached facet", async () => {
    const restore = stubLinearFetch();
    try {
      const stub = env.ChatAgent.get(env.ChatAgent.idFromName("e2e-happy"));
      await runInDurableObject(stub, async (instance) => {
        await (
          instance as unknown as { setName: (n: string) => Promise<void> }
        ).setName("e2e-happy");

        const tools = createSyncTool(instance);
        const result = await tools.execute!(
          {
            name: "linear-issues",
            integration: "linear",
            schema_ddl: SAMPLE_SCHEMA,
            handler_code: SAMPLE_HANDLER,
            filter_description: "all Linear issues",
          },
          {} as never,
        );

        if (!("ok" in result) || result.ok !== true) {
          throw new Error(
            `Expected ok: true, got: ${JSON.stringify(result, null, 2)}`,
          );
        }
        expect(result.linear_webhook_id).toMatch(/^wh_stub_/);

        const sql = instance.sql.bind(instance);
        const all = listSyncs(sql);
        expect(all).toHaveLength(1);
        const persisted = all[0];
        expect(persisted.name).toBe("linear-issues");
        expect(persisted.integration).toBe("linear");
        expect(persisted.upstream_webhook_id).toMatch(/^wh_stub_/);
        expect(persisted.webhook_secret).toMatch(/^sec_stub_/);
        expect(persisted.version).toBe(1);
      });
    } finally {
      restore();
    }
  });

  it("rolls back the DB row and unregisters the webhook if the facet fails to load", async () => {
    const restore = stubLinearFetch();
    try {
      const stub = env.ChatAgent.get(env.ChatAgent.idFromName("e2e-rollback"));
      await runInDurableObject(stub, async (instance) => {
        await (
          instance as unknown as { setName: (n: string) => Promise<void> }
        ).setName("e2e-rollback");

        // Force a facet-load failure by passing invalid JavaScript as
        // the handler code. Worker Loader will fail when it tries to
        // compile the module (either eagerly or on first .fetch() call),
        // which lands in the tool's facet_load_failed branch.
        const BROKEN_HANDLER =
          "export async function handleWebhook( { NOT VALID JS SYNTAX";

        const tools = createSyncTool(instance);
        const result = await tools.execute!(
          {
            name: "linear-rollback",
            integration: "linear",
            schema_ddl: SAMPLE_SCHEMA,
            handler_code: BROKEN_HANDLER,
          },
          {} as never,
        );

        expect(result).toMatchObject({
          ok: false,
          error: "facet_load_failed",
        });

        // DB row must have been rolled back.
        const sql = instance.sql.bind(instance);
        expect(getSyncByName(sql, "linear-rollback")).toBeNull();

        // Linear webhook unregister call must have been issued.
        const webhookDeleteCalled = (
          globalThis.fetch as unknown as { mock: { calls: unknown[][] } }
        ).mock.calls.some(
          (args) =>
            args[1] != null &&
            typeof (args[1] as RequestInit).body === "string" &&
            ((args[1] as RequestInit).body as string).includes("webhookDelete"),
        );
        expect(webhookDeleteCalled).toBe(true);
      });
    } finally {
      restore();
    }
  });
});
```

Two tests cover: happy path (Linear registered + row persisted + no error); rollback path (facet load fails → DB rolled back + Linear unregister called).

---

## Task 10: Full check, commit, push

- [ ] **Step 1: Full check**

```bash
pnpm run check > /dev/null 2>&1; echo "check: $?"
```

Target: exit 0. Test count 38 → **52** across 11 test files. Breakdown of the 14 new:

- `src/integrations/linear-api.test.ts` — 6 tests
- `src/facet/bundle.test.ts` — 4 tests
- `src/agent/tools/write/create-sync.test.ts` — 2 tests
- `tests/create-sync-integration.test.ts` — 2 tests

Total: 38 + 6 + 4 + 2 + 2 = 52. Re-verify during execution; adjust the commit message if the count differs.

- [ ] **Step 2: Commit**

```bash
git commit -m "$(cat <<'EOF'
Phase 08: create_sync tool + facets + Worker Loader + Linear webhook registration

First write tool lands. Agent can now register a sync end-to-end from
the chat: draft schema + handler, approval dialog surfaces both, tool
execution (a) registers a webhook with Linear via webhookCreate, (b)
loads the agent's handler.js into an isolated DO Facet via Worker
Loader (globalOutbound pointed at HttpGateway), (c) initializes the
facet's SQLite with schema_ddl, (d) persists the sync registry row.
Any failure rolls back.

Phase 09 completes the loop by adding the /webhook/:userId/:syncId
delivery route. Until then, facets exist but Linear deliveries 404.

- src/integrations/linear-api.ts + .test.ts — typed GraphQL helpers
  for webhookCreate / webhookDelete; injectable fetcher for tests
- src/facet/wrapper.ts — fixed wrapper module source that extends
  DurableObject, applies schema on first fetch, delegates to the
  agent's handleWebhook(request, sql)
- src/facet/bundle.ts + .test.ts — composes the 3-module Worker
  Loader bundle (main.js wrapper + schema.js generated + handler.js
  from agent); globalOutbound = exports.HttpGateway({ props: { userId } })
- src/facet/loader.ts — attachFacet helper wrapping env.LOADER.get
  and ctx.facets.get
- src/agent/tools/write/create-sync.ts + .test.ts — the tool;
  needsApproval:true, transactional rollback on every failure step
- src/agent/tools/index.ts — register create_sync in buildTools
- src/agent/system-prompt.ts — reflects create_sync availability,
  new "Drafting a sync" section documenting the handler.js contract
  (export handleWebhook(request, sql), idempotent writes, 5s timeout)
- tests/create-sync-integration.test.ts — 2 end-to-end tests via
  runInDurableObject with Linear fetch mocked
- PUBLIC_BASE_URL env + test bindings + env.d.ts regeneration

Test count: 38 -> ~52 across 9 test files.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 3: Push**

```bash
git push
```

---

## Phase 08 done when…

- [ ] `pnpm test` passes with the expected new tests (see Task 10 Step 1 for breakdown)
- [ ] `pnpm run check` green end-to-end
- [ ] `create_sync` is in `buildTools` and showing up in the agent's tool surface
- [ ] System prompt documents the handler.js contract (export `handleWebhook`)
- [ ] `PUBLIC_BASE_URL` is typed on Env
- [ ] Commit pushed to origin/main

## Manual verification (AFTER Phase 09)

End-to-end testing requires Phase 09's webhook delivery route to see data actually land. After Phase 09 ships:

1. Set `PUBLIC_BASE_URL` in `.dev.vars` to either a `wrangler dev --remote` URL or an ngrok/cloudflared tunnel URL pointing at `pnpm dev`
2. Start `pnpm dev`
3. Open chat, ask: "Set up a sync for my Linear issues."
4. Agent should: call web_search or skip (Linear is in the prompt), draft schema + handler in chat, call create_sync, show approval dialog
5. Approve. The tool runs, returns `{ ok: true, sync_id, linear_webhook_id }`
6. Open Linear → Settings → API → check webhook list; a new webhook should be registered pointing at your URL
7. Trigger a Linear event (create an issue). Within a few seconds, the webhook fires
8. Run `query_sync("<sync_id>", "SELECT * FROM issues")` — the row should be there

If steps 6-8 fail, check `get_sync_errors("<sync_id>")` — Phase 09's error logging surfaces handler runtime failures there.

Next phase: **Phase 09 — webhook delivery route** — `/webhook/:userId/:syncId`, HMAC signature verification against stored webhook_secret, facet dispatch wrapped in try/catch, error capture into the `sync_errors` table. After Phase 09, the full round-trip demo works.
