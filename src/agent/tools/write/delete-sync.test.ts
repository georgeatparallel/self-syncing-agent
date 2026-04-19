import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { deleteSyncTool } from "./delete-sync";
import { createSync, getSyncById } from "../../../db/syncs";
import type { NewSync, SqlTag } from "../../../db/types";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

function getStub(userName: string) {
  return env.ChatAgent.get(env.ChatAgent.idFromName(userName));
}

async function ensureReady(instance: unknown, userName: string): Promise<void> {
  await (instance as { setName: (n: string) => Promise<void> }).setName(
    userName
  );
}

const SAMPLE_HANDLER =
  "export async function verifySignature(){return true;}" +
  "export async function handleWebhook(){return new Response('ok');}";
const SAMPLE_SCHEMA = "CREATE TABLE IF NOT EXISTS x (id TEXT);";

function seedSync(
  instance: unknown,
  overrides: Partial<NewSync> = {}
): { id: string; name: string } {
  const sql = (instance as { sql: SqlTag }).sql.bind(instance) as SqlTag;
  const id = crypto.randomUUID();
  const name = overrides.name ?? `sync-${id.slice(0, 8)}`;
  const input: NewSync = {
    id,
    name,
    integration: "linear",
    handler_code: SAMPLE_HANDLER,
    schema_ddl: SAMPLE_SCHEMA,
    filter_description: null,
    webhook_secret: "sec_test",
    upstream_webhook_id: "wh_test",
    code_id: `sync:${id}:v1`,
    ...overrides
  };
  createSync(sql, input);
  return { id, name: input.name };
}

/**
 * Fake-facets test double mirroring the Task 2 pattern in
 * create-sync.test.ts. The vitest-pool-workers bundled workerd doesn't
 * ship the full Worker Loader / Facets surface; we stub `ctx.facets` with
 * a minimal in-memory stand-in whose methods can be swapped per-test to
 * drive each branch of delete_sync's flow.
 */
