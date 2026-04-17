# Phase 02 — Supervisor Data Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the per-user `ChatAgent` DO the two supervisor tables it needs (`syncs` and `sync_errors`), a typed repo layer with CRUD helpers, and an integration test proving the tables are per-DO-isolated — all without yet exposing any of this to the LLM (tools come in Phase 04).

**Architecture:** Supervisor state lives in the user DO's built-in SQLite. Tables are created idempotently in `onStart()` using `CREATE TABLE IF NOT EXISTS` (the Agents SDK pattern). Repo is a module of pure functions that take a typed `sql` template callable and return plain row objects. This keeps the DO class thin and the repo easy to test without extensive DO mocking. Integration tests use `runInDurableObject` from `cloudflare:test` to exercise the repo inside a real DO instance.

**Tech Stack:** Cloudflare Agents SDK (`this.sql\`...\``), TypeScript strict mode, Vitest + `@cloudflare/vitest-pool-workers`.

**Reference:** [`docs/superpowers/specs/2026-04-17-self-syncing-agent-architecture-design.md`](../specs/2026-04-17-self-syncing-agent-architecture-design.md) §5.1 Supervisor SQLite.

---

## File Structure

**Created:**
- `src/db/types.ts` — row types and input types for `Sync` + `SyncError`
- `src/db/syncs.ts` — `createSync`, `getSyncById`, `getSyncByName`, `listSyncs`, `updateSync`, `deleteSync` — pure functions over `this.sql`
- `src/db/sync-errors.ts` — `logSyncError`, `listSyncErrors`, `getSyncErrorStats` — same style
- `src/db/schema.ts` — single exported `applySchemaMigrations(sql)` function that runs the DDL
- `tests/supervisor-data-model.test.ts` — integration tests using `runInDurableObject`

**Modified:**
- `src/server.ts` — `ChatAgent.onStart()` calls `applySchemaMigrations(this.sql)`; add thin public methods on `ChatAgent` that wrap the repo (used by tests now, by tools in Phase 04)

No changes to `wrangler.jsonc`, `package.json`, or client code in this phase.

---

## Pre-flight context (critical to know before starting)

**`this.sql` semantics** (from `/cloudflare/agents` docs):
- `this.sql\`CREATE TABLE IF NOT EXISTS ...\`` — DDL, executes synchronously, returns empty array
- `this.sql\`INSERT INTO ... VALUES (${x})\`` — same; parameter binding is automatic via `${}`
- `this.sql<RowType>\`SELECT * FROM ...\`` — returns `RowType[]`; empty array if no rows
- It's a property of the `Agent` base class — we inherit it automatically by extending `AIChatAgent`

**`runInDurableObject` for tests** — imported from `cloudflare:test`:
```ts
await runInDurableObject(stub, async (instance, ctx) => {
  // instance is the actual ChatAgent; we can call any method on it
  // ctx is the DurableObjectState
});
```

---

## Task 1: Types module

**Files:**
- Create: `src/db/types.ts`

- [ ] **Step 1: Create `src/db/types.ts` with exactly this content:**

```ts
/**
 * Row shapes for the supervisor SQLite (per-user ChatAgent DO).
 *
 * `syncs` registers every agent-created sync and carries everything the
 * supervisor needs to route webhooks (webhook_secret, upstream_webhook_id)
 * and reload facet code on restart (code_id, handler_code).
 *
 * `sync_errors` captures handler runtime failures so the next chat turn's
 * ambient context can surface them to the agent for recovery.
 */

export type Integration = "linear" | "github";

export interface Sync {
  id: string;
  name: string;
  integration: Integration;
  handler_code: string;
  schema_ddl: string;
  filter_description: string | null;
  webhook_secret: string;
  upstream_webhook_id: string | null;
  code_id: string;
  version: number;
  created_at: number;
  updated_at: number;
}

export interface NewSync {
  id: string;
  name: string;
  integration: Integration;
  handler_code: string;
  schema_ddl: string;
  filter_description?: string | null;
  webhook_secret: string;
  upstream_webhook_id?: string | null;
  code_id: string;
}

export interface SyncPatch {
  handler_code?: string;
  schema_ddl?: string;
  filter_description?: string | null;
  upstream_webhook_id?: string | null;
  code_id?: string;
  version?: number;
}

export interface SyncError {
  id: number;
  sync_id: string;
  occurred_at: number;
  payload_preview: string | null;
  error_message: string;
  stack_trace: string | null;
  handler_version: number;
}

export interface NewSyncError {
  sync_id: string;
  payload_preview?: string | null;
  error_message: string;
  stack_trace?: string | null;
  handler_version: number;
}

export interface SyncErrorStat {
  sync_id: string;
  error_count: number;
  last_error_message: string;
  last_occurred_at: number;
}
```

