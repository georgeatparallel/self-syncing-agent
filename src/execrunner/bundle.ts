import { exports as workerExports } from "cloudflare:workers";
import { EXEC_WRAPPER_SOURCE } from "./wrapper";

/**
 * WorkerCode shape accepted by env.LOADER.load(). Mirrors the shape used
 * by facet bundles (see src/facet/bundle.ts) but with only two modules —
 * exec bundles don't need a schema.js because they don't own SQLite.
 */
export interface ExecWorkerCode {
  compatibilityDate: string;
  mainModule: string;
  modules: Record<string, string>;
  globalOutbound?: Fetcher | null;
}

export interface BuildExecWorkerCodeInput {
  code: string; // agent-authored ES module; must export runInSync(facet, fetch)
  userId: string;
}

/**
 * Assemble the 2-module Worker Loader bundle for a run_in_sync exec isolate.
 *
 * Modules:
 *   - main.js  (fixed): the WorkerEntrypoint from EXEC_WRAPPER_SOURCE
 *   - exec.js  (agent-authored): must export async function runInSync(facet, fetch)
 *
 * globalOutbound is set to the HttpGateway WorkerEntrypoint, stamped with
 * userId so the gateway can inject user-scoped credentials. Same pattern
 * as buildFacetWorkerCode — the exec isolate is credentially indistinguishable
 * from its sibling facet.
 */
export function buildExecWorkerCode(
  input: BuildExecWorkerCodeInput
): ExecWorkerCode {
  return {
    // Pinned to wrangler.jsonc's compatibility_date so all three isolates
    // (supervisor, facet, exec) speak the same runtime. Update alongside
    // the parent worker's compat date.
    compatibilityDate: "2026-03-02",
    mainModule: "main.js",
    modules: {
      "main.js": EXEC_WRAPPER_SOURCE,
      "exec.js": input.code
    },
    // Same as buildFacetWorkerCode: workerExports is typed `unknown` by
    // @cloudflare/workers-types; the runtime supplies HttpGateway because
    // src/server.ts re-exports it.
    globalOutbound: (
      workerExports as unknown as {
        HttpGateway: (opts: { props: unknown }) => Fetcher;
      }
    ).HttpGateway({ props: { userId: input.userId } })
  };
}
