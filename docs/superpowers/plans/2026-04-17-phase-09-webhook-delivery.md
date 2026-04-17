# Phase 09: Webhook Delivery Route Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the steady-state webhook delivery path — Linear POSTs to `/webhook/:userId/:syncId`, the supervisor verifies the HMAC signature against the stored per-sync secret, dispatches the validated request to the agent-authored facet, and logs any handler failure to `sync_errors` while returning 5xx so Linear retries.

**Architecture:** Introduce Hono (already a direct dependency, currently unused) as the top-level HTTP router in `src/server.ts`. Hono matches `POST /webhook/:userId/:syncId` explicitly, rejects other methods on that path with 405, and falls through everything else to `routeAgentRequest` via an `app.all("*", ...)` catch-all so chat / MCP / WebSocket upgrade keep working. The webhook handler resolves the supervisor DO by `userId`, reads the raw body bytes + `Linear-Signature` header, and calls a new RPC method on `ChatAgent` — `handleWebhookDelivery(syncId, bodyBytes, signatureHex)` — which: (1) looks up the sync row by id, (2) verifies the HMAC-SHA256 of `bodyBytes` keyed by `sync.webhook_secret`, (3) calls `attachFacet` + `facet.fetch(reconstructedRequest)`, and (4) catches exceptions / non-2xx into `logSyncError`. The RPC returns a plain `{ status, body }` structure so the router can build the final `Response`; this keeps `Response` objects out of the RPC channel (simpler contract, easier to type). `webhook_secret` never leaves the supervisor.

**Tech Stack:** Cloudflare Workers (`crypto.subtle` for HMAC-SHA256 verification), Durable Objects RPC, existing `attachFacet` / `logSyncError` / `getSyncById` helpers, vitest-pool-workers for integration tests with the same `installFakeFacets` shim pattern used in Phase 08.

---

### Task 1: HMAC-SHA256 signature verifier

One pure-function module that takes the raw body bytes, the hex-encoded Linear-Signature header value, and the per-sync secret. Returns true/false. No fetch, no DO, no side effects — unit-testable in the plain vitest environment via a dedicated test file.

**Files:**

- Create: `src/webhook/hmac.ts`
- Create: `src/webhook/hmac.test.ts`

**Notes:**

- Linear signs the raw request body with HMAC-SHA256 keyed by the webhook secret returned on `webhookCreate`. The signature is sent in the `Linear-Signature` request header, lowercase-hex-encoded.
- Use `crypto.subtle.importKey` + `crypto.subtle.verify`. Both are available in Workers without imports.
- Compare as bytes via `subtle.verify`, not via string compare — avoids timing-leak temptation.
- Return `false` on malformed hex / wrong length rather than throwing, so the caller has one code path (invalid → 401).

- [ ] **Step 1: Write the failing test file**

```ts
// src/webhook/hmac.test.ts
import { describe, it, expect } from "vitest";
import { verifyLinearSignature } from "./hmac";

const SECRET = "test-secret";
const BODY = new TextEncoder().encode('{"hello":"world"}');

async function sign(bodyBytes: Uint8Array, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, bodyBytes);
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

describe("verifyLinearSignature", () => {
  it("returns true for a correctly-signed body", async () => {
    const sig = await sign(BODY, SECRET);
    expect(await verifyLinearSignature(BODY, sig, SECRET)).toBe(true);
  });

  it("returns false when the signature was produced with a different secret", async () => {
    const sig = await sign(BODY, "different-secret");
    expect(await verifyLinearSignature(BODY, sig, SECRET)).toBe(false);
  });

  it("returns false when the body has been tampered with", async () => {
    const sig = await sign(BODY, SECRET);
    const tampered = new TextEncoder().encode('{"hello":"world!"}');
    expect(await verifyLinearSignature(tampered, sig, SECRET)).toBe(false);
  });

  it("returns false for malformed hex (odd length)", async () => {
    expect(await verifyLinearSignature(BODY, "abc", SECRET)).toBe(false);
  });

  it("returns false for hex with non-hex characters", async () => {
    expect(
      await verifyLinearSignature(BODY, "zz" + "00".repeat(31), SECRET)
    ).toBe(false);
  });

  it("returns false for an empty signature string", async () => {
    expect(await verifyLinearSignature(BODY, "", SECRET)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `pnpm exec vitest run src/webhook/hmac.test.ts`
Expected: FAIL — `Cannot find module './hmac'`.

- [ ] **Step 3: Implement `verifyLinearSignature`**

```ts
// src/webhook/hmac.ts
/**
 * Verify a Linear webhook signature. Linear computes HMAC-SHA256 over
 * the raw request body with the per-webhook secret returned from
 * `webhookCreate` and ships the result as lowercase hex in the
 * `Linear-Signature` header.
 *
 * Returns false (never throws) on: wrong signature, tampered body,
 * malformed hex, empty header. One code path for the caller — invalid
 * means 401.
 */
