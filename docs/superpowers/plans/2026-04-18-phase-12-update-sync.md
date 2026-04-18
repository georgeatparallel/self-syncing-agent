# Phase 12 — `update_sync` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `update_sync` tool so the agent can atomically update a sync's `handler_code`, `schema_ddl`, and/or apply a `migration_ddl` in one approval-gated operation. The live facet gets a new version of its bundle with compile-failure rollback.

**Architecture:** Tool orchestrates a 5-step flow: (1) migration DDL runs against the live facet via the existing `__sqlExec` RPC; (2) supervisor SQLite row is updated with a bumped `version` and new `code_id`; (3) `ctx.facets.abort(name)` shuts down the old isolate (storage preserved on the DO); (4) `attachFacet(...)` with the new `code_id` forces a Worker Loader cache miss and starts a fresh isolate with the new bundle; (5) `__supervisorPing()` forces compile so syntax errors fail here, triggering rollback. Rollback path on compile failure: restore the supervisor row to old values + re-attach old `code_id`. The facet's SQLite persists across aborts — only the isolate is swapped.

**Tech Stack:** TypeScript, Cloudflare Workers, Durable Object Facets, Worker Loader, Vitest + `@cloudflare/vitest-pool-workers`, Vercel AI SDK.

**Decisions locked in brainstorming (captured here so the spec doc is skipped):**

- **Scope = bundle swap + migration, NOT backfill.** Backfill is a separate `run_in_sync` call. Rationale: migration and swap share the "version bump" approval semantics; backfill is conceptually separate and often optional. We already have `run_in_sync` as a primitive — no need to re-implement the exec pipeline.
- **All inputs optional except `sync_id`.** At least one of `handler_code` / `schema_ddl` / `migration_ddl` must be present; a call with only `sync_id` is rejected as `no_changes`. Supports the common "just fix the handler" case without forcing the agent to re-send unchanged schema.
- **`schema_ddl` is the full target state, always.** Agent sends complete `CREATE TABLE` / `CREATE INDEX` statements. Token-heavier than a diff but auditable and unambiguous. `migration_ddl` is the how-to-get-there transition.
- **Migration runs BEFORE the swap.** `__sqlExec` needs a live isolate; aborting first would leave no one to run migration SQL against. Consequence: old handler is briefly live with post-migration schema. Additive migrations (ADD COLUMN) are safe; destructive ones need the agent to pair migration + handler_code carefully.
- **Webhook-during-update race is bounded by Linear retries.** A webhook arriving in the ~tens-of-ms swap window gets a 500 from the existing `handleWebhookDelivery` catch, which Linear retries at 1min / 1hr / 6hr. Zero data loss, ~60s max delay.
- **V2 paths (documented, not built):** Drizzle-managed schemas (agent runs drizzle-kit to produce schema + migration as a unit, supervisor persists drizzle state); draining step before destructive migrations (block webhooks via supervisor flag during the swap window); Tail-Worker observability for failed swaps.

**Spec reference:** None — design locked in brainstorming. Phase 11's spec at `docs/superpowers/specs/2026-04-18-phase-11-run-in-sync-design.md` is adjacent context for the `__sqlExec` RPC this plan reuses.

---

## File structure

| File                                        | Status | Responsibility                                                                                                                                              |
| ------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/agent/tools/write/update-sync.ts`      | create | The tool — orchestrates validation → migration → persist → abort → re-attach → ping, with rollback on compile failure                                       |
| `src/agent/tools/write/update-sync.test.ts` | create | 8 test cases: not_found, no_changes, happy (all three fields), handler-only, schema-only, migration-only, migration_failed, facet_load_failed-with-rollback |
| `src/agent/tools/index.ts`                  | modify | Register `update_sync` in `buildTools`                                                                                                                      |
| `src/agent/system-prompt.ts`                | modify | Add `update_sync` to the "Write tools (available)" list, insert a new `### update_sync contract` subsection, remove it from "What's out of scope"           |

**No changes to:**

- `src/facet/wrapper.ts` — `__sqlExec` (Phase 11) is the migration vehicle; `__supervisorPing` (Phase 08) is the compile probe. Both exist.
- `src/facet/bundle.ts` / `src/facet/loader.ts` — `attachFacet` already handles the new-`code_id` case via Worker Loader cache miss. Nothing new to build.
- `src/execrunner/*` — update_sync doesn't use the exec isolate; migrations run on the live facet.
- `src/db/syncs.ts` — `updateSync(sql, id, SyncPatch)` already exists and accepts `handler_code`, `schema_ddl`, `version`, `code_id` — exactly what we need.

---

## Testing notes (read before writing tests)

- **Test runner:** `npm test` (maps to `vitest run`). Config at `vitest.config.ts`.
- **Fake facets pattern:** established in `src/agent/tools/write/delete-sync.test.ts`. For Phase 12 the fake needs two RPC methods (`__sqlExec`, `__supervisorPing`) plus the facet-level operations (`abort`, `get`, `delete`). Reuse the pattern; define a local `FakeFacetStub` with the two RPCs.
- **No fake LOADER needed.** Unlike Phase 11, update_sync does not call `env.LOADER.load(...)` directly — `attachFacet` does that via Worker Loader, which our fakes bypass entirely (we replace `ctx.facets` so `attachFacet` returns whatever the fake provides).
- **The rollback test is the critical case.** When `__supervisorPing` throws after the DB has been bumped, the tool must: (a) restore the DB row to old values, (b) call `attachFacet` again with the ORIGINAL sync (old code_id), (c) return `facet_load_failed`. The test asserts all three observable effects (DB reverted, old facet re-attached, correct error shape).
- **`npm run check`:** runs format + lint + tsc + vitest. Run before each commit.

