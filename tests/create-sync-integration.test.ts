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

const SAMPLE_SCHEMA =
  "CREATE TABLE IF NOT EXISTS issues (id TEXT PRIMARY KEY);";

/**
 * The vitest-pool-workers bundled `workerd` (1.20260310.x) does not ship
 * Durable Object Facets nor the full Worker Loader API surface
 * (`worker.getDurableObjectClass` is absent in the test runtime).
 * Real facets work only in `wrangler dev` + deploy.
 *
 * For happy-path integration coverage we install a minimal in-memory
 * stand-in on `ctx.facets` that mimics the runtime contract: `get()`
 * invokes the callback to validate the bundle shape, returns a stub
 * that answers `fetch()` with a 200 response (simulating successful
 * schema init + handler delegation). The rollback test installs a
 * `get()` that throws, exercising the `facet_load_failed` branch.
 */
interface FakeFacetStub {
  fetch: (req: Request) => Promise<Response>;
  __supervisorPing: () => Promise<void>;
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

function stubLinearFetch(): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(
    async (url: RequestInfo | URL, init?: RequestInit) => {
      if (!String(url).includes("api.linear.app"))
        return original(url as never, init as never);
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
                  enabled: true
                }
              }
            }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (body.query.includes("webhookDelete")) {
        return new Response(
          JSON.stringify({ data: { webhookDelete: { success: true } } }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response("{}", { status: 500 });
    }
  ) as typeof fetch;
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

        // Install a successful fake facets API. The callback is invoked
        // to exercise the bundle-building path (Worker Loader lookup) even
        // though the concrete class object is unused under this stand-in.
        const facetCalls: string[] = [];
        const restoreFacets = installFakeFacets(instance, {
          get(name, callback) {
            facetCalls.push(name);
            // Kick the callback to catch bundle-build errors; swallow the
            // returned class (unusable under Miniflare's workerd).
            void Promise.resolve(callback()).catch(() => {});
            return {
              fetch: async () => new Response("ok", { status: 200 }),
              __supervisorPing: async () => {}
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
              resource_types: ["Issue"],
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
          expect(result.linear_webhook_id).toMatch(/^wh_stub_/);
          expect(facetCalls).toEqual(["linear-issues"]);

          const sql = instance.sql.bind(instance);
          const all = listSyncs(sql);
          expect(all).toHaveLength(1);
          const persisted = all[0];
          expect(persisted.name).toBe("linear-issues");
          expect(persisted.integration).toBe("linear");
          expect(persisted.upstream_webhook_id).toMatch(/^wh_stub_/);
          expect(persisted.webhook_secret).toMatch(/^sec_stub_/);
          expect(persisted.version).toBe(1);
        } finally {
          restoreFacets();
        }
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

        // Simulate Worker Loader/facet failure via a fake that throws
        // from get(). In production this mirrors a compilation error
        // when the agent's handler.js has invalid syntax.
        const restoreFacets = installFakeFacets(instance, {
          get() {
            throw new Error(
              "Worker Loader: SyntaxError in handler.js (simulated)"
            );
          },
          abort: () => {},
          delete: () => {}
        });

        try {
          // The fake facets.get() throws synchronously (see installFakeFacets
          // above), driving the tool's facet_load_failed branch. In
          // production, the same branch fires when Worker Loader fails to
          // compile handler.js (e.g., syntax error) or when
          // worker.getDurableObjectClass throws.
          const tools = createSyncTool(instance);
          const result = await tools.execute!(
            {
              name: "linear-rollback",
              integration: "linear",
              resource_types: ["Issue"],
              schema_ddl: SAMPLE_SCHEMA,
              handler_code: SAMPLE_HANDLER
            },
            {} as never
          );

          expect(result).toMatchObject({
            ok: false,
            error: "facet_load_failed"
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
              ((args[1] as RequestInit).body as string).includes(
                "webhookDelete"
              )
          );
          expect(webhookDeleteCalled).toBe(true);
        } finally {
          restoreFacets();
        }
      });
    } finally {
      restore();
    }
  });
});