export async function verifyLinearSignature(
  bodyBytes: Uint8Array,
  signatureHex: string,
  secret: string
): Promise<boolean> {
  const signatureBytes = hexToBytes(signatureHex);
  if (!signatureBytes) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );

  try {
    return await crypto.subtle.verify("HMAC", key, signatureBytes, bodyBytes);
  } catch {
    // subtle.verify only throws on programmer errors (wrong algorithm,
    // wrong key usage). Bucket those into "invalid" so the route still
    // returns a clean 401 instead of a 500.
    return false;
  }
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) return null;
    out[i] = byte;
  }
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run src/webhook/hmac.test.ts`
Expected: PASS — 6/6 green.

- [ ] **Step 5: Commit**

```bash
git add src/webhook/hmac.ts src/webhook/hmac.test.ts
git commit -m "Phase 09: HMAC-SHA256 verifier for Linear webhook signatures"
```

---

### Task 2: `handleWebhookDelivery` RPC method on `ChatAgent`

Add an RPC method that does the end-to-end work inside the supervisor DO: sync lookup, signature verification, facet dispatch, error capture. Returns a structured result — the top-level router builds the final `Response` so we don't have to put `Response` objects on the RPC wire.

**Files:**

- Modify: `src/server.ts` — add `handleWebhookDelivery` method on `ChatAgent`
- Create: `tests/webhook-delivery.test.ts`

**Notes:**

- Method signature: `async handleWebhookDelivery(syncId: string, bodyBytes: ArrayBuffer, signatureHex: string | null): Promise<{ status: number; body: string }>`.
- ArrayBuffer (not Uint8Array) over the wire because Workers RPC serializes `ArrayBuffer` cleanly; wrap it in `new Uint8Array(bodyBytes)` inside the method.
- On sync-not-found → `{ status: 404, body: "sync not found" }`.
- On missing or invalid signature → `{ status: 401, body: "invalid signature" }`. Do not leak WHY to the caller (Linear) — bad sig and missing header look the same.
- On facet dispatch success (2xx from `facet.fetch`) → `{ status: 200, body: "ok" }`. We don't propagate the facet's own body because Linear ignores it, and hiding it keeps the supervisor/facet contract one-way.
- On facet throw → `logSyncError`, return `{ status: 500, body: "handler failed" }`. Linear retries 5xx per its schedule (1min / 1hr / 6hr).
- On facet returning 5xx → same path: `logSyncError` with `error_message = "facet returned ${status}"`, return 5xx. (Facet returning 4xx means it processed and decided to drop — return 200 to Linear so it doesn't retry, no error row.)
- Payload preview: first 2KB of the body decoded as UTF-8 (lossy fine), stored in `sync_errors.payload_preview`.
- Reconstruct the `Request` for the facet: `new Request("https://facet.internal/webhook", { method: "POST", body: bodyBytes, headers: { "content-type": "application/json" } })` — agent handlers only care about `request.json()`.

- [ ] **Step 1: Write the failing integration test**

```ts
// tests/webhook-delivery.test.ts
import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { createSync } from "../src/db/syncs";
import { listSyncErrors } from "../src/db/sync-errors";
import type { NewSync } from "../src/db/types";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const WEBHOOK_SECRET = "lin_wh_secret_abcdef";

async function hmacHex(body: Uint8Array, secret: string): Promise<string> {
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
        expect(listSyncErrors(sql, syncId, 10)).toHaveLength(1);
      } finally {
        restore();
      }
    });
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `pnpm exec vitest run tests/webhook-delivery.test.ts`
Expected: FAIL — `handleWebhookDelivery is not a function`.

- [ ] **Step 3: Implement the RPC method on `ChatAgent`**

Add to `src/server.ts` inside the `ChatAgent` class (after `onStart`, before the `@callable` MCP methods):