---

## Task 1: Implement `update_sync` tool with full test coverage

**Files:**

- Create: `src/agent/tools/write/update-sync.ts`
- Test: `src/agent/tools/write/update-sync.test.ts`

- [ ] **Step 1: Create the test file with the first failing test (not_found)**

Create `src/agent/tools/write/update-sync.test.ts`:

```ts
import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { updateSyncTool } from "./update-sync";
import { createSync, getSyncById } from "../../../db/syncs";
import type { NewSync, Sync, SqlTag } from "../../../db/types";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

type SqlExecResult =
  | { ok: true; rowsWritten: number; rowsRead: number }
  | { ok: false; error: string };

interface FakeFacetStub {
  fetch: (req: Request) => Promise<Response>;
  __sqlExec: (sql: string, ...bindings: unknown[]) => Promise<SqlExecResult>;
  __supervisorPing: () => Promise<void>;
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

function seedSync(instance: unknown): Sync {
  const sql = (instance as { sql: SqlTag }).sql.bind(instance) as SqlTag;
  const id = crypto.randomUUID();
  const input: NewSync = {
    id,
    name: `sync-${id.slice(0, 8)}`,
    integration: "linear",
    handler_code:
      "export async function handleWebhook(){ return new Response('ok'); }",
    schema_ddl: "CREATE TABLE IF NOT EXISTS issues (id TEXT PRIMARY KEY);",
    filter_description: null,
    webhook_secret: "s",
    upstream_webhook_id: "wh_test_abc",
    code_id: `sync:${id}:v1`
  };
  createSync(sql, input);
  return getSyncById(sql, id)!;
}

describe("update_sync", () => {
  it("returns not_found for an unknown sync_id", async () => {
    const stub = env.ChatAgent.get(env.ChatAgent.idFromName("u-404"));
    await runInDurableObject(stub, async (instance) => {
      await (
        instance as never as { setName: (n: string) => Promise<void> }
      ).setName("u-404");
      const tool = updateSyncTool(instance as never);
      const res = await tool.execute!(
        {
          sync_id: "00000000-0000-0000-0000-000000000000",
          handler_code:
            "export async function handleWebhook(){ return new Response('ok'); }"
        },
        {} as never
      );
      expect(res).toMatchObject({ error: "not_found" });
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/agent/tools/write/update-sync.test.ts`
Expected: FAIL — `./update-sync` does not exist.

- [ ] **Step 3: Implement the tool**

Create `src/agent/tools/write/update-sync.ts`:

