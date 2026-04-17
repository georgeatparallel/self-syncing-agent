import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import {
  createSync,
  getSyncById,
  getSyncByName,
  listSyncs,
  updateSync,
  deleteSync
} from "../src/db/syncs";
import {
  logSyncError,
  listSyncErrors,
  getSyncErrorStats
} from "../src/db/sync-errors";
import type { NewSync } from "../src/db/types";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

function sampleSync(overrides: Partial<NewSync> = {}): NewSync {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    name: overrides.name ?? `test-sync-${crypto.randomUUID().slice(0, 8)}`,
    integration: overrides.integration ?? "linear",
    handler_code:
      overrides.handler_code ?? "export default { async fetch() {} }",
    schema_ddl:
      overrides.schema_ddl ?? "CREATE TABLE issues (id TEXT PRIMARY KEY)",
    filter_description: overrides.filter_description,
    webhook_secret: overrides.webhook_secret ?? "secret-32-bytes-here",
    upstream_webhook_id: overrides.upstream_webhook_id,
    code_id: overrides.code_id ?? `code-${crypto.randomUUID().slice(0, 8)}`
  };
}

function getStub(userName: string) {
  const stub = env.ChatAgent.get(env.ChatAgent.idFromName(userName));
  return { stub, userName };
}

/**
 * The Agents SDK's `sql` method reads `this.ctx` internally, so passing
 * `instance.sql` bare into repo functions loses the `this` binding and
 * blows up with "Cannot read properties of undefined (reading 'ctx')".
 * Bind at the boundary so repo code stays a plain function over a
 * tagged-template callable.
 */
function bindSql<T extends { sql: (...args: never[]) => unknown }>(
  instance: T
): T["sql"] {
  return instance.sql.bind(instance) as T["sql"];
}

/**
 * `runInDurableObject` constructs the instance but does NOT fire the
 * Agents SDK lifecycle. In normal operation PartyServer hydrates its
 * internal name from an incoming request header (`x-partykit-room`),
 * which in turn calls `#ensureInitialized` → `onStart` →
 * `applySchemaMigrations`. In the test harness no such request exists,
 * so we call `setName()` explicitly — it sets the name (idempotent across
 * reentry) and runs the initialization chain, leaving the DO in the same
 * state it'd be in after a real fetch.
 */
async function ensureReady(instance: unknown, userName: string): Promise<void> {
  await (instance as { setName: (name: string) => Promise<void> }).setName(
    userName
  );
}