---

## Task 2: Schema migration module

**Files:**
- Create: `src/db/schema.ts`

- [ ] **Step 1: Create `src/db/schema.ts` with exactly this content:**

```ts
/**
 * Supervisor SQLite schema. Called by ChatAgent.onStart() — runs on every
 * DO wake-up. Idempotent via CREATE TABLE IF NOT EXISTS; safe to call any
 * number of times.
 *
 * When adding columns later (e.g., a V2 `connections` table or an extra
 * column on `syncs`), follow the Agents SDK convention of ALTER TABLE
 * with an `addColumnIfNotExists` guard rather than editing these CREATE
 * statements — existing DOs already have the old tables.
 */

type SqlTag = <T = unknown>(strings: TemplateStringsArray, ...values: unknown[]) => T[];

export function applySchemaMigrations(sql: SqlTag): void {
  sql`
    CREATE TABLE IF NOT EXISTS syncs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      integration TEXT NOT NULL,
      handler_code TEXT NOT NULL,
      schema_ddl TEXT NOT NULL,
      filter_description TEXT,
      webhook_secret TEXT NOT NULL,
      upstream_webhook_id TEXT,
      code_id TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `;

  sql`
    CREATE TABLE IF NOT EXISTS sync_errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sync_id TEXT NOT NULL,
      occurred_at INTEGER NOT NULL,
      payload_preview TEXT,
      error_message TEXT NOT NULL,
      stack_trace TEXT,
      handler_version INTEGER NOT NULL,
      FOREIGN KEY (sync_id) REFERENCES syncs(id) ON DELETE CASCADE
    )
  `;

  sql`
    CREATE INDEX IF NOT EXISTS idx_sync_errors_sync_id_occurred_at
      ON sync_errors(sync_id, occurred_at DESC)
  `;
}
```

Why the specific structure:
- `ON DELETE CASCADE` on `sync_errors.sync_id` — when a sync is deleted, its error log is cleaned up automatically. Simpler than two-step delete logic.
- The index on `(sync_id, occurred_at DESC)` supports the common "give me the most recent N errors for this sync" query that Phase 04+ will use.
- `SqlTag` type is the local name for the template-literal callable shape; we define it once here to avoid importing SDK internals.

---

## Task 3: Syncs repo (TDD — tests first via `runInDurableObject`)

**Files:**
- Create: `src/db/syncs.ts`
- Modify: `tests/supervisor-data-model.test.ts` (next task creates this file)

The repo functions take the `sql` tag as a parameter so they're easy to test and reuse. Tests will be written in Task 5 alongside the sync_errors tests.

- [ ] **Step 1: Create `src/db/syncs.ts` with exactly this content:**

