import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect, vi } from "vitest";
import { deleteSyncTool } from "./delete-sync";
import { createSync, getSyncById } from "../../../db/syncs";
import { logSyncError } from "../../../db/sync-errors";
import type { NewSync, SqlTag } from "../../../db/types";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

function seedSync(instance: unknown): string {
  const sql = (instance as { sql: SqlTag }).sql.bind(instance) as SqlTag;
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
        const sql = (instance as { sql: SqlTag }).sql.bind(instance) as SqlTag;
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

          // DB row gone
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

  it("tolerates a 'facet not running' error and still removes the sync row", async () => {
    const restore = stubLinearFetch();
    try {
      const stub = env.ChatAgent.get(env.ChatAgent.idFromName("d-notrunning"));
      await runInDurableObject(stub, async (instance) => {
        await (
          instance as never as { setName: (n: string) => Promise<void> }
        ).setName("d-notrunning");
        const syncId = seedSync(instance);

        const restoreFacets = installFakeFacets(instance, {
          get: () => ({ fetch: async () => new Response("ok") }),
          abort: () => {},
          // Simulates a sync whose facet never materialized (e.g., the
          // user deletes right after create_sync before any webhook
          // arrived). workerd's ctx.facets.delete throws in this case.
          delete: () => {
            throw new Error("facet not running");
          }
        });

        try {
          const tool = deleteSyncTool(instance as never);
          const res = await tool.execute!({ sync_id: syncId }, {} as never);
          expect(res).toMatchObject({ ok: true });

          const sql = (instance as { sql: SqlTag }).sql.bind(
            instance
          ) as SqlTag;
          expect(getSyncById(sql, syncId)).toBeNull();
        } finally {
          restoreFacets();
        }
      });
    } finally {
      restore();
    }
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
          const sql = (instance as { sql: SqlTag }).sql.bind(
            instance
          ) as SqlTag;
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