describe("supervisor data model", () => {
  describe("schema", () => {
    it("creates syncs and sync_errors tables on DO start", async () => {
      const { stub, userName } = getStub("schema-test-user");
      await runInDurableObject(stub, async (instance) => {
        await ensureReady(instance, userName);
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
      const { stub, userName } = getStub("crud-user");
      const input = sampleSync({ name: "linear-bugs" });

      await runInDurableObject(stub, async (instance) => {
        await ensureReady(instance, userName);
        const sql = bindSql(instance);
        const created = createSync(sql, input);
        expect(created.id).toBe(input.id);
        expect(created.name).toBe("linear-bugs");
        expect(created.version).toBe(1);
        expect(created.created_at).toBeGreaterThan(0);
        expect(created.updated_at).toBe(created.created_at);

        const fetched = getSyncById(sql, input.id);
        expect(fetched).toEqual(created);
      });
    });

    it("returns null for unknown ids", async () => {
      const { stub, userName } = getStub("unknown-id-user");
      await runInDurableObject(stub, async (instance) => {
        await ensureReady(instance, userName);
        const sql = bindSql(instance);
        expect(getSyncById(sql, "no-such-id")).toBeNull();
      });
    });

    it("enforces UNIQUE name constraint", async () => {
      const { stub, userName } = getStub("unique-name-user");
      const first = sampleSync({ name: "dup-name" });
      const second = sampleSync({ name: "dup-name" });

      await runInDurableObject(stub, async (instance) => {
        await ensureReady(instance, userName);
        const sql = bindSql(instance);
        createSync(sql, first);
        expect(() => createSync(sql, second)).toThrow(/UNIQUE/i);
      });
    });

    it("lists syncs in created_at order", async () => {
      const { stub, userName } = getStub("list-order-user");
      const a = sampleSync({ name: "sync-a" });
      const b = sampleSync({ name: "sync-b" });

      await runInDurableObject(stub, async (instance) => {
        await ensureReady(instance, userName);
        const sql = bindSql(instance);
        createSync(sql, a);
        await new Promise((r) => setTimeout(r, 2));
        createSync(sql, b);

        const all = listSyncs(sql);
        expect(all.map((s) => s.name)).toEqual(["sync-a", "sync-b"]);
      });
    });

    it("updates partial fields without losing others", async () => {
      const { stub, userName } = getStub("update-user");
      const input = sampleSync({
        name: "patch-target",
        handler_code: "v1-code",
        code_id: "code-v1"
      });

      await runInDurableObject(stub, async (instance) => {
        await ensureReady(instance, userName);
        const sql = bindSql(instance);
        createSync(sql, input);
        await new Promise((r) => setTimeout(r, 2));

        const patched = updateSync(sql, input.id, {
          handler_code: "v2-code",
          code_id: "code-v2",
          version: 2
        });

        expect(patched.handler_code).toBe("v2-code");
        expect(patched.code_id).toBe("code-v2");
        expect(patched.version).toBe(2);
        expect(patched.name).toBe("patch-target");
        expect(patched.schema_ddl).toBe(input.schema_ddl);
        expect(patched.webhook_secret).toBe(input.webhook_secret);
        expect(patched.updated_at).toBeGreaterThan(patched.created_at);
      });
    });

    it("deletes a sync and cascades its errors", async () => {
      const { stub, userName } = getStub("cascade-user");
      const input = sampleSync({ name: "cascade-sync" });

      await runInDurableObject(stub, async (instance) => {
        await ensureReady(instance, userName);
        const sql = bindSql(instance);
        createSync(sql, input);
        logSyncError(sql, {
          sync_id: input.id,
          error_message: "test error",
          handler_version: 1
        });

        expect(listSyncErrors(sql, input.id)).toHaveLength(1);

        deleteSync(sql, input.id);

        expect(getSyncById(sql, input.id)).toBeNull();
        expect(listSyncErrors(sql, input.id)).toHaveLength(0);
      });
    });
  });

  describe("sync_errors repo", () => {
    it("logs and lists errors newest first", async () => {
      const { stub, userName } = getStub("errors-list-user");
      const sync = sampleSync({ name: "error-target" });

      await runInDurableObject(stub, async (instance) => {
        await ensureReady(instance, userName);
        const sql = bindSql(instance);
        createSync(sql, sync);
        logSyncError(sql, {
          sync_id: sync.id,
          error_message: "first",
          handler_version: 1
        });
        await new Promise((r) => setTimeout(r, 2));
        logSyncError(sql, {
          sync_id: sync.id,
          error_message: "second",
          handler_version: 1
        });

        const errors = listSyncErrors(sql, sync.id);
        expect(errors).toHaveLength(2);
        expect(errors[0].error_message).toBe("second");
        expect(errors[1].error_message).toBe("first");
      });
    });

    it("aggregates error stats within a time window", async () => {
      const { stub, userName } = getStub("stats-user");
      const sync = sampleSync({ name: "stats-target" });

      await runInDurableObject(stub, async (instance) => {
        await ensureReady(instance, userName);
        const sql = bindSql(instance);
        createSync(sql, sync);
        logSyncError(sql, {
          sync_id: sync.id,
          error_message: "old boom",
          handler_version: 1
        });
        // Same 2ms delay the sibling "logs and lists errors" test uses:
        // without it both inserts share a Date.now() millisecond and the
        // subquery's ORDER BY occurred_at DESC LIMIT 1 picks by SQLite's
        // tiebreaker (insertion order ASC), returning "old boom".
        await new Promise((r) => setTimeout(r, 2));
        logSyncError(sql, {
          sync_id: sync.id,
          error_message: "new boom",
          handler_version: 1
        });

        const stats = getSyncErrorStats(sql, 0);
        expect(stats).toHaveLength(1);
        expect(stats[0].sync_id).toBe(sync.id);
        expect(stats[0].error_count).toBe(2);
        expect(stats[0].last_error_message).toBe("new boom");
      });
    });
  });

  describe("per-user isolation (richer than Phase 01)", () => {
    it("lets two different users have syncs with the same name", async () => {
      const a = getStub("iso-user-a");
      const b = getStub("iso-user-b");

      await runInDurableObject(a.stub, async (instance) => {
        await ensureReady(instance, a.userName);
        createSync(bindSql(instance), sampleSync({ name: "linear-bugs" }));
      });
      await runInDurableObject(b.stub, async (instance) => {
        await ensureReady(instance, b.userName);
        createSync(bindSql(instance), sampleSync({ name: "linear-bugs" }));
      });

      await runInDurableObject(a.stub, async (instance) => {
        await ensureReady(instance, a.userName);
        const list = listSyncs(bindSql(instance));
        expect(list).toHaveLength(1);
        expect(list[0].name).toBe("linear-bugs");
      });
      await runInDurableObject(b.stub, async (instance) => {
        await ensureReady(instance, b.userName);
        const list = listSyncs(bindSql(instance));
        expect(list).toHaveLength(1);
        expect(list[0].name).toBe("linear-bugs");
      });
    });

    it("user A cannot see user B's syncs via getSyncByName", async () => {
      const a = getStub("leak-user-a");
      const b = getStub("leak-user-b");
      const uniqueName = `user-b-only-${crypto.randomUUID().slice(0, 6)}`;

      await runInDurableObject(b.stub, async (instance) => {
        await ensureReady(instance, b.userName);
        createSync(bindSql(instance), sampleSync({ name: uniqueName }));
      });

      await runInDurableObject(a.stub, async (instance) => {
        await ensureReady(instance, a.userName);
        expect(getSyncByName(bindSql(instance), uniqueName)).toBeNull();
      });
    });
  });
});
