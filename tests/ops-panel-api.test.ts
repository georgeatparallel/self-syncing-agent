import { env, SELF, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { createSync } from "../src/db/syncs";
import { logSyncError } from "../src/db/sync-errors";
import type { NewSync, SqlTag } from "../src/db/types";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

function seedSync(instance: unknown, overrides: Partial<NewSync> = {}): string {
  const sql = (instance as { sql: SqlTag }).sql.bind(instance) as SqlTag;
  const id = overrides.id ?? crypto.randomUUID();
  const input: NewSync = {
    id,
    name: overrides.name ?? `sync-${id.slice(0, 8)}`,
    integration: overrides.integration ?? "linear",
    handler_code:
      overrides.handler_code ??
      "export async function handleWebhook(){ return new Response('ok'); }",
    schema_ddl:
      overrides.schema_ddl ??
      "CREATE TABLE IF NOT EXISTS issues (id TEXT PRIMARY KEY);",
    filter_description: overrides.filter_description ?? null,
    webhook_secret: overrides.webhook_secret ?? "s",
    upstream_webhook_id: overrides.upstream_webhook_id ?? "wh_test_abc",
    code_id: overrides.code_id ?? `sync:${id}:v1`
  };
  createSync(sql, input);
  return id;
}

describe("ops panel API", () => {
  it("GET /api/user/:userId/syncs-summary returns empty array for a user with no syncs", async () => {
    const userId = `empty-${crypto.randomUUID()}`;
    const res = await SELF.fetch(
      `https://test.invalid/api/user/${userId}/syncs-summary`
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { syncs: unknown[] };
    expect(body.syncs).toEqual([]);
  });

  it("GET /syncs-summary returns syncs + error counts for a user with syncs and recent errors", async () => {
    const userId = `populated-${crypto.randomUUID()}`;
    const stub = env.ChatAgent.get(env.ChatAgent.idFromName(userId));
    let syncId: string;
    await runInDurableObject(stub, async (instance) => {
      await (
        instance as never as { setName: (n: string) => Promise<void> }
      ).setName(userId);
      syncId = seedSync(instance);
      const sql = (instance as { sql: SqlTag }).sql.bind(instance) as SqlTag;
      logSyncError(sql, {
        sync_id: syncId,
        payload_preview: "{}",
        error_message: "boom 1",
        stack_trace: null,
        handler_version: 1
      });
      logSyncError(sql, {
        sync_id: syncId,
        payload_preview: "{}",
        error_message: "boom 2",
        stack_trace: null,
        handler_version: 1
      });
    });

    const res = await SELF.fetch(
      `https://test.invalid/api/user/${userId}/syncs-summary`
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      syncs: Array<{
        id: string;
        name: string;
        version: number;
        error_count_1h: number;
      }>;
    };
    expect(body.syncs).toHaveLength(1);
    expect(body.syncs[0]!.id).toBe(syncId!);
    expect(body.syncs[0]!.version).toBe(1);
    expect(body.syncs[0]!.error_count_1h).toBe(2);
  });

  it("GET /syncs/:syncId/details returns 404 for unknown sync", async () => {
    const userId = `detail-404-${crypto.randomUUID()}`;
    const res = await SELF.fetch(
      `https://test.invalid/api/user/${userId}/syncs/00000000-0000-0000-0000-000000000000/details`
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_found");
  });

  it("GET /syncs/:syncId/details returns sync row + row counts + errors for a known sync", async () => {
    const userId = `detail-happy-${crypto.randomUUID()}`;
    const stub = env.ChatAgent.get(env.ChatAgent.idFromName(userId));
    let syncId: string;
    await runInDurableObject(stub, async (instance) => {
      await (
        instance as never as { setName: (n: string) => Promise<void> }
      ).setName(userId);
      syncId = seedSync(instance, {
        schema_ddl:
          "CREATE TABLE IF NOT EXISTS issues (id TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS comments (id TEXT);"
      });
      const sql = (instance as { sql: SqlTag }).sql.bind(instance) as SqlTag;
      logSyncError(sql, {
        sync_id: syncId,
        payload_preview: "{}",
        error_message: "previous failure",
        stack_trace: "Error: prev\n  at handler",
        handler_version: 1
      });

      // Install a fake facet that answers __query with deterministic counts
      // per table name. The details endpoint attaches the facet internally,
      // so we need the fake to be live when the endpoint fires.
      const ctx = (instance as { ctx: { facets?: unknown } }).ctx;
      (ctx as { facets: unknown }).facets = {
        get() {
          return {
            fetch: async () => new Response("ok"),
            __query: async (q: string) => {
              if (q.includes("FROM issues")) {
                return { ok: true, rows: [{ c: 7 }] };
              }
              if (q.includes("FROM comments")) {
                return { ok: true, rows: [{ c: 3 }] };
              }
              return { ok: true, rows: [{ c: 0 }] };
            },
            __supervisorPing: async () => {}
          };
        },
        abort: () => {},
        delete: () => {}
      };
    });

    const res = await SELF.fetch(
      `https://test.invalid/api/user/${userId}/syncs/${syncId!}/details`
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sync: { id: string; version: number };
      row_counts: Record<string, number>;
      errors: Array<{ error_message: string }>;
    };
    expect(body.sync.id).toBe(syncId!);
    expect(body.sync.version).toBe(1);
    expect(body.row_counts).toEqual({ issues: 7, comments: 3 });
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]!.error_message).toBe("previous failure");
  });
});