```ts
import { tool } from "ai";
import { z } from "zod";
import { getSyncById, updateSync } from "../../../db/syncs";
import { attachFacet } from "../../../facet/loader";
import type { ChatAgent } from "../../../server";

type SqlExecResult =
  | { ok: true; rowsWritten: number; rowsRead: number }
  | { ok: false; error: string };

interface FacetRpcSurface {
  __sqlExec(sql: string, ...bindings: unknown[]): Promise<SqlExecResult>;
  __supervisorPing(): Promise<void>;
}

type UpdateSyncResult =
  | { error: "not_found"; sync_id: string }
  | { ok: false; error: "no_changes" }
  | { ok: false; error: "migration_failed"; detail: string }
  | { ok: false; error: "facet_abort_failed"; detail: string }
  | { ok: false; error: "facet_load_failed"; detail: string }
  | { ok: true; new_version: number };

export function updateSyncTool(agent: ChatAgent) {
  return tool({
    description:
      "Update an existing sync's handler code and/or schema. Approval-gated. All fields except sync_id are optional — send only what's changing. When schema_ddl is provided, send the FULL target schema (all CREATE TABLE / CREATE INDEX statements), not a diff. When the schema is materially changing (new columns, new tables), pair it with migration_ddl (ALTER TABLE statements) that transitions existing data. If a bad handler_code prevents the new bundle from compiling, the update is rolled back and the sync stays on its old version. Use for bug fixes in handler_code, schema evolution, and filter changes.",
    inputSchema: z
      .object({
        sync_id: z.string().describe("The sync's UUID."),
        handler_code: z
          .string()
          .min(1)
          .optional()
          .describe(
            "New handler.js source. Must export `async function handleWebhook(request, sql)`. Omit if handler isn't changing."
          ),
        schema_ddl: z
          .string()
          .min(1)
          .optional()
          .describe(
            "FULL target schema as CREATE TABLE / CREATE INDEX statements separated by semicolons. Not a diff — send the entire schema even for a single-column change. Use CREATE TABLE IF NOT EXISTS so re-applying is safe. Omit if schema isn't changing."
          ),
        migration_ddl: z
          .string()
          .min(1)
          .optional()
          .describe(
            "ALTER TABLE / ALTER INDEX / etc. that transitions the facet's existing SQLite from the old schema to the new one. Required when schema_ddl materially changes an existing table (ADD COLUMN, rename, type change). Not needed for adding entirely new tables (the new schema_ddl's CREATE TABLE IF NOT EXISTS covers that). Runs against the LIVE facet before the bundle swap."
          )
      })
      .refine(
        (d) =>
          d.handler_code !== undefined ||
          d.schema_ddl !== undefined ||
          d.migration_ddl !== undefined,
        {
          message:
            "at least one of handler_code, schema_ddl, migration_ddl must be provided"
        }
      ),
    needsApproval: true,
    execute: async ({
      sync_id,
      handler_code,
      schema_ddl,
      migration_ddl
    }): Promise<UpdateSyncResult> => {
      const sql = agent.sql.bind(agent);
      const oldSync = getSyncById(sql, sync_id);
      if (!oldSync) return { error: "not_found" as const, sync_id };

      // Defence-in-depth: zod's refine should already catch this, but tools
      // called with unexpected shapes surface a cleaner error than a schema
      // exception.
      if (
        handler_code === undefined &&
        schema_ddl === undefined &&
        migration_ddl === undefined
      ) {
        return { ok: false as const, error: "no_changes" as const };
      }

      // 1. Migration runs against the LIVE facet. __sqlExec requires a live
      //    isolate; we can't abort first. For ADD COLUMN and similar
      //    additive changes, the old handler keeps writing the old shape
      //    harmlessly until the swap lands.
      if (migration_ddl !== undefined) {
        const oldFacet = attachFacet(
          agent.env,
          agent.ctx.facets,
          oldSync,
          agent.name
        );
        const result = await (oldFacet as unknown as FacetRpcSurface).__sqlExec(
          migration_ddl
        );
        if (!result.ok) {
          return {
            ok: false as const,
            error: "migration_failed" as const,
            detail: result.error
          };
        }
      }

      // 2. Persist the new row with bumped version + new code_id. This is
      //    the "commit point" — anything that fails after here requires
      //    rollback to keep DB and facet in sync.
      const newVersion = oldSync.version + 1;
      const newCodeId = `sync:${oldSync.id}:v${newVersion}`;
      const newSync = updateSync(sql, sync_id, {
        handler_code,
        schema_ddl,
        version: newVersion,
        code_id: newCodeId
      });

      // 3. Abort the old isolate. Facet storage persists across aborts —
      //    only the running class/isolate is torn down. Tolerate "not
      //    running" the same way delete_sync does: a facet that never
      //    materialized doesn't need aborting.
      try {
        agent.ctx.facets.abort(
          oldSync.name,
          new Error(`update_sync: swapping to v${newVersion}`)
        );
      } catch (e) {
        if (
          !(e instanceof Error) ||
          !/not running|no such facet/i.test(e.message)
        ) {
          // Unexpected abort failure. Roll back the DB row; facet may still
          // be running in a half-aborted state, but subsequent webhook
          // delivery will re-attach correctly against the v1 code_id.
          updateSync(sql, sync_id, {
            handler_code: oldSync.handler_code,
            schema_ddl: oldSync.schema_ddl,
            version: oldSync.version,
            code_id: oldSync.code_id
          });
          return {
            ok: false as const,
            error: "facet_abort_failed" as const,
            detail: e instanceof Error ? e.message : String(e)
          };
        }
      }

      // 4. Re-attach with the new code_id. Worker Loader sees a cache miss
      //    (code_id changed) and compiles the new bundle. __supervisorPing
      //    is a no-op RPC whose only job is to force compile — if handler_code
      //    has a syntax error, the ping rejects and we rollback.
      try {
        const newFacet = attachFacet(
          agent.env,
          agent.ctx.facets,
          newSync,
          agent.name
        );
        await (newFacet as unknown as FacetRpcSurface).__supervisorPing();
      } catch (e) {
        // Rollback: restore the DB row to v1, re-attach with the old code_id
        // so the sync is live again on its previous version. Next webhook
        // finds the v1 facet running as before.
        updateSync(sql, sync_id, {
          handler_code: oldSync.handler_code,
          schema_ddl: oldSync.schema_ddl,
          version: oldSync.version,
          code_id: oldSync.code_id
        });
        try {
          attachFacet(agent.env, agent.ctx.facets, oldSync, agent.name);
        } catch {
          // Best-effort re-attach. If this also fails, the next webhook
          // delivery will retry via handleWebhookDelivery -> attachFacet.
          // The DB is already restored to v1, which is what matters.
        }
        return {
          ok: false as const,
          error: "facet_load_failed" as const,
          detail: e instanceof Error ? e.message : String(e)
        };
      }

      return { ok: true as const, new_version: newVersion };
    }
  });
}
```

- [ ] **Step 4: Run the test to verify the not_found case passes**

Run: `npm test -- src/agent/tools/write/update-sync.test.ts`
Expected: PASS — 1 test green.

- [ ] **Step 5: Add the happy-path test (all three fields provided)**

Append to `update-sync.test.ts` (inside the existing `describe` block, after the `not_found` test):

```ts
it("happy path: migration runs, row updated with bumped version, facet aborted + re-attached + pinged", async () => {
  const stub = env.ChatAgent.get(env.ChatAgent.idFromName("u-happy"));
  await runInDurableObject(stub, async (instance) => {
    await (
      instance as never as { setName: (n: string) => Promise<void> }
    ).setName("u-happy");
    const seeded = seedSync(instance);

    const migrationsRun: string[] = [];
    const aborts: string[] = [];
    const pings: number[] = [];
    let pingCount = 0;

    const restoreFacets = installFakeFacets(instance, {
      get(name, cb) {
        // Exercise the Worker Loader callback path — same pattern as
        // create-sync-integration.test.ts. Swallow errors from the cb
        // because the real DO class isn't usable under the workerd
        // test runtime.
        void Promise.resolve(cb()).catch(() => {});
        return {
          fetch: async () => new Response("ok"),
          __sqlExec: async (sql) => {
            migrationsRun.push(sql);
            return { ok: true, rowsWritten: 0, rowsRead: 0 };
          },
          __supervisorPing: async () => {
            pingCount += 1;
            pings.push(pingCount);
          }
        };
      },
      abort: (name) => {
        aborts.push(name);
      },
      delete: () => {}
    });

    try {
      const tool = updateSyncTool(instance as never);
      const res = await tool.execute!(
        {
          sync_id: seeded.id,
          handler_code:
            "export async function handleWebhook(){ return new Response('v2'); }",
          schema_ddl:
            "CREATE TABLE IF NOT EXISTS issues (id TEXT PRIMARY KEY, title TEXT);",
          migration_ddl: "ALTER TABLE issues ADD COLUMN title TEXT;"
        },
        {} as never
      );

      expect(res).toEqual({ ok: true, new_version: 2 });
      expect(migrationsRun).toEqual([
        "ALTER TABLE issues ADD COLUMN title TEXT;"
      ]);
      expect(aborts).toEqual([seeded.name]);
      expect(pings.length).toBeGreaterThanOrEqual(1);

      const sql = (instance as { sql: SqlTag }).sql.bind(instance) as SqlTag;
      const updated = getSyncById(sql, seeded.id);
      expect(updated).not.toBeNull();
      expect(updated!.version).toBe(2);
      expect(updated!.code_id).toBe(`sync:${seeded.id}:v2`);
      expect(updated!.handler_code).toContain("v2");
      expect(updated!.schema_ddl).toContain("title TEXT");
    } finally {
      restoreFacets();
    }
  });
});
```

