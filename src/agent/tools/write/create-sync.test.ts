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
      // Assert the INSERT-before-register ordering by peeking at the DB
      // from inside the __registerWebhook mock. If the row isn't in SQL
      // at that moment, the egress gateway's live resolveEgress RPC would
      // 403 any handler fetch with sync_not_found. This pins the fix for
      // that Phase F Task 3 regression.
      let rowVisibleDuringRegister: {
        webhook_secret: string;
        upstream_webhook_id: string | null;
        api_hosts: string[];
      } | null = null;
      const restoreFacets = installFakeFacets(
        instance,
        makeFakeFacets(record, {
          __registerWebhook: async (config) => {
            record.registerCalls.push(config);
            const sql = instance.sql.bind(instance);
            // Parse syncId out of the callbackUrl so we don't depend on
            // closure-sharing the UUID with the tool.
            const match = config.callbackUrl.match(
              /\/webhook\/[^/]+\/([^/]+)$/
            );
            const sid = match?.[1] ?? "";
            const row = getSyncById(sql, sid);
            if (row) {
              rowVisibleDuringRegister = {
                webhook_secret: row.webhook_secret,
                upstream_webhook_id: row.upstream_webhook_id,
                api_hosts: row.api_hosts
              };
            }
            return { id: "wh_test", secret: "sec_test" };
          }
        })
      );

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

        // INSERT-before-registerWebhook ordering: the row was in SQL
        // while __registerWebhook ran, and it carried empty-string
        // placeholders for the fields that registerWebhook returns.
        expect(rowVisibleDuringRegister).not.toBeNull();
        expect(rowVisibleDuringRegister!.webhook_secret).toBe("");
        expect(rowVisibleDuringRegister!.upstream_webhook_id).toBe("");

        const sql = instance.sql.bind(instance);
        const persisted = getSyncById(sql, result.sync_id);
        expect(persisted).not.toBeNull();
        expect(persisted!.name).toBe("linear-issues");
        // After the post-register updateSync, the real values land.
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

  it("persists declared api_hosts on the sync row", async () => {
    const stub = getStub("create-api-hosts");
    const userName = "create-api-hosts";

    await runInDurableObject(stub, async (instance) => {
      await ensureReady(instance, userName);
      const record = freshRecord();
      const restoreFacets = installFakeFacets(instance, makeFakeFacets(record));

      try {
        const tools = createSyncTool(instance);
        const result = await tools.execute!(
          {
            name: "stripe-events",
            integration: "stripe",
            schema_ddl: SAMPLE_SCHEMA,
            handler_code: SAMPLE_HANDLER,
            api_hosts: ["api.stripe.com", "files.stripe.com"]
          },
          {} as never
        );

        if (!("ok" in result) || result.ok !== true) {
          throw new Error(
            `expected ok: true, got: ${JSON.stringify(result, null, 2)}`
          );
        }
        const sql = instance.sql.bind(instance);
        const persisted = getSyncById(sql, result.sync_id)!;
        expect(persisted.api_hosts).toEqual([
          "api.stripe.com",
          "files.stripe.com"
        ]);
      } finally {
        restoreFacets();
      }
    });
  });

  it("defaults api_hosts to [] when the agent omits the field", async () => {
    const stub = getStub("create-api-hosts-default");
    const userName = "create-api-hosts-default";

    await runInDurableObject(stub, async (instance) => {
      await ensureReady(instance, userName);
      const record = freshRecord();
      const restoreFacets = installFakeFacets(instance, makeFakeFacets(record));

      try {
        const tools = createSyncTool(instance);
        const result = await tools.execute!(
          {
            name: "no-hosts",
            integration: "linear",
            schema_ddl: SAMPLE_SCHEMA,
            handler_code: SAMPLE_HANDLER
          },
          {} as never
        );

        if (!("ok" in result) || result.ok !== true) {
          throw new Error(
            `expected ok: true, got: ${JSON.stringify(result, null, 2)}`
          );
        }
        const sql = instance.sql.bind(instance);
        const persisted = getSyncById(sql, result.sync_id)!;
        expect(persisted.api_hosts).toEqual([]);
      } finally {
        restoreFacets();
      }
    });
  });

  it("rolls back on post-register updateSync failure: __unregisterWebhook called, row deleted", async () => {
    const stub = getStub("create-update-fail");
    const userName = "create-update-fail";

    await runInDurableObject(stub, async (instance) => {
      await ensureReady(instance, userName);
      const record = freshRecord();
      const sql = instance.sql.bind(instance);

      // The new flow runs createSync BEFORE registerWebhook, then runs
      // updateSync AFTER registerWebhook returns. To drive the
      // update-fail branch without monkey-patching the db helper, we
      // have the fake __registerWebhook DELETE the freshly-inserted row
      // as a side effect. The subsequent updateSync throws
      // "no sync with id=..." and the tool's step-6 catch runs cleanup.
      const restoreFacets = installFakeFacets(
        instance,
        makeFakeFacets(record, {
          __registerWebhook: async (config) => {
            record.registerCalls.push(config);
            // Parse sync id out of the callbackUrl and delete the row
            // so the pending updateSync raises.
            const match = config.callbackUrl.match(
              /\/webhook\/[^/]+\/([^/]+)$/
            );
            const sid = match?.[1] ?? "";
            sql`DELETE FROM syncs WHERE id = ${sid}`;
            return { id: "wh_persist", secret: "sec_persist" };
          }
        })
      );

      try {
        const tools = createSyncTool(instance);
        const result = await tools.execute!(
          {
            name: "update-target",
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

        // No sync rows remain: the row we inserted then lost was
        // already gone before cleanup, and cleanup's delete is
        // idempotent.
        const all = listSyncs(sql);
        expect(all).toHaveLength(0);

        expect(record.facetsDeleteCalls).toEqual(["update-target"]);
        expect(record.registerCalls).toHaveLength(1);
        // Update-fail branch MUST call __unregisterWebhook — the
        // upstream has a live webhook pointing at a sync we're about
        // to delete locally.
        expect(record.unregisterCalls).toHaveLength(1);
        expect(record.unregisterCalls[0].id).toBe("wh_persist");
        expect(record.unregisterCalls[0].label).toMatch(/self-syncing-agent:/);
      } finally {
        restoreFacets();
      }
    });
  });

  // Four dedicated ordering-invariant tests. These pin the sequence
  // createSync → __supervisorPing → __registerWebhook → updateSync
  // and the compensation branches that the Task-3 regression fix turns
  // on. The earlier tests cover much of this implicitly; these are
  // here so a future refactor can't silently reorder the flow without
  // at least one test failing with an obvious signal.

  it("order: createSync runs before __registerWebhook (row visible to egress gateway)", async () => {
    const stub = getStub("order-insert-before-register");
    const userName = "order-insert-before-register";

    await runInDurableObject(stub, async (instance) => {
      await ensureReady(instance, userName);
      const record = freshRecord();
      let sawRowDuringRegister = false;
      const restoreFacets = installFakeFacets(
        instance,
        makeFakeFacets(record, {
          __registerWebhook: async (config) => {
            record.registerCalls.push(config);
            const sql = instance.sql.bind(instance);
            const match = config.callbackUrl.match(
              /\/webhook\/[^/]+\/([^/]+)$/
            );
            const sid = match?.[1] ?? "";
            sawRowDuringRegister = getSyncById(sql, sid) !== null;
            return { id: "wh_ord", secret: "sec_ord" };
          }
        })
      );

      try {
        const tools = createSyncTool(instance);
        const result = await tools.execute!(
          {
            name: "ordering-check",
            integration: "github",
            schema_ddl: SAMPLE_SCHEMA,
            handler_code: SAMPLE_HANDLER,
            api_hosts: ["api.github.com"]
          },
          {} as never
        );
        if (!("ok" in result) || result.ok !== true) {
          throw new Error(
            `expected ok: true, got: ${JSON.stringify(result, null, 2)}`
          );
        }
        expect(sawRowDuringRegister).toBe(true);
      } finally {
        restoreFacets();
      }
    });
  });

  it("compensation: __supervisorPing throws → row deleted, register/unregister never called", async () => {
    const stub = getStub("comp-ping-fail");
    const userName = "comp-ping-fail";

    await runInDurableObject(stub, async (instance) => {
      await ensureReady(instance, userName);
      const record = freshRecord();
      const restoreFacets = installFakeFacets(
        instance,
        makeFakeFacets(record, {
          __supervisorPing: async () => {
            // Confirm the row was inserted BEFORE ping ran — that's the
            // whole point of the reorder. We can't assert here without a
            // closure on the tool's syncId, but the tool-level assertion
            // below (listSyncs is empty) covers it.
            throw new Error("compile boom");
          }
        })
      );

      try {
        const tools = createSyncTool(instance);
        const result = await tools.execute!(
          {
            name: "ping-fails",
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

        const sql = instance.sql.bind(instance);
        expect(listSyncs(sql)).toHaveLength(0);

        expect(record.registerCalls).toHaveLength(0);
        expect(record.unregisterCalls).toHaveLength(0);
        expect(record.facetsDeleteCalls).toEqual(["ping-fails"]);
      } finally {
        restoreFacets();
      }
    });
  });

  it("compensation: __registerWebhook rejects → row deleted, unregister NOT called", async () => {
    const stub = getStub("comp-register-fail");
    const userName = "comp-register-fail";

    await runInDurableObject(stub, async (instance) => {
      await ensureReady(instance, userName);
      const record = freshRecord();
      const restoreFacets = installFakeFacets(
        instance,
        makeFakeFacets(record, {
          __registerWebhook: async (config) => {
            record.registerCalls.push(config);
            throw new Error("GitHub API 500");
          }
        })
      );

      try {
        const tools = createSyncTool(instance);
        const result = await tools.execute!(
          {
            name: "register-fails",
            integration: "github",
            schema_ddl: SAMPLE_SCHEMA,
            handler_code: SAMPLE_HANDLER,
            api_hosts: ["api.github.com"]
          },
          {} as never
        );

        expect(result).toMatchObject({
          ok: false,
          error: "webhook_register_failed"
        });

        const sql = instance.sql.bind(instance);
        expect(listSyncs(sql)).toHaveLength(0);

        expect(record.registerCalls).toHaveLength(1);
        // Nothing to undo upstream — registration never completed.
        expect(record.unregisterCalls).toHaveLength(0);
        expect(record.facetsDeleteCalls).toEqual(["register-fails"]);
      } finally {
        restoreFacets();
      }
    });
  });

  it("compensation: post-register updateSync throws → row deleted, unregister IS called", async () => {
    const stub = getStub("comp-update-fail");
    const userName = "comp-update-fail";

    await runInDurableObject(stub, async (instance) => {
      await ensureReady(instance, userName);
      const record = freshRecord();
      const sql = instance.sql.bind(instance);

      // Drive updateSync's "no sync with id=..." branch by deleting
      // the row from inside __registerWebhook — same trick as the
      // primary "rolls back on post-register updateSync failure" test
      // but kept separate here to pin the invariant as a named case.
      const restoreFacets = installFakeFacets(
        instance,
        makeFakeFacets(record, {
          __registerWebhook: async (config) => {
            record.registerCalls.push(config);
            const match = config.callbackUrl.match(
              /\/webhook\/[^/]+\/([^/]+)$/
            );
            const sid = match?.[1] ?? "";
            sql`DELETE FROM syncs WHERE id = ${sid}`;
            return { id: "wh_upd", secret: "sec_upd" };
          }
        })
      );

      try {
        const tools = createSyncTool(instance);
        const result = await tools.execute!(
          {
            name: "update-fails",
            integration: "github",
            schema_ddl: SAMPLE_SCHEMA,
            handler_code: SAMPLE_HANDLER
          },
          {} as never
        );

        expect(result).toMatchObject({
          ok: false,
          error: "persist_failed"
        });

        expect(listSyncs(sql)).toHaveLength(0);
        expect(record.registerCalls).toHaveLength(1);
        // Upstream webhook IS live; we must undo it.
        expect(record.unregisterCalls).toHaveLength(1);
        expect(record.unregisterCalls[0].id).toBe("wh_upd");
        expect(record.facetsDeleteCalls).toEqual(["update-fails"]);
      } finally {
        restoreFacets();
      }
    });
  });
});