```ts
import { getSyncById } from "./db/syncs";
import { logSyncError } from "./db/sync-errors";
import { attachFacet } from "./facet/loader";
import { verifyLinearSignature } from "./webhook/hmac";

// inside class ChatAgent:
async handleWebhookDelivery(
  syncId: string,
  bodyBytes: ArrayBuffer,
  signatureHex: string | null
): Promise<{ status: number; body: string }> {
  const sql = this.sql.bind(this);
  const sync = getSyncById(sql, syncId);
  if (!sync) return { status: 404, body: "sync not found" };

  const body = new Uint8Array(bodyBytes);
  if (
    !signatureHex ||
    !(await verifyLinearSignature(body, signatureHex, sync.webhook_secret))
  ) {
    return { status: 401, body: "invalid signature" };
  }

  const userId = this.name;
  const facet = attachFacet(this.env, this.ctx.facets, sync, userId);

  // Rebuild a minimal Request for the facet. Agent handlers read the
  // body via request.json(); headers beyond content-type are not part
  // of the documented handler contract.
  const facetRequest = new Request("https://facet.internal/webhook", {
    method: "POST",
    body: body,
    headers: { "content-type": "application/json" }
  });

  try {
    const facetResponse = await facet.fetch(facetRequest);
    if (facetResponse.status >= 500) {
      logSyncError(sql, {
        sync_id: sync.id,
        payload_preview: payloadPreview(body),
        error_message: `facet returned ${facetResponse.status}`,
        stack_trace: null,
        handler_version: sync.version
      });
      return { status: 500, body: "handler failed" };
    }
    // 2xx or 4xx from the handler both mean "processed" from Linear's
    // point of view — the handler intentionally returning 4xx is its
    // way of saying "I saw this and dropped it". Either way, we tell
    // Linear 200 so it doesn't retry.
    return { status: 200, body: "ok" };
  } catch (e) {
    logSyncError(sql, {
      sync_id: sync.id,
      payload_preview: payloadPreview(body),
      error_message: e instanceof Error ? e.message : String(e),
      stack_trace: e instanceof Error ? (e.stack ?? null) : null,
      handler_version: sync.version
    });
    return { status: 500, body: "handler failed" };
  }
}
```

And add this helper below the class (same file):

```ts
/**
 * First ~2KB of the raw webhook body, decoded as UTF-8. Stored on
 * sync_errors rows so the agent can look at what actually arrived
 * without re-asking Linear. Truncated hard at 2048 bytes; no attempt
 * to avoid splitting a UTF-8 codepoint because lossy previews are
 * fine for human debugging.
 */
const PAYLOAD_PREVIEW_MAX_BYTES = 2048;
function payloadPreview(body: Uint8Array): string {
  const slice = body.subarray(0, PAYLOAD_PREVIEW_MAX_BYTES);
  return new TextDecoder("utf-8", { fatal: false }).decode(slice);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run tests/webhook-delivery.test.ts`
Expected: PASS — 6/6 green.

- [ ] **Step 5: Run the full check suite**

Run: `pnpm run check`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/server.ts tests/webhook-delivery.test.ts
git commit -m "Phase 09: handleWebhookDelivery RPC method with sig verify + error capture"
```

---

### Task 3: Top-level route guard in `src/server.ts`

The final piece — wire the incoming `POST /webhook/:userId/:syncId` HTTP request to the RPC method by resolving the user's supervisor DO stub.

**Files:**

- Modify: `src/server.ts` — extend `export default { fetch }` with a guard before `routeAgentRequest`
- Modify: `wrangler.jsonc` — add `/webhook/*` to `assets.run_worker_first` for explicit routing intent

**Notes:**

- URL-shape match: `/webhook/:userId/:syncId`. Use `URL.pathname.split("/")` — no framework needed for a single route.
- Method check: require `POST`; anything else gets 405 so misconfigured tunnels fail loudly.
- Resolve supervisor DO: `env.ChatAgent.idFromName(userId)`. The typed stub already supports direct RPC calls thanks to `DurableObjectNamespace<ChatAgent>` in `env.d.ts`.
- Header is case-insensitive but Cloudflare normalizes to lowercase: `request.headers.get("linear-signature")`.
- Read body as `ArrayBuffer` (not `text()`) so we pass raw bytes through; HMAC verify uses bytes.

- [ ] **Step 1: Write the failing end-to-end HTTP test**

First, change the `cloudflare:test` import at the top of `tests/webhook-delivery.test.ts` (added in Task 2) to also pull in `SELF`:

```ts
import { env, runInDurableObject, SELF } from "cloudflare:test";
```

Do NOT add a duplicate `import { createSync } from "../src/db/syncs"` — it's already imported in the Task 2 test file header.

Then append a new `describe` block to the same file:

```ts
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
            __supervisorPing: async () => {}
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
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `pnpm exec vitest run tests/webhook-delivery.test.ts`
Expected: FAIL — route doesn't exist yet, hits the 404 fallthrough.

- [ ] **Step 3: Add the route guard using Hono**

Hono is already a direct dependency (`package.json`) but not currently used anywhere. Phase 09 is a natural place to introduce it — we get typed params, built-in method dispatch, and a clean composition pattern for new routes later.

Replace the `export default` block in `src/server.ts`. Also add the Hono import at the top of the file alongside the existing imports:

```ts
import { Hono } from "hono";
```

Then, at the bottom:

```ts
/**
 * HTTP router. /webhook/:userId/:syncId is handled directly; everything
 * else falls through to the Agents SDK (chat, MCP, WebSocket upgrade).
 * Keeping Agents SDK as the catch-all (rather than mounting it under a
 * prefix) matches the default template we started from.
 */