- [ ] **Step 6: Run to confirm happy passes**

Run: `npm test -- src/agent/tools/write/update-sync.test.ts`
Expected: PASS — 2/2 tests green.

- [ ] **Step 7: Add the handler-only test**

Append:

```ts
it("handler-only: skips migration, preserves old schema, bumps version", async () => {
  const stub = env.ChatAgent.get(env.ChatAgent.idFromName("u-handler"));
  await runInDurableObject(stub, async (instance) => {
    await (
      instance as never as { setName: (n: string) => Promise<void> }
    ).setName("u-handler");
    const seeded = seedSync(instance);

    let migrationCalled = false;
    const restoreFacets = installFakeFacets(instance, {
      get(_name, cb) {
        void Promise.resolve(cb()).catch(() => {});
        return {
          fetch: async () => new Response("ok"),
          __sqlExec: async () => {
            migrationCalled = true;
            return { ok: true, rowsWritten: 0, rowsRead: 0 };
          },
          __supervisorPing: async () => {}
        };
      },
      abort: () => {},
      delete: () => {}
    });

    try {
      const tool = updateSyncTool(instance as never);
      const res = await tool.execute!(
        {
          sync_id: seeded.id,
          handler_code:
            "export async function handleWebhook(){ return new Response('bugfix'); }"
        },
        {} as never
      );

      expect(res).toEqual({ ok: true, new_version: 2 });
      expect(migrationCalled).toBe(false);

      const sql = (instance as { sql: SqlTag }).sql.bind(instance) as SqlTag;
      const updated = getSyncById(sql, seeded.id)!;
      expect(updated.handler_code).toContain("bugfix");
      expect(updated.schema_ddl).toBe(seeded.schema_ddl); // unchanged
      expect(updated.version).toBe(2);
    } finally {
      restoreFacets();
    }
  });
});
```

- [ ] **Step 8: Run to confirm handler-only passes**

Run: `npm test -- src/agent/tools/write/update-sync.test.ts`
Expected: PASS — 3/3 tests green.

- [ ] **Step 9: Add the schema-only test**

Append:

```ts
it("schema-only: no migration fired, new schema_ddl persisted, version bumped", async () => {
  const stub = env.ChatAgent.get(env.ChatAgent.idFromName("u-schema"));
  await runInDurableObject(stub, async (instance) => {
    await (
      instance as never as { setName: (n: string) => Promise<void> }
    ).setName("u-schema");
    const seeded = seedSync(instance);

    let migrationCalled = false;
    const restoreFacets = installFakeFacets(instance, {
      get(_name, cb) {
        void Promise.resolve(cb()).catch(() => {});
        return {
          fetch: async () => new Response("ok"),
          __sqlExec: async () => {
            migrationCalled = true;
            return { ok: true, rowsWritten: 0, rowsRead: 0 };
          },
          __supervisorPing: async () => {}
        };
      },
      abort: () => {},
      delete: () => {}
    });

    try {
      const tool = updateSyncTool(instance as never);
      const res = await tool.execute!(
        {
          sync_id: seeded.id,
          schema_ddl:
            "CREATE TABLE IF NOT EXISTS issues (id TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS comments (id TEXT PRIMARY KEY);"
        },
        {} as never
      );

      expect(res).toEqual({ ok: true, new_version: 2 });
      expect(migrationCalled).toBe(false);

      const sql = (instance as { sql: SqlTag }).sql.bind(instance) as SqlTag;
      const updated = getSyncById(sql, seeded.id)!;
      expect(updated.schema_ddl).toContain("comments");
      expect(updated.handler_code).toBe(seeded.handler_code); // unchanged
    } finally {
      restoreFacets();
    }
  });
});
```

- [ ] **Step 10: Run**

Run: `npm test -- src/agent/tools/write/update-sync.test.ts`
Expected: PASS — 4/4 tests green.

- [ ] **Step 11: Add the migration-only test**

Append:

```ts
it("migration-only: migration fires, handler + schema persisted unchanged, version bumped", async () => {
  const stub = env.ChatAgent.get(env.ChatAgent.idFromName("u-migration"));
  await runInDurableObject(stub, async (instance) => {
    await (
      instance as never as { setName: (n: string) => Promise<void> }
    ).setName("u-migration");
    const seeded = seedSync(instance);

    const migrations: string[] = [];
    const restoreFacets = installFakeFacets(instance, {
      get(_name, cb) {
        void Promise.resolve(cb()).catch(() => {});
        return {
          fetch: async () => new Response("ok"),
          __sqlExec: async (sql) => {
            migrations.push(sql);
            return { ok: true, rowsWritten: 0, rowsRead: 0 };
          },
          __supervisorPing: async () => {}
        };
      },
      abort: () => {},
      delete: () => {}
    });

    try {
      const tool = updateSyncTool(instance as never);
      const res = await tool.execute!(
        {
          sync_id: seeded.id,
          migration_ddl:
            "CREATE INDEX IF NOT EXISTS idx_issues_title ON issues(title);"
        },
        {} as never
      );

      expect(res).toEqual({ ok: true, new_version: 2 });
      expect(migrations).toEqual([
        "CREATE INDEX IF NOT EXISTS idx_issues_title ON issues(title);"
      ]);

      const sql = (instance as { sql: SqlTag }).sql.bind(instance) as SqlTag;
      const updated = getSyncById(sql, seeded.id)!;
      expect(updated.handler_code).toBe(seeded.handler_code);
      expect(updated.schema_ddl).toBe(seeded.schema_ddl);
      expect(updated.version).toBe(2);
    } finally {
      restoreFacets();
    }
  });
});
```

- [ ] **Step 12: Run**

Run: `npm test -- src/agent/tools/write/update-sync.test.ts`
Expected: PASS — 5/5 tests green.

- [ ] **Step 13: Add the no_changes test**

Append:

```ts
it("no_changes: returns the defensive-branch error and leaves the sync untouched", async () => {
  const stub = env.ChatAgent.get(env.ChatAgent.idFromName("u-nochanges"));
  await runInDurableObject(stub, async (instance) => {
    await (
      instance as never as { setName: (n: string) => Promise<void> }
    ).setName("u-nochanges");
    const seeded = seedSync(instance);

    // The zod `.refine()` on inputSchema rejects calls with no update
    // fields during AI-SDK validation in production. Tests call
    // `tool.execute!(...)` directly, bypassing validation, so the
    // DEFENSIVE BRANCH inside execute catches this case and returns
    // a clean `no_changes` error. Install fakes so we can assert the
    // tool didn't touch them before bailing out.
    let touched = false;
    const restoreFacets = installFakeFacets(instance, {
      get() {
        touched = true;
        return {
          fetch: async () => new Response("ok"),
          __sqlExec: async () => {
            touched = true;
            return { ok: true, rowsWritten: 0, rowsRead: 0 };
          },
          __supervisorPing: async () => {
            touched = true;
          }
        };
      },
      abort: () => {
        touched = true;
      },
      delete: () => {}
    });

    try {
      const tool = updateSyncTool(instance as never);
      // Cast through `never` because the inputSchema type is stricter
      // than the defensive-branch runtime behaviour the test exercises.
      const res = await tool.execute!(
        { sync_id: seeded.id } as never,
        {} as never
      );
      expect(res).toEqual({ ok: false, error: "no_changes" });
      expect(touched).toBe(false);

      const sql = (instance as { sql: SqlTag }).sql.bind(instance) as SqlTag;
      const persisted = getSyncById(sql, seeded.id)!;
      expect(persisted.version).toBe(1);
    } finally {
      restoreFacets();
    }
  });
});
```

- [ ] **Step 14: Run**

Run: `npm test -- src/agent/tools/write/update-sync.test.ts`
Expected: PASS — 6/6 tests green.

- [ ] **Step 15: Add the migration_failed test**

Append:

```ts
it("migration_failed: returns migration_failed, DB untouched, facet not aborted", async () => {
  const stub = env.ChatAgent.get(env.ChatAgent.idFromName("u-migfail"));
  await runInDurableObject(stub, async (instance) => {
    await (
      instance as never as { setName: (n: string) => Promise<void> }
    ).setName("u-migfail");
    const seeded = seedSync(instance);

    let aborted = false;
    let pinged = false;
    const restoreFacets = installFakeFacets(instance, {
      get(_name, cb) {
        void Promise.resolve(cb()).catch(() => {});
        return {
          fetch: async () => new Response("ok"),
          __sqlExec: async () => ({
            ok: false,
            error: 'near "BAD": syntax error'
          }),
          __supervisorPing: async () => {
            pinged = true;
          }
        };
      },
      abort: () => {
        aborted = true;
      },
      delete: () => {}
    });

    try {
      const tool = updateSyncTool(instance as never);
      const res = await tool.execute!(
        {
          sync_id: seeded.id,
          migration_ddl: "BAD SQL;"
        },
        {} as never
      );

      expect(res).toMatchObject({
        ok: false,
        error: "migration_failed",
        detail: expect.stringMatching(/syntax error/)
      });
      expect(aborted).toBe(false);
      expect(pinged).toBe(false);

      const sql = (instance as { sql: SqlTag }).sql.bind(instance) as SqlTag;
      const persisted = getSyncById(sql, seeded.id)!;
      expect(persisted.version).toBe(1);
    } finally {
      restoreFacets();
    }
  });
});
```

- [ ] **Step 16: Run**

Run: `npm test -- src/agent/tools/write/update-sync.test.ts`
Expected: PASS — 7/7 tests green.

- [ ] **Step 17: Add the facet_load_failed-with-rollback test**

Append:

```ts
it("facet_load_failed: rollback restores DB to v1 and re-attaches old facet when ping throws", async () => {
  const stub = env.ChatAgent.get(env.ChatAgent.idFromName("u-rollback"));
  await runInDurableObject(stub, async (instance) => {
    await (
      instance as never as { setName: (n: string) => Promise<void> }
    ).setName("u-rollback");
    const seeded = seedSync(instance);

    // The fake returns a stub whose ping fails ONLY on the v2 attach,
    // succeeds on the v1 re-attach during rollback. We distinguish by
    // looking at the most recently persisted code_id at the moment the
    // cb runs — crude but effective in a single-threaded test.
    const attachedCodeIds: string[] = [];
    let callCount = 0;
    const restoreFacets = installFakeFacets(instance, {
      get(_name, cb) {
        callCount += 1;
        // Run the cb so the build path is exercised (same pattern as
        // other tests). Swallow failures because workerd test runtime
        // can't realize the DO class.
        void Promise.resolve(cb()).catch(() => {});
        const sql = (instance as { sql: SqlTag }).sql.bind(instance) as SqlTag;
        const current = getSyncById(sql, seeded.id);
        if (current) attachedCodeIds.push(current.code_id);
        const isV2 = current?.version === 2;
        return {
          fetch: async () => new Response("ok"),
          __sqlExec: async () => ({
            ok: true,
            rowsWritten: 0,
            rowsRead: 0
          }),
          __supervisorPing: async () => {
            if (isV2) {
              throw new Error("compilation error: SyntaxError in handler.js");
            }
            // v1 rollback ping succeeds
          }
        };
      },
      abort: () => {},
      delete: () => {}
    });

    try {
      const tool = updateSyncTool(instance as never);
      const res = await tool.execute!(
        {
          sync_id: seeded.id,
          handler_code: "export async function handleWebhook() { SYNTAX ERROR }"
        },
        {} as never
      );

      expect(res).toMatchObject({
        ok: false,
        error: "facet_load_failed",
        detail: expect.stringMatching(/SyntaxError/)
      });

      // Rollback asserted: DB restored to v1 shape.
      const sql = (instance as { sql: SqlTag }).sql.bind(instance) as SqlTag;
      const persisted = getSyncById(sql, seeded.id)!;
      expect(persisted.version).toBe(1);
      expect(persisted.code_id).toBe(`sync:${seeded.id}:v1`);
      expect(persisted.handler_code).toBe(seeded.handler_code);
      // `get(name, cb)` was called at least twice: v2 attach (failed)
      // + v1 rollback re-attach.
      expect(callCount).toBeGreaterThanOrEqual(2);
    } finally {
      restoreFacets();
    }
  });
});
```

- [ ] **Step 18: Run the full file**

Run: `npm test -- src/agent/tools/write/update-sync.test.ts`
Expected: PASS — 8/8 tests green.

- [ ] **Step 19: Typecheck + full suite + commit**

Run: `npm run check`
Expected: format clean, lint clean, tsc clean, all existing tests still pass (should be 111 total now: 103 before + 8 new).

```bash
git add src/agent/tools/write/update-sync.ts src/agent/tools/write/update-sync.test.ts
git commit -m "$(cat <<'EOF'
phase 12 task 1: add update_sync tool with rollback

Atomic update flow: migration via __sqlExec on the live facet →
persist new row with bumped version + new code_id → abort old
isolate → re-attach with new code_id (Worker Loader cache miss
forces fresh compile) → __supervisorPing probes compile. On
compile failure after the DB bump, rollback restores the old row
and re-attaches the previous bundle so the sync stays live on its
old version.

All inputs optional except sync_id; zod refine enforces at least
one of handler_code / schema_ddl / migration_ddl. Approval-gated.
Reuses __sqlExec (Phase 11) and __supervisorPing (Phase 08) — no
new facet RPCs introduced.

Tests cover 8 cases: not_found, happy (all three), handler-only,
schema-only, migration-only, no_changes (zod rejection),
migration_failed (pre-bump error), facet_load_failed with DB
rollback + re-attach of the old bundle.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Register tool + update system prompt

**Files:**

- Modify: `src/agent/tools/index.ts`
- Modify: `src/agent/system-prompt.ts`

- [ ] **Step 1: Register `update_sync` in `buildTools`**

Replace `src/agent/tools/index.ts` entirely with:

```ts
import { listSyncsTool } from "./read/list-syncs";
import { getSyncTool } from "./read/get-sync";
import { getSyncErrorsTool } from "./read/get-sync-errors";
import { querySyncTool } from "./read/query-sync";
import { webSearchTool } from "./read/web-search";
import { createSyncTool } from "./write/create-sync";
import { deleteSyncTool } from "./write/delete-sync";
import { runInSyncTool } from "./write/run-in-sync";
import { updateSyncTool } from "./write/update-sync";
import type { ChatAgent } from "../../server";

/**
 * Build the tool map passed to streamText. Each tool factory takes
 * the agent instance so tools can read/write the supervisor SQLite
 * and reach the env bindings (ANTHROPIC_API_KEY, PARALLEL_API_KEY).
 *
 * Write tools added progressively from Phase 08 onwards:
 * - create_sync (Phase 08, live)
 * - delete_sync (Phase 10, live)
 * - run_in_sync (Phase 11, live)
 * - update_sync (Phase 12, live)
 */
export function buildTools(agent: ChatAgent) {
  return {
    list_syncs: listSyncsTool(agent),
    get_sync: getSyncTool(agent),
    get_sync_errors: getSyncErrorsTool(agent),
    query_sync: querySyncTool(agent),
    web_search: webSearchTool(agent),
    create_sync: createSyncTool(agent),
    delete_sync: deleteSyncTool(agent),
    run_in_sync: runInSyncTool(agent),
    update_sync: updateSyncTool(agent)
  };
}
```

- [ ] **Step 2: Update the system prompt — add `update_sync` to the "Write tools (available)" block**

In `src/agent/system-prompt.ts`, locate the "Write tools (available):" block. After the `run_in_sync` bullet, add a new bullet for `update_sync`:

```
- \`update_sync(sync_id, handler_code?, schema_ddl?, migration_ddl?)\` — updates an existing sync's handler and/or schema atomically. Everything except \`sync_id\` is optional; at least one of \`handler_code\` / \`schema_ddl\` / \`migration_ddl\` must be provided. \`schema_ddl\` when present MUST be the FULL target schema (all CREATE TABLE / CREATE INDEX statements), not a diff. \`migration_ddl\` is the ALTER TABLE transition from old shape to new. On compile failure of the new handler, the update rolls back — the sync stays on its old version. Approval-gated. Use for bug fixes in handler logic, schema evolution, and filter changes.
```

