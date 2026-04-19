# Phase C: Agent-Authored Signature Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move webhook signature verification out of the supervisor and into agent-authored handler code. After this phase, the supervisor knows nothing about any integration's signing scheme — each handler owns its own `verifySignature(body, headers, secret)` export. Removes the last piece of Linear-specific supervisor code from the webhook path and unblocks GitHub / Slack / Stripe / Notion webhooks without touching supervisor code.

**Architecture:**

- The facet wrapper (`FACET_WRAPPER_SOURCE`) gains one new RPC method: `__verifySignature(body, headers, secret) → boolean`. The method imports `handler.js` with `import * as` to pick up an optional `verifySignature` export, delegates to it if present, and returns `false` on any error or missing export (fail-closed).
- The handler contract gains a new **required** second export: `async function verifySignature(body, headers, secret): Promise<boolean>`. `body` is a `Uint8Array` of the raw request body; `headers` is a `Record<string, string>` with lowercased keys; `secret` is the stored `webhook_secret`. Returning `false` (or throwing) means 401.
- `handleWebhookDelivery` in `src/server.ts` stops calling `verifyLinearSignature`. New flow: attach facet first, call `facet.__verifySignature(body, headers, secret)`, 401 on false, else deliver the webhook. Attaching the facet before signature verification is intentional — the wrapper is tiny and Worker Loader caches the compiled module, so the cost of compiling-to-reject-invalid is a few ms once per facet lifetime.
- The Hono `/webhook/:userId/:syncId` route stops cherry-picking the `linear-signature` header. It forwards ALL request headers (lowercased) to `handleWebhookDelivery`.
- `src/webhook/hmac.ts` and its test file are deleted. The `verifyLinearSignature` import in `src/server.ts` is removed. One code path; zero per-integration supervisor code.
- The `create_sync` and `update_sync` tool descriptions are updated to teach the LLM about the `verifySignature` export — with a concrete Linear HMAC-SHA256-hex example in the tool description (the most common scheme; the agent can web-search for GitHub/Slack/Stripe variants when needed).
- Migration: the existing `linear-high-urgent-issues` sync's handler doesn't export `verifySignature` yet. After Phase C ships, the next real webhook returns 401 until the user asks the agent to `update_sync` with a new handler that includes the verifier. This is the intended migration path — the README will mention it.