const app = new Hono<{ Bindings: Env }>();

app.post("/webhook/:userId/:syncId", async (c) => {
  const { userId, syncId } = c.req.param();
  const stub = c.env.ChatAgent.get(c.env.ChatAgent.idFromName(userId));
  const bodyBytes = await c.req.arrayBuffer();
  const signatureHex = c.req.header("linear-signature") ?? null;
  const result = await stub.handleWebhookDelivery(
    syncId,
    bodyBytes,
    signatureHex
  );
  // `new Response` instead of `c.text(body, status)` because Hono's
  // helpers type `status` as its `StatusCode` union — our RPC return
  // is a plain `number`, and widening the cast at every return site
  // is noisier than constructing the Response directly.
  return new Response(result.body, { status: result.status });
});

// Any non-POST method on the webhook path → 405. Hono evaluates route
// registrations in order, so this `.all(...)` only fires when the more
// specific `.post(...)` above has already rejected the method.
app.all("/webhook/:userId/:syncId", (c) => c.text("method not allowed", 405));

// Fallthrough: everything else (chat WebSocket upgrade, MCP, etc.)
// goes to the Agents SDK router.
app.all("*", async (c) => {
  const res = await routeAgentRequest(c.req.raw, c.env);
  return res ?? c.text("Not found", 404);
});

export default {
  fetch: app.fetch
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 4: Add `/webhook/*` to `run_worker_first` in `wrangler.jsonc`**

```jsonc
"assets": {
  "directory": "./public",
  "not_found_handling": "single-page-application",
  "run_worker_first": ["/agents/*", "/oauth/*", "/webhook/*"]
},
```

The fallthrough behavior would likely do the right thing already (no static asset matches `/webhook/...`), but explicit intent beats inherited behavior — `not_found_handling: "single-page-application"` would otherwise serve `index.html` for unknown paths before the worker sees them.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm exec vitest run tests/webhook-delivery.test.ts`
Expected: PASS — all 8 tests green (6 RPC + 2 HTTP route).

- [ ] **Step 6: Run the full check suite**

Run: `pnpm run check`
Expected: exit 0, every test file passing.

- [ ] **Step 7: Commit**

```bash
git add src/server.ts wrangler.jsonc tests/webhook-delivery.test.ts
git commit -m "Phase 09: top-level /webhook/:userId/:syncId route guard"
```

---

### Task 4: Manual smoke against real Linear (no test code)

With the worker running behind the public tunnel you already use for `create_sync`, verify an actual Linear event populates the facet's SQLite.

**Files:** None (manual verification step).

- [ ] **Step 1: Start the dev server with the public tunnel**

```bash
pnpm run dev
# separate pane
cloudflared tunnel --url http://localhost:5173
```

Update `PUBLIC_BASE_URL` in `.dev.vars` to the tunnel URL, restart dev.

- [ ] **Step 2: Ask the agent to create a sync**

In chat: "Create a sync that captures Linear issues with priority High or Medium". Approve the drafted `create_sync` call. Confirm `ok: true` comes back.

- [ ] **Step 3: Trigger an event in Linear**

Create a new issue in the workspace. Set priority to High. Save.

- [ ] **Step 4: Verify via the chat agent**

Ask: "How many issues are captured so far?" — the agent should call `list_syncs` + `get_sync` to confirm the sync is live; if `run_in_sync` has not landed yet, the agent should at least not report `<sync_errors>` in the ambient context. Absence of error rows = webhook round-tripped successfully.

Look at the dev-server terminal for the incoming `POST /webhook/:userId/:syncId` log line from wrangler.

- [ ] **Step 5: Force a failure to validate error capture**

Ask the agent to create a second sync whose handler intentionally does `data.doesNotExist.crash` (easiest to instruct: "write a sync that throws if any issue has no assignee — make it crash rather than return 200 so I can see sync_errors populate"). Trigger an issue. Confirm the ambient `<sync_errors>` block surfaces the failure in the next turn.

- [ ] **Step 6: Commit only if fixes were needed**

No code changes expected here; this task is verification. If smoke turned up bugs, they get their own commits with `fix:` prefixes.

---

## Out of Scope for Phase 09

- `update_sync` / `delete_sync` / `run_in_sync` — Phase 10.
- Webhook-level rate limiting / dedup cache — not required for V1; Linear retries on 5xx are bounded (max 3 attempts) and the handler contract already demands idempotency via `INSERT OR REPLACE` / `ON CONFLICT`.
- Redacting PII from `payload_preview` — acceptable tradeoff for V1 since the preview is only visible to the sync's own user.
- Webhook signature verification for integrations other than Linear — `verifyLinearSignature` is Linear-specific by design; V2 (Pipedream) will replace this layer entirely.