```ts
import type {
  Sync,
  NewSync,
  SyncPatch,
} from "./types";

type SqlTag = <T = unknown>(strings: TemplateStringsArray, ...values: unknown[]) => T[];

export function createSync(sql: SqlTag, input: NewSync): Sync {
  const now = Date.now();
  sql`
    INSERT INTO syncs (
      id, name, integration, handler_code, schema_ddl,
      filter_description, webhook_secret, upstream_webhook_id,
      code_id, version, created_at, updated_at
    ) VALUES (
      ${input.id}, ${input.name}, ${input.integration},
      ${input.handler_code}, ${input.schema_ddl},
      ${input.filter_description ?? null},
      ${input.webhook_secret},
      ${input.upstream_webhook_id ?? null},
      ${input.code_id}, 1, ${now}, ${now}
    )
  `;
  const row = getSyncById(sql, input.id);
  if (!row) throw new Error(`createSync: insert did not persist row for id=${input.id}`);
  return row;
}

export function getSyncById(sql: SqlTag, id: string): Sync | null {
  const rows = sql<Sync>`SELECT * FROM syncs WHERE id = ${id}`;
  return rows[0] ?? null;
}

export function getSyncByName(sql: SqlTag, name: string): Sync | null {
  const rows = sql<Sync>`SELECT * FROM syncs WHERE name = ${name}`;
  return rows[0] ?? null;
}

export function listSyncs(sql: SqlTag): Sync[] {
  return sql<Sync>`SELECT * FROM syncs ORDER BY created_at ASC`;
}

export function updateSync(sql: SqlTag, id: string, patch: SyncPatch): Sync {
  const existing = getSyncById(sql, id);
  if (!existing) throw new Error(`updateSync: no sync with id=${id}`);

  // Merge the patch over the existing row. Fields not in patch keep their
  // current values. We re-write the whole row because SQLite cannot
  // dynamically compose SET clauses from our tag without fighting the
  // parameter-binding API.
  const next: Sync = {
    ...existing,
    handler_code: patch.handler_code ?? existing.handler_code,
    schema_ddl: patch.schema_ddl ?? existing.schema_ddl,
    filter_description:
      patch.filter_description === undefined
        ? existing.filter_description
        : patch.filter_description,
    upstream_webhook_id:
      patch.upstream_webhook_id === undefined
        ? existing.upstream_webhook_id
        : patch.upstream_webhook_id,
    code_id: patch.code_id ?? existing.code_id,
    version: patch.version ?? existing.version,
    updated_at: Date.now(),
  };

  sql`
    UPDATE syncs SET
      handler_code = ${next.handler_code},
      schema_ddl = ${next.schema_ddl},
      filter_description = ${next.filter_description},
      upstream_webhook_id = ${next.upstream_webhook_id},
      code_id = ${next.code_id},
      version = ${next.version},
      updated_at = ${next.updated_at}
    WHERE id = ${id}
  `;

  const row = getSyncById(sql, id);
  if (!row) throw new Error(`updateSync: row vanished after update id=${id}`);
  return row;
}

export function deleteSync(sql: SqlTag, id: string): void {
  sql`DELETE FROM syncs WHERE id = ${id}`;
  // sync_errors rows are cleaned up automatically via ON DELETE CASCADE.
}
```

---

## Task 4: Sync-errors repo

**Files:**
- Create: `src/db/sync-errors.ts`

- [ ] **Step 1: Create `src/db/sync-errors.ts` with exactly this content:**

```ts
import type { SyncError, NewSyncError, SyncErrorStat } from "./types";

type SqlTag = <T = unknown>(strings: TemplateStringsArray, ...values: unknown[]) => T[];

export function logSyncError(sql: SqlTag, input: NewSyncError): void {
  sql`
    INSERT INTO sync_errors (
      sync_id, occurred_at, payload_preview, error_message,
      stack_trace, handler_version
    ) VALUES (
      ${input.sync_id}, ${Date.now()},
      ${input.payload_preview ?? null},
      ${input.error_message},
      ${input.stack_trace ?? null},
      ${input.handler_version}
    )
  `;
}

export function listSyncErrors(
  sql: SqlTag,
  syncId: string,
  limit: number = 20,
): SyncError[] {
  return sql<SyncError>`
    SELECT * FROM sync_errors
    WHERE sync_id = ${syncId}
    ORDER BY occurred_at DESC
    LIMIT ${limit}
  `;
}

/**
 * Aggregate recent errors per sync, for building the <sync_errors> ambient
 * context block injected into LLM turns. Accepts a unix-ms threshold;
 * callers typically pass `Date.now() - 3_600_000` for the last hour.
 */
export function getSyncErrorStats(
  sql: SqlTag,
  sinceMs: number,
): SyncErrorStat[] {
  return sql<SyncErrorStat>`
    SELECT
      sync_id,
      COUNT(*) as error_count,
      MAX(occurred_at) as last_occurred_at,
      (
        SELECT error_message FROM sync_errors s2
        WHERE s2.sync_id = s1.sync_id AND s2.occurred_at >= ${sinceMs}
        ORDER BY occurred_at DESC LIMIT 1
      ) as last_error_message
    FROM sync_errors s1
    WHERE occurred_at >= ${sinceMs}
    GROUP BY sync_id
    ORDER BY last_occurred_at DESC
  `;
}
```

---

## Task 5: Wire schema migration into `ChatAgent.onStart`

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1: Import the migration function at the top of `src/server.ts`**

Find the import block at the top of `src/server.ts`. After the existing imports (around line 13, after `import { z } from "zod"`), add:

```ts
import { applySchemaMigrations } from "./db/schema";
```

- [ ] **Step 2: Call the migration in `onStart`**

`ChatAgent` already has an `onStart()` method (it configures MCP OAuth callback). Add the migration call at the top of that method. Find the current `onStart` (around line 40):

