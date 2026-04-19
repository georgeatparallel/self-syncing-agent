import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { createSyncTool } from "../src/agent/tools/write/create-sync";
import { listSyncs, getSyncByName } from "../src/db/syncs";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const SAMPLE_HANDLER = `
export async function verifySignature(body, headers, secret) {
  return true;
}
export async function handleWebhook(request, sql) {
  return new Response("ok", { status: 200 });
}
export async function registerWebhook(callbackUrl, label) {
  return { id: "wh_bundle", secret: "sec_bundle" };
}
export async function unregisterWebhook(id, label) {
  return { ok: true };
}
`;

const SAMPLE_SCHEMA =
  "CREATE TABLE IF NOT EXISTS issues (id TEXT PRIMARY KEY);";

/**
 * The vitest-pool-workers bundled `workerd` (1.20260310.x) does not ship
 * Durable Object Facets nor the full Worker Loader API surface
 * (`worker.getDurableObjectClass` is absent in the test runtime).
 * Real facets work only in `wrangler dev` + deploy.
 *
 * For integration-shape coverage we install a minimal in-memory stand-in
 * on `ctx.facets` that mimics the runtime contract: `get()` invokes the
 * callback to validate the bundle shape, then returns a stub whose RPC
 * methods can be overridden per test to drive each branch of
 * create_sync's rollback ladder.
 */
interface FakeFacetStub {
  fetch: (req: Request) => Promise<Response>;
  __supervisorPing: () => Promise<void>;
  __registerWebhook: (config: {
    callbackUrl: string;
    label: string;
  }) => Promise<{ id: string; secret: string }>;
  __unregisterWebhook: (config: {
    id: string;
    label: string;
  }) => Promise<{ ok: true } | { ok: false; reason: string }>;
}
interface FakeFacets {
  get(
    name: string,
    callback: () => { class: unknown } | Promise<{ class: unknown }>
  ): FakeFacetStub;
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

describe("create_sync end-to-end", () => {
  it("creates a sync: registerWebhook via facet + persisted row + attached facet", async () => {
    const stub = env.ChatAgent.get(env.ChatAgent.idFromName("e2e-happy"));
    await runInDurableObject(stub, async (instance) => {
      await (
        instance as unknown as { setName: (n: string) => Promise<void> }
      ).setName("e2e-happy");

      // Install a successful fake facets API. The callback is invoked
      // to exercise the bundle-building path (Worker Loader lookup) even
      // though the concrete class object is unused under this stand-in.
      const facetCalls: string[] = [];
      const registerCalls: { callbackUrl: string; label: string }[] = [];
      const restoreFacets = installFakeFacets(instance, {
        get(name, callback) {
          facetCalls.push(name);
          // Kick the callback to catch bundle-build errors; swallow the
          // returned class (unusable under Miniflare's workerd).
          void Promise.resolve(callback()).catch(() => {});
          return {
            fetch: async () => new Response("ok", { status: 200 }),
            __supervisorPing: async () => {},
            __registerWebhook: async (config) => {
              registerCalls.push(config);
              return { id: "wh_bundle", secret: "sec_bundle" };
            },
            __unregisterWebhook: async () => ({ ok: true as const })
          };
        },
        abort: () => {},
        delete: () => {}
      });

      try {
        const tools = createSyncTool(instance);
        const result = await tools.execute!(
          {
            name: "linear-issues",
            integration: "linear",
            schema_ddl: SAMPLE_SCHEMA,
            handler_code: SAMPLE_HANDLER,
            filter_description: "all Linear issues"
          },
          {} as never
        );

        if (!("ok" in result) || result.ok !== true) {
          throw new Error(
            `Expected ok: true, got: ${JSON.stringify(result, null, 2)}`
          );
        }
        expect(result.upstream_webhook_id).toBe("wh_bundle");
        expect(facetCalls).toEqual(["linear-issues"]);
        expect(registerCalls).toHaveLength(1);
        expect(registerCalls[0].label).toMatch(/self-syncing-agent:/);

        const sql = instance.sql.bind(instance);
        const all = listSyncs(sql);
        expect(all).toHaveLength(1);
        const persisted = all[0];
        expect(persisted.name).toBe("linear-issues");
        expect(persisted.integration).toBe("linear");
        expect(persisted.upstream_webhook_id).toBe("wh_bundle");
        expect(persisted.webhook_secret).toBe("sec_bundle");
        expect(persisted.version).toBe(1);
      } finally {
        restoreFacets();
      }
    });
  });

  it("rolls back the facet attachment if __supervisorPing rejects (compile error)", async () => {
    const stub = env.ChatAgent.get(env.ChatAgent.idFromName("e2e-rollback"));
    await runInDurableObject(stub, async (instance) => {
      await (
        instance as unknown as { setName: (n: string) => Promise<void> }
      ).setName("e2e-rollback");

      // Simulate a compile failure via a ping that throws. In production
      // this mirrors Worker Loader rejecting a syntactically-broken
      // handler.js during its first RPC call.
      const deletedFacets: string[] = [];
      const registerCalls: { callbackUrl: string; label: string }[] = [];
      const restoreFacets = installFakeFacets(instance, {
        get() {
          return {
            fetch: async () => new Response("ok", { status: 200 }),
            __supervisorPing: async () => {
              throw new Error(
                "Worker Loader: SyntaxError in handler.js (simulated)"
              );
            },
            __registerWebhook: async (config) => {
              registerCalls.push(config);
              return { id: "wh_never", secret: "sec_never" };
            },
            __unregisterWebhook: async () => ({ ok: true as const })
          };
        },
        abort: () => {},
        delete: (name: string) => {
          deletedFacets.push(name);
        }
      });

      try {
        const tools = createSyncTool(instance);
        const result = await tools.execute!(
          {
            name: "linear-rollback",
            integration: "linear",
            schema_ddl: SAMPLE_SCHEMA,
            handler_code: SAMPLE_HANDLER
          },
          {} as never
        );

        expect(result).toMatchObject({
          ok: false,
          error: "facet_load_failed"
        });

        // DB row must NOT exist (we never reached persist).
        const sql = instance.sql.bind(instance);
        expect(getSyncByName(sql, "linear-rollback")).toBeNull();

        // registerWebhook was NOT called (ping failed before register).
        expect(registerCalls).toHaveLength(0);
        // Facet was torn down.
        expect(deletedFacets).toEqual(["linear-rollback"]);
      } finally {
        restoreFacets();
      }
    });
  });
});
