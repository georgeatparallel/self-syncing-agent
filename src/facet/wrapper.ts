/**
 * Fixed wrapper source for facet bundles. Composed into the Worker Loader
 * `modules` map at sync-creation time alongside a generated `schema.js`
 * and the agent-authored `handler.js`.
 *
 * The wrapper's supervisor-only responsibilities:
 *   - fetch delegate: run schema-init then call the agent's handleWebhook
 *   - schema init: #ensureSchema() applies SCHEMA_DDL once, lazily, shared
 *     by both fetch and __query (a query_sync may fire before any webhook
 *     has hit, so the query path also needs to trigger init)
 *   - __supervisorPing(): no-op RPC that forces Worker Loader compilation
 *     at create_sync time without running the agent's handler
 *   - __query(sql): supervisor-only SQL read path. Catches SQLite errors
 *     and returns { ok, rows | error } so a bad agent-written query can't
 *     wedge the facet. Tool layer enforces SELECT/WITH-only; wrapper is
 *     power-not-policy. Double underscore discourages the agent from
 *     shadowing it in handler.js.
 *
 * The agent's handler.js contract: export a function
 *   `handleWebhook(request: Request, sql: SqlStorage): Promise<Response>`
 * where `sql` is this.ctx.storage.sql (call sql.exec(query, ...args) and
 * sql.exec(query, ...args).toArray() for reads).
 */
export const FACET_WRAPPER_SOURCE = `
import { DurableObject } from "cloudflare:workers";
import { SCHEMA_DDL } from "./schema.js";
import { handleWebhook } from "./handler.js";

export class App extends DurableObject {
  #schemaApplied = false;

  #ensureSchema() {
    if (this.#schemaApplied) return;
    // Run each DDL statement. The agent-authored schema_ddl may contain
    // multiple statements separated by ';'. We split rather than passing
    // the whole string because SqlStorage.exec only runs one statement
    // at a time.
    for (const stmt of splitStatements(SCHEMA_DDL)) {
      if (stmt.trim()) this.ctx.storage.sql.exec(stmt);
    }
    this.#schemaApplied = true;
  }

  async fetch(request) {
    this.#ensureSchema();
    return handleWebhook(request, this.ctx.storage.sql);
  }

  // Supervisor-only probe. Touching the facet forces Worker Loader to
  // compile the bundle; if the agent's handler.js has a syntax error,
  // missing handleWebhook export, or any other load-time failure, this
  // call rejects and the supervisor's try/catch rolls back. Double
  // underscore discourages the agent from shadowing it in handler.js.
  async __supervisorPing() {}

  // Supervisor-only query path. Tool layer enforces SELECT/WITH-only;
  // this method is power-not-policy. Catches SQLite errors so a bad
  // query from the user can't wedge the facet.
  async __query(sql) {
    this.#ensureSchema();
    try {
      const rows = this.ctx.storage.sql.exec(sql).toArray();
      return { ok: true, rows };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : String(e)
      };
    }
  }
}

function splitStatements(ddl) {
  // Naive splitter — adequate for the agent-written schemas we expect
  // (CREATE TABLE, CREATE INDEX, ALTER TABLE). If an agent generates
  // triggers or stored procedures with embedded ';' this would break;
  // not in scope for V1.
  return ddl.split(/;\\s*\\n/).map((s) => s.trim()).filter(Boolean);
}
`;