```ts
onStart() {
  // Configure OAuth popup behavior for MCP servers that require authentication
  this.mcp.configureOAuthCallback({
    ...
  });
}
```

Change it to:

```ts
onStart() {
  applySchemaMigrations(this.sql);

  // Configure OAuth popup behavior for MCP servers that require authentication
  this.mcp.configureOAuthCallback({
    ...
  });
}
```

That's the entire server.ts change. Tables are created lazily on first DO wake-up and cached afterwards via `IF NOT EXISTS`.

- [ ] **Step 3: Run type check**

```bash
pnpm exec tsc --noEmit
```

Expected: zero errors. If `this.sql` is typed differently than our `SqlTag` shape, we'll see a type error here and need to adjust — report and ask before guessing.

---

## Task 6: Integration tests — schema, repo, and per-user isolation

**Files:**
- Create: `tests/supervisor-data-model.test.ts`

This is the meat of Phase 02's verification. We use `runInDurableObject` to run code inside a real `ChatAgent` instance and exercise the repo against its actual SQLite.

- [ ] **Step 1: Create `tests/supervisor-data-model.test.ts` with exactly this content:**

```ts
import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import {
  createSync,
  getSyncById,
  getSyncByName,
  listSyncs,
  updateSync,
  deleteSync,
} from "../src/db/syncs";
import {
  logSyncError,
  listSyncErrors,
  getSyncErrorStats,
} from "../src/db/sync-errors";
import type { NewSync } from "../src/db/types";

// Make env.ChatAgent type-visible (same pattern as tests/per-user-do.test.ts).
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

function sampleSync(overrides: Partial<NewSync> = {}): NewSync {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    name: overrides.name ?? `test-sync-${crypto.randomUUID().slice(0, 8)}`,
    integration: overrides.integration ?? "linear",
    handler_code: overrides.handler_code ?? "export default { async fetch() {} }",
    schema_ddl: overrides.schema_ddl ?? "CREATE TABLE issues (id TEXT PRIMARY KEY)",
    filter_description: overrides.filter_description,
    webhook_secret: overrides.webhook_secret ?? "secret-32-bytes-here",
    upstream_webhook_id: overrides.upstream_webhook_id,
    code_id: overrides.code_id ?? `code-${crypto.randomUUID().slice(0, 8)}`,
  };
}

function getStub(userName: string) {
  return env.ChatAgent.get(env.ChatAgent.idFromName(userName));
}

describe("supervisor data model", () => {
  describe("schema", () => {
    it("creates syncs and sync_errors tables on DO start", async () => {
      const stub = getStub("schema-test-user");
      await runInDurableObject(stub, async (instance) => {
        // onStart runs automatically; tables should exist.
        // Query sqlite_master to verify.
        const tables = instance.sql<{ name: string }>`
          SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('syncs', 'sync_errors')
        `;
        const names = tables.map((t) => t.name).sort();
        expect(names).toEqual(["sync_errors", "syncs"]);
      });
    });
  });

  describe("syncs repo", () => {
    it("creates and reads back a sync", async () => {
      const stub = getStub("crud-user");
      const input = sampleSync({ name: "linear-bugs" });

      await runInDurableObject(stub, async (instance) => {
        const created = createSync(instance.sql, input);
        expect(created.id).toBe(input.id);
        expect(created.name).toBe("linear-bugs");
        expect(created.version).toBe(1);
        expect(created.created_at).toBeGreaterThan(0);
        expect(created.updated_at).toBe(created.created_at);

        const fetched = getSyncById(instance.sql, input.id);
        expect(fetched).toEqual(created);
      });
    });

    it("returns null for unknown ids", async () => {
      const stub = getStub("unknown-id-user");
      await runInDurableObject(stub, async (instance) => {
        expect(getSyncById(instance.sql, "no-such-id")).toBeNull();
      });
    });

    it("enforces UNIQUE name constraint", async () => {
      const stub = getStub("unique-name-user");
      const first = sampleSync({ name: "dup-name" });
      const second = sampleSync({ name: "dup-name" });

      await runInDurableObject(stub, async (instance) => {
        createSync(instance.sql, first);
        expect(() => createSync(instance.sql, second)).toThrow(/UNIQUE/i);
      });
    });

    it("lists syncs in created_at order", async () => {
      const stub = getStub("list-order-user");
      const a = sampleSync({ name: "sync-a" });
      const b = sampleSync({ name: "sync-b" });

      await runInDurableObject(stub, async (instance) => {
        createSync(instance.sql, a);
        // Tiny sleep to guarantee different created_at.
        await new Promise((r) => setTimeout(r, 2));
        createSync(instance.sql, b);

        const all = listSyncs(instance.sql);
        expect(all.map((s) => s.name)).toEqual(["sync-a", "sync-b"]);
      });
    });

    it("updates partial fields without losing others", async () => {
      const stub = getStub("update-user");
      const input = sampleSync({
        name: "patch-target",
        handler_code: "v1-code",
        code_id: "code-v1",
      });

      await runInDurableObject(stub, async (instance) => {
        createSync(instance.sql, input);
        // Tiny sleep so updated_at differs from created_at
        await new Promise((r) => setTimeout(r, 2));

        const patched = updateSync(instance.sql, input.id, {
          handler_code: "v2-code",
          code_id: "code-v2",
          version: 2,
        });

        expect(patched.handler_code).toBe("v2-code");
        expect(patched.code_id).toBe("code-v2");
        expect(patched.version).toBe(2);
        // Untouched fields preserved
        expect(patched.name).toBe("patch-target");
        expect(patched.schema_ddl).toBe(input.schema_ddl);
        expect(patched.webhook_secret).toBe(input.webhook_secret);
        expect(patched.updated_at).toBeGreaterThan(patched.created_at);
      });
    });

    it("deletes a sync and cascades its errors", async () => {
      const stub = getStub("cascade-user");
      const input = sampleSync({ name: "cascade-sync" });

      await runInDurableObject(stub, async (instance) => {
        createSync(instance.sql, input);
        logSyncError(instance.sql, {
          sync_id: input.id,
          error_message: "test error",
          handler_version: 1,
        });

        expect(listSyncErrors(instance.sql, input.id)).toHaveLength(1);

        deleteSync(instance.sql, input.id);

        expect(getSyncById(instance.sql, input.id)).toBeNull();
        expect(listSyncErrors(instance.sql, input.id)).toHaveLength(0);
      });
    });
  });

  describe("sync_errors repo", () => {
    it("logs and lists errors newest first", async () => {
      const stub = getStub("errors-list-user");
      const sync = sampleSync({ name: "error-target" });

      await runInDurableObject(stub, async (instance) => {
        createSync(instance.sql, sync);
        logSyncError(instance.sql, {
          sync_id: sync.id,
          error_message: "first",
          handler_version: 1,
        });
        await new Promise((r) => setTimeout(r, 2));
        logSyncError(instance.sql, {
          sync_id: sync.id,
          error_message: "second",
          handler_version: 1,
        });

        const errors = listSyncErrors(instance.sql, sync.id);
        expect(errors).toHaveLength(2);
        expect(errors[0].error_message).toBe("second");
        expect(errors[1].error_message).toBe("first");
      });
    });

    it("aggregates error stats within a time window", async () => {
      const stub = getStub("stats-user");
      const sync = sampleSync({ name: "stats-target" });

      await runInDurableObject(stub, async (instance) => {
        createSync(instance.sql, sync);
        logSyncError(instance.sql, {
          sync_id: sync.id,
          error_message: "old boom",
          handler_version: 1,
        });
        logSyncError(instance.sql, {
          sync_id: sync.id,
          error_message: "new boom",
          handler_version: 1,
        });

        // Include everything created in this test.
        const stats = getSyncErrorStats(instance.sql, 0);
        expect(stats).toHaveLength(1);
        expect(stats[0].sync_id).toBe(sync.id);
        expect(stats[0].error_count).toBe(2);
        expect(stats[0].last_error_message).toBe("new boom");
      });
    });
  });

  describe("per-user isolation (richer than Phase 01)", () => {
    it("lets two different users have syncs with the same name", async () => {
      const userA = getStub("iso-user-a");
      const userB = getStub("iso-user-b");

      // Both users create a sync named "linear-bugs" — same name, different DOs.
      await runInDurableObject(userA, async (instance) => {
        createSync(instance.sql, sampleSync({ name: "linear-bugs" }));
      });
      await runInDurableObject(userB, async (instance) => {
        createSync(instance.sql, sampleSync({ name: "linear-bugs" }));
      });

      // Each user sees exactly one sync in their own registry.
      await runInDurableObject(userA, async (instance) => {
        const list = listSyncs(instance.sql);
        expect(list).toHaveLength(1);
        expect(list[0].name).toBe("linear-bugs");
      });
      await runInDurableObject(userB, async (instance) => {
        const list = listSyncs(instance.sql);
        expect(list).toHaveLength(1);
        expect(list[0].name).toBe("linear-bugs");
      });
    });

    it("user A cannot see user B's syncs via getSyncByName", async () => {
      const userA = getStub("leak-user-a");
      const userB = getStub("leak-user-b");
      const uniqueName = `user-b-only-${crypto.randomUUID().slice(0, 6)}`;

      await runInDurableObject(userB, async (instance) => {
        createSync(instance.sql, sampleSync({ name: uniqueName }));
      });

      await runInDurableObject(userA, async (instance) => {
        expect(getSyncByName(instance.sql, uniqueName)).toBeNull();
      });
    });
  });
});
```

