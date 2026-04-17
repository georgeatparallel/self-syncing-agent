/**
 * Fixed wrapper source for facet bundles. Composed into the Worker Loader
 * `modules` map at sync-creation time alongside a generated `schema.js`
 * and the agent-authored `handler.js`.
 *
 * The wrapper is responsible for:
 *   - Extending DurableObject so ctx.facets.get returns a proper DO stub
 *   - Lazily applying the schema on first fetch (idempotent)
 *   - Delegating to handleWebhook(request, sql) from the agent's module
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

  async fetch(request) {
    if (!this.#schemaApplied) {
      // Run each DDL statement. The agent-authored schema_ddl may contain
      // multiple statements separated by ';'. We split rather than passing
      // the whole string because SqlStorage.exec only runs one statement
      // at a time.
      for (const stmt of splitStatements(SCHEMA_DDL)) {
        if (stmt.trim()) this.ctx.storage.sql.exec(stmt);
      }
      this.#schemaApplied = true;
    }
    return handleWebhook(request, this.ctx.storage.sql);
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
