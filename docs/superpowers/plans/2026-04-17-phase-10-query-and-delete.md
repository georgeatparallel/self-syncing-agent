# Phase 10: `query_sync` + `delete_sync` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the demo loop. Ship two tools: `query_sync` (read-only SQL against a facet's SQLite so the agent can answer "how many issues landed?") and `delete_sync` (unregister the upstream webhook, drop the facet + its SQLite, clean sync_errors, remove the registry row). These are the two smallest of the four remaining Phase 10 tools from the original design — `run_in_sync` lands in Phase 11, `update_sync` with full backfill/migration builds on that in Phase 12.

**Architecture:**

- **`query_sync`** — read tool, no approval. The agent passes `sync_id + query`. Supervisor validates the query starts with `SELECT` or `WITH` after stripping SQL comments, resolves the facet via the existing `attachFacet` path, and calls a new **supervisor-only RPC method** `__query(sql)` on the wrapper (same pattern as `__supervisorPing` from Phase 08). The wrapper executes via `this.ctx.storage.sql.exec(sql).toArray()` and returns the row array. Because `query_sync` may be the first thing to touch a facet that hasn't yet received a webhook delivery (so `#schemaApplied` is still false), the wrapper's schema-application logic gets refactored into a shared private method that both `fetch()` and `__query()` call lazily. Result shape: `{ rows: unknown[], row_count: number }` on success, `{ error: "invalid_sql" | "sync_not_found" | "sqlite_error", detail }` on failure.

