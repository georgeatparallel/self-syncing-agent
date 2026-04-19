import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";
import { resolveModelId } from "./models";
import { handleGatewayRequest } from "../proxy/http-gateway";
import type { AgentRequest, AgentResult } from "./types";
import type { FacetAgentBridge } from "./facet-agent-bridge";

const MAX_STEPS_HARD_CAP = 15;
const DEFAULT_STEPS = 8;

/**
 * Adapter between FacetAgentBridge (supervisor-side sql/fetch surface)
 * and the FacetBridge contract that run_in_sync-authored `runInSync`
 * code expects (`__query` / `__sqlExec`).
 *
 * The exec tool loads a Worker Loader isolate and invokes the wrapper's
 * `run(facet)` — the wrapper passes that `facet` straight into user
 * code as `runInSync(facet, fetch)`. Agent-authored code calls
 * `facet.__query(...)` and `facet.__sqlExec(...)` (see
 * src/execrunner/facet-bridge.ts for the canonical surface), so we
 * must expose those method names from whatever we pass in.
 *
 * An RpcTarget subclass is required — raw objects and DO stubs don't
 * marshal across Worker Loader isolate boundaries.
 */
class ExecFacetShim extends RpcTarget {
  #bridge: FacetAgentBridge;

  constructor(bridge: FacetAgentBridge) {
    super();
    this.#bridge = bridge;
  }

  // Projects FacetAgentBridge.sqlExec's rich return down to the
  // documented __query contract: `{ ok: true, rows } | { ok: false, error }`.
  async __query(sql: string) {
    const r = await this.#bridge.sqlExec(sql);
    if (!r.ok) return { ok: false as const, error: r.error };
    return { ok: true as const, rows: r.rows };
  }

  // Same for __sqlExec: the agent-authored runInSync contract returns
  // `{ ok: true, rowsWritten, rowsRead } | { ok: false, error }`, so we
  // strip `rows` here to keep that contract exact.
  async __sqlExec(sql: string, ...bindings: unknown[]) {
    const r = await this.#bridge.sqlExec(sql, ...bindings);
    if (!r.ok) return { ok: false as const, error: r.error };
    return {
      ok: true as const,
      rowsWritten: r.rowsWritten,
      rowsRead: r.rowsRead
    };
  }
}

/**
 * Pure function form for unit tests — no WorkerEntrypoint plumbing.
 * Runs a generateText ReAct loop, wiring three built-in tools
 * (sql/fetch/exec) to bridge callbacks. Returns the final model text.
 *
 * ANTHROPIC_API_KEY lives here, in the supervisor isolate; the facet
 * never sees it.
 */
