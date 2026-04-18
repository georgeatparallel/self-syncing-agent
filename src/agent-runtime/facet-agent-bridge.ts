import { RpcTarget } from "cloudflare:workers";

interface BridgeDeps {
  sql: SqlStorage;
  userId: string;
}

/**
 * Bridge passed to LLMGateway.runAgent so the supervisor-side ReAct
 * loop can reach into the facet's SQLite. Mirrors the RpcTarget pattern
 * in src/execrunner/facet-bridge.ts — raw DO stubs don't cross Worker
 * Loader isolate boundaries, RpcTarget subclasses do.
 *
 * Scope: SQL only. Fetch and exec run supervisor-side — fetch via
 * handleGatewayRequest (same policy, no facet bounce), exec via
 * env.LOADER. userId is carried so the supervisor can stamp exec
 * isolates and fetch-policy calls with the right principal.
 */
export class FacetAgentBridge extends RpcTarget {
  #sql: SqlStorage;
  #userId: string;

  constructor(deps: BridgeDeps) {
    super();
    this.#sql = deps.sql;
    this.#userId = deps.userId;
  }

  async sqlQuery(query: string): Promise<unknown[]> {
    return this.#sql.exec(query).toArray();
  }

  async sqlExec(
    query: string,
    ...bindings: unknown[]
  ): Promise<
    | { ok: true; rowsWritten: number; rowsRead: number }
    | { ok: false; error: string }
  > {
    try {
      const cursor = this.#sql.exec(query, ...bindings);
      cursor.toArray();
      return {
        ok: true,
        rowsWritten: cursor.rowsWritten,
        rowsRead: cursor.rowsRead
      };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async getUserId(): Promise<string> {
    return this.#userId;
  }
}
