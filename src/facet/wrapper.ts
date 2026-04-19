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