- [ ] **Step 2: Run tests**

```bash
pnpm test
```

Expected final count: **22 passing** across 4 test files (1 smoke + 8 identity + 2 per-user-do + 11 supervisor-data-model).

Breakdown of the new 11:
- schema (1): tables exist after onStart
- syncs repo (6): create+read, null for unknown, UNIQUE name, list order, partial update, delete cascade
- sync_errors repo (2): log+list newest-first, stats aggregation
- per-user isolation (2): same-name syncs live independently, no leakage via name lookup

If any test fails, read the output carefully before making changes — the pattern is either a schema mismatch (wrong column name, type) or a `this.sql` typing mismatch (our `SqlTag` shape doesn't line up with the SDK's). Fix the specific issue; don't rewrite broadly.

---

## Task 7: Run full check

- [ ] **Step 1: Full check pipeline**

```bash
pnpm run check
```

Expected: all four commands (oxfmt, oxlint, tsc, vitest) green. If oxfmt reformats our new files, that's fine — the committed versions will reflect project style.

---

## Task 8: Commit and push

**Files:**
- All Phase 02 changes: `src/db/types.ts`, `src/db/schema.ts`, `src/db/syncs.ts`, `src/db/sync-errors.ts`, `tests/supervisor-data-model.test.ts`, `src/server.ts`.