export async function runAgent(
  request: AgentRequest,
  bridge: FacetAgentBridge,
  env: Env
): Promise<AgentResult> {
  const tier = request.model ?? "sonnet";
  const modelId = resolveModelId(tier);
  const steps = Math.min(request.maxSteps ?? DEFAULT_STEPS, MAX_STEPS_HARD_CAP);

  const anthropic = createAnthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const userId = await bridge.getUserId();
  // Bridge.getSyncId was introduced in Phase F so the subagent's
  // fetch/exec tools can route through the credential-injection gateway
  // with the correct sync scope. Pre-F bridges won't have the method;
  // treat missing-method as "no sync in scope", fail closed at the
  // gateway. Not ok to hard-error here — some call sites legitimately
  // have no sync context (tests, supervisor-side diagnostics).
  const syncId =
    typeof (bridge as { getSyncId?: () => Promise<string> }).getSyncId ===
    "function"
      ? await (bridge as { getSyncId: () => Promise<string> }).getSyncId()
      : "";

  const tools = {
    sql: tool({
      description: `Run a SQL statement against the facet's own SQLite.

Use for reads (SELECT) and writes (INSERT/UPDATE/DELETE/DDL). Bindings are applied positionally ('?' placeholders). The facet's schema was established at sync creation; inspect via \`SELECT sql FROM sqlite_master\` if you need the current shape.

Returns on success:
  { ok: true, rows, rowsWritten, rowsRead }
- \`rows\` is an array of result-row objects for SELECT; empty array for writes/DDL.
- \`rowsWritten\` and \`rowsRead\` are SQLite's cursor stats for the statement.

Returns on SQLite error:
  { ok: false, error }`,
      inputSchema: z.object({
        query: z.string(),
        bindings: z.array(z.unknown()).optional()
      }),
      execute: async ({ query, bindings }) => {
        return bridge.sqlExec(query, ...(bindings ?? []));
      }
    }),
    fetch: tool({
      description:
        "Make an HTTP request through the supervisor's credential-injecting proxy. Upstream auth is injected automatically for known hosts (e.g., api.linear.app); unknown hosts return 403.",
      inputSchema: z.object({
        url: z.string(),
        method: z.string().default("GET"),
        headers: z.record(z.string(), z.string()).optional(),
        body: z.string().optional()
      }),
      execute: async ({ url, method, headers, body }) => {
        // Invoke the gateway policy directly — we're already on the
        // supervisor side, the facet bounce adds 3 isolate hops per
        // fetch for no benefit. Policy still lives in one place
        // (handleGatewayRequest in src/proxy/http-gateway.ts).
        const req = new Request(url, { method, headers, body });
        const res = await handleGatewayRequest(req, env, { userId, syncId });
        const text = await res.text();
        return { status: res.status, body: text };
      }
    }),
    exec: tool({
      description: `Execute a JavaScript module in a fresh Worker Loader isolate. Use for compute the \`sql\` and \`fetch\` tools can't express: parsing complex payloads, computing diffs, chaining multi-step transformations, anything Turing-complete.

Module contract: ES module source that MUST export \`async function runInSync(facet, fetch)\`. The isolate imports that export and calls it with two capabilities:

\`facet\` — RPC surface into the sync's SQLite:
- \`await facet.__query(sql)\` → \`{ ok: true, rows } | { ok: false, error }\`. Read-only: executes the statement and returns all result rows.
- \`await facet.__sqlExec(sql, ...bindings)\` → \`{ ok: true, rowsWritten, rowsRead } | { ok: false, error }\`. Arbitrary SQL (INSERT / UPDATE / DELETE / DDL); rows are not returned — use \`__query\` for reads.

\`fetch\` — global fetch in the exec isolate. Routes through the same auth-injecting proxy the handler and \`fetch\` tool use: upstream token is injected automatically for known hosts (currently \`api.linear.app\`); unknown hosts return 403.

Limits and conventions:
- Do NOT \`import\` anything beyond these two parameters. Runtime globals \`crypto\`, \`Response\`, etc. are available but npm packages are not.
- Whatever \`runInSync\` returns becomes the tool's \`result\`. Keep it small — it flows back into this conversation's context.
- \`console.log / .info / .warn / .error\` are captured (ring buffer: last 200 entries, 2KB per message) and returned alongside the result on both success and failure. Log before and after each fetch/__sqlExec boundary so a failing run is debuggable from the return alone.
- Writes must be idempotent (INSERT OR REPLACE, ON CONFLICT) — the tool may be retried by the ReAct loop.

Returns:
- \`{ ok: true, result, logs }\` — module ran, \`result\` is whatever runInSync returned.
- \`{ ok: false, error: "exec_failed", detail, stack?, logs }\` — runInSync threw.
- \`{ ok: false, error: "no_export", detail, logs }\` — module didn't export \`runInSync\`.`,
      inputSchema: z.object({ code: z.string() }),
      execute: async ({ code }) => {
        const { buildExecWorkerCode } = await import("../execrunner/bundle");
        const bundle = buildExecWorkerCode({ code, userId, syncId });
        const stub = (
          env.LOADER as unknown as {
            load: (c: unknown) => {
              getEntrypoint: () => { run: (f: unknown) => Promise<unknown> };
            };
          }
        ).load(bundle);
        const shim = new ExecFacetShim(bridge);
        return stub.getEntrypoint().run(shim);
      }
    })
  };

  try {
    const result = await generateText({
      model: anthropic(modelId),
      system: request.system,
      messages: request.messages,
      tools,
      stopWhen: stepCountIs(steps)
    });
    return {
      ok: true,
      text: result.text,
      steps: result.steps.length,
      usage: {
        input_tokens: result.usage.inputTokens ?? 0,
        output_tokens: result.usage.outputTokens ?? 0
      }
    };
  } catch (e) {
    return {
      ok: false,
      error: "llm_failed",
      detail: e instanceof Error ? e.message : String(e)
    };
  }
}

interface LLMGatewayProps {
  userId?: string;
}

export class LLMGateway extends WorkerEntrypoint<Env, LLMGatewayProps> {
  async runAgent(
    request: AgentRequest,
    bridge: FacetAgentBridge
  ): Promise<AgentResult> {
    // this.env is the supervisor worker's env — has ANTHROPIC_API_KEY
    // and LOADER both from wrangler.jsonc.
    return runAgent(request, bridge, this.env);
  }
}