**Tech Stack:** Cloudflare Workers Durable Object Facets, Worker Loader (dynamic ES module bundles), Web Crypto (`crypto.subtle.sign` / `.verify`), Vitest with `@cloudflare/vitest-pool-workers` (facet runtime itself is faked via the existing `installFakeFacets` helper — facets don't run inside vitest-pool-workers yet).

**Branch:** `feat/pipedream` (continuing from Phase B).

---

## File Structure

**New files:** none.

**Modified files:**

- `src/facet/wrapper.ts` — extend `FACET_WRAPPER_SOURCE` with `__verifySignature(body, headers, secret)` method and the `import * as handlerModule` line. Update top-of-file jsdoc to document the new required `verifySignature` export in the handler contract.
- `src/facet/bundle.test.ts` — add a regex assertion that the wrapper source contains `async __verifySignature(`.
- `src/server.ts` — `handleWebhookDelivery` signature changes: `signatureHex: string | null` → `headers: Record<string, string>`. Attach facet first, then call `facet.__verifySignature`. Remove `import { verifyLinearSignature } from "./webhook/hmac"`. Update the Hono `/webhook/:userId/:syncId` route to collect all headers and pass them through (no more `linear-signature` cherry-pick).
- `tests/webhook-delivery.test.ts` — update every call site of `handleWebhookDelivery` from `(userId, syncId, body, sig)` to `(userId, syncId, body, headers)`. Add a `__verifySignature` method to the `FakeFacetStub` shape; each test provides an impl (HMAC-check for happy-path, `async () => false` for 401-path). Update the `POST /webhook/:userId/:syncId (end-to-end)` test — the fake facet's `__verifySignature` now does the real signature check.
- `src/agent/tools/write/create-sync.ts` — tool description gains the `verifySignature` contract + a concrete Linear example. Mark the export as REQUIRED (fail-closed).
- `src/agent/tools/write/update-sync.ts` — tool description cross-references create_sync's contract; reminds the agent that any `update_sync` that changes `handler_code` must still include `verifySignature`.

**Deleted files:**

- `src/webhook/hmac.ts`
- `src/webhook/hmac.test.ts`

**No frontend changes.** Phase C is purely handler-contract + supervisor-side.

---

## Task 1: Wrapper `__verifySignature` RPC method

**Files:**

- Modify: `src/facet/wrapper.ts`
- Modify: `src/facet/bundle.test.ts`

**Context:** The facet wrapper is a fixed string that runs inside the user's isolated Worker Loader runtime. It currently imports `{ handleWebhook }` from `./handler.js` and forwards the fetch path to it. Phase C adds a second, optional export — `verifySignature` — and a new supervisor-only RPC method that delegates to it. The wrapper is the ONLY place in the codebase that loads handler.js, so the namespace-import change has to live here.

Two wrapper changes:

1. Add `import * as handlerModule from "./handler.js";` next to the existing `{ handleWebhook }` import — gives runtime access to every export, including optional ones.
2. Add the `async __verifySignature(body, headers, secret)` method on the `App` DurableObject class.

**Fail-closed rationale:** If the agent's handler doesn't export `verifySignature`, we return `false` (→ 401 from the supervisor). Rationale: signature verification is a security primitive — missing is a bug the agent must fix, not a silent-pass default. The README migration note tells users how to recover from this for legacy syncs.

**Error swallow rationale:** If `verifySignature` throws (bad header parse, malformed secret, whatever), we catch and return `false`. Supervisor's job is to turn every non-valid case into a clean 401; letting the exception bubble would make the webhook route return 500, which Linear/GitHub/etc. will retry forever — exactly wrong.

- [ ] **Step 1: Update the wrapper source**

In `src/facet/wrapper.ts`, replace the existing template-literal content. The full new `FACET_WRAPPER_SOURCE` and surrounding jsdoc:

```ts
/**
 * Fixed wrapper source for facet bundles. Composed into the Worker Loader
 * `modules` map at sync-creation time alongside a generated `schema.js`
 * and the agent-authored `handler.js`.
 *
 * The wrapper's supervisor-only responsibilities:
 *   - fetch delegate: run schema-init then call the agent's handleWebhook
 *   - schema init: #ensureSchema() applies SCHEMA_DDL once, lazily, shared
 *     by both fetch and __query/__sqlExec (a query_sync or run_in_sync may
 *     fire before any webhook has hit, so those paths also need to trigger
 *     init)
 *   - __supervisorPing(): no-op RPC that forces Worker Loader compilation
 *     at create_sync time without running the agent's handler
 *   - __query(sql): supervisor-only SQL read path. Catches SQLite errors
 *     and returns { ok, rows | error } so a bad agent-written query can't
 *     wedge the facet. Tool layer enforces SELECT/WITH-only; wrapper is
 *     power-not-policy. Double underscore discourages the agent from
 *     shadowing it in handler.js.
 *   - __sqlExec(sql, ...bindings): supervisor-only SQL write path used by
 *     run_in_sync's exec isolate. Accepts any statement (including DDL) —
 *     approval gating on the tool side is the trust boundary, not this
 *     method. Returns { ok: true, rowsWritten, rowsRead } | { ok: false,
 *     error }; drains the cursor so side effects commit.
 *   - __verifySignature(body, headers, secret): supervisor-only RPC that
 *     delegates webhook-signature verification to the handler's own
 *     verifySignature export. Signing schemes are per-integration (Linear
 *     HMAC-hex, GitHub sha256=-prefixed, Slack v0:ts:body, etc.) and live
 *     in agent-authored code, not here. Fail-closed: missing export or
 *     thrown error → false → supervisor returns 401.
 *
 * The agent's handler.js contract:
 *
 *   export async function handleWebhook(request, sql, ctx): Promise<Response>
 *     — called for every verified webhook. `sql` is this.ctx.storage.sql
 *       (call sql.exec(query, ...args) and sql.exec(query, ...args).toArray()
 *       for reads). The optional third `ctx` arg provides `{ agent, waitUntil }`:
 *       `agent` is a preconfigured subagent runner (built from this.env.LLM
 *       + an RpcTarget bridge to this facet's sql/fetch/userId) that the
 *       handler can invoke to process the webhook with an LLM; `waitUntil`
 *       forwards to this.ctx.waitUntil for background work.
 *
 *   export async function verifySignature(body, headers, secret): Promise<boolean>
 *     — REQUIRED. Called by the supervisor before handleWebhook. `body` is
 *       a Uint8Array of the raw request body; `headers` is a
 *       Record<string, string> with lowercased keys; `secret` is the
 *       webhook_secret stored at create_sync time. Return true to accept
 *       the delivery, false (or throw) to reject with 401. Missing export
 *       → supervisor returns 401 (fail-closed).
 */
export const FACET_WRAPPER_SOURCE = `
import { DurableObject, RpcTarget } from "cloudflare:workers";
import { SCHEMA_DDL } from "./schema.js";
import { handleWebhook } from "./handler.js";
import * as handlerModule from "./handler.js";
import { createAgent } from "./agent.js";

class FacetAgentBridge extends RpcTarget {
  #sql;
  #userId;
  constructor(deps) {
    super();
    this.#sql = deps.sql;
    this.#userId = deps.userId;
  }
  async sqlExec(query, ...bindings) {
    try {
      const cursor = this.#sql.exec(query, ...bindings);
      const rows = cursor.toArray();
      return { ok: true, rows, rowsWritten: cursor.rowsWritten, rowsRead: cursor.rowsRead };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
  async getUserId() {
    return this.#userId;
  }
}

export class App extends DurableObject {
  #schemaApplied = false;

  #ensureSchema() {
    if (this.#schemaApplied) return;
    for (const stmt of splitStatements(SCHEMA_DDL)) {
      if (stmt.trim()) this.ctx.storage.sql.exec(stmt);
    }
    this.#schemaApplied = true;
  }

  async fetch(request) {
    this.#ensureSchema();
    const bridge = new FacetAgentBridge({
      sql: this.ctx.storage.sql,
      userId: this.ctx.props ? this.ctx.props.userId : ""
    });
    const agent = createAgent({ llm: this.env.LLM, bridge });
    const ctx = {
      agent,
      waitUntil: (p) => this.ctx.waitUntil(p)
    };
    return handleWebhook(request, this.ctx.storage.sql, ctx);
  }

  async __supervisorPing() {}

  async __query(sql) {
    this.#ensureSchema();
    try {
      const rows = this.ctx.storage.sql.exec(sql).toArray();
      return { ok: true, rows };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async __sqlExec(sql, ...bindings) {
    this.#ensureSchema();
    try {
      const cursor = this.ctx.storage.sql.exec(sql, ...bindings);
      cursor.toArray();
      return {
        ok: true,
        rowsWritten: cursor.rowsWritten,
        rowsRead: cursor.rowsRead
      };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : String(e)
      };
    }
  }

  async __verifySignature(body, headers, secret) {
    if (typeof handlerModule.verifySignature !== "function") return false;
    try {
      const bodyBytes = body instanceof Uint8Array ? body : new Uint8Array(body);
      const result = await handlerModule.verifySignature(bodyBytes, headers, secret);
      return result === true;
    } catch (e) {
      return false;
    }
  }
}

function splitStatements(ddl) {
  return ddl.split(/;\\s*\\n/).map((s) => s.trim()).filter(Boolean);
}
`;
```

- [ ] **Step 2: Add regex assertion to bundle.test.ts**

Find the test block that already asserts `__query` and `__sqlExec` appear in the wrapper (around line 85 of `src/facet/bundle.test.ts`, test name "wrapper source exposes __query, __sqlExec, and #ensureSchema"). Rename the test and add two new assertions:

```ts
it("wrapper source exposes __query, __sqlExec, __verifySignature, and #ensureSchema", () => {
  const handlerCode = "export async function handleWebhook(){ return new Response('ok'); }";
  const bundle = buildFacetBundle({
    schemaDdl: "CREATE TABLE x (id TEXT);",
    handlerCode
  });
  const main = bundle.modules["main.js"];
  expect(main).toMatch(/async __query\(/);
  expect(main).toMatch(/async __sqlExec\(/);
  expect(main).toMatch(/async __verifySignature\(/);
  expect(main).toMatch(/import \* as handlerModule from "\.\/handler\.js"/);
});
```

- [ ] **Step 3: Run facet tests**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npx vitest run src/facet/bundle.test.ts`
Expected: PASS (all existing tests + the renamed/extended one).

- [ ] **Step 4: Run full typecheck**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/facet/wrapper.ts src/facet/bundle.test.ts
git commit -m "feat(facet): __verifySignature RPC delegates to handler export"
```

---

## Task 2: Delegate signature verification in `handleWebhookDelivery` + route

**Files:**

- Modify: `src/server.ts`
- Modify: `tests/webhook-delivery.test.ts`

**Context:** Supervisor's `handleWebhookDelivery` currently calls `verifyLinearSignature` directly. Replace that with an RPC to the facet's new `__verifySignature`. Also update the Hono route to pass ALL request headers through (lowercased keys) instead of just `linear-signature`.

### Signature change

Before:

```ts
async handleWebhookDelivery(
  userId: string,
  syncId: string,
  bodyBytes: ArrayBuffer,
  signatureHex: string | null
): Promise<{ status: number; body: string }> {
  // ...
  const body = new Uint8Array(bodyBytes);
  if (
    !signatureHex ||
    !(await verifyLinearSignature(body, signatureHex, sync.webhook_secret))
  ) {
    return { status: 401, body: "invalid signature" };
  }
  const facet = attachFacet(...);
  // ...
}
```

After:

```ts
async handleWebhookDelivery(
  userId: string,
  syncId: string,
  bodyBytes: ArrayBuffer,
  headers: Record<string, string>
): Promise<{ status: number; body: string }> {
  // ... (setName, ensureSchema, getSyncById unchanged)

  const body = new Uint8Array(bodyBytes);
  const facet = attachFacet(this.env, this.ctx.facets, sync, userId);

  // Signature verification is delegated to the handler's verifySignature
  // export via the facet wrapper's __verifySignature RPC. Missing export
  // or thrown error → false → 401. See src/facet/wrapper.ts for contract.
  const verifyResult = await (
    facet as unknown as {
      __verifySignature(
        body: Uint8Array,
        headers: Record<string, string>,
        secret: string
      ): Promise<boolean>;
    }
  ).__verifySignature(body, headers, sync.webhook_secret);
  if (!verifyResult) {
    return { status: 401, body: "invalid signature" };
  }

  // (facetRequest build, facet.fetch, error-logging, touchSyncUpdatedAt,
  //  bumpChangeTick — all unchanged from the current shape)
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
    touchSyncUpdatedAt(sql, sync.id);
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
  } finally {
    this.#bumpChangeTick();
  }
}
```

**Important ordering note:** the facet attach now happens before the signature check. This is a deliberate change. Rationale (worth adding as an inline comment):

```ts
// Attach the facet before the signature check — verifySignature lives
// inside handler.js and needs the facet isolate running. Worker Loader
// caches the compiled bundle, so invalid-signature deliveries pay the
// compilation cost once per facet lifetime (cheap), not per delivery.
```

### Remove the import

Delete the line at the top of `src/server.ts`:

```ts
import { verifyLinearSignature } from "./webhook/hmac";
```

### Update the Hono route

Before (around line 467):

```ts
app.post("/webhook/:userId/:syncId", async (c) => {
  const { userId, syncId } = c.req.param();
  const stub = c.env.ChatAgent.get(c.env.ChatAgent.idFromName(userId));
  const bodyBytes = await c.req.arrayBuffer();
  const signatureHex = c.req.header("linear-signature") ?? null;
  const result = await stub.handleWebhookDelivery(
    userId,
    syncId,
    bodyBytes,
    signatureHex
  );
  return new Response(result.body, { status: result.status });
});
```

After:

```ts
app.post("/webhook/:userId/:syncId", async (c) => {
  const { userId, syncId } = c.req.param();
  const stub = c.env.ChatAgent.get(c.env.ChatAgent.idFromName(userId));
  const bodyBytes = await c.req.arrayBuffer();
  // Pass all request headers through (lowercased keys) so the handler's
  // verifySignature export can read whatever header its upstream uses
  // (linear-signature, x-hub-signature-256, x-slack-signature, etc.).
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  const result = await stub.handleWebhookDelivery(
    userId,
    syncId,
    bodyBytes,
    headers
  );
  return new Response(result.body, { status: result.status });
});
```

### Update the tests

Every `handleWebhookDelivery(...)` call site in `tests/webhook-delivery.test.ts` changes. And every `FakeFacetStub` needs a `__verifySignature` method. Concretely:

**Extend `FakeFacetStub`:**

```ts
interface FakeFacetStub {
  fetch: (req: Request) => Promise<Response>;
  __supervisorPing: () => Promise<void>;
  __verifySignature: (
    body: Uint8Array,
    headers: Record<string, string>,
    secret: string
  ) => Promise<boolean>;
}
```

**Extract a reusable Linear-scheme verifier** to use inside each test that wants the happy path:

```ts
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
```

**Update each individual test** — call-site shape changes from:

```ts
.handleWebhookDelivery("wh-happy", syncId, body.buffer as ArrayBuffer, sig)
```

to:

```ts
.handleWebhookDelivery("wh-happy", syncId, body.buffer as ArrayBuffer, {
  "linear-signature": sig,
  "content-type": "application/json"
})
```

And the inline RPC type annotation changes from `sig: string | null` to `headers: Record<string, string>`.

**Each `installFakeFacets` call** adds the new method. For happy-path tests:

```ts
installFakeFacets(instance, {
  get() {
    return {
      fetch: async (req) => { /* ... */ },
      __supervisorPing: async () => {},
      __verifySignature: verifyLinearHmac  // real HMAC check against headers + secret
    };
  },
  abort: () => {},
  delete: () => {}
});
```

For the "returns 401 when signature does not match" test, swap to a fake that rejects:

```ts
__verifySignature: async () => false
```

Actually no — the existing "bad signature" tests already produce a bad HMAC (they sign a DIFFERENT body). If the fake's `__verifySignature` is `verifyLinearHmac`, it will correctly return false for the bad signature. Prefer using the real verifier in all tests; leaves only one code path exercised.

**The 401-nosig test** (no `linear-signature` header) currently passes `null`. New shape: pass an empty headers object `{}`. `verifyLinearHmac` reads `headers["linear-signature"]`, sees `undefined`, returns `false` → 401. Exactly the same behavior.

**The e2e route test** (`POST /webhook/:userId/:syncId`) already sends headers via `SELF.fetch`, so the route change forwards them naturally. The fake facet in that test uses `verifyLinearHmac` and the bad-sig case (`sig: "ab".repeat(32)`) fails the HMAC → 401. Update:

```ts
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
```

- [ ] **Step 1: Update `handleWebhookDelivery` + route in `src/server.ts`**

Apply the changes described above. Delete the `verifyLinearSignature` import.

- [ ] **Step 2: Update `tests/webhook-delivery.test.ts`**

Apply the changes described above: extend `FakeFacetStub`, add `verifyLinearHmac` helper, update every call site's arguments, update every `installFakeFacets` call to include `__verifySignature`.

- [ ] **Step 3: Run tests**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npx vitest run tests/webhook-delivery.test.ts`
Expected: PASS (all 8 tests: 6 direct RPC + 2 e2e route).

- [ ] **Step 4: Run full check**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npm run check`
Expected: fully green. (Except: `src/webhook/hmac.ts` is now dead code, not yet deleted. Typecheck still passes because the import was removed. The hmac.test.ts file still runs and still passes — it imports directly from `./hmac`, not through server.ts.)

- [ ] **Step 5: Commit**

```bash
git add src/server.ts tests/webhook-delivery.test.ts
git commit -m "feat(webhook): delegate signature verification to facet handler"
```

---

## Task 3: Teach the agent about `verifySignature` via tool descriptions

**Files:**

- Modify: `src/agent/tools/write/create-sync.ts`
- Modify: `src/agent/tools/write/update-sync.ts`

**Context:** The LLM reads tool descriptions before every call. For the agent to author a working handler after Phase C, the `create_sync` description must explain the new required export, show at least one concrete example, and note that `update_sync` calls that change `handler_code` must preserve it. A Linear HMAC-SHA256-hex example is enough for the common case; the agent can web-search for GitHub/Slack variants when needed (we already tell it to web-search for unfamiliar integrations).

### create-sync.ts

Update the tool description. The current text (lines 15–54 of `src/agent/tools/write/create-sync.ts`) describes `handleWebhook` in detail. Extend the `handler_code contract:` block to add the verifySignature requirement and example.

**The new tool description block** (replacing the existing one):

```ts
description: `Create a new sync. Registers a webhook with the upstream service, loads the agent-authored handler into an isolated facet runtime with its own SQLite, applies the schema DDL, and persists the sync registry row. Approval-gated — the user sees the drafted schema_ddl and handler_code in the approval dialog before anything runs. Call this AFTER you've shown the draft in chat.

handler_code contract: JavaScript module source that MUST export TWO async functions:

1) \`async function verifySignature(body, headers, secret): Promise<boolean>\`
   — Called by the supervisor BEFORE handleWebhook on every delivery.
   - \`body\` is a Uint8Array of the raw request body.
   - \`headers\` is a Record<string, string> with lowercased keys.
   - \`secret\` is the webhook_secret the upstream registration returned (stored for you, passed in at call time — never hardcode it).
   - Return true to accept the delivery, false (or throw) to reject it — the supervisor returns 401 on false / thrown.
   - REQUIRED. A missing export fails closed (supervisor returns 401 for every delivery), so every handler must own its signature verification. Each upstream signs differently: Linear uses HMAC-SHA256-hex in \`linear-signature\`; GitHub uses \`x-hub-signature-256: sha256=<hex>\`; Slack uses \`v0:<timestamp>:<body>\` signed with HMAC and shipped in \`x-slack-signature\` as \`v0=<hex>\`. Check the upstream's docs if unsure.

2) \`async function handleWebhook(request, sql, ctx): Promise<Response>\`
   — Called AFTER the signature has been verified.
   - \`request\` is the raw webhook POST.
   - \`sql\` is the facet's own SQLite. \`sql.exec(query, ...bindings)\` for inserts/updates; \`sql.exec(query, ...bindings).toArray()\` for reads.
   - \`ctx\` carries two capabilities:
     - \`ctx.waitUntil(promise)\` — keep background work alive past the 200 response. Use this so the webhook returns a fast 200 while enrichment runs afterwards.
     - \`ctx.agent({ model?, system, messages, maxSteps? })\` — spawn a sub-agent ReAct loop and get back a string. \`model\` is \`"haiku" | "sonnet" | "opus"\` (default \`"sonnet"\`). The sub-agent has three built-in tools: \`sql\` (reads + writes the facet's SQLite), \`fetch\` (upstream HTTP through the same credential-injecting proxy as the handler's own fetch), and \`exec\` (runs an agent-authored JS module in a fresh isolate). No nested \`ctx.agent()\` calls permitted.
   - Return a 2xx Response for successful processing (including "filtered out, nothing to write" — use 200). Return 5xx only if you want the upstream to retry.
   - Be idempotent. Upstreams may deliver the same event twice — use INSERT OR REPLACE or ON CONFLICT keyed on the resource's stable id from the payload.
   - Do not import anything beyond the parameters. \`fetch\` is globally available for upstream API calls (the proxy injects auth automatically); most write-path handlers don't need it.
   - Keep it fast. Upstream webhook timeouts are typically 5–30 seconds. If you need longer LLM reasoning, run it inside \`ctx.waitUntil(ctx.agent(...))\` so the 200 returns immediately and the sub-agent enriches the row in the background.

Example handler for Linear (HMAC-SHA256-hex signature scheme):
\`\`\`js
export async function verifySignature(body, headers, secret) {
  const sig = headers["linear-signature"];
  if (!sig) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const computed = await crypto.subtle.sign("HMAC", key, body);
  const hex = [...new Uint8Array(computed)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hex === sig;
}

export async function handleWebhook(request, sql, ctx) {
  const payload = await request.json();
  const id = payload.data.id;
  sql.exec(
    "INSERT OR REPLACE INTO issues (id, title, priority) VALUES (?, ?, ?)",
    id,
    payload.data.title,
    payload.data.priority
  );
  if (payload.data.priority === 1) {
    ctx.waitUntil(
      ctx.agent({
        model: "sonnet",
        system: "You are a Linear triage bot. Given an issue payload, write one sentence describing the likely root cause or next action.",
        messages: [{ role: "user", content: JSON.stringify(payload.data) }]
      }).then((note) =>
        sql.exec("UPDATE issues SET triage = ? WHERE id = ?", note, id)
      )
    );
  }
  return new Response("ok", { status: 200 });
}
\`\`\`

For unfamiliar integrations or resource types: use the probe loop (described in the system prompt) before drafting the real handler. Don't guess payload field names from training data. Likewise, don't guess signature schemes — check the upstream's webhook documentation for which header name, hashing algorithm, and encoding (hex vs base64, prefix, etc.) the upstream uses.`
```

**Also update the `handler_code` zod description** (a few lines below the main description):

```ts
handler_code: z
  .string()
  .describe(
    "JavaScript module source that exports `async function verifySignature(body, headers, secret)` AND `async function handleWebhook(request, sql, ctx)`. Both exports are required. See the tool description for the full contract and a Linear example."
  ),
```

### update-sync.ts

The update-sync description doesn't need to duplicate the contract — just a reminder that the verifier must be preserved across updates. Find the existing `handler_code` zod description (around line 49):

Before:

```ts
handler_code: z
  .string()
  .min(1)
  .optional()
  .describe(
    "New handler.js source. Must export `async function handleWebhook(request, sql, ctx)`. See create_sync's description for the full contract (ctx.agent, ctx.waitUntil, and the sub-agent primitive). Omit if handler isn't changing."
  ),
```

After:

```ts
handler_code: z
  .string()
  .min(1)
  .optional()
  .describe(
    "New handler.js source. Must export both `verifySignature(body, headers, secret)` AND `handleWebhook(request, sql, ctx)` — see create_sync's description for the full contract and example. An update_sync that drops either export will cause the next webhook delivery to fail (401 if verifySignature is missing, facet load failure if handleWebhook is missing). Omit if handler isn't changing."
  ),
```

- [ ] **Step 1: Update create-sync.ts**

Replace the `description` template literal and the `handler_code` zod description per above.

- [ ] **Step 2: Update update-sync.ts**

Replace the `handler_code` zod description per above.

- [ ] **Step 3: Run tool tests**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npx vitest run src/agent/tools/write/create-sync.test.ts src/agent/tools/write/update-sync.test.ts`
Expected: PASS (test assertions are behavior-based, not description-text-based — nothing should break).

- [ ] **Step 4: Run full check**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npm run check`
Expected: fully green.

- [ ] **Step 5: Commit**

```bash
git add src/agent/tools/write/create-sync.ts src/agent/tools/write/update-sync.ts
git commit -m "feat(tools): document verifySignature contract in create/update_sync"
```

---

## Task 4: Delete `src/webhook/hmac.ts` and its test

**Files:**

- Delete: `src/webhook/hmac.ts`
- Delete: `src/webhook/hmac.test.ts`

**Context:** After Task 2, `verifyLinearSignature` has no callers. Verify there are no remaining imports, then delete. Also check whether the `src/webhook/` directory becomes empty — if so, delete the directory itself.

- [ ] **Step 1: Verify no remaining imports**

Use Grep: search for `verifyLinearSignature` and `webhook/hmac` across `src/` and `tests/`.
Expected: zero hits. If any appear, either Task 2 was incomplete or a new caller slipped in — fix before continuing.

- [ ] **Step 2: Delete the files**

```bash
rm src/webhook/hmac.ts src/webhook/hmac.test.ts
# If src/webhook/ is now empty, remove the directory too.
rmdir src/webhook 2>/dev/null || true
```

- [ ] **Step 3: Run full check**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npm run check`
Expected: fully green. No dangling imports, no orphaned tests.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore(webhook): remove hardcoded linear hmac — agent owns verification now"
```

---

## Task 5: Manual smoke test — migrate existing Linear sync and verify end-to-end

**Files:** none (manual verification).

**Context:** After Phase C ships, the existing `linear-high-urgent-issues` sync's handler (authored before Phase C) doesn't export `verifySignature`. The next real webhook delivery will 401. This task walks through the migration: use `update_sync` to swap in a new handler that includes the verifier, then trigger a real Linear event to confirm 200.

- [ ] **Step 1: Start dev server with Node 22**

Run (in a background terminal): `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npm run dev`

- [ ] **Step 2: Confirm the existing sync is in pre-Phase-C state**

In the main chat, ask the agent:

> "Use query_sync on linear-high-urgent-issues to SELECT name FROM sqlite_master — just confirming the facet still loads after the wrapper change."

Expected: a list of tables (issues or similar). Proves the wrapper still compiles with the existing handler that lacks `verifySignature`. (The wrapper's `__verifySignature` method will fail-closed on this handler, but `__query` / `query_sync` path is orthogonal — no signature check involved.)

- [ ] **Step 3: Trigger a real Linear webhook to confirm the 401**

Create a Linear issue that matches the existing sync's filter (e.g., priority = Urgent in the relevant team). Watch `npm run dev` logs.

Expected: webhook POST arrives, supervisor returns 401 ("invalid signature"). Proves fail-closed is working — the old handler without `verifySignature` is correctly rejected.

- [ ] **Step 4: Ask the agent to migrate the handler via update_sync**

In the main chat:

> "The linear-high-urgent-issues sync's handler predates the new signature-verification contract. Use update_sync on it with a new handler that (a) keeps all the existing behavior, (b) adds a verifySignature export for Linear's HMAC-SHA256-hex scheme using the linear-signature header. The webhook_secret is already stored; your verifySignature function just receives it as the third arg."

Approve when prompted. The agent should author a new handler_code with both exports.

Expected: update_sync returns `{ ok: true, new_version: 2 }`. The facet recompiles; the old facet is aborted.

- [ ] **Step 5: Trigger a second real Linear webhook**

Create another qualifying Linear issue. Watch logs.

Expected: 200 response, row inserted in the facet's `issues` table, `syncChangeTick` bumps, sidebar refreshes.

Verify by asking the agent:

> "Use query_sync on linear-high-urgent-issues to SELECT * FROM issues ORDER BY created_at DESC LIMIT 3."

Expected: the new issue appears at the top.

- [ ] **Step 6: Push the branch and move to Phase D**

```bash
git push origin feat/pipedream
```

If any step fails, capture logs (wrangler tail, dev console) and diagnose. Common failure modes:

- `__verifySignature` returning false despite a correct handler: check `handlerModule.verifySignature` is actually exported (typo? re-exported from a sub-module?). The wrapper does a strict `typeof === "function"` check.
- TextEncoder / Uint8Array type mismatch in the handler: subtle.sign wants a `BufferSource`; copy into a fresh Uint8Array if needed (the Linear example in the tool description already does this pattern).
- Wrong header name: Linear actually uses `linear-signature` (lowercased). The route lowercases keys before passing to `handleWebhookDelivery`, so `headers["linear-signature"]` is the right access pattern.
- Facet not recompiling: `update_sync` bumps `code_id`; if the facet.fetch still runs the old handler, check that `attachFacet` sees the new code_id (it should — `updateSync` in the DB bumps it).

---

## Self-Review Checklist

**1. Spec coverage:**

- ✅ Supervisor contains zero per-integration signature logic — confirmed by deleting `src/webhook/hmac.ts`.
- ✅ Handlers can verify any signing scheme (HMAC-hex, sha256=-prefixed, v0:ts:body, etc.) because they own the full algorithm.
- ✅ Missing `verifySignature` fails closed (401), not open.
- ✅ The existing Linear sync continues to work after migration (update_sync with verifier).
- ✅ Tests cover the happy path, missing-header path, bad-signature path, and the end-to-end route.
- ✅ Tool descriptions include a concrete example the LLM can adapt.

**2. Type consistency:**

- `handleWebhookDelivery`'s 4th parameter is `Record<string, string>` in both the method signature (Task 2) and every test call site (Task 2). No `string | null` leaks.
- `__verifySignature` in the wrapper (Task 1) returns `boolean`; the supervisor treats any non-`true` as 401. The `result === true` check in the wrapper rejects anything weird a handler might return (truthy strings, etc.) — strictly boolean contract.
- `FakeFacetStub` (Task 2 tests) matches the real RPC shape: fetch, __supervisorPing, __verifySignature.
- No type drift between the tool description's JSON-like JS example and the TS contract — the example is plain JS (runs in the facet runtime), which doesn't need TS types.

**3. Backward compat:**

- `handleWebhookDelivery` signature changed. Only known caller is the Hono route in `src/server.ts` (updated in Task 2 Step 1). Tests updated in Task 2 Step 2. Any other caller would surface in `npm run check`.
- Existing handler code in production (linear-high-urgent-issues) will 401 on the first webhook after Phase C ships. This is documented as the intended migration path in Task 5. README update in Phase F will mention it.

**4. Placeholder / fluff scan:**

- No TODOs, no "add appropriate error handling", no "see Task N" without the code being repeated.
- Every code block is compilable source, not pseudocode.
- Commands include the Node-22 PATH prefix matching prior phases.

---

## Future Work (noted, not planned here)

- **Phase D: agent-authored webhook registration.** The other half of the "zero per-integration supervisor code" thesis. Today `src/integrations/linear-api.ts` has hardcoded `registerLinearWebhook` / `unregisterLinearWebhook` — Phase D replaces that with a third required handler export, `async function registerWebhook(fetch, config)`, invoked by the supervisor during create_sync. Removes `LINEAR_ACCESS_TOKEN` env var at that point. (Linear uses an internal OAuth app that requires an app-level toggle for webhook scopes — see memory `feedback_linear_oauth_webhook.md`; Phase D will use Pipedream's token for Linear webhook creation, sidestepping the per-user webhookCreate scope entirely.)
- **Signature-scheme helper library in the handler runtime.** Optional V2 ergonomics: expose a `ctx.crypto.hmacHex(body, secret)` helper so handlers don't each hand-roll the same HMAC code. Skip for now — copy-pasted 10-line verifiers are fine for a trial submission; shared helpers can come later.
- **Replay protection (Slack-style timestamp rejection).** Slack and Stripe require rejecting requests older than 5 minutes to prevent replay attacks. That logic lives inside the agent-authored `verifySignature` after Phase C — fine to document it in the tool description as "check the upstream's replay-protection requirements". Not a supervisor concern.
