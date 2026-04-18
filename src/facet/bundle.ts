import { exports as workerExports } from "cloudflare:workers";
import { FACET_WRAPPER_SOURCE } from "./wrapper";
import { AGENT_PRIMITIVE_SOURCE } from "../agent-runtime/agent-primitive-source";

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
  env: { LLM: unknown };
  globalOutbound?: Fetcher | null;
}

export interface BuildFacetWorkerCodeInput {
  schemaDdl: string;
  handlerCode: string;
  userId: string;
}

/**
 * Assemble the 4-module Worker Loader bundle for a sync's facet.
 *
 * Modules:
 *   - main.js     (fixed): the DurableObject wrapper from FACET_WRAPPER_SOURCE
 *   - schema.js   (generated): exports SCHEMA_DDL as a string constant
 *   - handler.js  (agent-authored): must export handleWebhook(request, sql, ctx)
 *   - agent.js    (fixed): exports createAgent({ llm, bridge }) for ctx.agent
 *
 * env.LLM is a stamped LLMGateway WorkerEntrypoint the facet can reach via
 * RPC. It holds ANTHROPIC_API_KEY in the supervisor's isolate; the facet
 * never sees the key.
 *
 * globalOutbound is the HttpGateway WorkerEntrypoint, stamped with
 * ctx.props.userId so the gateway knows which user DO this facet belongs
 * to.
 */
export function buildFacetWorkerCode(
  input: BuildFacetWorkerCodeInput
): WorkerCode {
  // Type assertion: workerExports is typed as unknown in
  // @cloudflare/workers-types; the runtime supplies HttpGateway and
  // LLMGateway because we export both from src/server.ts.
  const exportsRef = workerExports as unknown as {
    HttpGateway: (opts: { props: unknown }) => Fetcher;
    LLMGateway: (opts: { props: unknown }) => {
      runAgent: (...args: unknown[]) => unknown;
    };
  };

  return {
    // Pinned to the parent worker's compatibilityDate (see wrangler.jsonc)
    // so facets and supervisor speak the same runtime. Updating the
    // parent's compat date should update this too.
    compatibilityDate: "2026-03-02",
    mainModule: "main.js",
    modules: {
      "main.js": FACET_WRAPPER_SOURCE,
      "schema.js": `export const SCHEMA_DDL = ${JSON.stringify(input.schemaDdl)};\n`,
      "handler.js": input.handlerCode,
      "agent.js": AGENT_PRIMITIVE_SOURCE
    },
    env: {
      LLM: exportsRef.LLMGateway({ props: { userId: input.userId } })
    },
    globalOutbound: exportsRef.HttpGateway({ props: { userId: input.userId } })
  };
}
