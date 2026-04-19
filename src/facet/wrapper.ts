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
 *   - __registerWebhook(config): supervisor-only RPC called ONCE at
 *     create_sync time. Delegates to the handler's REQUIRED
 *     registerWebhook(fetch, config) export, which performs the upstream
 *     HTTP call to create the webhook subscription and returns
 *     { id, secret }. THROWS if the export is missing — create_sync needs
 *     the real error to surface meaningfully so its rollback logic can
 *     react; fail-closed-to-undefined would be ambiguous. The facet-global
 *     `fetch` is passed explicitly so the handler's code has a clear
 *     parameter; it routes through the HttpGateway → Pipedream proxy, so
 *     the handler never touches credentials.
 *   - __unregisterWebhook(config): supervisor-only RPC called from
 *     delete_sync. Delegates to the handler's STRONGLY RECOMMENDED
 *     unregisterWebhook(fetch, config) export. Returns a discriminated
 *     result: { ok: true } on success, { ok: false, reason:
 *     "no_unregister_export" } if the export is missing (legacy
 *     pre-Phase-D syncs), { ok: false, reason: "threw", detail: <message> }
 *     on throw. Soft-fails so delete_sync can still tear down state even
 *     when upstream deregistration is unavailable or fails.
 *
 * The agent's handler.js contract:
 *
 *   export async function handleWebhook(request, sql, ctx): Promise<Response>
 *     — called for every verified webhook. `request.headers` mirrors the
 *       upstream delivery's headers (lowercased keys as the supervisor
 *       received them), so handlers can dispatch on e.g. x-github-event,
 *       stripe-signature, linear-event, x-slack-signature, etc. via the
 *       standard case-insensitive Headers API (`request.headers.get(...)`).
 *       `request.body` / `request.json()` yield the raw upstream body.
 *       `sql` is this.ctx.storage.sql (call sql.exec(query, ...args) and
 *       sql.exec(query, ...args).toArray() for reads). The optional third
 *       `ctx` arg provides `{ agent, waitUntil }`: `agent` is a preconfigured
 *       subagent runner (built from this.env.LLM + an RpcTarget bridge to
 *       this facet's sql/fetch/userId) that the handler can invoke to process
 *       the webhook with an LLM; `waitUntil` forwards to this.ctx.waitUntil
 *       for background work.
 *
 *   export async function verifySignature(body, headers, secret): Promise<boolean>
 *     — REQUIRED. Called by the supervisor before handleWebhook. `body` is
 *       a Uint8Array of the raw request body; `headers` is a
 *       Record<string, string> with lowercased keys; `secret` is the
 *       webhook_secret stored at create_sync time. Return true to accept
 *       the delivery, false (or throw) to reject with 401. Missing export
 *       → supervisor returns 401 (fail-closed).
 *
 *   export async function registerWebhook(fetch, config): Promise<{id: string, secret: string}>
 *     — REQUIRED. Called once at create_sync time. Makes the upstream HTTP
 *       call (via the injected facet-global `fetch`, which routes through
 *       the HttpGateway → Pipedream proxy so auth is automatic) to create
 *       the webhook subscription. Must return the upstream-assigned
 *       webhook id and the shared secret the supervisor will use to verify
 *       subsequent deliveries. Missing export → __registerWebhook throws.
 *
 *   export async function unregisterWebhook(fetch, config): Promise<void>
 *     — STRONGLY RECOMMENDED. Called from delete_sync to tear down the
 *       upstream webhook subscription. Same `fetch` semantics as
 *       registerWebhook. Missing or throwing → __unregisterWebhook returns
 *       a soft-fail result so delete_sync proceeds.
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
  #syncId;
  constructor(deps) {
    super();
    this.#sql = deps.sql;
    this.#userId = deps.userId;
    this.#syncId = deps.syncId ?? "";
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
  async getSyncId() {
    return this.#syncId;
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
      userId: this.ctx.props ? this.ctx.props.userId : "",
      syncId: this.ctx.props ? this.ctx.props.syncId : ""
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

  async __registerWebhook(config) {
    if (typeof handlerModule.registerWebhook !== "function") {
      throw new Error("handler.js missing required export: registerWebhook");
    }
    // fetch is a facet-global that routes through the HttpGateway→Pipedream
    // proxy — auth is injected for Pipedream-connected apps automatically.
    // Pass it explicitly so the handler has a clear parameter.
    return await handlerModule.registerWebhook(fetch, config);
  }

  async __unregisterWebhook(config) {
    if (typeof handlerModule.unregisterWebhook !== "function") {
      return { ok: false, reason: "no_unregister_export" };
    }
    try {
      await handlerModule.unregisterWebhook(fetch, config);
      return { ok: true };
    } catch (e) {
      return {
        ok: false,
        reason: "threw",
        detail: e instanceof Error ? e.message : String(e)
      };
    }
  }
}

function splitStatements(ddl) {
  return ddl.split(/;\\s*\\n/).map((s) => s.trim()).filter(Boolean);
}
`;
