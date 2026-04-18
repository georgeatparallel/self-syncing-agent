import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";
import { resolveModelId } from "./models";
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

  async __query(sql: string) {
    try {
      const rows = await this.#bridge.sqlQuery(sql);
      return { ok: true as const, rows };
    } catch (e) {
      return {
        ok: false as const,
        error: e instanceof Error ? e.message : String(e)
      };
    }
  }

  async __sqlExec(sql: string, ...bindings: unknown[]) {
    return this.#bridge.sqlExec(sql, ...bindings);
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
  env: { ANTHROPIC_API_KEY: string; LOADER: WorkerLoader }
): Promise<AgentResult> {
  const tier = request.model ?? "sonnet";
  const modelId = resolveModelId(tier);
  const steps = Math.min(request.maxSteps ?? DEFAULT_STEPS, MAX_STEPS_HARD_CAP);

  const anthropic = createAnthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const userId = await bridge.getUserId();

  const tools = {
    sql: tool({
      description:
        "Run a SQL statement against the facet's SQLite. Use for reads (SELECT) and writes (INSERT/UPDATE/DELETE/DDL).",
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
        "Make an HTTP request through the facet's credential-injecting proxy. Upstream auth is injected automatically for known hosts.",
      inputSchema: z.object({
        url: z.string(),
        method: z.string().default("GET"),
        headers: z.record(z.string(), z.string()).optional(),
        body: z.string().optional()
      }),
      execute: async ({ url, method, headers, body }) => {
        const res = await bridge.gatewayFetch(url, { method, headers, body });
        const text = await res.text();
        return { status: res.status, body: text };
      }
    }),
    exec: tool({
      description:
        "Execute a JavaScript module that exports `async function runInSync(facet, fetch)`. Runs in a fresh Worker Loader isolate. Same contract as the run_in_sync tool.",
      inputSchema: z.object({ code: z.string() }),
      execute: async ({ code }) => {
        const { buildExecWorkerCode } = await import("../execrunner/bundle");
        const bundle = buildExecWorkerCode({ code, userId });
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