- **`delete_sync`** — write tool, `needsApproval: true`. Mirrors `create_sync`'s three-step coordination but in reverse: (1) unregister the upstream webhook via `unregisterLinearWebhook` (existing helper); (2) `ctx.facets.delete(syncName)` — drops the facet + its SQLite database; (3) cascade-delete `sync_errors` rows for the sync, then delete the `syncs` row. Network-touching step first so if Linear is unreachable we haven't yet destroyed local state. Rollback semantics on failure: abort the delete (don't leave a half-deleted sync). Output: `{ ok: true }` or `{ ok: false, error, detail }`.

**Tech Stack:** Adds nothing new. Existing primitives: `attachFacet`, `unregisterLinearWebhook`, `ctx.facets.delete`, `ctx.storage.sql.exec`, Durable Objects RPC, vitest-pool-workers for integration tests with the same `installFakeFacets` shim.

---

### Task 1: Wrapper `__query` RPC + shared schema-ensure helper

The wrapper currently applies schema lazily inside `fetch()`. Once `query_sync` lands, a query path can touch a facet before any webhook has arrived — so `#schemaApplied` may still be false. Factor the schema-apply into a private method both `fetch()` and `__query()` call.

**Files:**

- Modify: `src/facet/wrapper.ts` — add `#ensureSchema()` + `__query(sql)` method to the `App` class
- Modify: `src/facet/bundle.test.ts` — assert the new wrapper exports compile/parse and include both methods

**Notes:**

- `__query` is supervisor-only RPC (double underscore convention, same as `__supervisorPing`). Agent-authored `handler.js` cannot shadow it because it's on the wrapper class, not the handler module.
- `sql.exec(query).toArray()` returns `unknown[]` — no parameter binding supported from this path for V1 (agent writes the full SQL; SELECT-only validator in the tool prevents destructive SQL).
- If the query fails (bad table name, syntax error), SQLite throws. `__query` catches and returns `{ error: string }` so the supervisor can wrap it cleanly — never crashes the facet.

- [ ] **Step 1: Update `src/facet/bundle.test.ts` with a failing assertion**

Append to the existing test file:

```ts
it("wrapper source exposes __query and #ensureSchema", () => {
  const bundle = buildFacetWorkerCode({
    schemaDdl: "CREATE TABLE IF NOT EXISTS x (id TEXT);",
    handlerCode:
      "export async function handleWebhook(){ return new Response('ok'); }",
    userId: "u1"
  });
  const main = bundle.modules["main.js"];
  expect(main).toMatch(/#ensureSchema/);
  expect(main).toMatch(/async __query\(/);
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `pnpm exec vitest run src/facet/bundle.test.ts`
Expected: FAIL — neither `#ensureSchema` nor `__query` is in the wrapper source yet.

- [ ] **Step 3: Update `FACET_WRAPPER_SOURCE` in `src/facet/wrapper.ts`**

Replace the `App` class body with:

```js
export class App extends DurableObject {
  #schemaApplied = false;

  #ensureSchema() {
    if (this.#schemaApplied) return;
    for (const stmt of splitStatements(SCHEMA_DDL)) {
      if (stmt.trim()) this.ctx.storage.sql.exec(stmt);
    }
    this.#schemaApplied = true;
  }

  async fetch(request) {
    this.#ensureSchema();
    return handleWebhook(request, this.ctx.storage.sql);
  }

  // Supervisor-only probe — forces Worker Loader compilation without
  // running the agent's handler. See create-sync.ts.
  async __supervisorPing() {}

  // Supervisor-only query path. Tool layer enforces SELECT/WITH-only;
  // this method is power-not-policy. Catches SQLite errors so a bad
  // query from the user doesn't wedge the facet.
  async __query(sql) {
    this.#ensureSchema();
    try {
      const rows = this.ctx.storage.sql.exec(sql).toArray();
      return { ok: true, rows };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : String(e)
      };
    }
  }
}
```

Update the `FACET_WRAPPER_SOURCE` header comment block to mention the three responsibilities (fetch delegate, schema init, query + supervisor ping) — replace the current bullet list.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run src/facet/bundle.test.ts`
Expected: PASS — 5/5 (4 existing + 1 new).

- [ ] **Step 5: Full check**

Run: `pnpm run check`
Expected: exit 0, 68/68 tests (67 existing + 1 new).

- [ ] **Step 6: Commit**

```bash
git add src/facet/wrapper.ts src/facet/bundle.test.ts
git commit -m "$(cat <<'EOF'
Phase 10: wrapper __query RPC + shared #ensureSchema helper

Factor the schema-apply-on-first-use logic out of fetch() into a
private #ensureSchema() method so query paths can lazily apply
schema too (a facet can receive a query_sync call before any
webhook has hit, leaving #schemaApplied false).

Add __query(sql) supervisor-only RPC method. Executes via
ctx.storage.sql.exec and returns { ok: true, rows } or
{ ok: false, error }. The SELECT-only validator lives in the tool
layer, not here — wrapper is power-not-policy. Catches SQLite
errors so a bad agent-written query can't wedge the facet.

Covered by bundle.test.ts asserting both method names appear in
the generated wrapper source. Actual behavioral coverage lands
via query_sync integration tests in the next task.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `query_sync` tool

SELECT-only tool the agent calls to answer "how many X are in my sync" and similar. No approval needed — the validator + wrapper's exec are the boundary.

**Files:**

- Create: `src/agent/tools/read/query-sync.ts`
- Create: `src/agent/tools/read/query-sync.test.ts`
- Modify: `src/agent/tools/index.ts` — add `query_sync` to the tool map
- Modify: `src/agent/system-prompt.ts` — document `query_sync` in "Read tools" + add a sentence in the "Query" flow

**Notes:**

- **Validator:** strip line comments (`-- ...\n`) and block comments (`/* ... */`), trim leading whitespace, check first token (case-insensitive) is `SELECT` or `WITH`. Reject otherwise.
- **Execution:** `attachFacet(env, facets, sync, userId)` returns a Fetcher; call `(facet as ...).__query(sql)`. Wrap as `{ rows, row_count }` on success, tagged error on failure.
- **Error surface** (for the agent):
  - `{ error: "not_found", sync_id }` — unknown sync
  - `{ error: "invalid_sql", detail: "query must start with SELECT or WITH" }` — validator rejected
  - `{ error: "sqlite_error", detail }` — `__query` returned `{ ok: false, error }`
- **Output shape on success:** `{ row_count: number, rows: unknown[] }`. Rows are opaque to the supervisor — the agent receives them, decides how to summarize.
- **Row cap:** cap at 200 rows. If `rows.length > 200`, truncate and set `truncated: true`. Prevents a `SELECT * FROM issues` on a bloated facet from blowing the LLM context window.

- [ ] **Step 1: Write the failing test file `src/agent/tools/read/query-sync.test.ts`**

```ts
import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { querySyncTool } from "./query-sync";
import { createSync } from "../../../db/syncs";
import type { NewSync } from "../../../db/types";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

interface FakeFacetStub {
  fetch: (req: Request) => Promise<Response>;
  __supervisorPing: () => Promise<void>;
  __query: (
    sql: string
  ) => Promise<{ ok: boolean; rows?: unknown[]; error?: string }>;
}
interface FakeFacets {
  get(name: string, cb: () => unknown): FakeFacetStub;
  abort: (name: string, reason?: unknown) => void;
  delete: (name: string) => void;
}
function installFakeFacets(instance: unknown, facets: FakeFacets): () => void {
  const ctx = (instance as { ctx: { facets?: FakeFacets } }).ctx;
  const prev = ctx.facets;
  ctx.facets = facets;
  return () => {
    ctx.facets = prev;
  };
}

function seedSync(instance: unknown): string {
  const sql = (instance as { sql: (...a: unknown[]) => unknown }).sql.bind(
    instance
  ) as never;
  const id = crypto.randomUUID();
  const input: NewSync = {
    id,
    name: "linear-issues",
    integration: "linear",
    handler_code:
      "export async function handleWebhook(){ return new Response('ok'); }",
    schema_ddl: "CREATE TABLE IF NOT EXISTS issues (id TEXT PRIMARY KEY);",
    filter_description: null,
    webhook_secret: "s",
    upstream_webhook_id: "wh_test",
    code_id: `sync:${id}:v1`
  };
  createSync(sql, input);
  return id;
}

describe("query_sync", () => {
  it("returns rows from a SELECT against the facet", async () => {
    const stub = env.ChatAgent.get(env.ChatAgent.idFromName("q-happy"));
    await runInDurableObject(stub, async (instance) => {
      await (
        instance as never as { setName: (n: string) => Promise<void> }
      ).setName("q-happy");
      const syncId = seedSync(instance);

      const restore = installFakeFacets(instance, {
        get() {
          return {
            fetch: async () => new Response("ok"),
            __supervisorPing: async () => {},
            __query: async () => ({ ok: true, rows: [{ count: 3 }] })
          };
        },
        abort: () => {},
        delete: () => {}
      });

      try {
        const tool = querySyncTool(instance as never);
        const res = (await tool.execute!(
          { sync_id: syncId, query: "SELECT COUNT(*) as count FROM issues" },
          {} as never
        )) as { row_count: number; rows: unknown[] };
        expect(res.row_count).toBe(1);
        expect(res.rows).toEqual([{ count: 3 }]);
      } finally {
        restore();
      }
    });
  });

  it("rejects non-SELECT queries with invalid_sql", async () => {
    const stub = env.ChatAgent.get(env.ChatAgent.idFromName("q-invalid"));
    await runInDurableObject(stub, async (instance) => {
      await (
        instance as never as { setName: (n: string) => Promise<void> }
      ).setName("q-invalid");
      const syncId = seedSync(instance);
      const tool = querySyncTool(instance as never);
      const res = await tool.execute!(
        { sync_id: syncId, query: "DELETE FROM issues" },
        {} as never
      );
      expect(res).toMatchObject({ error: "invalid_sql" });
    });
  });

  it("accepts WITH ... SELECT queries (CTEs)", async () => {
    const stub = env.ChatAgent.get(env.ChatAgent.idFromName("q-with"));
    await runInDurableObject(stub, async (instance) => {
      await (
        instance as never as { setName: (n: string) => Promise<void> }
      ).setName("q-with");
      const syncId = seedSync(instance);
      const restore = installFakeFacets(instance, {
        get() {
          return {
            fetch: async () => new Response("ok"),
            __supervisorPing: async () => {},
            __query: async () => ({ ok: true, rows: [{ n: 1 }] })
          };
        },
        abort: () => {},
        delete: () => {}
      });
      try {
        const tool = querySyncTool(instance as never);
        const res = (await tool.execute!(
          {
            sync_id: syncId,
            query: "WITH t AS (SELECT 1 AS n) SELECT * FROM t"
          },
          {} as never
        )) as { row_count: number };
        expect(res.row_count).toBe(1);
      } finally {
        restore();
      }
    });
  });

  it("strips leading SQL comments before validating", async () => {
    const stub = env.ChatAgent.get(env.ChatAgent.idFromName("q-comment"));
    await runInDurableObject(stub, async (instance) => {
      await (
        instance as never as { setName: (n: string) => Promise<void> }
      ).setName("q-comment");
      const syncId = seedSync(instance);
      const restore = installFakeFacets(instance, {
        get() {
          return {
            fetch: async () => new Response("ok"),
            __supervisorPing: async () => {},
            __query: async () => ({ ok: true, rows: [] })
          };
        },
        abort: () => {},
        delete: () => {}
      });
      try {
        const tool = querySyncTool(instance as never);
        const res = (await tool.execute!(
          {
            sync_id: syncId,
            query: "-- a comment\n/* block */ SELECT * FROM issues"
          },
          {} as never
        )) as { row_count: number };
        expect(res.row_count).toBe(0);
      } finally {
        restore();
      }
    });
  });

  it("returns not_found for an unknown sync_id", async () => {
    const stub = env.ChatAgent.get(env.ChatAgent.idFromName("q-404"));
    await runInDurableObject(stub, async (instance) => {
      await (
        instance as never as { setName: (n: string) => Promise<void> }
      ).setName("q-404");
      const tool = querySyncTool(instance as never);
      const res = await tool.execute!(
        {
          sync_id: "00000000-0000-0000-0000-000000000000",
          query: "SELECT 1"
        },
        {} as never
      );
      expect(res).toMatchObject({ error: "not_found" });
    });
  });

  it("surfaces sqlite errors from __query as sqlite_error", async () => {
    const stub = env.ChatAgent.get(env.ChatAgent.idFromName("q-sqliteerr"));
    await runInDurableObject(stub, async (instance) => {
      await (
        instance as never as { setName: (n: string) => Promise<void> }
      ).setName("q-sqliteerr");
      const syncId = seedSync(instance);
      const restore = installFakeFacets(instance, {
        get() {
          return {
            fetch: async () => new Response("ok"),
            __supervisorPing: async () => {},
            __query: async () => ({ ok: false, error: "no such table: bogus" })
          };
        },
        abort: () => {},
        delete: () => {}
      });
      try {
        const tool = querySyncTool(instance as never);
        const res = await tool.execute!(
          { sync_id: syncId, query: "SELECT * FROM bogus" },
          {} as never
        );
        expect(res).toMatchObject({
          error: "sqlite_error",
          detail: expect.stringMatching(/no such table/)
        });
      } finally {
        restore();
      }
    });
  });

  it("caps rows at 200 and sets truncated: true when exceeded", async () => {
    const stub = env.ChatAgent.get(env.ChatAgent.idFromName("q-cap"));
    await runInDurableObject(stub, async (instance) => {
      await (
        instance as never as { setName: (n: string) => Promise<void> }
      ).setName("q-cap");
      const syncId = seedSync(instance);
      const big = Array.from({ length: 500 }, (_, i) => ({ i }));
      const restore = installFakeFacets(instance, {
        get() {
          return {
            fetch: async () => new Response("ok"),
            __supervisorPing: async () => {},
            __query: async () => ({ ok: true, rows: big })
          };
        },
        abort: () => {},
        delete: () => {}
      });
      try {
        const tool = querySyncTool(instance as never);
        const res = (await tool.execute!(
          { sync_id: syncId, query: "SELECT i FROM issues" },
          {} as never
        )) as { row_count: number; rows: unknown[]; truncated: boolean };
        expect(res.row_count).toBe(200);
        expect(res.rows).toHaveLength(200);
        expect(res.truncated).toBe(true);
      } finally {
        restore();
      }
    });
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `pnpm exec vitest run src/agent/tools/read/query-sync.test.ts`
Expected: FAIL — module `./query-sync` not found.

- [ ] **Step 3: Implement `src/agent/tools/read/query-sync.ts`**

```ts
import { tool } from "ai";
import { z } from "zod";
import { getSyncById } from "../../../db/syncs";
import { attachFacet } from "../../../facet/loader";
import type { ChatAgent } from "../../../server";

const ROW_CAP = 200;

/**
 * Strip SQL block and line comments, trim, lowercase the first token,
 * and return whether it's SELECT or WITH. Belt; the suspenders live
 * inside the facet's __query (SQLite's SELECT is read-only by semantics).
 */
function isReadOnlyQuery(sql: string): boolean {
  const stripped = sql
    .replaceAll(/\/\*[\s\S]*?\*\//g, "")
    .replaceAll(/--[^\n]*/g, "")
    .trim();
  const firstToken = stripped.slice(0, 6).toLowerCase();
  return firstToken === "select" || firstToken.startsWith("with");
}

export function querySyncTool(agent: ChatAgent) {
  return tool({
    description:
      "Run a read-only SQL query against a sync's facet SQLite. Use to answer 'how many X are there?', 'show me recent Y', and similar data questions the user asks about their synced data. Must start with SELECT or WITH; anything else is rejected. Results capped at 200 rows — narrow via WHERE / LIMIT / aggregation instead of relying on the cap.",
    inputSchema: z.object({
      sync_id: z.string().describe("The sync's UUID."),
      query: z
        .string()
        .min(1)
        .describe(
          "A single SQL statement starting with SELECT or WITH. SQL comments are allowed. No parameter binding — embed literals directly (escape single quotes by doubling)."
        )
    }),
    execute: async ({ sync_id, query }) => {
      const sql = agent.sql.bind(agent);
      const sync = getSyncById(sql, sync_id);
      if (!sync) {
        return { error: "not_found" as const, sync_id };
      }
      if (!isReadOnlyQuery(query)) {
        return {
          error: "invalid_sql" as const,
          detail: "query must start with SELECT or WITH"
        };
      }

      const facet = attachFacet(agent.env, agent.ctx.facets, sync, agent.name);
      const result = await (
        facet as unknown as {
          __query: (
            sql: string
          ) => Promise<
            { ok: true; rows: unknown[] } | { ok: false; error: string }
          >;
        }
      ).__query(query);

      if (!result.ok) {
        return { error: "sqlite_error" as const, detail: result.error };
      }

      const truncated = result.rows.length > ROW_CAP;
      const rows = truncated ? result.rows.slice(0, ROW_CAP) : result.rows;
      return {
        row_count: rows.length,
        rows,
        ...(truncated ? { truncated: true } : {})
      };
    }
  });
}
```

- [ ] **Step 4: Wire `query_sync` into `src/agent/tools/index.ts`**

```ts
import { querySyncTool } from "./read/query-sync";
// ... inside buildTools return:
query_sync: querySyncTool(agent),
```

- [ ] **Step 5: Update the system prompt**

In `src/agent/system-prompt.ts`, under "Read tools (available):" add:

```
- \`query_sync(sync_id, query)\` — SELECT-only SQL against a sync's facet SQLite. Use this to answer user questions about the synced data ("how many bugs?", "recent high-priority issues", etc.). Query must start with SELECT or WITH (CTE). No parameter binding — embed literals, escape quotes by doubling. Results capped at 200 rows; narrow server-side. Errors returned as \`{ error: "not_found" | "invalid_sql" | "sqlite_error", detail }\`.
```

Also add a short sentence to the existing "How to handle unfamiliar shapes" / response-flow section if there's a natural place, pointing out that to answer a data question the agent should:

1. Read `<active_syncs>` to pick the sync
2. Call `get_sync` if schema detail is needed
3. Then `query_sync` with the targeted SELECT

- [ ] **Step 6: Run tests and full check**

```
pnpm exec vitest run src/agent/tools/read/query-sync.test.ts
pnpm run check
```

Both green.

- [ ] **Step 7: Commit**

```bash
git add src/agent/tools/read/query-sync.ts src/agent/tools/read/query-sync.test.ts src/agent/tools/index.ts src/agent/system-prompt.ts
git commit -m "$(cat <<'EOF'
Phase 10: query_sync read tool

Agent can now SELECT against a sync's facet SQLite. Tool validates
the query starts with SELECT or WITH (after stripping comments) and
delegates to the wrapper's __query RPC. Returns { row_count, rows }
on success, tagged { error, detail } on validator / sqlite failure.

Row cap at 200 with truncated: true flag — prevents a bloated
SELECT * from blowing the LLM context window. System prompt
documents the contract and a three-step flow for answering user
data questions.

Covered by 7 integration tests: happy SELECT, invalid-SQL rejection,
WITH-CTE acceptance, comment-stripping, not_found, sqlite_error
surface, row-cap truncation.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `delete_sync` tool

Agent calls this to clean up a sync — unregister upstream, drop facet, remove DB rows. Approval-gated.

**Files:**

- Create: `src/agent/tools/write/delete-sync.ts`
- Create: `src/agent/tools/write/delete-sync.test.ts`
- Modify: `src/agent/tools/index.ts` — add `delete_sync`
- Modify: `src/agent/system-prompt.ts` — document `delete_sync` + remove "delete_sync coming later" stub

**Notes:**

- **Step order (network first, local last):** unregister Linear webhook → `ctx.facets.delete(sync.name)` → `DELETE FROM sync_errors WHERE sync_id = ?` → `deleteSync` from db layer. If Linear fails, bail before touching local state so the user can retry.
- **Missing upstream_webhook_id:** defensive — if `sync.upstream_webhook_id` is null, skip the Linear call (shouldn't happen in practice but tolerate it).
- **Error shape:**
  - `{ error: "not_found" }` — unknown sync
  - `{ error: "linear_api_error" | "linear_api_auth_failed", detail }` — Linear rejected the unregister (reuse `LinearApiError.code`)
  - `{ error: "local_cleanup_failed", detail }` — Linear succeeded but facet/DB cleanup threw (rare; surface honestly — user has an orphaned local state that needs attention)
- **Rollback considerations:** unlike `create_sync`, there's no natural rollback once the facet is gone — can't re-attach an old bundle without the old code bytes. So we ensure the ORDER is right (Linear first, irreversible local second).
- `deleteSync` from `src/db/syncs.ts` (line 79) already exists. `unregisterLinearWebhook` already exists. `ctx.facets.delete()` already wired in the fake facets shim.

- [ ] **Step 1: Write the failing test file `src/agent/tools/write/delete-sync.test.ts`**

```ts
import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect, vi } from "vitest";
import { deleteSyncTool } from "./delete-sync";
import { createSync, getSyncById } from "../../../db/syncs";
import { logSyncError } from "../../../db/sync-errors";
import type { NewSync } from "../../../db/types";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

function seedSync(instance: unknown): string {
  const sql = (instance as { sql: (...a: unknown[]) => unknown }).sql.bind(
    instance
  ) as never;
  const id = crypto.randomUUID();
  const input: NewSync = {
    id,
    name: `sync-${id.slice(0, 8)}`,
    integration: "linear",
    handler_code:
      "export async function handleWebhook(){ return new Response('ok'); }",
    schema_ddl: "CREATE TABLE IF NOT EXISTS x (id TEXT);",
    filter_description: null,
    webhook_secret: "s",
    upstream_webhook_id: "wh_test_abc",
    code_id: `sync:${id}:v1`
  };
  createSync(sql, input);
  return id;
}

interface FakeFacets {
  get(name: string, cb: () => unknown): unknown;
  abort: (name: string, reason?: unknown) => void;
  delete: (name: string) => void;
}
function installFakeFacets(instance: unknown, facets: FakeFacets): () => void {
  const ctx = (instance as { ctx: { facets?: FakeFacets } }).ctx;
  const prev = ctx.facets;
  ctx.facets = facets;
  return () => {
    ctx.facets = prev;
  };
}

function stubLinearFetch(opts: { failUnregister?: boolean } = {}): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async (url, init) => {
    if (!String(url).includes("api.linear.app"))
      return original(url as never, init as never);
    if (opts.failUnregister) {
      return new Response(
        JSON.stringify({ errors: [{ message: "simulated linear failure" }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response(
      JSON.stringify({ data: { webhookDelete: { success: true } } }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

describe("delete_sync", () => {
  it("removes the sync end-to-end: Linear unregister + facet delete + db rows", async () => {
    const restore = stubLinearFetch();
    try {
      const stub = env.ChatAgent.get(env.ChatAgent.idFromName("d-happy"));
      await runInDurableObject(stub, async (instance) => {
        await (
          instance as never as { setName: (n: string) => Promise<void> }
        ).setName("d-happy");
        const syncId = seedSync(instance);
        const sql = (
          instance as never as { sql: (...a: unknown[]) => unknown }
        ).sql.bind(instance) as never;
        logSyncError(sql, {
          sync_id: syncId,
          payload_preview: "{}",
          error_message: "prior error",
          stack_trace: null,
          handler_version: 1
        });

        const facetDeletes: string[] = [];
        const restoreFacets = installFakeFacets(instance, {
          get: () => ({ fetch: async () => new Response("ok") }),
          abort: () => {},
          delete: (name) => {
            facetDeletes.push(name);
          }
        });

        try {
          const tool = deleteSyncTool(instance as never);
          const res = await tool.execute!({ sync_id: syncId }, {} as never);
          expect(res).toMatchObject({ ok: true });

          // DO row gone
          expect(getSyncById(sql, syncId)).toBeNull();
          // sync_errors cleaned
          const remaining = sql<{
            c: number;
          }>`SELECT COUNT(*) as c FROM sync_errors WHERE sync_id = ${syncId}`;
          expect(remaining[0].c).toBe(0);
          // Facet dropped
          expect(facetDeletes).toHaveLength(1);
          // Linear called
          const linearCalls = (
            globalThis.fetch as unknown as { mock: { calls: unknown[][] } }
          ).mock.calls.filter((a) => String(a[0]).includes("api.linear.app"));
          expect(linearCalls).toHaveLength(1);
        } finally {
          restoreFacets();
        }
      });
    } finally {
      restore();
    }
  });

  it("returns not_found for an unknown sync_id", async () => {
    const stub = env.ChatAgent.get(env.ChatAgent.idFromName("d-404"));
    await runInDurableObject(stub, async (instance) => {
      await (
        instance as never as { setName: (n: string) => Promise<void> }
      ).setName("d-404");
      const tool = deleteSyncTool(instance as never);
      const res = await tool.execute!(
        { sync_id: "00000000-0000-0000-0000-000000000000" },
        {} as never
      );
      expect(res).toMatchObject({ error: "not_found" });
    });
  });

  it("aborts and preserves local state when Linear unregister fails", async () => {
    const restore = stubLinearFetch({ failUnregister: true });
    try {
      const stub = env.ChatAgent.get(env.ChatAgent.idFromName("d-linearfail"));
      await runInDurableObject(stub, async (instance) => {
        await (
          instance as never as { setName: (n: string) => Promise<void> }
        ).setName("d-linearfail");
        const syncId = seedSync(instance);

        let facetDeleted = false;
        const restoreFacets = installFakeFacets(instance, {
          get: () => ({ fetch: async () => new Response("ok") }),
          abort: () => {},
          delete: () => {
            facetDeleted = true;
          }
        });

        try {
          const tool = deleteSyncTool(instance as never);
          const res = await tool.execute!({ sync_id: syncId }, {} as never);
          expect(res).toMatchObject({
            ok: false,
            error: "linear_api_error",
            detail: expect.stringMatching(/simulated linear failure/)
          });

          // Local state still present — user can retry.
          const sql = (
            instance as never as { sql: (...a: unknown[]) => unknown }
          ).sql.bind(instance) as never;
          expect(getSyncById(sql, syncId)).not.toBeNull();
          expect(facetDeleted).toBe(false);
        } finally {
          restoreFacets();
        }
      });
    } finally {
      restore();
    }
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `pnpm exec vitest run src/agent/tools/write/delete-sync.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/agent/tools/write/delete-sync.ts`**

```ts
import { tool } from "ai";
import { z } from "zod";
import { getSyncById, deleteSync } from "../../../db/syncs";
import {
  unregisterLinearWebhook,
  LinearApiError
} from "../../../integrations/linear-api";
import type { ChatAgent } from "../../../server";

export function deleteSyncTool(agent: ChatAgent) {
  return tool({
    description:
      "Remove a sync entirely. Unregisters the upstream webhook with the integration (so delivery stops), drops the facet + its SQLite database (data is unrecoverable), and deletes the sync row + its error history. Approval-gated — the user confirms in the dialog before anything is destroyed. Use when the user asks to delete, remove, or unsubscribe a sync. For 'pause' semantics we have no dedicated flow yet; say so if asked.",
    inputSchema: z.object({
      sync_id: z.string().describe("The sync's UUID")
    }),
    needsApproval: true,
    execute: async ({
      sync_id
    }): Promise<
      | { ok: true }
      | { ok: false; error: string; detail: string }
      | { error: "not_found"; sync_id: string }
    > => {
      const sql = agent.sql.bind(agent);
      const sync = getSyncById(sql, sync_id);
      if (!sync) return { error: "not_found", sync_id };

      // 1. Unregister upstream webhook (network-touching, may fail).
      //    Skip gracefully if the row somehow has no upstream id.
      if (sync.upstream_webhook_id) {
        try {
          await unregisterLinearWebhook(
            agent.env.LINEAR_ACCESS_TOKEN,
            sync.upstream_webhook_id
          );
        } catch (e) {
          if (e instanceof LinearApiError) {
            return { ok: false, error: e.code, detail: e.message };
          }
          throw e;
        }
      }

      // 2. Drop the facet and its SQLite. Unlike create_sync, once this
      //    runs there's no rollback path — we'd need the old bundle
      //    bytes to re-attach. Order matters: Linear first (reversible
      //    via re-register if we kept the URL), facet second.
      try {
        agent.ctx.facets.delete(sync.name);
      } catch (e) {
        // ctx.facets.delete throws if the facet never started; tolerate
        // that case so a sync whose facet never materialized can still
        // be removed from the registry.
        if (
          !(e instanceof Error) ||
          !/not running|no such facet/i.test(e.message)
        ) {
          return {
            ok: false,
            error: "local_cleanup_failed",
            detail: e instanceof Error ? e.message : String(e)
          };
        }
      }

      // 3. Cascade-clean sync_errors, then remove the registry row.
      sql`DELETE FROM sync_errors WHERE sync_id = ${sync_id}`;
      deleteSync(sql, sync_id);

      return { ok: true };
    }
  });
}
```

- [ ] **Step 4: Wire into `src/agent/tools/index.ts`**

```ts
import { deleteSyncTool } from "./write/delete-sync";
// ... inside buildTools return:
delete_sync: deleteSyncTool(agent),
```

- [ ] **Step 5: Update system prompt**

In `src/agent/system-prompt.ts`:

- Under "Write tool (available):" (which should become plural) add:
  ```
  - \`delete_sync(sync_id)\` — removes a sync: unregisters the upstream webhook, drops the facet + its SQLite, deletes the registry row and error history. Destructive and irreversible. Approval-gated. Use when the user asks to delete, remove, or unsubscribe a sync.
  ```
- Remove `delete_sync` from the "Still-unavailable" list (leave `update_sync`, `run_in_sync` — those land in later phases).

- [ ] **Step 6: Run tests and full check**

```
pnpm exec vitest run src/agent/tools/write/delete-sync.test.ts
pnpm run check
```

- [ ] **Step 7: Commit**

```bash
git add src/agent/tools/write/delete-sync.ts src/agent/tools/write/delete-sync.test.ts src/agent/tools/index.ts src/agent/system-prompt.ts
git commit -m "$(cat <<'EOF'
Phase 10: delete_sync write tool

Agent can now fully remove a sync: unregister the upstream webhook
(network-touching, done first so rollback is still possible),
ctx.facets.delete the isolated facet + its SQLite, cascade-clean
sync_errors rows, then drop the syncs row.

Approval-gated. Returns { ok: true } on success, tagged
{ ok: false, error, detail } on Linear / local-cleanup failure, or
{ error: "not_found", sync_id } for unknown ids.

Network-first ordering means a Linear failure aborts with local
state intact — user retries. Facet delete is irreversible once
it runs (no way to re-attach without the old bundle bytes), so
ordering matters.

Tolerates ctx.facets.delete throwing "facet not running" (happens
for syncs whose facet never materialized) so the registry row
can still be removed.

Covered by 3 integration tests: happy path (Linear + facet + db
all cleaned), not_found, Linear-failure rollback preservation.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Manual smoke against real Linear

**Files:** None — manual verification.

- [ ] **Step 1: Start dev server + tunnel**

`pnpm run dev` + `ngrok http 5173`. Update `PUBLIC_BASE_URL` in `.dev.vars` if tunnel URL changed; restart dev.

- [ ] **Step 2: Create (or keep) a sync via the chat UI**

If you already have a working sync from the Phase 09 smoke, keep it. Otherwise ask the agent to create one.

- [ ] **Step 3: Trigger a Linear event that matches the sync's filter**

Create / edit an issue with High or Medium priority.

- [ ] **Step 4: In the chat, ask a data question**

"How many issues are in my sync?" — the agent should call `query_sync(sync_id, "SELECT COUNT(*) FROM issues")` (or whatever table the handler writes to) and return the count.

"Show me the most recent 5 issues." — `query_sync(sync_id, "SELECT * FROM issues ORDER BY created_at DESC LIMIT 5")`.

- [ ] **Step 5: Ask the agent to delete the sync**

"Delete my sync." — agent calls `delete_sync`, approval dialog shows, you approve. Verify:

- Linear → Settings → Webhooks: the webhook is gone.
- `list_syncs` in chat returns empty (or without this sync).
- `<active_syncs>` ambient context next turn reflects the empty state.

- [ ] **Step 6: Commit only if fixes were needed**

No code changes expected. If bugs surfaced, fold them into separate `fix:` commits.

---

## Out of Scope for Phase 10

- **`update_sync`** — Phase 12. Will reuse `run_in_sync` (Phase 11) for the migration dance, so landing `run_in_sync` first simplifies it.
- **`run_in_sync`** — Phase 11. Adds ad-hoc code execution inside the facet with a one-shot `/exec` entrypoint and its own approval surface.
- **Parameterized SELECT** for `query_sync` — V1 embeds literals. If `SELECT`s with user-controlled strings ever become a concern (V2, multi-user), add a `params: unknown[]` argument and wire through to `sql.exec(query, ...params)`.
- **Result pagination** — 200-row cap is a ceiling, not a pager. Agents should narrow server-side.
- **Soft-delete** for `delete_sync` — hard delete for V1. Undo is out of scope.
