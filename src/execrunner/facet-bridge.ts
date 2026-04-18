import { RpcTarget } from "cloudflare:workers";

/**
 * Host-side bridge between the supervisor's facet DO stub and the loaded
 * dynamic worker (exec isolate). Cloudflare's Worker Loader can't marshal
 * raw DurableObject stubs across isolate boundaries — passing a facet stub
 * directly to `entrypoint.run(facet)` fails with an opaque
 * `"internal error; reference = ..."` before our code runs.
 *
 * The canonical fix (see cloudflare/agents codemode example) is to wrap
 * capabilities in `RpcTarget` subclasses, which ARE crossable. The loaded
 * worker calls `bridge.__query(...)` and `bridge.__sqlExec(...)` and the
 * bridge forwards to the real facet DO stub here in the supervisor.
 *
 * The method names (`__query`, `__sqlExec`) mirror the facet wrapper's
 * RPC surface so the agent's code sees exactly the same contract it
 * would see if it were calling the facet directly.
 */
export class FacetBridge extends RpcTarget {
  #facet: Fetcher;

  constructor(facet: Fetcher) {
    super();
    this.#facet = facet;
  }

  async __query(sql: string): Promise<unknown> {
    return await (
      this.#facet as unknown as {
        __query: (sql: string) => Promise<unknown>;
      }
    ).__query(sql);
  }

  async __sqlExec(sql: string, ...bindings: unknown[]): Promise<unknown> {
    return await (
      this.#facet as unknown as {
        __sqlExec: (sql: string, ...bindings: unknown[]) => Promise<unknown>;
      }
    ).__sqlExec(sql, ...bindings);
  }
}
