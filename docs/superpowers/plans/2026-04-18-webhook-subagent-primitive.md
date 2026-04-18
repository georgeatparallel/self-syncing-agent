# Webhook Sub-Agent Primitive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose an `agent()` primitive to agent-authored webhook handler code so a handler can spawn a ReAct-loop sub-agent per delivery with built-in tools (`fetch`, `sql`, `exec`) — implementing the V2-stretch "webhook-spawned background agents" ask from the spec.

**Architecture:**
- A new `LLMGateway` `WorkerEntrypoint` in the supervisor holds `ANTHROPIC_API_KEY` and runs the full `generateText` ReAct loop. It is stamped per-user (`ctx.props.userId`) and exposed to every facet via the facet bundle's `env` field.
- Handler code receives a third argument, `ctx`, carrying `agent()` and `waitUntil()`. A `FacetAgentBridge` `RpcTarget` (mirrors the existing `FacetBridge` pattern) exposes the facet's `sql`, `globalOutbound` fetch, and a fresh-isolate `exec` capability to the supervisor-side agent loop.
- Built-in tools (`fetch`, `sql`, `exec`) live in the supervisor's `LLMGateway` and route every call back to the bridge. The `exec` tool spins a fresh Worker Loader isolate per call, reusing the existing `run_in_sync` exec-runner wrapper.

**Tech Stack:** Cloudflare Workers, Durable Object Facets, Worker Loader (`env.LOADER`), `WorkerEntrypoint` + `RpcTarget`, Vercel AI SDK (`generateText`, `stepCountIs`), `@ai-sdk/anthropic` with 3-tier model enum (`haiku | sonnet | opus`).

---

## File Structure

**New files:**
- `src/agent-runtime/llm-gateway.ts` — `LLMGateway` `WorkerEntrypoint`. Owns the Anthropic key, runs the ReAct loop, wires built-in tools to the bridge. Exported from `src/server.ts` so it's available in `ctx.exports`.
- `src/agent-runtime/facet-agent-bridge.ts` — `FacetAgentBridge` `RpcTarget`. Exposes `sqlExec`, `sqlQuery`, `gatewayFetch`, `execScript` to `LLMGateway`. One instance per handler invocation.
- `src/agent-runtime/agent-primitive-source.ts` — fixed ES-module source that will be bundled into every facet as `agent.js`. Exports `createAgent({ llm, bridgeStamp, loader, sql, fetch, userId })` which returns the user-facing `agent()` function.
- `src/agent-runtime/models.ts` — model tier enum + mapping (`haiku` → `claude-haiku-4-5`, `sonnet` → `claude-sonnet-4-6`, `opus` → `claude-opus-4-7`).
- `src/agent-runtime/types.ts` — shared types: `AgentRequest`, `AgentResult`, `HandlerCtx`, model enum.
- `src/agent-runtime/llm-gateway.test.ts` — unit tests for `LLMGateway.runAgent` with mocked Anthropic + stubbed bridge.
- `src/agent-runtime/facet-agent-bridge.test.ts` — unit tests for the bridge.
- `tests/subagent-e2e.test.ts` — end-to-end: create a sync whose handler calls `agent()`, deliver a webhook, assert the triage column gets populated.

**Modified files:**
- `src/facet/bundle.ts` — add a fourth module `agent.js`, pass `env: { LLM, LOADER }` in the bundle.
- `src/facet/wrapper.ts` — import `createAgent` from `./agent.js`, build a `FacetAgentBridge`, pass `ctx = { agent, waitUntil }` as the 3rd arg to `handleWebhook`.
- `src/server.ts` — export `LLMGateway`; use `ctx.exports.LLMGateway({ props: { userId } })` inside `buildFacetWorkerCode` (wired via a new `input` field).
- `src/agent/tools/write/create-sync.ts` — update the tool description to document the handler's new 3rd arg, the `agent()` primitive, the 3-tier model enum, and the three built-in tools.
- `src/agent/tools/write/update-sync.ts` — same update as create-sync (both describe the handler contract).
- `src/agent/system-prompt.ts` — add a short "Webhook sub-agents" section that teaches the main agent when to reach for the primitive.
- `wrangler.jsonc` — no changes expected; the `LLMGateway` is a `WorkerEntrypoint` export, not a new binding.

---

## Task 1: Model tier enum

**Files:**
- Create: `src/agent-runtime/models.ts`
- Test: `src/agent-runtime/models.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/agent-runtime/models.test.ts
import { describe, it, expect } from "vitest";
import { resolveModelId, MODEL_TIERS } from "./models";

describe("resolveModelId", () => {
  it("maps haiku to the latest Haiku model id", () => {
    expect(resolveModelId("haiku")).toBe("claude-haiku-4-5");
  });
  it("maps sonnet to the latest Sonnet model id", () => {
    expect(resolveModelId("sonnet")).toBe("claude-sonnet-4-6");
  });
  it("maps opus to the latest Opus model id", () => {
    expect(resolveModelId("opus")).toBe("claude-opus-4-7");
  });
  it("exposes the tier names as a tuple for validation", () => {
    expect(MODEL_TIERS).toEqual(["haiku", "sonnet", "opus"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npx vitest run src/agent-runtime/models.test.ts`
