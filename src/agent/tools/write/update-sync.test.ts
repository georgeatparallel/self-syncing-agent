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
          const sql = (instance as { sql: SqlTag }).sql.bind(
            instance
          ) as SqlTag;
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
            handler_code:
              "export async function handleWebhook() { SYNTAX ERROR }"
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
});
