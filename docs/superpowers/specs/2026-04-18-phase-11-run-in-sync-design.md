# Phase 11 — `run_in_sync` Design

**Status:** approved 2026-04-18

## 1. Goal

Give the agent a way to execute one-shot code against a specific sync's SQLite — with the same network proxy and user scope that the sync's webhook handler runs under — without disturbing live webhook delivery.

This unlocks backfill (pull historical data via Linear's API and write it to the facet), diagnostics (ad-hoc queries the read path can't express), and data repair (fix up rows after a broken handler version).

`run_in_sync` is the last primitive before `update_sync` (Phase 12) can support schema migrations with backfill.

## 2. Non-goals

- **Custom wall-time enforcement.** Workers' built-in per-RPC time limit (~30s) caps a run. We document "chunk long work across multiple calls" rather than build an in-process timeout/abort.
- **Exec code as a persistent part of the sync.** Each `run_in_sync` call is ephemeral — the exec bundle is loaded, run, and never referenced again. Persisting ad-hoc code belongs to `update_sync`.
- **Use from `update_sync` for backfill.** Phase 12 integrates `run_in_sync` primitives into the update flow; this phase only ships the standalone tool.
- **Per-binding log streaming.** Logs are captured in-memory during the run and returned with the result. We don't expose a real-time stream to the chat UI in V1 — the agent sees the full log array when the tool returns.

## 3. Architecture

Two isolates running side by side, talking via RPC:

```
┌─────────────────────────┐        ┌──────────────────────────┐
│  Facet DO (the sync)    │        │  Exec worker (ephemeral) │
│  - SQLite lives here    │ ◄──────│  - Agent's one-shot code │
│  - handler.js runs here │  RPC   │  - No SQLite of its own  │
│  - __query, __sqlExec   │ ─────► │  - fetch via gateway     │
└─────────────────────────┘        └──────────────────────────┘
```

The facet DO is unchanged in its primary job (running `handleWebhook`). We extend its supervisor-only RPC surface with `__sqlExec(sql, ...bindings)` so the exec worker has a write path into the facet's SQLite.

The exec worker is a fresh `WorkerEntrypoint` loaded via Worker Loader, bundled with the agent's code as a module. It has one RPC method: `run(facetStub)`. That method imports the agent's module, calls its exported `runInSync(facet, fetch)`, and returns the result.

**Why this shape rather than running exec code inside the facet DO?**
Workers blocks `eval`/`new Function` at runtime, so new code can only arrive at Worker Loader compile time. Running exec code inside the facet DO would require rebuilding the facet's bundle and swapping the DO class via `ctx.facets.delete` + re-attach on every call. That swap aborts any in-flight webhook and races with parallel tool calls (Anthropic's tool-use protocol emits tool_use blocks in parallel, and the AI SDK executes them concurrently). Moving exec to a sibling isolate means the live facet is never touched — webhook processing continues uninterrupted during a backfill. The ergonomic cost (`await facet.__query(...)` instead of `sql.exec(...)`) is small and mirrors the handler contract closely enough.

## 4. Components

### 4.1 `src/execrunner/wrapper.ts` — fixed wrapper source (new)

Exports `EXEC_WRAPPER_SOURCE` (a string of JS module code). Shape:

```js
import { WorkerEntrypoint } from "cloudflare:workers";
import { runInSync } from "./exec.js";

const LOG_ENTRY_CAP = 200;
const LOG_MESSAGE_BYTES = 2048;

function formatArg(a) {
  if (typeof a === "string") return a;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

function installLogCapture() {
  const logs = [];
  const original = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error
  };
  const capture =
    (level) =>
    (...args) => {
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
```

Two details worth flagging:

- The `no_export` branch won't fire via the `import` directly — a missing export blows up at module load. The `typeof` check covers the case where `runInSync` is exported but isn't a function.
- Log capture monkey-patches `console` methods. This is scoped to the exec isolate (fresh per call), so there's no leakage to the supervisor or facet. The original methods are restored in `finally` so even if our patching breaks, the isolate gets torn down after the RPC anyway.

**Log contract for the agent:** `console.log` / `console.info` / `console.warn` / `console.error` work as expected. Each entry is captured as `{ level, message, ts }`. Capped at 200 entries total; each message truncated to 2KB. Logs are returned on both success and failure paths — especially valuable on failure.

### 4.2 `src/execrunner/bundle.ts` — bundle factory (new)

Mirrors `src/facet/bundle.ts`:

