import { RpcTarget } from "cloudflare:workers";

interface BridgeDeps {
  sql: SqlStorage;
  fetch: (input: RequestInfo, init?: RequestInit) => Promise<Response>;
  userId: string;
}

/**
 * Bridge passed to LLMGateway.runAgent so the supervisor-side ReAct
 * loop can call back into facet capabilities. Mirrors the RpcTarget
 * pattern used by src/execrunner/facet-bridge.ts — raw DO stubs don't
 * cross Worker Loader isolate boundaries, RpcTarget subclasses do.
 *
 * Scope: sql + fetch only. The exec tool is implemented on the
 * LLMGateway side (it has env.LOADER); this bridge just carries the
 * userId so exec isolates get stamped with the right props.
 */
export class FacetAgentBridge extends RpcTarget {
  #sql: SqlStorage;
  #fetch: (input: RequestInfo, init?: RequestInit) => Promise<Response>;
  #userId: string;

  constructor(deps: BridgeDeps) {
    super();
    this.#sql = deps.sql;
    this.#fetch = deps.fetch;
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

  async gatewayFetch(url: string, init?: RequestInit): Promise<Response> {
    return this.#fetch(url, init);
  }

  async getUserId(): Promise<string> {
    return this.#userId;
  }
}
