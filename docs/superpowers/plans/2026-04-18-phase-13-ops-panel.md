# Phase 13 — Ops Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a left-sidebar operations panel that shows the user's active syncs (name, integration, version, error count, last updated) and an expandable per-sync details view (handler code, schema DDL, per-table row counts, recent errors). Refresh happens via a dataless change-tick pushed from the supervisor DO over the existing Agents-SDK WebSocket — no polling.

**Architecture:** Two new HTTP endpoints expose supervisor-SQLite-only summary (cheap) and facet-hitting details (lazy). A private `#bumpChangeTick()` on the ChatAgent DO increments a `syncChangeTick` via `this.setState(...)` at the end of every `handleWebhookDelivery` call and every `onChatMessage` turn — the Agents SDK's state-sync channel pushes that to all connected clients. A React hook watches `agent.state.syncChangeTick` and refetches the summary when it changes. Details are lazy-loaded on card expand. The sidebar never polls.

**Tech Stack:** React + Kumo design system, `agents/react`'s `useAgent`, `@cloudflare/ai-chat/react`'s `useAgentChat`, Hono router, Cloudflare Durable Objects (ChatAgent), Vitest + `@cloudflare/vitest-pool-workers`.

**Decisions locked in brainstorming:**

- **Scope = operations panel only.** Tool-result pretty-printing in the chat is out of scope.
- **Sidebar on the left, Kumo Surface, ~320px wide.** Chat stays in the right flex column.
- **No total row count on the collapsed card.** Sum-of-rows-across-tables is a meaningless metric. Per-table counts appear only in the expanded view where they're contextualized.
- **No polling.** A dataless change-tick on `agent.state.syncChangeTick`, pushed from the DO via the Agents-SDK WebSocket, drives refetch. The reviewer watching the Loom sees: sync created → card appears; webhook arrives → timestamp ticks; update lands → version badge flips. All without a visible refresh button.
- **Bump the tick at the supervisor boundary, not inside dynamic facet code.** Two call sites: end of `handleWebhookDelivery` (finally block — always fires) and end of `onChatMessage` (after the stream has been consumed). Agent-authored handler code stays pure.
- **No delete button inside the panel.** The panel is read-only; operations happen in chat via approval-gated tools. "Click delete → prefill chat" felt contrived; the cleaner narrative is "panel displays, chat drives change."
- **No UI tests for V1.** Backend API tests cover the endpoints; manual smoke covers the component integration. Adding a React testing infrastructure just for this phase would be YAGNI.

**V2 upgrade paths (documented, not built):**

- **Per-table row-count streaming.** Right now details fetch calls `__query("SELECT COUNT(*) ...")` for each table. For large tables this could block the UI. V2 could stream counts as they arrive, or cache them on the facet and invalidate on writes.
- **Activity timeline.** A horizontal sparkline of webhook-delivery counts over the last N minutes, backed by a cheap rolling-window counter on the supervisor. Would make the "agent-owned event stream" story even more visible. Out of scope for the 4-day demo; 1-2 hours of work to add later.
- **Approval-dialog code highlighting.** Right now approval dialogs show proposed schema/handler as dense code without syntax highlighting. Could wire Streamdown's code component into the approval path. Separate phase if we get time.
- **Row-count diffing animation.** When the tick fires and the summary refetches, animate count deltas (e.g., `"42 → 43"`) rather than snap-replacing. Nice polish, not demo-critical.

---

## File structure

| File                          | Status | Responsibility                                                                                                                                                                                                          |
| ----------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/server.ts`               | modify | Add two RPC methods on `ChatAgent` (`listSyncsSummary`, `getSyncDetails`); add `#bumpChangeTick` invoked in `handleWebhookDelivery` finally + `onChatMessage` stream-consumed; add two Hono routes proxying into the DO |
| `src/db/syncs.ts`             | modify | Add `getSyncErrorCountSince(sql, sync_id, sinceMs)` helper (sibling to the existing sync-query helpers)                                                                                                                 |
| `src/db/sync-errors.ts`       | modify | Add `getRecentSyncErrors(sql, sync_id, limit)` helper                                                                                                                                                                   |
| `tests/ops-panel-api.test.ts` | create | Covers both endpoints: happy path (summary + details), empty-user, not-found, error-count reporting                                                                                                                     |
| `src/ui/useSyncsSummary.ts`   | create | React hook — fetches `/api/user/:userId/syncs-summary`, refetches when `agent.state.syncChangeTick` changes                                                                                                             |
| `src/ui/useSyncDetails.ts`    | create | React hook — lazy-fetches `/api/user/:userId/syncs/:syncId/details` when a card is expanded                                                                                                                             |
| `src/ui/SyncCard.tsx`         | create | Collapsed card (name / integration / version / error badge / relative timestamp) + expanded view (handler, schema, row counts, errors)                                                                                  |
| `src/ui/SyncPanel.tsx`        | create | Sidebar container — renders the list of cards, empty state, error state                                                                                                                                                 |
| `src/app.tsx`                 | modify | Restructure outer layout to place `<SyncPanel>` as a left sidebar alongside the existing chat column                                                                                                                    |

**No changes to:** `src/facet/*`, `src/execrunner/*`, `src/agent/tools/*`. All write paths stay chat-driven.

---

## Testing notes (read before writing tests)

