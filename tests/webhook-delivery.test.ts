import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { createSync } from "../src/db/syncs";
import { listSyncErrors } from "../src/db/sync-errors";
import type { NewSync } from "../src/db/types";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const WEBHOOK_SECRET = "lin_wh_secret_abcdef";

async function hmacHex(body: Uint8Array, secret: string): Promise<string> {
  // Copy into a fresh Uint8Array<ArrayBuffer>. TextEncoder.encode() is
  // typed as Uint8Array<ArrayBufferLike> under some toolchain versions
  // (editor-side TS vs project tsc can diverge), but crypto.subtle.sign
  // strictly requires BufferSource = ArrayBufferView<ArrayBuffer>. The
  // copy is cheap and normalizes away the variance.
  const normalized = new Uint8Array(body);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, normalized);
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Helper: matches what an agent-authored Linear handler's verifySignature
// export would do. Kept in the test file so the production code stays
// free of any Linear-specific signature logic.
async function verifyLinearHmac(
  body: Uint8Array,
  headers: Record<string, string>,
  secret: string
): Promise<boolean> {
  const sig = headers["linear-signature"];
  if (!sig || sig.length === 0) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const normalizedBody = new Uint8Array(body);
  const computed = await crypto.subtle.sign("HMAC", key, normalizedBody);
  const hex = [...new Uint8Array(computed)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hex === sig;
}

interface FakeFacetStub {
  fetch: (req: Request) => Promise<Response>;
  __supervisorPing: () => Promise<void>;
  __verifySignature: (
    body: Uint8Array,
    headers: Record<string, string>,
    secret: string
  ) => Promise<boolean>;
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
            __supervisorPing: async () => {},
            __verifySignature: verifyLinearHmac
          };
        },
        abort: () => {},
        delete: () => {}
      });

      try {
        const res = await (
          instance as never as {
            handleWebhookDelivery: (
              userId: string,
              id: string,
              body: ArrayBuffer,
              headers: Record<string, string>
            ) => Promise<{ status: number; body: string }>;
          }
        ).handleWebhookDelivery(
          "wh-happy",
          syncId,
          body.buffer as ArrayBuffer,
          {
            "linear-signature": sig,
            "content-type": "application/json"
          }
        );
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
            userId: string,
            id: string,
            body: ArrayBuffer,
            headers: Record<string, string>
          ) => Promise<{ status: number; body: string }>;
        }
      ).handleWebhookDelivery(
        "wh-404",
        "00000000-0000-0000-0000-000000000000",
        body.buffer as ArrayBuffer,
        { "linear-signature": sig, "content-type": "application/json" }
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

      const restore = installFakeFacets(instance, {
        get() {
          return {
            fetch: async () => new Response("ok", { status: 200 }),
            __supervisorPing: async () => {},
            __verifySignature: verifyLinearHmac
          };
        },
        abort: () => {},
        delete: () => {}
      });

      try {
        const res = await (
          instance as never as {
            handleWebhookDelivery: (
              userId: string,
              id: string,
              body: ArrayBuffer,
              headers: Record<string, string>
            ) => Promise<{ status: number; body: string }>;
          }
        ).handleWebhookDelivery(
          "wh-nosig",
          syncId,
          body.buffer as ArrayBuffer,
          {}
        );
        expect(res.status).toBe(401);

        const sql = (
          instance as never as { sql: (...a: unknown[]) => unknown }
        ).sql.bind(instance) as never;
        const errors = listSyncErrors(sql, syncId, 10);
        expect(errors).toHaveLength(1);
        expect(errors[0].error_message).toBe(
          "signature verification rejected by handler"
        );
        expect(errors[0].handler_version).toBe(1);
      } finally {
        restore();
      }
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

      const restore = installFakeFacets(instance, {
        get() {
          return {
            fetch: async () => new Response("ok", { status: 200 }),
            __supervisorPing: async () => {},
            __verifySignature: verifyLinearHmac
          };
        },
        abort: () => {},
        delete: () => {}
      });

      try {
        const res = await (
          instance as never as {
            handleWebhookDelivery: (
              userId: string,
              id: string,
              body: ArrayBuffer,
              headers: Record<string, string>
            ) => Promise<{ status: number; body: string }>;
          }
        ).handleWebhookDelivery(
          "wh-badsig",
          syncId,
          body.buffer as ArrayBuffer,
          {
            "linear-signature": wrongSig,
            "content-type": "application/json"
          }
        );
        expect(res.status).toBe(401);

        const sql = (
          instance as never as { sql: (...a: unknown[]) => unknown }
        ).sql.bind(instance) as never;
        const errors = listSyncErrors(sql, syncId, 10);
        expect(errors).toHaveLength(1);
        expect(errors[0].error_message).toBe(
          "signature verification rejected by handler"
        );
        expect(errors[0].handler_version).toBe(1);
      } finally {
        restore();
      }
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
            __supervisorPing: async () => {},
            __verifySignature: verifyLinearHmac
          };
        },
        abort: () => {},
        delete: () => {}
      });

      try {
        const res = await (
          instance as never as {
            handleWebhookDelivery: (
              userId: string,
              id: string,
              body: ArrayBuffer,
              headers: Record<string, string>
            ) => Promise<{ status: number; body: string }>;
          }
        ).handleWebhookDelivery(
          "wh-throws",
          syncId,
          body.buffer as ArrayBuffer,
          { "linear-signature": sig, "content-type": "application/json" }
        );
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
            __supervisorPing: async () => {},
            __verifySignature: verifyLinearHmac
          };
        },
        abort: () => {},
        delete: () => {}
      });

      try {
        const res = await (
          instance as never as {
            handleWebhookDelivery: (
              userId: string,
              id: string,
              body: ArrayBuffer,
              headers: Record<string, string>
            ) => Promise<{ status: number; body: string }>;
          }
        ).handleWebhookDelivery(
          "wh-facet500",
          syncId,
          body.buffer as ArrayBuffer,
          { "linear-signature": sig, "content-type": "application/json" }
        );
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

describe("POST /webhook/:userId/:syncId (end-to-end)", () => {
  it("200s on a correctly-signed request and 401s on a bad signature", async () => {
    const userId = "e2e-route-user";
    const stub = env.ChatAgent.get(env.ChatAgent.idFromName(userId));

    // Seed a sync row and install a passthrough fake facets so the
    // request actually reaches facet.fetch via the route.
    let syncId = "";
    await runInDurableObject(stub, async (instance) => {
      await (
        instance as never as { setName: (n: string) => Promise<void> }
      ).setName(userId);
      syncId = seedSync(instance as never);
      installFakeFacets(instance, {
        get() {
          return {
            fetch: async () => new Response("ok", { status: 200 }),
            __supervisorPing: async () => {},
            __verifySignature: verifyLinearHmac
          };
        },
        abort: () => {},
        delete: () => {}
      });
    });

    const body = new TextEncoder().encode('{"action":"create"}');
    const sig = await hmacHex(body, WEBHOOK_SECRET);

    const good = await SELF.fetch(`http://self/webhook/${userId}/${syncId}`, {
      method: "POST",
      headers: { "linear-signature": sig, "content-type": "application/json" },
      body
    });
    expect(good.status).toBe(200);

    const bad = await SELF.fetch(`http://self/webhook/${userId}/${syncId}`, {
      method: "POST",
      headers: {
        "linear-signature": "ab".repeat(32),
        "content-type": "application/json"
      },
      body
    });
    expect(bad.status).toBe(401);
  });

  it("405s on GET /webhook/:userId/:syncId", async () => {
    const res = await SELF.fetch("http://self/webhook/u/s", { method: "GET" });
    expect(res.status).toBe(405);
  });
});
