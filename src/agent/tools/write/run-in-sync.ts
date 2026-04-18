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
    description:
      "Run agent-authored one-shot code inside a sync's isolated runtime. Use for backfills (pull history from the upstream API), diagnostics (ad-hoc queries the read path can't express), and data repair. The code must export `async function runInSync(facet, fetch)`. Calls to facet.__query / facet.__sqlExec read/write the sync's SQLite. fetch goes through the same auth proxy handler.js uses — the upstream token is injected automatically. console.log / .info / .warn / .error are captured and returned alongside the result (and on errors). Approval-gated.",
    inputSchema: z.object({
      sync_id: z.string().describe("The sync's UUID."),
      code: z
        .string()
        .min(1)
        .describe(
          "An ES module that exports `async function runInSync(facet, fetch)`. Whatever runInSync returns becomes the tool's result. facet.__query(sql) returns { ok, rows | error }. facet.__sqlExec(sql, ...bindings) returns { ok, rowsWritten, rowsRead | error }. Use console.log/warn/error liberally — logs are captured and returned (even on failure). Keep runs under 30s; chunk long backfills."
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