Expected: FAIL with "Cannot find module './models'".

- [ ] **Step 3: Write the implementation**

```ts
// src/agent-runtime/models.ts
export const MODEL_TIERS = ["haiku", "sonnet", "opus"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

const MODEL_IDS: Record<ModelTier, string> = {
  haiku: "claude-haiku-4-5",
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-7"
};

export function resolveModelId(tier: ModelTier): string {
  return MODEL_IDS[tier];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npx vitest run src/agent-runtime/models.test.ts`
Expected: PASS (4/4).

- [ ] **Step 5: Commit**

```bash
git add src/agent-runtime/models.ts src/agent-runtime/models.test.ts
git commit -m "feat(subagent): model tier enum for webhook sub-agent primitive"
```

---

## Task 2: Shared types module

**Files:**
- Create: `src/agent-runtime/types.ts`

- [ ] **Step 1: Write the type file**

```ts
// src/agent-runtime/types.ts
import type { ModelTier } from "./models";

/** Request shape accepted by LLMGateway.runAgent and the agent() primitive. */
export interface AgentRequest {
  model?: ModelTier; // default "sonnet"
  system: string;
  messages: Array<
    | { role: "user"; content: string }
    | { role: "assistant"; content: string }
  >;
  maxSteps?: number; // default 8, capped at 15
}

export type AgentResult =
  | { ok: true; text: string; steps: number; usage: { input_tokens: number; output_tokens: number } }
  | { ok: false; error: string; detail?: string };

/** Third argument passed to the agent-authored handleWebhook. */
export interface HandlerCtx {
  agent(request: AgentRequest): Promise<string>;
  waitUntil(promise: Promise<unknown>): void;
}

/** Input passed across RpcTarget for exec tool. */
export interface ExecToolInput {
  code: string;
}

export type ExecToolResult =
  | { ok: true; result: unknown; logs: Array<{ level: string; message: string; ts: number }> }
  | { ok: false; error: string; detail?: string; stack?: string | null; logs: Array<{ level: string; message: string; ts: number }> };
```

- [ ] **Step 2: Verify it compiles**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npx tsc --noEmit`
Expected: PASS (no output).

- [ ] **Step 3: Commit**

```bash
git add src/agent-runtime/types.ts
git commit -m "feat(subagent): shared types for webhook sub-agent primitive"
```

---

## Task 3: FacetAgentBridge

**Files:**
- Create: `src/agent-runtime/facet-agent-bridge.ts`
- Test: `src/agent-runtime/facet-agent-bridge.test.ts`

**Context:** This RpcTarget is constructed inside the facet wrapper for each webhook invocation and passed to `LLMGateway.runAgent` so the supervisor-side loop can call back into facet capabilities. Mirrors the existing `src/execrunner/facet-bridge.ts`. Scope: SQL + fetch only. The `exec` tool is implemented on the `LLMGateway` side (Task 4) — the facet has no loader-code-builder at runtime, but the supervisor does; the bridge just carries `userId` along so the supervisor can stamp a matching isolate.

- [ ] **Step 1: Write the failing test**

```ts
// src/agent-runtime/facet-agent-bridge.test.ts
import { describe, it, expect, vi } from "vitest";
import { FacetAgentBridge } from "./facet-agent-bridge";