The "Still-unavailable write tools" line should already show an empty list (all four write tools are now live). Delete the line entirely, since there's nothing to list. Before edit:

```
Still-unavailable write tools (coming in later phases): \`update_sync\`. If asked to update, acknowledge and say that's coming.
```

After edit: the entire line is removed. The write-tools list ends with the `update_sync` bullet.

- [ ] **Step 3: Update the system prompt — add the `### update_sync contract` subsection**

In `src/agent/system-prompt.ts`, find the `### run_in_sync contract` section. Immediately AFTER it (and BEFORE `### schema_ddl contract`), insert a new subsection:

```
### update_sync contract

When the user asks for a handler bug fix, a schema change, or a filter tweak on an existing sync, draft \`update_sync\` with only the fields that are changing.

Key rules:

- **\`schema_ddl\` is the FULL target schema, always.** Even for a one-column addition, send the entire schema as CREATE TABLE / CREATE INDEX statements separated by semicolons. Use CREATE TABLE IF NOT EXISTS so re-applying is safe.
- **Pair schema changes to existing tables with \`migration_ddl\`.** Adding a brand-new table? \`CREATE TABLE IF NOT EXISTS\` in \`schema_ddl\` is enough (no migration needed). Adding a column to an existing table, renaming a column, changing a type? Supply \`migration_ddl\` with the appropriate \`ALTER TABLE\`. Migration runs against the live facet before the swap.
- **Destructive migrations (DROP COLUMN, type change) should pair with a handler update in the same call.** The old handler keeps running briefly with the new schema between migration and swap — if the old handler writes a column that was just dropped, webhook deliveries in that window fail (Linear will retry; still no data loss, but noisy).
- **A webhook arriving in the swap window** (tens of ms between \`abort\` and new facet up) gets a 500, which Linear retries at 1min / 1hr / 6hr — no data loss, ~60s max delay. Mention this to the user if they're asking about timing-sensitive updates.
- **Rollback is automatic on compile failure.** If the new handler_code has a syntax error, \`__supervisorPing\` fails, the DB is restored to the previous version, and the old bundle is re-attached. The tool returns \`{ ok: false, error: "facet_load_failed", detail }\`.
- **For big backfills after a schema change**, follow up with \`run_in_sync\` as a separate tool call. \`update_sync\` handles the shape transition; \`run_in_sync\` handles filling in new data.

Error shapes:
- \`{ error: "not_found", sync_id }\` — unknown sync.
- \`{ ok: false, error: "no_changes" }\` — none of the three optional fields were provided.
- \`{ ok: false, error: "migration_failed", detail }\` — \`migration_ddl\` threw. DB untouched, sync still on old version.
- \`{ ok: false, error: "facet_load_failed", detail }\` — new bundle failed to compile. DB rolled back to old version; sync still live on old handler.
- \`{ ok: true, new_version: N }\` — success.
```

- [ ] **Step 4: Update the system prompt — remove `update_sync` from the "What's out of scope" list**

In `src/agent/system-prompt.ts`, in the `## What's out of scope` section, delete this bullet:

```
- You cannot update syncs yet (coming in a later phase). Deletion works via \`delete_sync\`.
```

Keep the remaining bullets (Linear-only, no-autonomous). After this edit the section should have exactly two bullets.

Verify:

```bash
grep -n "cannot update\|cannot run ad-hoc\|cannot handle any integration\|run autonomously" src/agent/system-prompt.ts
```

Expected: two matches — Linear-only + no-autonomous. No lines containing "cannot update" or "cannot run ad-hoc".

- [ ] **Step 5: Run the full suite to confirm nothing regressed**

Run: `npm run check`
Expected: all tests pass (111 tests), format + lint + tsc clean. No behavioural changes in other code; this step is just registration + prompt.

- [ ] **Step 6: Commit**