```ts
export interface ExecWorkerCode {
  compatibilityDate: string;
  mainModule: string;
  modules: Record<string, string>;
  globalOutbound?: Fetcher | null;
}

export interface BuildExecWorkerCodeInput {
  code: string; // agent-authored module, must export runInSync
  userId: string;
}

export function buildExecWorkerCode(
  input: BuildExecWorkerCodeInput
): ExecWorkerCode {
  return {
    compatibilityDate: "2026-03-02",
    mainModule: "main.js",
    modules: {
      "main.js": EXEC_WRAPPER_SOURCE,
      "exec.js": input.code
    },
    globalOutbound: (
      workerExports as { HttpGateway: (opts: { props: unknown }) => Fetcher }
    ).HttpGateway({ props: { userId: input.userId } })
  };
}
```

### 4.3 `src/facet/wrapper.ts` — add `__sqlExec`

New supervisor-only RPC on the existing `App` DO class:

```js
async __sqlExec(sql, ...bindings) {
  this.#ensureSchema();
  try {
    const cursor = this.ctx.storage.sql.exec(sql, ...bindings);
    cursor.toArray();  // drain — side effects like INSERT commit on exec anyway
    return {
      ok: true,
      rowsWritten: cursor.rowsWritten,
      rowsRead: cursor.rowsRead
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e)
    };
  }
}
```

`rowsWritten` / `rowsRead` come from `SqlStorageCursor` — cheap to return, useful for the agent ("I wrote 42 rows").

### 4.4 `src/agent/tools/write/run-in-sync.ts` — the tool (new)

```ts
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

interface ExecRunner {
  run(facet: unknown): Promise<ExecOk | ExecFail>;
}

const RESULT_CAP = 64 * 1024;

export function runInSyncTool(agent: ChatAgent) {
  return tool({
    description:
      "Run agent-authored one-shot code inside a sync's isolated runtime. Use for backfills, diagnostics, and data repair. The code must export runInSync(facet, fetch). Calls to facet.__query / facet.__sqlExec read/write the sync's SQLite. fetch goes through the same auth proxy the handler uses.",
    inputSchema: z.object({
      sync_id: z.string().describe("The sync's UUID."),
      code: z
        .string()
        .min(1)
        .describe(
          "An ES module that exports `async function runInSync(facet, fetch)`. Whatever runInSync returns becomes the tool's result. facet.__query(sql) returns { ok, rows | error }. facet.__sqlExec(sql, ...bindings) returns { ok, rowsWritten, rowsRead | error }. Use console.log/warn/error freely — logs are captured and returned with the result (and on errors)."
        )
    }),
    needsApproval: true,
    execute: async ({ sync_id, code }) => {
      const sql = agent.sql.bind(agent);
      const sync = getSyncById(sql, sync_id);
      if (!sync) return { error: "not_found" as const, sync_id };

      // `load()` rather than `get(id, cb)` — Cloudflare docs mark load()
      // as the primitive for one-time execution ("best for one-time code
      // execution, for example when using Codemode"). Each run_in_sync
      // call is new agent-authored code, so caching by ID would just
      // require a per-call nonce anyway. Billing is the same either way.
      const workerStub = agent.env.LOADER.load(
        buildExecWorkerCode({ code, userId: agent.name })
      );
      const entrypoint = workerStub.getEntrypoint();

      const facet = attachFacet(agent.env, agent.ctx.facets, sync, agent.name);

      try {
        const res = await (entrypoint as unknown as ExecRunner).run(facet);

        if (!res.ok) return res;

        const json = JSON.stringify(res.result);
        if (json.length > RESULT_CAP) {
          return {
            ok: true,
            result: null,
            truncated: true,
            serialized_bytes: json.length,
            logs: res.logs
          };
        }
        return { ok: true, result: res.result, logs: res.logs };
      } catch (e) {
        return {
          ok: false,
          error: "exec_failed" as const,
          detail: e instanceof Error ? e.message : String(e),
          logs: [] // wrapper never ran, no logs to surface
        };
      }
    }
  });
}
```