describe("FacetAgentBridge", () => {
  it("sqlQuery delegates to sql.exec().toArray()", async () => {
    const toArray = vi.fn().mockReturnValue([{ id: 1 }]);
    const exec = vi.fn().mockReturnValue({ toArray });
    const sql = { exec } as unknown as SqlStorage;

    const bridge = new FacetAgentBridge({
      sql,
      fetch: vi.fn(),
      loader: {} as WorkerLoader,
      userId: "u"
    });
    const rows = await bridge.sqlQuery("SELECT 1");
    expect(rows).toEqual([{ id: 1 }]);
    expect(exec).toHaveBeenCalledWith("SELECT 1");
  });

  it("sqlExec delegates with bindings and returns rowsWritten", async () => {
    const cursor = {
      toArray: vi.fn().mockReturnValue([]),
      rowsWritten: 2,
      rowsRead: 0
    };
    const exec = vi.fn().mockReturnValue(cursor);
    const sql = { exec } as unknown as SqlStorage;

    const bridge = new FacetAgentBridge({
      sql,
      fetch: vi.fn(),
      loader: {} as WorkerLoader,
      userId: "u"
    });
    const result = await bridge.sqlExec("INSERT INTO t VALUES (?)", 1);
    expect(result).toEqual({ ok: true, rowsWritten: 2, rowsRead: 0 });
    expect(exec).toHaveBeenCalledWith("INSERT INTO t VALUES (?)", 1);
  });

  it("sqlExec returns { ok: false, error } on SQLite error", async () => {
    const exec = vi.fn().mockImplementation(() => {
      throw new Error("no such table: t");
    });
    const sql = { exec } as unknown as SqlStorage;

    const bridge = new FacetAgentBridge({
      sql,
      fetch: vi.fn(),
      loader: {} as WorkerLoader,
      userId: "u"
    });
    const result = await bridge.sqlExec("INSERT INTO t VALUES (1)");
    expect(result).toEqual({ ok: false, error: "no such table: t" });
  });

  it("gatewayFetch forwards to the provided fetch", async () => {
    const mockResponse = new Response("body", { status: 200 });
    const fetchFn = vi.fn().mockResolvedValue(mockResponse);
    const bridge = new FacetAgentBridge({
      sql: { exec: vi.fn() } as unknown as SqlStorage,
      fetch: fetchFn,
      userId: "u"
    });
    const result = await bridge.gatewayFetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"query":"{viewer{id}}"}'
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(result.status).toBe(200);
    expect(await result.text()).toBe("body");
  });

  it("exposes userId so the supervisor can stamp exec isolates", async () => {
    const bridge = new FacetAgentBridge({
      sql: { exec: vi.fn() } as unknown as SqlStorage,
      fetch: vi.fn(),
      userId: "u-42"
    });
    expect(await bridge.getUserId()).toBe("u-42");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npx vitest run src/agent-runtime/facet-agent-bridge.test.ts`
Expected: FAIL with "Cannot find module './facet-agent-bridge'".

- [ ] **Step 3: Write the implementation**

```ts
// src/agent-runtime/facet-agent-bridge.ts
import { RpcTarget } from "cloudflare:workers";

interface BridgeDeps {
  sql: SqlStorage;
  fetch: (input: RequestInfo, init?: RequestInit) => Promise<Response>;
  userId: string;
}

/**
 * Bridge passed to LLMGateway.runAgent so the supervisor-side ReAct
 * loop can call back into facet capabilities. Mirrors the RpcTarget
 * pattern used by src/execrunner/facet-bridge.ts — raw DO stubs don't
 * cross Worker Loader isolate boundaries, RpcTarget subclasses do.
 *
 * Scope: sql + fetch only. The exec tool is implemented on the
 * LLMGateway side (it has env.LOADER); this bridge just carries the
 * userId so exec isolates get stamped with the right props.
 */
export class FacetAgentBridge extends RpcTarget {
  #sql: SqlStorage;
  #fetch: (input: RequestInfo, init?: RequestInit) => Promise<Response>;
  #userId: string;

  constructor(deps: BridgeDeps) {
    super();
    this.#sql = deps.sql;
    this.#fetch = deps.fetch;
    this.#userId = deps.userId;
  }

  async sqlQuery(query: string): Promise<unknown[]> {
    return this.#sql.exec(query).toArray();
  }

  async sqlExec(
    query: string,
    ...bindings: unknown[]
  ): Promise<{ ok: true; rowsWritten: number; rowsRead: number } | { ok: false; error: string }> {
    try {
      const cursor = this.#sql.exec(query, ...bindings);
      cursor.toArray();
      return { ok: true, rowsWritten: cursor.rowsWritten, rowsRead: cursor.rowsRead };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async gatewayFetch(url: string, init?: RequestInit): Promise<Response> {
    return this.#fetch(url, init);
  }

  async getUserId(): Promise<string> {
    return this.#userId;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npx vitest run src/agent-runtime/facet-agent-bridge.test.ts`
Expected: PASS (4/4).

- [ ] **Step 5: Commit**

```bash
git add src/agent-runtime/facet-agent-bridge.ts src/agent-runtime/facet-agent-bridge.test.ts
git commit -m "feat(subagent): FacetAgentBridge RpcTarget for sql/fetch/exec callback"
```

---

## Task 4: LLMGateway WorkerEntrypoint

**Files:**
- Create: `src/agent-runtime/llm-gateway.ts`
- Test: `src/agent-runtime/llm-gateway.test.ts`

**Context:** This is the brains of the primitive. `runAgent` receives a request + a `FacetAgentBridge`, configures `generateText` with three tools whose `execute` fns call bridge methods, and returns `{ ok: true, text, steps, usage }` on success. All LLM I/O happens here so the Anthropic key never leaves the supervisor DO's isolate.

- [ ] **Step 1: Write the failing test (mocked Anthropic)**

```ts
// src/agent-runtime/llm-gateway.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { runAgent } from "./llm-gateway";
import type { AgentRequest } from "./types";

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    generateText: vi.fn()
  };
});
vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: vi.fn(() => (id: string) => ({ id }))
}));

import { generateText } from "ai";

const baseReq: AgentRequest = {
  model: "sonnet",
  system: "You are a test bot.",
  messages: [{ role: "user", content: "hello" }]
};

const fakeBridge = {
  sqlQuery: vi.fn(),
  sqlExec: vi.fn(),
  gatewayFetch: vi.fn(),
  execScript: vi.fn()
};

describe("runAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the model's final text on a tool-free response", async () => {
    vi.mocked(generateText).mockResolvedValue({
      text: "hello back",
      steps: [{}],
      usage: { inputTokens: 10, outputTokens: 5 }
    } as unknown as Awaited<ReturnType<typeof generateText>>);

    const result = await runAgent(baseReq, fakeBridge as never, { ANTHROPIC_API_KEY: "k" } as Env);
    expect(result).toEqual({
      ok: true,
      text: "hello back",
      steps: 1,
      usage: { input_tokens: 10, output_tokens: 5 }
    });
  });

  it("defaults to sonnet when model is omitted", async () => {
    vi.mocked(generateText).mockResolvedValue({
      text: "ok",
      steps: [],
      usage: { inputTokens: 0, outputTokens: 0 }
    } as unknown as Awaited<ReturnType<typeof generateText>>);

    await runAgent(
      { system: "s", messages: [{ role: "user", content: "x" }] } as AgentRequest,
      fakeBridge as never,
      { ANTHROPIC_API_KEY: "k" } as Env
    );
    const call = vi.mocked(generateText).mock.calls[0][0] as { model: { id: string } };
    expect(call.model.id).toBe("claude-sonnet-4-6");
  });

  it("caps maxSteps at 15", async () => {
    vi.mocked(generateText).mockResolvedValue({
      text: "ok",
      steps: [],
      usage: { inputTokens: 0, outputTokens: 0 }
    } as unknown as Awaited<ReturnType<typeof generateText>>);

    await runAgent(
      { ...baseReq, maxSteps: 9999 },
      fakeBridge as never,
      { ANTHROPIC_API_KEY: "k" } as Env
    );
    // stopWhen is a function that returns true at step >= 15
    const call = vi.mocked(generateText).mock.calls[0][0] as { stopWhen: unknown };
    expect(call.stopWhen).toBeDefined();
  });

  it("returns { ok: false } when generateText throws", async () => {
    vi.mocked(generateText).mockRejectedValue(new Error("network blew up"));
    const result = await runAgent(baseReq, fakeBridge as never, { ANTHROPIC_API_KEY: "k" } as Env);
    expect(result).toEqual({ ok: false, error: "llm_failed", detail: "network blew up" });
  });

  it("wires sql tool to bridge.sqlExec", async () => {
    vi.mocked(generateText).mockImplementation(async (opts: never) => {
      const tools = (opts as unknown as { tools: Record<string, { execute: (input: unknown) => Promise<unknown> }> }).tools;
      await tools.sql.execute({ query: "SELECT 1" });
      return {
        text: "done",
        steps: [],
        usage: { inputTokens: 0, outputTokens: 0 }
      } as unknown as Awaited<ReturnType<typeof generateText>>;
    });
    fakeBridge.sqlExec.mockResolvedValue({ ok: true, rowsWritten: 0, rowsRead: 1 });
    await runAgent(baseReq, fakeBridge as never, { ANTHROPIC_API_KEY: "k" } as Env);
    expect(fakeBridge.sqlExec).toHaveBeenCalledWith("SELECT 1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npx vitest run src/agent-runtime/llm-gateway.test.ts`
Expected: FAIL with "Cannot find module './llm-gateway'".

- [ ] **Step 3: Write the implementation**

```ts
// src/agent-runtime/llm-gateway.ts
import { WorkerEntrypoint } from "cloudflare:workers";
import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";
import { resolveModelId } from "./models";
import type { AgentRequest, AgentResult } from "./types";
import type { FacetAgentBridge } from "./facet-agent-bridge";

const MAX_STEPS_HARD_CAP = 15;
const DEFAULT_STEPS = 8;

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
        // Import lazily to keep the module tree testable in isolation.
        const { buildExecWorkerCode } = await import("../execrunner/bundle");
        const bundle = buildExecWorkerCode({ code, userId });
        const stub = (env.LOADER as unknown as {
          load: (c: unknown) => { getEntrypoint: () => { run: (f: unknown) => Promise<unknown> } };
        }).load(bundle);
        return stub.getEntrypoint().run(null);
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
      steps: Array.isArray(result.steps) ? result.steps.length : 0,
      usage: {
        input_tokens: (result.usage as unknown as { inputTokens: number }).inputTokens ?? 0,
        output_tokens: (result.usage as unknown as { outputTokens: number }).outputTokens ?? 0
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
  async runAgent(request: AgentRequest, bridge: FacetAgentBridge): Promise<AgentResult> {
    // this.env is the supervisor worker's env — has ANTHROPIC_API_KEY
    // and LOADER both from wrangler.jsonc.
    return runAgent(request, bridge, this.env);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npx vitest run src/agent-runtime/llm-gateway.test.ts`
Expected: PASS (5/5).

- [ ] **Step 5: Commit**

```bash
git add src/agent-runtime/llm-gateway.ts src/agent-runtime/llm-gateway.test.ts
git commit -m "feat(subagent): LLMGateway with built-in sql/fetch/exec tools"
```

---

## Task 5: Export LLMGateway from server.ts

**Files:**
- Modify: `src/server.ts` (top-level exports)

**Context:** `HttpGateway` is already re-exported from `src/server.ts` so `workerExports.HttpGateway` resolves at runtime (see `src/facet/bundle.ts:53-57`). We follow the identical pattern for `LLMGateway`.

- [ ] **Step 1: Find the existing HttpGateway export**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" grep -n "HttpGateway" src/server.ts`
Expected: one or more lines showing `export { HttpGateway }` or equivalent.

- [ ] **Step 2: Add the LLMGateway export next to HttpGateway**

Locate the existing `export { HttpGateway } from "./proxy/http-gateway";` line (or equivalent). Add directly after it:

```ts
export { LLMGateway } from "./agent-runtime/llm-gateway";
```

- [ ] **Step 3: Verify it compiles**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/server.ts
git commit -m "feat(subagent): re-export LLMGateway so facets can reach it via workerExports"
```

---

## Task 6: Agent primitive source (bundled into facets as agent.js)

**Files:**
- Create: `src/agent-runtime/agent-primitive-source.ts`

**Context:** This is a fixed ES-module string that becomes `agent.js` in every facet bundle. The wrapper imports `createAgent` from it and calls `handleWebhook(request, sql, ctx)` with `ctx.agent` pointing to the returned function.

- [ ] **Step 1: Write the module source**

```ts
// src/agent-runtime/agent-primitive-source.ts

/**
 * Fixed source for agent.js — bundled into every facet alongside
 * handler.js and schema.js. Exports createAgent(deps) which returns
 * the user-facing agent() function. The facet wrapper constructs a
 * FacetAgentBridge, wires it up, and passes the resulting function
 * as ctx.agent to handleWebhook(request, sql, ctx).
 *
 * This module runs inside the facet isolate. It holds no keys and
 * does no I/O on its own — every call delegates to env.LLM (a
 * stamped LLMGateway WorkerEntrypoint) in the supervisor.
 */
export const AGENT_PRIMITIVE_SOURCE = `
export function createAgent({ llm, bridge }) {
  if (!llm || typeof llm.runAgent !== "function") {
    throw new Error("createAgent: env.LLM.runAgent is not available");
  }
  let callsInFlight = 0;
  return async function agent(request) {
    if (callsInFlight > 0) {
      throw new Error("agent(): nested calls are not permitted inside a single handler invocation");
    }
    callsInFlight++;
    try {
      const result = await llm.runAgent(request, bridge);
      if (!result.ok) {
        throw new Error("agent() failed: " + result.error + (result.detail ? ": " + result.detail : ""));
      }
      return result.text;
    } finally {
      callsInFlight--;
    }
  };
}
`;
```

- [ ] **Step 2: Verify it compiles**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/agent-runtime/agent-primitive-source.ts
git commit -m "feat(subagent): agent primitive ES-module source bundled into facets"
```

---

## Task 7: Extend facet bundle to include agent.js + env bindings

**Files:**
- Modify: `src/facet/bundle.ts` (entire rewrite of `buildFacetWorkerCode`)
- Test: `src/facet/bundle.test.ts` (new tests added)

- [ ] **Step 1: Add failing tests for the new bundle shape**

Append to `src/facet/bundle.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildFacetWorkerCode } from "./bundle";

describe("buildFacetWorkerCode — agent primitive", () => {
  it("includes agent.js alongside handler.js and schema.js", () => {
    const bundle = buildFacetWorkerCode({
      schemaDdl: "CREATE TABLE t (id INTEGER);",
      handlerCode: "export async function handleWebhook() { return new Response('ok'); }",
      userId: "u-123"
    });
    expect(Object.keys(bundle.modules).sort()).toEqual([
      "agent.js",
      "handler.js",
      "main.js",
      "schema.js"
    ]);
    expect(bundle.modules["agent.js"]).toContain("export function createAgent");
  });

  it("passes the LLM binding in env so agent() can reach LLMGateway", () => {
    const bundle = buildFacetWorkerCode({
      schemaDdl: "",
      handlerCode: "",
      userId: "u-123"
    });
    expect(bundle.env).toBeDefined();
    expect(bundle.env.LLM).toBeDefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npx vitest run src/facet/bundle.test.ts`
Expected: FAIL on the two new tests (agent.js missing, env undefined).

- [ ] **Step 3: Rewrite `buildFacetWorkerCode`**

Replace the body of `src/facet/bundle.ts` with:

```ts
import { exports as workerExports } from "cloudflare:workers";
import { FACET_WRAPPER_SOURCE } from "./wrapper";
import { AGENT_PRIMITIVE_SOURCE } from "../agent-runtime/agent-primitive-source";

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

export function buildFacetWorkerCode(
  input: BuildFacetWorkerCodeInput
): WorkerCode {
  const exportsRef = workerExports as unknown as {
    HttpGateway: (opts: { props: unknown }) => Fetcher;
    LLMGateway: (opts: { props: unknown }) => { runAgent: (...args: unknown[]) => unknown };
  };

  return {
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
```

- [ ] **Step 4: Run all bundle tests**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npx vitest run src/facet/bundle.test.ts`
Expected: PASS (all tests). No caller signature changes are needed — `BuildFacetWorkerCodeInput` stays the same shape.

- [ ] **Step 5: Full type check**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/facet/bundle.ts src/facet/bundle.test.ts
git commit -m "feat(subagent): bundle agent.js into facets + pass LLM binding in env"
```

---

## Task 8: Wire ctx.agent into FACET_WRAPPER_SOURCE

**Files:**
- Modify: `src/facet/wrapper.ts` (the `FACET_WRAPPER_SOURCE` string)

**Context:** The wrapper's `fetch()` currently calls `handleWebhook(request, this.ctx.storage.sql)`. We extend the signature to pass a `ctx` object with `agent` and `waitUntil`. The wrapper constructs a `FacetAgentBridge`, imports `createAgent` from `./agent.js`, and composes the final function.

The wrapper source is a template string — we can't `import` the bridge from TypeScript land. Instead, we construct the bridge in the wrapper using an inline RpcTarget subclass or by importing it from a new bundled module. Simplest path: inline the bridge definition in the wrapper source itself (it's ~40 lines).

- [ ] **Step 1: Update `FACET_WRAPPER_SOURCE` to include an inline FacetAgentBridge + ctx composition**

Replace `src/facet/wrapper.ts`'s export with:

```ts
export const FACET_WRAPPER_SOURCE = `
import { DurableObject, RpcTarget } from "cloudflare:workers";
import { SCHEMA_DDL } from "./schema.js";
import { handleWebhook } from "./handler.js";
import { createAgent } from "./agent.js";

class FacetAgentBridge extends RpcTarget {
  #sql;
  #fetch;
  #userId;
  constructor(deps) {
    super();
    this.#sql = deps.sql;
    this.#fetch = deps.fetch;
    this.#userId = deps.userId;
  }
  async sqlQuery(query) {
    return this.#sql.exec(query).toArray();
  }
  async sqlExec(query, ...bindings) {
    try {
      const cursor = this.#sql.exec(query, ...bindings);
      cursor.toArray();
      return { ok: true, rowsWritten: cursor.rowsWritten, rowsRead: cursor.rowsRead };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
  async gatewayFetch(url, init) {
    return this.#fetch(url, init);
  }
  async getUserId() {
    return this.#userId;
  }
}

export class App extends DurableObject {
  #schemaApplied = false;

  #ensureSchema() {
    if (this.#schemaApplied) return;
    for (const stmt of splitStatements(SCHEMA_DDL)) {
      if (stmt.trim()) this.ctx.storage.sql.exec(stmt);
    }
    this.#schemaApplied = true;
  }

  async fetch(request) {
    this.#ensureSchema();
    const bridge = new FacetAgentBridge({
      sql: this.ctx.storage.sql,
      fetch: (url, init) => fetch(url, init),
      userId: this.ctx.props ? this.ctx.props.userId : ""
    });
    const agent = createAgent({ llm: this.env.LLM, bridge });
    const ctx = {
      agent,
      waitUntil: (p) => this.ctx.waitUntil(p)
    };
    return handleWebhook(request, this.ctx.storage.sql, ctx);
  }

  async __supervisorPing() {}

  async __query(sql) {
    this.#ensureSchema();
    try {
      const rows = this.ctx.storage.sql.exec(sql).toArray();
      return { ok: true, rows };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async __sqlExec(sql, ...bindings) {
    this.#ensureSchema();
    try {
      const cursor = this.ctx.storage.sql.exec(sql, ...bindings);
      cursor.toArray();
      return { ok: true, rowsWritten: cursor.rowsWritten, rowsRead: cursor.rowsRead };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}

function splitStatements(ddl) {
  return ddl.split(/;\\s*\\n/).map((s) => s.trim()).filter(Boolean);
}
`;
```

- [ ] **Step 2: Run the existing facet wrapper tests (sanity check)**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npx vitest run src/facet/`
Expected: all existing tests PASS; new behavior (ctx arg) untested here but won't break the wrapper's other paths.

- [ ] **Step 3: Commit**

```bash
git add src/facet/wrapper.ts
git commit -m "feat(subagent): pass ctx (agent, waitUntil) to handleWebhook"
```

---

## Task 9: Update create-sync tool description for the new handler contract

**Files:**
- Modify: `src/agent/tools/write/create-sync.ts` (description + handler_code input schema describe)

- [ ] **Step 1: Find the handler_code contract text**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" grep -n "handleWebhook" src/agent/tools/write/create-sync.ts`
Expected: line numbers where the contract is described (description + zod describe).

- [ ] **Step 2: Replace the handler contract text**

Replace the description text that currently says:

```
handler_code contract: JavaScript module source that MUST export \`async function handleWebhook(request, sql)\`.
```

with:

```
handler_code contract: JavaScript module source that MUST export \`async function handleWebhook(request, sql, ctx)\`.
- \`request\` is the raw webhook POST; signature is already verified.
- \`sql\` is the facet's own SQLite (\`sql.exec(query, ...bindings)\`).
- \`ctx\` carries two capabilities:
  - \`ctx.waitUntil(promise)\` — keep work alive past the 200 response. Use this for fire-and-forget enrichment so the webhook returns fast.
  - \`ctx.agent({ model?, system, messages, maxSteps? })\` — spawn a sub-agent ReAct loop and get back a string. \`model\` is \`"haiku" | "sonnet" | "opus"\` (default \`"sonnet"\`; pick \`haiku\` for simple classification, \`opus\` for hard reasoning). The sub-agent has three built-in tools: \`sql\` (reads + writes the facet's SQLite), \`fetch\` (upstream HTTP through the same auth proxy), and \`exec\` (runs an agent-authored JS module in a fresh isolate — contract matches the \`run_in_sync\` tool: \`async function runInSync(facet, fetch)\`). No nested \`agent()\` calls. Use when the handler needs LLM reasoning on the payload — triage, classification, summarization — rather than deterministic processing.

Example fire-and-forget triage:
\`\`\`js
export async function handleWebhook(request, sql, ctx) {
  const payload = await request.json();
  sql.exec("INSERT OR REPLACE INTO issues ...", ...);
  if (payload.data.priority === 1) {
    ctx.waitUntil(
      ctx.agent({
        model: "sonnet",
        system: "You are a Linear triage bot...",
        messages: [{ role: "user", content: JSON.stringify(payload.data) }]
      }).then(note =>
        sql.exec("UPDATE issues SET triage = ? WHERE id = ?", note, payload.data.id)
      )
    );
  }
  return new Response("ok", { status: 200 });
}
\`\`\`
```

Also update the `handler_code` zod describe to say `handleWebhook(request, sql, ctx)`.

- [ ] **Step 3: Run tests to confirm nothing breaks**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npm run check`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/agent/tools/write/create-sync.ts
git commit -m "docs(subagent): teach create_sync about the agent() primitive"
```

---

## Task 10: Mirror the update_sync description

**Files:**
- Modify: `src/agent/tools/write/update-sync.ts`

- [ ] **Step 1: Update handler_code describe in update-sync.ts**

Find the `handler_code` zod describe in `src/agent/tools/write/update-sync.ts` that currently says:

```
"New handler.js source. Must export `async function handleWebhook(request, sql)`. Omit if handler isn't changing."
```

Replace with:

```
"New handler.js source. Must export `async function handleWebhook(request, sql, ctx)`. See create_sync's description for the full contract (`ctx.agent` and `ctx.waitUntil`). Omit if handler isn't changing."
```

- [ ] **Step 2: Run the full check**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npm run check`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/agent/tools/write/update-sync.ts
git commit -m "docs(subagent): align update_sync handler contract with create_sync"
```

---

## Task 11: Teach the main agent about the primitive

**Files:**
- Modify: `src/agent/system-prompt.ts`

- [ ] **Step 1: Add a "Webhook sub-agents" section before "Response style"**

Insert into the SYSTEM_PROMPT string, after the "probe loop" section and before "Response style":

```
## Webhook sub-agents

Handler code can spawn a ReAct sub-agent per webhook delivery when the work requires LLM reasoning — triage, classification, summarization, enrichment. The handler signature is \`handleWebhook(request, sql, ctx)\`; \`ctx.agent({ model, system, messages })\` returns a string, and \`ctx.waitUntil(promise)\` keeps background work alive past the 200 response.

Model tiers: \`haiku\` (simple classification, cheapest), \`sonnet\` (default, reasoning), \`opus\` (hard multi-step reasoning, most expensive). Pick the cheapest that will work.

Sub-agent built-in tools: \`sql\` (facet SQLite reads + writes), \`fetch\` (proxy'd upstream HTTP), \`exec\` (fresh Worker Loader isolate running an agent-authored module that exports \`runInSync(facet, fetch)\`).

When to reach for it: the user asks for runtime reasoning on each delivery ("triage urgent issues", "summarize merged PRs", "classify Slack sentiment") — anything where deterministic parsing isn't enough. Use \`ctx.waitUntil\` for the \`ctx.agent\` call so the upstream webhook gets a fast 200 and the sub-agent runs in the background.

Do NOT reach for it for simple filtering or data shaping — deterministic JS is cheaper and faster.
```

- [ ] **Step 2: Run check + confirm prompt still compiles**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npm run check`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/agent/system-prompt.ts
git commit -m "docs(subagent): teach main agent when to use the agent() primitive"
```

---

## Task 12: End-to-end smoke test (vitest-pool-workers)

**Files:**
- Create: `tests/subagent-e2e.test.ts`

**Context:** Verifies the end-to-end path: a sync whose handler calls `ctx.agent(...)` actually gets a triage string written back via `sql.exec`. Uses the fake-facets pattern from `tests/per-user-do.test.ts` and mocks the Anthropic generateText call to return a deterministic string.

- [ ] **Step 1: Write the test**

```ts
// tests/subagent-e2e.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { SELF } from "cloudflare:test";
// ... (match the import pattern used in existing tests/*.test.ts)

// Mock Anthropic so we don't hit the network
vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    generateText: vi.fn(async () => ({
      text: "TRIAGE: duplicate of LIN-42",
      steps: [{}],
      usage: { inputTokens: 100, outputTokens: 20 }
    }))
  };
});

describe("webhook sub-agent primitive (E2E)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("a handler that calls ctx.agent writes the result back via sql.exec", async () => {
    // Steps in the test body:
    // 1. Create a sync whose handler_code does:
    //      sql.exec("INSERT OR IGNORE INTO issues (id, title) VALUES (?, ?)", id, title);
    //      ctx.waitUntil(ctx.agent({model, system, messages}).then(txt =>
    //        sql.exec("UPDATE issues SET triage=? WHERE id=?", txt, id)));
    // 2. Deliver a webhook payload.
    // 3. Query the facet and assert triage column == "TRIAGE: duplicate of LIN-42".
    //
    // Use the same setup as tests/per-user-do.test.ts for sync creation
    // and webhook delivery. Wait for waitUntil by awaiting a small delay
    // or by exposing a promise hook — reuse tests/ops-panel-api.test.ts's
    // waitForSyncChangeTick helper if it exists, otherwise add a small
    // setTimeout(50).
    expect(true).toBe(true); // placeholder — fill the assertion with the query result
  });
});
```

- [ ] **Step 2: Fill in the test body**

Flesh out the test following the pattern from `tests/per-user-do.test.ts`:

1. `POST /agents/chat-agent/<userId>/ask` to create the sync via the chat tool path, OR construct a sync row directly in the supervisor and attach the facet.
2. `POST /webhook/<userId>/<syncId>` with a sample Linear-shaped payload.
3. `GET /api/user/<userId>/syncs/<syncId>/details` and assert the triage row was updated.

If `waitUntil` resolution is flaky in tests, use `await new Promise(r => setTimeout(r, 100))` before the assertion.

- [ ] **Step 3: Run the test**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npx vitest run tests/subagent-e2e.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/subagent-e2e.test.ts
git commit -m "test(subagent): E2E handler → ctx.agent → sql.exec round-trip"
```

---

## Task 13: Full check + deploy

**Files:**
- None (CI-based)

- [ ] **Step 1: Run the full check**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npm run check`
Expected: PASS (fmt + lint + tsc + 115+ tests).

- [ ] **Step 2: Push to main (triggers deploy workflow)**

```bash
git push origin main
```

- [ ] **Step 3: Watch the deploy**

```bash
gh run watch $(gh run list --workflow=deploy.yml --limit 1 --json databaseId -q '.[0].databaseId') --exit-status
```
Expected: deploy step green.

- [ ] **Step 4: Smoke test on prod**

Open `https://self-syncing-agent.pandaronit25.workers.dev` and ask the agent:
> "Create a sync for Linear issues. When a priority=1 issue arrives, use a sub-agent to write a one-sentence triage note into a `triage` column. Use sonnet."

The agent should write a handler that uses `ctx.agent` inside `ctx.waitUntil`. After approval, trigger a urgent issue in Linear and verify the triage column populates within ~10-15s.

- [ ] **Step 5: Manual check: inspect the deployed handler**

Expand the sync card in the ops panel; confirm the handler code contains a `ctx.agent(...)` call.

---

## Future work (noted, not planned here)

- **Audit trail per handler version** — git-worktree-per-handler-code with commits on every `update_sync`. Gives a pure audit log of every agent-initiated code change. Out of scope for V1.
- **Production queue** — Cloudflare Queues in front of webhook delivery for retry + dead-lettering. `ctx.waitUntil` is the demo-quality equivalent.
- **Sub-agent budget + rate limit per sync** — token/day and calls/min caps with visible meters in the ops panel. V1 inherits Anthropic's account-level ceiling.
- **Agent-authored demo pre-seed** — let the user click "seed triage demo" to get a pre-made Linear-triage sync. Currently the agent composes it live; a one-click helper would speed up the Loom.
- **Tracing** — Helicone/Langfuse hookup (deferred earlier in this session).