- **API tests** use `cloudflare:test`'s `env` + `runInDurableObject` pattern plus `SELF.fetch()` for the HTTP layer. See `tests/webhook-delivery.test.ts` for the full Hono-route testing shape.
- **No UI tests** per the phase decision. Manual smoke is Task 4.
- **Signal plumbing (`#bumpChangeTick`)** is NOT tested directly. Rationale: its only job is to call `this.setState`. A unit test would just verify `this.setState` was called, which is a mock-returning-a-mock. The real behavior is "client receives tick, client refetches" — that's an integration flow captured in the manual smoke.
- **`npm run check`** runs oxfmt + oxlint + tsc + vitest. Run before each commit. Pre-existing warning: the newly-created plan doc may not be oxfmt-clean until a follow-up format pass; that's fine.

---

## Task 1: Backend — read helpers + API endpoints

**Files:**

- Modify: `src/db/syncs.ts`
- Modify: `src/db/sync-errors.ts`
- Modify: `src/server.ts`
- Test: `tests/ops-panel-api.test.ts`

- [ ] **Step 1: Add `getSyncErrorCountSince` helper**

At the bottom of `src/db/syncs.ts`, append:

```ts
export function getSyncErrorCountSince(
  sql: SqlTag,
  sync_id: string,
  sinceMs: number
): number {
  const rows = sql<{ c: number }>`
    SELECT COUNT(*) as c FROM sync_errors
    WHERE sync_id = ${sync_id} AND created_at >= ${sinceMs}
  `;
  return rows[0]?.c ?? 0;
}
```

- [ ] **Step 2: Add `getRecentSyncErrors` helper**

First check `src/db/sync-errors.ts` for the existing `SyncError` type export. Then append to the file:

```ts
export function getRecentSyncErrors(
  sql: SqlTag,
  sync_id: string,
  limit: number
): SyncError[] {
  return sql<SyncError>`
    SELECT * FROM sync_errors
    WHERE sync_id = ${sync_id}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
}
```

If `SyncError` isn't already imported at the top of the file, verify the file's existing imports and add `SyncError` to the `../db/types` import. (Likely it's already imported.)

- [ ] **Step 3: Add the API test file with the first failing test (summary with empty user)**

Create `tests/ops-panel-api.test.ts`:

```ts
import { env, SELF, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { createSync } from "../src/db/syncs";
import { logSyncError } from "../src/db/sync-errors";
import type { NewSync, SqlTag } from "../src/db/types";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

function seedSync(instance: unknown, overrides: Partial<NewSync> = {}): string {
  const sql = (instance as { sql: SqlTag }).sql.bind(instance) as SqlTag;
  const id = overrides.id ?? crypto.randomUUID();
  const input: NewSync = {
    id,
    name: overrides.name ?? `sync-${id.slice(0, 8)}`,
    integration: overrides.integration ?? "linear",
    handler_code:
      overrides.handler_code ??
      "export async function handleWebhook(){ return new Response('ok'); }",
    schema_ddl:
      overrides.schema_ddl ??
      "CREATE TABLE IF NOT EXISTS issues (id TEXT PRIMARY KEY);",
    filter_description: overrides.filter_description ?? null,
    webhook_secret: overrides.webhook_secret ?? "s",
    upstream_webhook_id: overrides.upstream_webhook_id ?? "wh_test_abc",
    code_id: overrides.code_id ?? `sync:${id}:v1`
  };
  createSync(sql, input);
  return id;
}

describe("ops panel API", () => {
  it("GET /api/user/:userId/syncs-summary returns empty array for a user with no syncs", async () => {
    const userId = `empty-${crypto.randomUUID()}`;
    const res = await SELF.fetch(
      `https://test.invalid/api/user/${userId}/syncs-summary`
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { syncs: unknown[] };
    expect(body.syncs).toEqual([]);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npm test -- tests/ops-panel-api.test.ts`
Expected: FAIL with 404 — the route doesn't exist yet.

- [ ] **Step 5: Add the `listSyncsSummary` RPC method on ChatAgent**

In `src/server.ts`, inside the `ChatAgent` class (place alongside the other public methods, e.g., after `handleWebhookDelivery`), add:

```ts
  /**
   * Supervisor-SQLite-only summary of this user's syncs. No facet attach —
   * cheap enough to be safe on every signal-driven refetch. Fields are
   * sized to what the sidebar card renders: id/name/integration/version,
   * error count in the last hour (red badge if >0), last-updated timestamp.
   */
  async listSyncsSummary(): Promise<
    Array<{
      id: string;
      name: string;
      integration: string;
      version: number;
      error_count_1h: number;
      updated_at: number;
    }>
  > {
    const sql = this.sql.bind(this);
    const syncs = listSyncs(sql);
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    return syncs.map((s) => ({
      id: s.id,
      name: s.name,
      integration: s.integration,
      version: s.version,
      error_count_1h: getSyncErrorCountSince(sql, s.id, oneHourAgo),
      updated_at: s.updated_at
    }));
  }
```

Add the required imports at the top of `src/server.ts`:

```ts
import { listSyncs, getSyncErrorCountSince } from "./db/syncs";
```

(Adjust the existing import for `./db/syncs` if `getSyncById` is already imported — just extend the destructure.)

- [ ] **Step 6: Add the Hono route for the summary endpoint**

In `src/server.ts`, locate the existing Hono app declarations (look for `app.post("/webhook/:userId/:syncId"`). Add a new route BEFORE the catch-all `app.all("*", ...)`:

```ts
app.get("/api/user/:userId/syncs-summary", async (c) => {
  const { userId } = c.req.param();
  const stub = c.env.ChatAgent.get(c.env.ChatAgent.idFromName(userId));
  const syncs = await stub.listSyncsSummary();
  return c.json({ syncs });
});
```

- [ ] **Step 7: Run the test — expect it to pass**

Run: `npm test -- tests/ops-panel-api.test.ts`
Expected: PASS — empty user returns `{ syncs: [] }`.

- [ ] **Step 8: Add the non-empty summary test**

Append to `tests/ops-panel-api.test.ts` (inside the describe block):

```ts
it("GET /syncs-summary returns syncs + error counts for a user with syncs and recent errors", async () => {
  const userId = `populated-${crypto.randomUUID()}`;
  const stub = env.ChatAgent.get(env.ChatAgent.idFromName(userId));
  let syncId: string;
  await runInDurableObject(stub, async (instance) => {
    await (
      instance as never as { setName: (n: string) => Promise<void> }
    ).setName(userId);
    syncId = seedSync(instance);
    const sql = (instance as { sql: SqlTag }).sql.bind(instance) as SqlTag;
    // Log two errors — both within the last hour.
    logSyncError(sql, {
      sync_id: syncId,
      payload_preview: "{}",
      error_message: "boom 1",
      stack_trace: null,
      handler_version: 1
    });
    logSyncError(sql, {
      sync_id: syncId,
      payload_preview: "{}",
      error_message: "boom 2",
      stack_trace: null,
      handler_version: 1
    });
  });

  const res = await SELF.fetch(
    `https://test.invalid/api/user/${userId}/syncs-summary`
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    syncs: Array<{
      id: string;
      name: string;
      version: number;
      error_count_1h: number;
    }>;
  };
  expect(body.syncs).toHaveLength(1);
  expect(body.syncs[0]!.id).toBe(syncId!);
  expect(body.syncs[0]!.version).toBe(1);
  expect(body.syncs[0]!.error_count_1h).toBe(2);
});
```

- [ ] **Step 9: Run to confirm**

Run: `npm test -- tests/ops-panel-api.test.ts`
Expected: PASS — 2/2 tests green.

- [ ] **Step 10: Add the `getSyncDetails` RPC method**

Inside the `ChatAgent` class, after `listSyncsSummary`, add:

```ts
  /**
   * Full per-sync payload for the sidebar's expanded card. Hits the facet
   * via `__query` once per table to get row counts — more expensive than
   * the summary, so this is fetched lazily when a user expands a card,
   * not on every change-tick.
   */
  async getSyncDetails(syncId: string): Promise<{
    sync: {
      id: string;
      name: string;
      integration: string;
      version: number;
      handler_code: string;
      schema_ddl: string;
      updated_at: number;
    };
    row_counts: Record<string, number>;
    errors: Array<{
      created_at: number;
      error_message: string;
      stack_trace: string | null;
      payload_preview: string;
      handler_version: number;
    }>;
  } | null> {
    const sql = this.sql.bind(this);
    const sync = getSyncById(sql, syncId);
    if (!sync) return null;

    // Parse CREATE TABLE statements from the sync's schema_ddl to get the
    // table names we should COUNT(*) against. Naive — splits on ";" then
    // regex-matches the table name. Robust enough for the CREATE TABLE
    // IF NOT EXISTS shape the agent writes; skips CREATE INDEX / other.
    const tableNames = extractTableNames(sync.schema_ddl);

    const facet = attachFacet(this.env, this.ctx.facets, sync, this.name);
    const row_counts: Record<string, number> = {};
    for (const table of tableNames) {
      const result = await (
        facet as unknown as {
          __query: (
            sql: string
          ) => Promise<
            { ok: true; rows: Array<{ c: number }> } | { ok: false; error: string }
          >;
        }
      ).__query(`SELECT COUNT(*) as c FROM ${table}`);
      row_counts[table] = result.ok ? (result.rows[0]?.c ?? 0) : 0;
    }

    const errors = getRecentSyncErrors(sql, syncId, 10).map((e) => ({
      created_at: e.created_at,
      error_message: e.error_message,
      stack_trace: e.stack_trace,
      payload_preview: e.payload_preview,
      handler_version: e.handler_version
    }));

    return {
      sync: {
        id: sync.id,
        name: sync.name,
        integration: sync.integration,
        version: sync.version,
        handler_code: sync.handler_code,
        schema_ddl: sync.schema_ddl,
        updated_at: sync.updated_at
      },
      row_counts,
      errors
    };
  }
```

And at the bottom of `src/server.ts` (after the existing `payloadPreview` helper), add the table-name extractor:

```ts
/**
 * Pull table names from a `CREATE TABLE [IF NOT EXISTS] <name> (...)`
 * sequence in the schema DDL. Skips CREATE INDEX / triggers / anything
 * that isn't CREATE TABLE. Naive regex — sufficient for the schema
 * shapes the agent is trained to emit.
 */
function extractTableNames(ddl: string): string[] {
  const names: string[] = [];
  const pattern =
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?([a-zA-Z_][a-zA-Z0-9_]*)["`]?/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(ddl)) !== null) {
    if (match[1]) names.push(match[1]);
  }
  return names;
}
```

Update imports in `src/server.ts`:

```ts
import { getSyncById, listSyncs, getSyncErrorCountSince } from "./db/syncs";
import { logSyncError, getRecentSyncErrors } from "./db/sync-errors";
```

- [ ] **Step 11: Add the Hono route for the details endpoint**

Before the catch-all, add:

```ts
app.get("/api/user/:userId/syncs/:syncId/details", async (c) => {
  const { userId, syncId } = c.req.param();
  const stub = c.env.ChatAgent.get(c.env.ChatAgent.idFromName(userId));
  const details = await stub.getSyncDetails(syncId);
  if (!details) return c.json({ error: "not_found" }, 404);
  return c.json(details);
});
```

- [ ] **Step 12: Add the details test — not_found case**

Append to `tests/ops-panel-api.test.ts`:

```ts
it("GET /syncs/:syncId/details returns 404 for unknown sync", async () => {
  const userId = `detail-404-${crypto.randomUUID()}`;
  const res = await SELF.fetch(
    `https://test.invalid/api/user/${userId}/syncs/00000000-0000-0000-0000-000000000000/details`
  );
  expect(res.status).toBe(404);
  const body = (await res.json()) as { error: string };
  expect(body.error).toBe("not_found");
});
```

- [ ] **Step 13: Run to confirm**

Run: `npm test -- tests/ops-panel-api.test.ts`
Expected: PASS — 3/3 tests green.

- [ ] **Step 14: Add the details happy-path test (with fake facet)**

Append to `tests/ops-panel-api.test.ts`:

```ts
it("GET /syncs/:syncId/details returns sync row + row counts + errors for a known sync", async () => {
  const userId = `detail-happy-${crypto.randomUUID()}`;
  const stub = env.ChatAgent.get(env.ChatAgent.idFromName(userId));
  let syncId: string;
  await runInDurableObject(stub, async (instance) => {
    await (
      instance as never as { setName: (n: string) => Promise<void> }
    ).setName(userId);
    syncId = seedSync(instance, {
      schema_ddl:
        "CREATE TABLE IF NOT EXISTS issues (id TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS comments (id TEXT);"
    });
    const sql = (instance as { sql: SqlTag }).sql.bind(instance) as SqlTag;
    logSyncError(sql, {
      sync_id: syncId,
      payload_preview: "{}",
      error_message: "previous failure",
      stack_trace: "Error: prev\n  at handler",
      handler_version: 1
    });

    // Install a fake facet that answers __query with deterministic counts
    // per table name. The details endpoint attaches the facet internally,
    // so we need the fake to be live when the endpoint fires.
    const ctx = (instance as { ctx: { facets?: unknown } }).ctx;
    (ctx as { facets: unknown }).facets = {
      get() {
        return {
          fetch: async () => new Response("ok"),
          __query: async (q: string) => {
            // Deterministic table-name-dependent counts for assertion.
            if (q.includes("FROM issues")) {
              return { ok: true, rows: [{ c: 7 }] };
            }
            if (q.includes("FROM comments")) {
              return { ok: true, rows: [{ c: 3 }] };
            }
            return { ok: true, rows: [{ c: 0 }] };
          },
          __supervisorPing: async () => {}
        };
      },
      abort: () => {},
      delete: () => {}
    };
  });

  const res = await SELF.fetch(
    `https://test.invalid/api/user/${userId}/syncs/${syncId!}/details`
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    sync: { id: string; version: number };
    row_counts: Record<string, number>;
    errors: Array<{ error_message: string }>;
  };
  expect(body.sync.id).toBe(syncId!);
  expect(body.sync.version).toBe(1);
  expect(body.row_counts).toEqual({ issues: 7, comments: 3 });
  expect(body.errors).toHaveLength(1);
  expect(body.errors[0]!.error_message).toBe("previous failure");
});
```

- [ ] **Step 15: Run to confirm 4/4**

Run: `npm test -- tests/ops-panel-api.test.ts`
Expected: PASS — 4/4 tests green.

- [ ] **Step 16: Run the full suite + typecheck**

Run: `npm run check`
Expected: 115/115 tests pass (111 prior + 4 new), format + lint + tsc clean. If the plan doc triggers a format warning that's acceptable — same pattern as earlier phases.

- [ ] **Step 17: Commit**

```bash
git add src/server.ts src/db/syncs.ts src/db/sync-errors.ts tests/ops-panel-api.test.ts
git commit -m "$(cat <<'EOF'
phase 13 task 1: add ops panel API — summary + details endpoints

Two new Hono routes on the supervisor:
- GET /api/user/:userId/syncs-summary — lightweight, supervisor-SQLite
  only, returns { syncs: [{ id, name, integration, version,
  error_count_1h, updated_at }] }. Cheap enough to hit on every
  change-tick from the client.
- GET /api/user/:userId/syncs/:syncId/details — heavy, hits the
  facet via __query for per-table row counts, returns full sync
  row + counts + recent errors. Lazy-fetched only when a card is
  expanded.

Added two helpers: getSyncErrorCountSince and getRecentSyncErrors.
Added a naive extractTableNames that pulls CREATE TABLE names from
the sync's schema_ddl so getSyncDetails can count them.

Tests cover: empty-user summary, populated summary with error
counts, details not_found, details happy path with fake facet
returning deterministic counts.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Backend — signal plumbing (`#bumpChangeTick`)

**Files:**

- Modify: `src/server.ts`

This task has no new tests. Rationale: `#bumpChangeTick` is a one-line `this.setState` call. A unit test would mock `setState` and assert it was called, which is a tautology. The real behavior — "client receives tick, client refetches" — is covered by the Task 4 manual smoke.

- [ ] **Step 1: Add the state shape + bump helper**

In `src/server.ts`, inside the `ChatAgent` class (near the top, after the existing `declare env` / `declare ctx` blocks), add:

```ts
  /**
   * Declare the DO state shape that the Agents SDK syncs to every
   * connected client via WebSocket. `syncChangeTick` is a dataless
   * signal — a monotonically-increasing integer bumped whenever
   * something in the user's syncs may have changed (a tool call
   * finished, a webhook landed, etc.). The client hook watches this
   * field and refetches the summary when it changes. No payload
   * needed; the tick's only job is "something changed, go look again."
   */
  declare state: { syncChangeTick: number } | undefined;

  /**
   * Bump the signal tick. Safe to call multiple times in one turn —
   * the client collapses consecutive updates via React's dep array.
   */
  #bumpChangeTick() {
    const prev = this.state?.syncChangeTick ?? 0;
    this.setState({ ...(this.state ?? {}), syncChangeTick: prev + 1 });
  }
```

- [ ] **Step 2: Wire the bump into `handleWebhookDelivery`**

Locate the existing `handleWebhookDelivery` method in `src/server.ts`. The method already has a try/catch structure around the `facet.fetch` call. Add a `finally` block so the bump fires whether the handler succeeded, returned 5xx, or threw:

```ts
try {
  const facetResponse = await facet.fetch(facetRequest);
  if (facetResponse.status >= 500) {
    logSyncError(sql, {
      sync_id: sync.id,
      payload_preview: payloadPreview(body),
      error_message: `facet returned ${facetResponse.status}`,
      stack_trace: null,
      handler_version: sync.version
    });
    return { status: 500, body: "handler failed" };
  }
  return { status: 200, body: "ok" };
} catch (e) {
  logSyncError(sql, {
    sync_id: sync.id,
    payload_preview: payloadPreview(body),
    error_message: e instanceof Error ? e.message : String(e),
    stack_trace: e instanceof Error ? (e.stack ?? null) : null,
    handler_version: sync.version
  });
  return { status: 500, body: "handler failed" };
} finally {
  // Signal to the client that something changed. Fires on 2xx (row
  // written), 5xx (error logged), and throw (error logged) — any
  // of which could affect what the sidebar should display.
  this.#bumpChangeTick();
}
```

- [ ] **Step 3: Wire the bump into `onChatMessage`**

Find the existing `onChatMessage` method. It currently returns the streaming response directly. Modify it to fire the bump after the stream finishes:

```ts
  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const anthropic = createAnthropic({ apiKey: this.env.ANTHROPIC_API_KEY });
    const sql = this.sql.bind(this);

    const messages = [
      ...buildContextMessages(sql),
      ...(await convertToModelMessages(this.messages))
    ];

    const mcpTools = this.mcp.getAITools();

    const result = streamText({
      model: anthropic(MODEL_ID),
      system: {
        role: "system",
        content: SYSTEM_PROMPT,
        providerOptions: {
          anthropic: { cacheControl: { type: "ephemeral" } }
        }
      },
      messages,
      tools: {
        ...mcpTools,
        ...buildTools(this)
      },
      stopWhen: stepCountIs(5),
      abortSignal: options?.abortSignal,
      onFinish: () => {
        // Signal panel clients to refetch after every completed turn —
        // any tool call that wrote to the supervisor or facet is captured
        // by this tick. The AI SDK's onFinish fires after the full stream
        // (including tool-call results) has been consumed.
        this.#bumpChangeTick();
      }
    });

    return result.toUIMessageStreamResponse();
  }
```

- [ ] **Step 4: Verify nothing broke**

Run: `npm run check`
Expected: 115/115 tests still pass (the bump is additive; existing tests don't assert on state, so the extra `setState` call is invisible to them). Format + lint + tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts
git commit -m "$(cat <<'EOF'
phase 13 task 2: wire change-tick signal at webhook + chat boundaries

The supervisor bumps `state.syncChangeTick` in two places:
- finally block of handleWebhookDelivery (fires on 2xx, 5xx, throw)
- onFinish of onChatMessage's streamText (fires after the full turn
  including any tool-call results has been consumed)

The Agents SDK pushes state updates to all connected WebSocket
clients automatically via `setState`. The sidebar hook (Task 3)
watches `agent.state.syncChangeTick` and refetches the summary
when it changes — no polling, dataless signal, single source of
truth for "the user's syncs may have changed."

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Frontend — hooks + components + layout integration

**Files:**

- Create: `src/ui/useSyncsSummary.ts`
- Create: `src/ui/useSyncDetails.ts`
- Create: `src/ui/SyncCard.tsx`
- Create: `src/ui/SyncPanel.tsx`
- Modify: `src/app.tsx`

- [ ] **Step 1: Create the summary hook**

Create `src/ui/useSyncsSummary.ts`:

```ts
import { useCallback, useEffect, useState } from "react";

export interface SyncSummary {
  id: string;
  name: string;
  integration: string;
  version: number;
  error_count_1h: number;
  updated_at: number;
}

/**
 * Fetches `/api/user/:userId/syncs-summary` on mount and whenever the
 * supervisor's `syncChangeTick` state field changes. No polling. The
 * tick is dataless — receiving it means "refetch"; what specifically
 * changed isn't encoded in the signal.
 */
export function useSyncsSummary(
  userId: string,
  syncChangeTick: number | undefined
) {
  const [syncs, setSyncs] = useState<SyncSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    try {
      const res = await fetch(`/api/user/${userId}/syncs-summary`);
      if (!res.ok) {
        setError(`HTTP ${res.status}`);
        return;
      }
      const body = (await res.json()) as { syncs: SyncSummary[] };
      setSyncs(body.syncs);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [userId]);

  // Fires on mount (syncChangeTick is undefined, first run) AND on every
  // tick change (supervisor published a signal). Single effect covers
  // both paths because undefined → number is a dependency change.
  useEffect(() => {
    void refetch();
  }, [refetch, syncChangeTick]);

  return { syncs, error, refetch };
}
```

- [ ] **Step 2: Create the details hook**

Create `src/ui/useSyncDetails.ts`:

```ts
import { useCallback, useState } from "react";

export interface SyncDetails {
  sync: {
    id: string;
    name: string;
    integration: string;
    version: number;
    handler_code: string;
    schema_ddl: string;
    updated_at: number;
  };
  row_counts: Record<string, number>;
  errors: Array<{
    created_at: number;
    error_message: string;
    stack_trace: string | null;
    payload_preview: string;
    handler_version: number;
  }>;
}

/**
 * Lazy-fetches `/api/user/:userId/syncs/:syncId/details`. Called by
 * SyncCard when a user expands a card; NOT driven by the change-tick
 * (too expensive — the details endpoint hits the facet for per-table
 * row counts). The card's expanded view manually refetches via the
 * returned `refetch` after actions that would invalidate it.
 */
export function useSyncDetails(userId: string, syncId: string | null) {
  const [details, setDetails] = useState<SyncDetails | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    if (!syncId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/user/${userId}/syncs/${syncId}/details`);
      if (res.status === 404) {
        setError("not_found");
        setDetails(null);
        return;
      }
      if (!res.ok) {
        setError(`HTTP ${res.status}`);
        return;
      }
      const body = (await res.json()) as SyncDetails;
      setDetails(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [userId, syncId]);

  return { details, loading, error, refetch };
}
```

- [ ] **Step 3: Create the SyncCard component**

Create `src/ui/SyncCard.tsx`:

```tsx
import { useCallback, useEffect, useState } from "react";
import { Badge, Surface, Text, Button } from "@cloudflare/kumo";
import { CaretDownIcon, CaretUpIcon, WarningIcon } from "@phosphor-icons/react";
import type { SyncSummary } from "./useSyncsSummary";
import { useSyncDetails } from "./useSyncDetails";

function relativeTime(ms: number): string {
  const delta = Date.now() - ms;
  if (delta < 60_000) return "just now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}

interface SyncCardProps {
  userId: string;
  sync: SyncSummary;
}

export function SyncCard({ userId, sync }: SyncCardProps) {
  const [expanded, setExpanded] = useState(false);
  const { details, loading, error, refetch } = useSyncDetails(
    userId,
    expanded ? sync.id : null
  );

  // Fetch details the first time the card is expanded. Subsequent
  // expands reuse the cached details; the hook exposes `refetch` if
  // we ever need to bust the cache.
  useEffect(() => {
    if (expanded && !details && !loading && !error) {
      void refetch();
    }
  }, [expanded, details, loading, error, refetch]);

  const toggle = useCallback(() => setExpanded((v) => !v), []);

  return (
    <Surface className="rounded-lg ring ring-kumo-line p-3 space-y-2">
      <button
        type="button"
        onClick={toggle}
        className="w-full flex items-start justify-between text-left"
        aria-expanded={expanded}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Text size="sm" bold className="truncate">
              {sync.name}
            </Text>
            <Badge variant="secondary">v{sync.version}</Badge>
          </div>
          <div className="flex items-center gap-2 mt-1">
            <Text size="xs" variant="secondary">
              {sync.integration}
            </Text>
            <Text size="xs" variant="secondary">
              · {relativeTime(sync.updated_at)}
            </Text>
            {sync.error_count_1h > 0 ? (
              <Badge variant="destructive">
                <WarningIcon size={10} className="mr-0.5" />
                {sync.error_count_1h} err
              </Badge>
            ) : (
              <Text size="xs" variant="secondary">
                — no errors
              </Text>
            )}
          </div>
        </div>
        <div className="shrink-0 ml-2 pt-0.5">
          {expanded ? <CaretUpIcon size={14} /> : <CaretDownIcon size={14} />}
        </div>
      </button>

      {expanded && (
        <div className="pt-2 border-t border-kumo-line space-y-3">
          {loading && (
            <Text size="xs" variant="secondary">
              Loading…
            </Text>
          )}
          {error && (
            <Text size="xs" variant="secondary">
              Failed to load details: {error}
            </Text>
          )}
          {details && (
            <>
              <div>
                <Text size="xs" bold className="mb-1">
                  Row counts
                </Text>
                {Object.keys(details.row_counts).length === 0 ? (
                  <Text size="xs" variant="secondary">
                    No tables discovered in schema_ddl.
                  </Text>
                ) : (
                  <div className="space-y-0.5">
                    {Object.entries(details.row_counts).map(([t, c]) => (
                      <div
                        key={t}
                        className="flex justify-between text-xs font-mono"
                      >
                        <span>{t}</span>
                        <span className="text-kumo-subtle">{c}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <details>
                <summary className="text-xs font-medium cursor-pointer text-kumo-default">
                  Handler code
                </summary>
                <pre className="mt-1 p-2 text-xs font-mono bg-kumo-base rounded overflow-x-auto whitespace-pre-wrap max-h-64">
                  {details.sync.handler_code}
                </pre>
              </details>

              <details>
                <summary className="text-xs font-medium cursor-pointer text-kumo-default">
                  Schema DDL
                </summary>
                <pre className="mt-1 p-2 text-xs font-mono bg-kumo-base rounded overflow-x-auto whitespace-pre-wrap max-h-64">
                  {details.sync.schema_ddl}
                </pre>
              </details>

              {details.errors.length > 0 && (
                <details>
                  <summary className="text-xs font-medium cursor-pointer text-kumo-default">
                    Recent errors ({details.errors.length})
                  </summary>
                  <div className="mt-1 space-y-2">
                    {details.errors.map((err, i) => (
                      <div
                        key={i}
                        className="p-2 text-xs bg-kumo-base rounded ring ring-kumo-line"
                      >
                        <div className="flex justify-between mb-1">
                          <span className="font-mono text-kumo-subtle">
                            v{err.handler_version}
                          </span>
                          <span className="text-kumo-subtle">
                            {relativeTime(err.created_at)}
                          </span>
                        </div>
                        <div className="font-mono break-all mb-1">
                          {err.error_message}
                        </div>
                        {err.stack_trace && (
                          <details>
                            <summary className="cursor-pointer text-kumo-subtle text-xs">
                              Stack trace
                            </summary>
                            <pre className="mt-1 whitespace-pre-wrap text-[10px] font-mono">
                              {err.stack_trace}
                            </pre>
                          </details>
                        )}
                      </div>
                    ))}
                  </div>
                </details>
              )}

              <div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void refetch()}
                  disabled={loading}
                >
                  Refresh details
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </Surface>
  );
}
```

- [ ] **Step 4: Create the SyncPanel component**

Create `src/ui/SyncPanel.tsx`:

```tsx
import { Surface, Text, Empty } from "@cloudflare/kumo";
import { PlugsConnectedIcon } from "@phosphor-icons/react";
import { useSyncsSummary } from "./useSyncsSummary";
import { SyncCard } from "./SyncCard";

interface SyncPanelProps {
  userId: string;
  syncChangeTick: number | undefined;
}

export function SyncPanel({ userId, syncChangeTick }: SyncPanelProps) {
  const { syncs, error } = useSyncsSummary(userId, syncChangeTick);

  return (
    <aside className="w-80 shrink-0 border-r border-kumo-line bg-kumo-base flex flex-col h-screen">
      <div className="px-4 py-3 border-b border-kumo-line">
        <div className="flex items-center gap-2">
          <PlugsConnectedIcon size={16} className="text-kumo-accent" />
          <Text size="sm" bold>
            Syncs
          </Text>
          {syncs && syncs.length > 0 && (
            <Text size="xs" variant="secondary">
              ({syncs.length})
            </Text>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {error && (
          <Surface className="rounded-lg p-3 ring ring-kumo-danger">
            <Text size="xs" variant="secondary">
              Failed to load syncs: {error}
            </Text>
          </Surface>
        )}
        {!syncs && !error && (
          <Text size="xs" variant="secondary">
            Loading…
          </Text>
        )}
        {syncs && syncs.length === 0 && (
          <Empty
            title="No syncs yet"
            description="Ask the agent to create one — e.g., 'create a sync for Linear issues'."
          />
        )}
        {syncs &&
          syncs.map((s) => <SyncCard key={s.id} userId={userId} sync={s} />)}
      </div>
    </aside>
  );
}
```

If `Empty` isn't exported from `@cloudflare/kumo`, substitute a plain `<div>`:

```tsx
{
  syncs && syncs.length === 0 && (
    <div className="text-center py-8">
      <Text size="xs" variant="secondary">
        No syncs yet. Ask the agent to create one — e.g., "create a sync for
        Linear issues".
      </Text>
    </div>
  );
}
```

(Check the existing `app.tsx` imports from `@cloudflare/kumo`; if `Empty` is listed there, the first form is correct. Otherwise use the fallback.)

- [ ] **Step 5: Integrate the sidebar into the app layout**

In `src/app.tsx`, add the import at the top with the other UI imports:

```tsx
import { SyncPanel } from "./ui/SyncPanel";
```

Locate the outermost return of the `Chat()` component. It's currently a single div containing the header + messages + input. Wrap that div with a flex-row container that places `<SyncPanel>` to its left:

Before (approximate shape):

```tsx
return (
  <div
    className="h-screen flex flex-col bg-kumo-elevated"
    // ... drag handlers ...
  >
    {/* drag overlay, header, messages, input */}
  </div>
);
```

After:

```tsx
return (
  <div className="flex h-screen bg-kumo-elevated">
    <SyncPanel
      userId={userId}
      syncChangeTick={
        (agent.state as { syncChangeTick?: number } | undefined)?.syncChangeTick
      }
    />
    <div
      className="flex-1 flex flex-col relative"
      // ... keep all existing drag handlers + classes the original div had ...
    >
      {/* drag overlay, header, messages, input — unchanged */}
    </div>
  </div>
);
```

Important points:

- Keep the existing drag-and-drop handlers on the inner div (don't move them to the outer wrapper — otherwise dropping onto the sidebar would trigger a chat attachment).
- Remove `h-screen` from the inner div; the outer flex container owns height now.
- Keep `relative` on the inner div so the drag overlay positions correctly.
- The `userId` is the value the `Chat()` component already resolved via `useState(() => ...)` — just pass it through.
- `agent.state` type is inferred; cast to the shape we care about inline so TS accepts the optional access.

- [ ] **Step 6: Run typecheck + full suite**

Run: `npm run check`
Expected: 115/115 tests still pass. tsc + oxlint + oxfmt clean.

If `Empty` isn't in Kumo's exports, tsc will surface that immediately — swap to the fallback div from Step 4 and re-run.

- [ ] **Step 7: Commit**

```bash
git add src/ui/ src/app.tsx
git commit -m "$(cat <<'EOF'
phase 13 task 3: add operations sidebar (SyncPanel, SyncCard, hooks)

Left sidebar shows each of the user's syncs: name, integration,
version, error count in the last hour, relative last-updated
timestamp. Click a card to expand — lazy-fetches full details:
handler code, schema DDL, per-table row counts, recent errors.

No polling: useSyncsSummary watches agent.state.syncChangeTick
(pushed from the DO via the Agents SDK WebSocket) and refetches
on any change. Details are one-shot on expand.

Restructured Chat() to a flex-row outer layout: SyncPanel on
the left, existing chat column on the right. Drag-and-drop
handlers stayed on the chat column.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Manual end-to-end smoke

**Files:** none (manual validation)

- [ ] **Step 1: Start the dev server and load the chat**

```bash
npm run dev
```

Open the local URL. You should see the new sidebar on the left, showing whatever syncs you have registered from prior phase smokes. If the sidebar is empty, create a sync first via chat.

- [ ] **Step 2: Card data on mount**

Verify for each visible card:

- Name matches the sync name
- Integration + version badge ("linear · v3")
- Error count shows "— no errors" (if clean) or a red badge (if there are recent errors)
- Relative timestamp is sensible ("5m ago", "just now", etc.)

- [ ] **Step 3: Expand a card**

Click a card. Verify:

- Expands inline (no modal)
- "Loading…" briefly appears
- Row counts section shows per-table counts (or "No tables discovered" if the schema_ddl has no CREATE TABLE)
- Handler code, Schema DDL, Recent errors (if any) sections are available as collapsible details
- "Refresh details" button is visible

Expand another card — verify they expand independently (not a single-active-card accordion).

- [ ] **Step 4: Webhook-driven tick (no-poll proof)**

Keep the browser open on the chat page. Trigger a Linear event (edit an issue title, create a new issue, etc.). Within a few seconds (typically <1s — it's WebSocket-pushed, not polled):

- The error count, or at minimum the "updated_at" timestamp, should refresh on the affected sync's card
- Open DevTools' Network tab: you should NOT see periodic requests to `/syncs-summary` — only one on mount and then one per webhook event

If you see polling requests every 10 seconds, Task 2's signal wiring is broken — check that `#bumpChangeTick` is being called.

- [ ] **Step 5: Tool-driven tick**

In chat: "update my Linear sync's handler to just return 200 OK and ignore the payload."

After the agent proposes + you approve + it returns `ok: true`:

- The version badge on the affected sync's card should flip (e.g., `v3` → `v4`)
- DevTools Network tab: one new request to `/syncs-summary` immediately after the tool call's approval round-trip finishes

- [ ] **Step 6: New sync appears without reload**

In chat: "create a small test sync for Linear comments only."

After the agent proposes + you approve:

- A new card for the new sync should appear in the sidebar automatically
- No page reload, no manual refresh click

- [ ] **Step 7: Delete via chat removes the card**

In chat: "delete the test sync I just made."

After approval:

- The card disappears from the sidebar automatically

- [ ] **Step 8: Empty state**

If at any point you delete all your syncs: verify the sidebar shows the "No syncs yet" empty state instead of a blank list.

- [ ] **Step 9: Refresh details button**

Expand a card, click "Refresh details". Verify the loading indicator fires and row counts are re-fetched (same counts if nothing changed; updated counts if a webhook landed between expand and refresh).

- [ ] **Step 10: Stop the dev server.** Nothing to commit — Task 4 is validation only.

If any step fails, capture the exact output (browser console, server terminal, Network tab) and diagnose before declaring the phase done.

---

## Spec coverage / self-review

| Decision from brainstorming                                                          | Covered by                                                                                            |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Operations panel only; no chat-tool prettification                                   | Task 3 scope (no tool-card changes)                                                                   |
| Sidebar left, ~320px                                                                 | Task 3 Step 5 (`w-80 shrink-0 border-r`)                                                              |
| No total row count on collapsed card                                                 | Task 3 Step 3 (SyncCard collapsed view omits it)                                                      |
| Per-table row counts only in expanded view                                           | Task 3 Step 3 (expanded view `row_counts` table)                                                      |
| No polling — change-tick signal over WebSocket                                       | Task 2 (`#bumpChangeTick`) + Task 3 Step 1 (`useSyncsSummary` watches `syncChangeTick`)               |
| Bump at supervisor boundary, not inside facet handler                                | Task 2 Step 2 + Step 3 (bump in `handleWebhookDelivery` and `onChatMessage`, not inside facet source) |
| No delete button in panel                                                            | Task 3 Step 3 (SyncCard has no delete affordance)                                                     |
| Details lazy-loaded on expand                                                        | Task 3 Step 2 (`useSyncDetails` only fires when `syncId` is non-null)                                 |
| Two endpoints (summary cheap, details heavy)                                         | Task 1 Steps 5-6 + 10-11                                                                              |
| No UI tests for V1                                                                   | Task 1 covers API; manual smoke covers UI                                                             |
| V2 paths (row-count streaming, activity timeline, code highlighting, diff animation) | Documented in plan header                                                                             |

All sections land in at least one task. No placeholders. Types and endpoint shapes consistent across backend (`listSyncsSummary` return type) and frontend (`SyncSummary` interface). `SyncDetails` shape in the hook matches `getSyncDetails` return type one-for-one.
