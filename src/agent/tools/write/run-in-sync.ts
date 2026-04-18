import { tool } from "ai";
import { z } from "zod";
import { getSyncById } from "../../../db/syncs";
import { attachFacet } from "../../../facet/loader";
import { buildExecWorkerCode } from "../../../execrunner/bundle";
import { FacetBridge } from "../../../execrunner/facet-bridge";
import type { ChatAgent } from "../../../server";

interface LogEntry {
  level: "log" | "info" | "warn" | "error";
  message: string;
  ts: number;
}

type ExecOk = { ok: true; result: unknown; logs: LogEntry[] };
type ExecFail = {
  ok: false;
  error: string;
  detail?: string;
  stack?: string | null;
  logs: LogEntry[];
};

type NotFoundResult = { error: "not_found"; sync_id: string };
type OkResult = { ok: true; result: unknown; logs: LogEntry[] };
type OkTruncatedResult = {
  ok: true;
  result: null;
  truncated: true;
  serialized_bytes: number;
  logs: LogEntry[];
};
// ExecFail (already declared) covers both the wrapper-passed failure
// and the outer-catch failure from this tool, since their shapes align.
type RunInSyncResult = NotFoundResult | OkResult | OkTruncatedResult | ExecFail;

interface ExecRunner {
  run(facet: unknown): Promise<ExecOk | ExecFail>;
}

interface ExecWorkerStub {
  getEntrypoint(): ExecRunner;
}

// 64KB of serialized JSON. Sized for realistic backfill summaries; past
// this we drop the raw result and flag the size so the agent can retry
// with a smaller-shape return.
const RESULT_CAP = 64 * 1024;

export function runInSyncTool(agent: ChatAgent) {
  return tool({
    description: `Run agent-authored one-shot code inside a sync's isolated runtime. Approval-gated. Use for:
- Backfill (pull historical data from the upstream API into the facet).
- Diagnostics (ad-hoc queries the read path can't express — parameter binding, multi-statement flows).
- Data repair (fix up rows after a broken handler version).
- Triggering upstream actions during the probe loop (create a test event so a webhook fires).

Code contract: ES module source that MUST export \`async function runInSync(facet, fetch)\`. Whatever runInSync returns becomes the tool's \`result\`.

facet RPC methods:
- \`await facet.__query(sql)\` → \`{ ok: true, rows } | { ok: false, error }\`. Read-only SQL.
- \`await facet.__sqlExec(sql, ...bindings)\` → \`{ ok: true, rowsWritten, rowsRead } | { ok: false, error }\`. Arbitrary SQL (INSERT/UPDATE/DELETE/DDL).

\`fetch\` is global and routes through the same auth proxy handler.js uses — the upstream token is injected automatically.

Logging: \`console.log\` / \`.info\` / \`.warn\` / \`.error\` are captured (last 200 entries, 2KB per message) and returned alongside the result on BOTH success and failure. Log before and after each \`fetch\` and \`__sqlExec\` boundary so a failing run is debuggable from the return value alone. Do NOT reassign \`console\` methods — you'll lose debug visibility.

Limits and caveats:
- Keep runs under ~30 seconds (Workers wall-time per RPC). For long backfills, store progress (e.g., \`last_synced_at\`) in a side table and call run_in_sync repeatedly.
- Do not \`import\` anything beyond runtime globals (\`fetch\`, \`crypto\`, \`Response\`). No npm packages.
- Writes must be idempotent (INSERT OR REPLACE, ON CONFLICT) — retries are always possible.
- Result is capped at 64KB serialized JSON. Past that you'll see \`{ ok: true, result: null, truncated: true, serialized_bytes }\`; retry with aggregates or paging.

Error shapes:
- \`{ error: "not_found", sync_id }\` — unknown sync. Recheck <active_syncs>; maybe it was deleted.
- \`{ ok: false, error: "exec_failed", detail, stack?, logs }\` — code threw. Read the logs to diagnose.
- \`{ ok: false, error: "no_export", detail, logs }\` — module didn't export runInSync.`,
    inputSchema: z.object({
      sync_id: z.string().describe("The sync's UUID."),
      code: z
        .string()
        .min(1)
        .describe(
          "An ES module that exports `async function runInSync(facet, fetch)`. See the tool description for the full contract, logging rules, limits, and error shapes."
        )
    }),
    needsApproval: true,
    execute: async ({ sync_id, code }): Promise<RunInSyncResult> => {
      const sql = agent.sql.bind(agent);
      const sync = getSyncById(sql, sync_id);
      if (!sync) return { error: "not_found" as const, sync_id };

      // `load()` rather than `get(id, cb)` — Cloudflare's Dynamic Workers
      // docs mark load() as the primitive for one-time execution. Each
      // run_in_sync call is new agent-authored code; caching by ID would
      // just need a per-call nonce anyway. Billing is identical.
      const workerStub = (
        agent.env.LOADER as unknown as {
          load: (c: unknown) => ExecWorkerStub;
        }
      ).load(buildExecWorkerCode({ code, userId: agent.name }));
      const entrypoint = workerStub.getEntrypoint();

      // We can't pass the raw facet DO stub as an RPC arg — workerd
      // can't marshal DurableObject stubs across Worker Loader isolate
      // boundaries (produces an opaque "internal error; reference = ..."
      // before the method body runs). The canonical fix from Cloudflare's
      // codemode example: wrap the stub in an RpcTarget subclass, which
      // IS crossable. FacetBridge mirrors __query / __sqlExec so the
      // agent's code sees the same interface it would see talking to
      // the facet directly.
      const facet = attachFacet(agent.env, agent.ctx.facets, sync, agent.name);
      const bridge = new FacetBridge(facet);

      try {
        const res = await entrypoint.run(bridge);

        if (!res.ok) return res;

        // Truncation: if the returned result serializes past the cap, drop
        // the raw value and report the size. Agent can retry with a
        // smaller-shape return (aggregates instead of raw rows, etc.).
        const json = JSON.stringify(res.result);
        if (json.length > RESULT_CAP) {
          return {
            ok: true as const,
            result: null,
            truncated: true,
            serialized_bytes: json.length,
            logs: res.logs
          };
        }
        return { ok: true as const, result: res.result, logs: res.logs };
      } catch (e) {
        // Thrown here means the exec wrapper itself failed to execute —
        // typically a Worker Loader compile error (syntax in the agent's
        // code). The wrapper never ran, so we have no logs to surface.
        return {
          ok: false as const,
          error: "exec_failed",
          detail: e instanceof Error ? e.message : String(e),
          logs: [] as LogEntry[]
        };
      }
    }
  });
}
