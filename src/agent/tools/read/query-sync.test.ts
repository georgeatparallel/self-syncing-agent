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

  it("rejects multi-statement queries even if the first is SELECT", async () => {
    const stub = env.ChatAgent.get(env.ChatAgent.idFromName("q-multi"));
    await runInDurableObject(stub, async (instance) => {
      await (
        instance as never as { setName: (n: string) => Promise<void> }
      ).setName("q-multi");
      const syncId = seedSync(instance);
      const tool = querySyncTool(instance as never);
      const res = await tool.execute!(
        { sync_id: syncId, query: "SELECT 1; DROP TABLE issues" },
        {} as never
      );
      expect(res).toMatchObject({ error: "invalid_sql" });
    });
  });

  it("rejects WITH ... INSERT even though the prefix is WITH", async () => {
    const stub = env.ChatAgent.get(env.ChatAgent.idFromName("q-with-insert"));
    await runInDurableObject(stub, async (instance) => {
      await (
        instance as never as { setName: (n: string) => Promise<void> }
      ).setName("q-with-insert");
      const syncId = seedSync(instance);
      const tool = querySyncTool(instance as never);
      const res = await tool.execute!(
        {
          sync_id: syncId,
          query: "WITH t AS (SELECT 1 AS n) INSERT INTO issues SELECT n FROM t"
        },
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
            __query: async () => ({
              ok: false,
              error: "no such table: bogus"
            })
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
