/**
 * Fixed wrapper source for run_in_sync exec bundles. Composed into the
 * Worker Loader `modules` map at tool-invocation time alongside the
 * agent-authored `exec.js`.
 *
 * This wrapper runs in a SEPARATE Worker Loader isolate from the facet DO.
 * It holds no persistent state — it is a stateless WorkerEntrypoint whose
 * only job is to import exec.js, call its exported `runInSync(facet, fetch)`,
 * and return the result (plus captured console logs) to the tool layer via
 * RPC.
 *
 * Log capture monkey-patches console.log/info/warn/error into a ring buffer
 * (cap: 200 entries, 2KB per message). Ring-buffered so entries nearest a
 * throw survive — that's what's useful for debugging. Returned on BOTH
 * success and failure paths; on failure, logs up to the throw point are
 * preserved.
 *
 * See docs/superpowers/specs/2026-04-18-phase-11-run-in-sync-design.md §4.1
 * for the full contract. V2 upgrade (Tail Workers) is described in §12.1.
 */
export const EXEC_WRAPPER_SOURCE = `
import { WorkerEntrypoint } from "cloudflare:workers";
import { runInSync } from "./exec.js";

const LOG_ENTRY_CAP = 200;
const LOG_MESSAGE_BYTES = 2048;

function formatArg(a) {
  if (typeof a === "string") return a;
  try { return JSON.stringify(a); } catch { return String(a); }
}

function installLogCapture() {
  const logs = [];
  const original = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error
  };
  const capture = (level) => (...args) => {
    const message = args.map(formatArg).join(" ").slice(0, LOG_MESSAGE_BYTES);
    logs.push({ level, message, ts: Date.now() });
    // Ring-buffer behaviour: keep the LAST 200 entries. Debugging a throw
    // needs the logs near the throw site, not the ones at script start.
    if (logs.length > LOG_ENTRY_CAP) logs.shift();
    original[level].apply(console, args);
  };
  console.log = capture("log");
  console.info = capture("info");
  console.warn = capture("warn");
  console.error = capture("error");
  const restore = () => {
    console.log = original.log;
    console.info = original.info;
    console.warn = original.warn;
    console.error = original.error;
  };
  return { logs, restore };
}

export default class extends WorkerEntrypoint {
  async run(facet) {
    if (typeof runInSync !== "function") {
      return {
        ok: false,
        error: "no_export",
        detail: "exec.js must export async function runInSync(facet, fetch)",
        logs: []
      };
    }
    const { logs, restore } = installLogCapture();
    try {
      const result = await runInSync(facet, fetch);
      return { ok: true, result, logs };
    } catch (e) {
      return {
        ok: false,
        error: "exec_failed",
        detail: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? (e.stack ?? null) : null,
        logs
      };
    } finally {
      restore();
    }
  }
}
`;
