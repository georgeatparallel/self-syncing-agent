import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";
import { resolveModelId } from "./models";
import { handleGatewayRequest } from "../proxy/http-gateway";
import { formatConnectedAccounts } from "../agent/context";
import type { ConnectedAccount } from "../db/types";
import type { AgentRequest, AgentResult } from "./types";
import type { FacetAgentBridge } from "./facet-agent-bridge";

const MAX_STEPS_HARD_CAP = 15;
const DEFAULT_STEPS = 8;

/**
 * Live-read the user's connected Pipedream accounts so the subagent
 * can pick the correct `X-Pd-App` slug on each fetch. Same pattern
 * HttpGateway uses for resolveEgress — re-run per generation, not
 * stamped on props, so a user connecting a new app mid-session is
 * reflected on the NEXT subagent turn without a bundle bump.
 *
 * If userId is missing (no user scope, diagnostic call) or the RPC
 * fails, we fall through to an empty list and let the gateway's
 * `account_not_connected` 403 surface the problem downstream.
 */
async function buildSubagentContext(env: Env, userId: string): Promise<string> {
  if (!userId) return formatConnectedAccounts([]);
  try {
    const stub = env.ChatAgent.get(env.ChatAgent.idFromName(userId));
    const accounts = await (
      stub as unknown as {
        listPipedreamAccounts: (u: string) => Promise<ConnectedAccount[]>;
      }
    ).listPipedreamAccounts(userId);
    return formatConnectedAccounts(accounts);
  } catch {
    return formatConnectedAccounts([]);
  }
}

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
      description: `Make an HTTP request through the user's credential-injecting proxy.

**Every fetch MUST set the \`X-Pd-App\` header** to one of the user's connected app slugs (see the \`<connected_accounts>\` block at the top of your context — use the slug verbatim). The gateway uses this header to pick which connected Pipedream account's OAuth token to inject via the Pipedream Connect proxy.

Host constraints: the target hostname must be declared in the calling sync's \`api_hosts\` (set at create_sync by the main agent). Undeclared hosts 403 \`unknown_host\`. SSRF denylist blocks private IPs, cloud metadata (169.254.169.254), localhost, etc. — 403 \`denied_host\`.

Returns \`{ status, body }\` on both success and 4xx/5xx; the gateway itself never throws. 403 responses carry a structured error code in the body (\`denied_host\`, \`missing_app_header\`, \`unknown_host\`, \`account_not_connected\`, \`sync_not_found\`) — inspect and self-correct (e.g., retry with a correct slug in X-Pd-App).

Example:
  fetch({
    url: "https://api.slack.com/chat.postMessage",
    method: "POST",
    headers: { "X-Pd-App": "slack", "Content-Type": "application/json" },
    body: JSON.stringify({ channel: "C123", text: "hello" })
  })`,
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

\`fetch\` — global fetch in the exec isolate. Every fetch goes through the user's credential-injecting proxy. **Every fetch MUST set the \`X-Pd-App\` header** to one of the user's connected app slugs (see \`<connected_accounts>\` block in your context). The gateway injects that app's OAuth token via Pipedream Connect. Hosts must be in the calling sync's \`api_hosts\` (declared at create_sync). Undeclared hosts 403 \`unknown_host\`. SSRF denylist blocks private IPs / metadata / .internal / .local → 403 \`denied_host\`. Missing \`X-Pd-App\` → 403 \`missing_app_header\`.

Example fetch from inside runInSync:
  await fetch("https://api.slack.com/chat.postMessage", {
    method: "POST",
    headers: { "X-Pd-App": "slack", "Content-Type": "application/json" },
    body: JSON.stringify({ channel, text })
  });

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

  // Prepend a `<connected_accounts>` ambient-context message so the
  // subagent knows which X-Pd-App slugs are valid. Live-read per
  // generation (not stamped on props) — no stale-bundle trap. Matches
  // the block the main agent already receives via buildContextMessages.
  const ambientContext = await buildSubagentContext(env, userId);
  const augmentedMessages = [
    { role: "user" as const, content: ambientContext },
    ...request.messages
  ];

  try {
    const result = await generateText({
      model: anthropic(modelId),
      system: request.system,
      messages: augmentedMessages,
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
