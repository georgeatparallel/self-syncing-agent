import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { createSyncTool } from "./create-sync";
import { getSyncById, listSyncs, getSyncByName } from "../../../db/syncs";

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

const SAMPLE_HANDLER = `
export async function verifySignature(body, headers, secret) {
  return true;
}
export async function handleWebhook(request, sql) {
  return new Response("ok", { status: 200 });
}
export async function registerWebhook(callbackUrl, label) {
  return { id: "wh_test", secret: "sec_test" };
}
export async function unregisterWebhook(id, label) {
  return { ok: true };
}
`;

const SAMPLE_SCHEMA =
  "CREATE TABLE IF NOT EXISTS issues (id TEXT PRIMARY KEY, title TEXT);";

/**
 * Fake-facets test double. The vitest-pool-workers bundled workerd doesn't
 * ship the full Worker Loader / Facets surface; we stub `ctx.facets` with
 * a minimal in-memory stand-in whose methods can be swapped per-test to
 * drive each branch of create_sync's rollback ladder.
 */
interface FakeFacetStub {
  fetch: (req: Request) => Promise<Response>;
  __supervisorPing: () => Promise<void>;
  __verifySignature: (
    body: Uint8Array,
    headers: Record<string, string>,
    secret: string
  ) => Promise<boolean>;
  __registerWebhook: (config: {
    callbackUrl: string;
    label: string;
  }) => Promise<unknown>;
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

/**
 * Record of calls made on the fake stub. Lets each test assert which RPCs
 * were invoked (e.g. that __unregisterWebhook was NOT called on
 * register-throw, but WAS called on persist-fail).
 */
interface CallRecord {
  facetsDeleteCalls: string[];
  registerCalls: { callbackUrl: string; label: string }[];
  unregisterCalls: { id: string; label: string }[];
  pingCalls: number;
}

function makeFakeFacets(
  record: CallRecord,
  overrides: Partial<FakeFacetStub> = {}
): FakeFacets {
  const defaultStub: FakeFacetStub = {
    fetch: async () => new Response("ok", { status: 200 }),
    __supervisorPing: async () => {
      record.pingCalls += 1;
    },
    __verifySignature: async () => true,
    __registerWebhook: async (config) => {
      record.registerCalls.push(config);
      return { id: "wh_test", secret: "sec_test" };
    },
    __unregisterWebhook: async (config) => {
      record.unregisterCalls.push(config);
      return { ok: true as const };
    }
  };
  const stub: FakeFacetStub = { ...defaultStub, ...overrides };
  // If the override wraps __supervisorPing, keep the record update. The
  // test author can opt into recording explicitly by reading record.pingCalls
  // — but the override's semantics win (e.g., throwing for compile-failure).
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

function freshRecord(): CallRecord {
  return {
    facetsDeleteCalls: [],
    registerCalls: [],
    unregisterCalls: [],
    pingCalls: 0
  };
}

describe("createSyncTool", () => {
  it("rejects duplicate sync names before touching the facet", async () => {
    const stub = getStub("create-dup");
    const userName = "create-dup";

    await runInDurableObject(stub, async (instance) => {
      await ensureReady(instance, userName);
      const tools = createSyncTool(instance);
      // Pre-seed a sync with the same name.
      const sql = instance.sql.bind(instance);
      sql`
        INSERT INTO syncs (
          id, name, integration, handler_code, schema_ddl,
          filter_description, webhook_secret, upstream_webhook_id,
          code_id, version, created_at, updated_at
        ) VALUES (
          'existing-1', 'taken-name', 'linear', '', '',
          NULL, 's', NULL, 'c', 1, ${Date.now()}, ${Date.now()}
        )
      `;

      const result = await tools.execute!(
        {
          name: "taken-name",
          integration: "linear",
          schema_ddl: SAMPLE_SCHEMA,
          handler_code: SAMPLE_HANDLER
        },
        {} as never
      );

      expect(result).toMatchObject({
        ok: false,
        error: "duplicate_name"
      });
    });
  });

  it("happy path: registers via facet, persists, returns upstream_webhook_id", async () => {
    const stub = getStub("create-happy");
    const userName = "create-happy";

    await runInDurableObject(stub, async (instance) => {
      await ensureReady(instance, userName);
      const record = freshRecord();
      const restoreFacets = installFakeFacets(instance, makeFakeFacets(record));

      try {
        const tools = createSyncTool(instance);
        const result = await tools.execute!(
          {
            name: "linear-issues",
            integration: "linear",
            schema_ddl: SAMPLE_SCHEMA,
            handler_code: SAMPLE_HANDLER,
            filter_description: "all linear issues"
          },
          {} as never
        );

        if (!("ok" in result) || result.ok !== true) {
          throw new Error(
            `expected ok: true, got: ${JSON.stringify(result, null, 2)}`
          );
        }
        expect(result.upstream_webhook_id).toBe("wh_test");
        expect(typeof result.sync_id).toBe("string");

        const sql = instance.sql.bind(instance);
        const persisted = getSyncById(sql, result.sync_id);
        expect(persisted).not.toBeNull();
        expect(persisted!.name).toBe("linear-issues");
        expect(persisted!.webhook_secret).toBe("sec_test");
        expect(persisted!.upstream_webhook_id).toBe("wh_test");
        expect(persisted!.version).toBe(1);

        // __supervisorPing fired once (pre-register); __registerWebhook
        // fired once; __unregisterWebhook did NOT fire.
        expect(record.pingCalls).toBe(1);
        expect(record.registerCalls).toHaveLength(1);
        expect(record.registerCalls[0].label).toMatch(/self-syncing-agent:/);
        expect(record.registerCalls[0].callbackUrl).toMatch(
          new RegExp(`/webhook/${userName}/${result.sync_id}$`)
        );
        expect(record.unregisterCalls).toHaveLength(0);
        expect(record.facetsDeleteCalls).toHaveLength(0);
      } finally {
        restoreFacets();
      }
    });
  });

  it("rolls back on compile failure: no DB row, facets.delete invoked", async () => {
    const stub = getStub("create-compile-fail");
    const userName = "create-compile-fail";

    await runInDurableObject(stub, async (instance) => {
      await ensureReady(instance, userName);
      const record = freshRecord();
      const restoreFacets = installFakeFacets(
        instance,
        makeFakeFacets(record, {
          __supervisorPing: async () => {
            throw new Error("SyntaxError: unexpected token");
          }
        })
      );

      try {
        const tools = createSyncTool(instance);
        const result = await tools.execute!(
          {
            name: "compile-broken",
            integration: "linear",
            schema_ddl: SAMPLE_SCHEMA,
            handler_code: SAMPLE_HANDLER
          },
          {} as never
        );

        expect(result).toMatchObject({
          ok: false,
          error: "facet_load_failed",
          detail: expect.stringMatching(/SyntaxError/)
        });

        const sql = instance.sql.bind(instance);
        expect(getSyncByName(sql, "compile-broken")).toBeNull();
        expect(listSyncs(sql)).toHaveLength(0);

        // Facet was torn down, registerWebhook never called.
        expect(record.facetsDeleteCalls).toEqual(["compile-broken"]);
        expect(record.registerCalls).toHaveLength(0);
        expect(record.unregisterCalls).toHaveLength(0);
      } finally {
        restoreFacets();
      }
    });
  });

  it("rolls back when registerWebhook throws: no DB row, no unregister call", async () => {
    const stub = getStub("create-register-throw");
    const userName = "create-register-throw";

    await runInDurableObject(stub, async (instance) => {
      await ensureReady(instance, userName);
      const record = freshRecord();
      const restoreFacets = installFakeFacets(
        instance,
        makeFakeFacets(record, {
          __registerWebhook: async (config) => {
            record.registerCalls.push(config);
            throw new Error("Linear API returned 401");
          }
        })
      );

      try {
        const tools = createSyncTool(instance);
        const result = await tools.execute!(
          {
            name: "register-throws",
            integration: "linear",
            schema_ddl: SAMPLE_SCHEMA,
            handler_code: SAMPLE_HANDLER
          },
          {} as never
        );

        expect(result).toMatchObject({
          ok: false,
          error: "webhook_register_failed",
          detail: expect.stringMatching(/Linear API returned 401/)
        });

        const sql = instance.sql.bind(instance);
        expect(getSyncByName(sql, "register-throws")).toBeNull();

        expect(record.facetsDeleteCalls).toEqual(["register-throws"]);
        expect(record.registerCalls).toHaveLength(1);
        // __unregisterWebhook must NOT be called — nothing was registered.
        expect(record.unregisterCalls).toHaveLength(0);
      } finally {
        restoreFacets();
      }
    });
  });

  it("rolls back when registerWebhook returns a bad shape", async () => {
    const stub = getStub("create-register-badshape");
    const userName = "create-register-badshape";

    await runInDurableObject(stub, async (instance) => {
      await ensureReady(instance, userName);
      const record = freshRecord();
      const restoreFacets = installFakeFacets(
        instance,
        makeFakeFacets(record, {
          __registerWebhook: async (config) => {
            record.registerCalls.push(config);
            // secret is a number, not a string — must be rejected.
            return { id: "wh", secret: 123 } as never;
          }
        })
      );

      try {
        const tools = createSyncTool(instance);
        const result = await tools.execute!(
          {
            name: "register-badshape",
            integration: "linear",
            schema_ddl: SAMPLE_SCHEMA,
            handler_code: SAMPLE_HANDLER
          },
          {} as never
        );

        expect(result).toMatchObject({
          ok: false,
          error: "webhook_register_failed",
          detail: expect.stringMatching(/invalid shape/)
        });

        const sql = instance.sql.bind(instance);
        expect(getSyncByName(sql, "register-badshape")).toBeNull();

        expect(record.facetsDeleteCalls).toEqual(["register-badshape"]);
        expect(record.registerCalls).toHaveLength(1);
        expect(record.unregisterCalls).toHaveLength(0);
      } finally {
        restoreFacets();
      }
    });
  });

  it("rolls back on persist failure: __unregisterWebhook called with just-registered id", async () => {
    const stub = getStub("create-persist-fail");
    const userName = "create-persist-fail";

    await runInDurableObject(stub, async (instance) => {
      await ensureReady(instance, userName);
      const record = freshRecord();
      const restoreFacets = installFakeFacets(
        instance,
        makeFakeFacets(record, {
          __registerWebhook: async (config) => {
            record.registerCalls.push(config);
            return { id: "wh_persist", secret: "sec_persist" };
          }
        })
      );

      // Pre-seed a row with the SAME `name` so createSync's UNIQUE
      // constraint fires when the tool tries to persist. The tool's
      // getSyncByName guard uses the EXACT same name — so we need to
      // sneak the conflict past that guard. We do it by inserting a
      // row whose name exactly matches the one create_sync is about to
      // use: the guard already returns duplicate_name before reaching
      // the register step. Instead: pre-seed with a conflicting `id`
      // is no good (id is a UUID generated per call). The reliable
      // way is to race the INSERT — but vitest has no concurrency
      // hook here. So we substitute the createSync path by pre-
      // seeding a row with a unique constraint collision on an
      // implementation detail: create_sync checks getSyncByName, but
      // not getSyncById. Insert a conflicting row AFTER the guard via
      // a __registerWebhook-time side effect that writes a row with
      // the same name into the DB.
      //
      // Simplest approach: __registerWebhook is called AFTER the
      // duplicate-name guard but BEFORE createSync. Have the fake
      // __registerWebhook insert a row with the same name, then
      // return the stub webhook ids. createSync's INSERT will
      // collide on the `name` UNIQUE index and throw.
      const sql = instance.sql.bind(instance);
      const originalRegister = record.registerCalls;
      // Rebuild the fake with a register that also seeds a conflicting row.
      restoreFacets();
      const restoreFacets2 = installFakeFacets(
        instance,
        makeFakeFacets(record, {
          __registerWebhook: async (config) => {
            originalRegister.push(config);
            sql`
              INSERT INTO syncs (
                id, name, integration, handler_code, schema_ddl,
                filter_description, webhook_secret, upstream_webhook_id,
                code_id, version, created_at, updated_at
              ) VALUES (
                'squat-1', 'persist-target', 'linear', '', '',
                NULL, 's', NULL, 'c', 1, ${Date.now()}, ${Date.now()}
              )
            `;
            return { id: "wh_persist", secret: "sec_persist" };
          }
        })
      );

      try {
        const tools = createSyncTool(instance);
        const result = await tools.execute!(
          {
            name: "persist-target",
            integration: "linear",
            schema_ddl: SAMPLE_SCHEMA,
            handler_code: SAMPLE_HANDLER
          },
          {} as never
        );

        expect(result).toMatchObject({
          ok: false,
          error: "persist_failed"
        });

        // The pre-existing 'squat-1' row should still be there; no new
        // row with our UUID should have been persisted.
        const all = listSyncs(sql);
        expect(all).toHaveLength(1);
        expect(all[0].id).toBe("squat-1");

        expect(record.facetsDeleteCalls).toEqual(["persist-target"]);
        expect(record.registerCalls).toHaveLength(1);
        // Persist-fail branch MUST call __unregisterWebhook best-effort.
        expect(record.unregisterCalls).toHaveLength(1);
        expect(record.unregisterCalls[0].id).toBe("wh_persist");
        expect(record.unregisterCalls[0].label).toMatch(/self-syncing-agent:/);
      } finally {
        restoreFacets2();
      }
    });
  });
});