- [ ] **Step 1: Stage and verify**

```bash
git add -A
git status --short
git diff --cached --stat
```

Expected files staged: the six above. Cosmetic oxfmt reformat on unrelated files is fine.

- [ ] **Step 2: Commit**

```bash
git commit -m "$(cat <<'EOF'
Phase 02: supervisor data model — syncs + sync_errors tables, repo, tests

Adds the supervisor-side SQLite schema that Phase 04+ tools will read
and write. Nothing is exposed to the LLM yet — just the substrate.

- src/db/types.ts — row types and input types (Sync, NewSync, SyncPatch,
  SyncError, NewSyncError, SyncErrorStat, Integration)
- src/db/schema.ts — applySchemaMigrations(sql) with CREATE TABLE IF NOT
  EXISTS for syncs + sync_errors, plus an index on (sync_id, occurred_at)
  for the common "most-recent N errors" query. ON DELETE CASCADE so
  deleting a sync cleans up its errors.
- src/db/syncs.ts — createSync, getSyncById, getSyncByName, listSyncs,
  updateSync (partial patch semantics, preserves untouched fields),
  deleteSync
- src/db/sync-errors.ts — logSyncError, listSyncErrors (newest first,
  limited), getSyncErrorStats (windowed aggregation for ambient context
  injection in later phases)
- src/server.ts — ChatAgent.onStart() calls applySchemaMigrations;
  tables come up idempotently on every DO wake
- tests/supervisor-data-model.test.ts — 11 integration tests via
  runInDurableObject covering schema creation, CRUD, UNIQUE name,
  CASCADE delete, stats aggregation, and per-user isolation (same-name
  syncs in different DOs don't collide or leak)

Test count: 11 → 22 across 4 files.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 3: Push**

```bash
git push
```

---

## Phase 02 done when…

- [ ] `pnpm test` shows 22 passing across 4 test files (1 smoke + 8 identity + 2 per-user-do + 11 supervisor-data-model)
- [ ] `pnpm run check` passes end-to-end (oxfmt + oxlint + tsc + vitest)
- [ ] Commit pushed to origin/main
- [ ] `src/db/*` files hold all supervisor storage logic; `src/server.ts` changed by only two lines (import + migration call)

Next phase: **Phase 03 — Integration docs bundle** (small JSON files for Linear + GitHub with webhook event schemas, sample payloads, auth patterns). Tiny phase before Phase 04 assembles the agent tool surface.
