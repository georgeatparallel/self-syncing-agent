# Phase 11 — `run_in_sync` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `run_in_sync(sync_id, code)` tool so the agent can execute one-shot code against a sync's SQLite (for backfill, diagnostics, data repair) without disturbing live webhook delivery.

**Architecture:** Run the agent's code in a fresh Worker Loader isolate (`env.LOADER.load(...)`), not the facet DO. The isolate holds a stub to the facet and reaches SQLite via two facet RPC methods: `__query` (already shipped) and `__sqlExec` (added in this phase). The exec wrapper captures `console.*` into a ring buffer and returns it alongside the result. Approval-gated. Logs return on both success and failure paths so the agent can debug.

**Tech Stack:** TypeScript, Cloudflare Workers, Worker Loader, Durable Object Facets, Vitest + `@cloudflare/vitest-pool-workers`, Vercel AI SDK.

**Spec reference:** `docs/superpowers/specs/2026-04-18-phase-11-run-in-sync-design.md` — read it first if anything below is ambiguous.

---

## File structure

| File                                        | Status | Responsibility                                                                                                                                                                          |
| ------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/facet/wrapper.ts`                      | modify | Add `__sqlExec(sql, ...bindings)` RPC to the facet DO wrapper source.                                                                                                                   |
| `src/facet/bundle.test.ts`                  | modify | Add string-match test for `__sqlExec` in the wrapper source.                                                                                                                            |
| `src/execrunner/wrapper.ts`                 | create | `EXEC_WRAPPER_SOURCE` — fixed JS module for the exec isolate. Default-exports a `WorkerEntrypoint` with a `run(facet)` method; monkey-patches `console` into a ring-buffered log array. |
| `src/execrunner/wrapper.test.ts`            | create | String-match tests on the wrapper source. Runtime behavior is verified by `run-in-sync.test.ts` once we go through the tool.                                                            |
| `src/execrunner/bundle.ts`                  | create | `buildExecWorkerCode({ code, userId })` → `{ compatibilityDate, mainModule, modules, globalOutbound }`. Mirrors `src/facet/bundle.ts`.                                                  |
| `src/execrunner/bundle.test.ts`             | create | Shape/encoding tests, mirroring `src/facet/bundle.test.ts`.                                                                                                                             |
| `src/agent/tools/write/run-in-sync.ts`      | create | The `run_in_sync` tool — loads the exec bundle, attaches the facet, calls `entrypoint.run(facet)`, applies truncation, surfaces errors + logs.                                          |
| `src/agent/tools/write/run-in-sync.test.ts` | create | Unit tests with a fake `LOADER` binding (fake `getEntrypoint().run()`) and fake `ctx.facets`. Covers happy path, not_found, throw, no_export, truncation, log capture.                  |
| `src/agent/tools/index.ts`                  | modify | Register `run_in_sync` in `buildTools`.                                                                                                                                                 |
| `src/agent/system-prompt.ts`                | modify | Document `run_in_sync` in the write-tools list and add a "run_in_sync contract" section. Remove from "Still-unavailable" list.                                                          |

Why `src/execrunner/` instead of reusing `src/facet/`: facet bundles produce a DO class (`App`); exec bundles produce a stateless `WorkerEntrypoint`. Different primitive, different file.

---

## Testing notes (read before writing tests)

- **Test runner:** `npm test` (maps to `vitest run`). Config at `vitest.config.ts` uses `@cloudflare/vitest-pool-workers`. Tests can `import { env, runInDurableObject } from "cloudflare:test"`.
- **Workerd test runtime limitation:** `worker.getDurableObjectClass` and parts of the Facets API are absent in the bundled workerd used by the tests. `env.LOADER.load(...)` might work partially; tests should NOT rely on real Worker Loader compilation — instead, fake the LOADER binding.
- **Fake pattern:** Existing tests (`tests/create-sync-integration.test.ts`, `src/agent/tools/write/delete-sync.test.ts`) install fakes on `ctx.facets`. For Phase 11 we also need a fake `env.LOADER`. Both are plain objects in the test env, so direct assignment works.
- **Typecheck:** `npm run check` runs format + lint + tsc + vitest. Run it before every commit.

Fake `LOADER` pattern (used by Task 4 tests):

```ts
interface FakeEntrypoint {
  run: (facet: unknown) => Promise<unknown>;
}
interface FakeWorkerStub {
  getEntrypoint: () => FakeEntrypoint;
}
interface FakeLoader {
  load: (code: unknown) => FakeWorkerStub;
}
function installFakeLoader(instance: unknown, loader: FakeLoader): () => void {
  const env = (instance as { env: Record<string, unknown> }).env;
  const prev = env.LOADER;
  env.LOADER = loader;
  return () => {
    env.LOADER = prev;
  };
}
```

---

## Task 1: Add `__sqlExec` RPC to the facet wrapper

**Files:**

- Modify: `src/facet/wrapper.ts`
- Test: `src/facet/bundle.test.ts`

- [ ] **Step 1: Add failing string-match test for `__sqlExec`**

Open `src/facet/bundle.test.ts` and update the existing `"wrapper source exposes __query and #ensureSchema"` test to also assert the presence of `__sqlExec`:

```ts
it("wrapper source exposes __query, __sqlExec, and #ensureSchema", () => {
  const bundle = buildFacetWorkerCode({
    schemaDdl: "CREATE TABLE IF NOT EXISTS x (id TEXT);",
    handlerCode:
      "export async function handleWebhook(){ return new Response('ok'); }",
    userId: "u1"
  });
  const main = bundle.modules["main.js"];
  expect(main).toMatch(/#ensureSchema/);
  expect(main).toMatch(/async __query\(/);
  expect(main).toMatch(/async __sqlExec\(/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/facet/bundle.test.ts`
Expected: FAIL on the new `toMatch(/async __sqlExec\(/)` assertion — current wrapper source has no `__sqlExec`.

- [ ] **Step 3: Add `__sqlExec` to the wrapper source**

Edit `src/facet/wrapper.ts`. Locate the block comment listing supervisor-only methods (around lines 6-17) and extend it:

```ts
/**
 * Fixed wrapper source for facet bundles. Composed into the Worker Loader
 * `modules` map at sync-creation time alongside a generated `schema.js`
 * and the agent-authored `handler.js`.
 *
 * The wrapper's supervisor-only responsibilities:
 *   - fetch delegate: run schema-init then call the agent's handleWebhook
 *   - schema init: #ensureSchema() applies SCHEMA_DDL once, lazily, shared
 *     by both fetch and __query/__sqlExec (a query_sync or run_in_sync may
 *     fire before any webhook has hit, so those paths also need to trigger
 *     init)
 *   - __supervisorPing(): no-op RPC that forces Worker Loader compilation
 *     at create_sync time without running the agent's handler
 *   - __query(sql): supervisor-only SQL read path. Catches SQLite errors
 *     and returns { ok, rows | error } so a bad agent-written query can't
 *     wedge the facet. Tool layer enforces SELECT/WITH-only; wrapper is
 *     power-not-policy. Double underscore discourages the agent from
 *     shadowing it in handler.js.
 *   - __sqlExec(sql, ...bindings): supervisor-only SQL write path used by
 *     run_in_sync's exec isolate. Accepts any statement (including DDL) —
 *     approval gating on the tool side is the trust boundary, not this
 *     method. Returns { ok: true, rowsWritten, rowsRead } | { ok: false,
 *     error }; drains the cursor so side effects commit.
 */
```

Then add the method inside the `App` class, immediately after the `__query` method block:

```js
  // Supervisor-only write path used by run_in_sync's exec isolate. Runs
  // whatever statement + bindings the caller passes; trust comes from the
  // tool's approval gate, not this method. Drains the cursor so INSERTs
  // actually commit.
  async __sqlExec(sql, ...bindings) {
    this.#ensureSchema();
    try {
      const cursor = this.ctx.storage.sql.exec(sql, ...bindings);
      cursor.toArray();
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

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/facet/bundle.test.ts`
Expected: PASS — all 5 tests green, including the updated `__sqlExec` assertion.

- [ ] **Step 5: Typecheck + commit**

```bash
npm run check
git add src/facet/wrapper.ts src/facet/bundle.test.ts
git commit -m "$(cat <<'EOF'
phase 11 task 1: add __sqlExec RPC to facet wrapper

New supervisor-only write path used by run_in_sync's exec isolate.
Drains the cursor to commit side effects; returns rowsWritten /
rowsRead on success, { ok: false, error } on SQLite errors.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Create exec wrapper source

**Files:**

- Create: `src/execrunner/wrapper.ts`
- Test: `src/execrunner/wrapper.test.ts`

- [ ] **Step 1: Create the failing test file**

Create `src/execrunner/wrapper.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { EXEC_WRAPPER_SOURCE } from "./wrapper";

describe("EXEC_WRAPPER_SOURCE", () => {
  it("imports WorkerEntrypoint from cloudflare:workers", () => {
    expect(EXEC_WRAPPER_SOURCE).toMatch(
      /import \{ WorkerEntrypoint \} from "cloudflare:workers"/
    );
  });

  it("imports runInSync from ./exec.js", () => {
    expect(EXEC_WRAPPER_SOURCE).toMatch(
      /import \{ runInSync \} from "\.\/exec\.js"/
    );
  });

  it("default-exports a class extending WorkerEntrypoint with an async run(facet) method", () => {
    expect(EXEC_WRAPPER_SOURCE).toMatch(
      /export default class extends WorkerEntrypoint/
    );
    expect(EXEC_WRAPPER_SOURCE).toMatch(/async run\(facet\)/);
  });

  it("guards against a missing or non-function runInSync export", () => {
    expect(EXEC_WRAPPER_SOURCE).toMatch(/typeof runInSync !== "function"/);
    expect(EXEC_WRAPPER_SOURCE).toMatch(/no_export/);
  });

  it("wraps the runInSync call in try/catch and returns exec_failed with stack on throw", () => {
    expect(EXEC_WRAPPER_SOURCE).toMatch(/try\s*\{/);
    expect(EXEC_WRAPPER_SOURCE).toMatch(/exec_failed/);
    expect(EXEC_WRAPPER_SOURCE).toMatch(/e\.stack/);
  });

  it("installs a log capture that monkey-patches console.log/info/warn/error", () => {
    expect(EXEC_WRAPPER_SOURCE).toMatch(/console\.log = capture/);
    expect(EXEC_WRAPPER_SOURCE).toMatch(/console\.info = capture/);
    expect(EXEC_WRAPPER_SOURCE).toMatch(/console\.warn = capture/);
    expect(EXEC_WRAPPER_SOURCE).toMatch(/console\.error = capture/);
  });

  it("uses a ring-buffered log array with a 200-entry cap", () => {
    expect(EXEC_WRAPPER_SOURCE).toMatch(/LOG_ENTRY_CAP\s*=\s*200/);
    expect(EXEC_WRAPPER_SOURCE).toMatch(/logs\.shift\(\)/);
  });

  it("truncates each log message at 2048 bytes", () => {
    expect(EXEC_WRAPPER_SOURCE).toMatch(/LOG_MESSAGE_BYTES\s*=\s*2048/);
    expect(EXEC_WRAPPER_SOURCE).toMatch(/\.slice\(0, LOG_MESSAGE_BYTES\)/);
  });

  it("restores original console methods in finally", () => {
    expect(EXEC_WRAPPER_SOURCE).toMatch(/finally\s*\{/);
    expect(EXEC_WRAPPER_SOURCE).toMatch(/restore\(\)/);
  });

  it("returns logs on both success and failure paths", () => {
    // Both the ok:true and ok:false returns should include `logs`.
    const okMatch = EXEC_WRAPPER_SOURCE.match(
      /return \{\s*ok:\s*true,[^}]*logs[^}]*\}/
    );
    const failMatch = EXEC_WRAPPER_SOURCE.match(
      /return \{\s*ok:\s*false,[\s\S]*?logs[\s\S]*?\}/
    );
    expect(okMatch).not.toBeNull();
    expect(failMatch).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/execrunner/wrapper.test.ts`
Expected: FAIL — `src/execrunner/wrapper.ts` does not exist yet, imports fail.

- [ ] **Step 3: Create the wrapper source**

Create `src/execrunner/wrapper.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/execrunner/wrapper.test.ts`
Expected: PASS — all 10 assertions green.

- [ ] **Step 5: Typecheck + commit**

```bash
npm run check
git add src/execrunner/wrapper.ts src/execrunner/wrapper.test.ts
git commit -m "$(cat <<'EOF'
phase 11 task 2: add exec wrapper source for run_in_sync

Fixed WorkerEntrypoint module loaded into the exec isolate at
run_in_sync time. Imports the agent's exec.js, calls its
runInSync(facet, fetch), returns { ok, result | error, logs }
with a ring-buffered console capture.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Create exec bundle factory

**Files:**

- Create: `src/execrunner/bundle.ts`
- Test: `src/execrunner/bundle.test.ts`

- [ ] **Step 1: Create the failing test file**

Create `src/execrunner/bundle.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";

// Must mock the exports import before importing the module under test,
// since top-level imports evaluate eagerly. Same pattern as src/facet/bundle.test.ts.
vi.mock("cloudflare:workers", async (importActual) => {
  const actual = await importActual<typeof import("cloudflare:workers")>();
  return {
    ...actual,
    exports: {
      HttpGateway: (opts: { props: unknown }) => ({
        __mockHttpGateway: true,
        props: opts.props
      })
    }
  };
});

import { buildExecWorkerCode } from "./bundle";
import { EXEC_WRAPPER_SOURCE } from "./wrapper";

const SAMPLE_CODE = `
export async function runInSync(facet, fetch) {
  return { ok: true };
}
`;

describe("buildExecWorkerCode", () => {
  it("produces a WorkerCode with main.js + exec.js and mainModule=main.js", () => {
    const code = buildExecWorkerCode({
      code: SAMPLE_CODE,
      userId: "user-abc"
    });
    expect(code.mainModule).toBe("main.js");
    expect(Object.keys(code.modules).sort()).toEqual(["exec.js", "main.js"]);
  });

  it("embeds the agent-authored code verbatim as exec.js", () => {
    const code = buildExecWorkerCode({
      code: SAMPLE_CODE,
      userId: "u"
    });
    expect(code.modules["exec.js"]).toBe(SAMPLE_CODE);
  });

  it("includes the fixed wrapper source verbatim in main.js", () => {
    const code = buildExecWorkerCode({
      code: SAMPLE_CODE,
      userId: "u"
    });
    expect(code.modules["main.js"]).toBe(EXEC_WRAPPER_SOURCE);
  });

  it("pins a compatibilityDate matching the parent worker", () => {
    const code = buildExecWorkerCode({
      code: SAMPLE_CODE,
      userId: "u"
    });
    // Must match wrangler.jsonc's compatibility_date so facet and exec
    // isolates share the same runtime semantics.
    expect(code.compatibilityDate).toBe("2026-03-02");
  });

  it("sets globalOutbound to HttpGateway stamped with userId props", () => {
    const code = buildExecWorkerCode({
      code: SAMPLE_CODE,
      userId: "user-xyz"
    });
    expect(code.globalOutbound).toMatchObject({
      __mockHttpGateway: true,
      props: { userId: "user-xyz" }
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/execrunner/bundle.test.ts`
Expected: FAIL — `src/execrunner/bundle.ts` does not exist yet, imports fail.

- [ ] **Step 3: Create the bundle factory**

Create `src/execrunner/bundle.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/execrunner/bundle.test.ts`
Expected: PASS — all 5 assertions green.

- [ ] **Step 5: Typecheck + commit**

```bash
npm run check
git add src/execrunner/bundle.ts src/execrunner/bundle.test.ts
git commit -m "$(cat <<'EOF'
phase 11 task 3: add exec bundle factory

buildExecWorkerCode produces a 2-module WorkerCode (main.js wrapper
+ exec.js agent code) with globalOutbound pinned to the user-scoped
HttpGateway. Mirrors buildFacetWorkerCode but without schema.js since
exec isolates don't own SQLite — they reach into the facet via RPC.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Implement the `run_in_sync` tool

**Files:**

- Create: `src/agent/tools/write/run-in-sync.ts`
- Test: `src/agent/tools/write/run-in-sync.test.ts`

- [ ] **Step 1: Create the test file with the first failing test (not_found)**

Create `src/agent/tools/write/run-in-sync.test.ts`:

```ts
import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { runInSyncTool } from "./run-in-sync";
import { createSync } from "../../../db/syncs";
import type { NewSync, SqlTag } from "../../../db/types";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

interface LogEntry {
  level: "log" | "info" | "warn" | "error";
  message: string;
  ts: number;
}
type FakeRunResult =
  | { ok: true; result: unknown; logs: LogEntry[] }
  | {
      ok: false;
      error: string;
      detail?: string;
      stack?: string | null;
      logs: LogEntry[];
    };

interface FakeEntrypoint {
  run: (facet: unknown) => Promise<FakeRunResult>;
}
interface FakeWorkerStub {
  getEntrypoint: () => FakeEntrypoint;
}
interface FakeLoader {
  load: (code: unknown) => FakeWorkerStub;
}
interface FakeFacets {
  get(name: string, cb: () => unknown): unknown;
  abort: (name: string, reason?: unknown) => void;
  delete: (name: string) => void;
}

function installFakeLoader(instance: unknown, loader: FakeLoader): () => void {
  const agentEnv = (instance as { env: Record<string, unknown> }).env;
  const prev = agentEnv.LOADER;
  agentEnv.LOADER = loader;
  return () => {
    agentEnv.LOADER = prev;
  };
}

function installFakeFacets(instance: unknown, facets: FakeFacets): () => void {
  const ctx = (instance as { ctx: { facets?: FakeFacets } }).ctx;
  const prev = ctx.facets;
  ctx.facets = facets;
  return () => {
    ctx.facets = prev;
  };
}

function seedSync(instance: unknown): string {
  const sql = (instance as { sql: SqlTag }).sql.bind(instance) as SqlTag;
  const id = crypto.randomUUID();
  const input: NewSync = {
    id,
    name: `sync-${id.slice(0, 8)}`,
    integration: "linear",
    handler_code:
      "export async function handleWebhook(){ return new Response('ok'); }",
    schema_ddl: "CREATE TABLE IF NOT EXISTS x (id TEXT);",
    filter_description: null,
    webhook_secret: "s",
    upstream_webhook_id: "wh_test_abc",
    code_id: `sync:${id}:v1`
  };
  createSync(sql, input);
  return id;
}

function makeFakeLoader(run: FakeEntrypoint["run"]): FakeLoader {
  return {
    load: () => ({
      getEntrypoint: () => ({ run })
    })
  };
}

const noopFacets: FakeFacets = {
  get: () => ({ fetch: async () => new Response("ok") }),
  abort: () => {},
  delete: () => {}
};

describe("run_in_sync", () => {
  it("returns not_found for an unknown sync_id", async () => {
    const stub = env.ChatAgent.get(env.ChatAgent.idFromName("r-404"));
    await runInDurableObject(stub, async (instance) => {
      await (
        instance as never as { setName: (n: string) => Promise<void> }
      ).setName("r-404");
      const tool = runInSyncTool(instance as never);
      const res = await tool.execute!(
        {
          sync_id: "00000000-0000-0000-0000-000000000000",
          code: "export async function runInSync(){ return 1; }"
        },
        {} as never
      );
      expect(res).toMatchObject({ error: "not_found" });
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/agent/tools/write/run-in-sync.test.ts`
Expected: FAIL — `./run-in-sync` does not exist yet.

- [ ] **Step 3: Implement the tool**

Create `src/agent/tools/write/run-in-sync.ts`:

```ts
import { tool } from "ai";
import { z } from "zod";
import { getSyncById } from "../../../db/syncs";
import { attachFacet } from "../../../facet/loader";
import { buildExecWorkerCode } from "../../../execrunner/bundle";
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
    execute: async ({ sync_id, code }) => {
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

      // The facet stub is passed AS AN RPC ARGUMENT to entrypoint.run(...).
      // Capability-based RPC allows stubs to cross isolate boundaries;
      // the exec code reaches SQLite via facet.__query / facet.__sqlExec.
      const facet = attachFacet(agent.env, agent.ctx.facets, sync, agent.name);

      try {
        const res = await entrypoint.run(facet);

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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/agent/tools/write/run-in-sync.test.ts`
Expected: PASS — the `not_found` test passes.

- [ ] **Step 5: Add the happy-path test**

Append to `src/agent/tools/write/run-in-sync.test.ts`:

```ts
it("happy path: runs code and returns result + logs via fake entrypoint", async () => {
  const stub = env.ChatAgent.get(env.ChatAgent.idFromName("r-happy"));
  await runInDurableObject(stub, async (instance) => {
    await (
      instance as never as { setName: (n: string) => Promise<void> }
    ).setName("r-happy");
    const syncId = seedSync(instance);

    const restoreFacets = installFakeFacets(instance, noopFacets);
    const restoreLoader = installFakeLoader(
      instance,
      makeFakeLoader(async () => ({
        ok: true,
        result: { wrote: 3 },
        logs: [{ level: "log", message: "hello", ts: 1 }]
      }))
    );

    try {
      const tool = runInSyncTool(instance as never);
      const res = (await tool.execute!(
        {
          sync_id: syncId,
          code: "export async function runInSync(){ return { wrote: 3 }; }"
        },
        {} as never
      )) as { ok: true; result: { wrote: number }; logs: LogEntry[] };
      expect(res.ok).toBe(true);
      expect(res.result).toEqual({ wrote: 3 });
      expect(res.logs).toEqual([{ level: "log", message: "hello", ts: 1 }]);
    } finally {
      restoreLoader();
      restoreFacets();
    }
  });
});
```

- [ ] **Step 6: Run to confirm happy test passes**

Run: `npm test -- src/agent/tools/write/run-in-sync.test.ts`
Expected: PASS — both tests green.

- [ ] **Step 7: Add the throw-propagation test**

Append to `src/agent/tools/write/run-in-sync.test.ts`:

```ts
it("propagates exec_failed with logs from a throwing runInSync", async () => {
  const stub = env.ChatAgent.get(env.ChatAgent.idFromName("r-throw"));
  await runInDurableObject(stub, async (instance) => {
    await (
      instance as never as { setName: (n: string) => Promise<void> }
    ).setName("r-throw");
    const syncId = seedSync(instance);

    const restoreFacets = installFakeFacets(instance, noopFacets);
    const restoreLoader = installFakeLoader(
      instance,
      makeFakeLoader(async () => ({
        ok: false,
        error: "exec_failed",
        detail: "boom",
        stack: "Error: boom\n    at runInSync",
        logs: [{ level: "log", message: "step 1", ts: 1 }]
      }))
    );

    try {
      const tool = runInSyncTool(instance as never);
      const res = await tool.execute!(
        {
          sync_id: syncId,
          code: "export async function runInSync(){ console.log('step 1'); throw new Error('boom'); }"
        },
        {} as never
      );
      expect(res).toMatchObject({
        ok: false,
        error: "exec_failed",
        detail: "boom",
        logs: [{ level: "log", message: "step 1", ts: 1 }]
      });
    } finally {
      restoreLoader();
      restoreFacets();
    }
  });
});
```

- [ ] **Step 8: Add the no_export test**

Append:

```ts
it("propagates no_export when the agent's code is missing runInSync", async () => {
  const stub = env.ChatAgent.get(env.ChatAgent.idFromName("r-noexport"));
  await runInDurableObject(stub, async (instance) => {
    await (
      instance as never as { setName: (n: string) => Promise<void> }
    ).setName("r-noexport");
    const syncId = seedSync(instance);

    const restoreFacets = installFakeFacets(instance, noopFacets);
    const restoreLoader = installFakeLoader(
      instance,
      makeFakeLoader(async () => ({
        ok: false,
        error: "no_export",
        detail: "exec.js must export async function runInSync(facet, fetch)",
        logs: []
      }))
    );

    try {
      const tool = runInSyncTool(instance as never);
      const res = await tool.execute!(
        { sync_id: syncId, code: "export const notRunInSync = 1;" },
        {} as never
      );
      expect(res).toMatchObject({
        ok: false,
        error: "no_export",
        logs: []
      });
    } finally {
      restoreLoader();
      restoreFacets();
    }
  });
});
```

- [ ] **Step 9: Add the result-truncation test**

Append:

```ts
it("truncates oversized results and preserves logs", async () => {
  const stub = env.ChatAgent.get(env.ChatAgent.idFromName("r-trunc"));
  await runInDurableObject(stub, async (instance) => {
    await (
      instance as never as { setName: (n: string) => Promise<void> }
    ).setName("r-trunc");
    const syncId = seedSync(instance);

    // Build a payload whose JSON.stringify length is > 64KB.
    const bigArray = Array.from({ length: 5000 }, (_, i) => ({
      id: i,
      filler: "x".repeat(40)
    }));

    const restoreFacets = installFakeFacets(instance, noopFacets);
    const restoreLoader = installFakeLoader(
      instance,
      makeFakeLoader(async () => ({
        ok: true,
        result: bigArray,
        logs: [{ level: "info", message: "dumped rows", ts: 1 }]
      }))
    );

    try {
      const tool = runInSyncTool(instance as never);
      const res = (await tool.execute!(
        {
          sync_id: syncId,
          code: "export async function runInSync(){ return []; }"
        },
        {} as never
      )) as {
        ok: true;
        result: null;
        truncated: true;
        serialized_bytes: number;
        logs: LogEntry[];
      };
      expect(res.ok).toBe(true);
      expect(res.result).toBeNull();
      expect(res.truncated).toBe(true);
      expect(res.serialized_bytes).toBeGreaterThan(64 * 1024);
      expect(res.logs).toEqual([
        { level: "info", message: "dumped rows", ts: 1 }
      ]);
    } finally {
      restoreLoader();
      restoreFacets();
    }
  });
});
```

- [ ] **Step 10: Add the outer-catch test (Worker Loader compile failure)**

Append:

```ts
it("catches Worker Loader compile failures and returns exec_failed with empty logs", async () => {
  const stub = env.ChatAgent.get(env.ChatAgent.idFromName("r-compile"));
  await runInDurableObject(stub, async (instance) => {
    await (
      instance as never as { setName: (n: string) => Promise<void> }
    ).setName("r-compile");
    const syncId = seedSync(instance);

    // Simulate a compile failure surfaced at entrypoint.run() time.
    // Real Workers rejects here when the agent's code has a syntax
    // error; the fake loader mimics that by making run() throw.
    const restoreFacets = installFakeFacets(instance, noopFacets);
    const restoreLoader = installFakeLoader(
      instance,
      makeFakeLoader(async () => {
        throw new Error("Worker Loader: SyntaxError in exec.js");
      })
    );

    try {
      const tool = runInSyncTool(instance as never);
      const res = await tool.execute!(
        {
          sync_id: syncId,
          code: "export async function runInSync() { syntax error here }"
        },
        {} as never
      );
      expect(res).toMatchObject({
        ok: false,
        error: "exec_failed",
        detail: expect.stringMatching(/SyntaxError/),
        logs: []
      });
    } finally {
      restoreLoader();
      restoreFacets();
    }
  });
});
```

- [ ] **Step 11: Run the full test file to confirm all cases pass**

Run: `npm test -- src/agent/tools/write/run-in-sync.test.ts`
Expected: PASS — 6 tests green (not_found, happy, throw, no_export, truncation, compile-fail).

- [ ] **Step 12: Typecheck + commit**

```bash
npm run check
git add src/agent/tools/write/run-in-sync.ts src/agent/tools/write/run-in-sync.test.ts
git commit -m "$(cat <<'EOF'
phase 11 task 4: add run_in_sync tool

Tool loads an exec isolate via env.LOADER.load(buildExecWorkerCode),
calls entrypoint.run(facetStub), and returns { ok, result | error,
logs }. Approval-gated. 64KB result cap with { result: null,
truncated: true, serialized_bytes } on overflow. Outer try/catch
handles Worker Loader compile failures.

Tests cover: not_found, happy path, throw propagation with logs,
no_export, result truncation, compile-failure outer catch. All
tests use a fake LOADER + fake ctx.facets so they don't depend on
Worker Loader API availability in the workerd test runtime.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Register the tool and update the system prompt

**Files:**

- Modify: `src/agent/tools/index.ts`
- Modify: `src/agent/system-prompt.ts`

- [ ] **Step 1: Register `run_in_sync` in `buildTools`**

Edit `src/agent/tools/index.ts`:

```ts
import { listSyncsTool } from "./read/list-syncs";
import { getSyncTool } from "./read/get-sync";
import { getSyncErrorsTool } from "./read/get-sync-errors";
import { querySyncTool } from "./read/query-sync";
import { webSearchTool } from "./read/web-search";
import { createSyncTool } from "./write/create-sync";
import { deleteSyncTool } from "./write/delete-sync";
import { runInSyncTool } from "./write/run-in-sync";
import type { ChatAgent } from "../../server";

/**
 * Build the tool map passed to streamText. Each tool factory takes
 * the agent instance so tools can read/write the supervisor SQLite
 * and reach the env bindings (ANTHROPIC_API_KEY, PARALLEL_API_KEY).
 *
 * Write tools added progressively from Phase 08 onwards:
 * - create_sync (Phase 08, live)
 * - delete_sync (Phase 10, live)
 * - run_in_sync (Phase 11, live)
 * - update_sync (later phase)
 */
export function buildTools(agent: ChatAgent) {
  return {
    list_syncs: listSyncsTool(agent),
    get_sync: getSyncTool(agent),
    get_sync_errors: getSyncErrorsTool(agent),
    query_sync: querySyncTool(agent),
    web_search: webSearchTool(agent),
    create_sync: createSyncTool(agent),
    delete_sync: deleteSyncTool(agent),
    run_in_sync: runInSyncTool(agent)
  };
}
```

- [ ] **Step 2: Update the system prompt — add `run_in_sync` to the write-tools list**

Edit `src/agent/system-prompt.ts`. Locate the "Write tools (available)" block (around lines 23-25) and add a new bullet after `delete_sync`:

```ts
Write tools (available):
- \`create_sync(name, integration, resource_types, schema_ddl, handler_code, filter_description?)\` — registers a webhook with the upstream, spins up an isolated facet with its own SQLite, persists the sync registry row. Approval-gated — the user sees your proposed schema + handler in an approval dialog before it runs.
- \`delete_sync(sync_id)\` — removes a sync: unregisters the upstream webhook, drops the facet + its SQLite, deletes the registry row and error history. Destructive and irreversible. Approval-gated. Use when the user asks to delete, remove, or unsubscribe a sync.
- \`run_in_sync(sync_id, code)\` — runs agent-authored one-shot code in an isolated runtime scoped to the sync. Use for backfill (pull history from the upstream), diagnostics (queries the read path can't express), and data repair. Code must export \`async function runInSync(facet, fetch)\`. facet exposes \`__query(sql)\` and \`__sqlExec(sql, ...bindings)\`. fetch goes through the same auth proxy handler.js uses (upstream token injected automatically). \`console.log/info/warn/error\` are captured and returned alongside the result — use them for debuggability, especially around \`fetch\` and \`__sqlExec\` calls. Approval-gated.

Still-unavailable write tools (coming in later phases): \`update_sync\`. If asked to update, acknowledge and say that's coming.
```

- [ ] **Step 3: Update the system prompt — add a "run_in_sync contract" section**

In `src/agent/system-prompt.ts`, after the existing "### handler_code contract" section and before "### schema_ddl contract", insert a new subsection:

```ts
### run_in_sync contract

The exec module you generate MUST export a function named \`runInSync\`:

\`\`\`ts
export async function runInSync(facet, fetch) {
  // Read: await facet.__query("SELECT ...")           → { ok: true, rows } | { ok: false, error }
  // Write: await facet.__sqlExec("INSERT ...", ...args) → { ok: true, rowsWritten, rowsRead } | { ok: false, error }
  // Network: fetch("https://api.linear.app/graphql", { ... })  — proxy injects the token
  // Return: anything JSON-serializable. Caller receives it as \`result\`.
}
\`\`\`

- Keep runs under 30s (Workers wall-time per RPC call). Chunk long backfills: store \`last_synced_at\` in a side table and call \`run_in_sync\` repeatedly.
- Writes must be idempotent (INSERT OR REPLACE, ON CONFLICT) — a retry is always possible.
- **Log liberally.** \`console.log / .info / .warn / .error\` are captured (last 200 entries, 2KB per message) and returned alongside the result — including on failure. Log before/after each \`fetch\` and \`__sqlExec\` boundary so a failing run is debuggable from the return value alone.
- Don't \`import\` anything beyond runtime globals (\`fetch\`, \`crypto\`, \`Response\`, etc.). No npm packages.
- Result is capped at 64KB JSON. If yours exceeds that you'll see \`{ ok: true, result: null, truncated: true, serialized_bytes }\` — retry with aggregates or paging.
- Error shapes on failure: \`{ ok: false, error: "exec_failed" | "no_export", detail, stack?, logs }\`. Read the logs to diagnose.

Use \`run_in_sync\` when:
- The user asks for historical data the handler hasn't captured (backfill).
- A query the read path can't express (no parameter binding, no update path).
- A row needs repair after a bad handler version (data fix).
```

- [ ] **Step 4: Update the system prompt — remove `run_in_sync` from the "What's out of scope" list**

In `src/agent/system-prompt.ts`, in the `## What's out of scope` section, delete the bullet that says:

```
- You cannot run ad-hoc code in a facet yet (\`run_in_sync\`).
```

Keep the existing `- You cannot update syncs yet ...` bullet — `update_sync` is still out of scope.

Verify the resulting list has exactly three bullets: update-syncs-not-available, Linear-only, no-autonomous-schedule.

```bash
grep -n "cannot update\|cannot run ad-hoc\|cannot handle any integration\|run autonomously" src/agent/system-prompt.ts
```

Expected: four matching lines — the update-syncs, Linear-only, and no-autonomous bullets (3 in the out-of-scope section), plus any incidental earlier mentions of "update". No line containing "cannot run ad-hoc" should remain.

- [ ] **Step 5: Run the full test suite to confirm nothing regressed**

Run: `npm run check`
Expected: format clean, lint clean, tsc clean, all vitest tests green (including the new Task 1-4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/agent/tools/index.ts src/agent/system-prompt.ts
git commit -m "$(cat <<'EOF'
phase 11 task 5: register run_in_sync in buildTools + update system prompt

Tool is now wired into the AI SDK's tool map. System prompt documents
the runInSync(facet, fetch) contract, logging guidance, 30s wall-time
tip, 64KB result cap, and removes run_in_sync from the unavailable
list. update_sync is now the only remaining write tool out-of-scope.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Manual end-to-end smoke test

**Files:** none (manual test against a live Cloudflare dev runtime)

- [ ] **Step 1: Start the dev server**

```bash
npm run dev
```

Wait for Vite + wrangler dev to come up. Note the local URL printed (usually `http://localhost:5173`).

- [ ] **Step 2: Open the chat UI and confirm an existing sync is present**

Open the local URL in a browser. If there's no Linear sync yet, create one via chat: "create a sync for Linear issues" and approve.

Verify via: "list my syncs" — should show at least one sync with a UUID.

- [ ] **Step 3: Exercise a simple diagnostic run**

In chat: "run this against the Linear issues sync: count how many rows are in the issues table and return the number"

The agent should propose `run_in_sync` with code along these lines:

```js
export async function runInSync(facet, fetch) {
  console.log("about to query issues count");
  const res = await facet.__query("SELECT COUNT(*) AS c FROM issues");
  if (!res.ok) {
    console.error("query failed", res.error);
    return { error: res.error };
  }
  console.log("got rows", res.rows);
  return { count: res.rows[0].c };
}
```

Approve the tool call. Verify the response includes a `result` with the count AND a `logs` array with the expected messages.

- [ ] **Step 4: Exercise a backfill-style run (fetch + sqlExec)**

This depends on what integration is set up; if Linear is live, prompt: "run this against the Linear issues sync: fetch the 5 most recently updated issues via Linear's GraphQL API and INSERT OR REPLACE them into the issues table. Log each step."

Agent should generate code using `fetch("https://api.linear.app/graphql", ...)` and `facet.__sqlExec(...)`. Approve and verify:

- The agent's returned `result` reports rows written.
- `logs` array contains entries from each step.
- Immediately after, `query_sync` on that sync returns the newly-written rows.

- [ ] **Step 5: Exercise a failure path for log surfacing**

In chat: "run code that throws an error after logging 'step 1'"

Agent should propose code like:

```js
export async function runInSync() {
  console.log("step 1");
  throw new Error("intentional failure");
}
```

Approve. The tool result should show `{ ok: false, error: "exec_failed", detail: "intentional failure", stack, logs: [{ level: "log", message: "step 1", ... }] }` — the log BEFORE the throw must be present.

- [ ] **Step 6: Confirm webhook delivery still works during/after the runs**

Modify an issue in Linear (change its title). Wait a few seconds, then `query_sync` for that issue — the updated title should be reflected. This proves the live facet was never disturbed by exec activity.

- [ ] **Step 7: Stop the dev server.** Nothing to commit — this is a validation task.

If any step fails, capture the exact error/log output and diagnose before proceeding. Don't mark the task complete on partial success.

---

## Spec coverage checklist (self-review)

Every spec section must point at a task. If a gap is found, add a task.

| Spec section                                                                              | Covered by                                                                                                      |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| §4.1 Exec wrapper source (EXEC_WRAPPER_SOURCE + log capture)                              | Task 2                                                                                                          |
| §4.2 `buildExecWorkerCode`                                                                | Task 3                                                                                                          |
| §4.3 Facet wrapper `__sqlExec` addition                                                   | Task 1                                                                                                          |
| §4.4 Tool implementation (runInSyncTool) + types + RESULT_CAP                             | Task 4 (types and RESULT_CAP at top of file, tool body in execute)                                              |
| §4.5 System prompt updates                                                                | Task 5 (steps 2-4)                                                                                              |
| §4.6 No supervisor DB migration                                                           | n/a by design                                                                                                   |
| §5 Data flow                                                                              | Covered implicitly by Task 4's execute body                                                                     |
| §6 Error handling table (not_found / no_export / exec_failed / truncation / compile-fail) | Task 4 (tests + implementation)                                                                                 |
| §7 Security (isolation, gateway, SQL scope, cross-sync, approval)                         | Task 3 (globalOutbound), Task 4 (needsApproval, single facet stub), Task 1 (`__sqlExec` is supervisor-only RPC) |
| §8.1 Facet wrapper tests for `__sqlExec`                                                  | Task 1 (string-match) — runtime behaviour verified in Task 6 smoke                                              |
| §8.2 Tool tests (happy / not_found / throws / no_export / truncation / compile-fail)      | Task 4                                                                                                          |
| §8.3 Manual smoke                                                                         | Task 6                                                                                                          |
| §9 Integration points (buildTools registration, context.ts unchanged)                     | Task 5 (step 1)                                                                                                 |
| §10 Decision log                                                                          | Informational — no task                                                                                         |
| §11 Out-of-scope (Phase 12)                                                               | Informational — no task                                                                                         |
| §12 V2 upgrade paths (Tail Workers)                                                       | Informational — no task                                                                                         |

All spec sections accounted for.
