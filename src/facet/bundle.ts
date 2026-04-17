import { exports as workerExports } from "cloudflare:workers";
import { FACET_WRAPPER_SOURCE } from "./wrapper";

/**
 * WorkerCode shape from the Cloudflare Dynamic Workers API reference.
 * Fields match @cloudflare/workers-types' `WorkerLoaderWorkerCode`, which
 * is what env.LOADER.get() ultimately expects. Declaring locally keeps
 * the module importable without a types-only import line.
 */
export interface WorkerCode {
  compatibilityDate: string;
  compatibilityFlags?: string[];
  mainModule: string;
  modules: Record<string, string>;
  globalOutbound?: Fetcher | null;
}

export interface BuildFacetWorkerCodeInput {
  schemaDdl: string;
  handlerCode: string;
  userId: string;
}

/**
 * Assemble the 3-module Worker Loader bundle for a sync's facet.
 *
 * Modules:
 *   - main.js     (fixed): the DurableObject wrapper from FACET_WRAPPER_SOURCE
 *   - schema.js   (generated): exports SCHEMA_DDL as a string constant
 *   - handler.js  (agent-authored): must export handleWebhook(request, sql)
 *
 * globalOutbound is set to the HttpGateway WorkerEntrypoint, stamped with
 * ctx.props.userId so the gateway knows which user DO this facet belongs
 * to. V1 ignores it in credential lookup (shared workspace token) but
 * V2 Pipedream will use it to pick the user's access token.
 */
export function buildFacetWorkerCode(
  input: BuildFacetWorkerCodeInput
): WorkerCode {
  return {
    // Pinned to the parent worker's compatibilityDate (see wrangler.jsonc)
    // so facets and supervisor speak the same runtime. Updating the parent's
    // compat date should update this too.
    compatibilityDate: "2026-03-02",
    mainModule: "main.js",
    modules: {
      "main.js": FACET_WRAPPER_SOURCE,
      "schema.js": `export const SCHEMA_DDL = ${JSON.stringify(input.schemaDdl)};\n`,
      "handler.js": input.handlerCode
    },
    // Type assertion: workerExports is typed as unknown in @cloudflare/workers-types;
    // the runtime supplies HttpGateway because we export it from src/server.ts.
    globalOutbound: (
      workerExports as unknown as {
        HttpGateway: (opts: { props: unknown }) => Fetcher;
      }
    ).HttpGateway({ props: { userId: input.userId } })
  };
}