interface FakeFacetStub {
  fetch: (req: Request) => Promise<Response>;
  __unregisterWebhook: (config: {
    id: string;
    label: string;
  }) => Promise<{ ok: true } | { ok: false; reason: string; detail?: string }>;
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

interface CallRecord {
  facetsDeleteCalls: string[];
  unregisterCalls: { id: string; label: string }[];
}

function freshRecord(): CallRecord {
  return { facetsDeleteCalls: [], unregisterCalls: [] };
}

function makeFakeFacets(
  record: CallRecord,
  overrides: Partial<FakeFacetStub> = {}
): FakeFacets {
  const defaultStub: FakeFacetStub = {
    fetch: async () => new Response("ok", { status: 200 }),
    __unregisterWebhook: async (config) => {
      record.unregisterCalls.push(config);
      return { ok: true as const };
    }
  };
  const stub: FakeFacetStub = { ...defaultStub, ...overrides };
  return {
    get() {
      return stub;
    },
    abort: () => {},
    delete: (name: string) => {
      record.facetsDeleteCalls.push(name);
    }
  };
}

describe("deleteSyncTool", () => {
  it("returns not_found for an unknown sync_id", async () => {
    const stub = getStub("d-404");
    await runInDurableObject(stub, async (instance) => {
      await ensureReady(instance, "d-404");
      const record = freshRecord();
      const restoreFacets = installFakeFacets(instance, makeFakeFacets(record));
      try {
        const tools = deleteSyncTool(instance as never);
        const res = await tools.execute!(
          { sync_id: "00000000-0000-0000-0000-000000000000" },
          {} as never
        );
        expect(res).toMatchObject({
          error: "not_found",
          sync_id: "00000000-0000-0000-0000-000000000000"
        });
        // No facet RPCs invoked on not_found.
        expect(record.unregisterCalls).toHaveLength(0);
        expect(record.facetsDeleteCalls).toHaveLength(0);
      } finally {
        restoreFacets();
      }
    });
  });

  it("happy path: __unregisterWebhook succeeds - sync cleaned up, no warnings", async () => {
    const userName = "d-happy";
    const stub = getStub(userName);
    await runInDurableObject(stub, async (instance) => {
      await ensureReady(instance, userName);
      const seeded = seedSync(instance, {
        name: "happy-sync",
        upstream_webhook_id: "wh_test"
      });
      const record = freshRecord();
      const restoreFacets = installFakeFacets(instance, makeFakeFacets(record));

      try {
        const tools = deleteSyncTool(instance as never);
        const res = await tools.execute!({ sync_id: seeded.id }, {} as never);

        expect(res).toEqual({ ok: true });
        // No warnings field at all on pure success.
        expect(res as { warnings?: unknown }).not.toHaveProperty("warnings");

        // __unregisterWebhook was called once, with expected shape.
        expect(record.unregisterCalls).toHaveLength(1);
        expect(record.unregisterCalls[0].id).toBe("wh_test");
        expect(record.unregisterCalls[0].label).toBe(
          `self-syncing-agent:${userName.slice(0, 8)}:happy-sync`
        );

        // DB row gone.
        const sql = (instance as { sql: SqlTag }).sql.bind(instance) as SqlTag;
        expect(getSyncById(sql, seeded.id)).toBeNull();

        // Facet dropped.
        expect(record.facetsDeleteCalls).toEqual(["happy-sync"]);
      } finally {
        restoreFacets();
      }
    });
  });

  it("graceful-skip: no_unregister_export adds a warning but still cleans up locally", async () => {
    const userName = "d-noexport";
    const stub = getStub(userName);
    await runInDurableObject(stub, async (instance) => {
      await ensureReady(instance, userName);
      const seeded = seedSync(instance, {
        name: "legacy-sync",
        upstream_webhook_id: "wh_legacy"
      });
      const record = freshRecord();
      const restoreFacets = installFakeFacets(
        instance,
        makeFakeFacets(record, {
          __unregisterWebhook: async (config) => {
            record.unregisterCalls.push(config);
            return { ok: false as const, reason: "no_unregister_export" };
          }
        })
      );

      try {
        const tools = deleteSyncTool(instance as never);
        const res = await tools.execute!({ sync_id: seeded.id }, {} as never);

        if (!("ok" in res) || res.ok !== true) {
          throw new Error(
            `expected ok: true, got: ${JSON.stringify(res, null, 2)}`
          );
        }
        expect(res.warnings).toBeDefined();
        expect(res.warnings).toHaveLength(1);
        expect(res.warnings![0]).toMatch(
          /cleanup skipped: no_unregister_export/
        );
        // Warning must be actionable — mention manual cleanup.
        expect(res.warnings![0]).toMatch(/manual/i);

        // Local cleanup still happened.
        const sql = (instance as { sql: SqlTag }).sql.bind(instance) as SqlTag;
        expect(getSyncById(sql, seeded.id)).toBeNull();
        expect(record.facetsDeleteCalls).toEqual(["legacy-sync"]);
      } finally {
        restoreFacets();
      }
    });
  });

  it("graceful-skip: threw with detail surfaces both reason and detail in warning", async () => {
    const userName = "d-threw";
    const stub = getStub(userName);
    await runInDurableObject(stub, async (instance) => {
      await ensureReady(instance, userName);
      const seeded = seedSync(instance, {
        name: "flaky-sync",
        upstream_webhook_id: "wh_flaky"
      });
      const record = freshRecord();
      const restoreFacets = installFakeFacets(
        instance,
        makeFakeFacets(record, {
          __unregisterWebhook: async (config) => {
            record.unregisterCalls.push(config);
            return {
              ok: false as const,
              reason: "threw",
              detail: "simulated network error"
            };
          }
        })
      );

      try {
        const tools = deleteSyncTool(instance as never);
        const res = await tools.execute!({ sync_id: seeded.id }, {} as never);

        if (!("ok" in res) || res.ok !== true) {
          throw new Error(
            `expected ok: true, got: ${JSON.stringify(res, null, 2)}`
          );
        }
        expect(res.warnings).toBeDefined();
        expect(res.warnings).toHaveLength(1);
        expect(res.warnings![0]).toMatch(/threw/);
        expect(res.warnings![0]).toMatch(/simulated network error/);

        // Local cleanup still happened.
        const sql = (instance as { sql: SqlTag }).sql.bind(instance) as SqlTag;
        expect(getSyncById(sql, seeded.id)).toBeNull();
        expect(record.facetsDeleteCalls).toEqual(["flaky-sync"]);
      } finally {
        restoreFacets();
      }
    });
  });
});