```bash
git add src/agent/tools/index.ts src/agent/system-prompt.ts
git commit -m "$(cat <<'EOF'
phase 12 task 2: register update_sync + document the contract in the prompt

Tool is live in buildTools. System prompt documents the
update_sync contract: full schema_ddl always (no diffs), pair
schema changes with migration_ddl, destructive migrations should
include a matching handler update, rollback behaviour on compile
failure. Removed update_sync from the "What's out of scope"
section — all four write tools (create/delete/run_in/update) are
now live.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Manual end-to-end smoke test

**Files:** none (manual test against a live Cloudflare dev runtime)

- [ ] **Step 1: Start the dev server**

```bash
npm run dev
```

Open the local URL in a browser. Ensure you have a live Linear sync registered from Phase 11 smoke (or create one first).

- [ ] **Step 2: Exercise a handler-only update (bug fix case)**

In chat: "update my Linear sync's handler to log every incoming webhook payload before writing it. Everything else stays the same."

The agent should propose `update_sync` with only `handler_code`. Approve.

Verify the response shows `{ ok: true, new_version: 2 }`. Then trigger a Linear event (edit an issue). Verify via `query_sync` that the update flows through the new handler (it should still write the same shape — this is a no-op behavioural change, just ensuring the new bundle loaded).

- [ ] **Step 3: Exercise a schema + migration + handler update (additive case)**

In chat: "add a column called \`updated_at\` to my Linear issues sync, set it from Linear's \`updatedAt\` field. Update the handler to write it."

The agent should propose `update_sync` with `handler_code` (writes `updated_at`), `schema_ddl` (full schema with the new column), and `migration_ddl` (`ALTER TABLE issues ADD COLUMN updated_at INTEGER;` or similar). Approve.

Verify:

- `{ ok: true, new_version: 3 }` returned
- `query_sync` with `PRAGMA table_info(issues)` shows the new column
- A new Linear event populates the column (check via `SELECT id, updated_at FROM issues WHERE updated_at IS NOT NULL LIMIT 5`)

- [ ] **Step 4: Exercise a compile failure to verify rollback**

In chat: "update my Linear sync's handler to this code: export async function handleWebhook() { THIS IS INTENTIONALLY BROKEN }"

The agent may push back on the syntax. Tell it to proceed anyway so we can validate the rollback path. Approve.

Verify:

- Tool returns `{ ok: false, error: "facet_load_failed", detail: "..." }` (the detail mentions SyntaxError or similar)
- `list_syncs` shows the sync is still at `version: 3` (from the previous step), NOT version 4
- A new Linear event still triggers the PREVIOUS handler successfully (webhook delivery works, column is populated)

- [ ] **Step 5: Webhook-during-update smoke (optional but ideal)**

Open two chat sessions for the same user. In one, start a long-running update (e.g., a migration DDL that does many `ALTER TABLE` statements). Concurrently edit an issue in Linear. After both complete, check:

- Webhook delivery recorded (either succeeded normally or surfaced in `sync_errors` with a retry indicator)
- If surfaced in `sync_errors`: Linear's retry should eventually clear it; check after ~1 min

- [ ] **Step 6: Stop the dev server.** Nothing to commit — Task 3 is validation only.

If any step fails, capture the exact output and diagnose before declaring the phase done. Don't mark the task complete on partial success.

---

## V2 upgrade paths

Enumerated here so they can be pulled into the README later and so reviewers can see what was deliberately deferred.

### Drizzle-managed schemas

Replace the "agent writes raw DDL" model with a drizzle-kit workflow: agent-authored drizzle schema definitions get compiled to migrations + a typed query layer. Benefits: schema changes become source-controlled and diffable, types flow into the handler automatically, drizzle-kit's migration generator handles the edge cases SQLite doesn't support natively (e.g., DROP COLUMN on older versions). Tradeoffs: supervisor takes on dependency tracking for drizzle state per sync, and the agent's mental model shifts from "I write DDL" to "I write drizzle TS then run drizzle-kit". Not needed for V1 demo.

### Drain webhooks during destructive migrations

Current design accepts a tens-of-millisecond race window during the swap. Destructive migrations (DROP COLUMN, type change) with paired handler updates are safe-ish, but not bulletproof: a webhook landing between "migration applied" and "new bundle live" will run against a dropped column. V2 could add a supervisor flag (`syncs.is_updating`) checked in `handleWebhookDelivery` — if set, return 503 with `Retry-After: 2`, Linear retries almost immediately. Costs: one SQL write per update to set/clear the flag, one read per webhook delivery. Skip for V1 (Linear retries at 1min anyway).

### Tail-Worker observability for swap failures

Phase 11 already flagged Tail Workers as the V2 observability path. For `update_sync` specifically: crash-time logs from failed compiles (rare but hard to debug) would be invaluable. Same pattern as Phase 11 §12.1 — attach `tails: [ctx.exports.ExecTail({...})]` on the Worker Loader call site, relay through a LogSession DO. Applies to any `attachFacet`-triggered load, not just exec isolates.

### Versioned rollback UI

When `facet_load_failed` fires, the tool rolls back silently. V2 UX: surface a "sync was automatically rolled back from v4 to v3" banner in the chat context so the user sees the rollback rather than just a tool error. Useful if the compile error was subtle (e.g., a missing await that only surfaces under load).

---

## Spec coverage / self-review checklist

| Brainstorming decision                                    | Covered by                                                                                                       |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Scope = bundle swap + migration, not backfill             | Task 1 Step 3 (no exec-isolate plumbing in the tool)                                                             |
| All inputs optional except `sync_id`                      | Task 1 Step 3 (zod optional + refine) + Step 13 no_changes test                                                  |
| `schema_ddl` is full target state                         | Task 1 Step 3 (tool description + input schema description) + Task 2 Step 3 (prompt contract)                    |
| Migration runs BEFORE swap                                | Task 1 Step 3 (step 1 of execute) + Task 2 Step 3 (documented in contract)                                       |
| Webhook race bounded by Linear retries                    | Task 2 Step 3 (prompt contract paragraph) + no code change needed (existing `handleWebhookDelivery` catches 5xx) |
| Rollback on compile failure                               | Task 1 Step 3 (outer catch in execute) + Step 17 rollback test                                                   |
| Reuses Phase 11 `__sqlExec` + Phase 08 `__supervisorPing` | Task 1 Step 3 (FacetRpcSurface interface)                                                                        |
| Reuses existing `updateSync` helper + `attachFacet`       | Task 1 Step 3 (imports)                                                                                          |
| V2: Drizzle / draining / Tail Workers / rollback UI       | "V2 upgrade paths" section                                                                                       |

All decisions from the brainstorming conversation land in at least one task or are documented under V2 paths. No placeholders, no "TBD", no "similar to Task N" references. Types and method signatures are consistent across the tool file and test file (`FacetRpcSurface.__sqlExec` return shape matches `SqlExecResult` in tests; `UpdateSyncResult` union matches tool return branches).
