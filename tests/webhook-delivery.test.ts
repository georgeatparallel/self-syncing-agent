import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { createSync } from "../src/db/syncs";
import { listSyncErrors } from "../src/db/sync-errors";
import type { NewSync } from "../src/db/types";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const WEBHOOK_SECRET = "lin_wh_secret_abcdef";

async function hmacHex(
  body: Uint8Array<ArrayBuffer>,
  secret: string
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, body);
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

interface FakeFacetStub {
  fetch: (req: Request) => Promise<Response>;
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

function seedSync(
  instance: { sql: (...a: unknown[]) => unknown },
  overrides: Partial<NewSync> = {}
): string {
  const sql = instance.sql.bind(instance) as never;
  const id = crypto.randomUUID();
  const input: NewSync = {
    id,
    name: overrides.name ?? "linear-issues",
    integration: "linear",
    handler_code:
      "export async function handleWebhook(){ return new Response('ok'); }",
    schema_ddl: "CREATE TABLE IF NOT EXISTS x (id TEXT);",
    filter_description: null,
    webhook_secret: WEBHOOK_SECRET,
    upstream_webhook_id: "wh_test",
    code_id: `sync:${id}:v1`,
    ...overrides
  };
  createSync(sql, input);
  return id;
}

describe("handleWebhookDelivery", () => {
  it("delivers a signed webhook: 200 + facet.fetch called with raw body", async () => {
    const stub = env.ChatAgent.get(env.ChatAgent.idFromName("wh-happy"));
    await runInDurableObject(stub, async (instance) => {
      await (
        instance as never as { setName: (n: string) => Promise<void> }
      ).setName("wh-happy");
      const syncId = seedSync(instance as never);
      const body = new TextEncoder().encode(
        '{"action":"create","type":"Issue"}'
      );
      const sig = await hmacHex(body, WEBHOOK_SECRET);

      const received: Uint8Array[] = [];
      const restore = installFakeFacets(instance, {
        get() {
          return {
            fetch: async (req) => {
              received.push(new Uint8Array(await req.arrayBuffer()));
              return new Response("ok", { status: 200 });
            },
            __supervisorPing: async () => {}
          };
        },
        abort: () => {},
        delete: () => {}
      });

      try {
        const res = await (
          instance as never as {
            handleWebhookDelivery: (
              id: string,
              body: ArrayBuffer,
              sig: string | null
            ) => Promise<{ status: number; body: string }>;
          }
        ).handleWebhookDelivery(syncId, body.buffer as ArrayBuffer, sig);
        expect(res.status).toBe(200);
        expect(received).toHaveLength(1);
        expect(new TextDecoder().decode(received[0])).toBe(
          '{"action":"create","type":"Issue"}'
        );
      } finally {
        restore();
      }
    });
  });

  it("returns 404 when the sync_id does not match any row", async () => {
    const stub = env.ChatAgent.get(env.ChatAgent.idFromName("wh-404"));
    await runInDurableObject(stub, async (instance) => {
      await (
        instance as never as { setName: (n: string) => Promise<void> }
      ).setName("wh-404");
      const body = new TextEncoder().encode("{}");
      const sig = await hmacHex(body, WEBHOOK_SECRET);
      const res = await (
        instance as never as {
          handleWebhookDelivery: (
            id: string,
            body: ArrayBuffer,
            sig: string | null
          ) => Promise<{ status: number; body: string }>;
        }
      ).handleWebhookDelivery(
        "00000000-0000-0000-0000-000000000000",
        body.buffer as ArrayBuffer,
        sig
      );
      expect(res.status).toBe(404);
    });
  });

  it("returns 401 when the signature header is missing", async () => {
    const stub = env.ChatAgent.get(env.ChatAgent.idFromName("wh-nosig"));
    await runInDurableObject(stub, async (instance) => {
      await (
        instance as never as { setName: (n: string) => Promise<void> }
      ).setName("wh-nosig");
      const syncId = seedSync(instance as never);
      const body = new TextEncoder().encode("{}");
      const res = await (
        instance as never as {
          handleWebhookDelivery: (
            id: string,
            body: ArrayBuffer,
            sig: string | null
          ) => Promise<{ status: number; body: string }>;
        }
      ).handleWebhookDelivery(syncId, body.buffer as ArrayBuffer, null);
      expect(res.status).toBe(401);
    });
  });

  it("returns 401 when the signature does not match the body", async () => {
    const stub = env.ChatAgent.get(env.ChatAgent.idFromName("wh-badsig"));
    await runInDurableObject(stub, async (instance) => {
      await (
        instance as never as { setName: (n: string) => Promise<void> }
      ).setName("wh-badsig");
      const syncId = seedSync(instance as never);
      const body = new TextEncoder().encode("{}");
      const wrongSig = await hmacHex(
        new TextEncoder().encode("other"),
        WEBHOOK_SECRET
      );
      const res = await (
        instance as never as {
          handleWebhookDelivery: (
            id: string,
            body: ArrayBuffer,
            sig: string | null
          ) => Promise<{ status: number; body: string }>;
        }
      ).handleWebhookDelivery(syncId, body.buffer as ArrayBuffer, wrongSig);
      expect(res.status).toBe(401);
    });
  });

  it("returns 5xx and writes a sync_errors row when the facet throws", async () => {
    const stub = env.ChatAgent.get(env.ChatAgent.idFromName("wh-throws"));
    await runInDurableObject(stub, async (instance) => {
      await (
        instance as never as { setName: (n: string) => Promise<void> }
      ).setName("wh-throws");
      const syncId = seedSync(instance as never);
      const body = new TextEncoder().encode('{"boom":true}');
      const sig = await hmacHex(body, WEBHOOK_SECRET);

      const restore = installFakeFacets(instance, {
        get() {
          return {
            fetch: async () => {
              throw new Error("kaboom: cannot read undefined.team");
            },
            __supervisorPing: async () => {}
          };
        },
        abort: () => {},
        delete: () => {}
      });

      try {
        const res = await (
          instance as never as {
            handleWebhookDelivery: (
              id: string,
              body: ArrayBuffer,
              sig: string | null
            ) => Promise<{ status: number; body: string }>;
          }
        ).handleWebhookDelivery(syncId, body.buffer as ArrayBuffer, sig);
        expect(res.status).toBe(500);

        const sql = (
          instance as never as { sql: (...a: unknown[]) => unknown }
        ).sql.bind(instance) as never;
        const errors = listSyncErrors(sql, syncId, 10);
        expect(errors).toHaveLength(1);
        expect(errors[0].error_message).toMatch(/kaboom/);
        expect(errors[0].payload_preview).toContain('"boom":true');
        expect(errors[0].handler_version).toBe(1);
      } finally {
        restore();
      }
    });
  });

  it("returns 5xx and logs an error when the facet responds with 500", async () => {
    const stub = env.ChatAgent.get(env.ChatAgent.idFromName("wh-facet500"));
    await runInDurableObject(stub, async (instance) => {
      await (
        instance as never as { setName: (n: string) => Promise<void> }
      ).setName("wh-facet500");
      const syncId = seedSync(instance as never);
      const body = new TextEncoder().encode("{}");
      const sig = await hmacHex(body, WEBHOOK_SECRET);

      const restore = installFakeFacets(instance, {
        get() {
          return {
            fetch: async () => new Response("boom", { status: 500 }),
            __supervisorPing: async () => {}
          };
        },
        abort: () => {},
        delete: () => {}
      });

      try {
        const res = await (
          instance as never as {
            handleWebhookDelivery: (
              id: string,
              body: ArrayBuffer,
              sig: string | null
            ) => Promise<{ status: number; body: string }>;
          }
        ).handleWebhookDelivery(syncId, body.buffer as ArrayBuffer, sig);
        expect(res.status).toBe(500);
        const sql = (
          instance as never as { sql: (...a: unknown[]) => unknown }
        ).sql.bind(instance) as never;
        const rows = listSyncErrors(sql, syncId, 10);
        expect(rows).toHaveLength(1);
        expect(rows[0].error_message).toBe("facet returned 500");
      } finally {
        restore();
      }
    });
  });
});