Note the outer try/catch: the wrapper itself catches thrown errors in `run()` and returns `{ok: false, error}`, but if the Worker Loader compile fails (syntax error in the agent's code), the error surfaces at the `execWorker.run(...)` call site. Catching here covers that path.

Result truncation: naive substring-then-reparse can produce invalid JSON. Settled approach: when `JSON.stringify(result).length > RESULT_CAP`, return `{ ok: true, result: null, truncated: true, serialized_bytes: json.length }` — drop the raw result, tell the agent how big it was, let them retry with a smaller query or reshape their return.

### 4.5 `src/agent/system-prompt.ts` — updates

Add to the "Write tools (available)" block:

```
- `run_in_sync(sync_id, code)` — runs agent-authored one-shot code in an isolated runtime scoped to the sync. Use for backfill, diagnostics, data repair. Code must export `async function runInSync(facet, fetch)`. facet exposes `__query(sql)` and `__sqlExec(sql, ...bindings)`. fetch goes through the same auth proxy handler.js uses (Linear token injected automatically). Approval-gated.
```

Add a new section "run_in_sync contract" after the handler_code contract:

- Code must be an ES module with `export async function runInSync(facet, fetch)`.
- Keep it under 30s (Workers wall-time per RPC). Chunk long backfills: store `last_synced_at` in a side table and call `run_in_sync` repeatedly.
- Idempotent writes (INSERT OR REPLACE, ON CONFLICT). Backfills retry.
- Return shape: anything JSON-serializable. Caller sees `result`. Include diagnostics (row counts, errors encountered) in the return.
- `facet.__query(sql)` → `{ ok: true, rows } | { ok: false, error }`.
- `facet.__sqlExec(sql, ...bindings)` → `{ ok: true, rowsWritten, rowsRead } | { ok: false, error }`.
- **Logging:** `console.log` / `console.info` / `console.warn` / `console.error` are captured and returned alongside the result (and alongside the error on failure). Use them liberally — especially before and after each `fetch` or `__sqlExec` boundary so a failing run is debuggable. Logs are capped at 200 entries per run, 2KB per message.
- No `import` beyond the runtime globals (`fetch`, `crypto`, `Response`, etc.).

Also update the "Still-unavailable write tools" note — `run_in_sync` moves out of "coming later"; `update_sync` remains.

### 4.6 No supervisor DB migrations needed

`run_in_sync` doesn't persist anything to supervisor SQLite. Exec runs are transient. If Phase 12 wants to record exec history for audit, it adds a table then.

## 5. Data flow

```
agent call run_in_sync(sync_id, code)
  │
  ▼
tool: lookup sync, check not_found
  │
  ▼
tool: build exec bundle with code + userId-scoped gateway
  │
  ▼
env.LOADER.load(workerCode)   ← fresh isolate, no caching by design
  │
  ▼
workerStub.getEntrypoint()   ← default WorkerEntrypoint stub
  │
  ▼
attachFacet(...)  — returns existing facet stub, no swap
  │
  ▼
entrypoint.run(facetStub)   — RPC into exec isolate
  │
  ▼
exec wrapper imports exec.js, calls runInSync(facet, fetch)
  │
  ├── fetch(linear) → globalOutbound → HttpGateway → Linear API with user token
  │
  ├── facet.__query(sql) → RPC back into facet DO → sql.exec → rows → JSON
  │
  ├── facet.__sqlExec(sql, ...) → RPC back into facet DO → sql.exec → rowsWritten → JSON
  │
  ▼
return result (or error) → serialize → tool returns to agent
```

## 6. Error handling

All success and failure shapes include a `logs` array (may be empty). Shapes shown below omit `logs` for brevity but it is always present on shapes the wrapper returned.

| Condition                                       | Returned shape                                                                                                               |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Unknown `sync_id`                               | `{ error: "not_found", sync_id }` — no logs (wrapper never ran)                                                              |
| `runInSync` not exported / not a function       | `{ ok: false, error: "no_export", detail, logs: [] }`                                                                        |
| `runInSync` throws                              | `{ ok: false, error: "exec_failed", detail, stack, logs }` — logs up to the throw included                                   |
| Worker Loader compile fails (syntax error)      | `{ ok: false, error: "exec_failed", detail, logs: [] }` — caught by tool's outer try/catch; wrapper never ran                |
| Result exceeds 64KB serialized                  | `{ ok: true, result: null, truncated: true, serialized_bytes, logs }` — raw result dropped, agent retries with smaller shape |
| Workers wall-time exceeded                      | RPC rejects with Workers' timeout error → `exec_failed` with that message, logs=[]                                           |
| `facet.__query` / `__sqlExec` fails inside exec | Surfaced to agent's code as `{ ok: false, error }`. Agent decides whether to propagate. Agent-level logs still captured.     |

## 7. Security

- **Isolation.** Exec runs in a fresh Worker Loader isolate. No supervisor env vars leak — the exec bundle gets `globalOutbound` (`HttpGateway` stub) but no other bindings.
- **Network scope.** `globalOutbound` is the same user-stamped HttpGateway the facet uses. Hostname allowlist and credential injection already enforced there.
- **SQL scope.** Exec reaches SQLite only via `facet.__query` / `facet.__sqlExec`. No raw `SqlStorage` reference crosses the isolate boundary. DDL isn't blocked at the wrapper — `__sqlExec` runs whatever SQL the agent's code passes, including `DROP TABLE`. Justified: exec is approval-gated and meant for repair; we trust the agent + user to not write destructive code together. Phase 12 can add ring-fencing if we observe misuse.
- **Cross-sync access.** Exec receives a stub to exactly one facet — the one named in the tool input. It cannot enumerate or name-address other facets.
- **Approval gate.** `needsApproval: true`. Approval dialog shows the proposed code. Same UX as `create_sync` / `delete_sync`.

## 8. Testing

### 8.1 `src/facet/wrapper.test.ts` — new or extended

- `__sqlExec` inserts a row; `__query` reads it back.
- `__sqlExec` with constraint violation returns `{ ok: false, error }` without throwing.
- `__sqlExec` reports `rowsWritten` accurately after multi-row INSERT.

### 8.2 `src/agent/tools/write/run-in-sync.test.ts` — new

Following Phase 10's fake-facet pattern. `cloudflare:test` gives a real `env.LOADER`, so tests pass real (small) ES module strings as the `code` parameter and Workers compiles them — no stubbing of `new Function` needed. For error cases where we need the exec to misbehave in a specific way, we author short code strings that produce the target behaviour (throwing, missing export, oversized return).

Cases:

- **happy**: code does `await facet.__sqlExec(...)` then `await facet.__query(...)` and returns `{ rows }` — tool returns `{ ok: true, result: { rows: [...] }, logs: [] }`.
- **not_found**: unknown sync_id → `{ error: "not_found", sync_id }`.
- **exec throws**: code does `console.log("step 1"); throw new Error("boom")` → tool returns `{ ok: false, error: "exec_failed", detail: "boom", stack: "...", logs: [{ level: "log", message: "step 1", ts: ... }] }`. Key assertion: logs from before the throw are preserved.
- **no_export**: code doesn't export `runInSync` → tool returns `{ ok: false, error: "no_export", detail, logs: [] }`.
- **logs captured across levels**: code emits one entry each at log/info/warn/error → all four present in the returned `logs` array with correct `level` values.
- **log cap (ring buffer)**: code emits 300 entries with sequential messages → returned `logs` has exactly 200, containing the LAST 200 (entries 101..300), proving ring-buffer semantics.
- **log message truncation**: code emits a 5KB string → returned `message` is exactly 2048 chars.
- **fetch reaches gateway**: code calls `fetch("https://api.linear.app/graphql", ...)` — fake gateway sees the request with expected headers.
- **result truncation**: code returns a 100KB array — tool returns `{ ok: true, result: null, truncated: true, serialized_bytes, logs: [...] }`. Logs still flow through truncation.

Testing trick: since `cloudflare:test` runs real Worker Loader, the fake stub path is `env.LOADER.get(codeId, cb)` where cb actually returns the bundle; Workers compiles the agent's code. Unit tests can pass real small modules via the `code` parameter.

### 8.3 Manual smoke

After implementation, smoke-test against a real Linear workspace:

1. Create a sync on Linear issues.
2. Manually trigger a backfill via chat: "fetch all open issues from the last 7 days and put them in the table."
3. Verify `query_sync` shows the backfilled rows.
4. Create a new issue in Linear, confirm webhook delivery still works during/after the backfill.

## 9. Integration points

- **`src/facet/loader.ts`**: unchanged. `attachFacet` is already the shared path.
- **`src/integrations/linear-api.ts`**: unchanged. Exec fetches the real Linear API via the gateway.
- **`src/proxy/http-gateway.ts`**: unchanged. Gateway already enforces hostname allowlist + credential injection per userId.
- **`src/agent/tools/index.ts`** (or equivalent): register `run_in_sync` in `buildTools(agent)`.
- **`src/agent/context.ts`**: no changes — `run_in_sync` doesn't inject ambient context.

## 10. Decision log

- **B (separate isolate) over A (rebuild facet bundle).** Chosen because the swap race and the webhook-abort problem outweigh the `await facet.__xxx` ergonomic tax.
- **Add `__sqlExec` on the facet wrapper rather than open a raw SQL RPC surface.** `__sqlExec` takes statement + bindings, same shape as `sql.exec`. Keeps the contract narrow.
- **Capture console logs and return them with every result (success or failure).** Debugging a failed backfill via only an error message is painful — the agent ends up guessing and burning tokens. Capturing `console.*` matches JS developer instinct (no new `log()` API to remember) and makes failure paths actionable. Cost is minor: an array in the wrapper's closure, monkey-patched at the start of each run, capped for memory safety.
- **`load()` over `get(id, cb)`.** Cloudflare's Dynamic Workers docs recommend `load()` for one-time execution; `get()` is for cacheable, re-used workers. Every `run_in_sync` call is new agent-authored code, so caching would require per-call nonces anyway. Billing is identical in practice ("1 Dynamic Worker per invocation"). `load()` is simpler and semantically correct.
- **Monkey-patched `console` capture over Tail Workers.** Docs describe an official Tail Worker path for observability (`tails: [ctx.exports.ExecTail({ props: { runId } })]` + a shared DO buffer to deliver logs back to the `run_in_sync` response). It's more robust (catches crash-time logs, runtime-instrumented) but async: the tail callback fires after the dynamic worker finishes, so we'd need a shared DO to relay logs back to the tool response — an extra component and roundtrip. For V1 we accept the simpler in-process capture and flag Tail Workers as a V2 upgrade path.
- **64KB result cap, 200-entry/2KB-message log cap.** Sized for realistic backfill summaries and debug traces. Tool flags truncation on results. Logs use a ring buffer (keep the last 200) so the entries closest to a throw survive — that's where debugging starts.

## 11. Out-of-scope reminders

Phase 12 (`update_sync`) will:

- Persist new schema_ddl + handler_code on the sync row, bump `sync.version`.
- Re-bundle the facet (forcing a cache miss on the bumped codeId) and re-attach.
- Optionally chain a `run_in_sync`-style backfill after the schema migration lands.

That migration flow is the reason we ship `run_in_sync` as a standalone primitive first.

## 12. V2 upgrade paths

Enumerated here so the README can surface them later and so V1 reviewers see what we deliberately deferred.

### 12.1 Swap `console`-monkey-patch capture for Tail Workers

**What V1 ships.** The exec wrapper overwrites `console.log` / `.info` / `.warn` / `.error` at the start of each run and drains a ring-buffered array into the RPC return value alongside `result`.

**What V2 should ship.** Use Cloudflare's official observability path: attach a Tail Worker via `tails: [ctx.exports.ExecTail({ props: { runId } })]` on the `env.LOADER.load(...)` call. The Tail Worker runs asynchronously after the exec worker finishes and receives runtime-captured events (logs, uncaught exceptions, `outcome`, CPU metadata). To surface those logs back through the `run_in_sync` tool response, add a `LogSession` DO that both the main tool handler and the Tail Worker can reach: the tool creates a session before `run()`, the Tail Worker writes events into it after the dynamic worker finishes, and the tool awaits `logSession.waitForLogs(timeout)` before returning. The Playground example in the Dynamic Workers docs is a reference implementation.

**What the upgrade buys.**

- **Crash-time capture.** Monkey-patched arrays die with the isolate on OOM, uncaught exception, or CPU-time wall. Runtime-level tail capture survives, because events are emitted below the JS layer. Exec code that crashes catastrophically still produces a debuggable log stream.
- **Unforgeable by exec code.** Agent-authored code can't redefine `console.log` to subvert the capture — runtime instrumentation is outside the sandbox.
- **Full event shape.** Tail events carry uncaught exceptions, outcome (`ok` / `exception` / `exceededCpu` / `canceled`), and request metadata — not just what the agent chose to log.
- **Integrates with Workers Logs.** The Tail Worker can also push into Workers Logs for persistent, searchable history across all runs.

**Costs.**

- Adds a `LogSession` Durable Object class and an `ExecTail` WorkerEntrypoint — roughly 150 lines plus their wrangler binding wiring.
- Introduces a latency floor: every `run_in_sync` waits up to N ms (1s is the docs' suggested cap) for the tail callback to deliver logs, even on successful fast runs.
- Testing overhead: DO state, async delivery, and timing assumptions enter the test matrix.

**When to upgrade.** Any of:

- We ever run code that isn't agent-authored (user-uploaded handlers, third-party scripts) — adversarial subversion of `console` becomes realistic.
- Exec failures we can't diagnose from the monkey-patched trace (OOM, CPU timeout, uncaught rejection).
- Demand for persistent, searchable exec logs across runs.
- A unified observability surface with webhook handler logs.

None of these apply for V1 / assignment demo.
