# Phase 04 — Read Tools + Context Injection + server.ts Refactor

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the agent its first real LLM-facing tool surface (4 read tools), inject per-turn context (`<active_syncs>` + `<sync_errors>`) respecting Anthropic's prompt cache, and refactor the monolithic `server.ts` into focused modules under `src/agent/`. Demo tools from the starter (weather, calculator, scheduleTask, etc.) are deleted — our own tools are the reference now.

**Architecture:** `server.ts` shrinks to a thin `ChatAgent` class that orchestrates pre-built pieces. System prompt, context messages, tool registry, and each tool live in their own modules under `src/agent/`. The pattern mirrors a lightweight version of the LangGraph `NodeConfig` decomposition, without creating a generic config class (YAGNI for one agent).

**Tech Stack:** TypeScript, `ai` SDK `tool()` helper, Zod schemas, **`parallel-web`** (official Parallel AI TypeScript SDK, zero runtime deps, Workers-compatible).

**Reference:** [`docs/superpowers/specs/2026-04-17-self-syncing-agent-architecture-design.md`](../specs/2026-04-17-self-syncing-agent-architecture-design.md) §8 (read tools), §9 (context injection), §11.1 (web_search as Layer-1 prevention).

---

## File Structure

**Created:**

- `src/agent/system-prompt.ts` — `SYSTEM_PROMPT` string (minimal placeholder; full content in Phase 07)
- `src/agent/context.ts` — `buildContextMessages(agent)`, `formatActiveSyncs`, `formatSyncErrors`
- `src/agent/context.test.ts` — unit tests for the three pure formatters
- `src/agent/tools/index.ts` — `buildTools(agent): ToolSet` — the tool registry
- `src/agent/tools/read/list-syncs.ts`
- `src/agent/tools/read/get-sync.ts`
- `src/agent/tools/read/get-sync-errors.ts`
- `src/agent/tools/read/web-search.ts` — calls Parallel AI
- `tests/agent-read-tools.test.ts` — integration tests via `runInDurableObject`

**Modified:**

- `src/server.ts` — rewritten. Removes inline tools (weather, calculator, scheduleTask, getScheduledTasks, cancelScheduledTask, getUserTimezone). Removes `inlineDataUrls` helper (not needed — we're text-only for V1). Keeps `addServer`/`removeServer` `@callable` methods (MCP still supported). Wires `buildContextMessages` + `buildTools` + `SYSTEM_PROMPT` into `onChatMessage`.
- `vitest.config.ts` — add `PARALLEL_API_KEY: "test-stub-key"` to miniflare bindings
- `.dev.vars.example` — add `PARALLEL_API_KEY=` template line
- `.dev.vars` — add `PARALLEL_API_KEY=` with user-supplied real value (or kept as placeholder during this phase; the web_search tool won't be exercised in tests)
- `env.d.ts` — regenerated after `.dev.vars` changes

**Not changed:** `wrangler.jsonc`, `src/db/*`, `src/app.tsx`, `src/client.tsx`, tests from Phases 00-02.

---

## Pre-flight context

### Circular imports

Tool files import the `ChatAgent` type from `src/server.ts`. `src/server.ts` imports `buildTools` from `src/agent/tools/index.ts`. This is a runtime cycle if we import values, but TypeScript's `import type` statements are erased at runtime, so cycles via `import type { ChatAgent } from "../../../server"` are safe. Use type-only imports everywhere tool files reference `ChatAgent`.

### Parallel AI via `parallel-web` SDK

Using the official TypeScript SDK (`parallel-web@^0.3.2`). Zero runtime deps (uses native `fetch`), Workers-compatible.

```ts
import Parallel, { APIError } from "parallel-web";

const client = new Parallel({ apiKey: env.PARALLEL_API_KEY });

const result = await client.beta.search({
  objective: "...",
  search_queries: ["q1", "q2"] ?? null, // optional
  mode: "agentic", // or "fast"
  excerpts: { max_chars_per_result: 4000 }
});

// Typed result:
// {
//   search_id: string,
//   results: WebSearchResult[],   // each has { url, title?, excerpts?, publish_date? }
//   usage?, warnings?
// }
```

Typed errors: `APIError`, `AuthenticationError`, `RateLimitError`, `InternalServerError`, etc. — all extend `ParallelError`.

Why the SDK over bare fetch:

- Typed request + response (no hand-rolled interfaces that drift from API)
- Typed error subclasses (we can surface rate-limit/auth errors distinctly)
- Free upgrade path when Parallel ships new fields or endpoints

### SDK tool shape

`ai` SDK's `tool()` helper returns a `Tool` object:

```ts
import { tool } from "ai";
import { z } from "zod";
tool({
  description: string,
  inputSchema: z.object({...}),
  execute: async (args, context) => result,
});
```

For Phase 04, all tools have `execute` (server-side). No `needsApproval` — these are read-only.

---

## Task 1: Install `parallel-web` SDK + wire `PARALLEL_API_KEY`

**Files:**

- Modify: `package.json`, `pnpm-lock.yaml`, `.dev.vars.example`, `.dev.vars`, `vitest.config.ts`, `env.d.ts` (regenerated)

- [ ] **Step 1: Install the Parallel SDK**

```bash
pnpm add parallel-web
```

Expected: `parallel-web` lands in `dependencies` (latest ^0.3.x, zero runtime deps).

- [ ] **Step 2: Add to `.dev.vars.example`**

Append to `.dev.vars.example`:

```
PARALLEL_API_KEY=your-parallel-api-key-here
```

- [ ] **Step 3: Add placeholder to `.dev.vars`**

Append to `.dev.vars`:

```
PARALLEL_API_KEY=stub-for-phase-04
```

The real key goes in before Phase 11 (UI demo time). Phase 04 tests never exercise the web_search execute path, so a stub is fine.

- [ ] **Step 4: Add test-env binding override**

In `vitest.config.ts`, inside `poolOptions.workers.miniflare.bindings`, add:

```ts
PARALLEL_API_KEY: "test-stub-key",
```

Alongside the existing `ANTHROPIC_API_KEY` stub.

- [ ] **Step 5: Regenerate env.d.ts**

```bash
pnpm run types
```

Expected: `env.d.ts` now includes `PARALLEL_API_KEY: string` in the `Cloudflare.Env` interface. `pnpm exec tsc --noEmit` clean.

---

## Task 2: System prompt placeholder module

**Files:**

- Create: `src/agent/system-prompt.ts`

- [ ] **Step 1: Create `src/agent/system-prompt.ts` with exactly this content:**

```ts
/**
 * System prompt for the ChatAgent. Phase 04 ships a minimal placeholder
 * that's functional but not polished — enough to get the agent talking
 * about syncs correctly. The production prompt (docs-first discipline,
 * Linear-specific guidance, response style rules) lands in Phase 07.
 *
 * IMPORTANT: this string must be stable across turns for prompt caching
 * to hit. Dynamic state goes in the context messages (see context.ts),
 * never in this system prompt.
 */
export const SYSTEM_PROMPT = `You are a self-syncing agent. You help users register and query webhook-driven syncs from third-party services into local SQLite databases the agent owns.

V1 supports Linear only. More integrations (via Pipedream Connect) come in V2.

Tools available to you (read-only):
- list_syncs(): list all syncs registered for this user
- get_sync(sync_id): full details of one sync (handler code, schema, recent errors)
- get_sync_errors(sync_id, limit): recent runtime errors for a sync
- web_search(objective, search_queries?): agentic web search via Parallel AI, for docs and research

Before each turn you'll receive ambient context blocks — <active_syncs> lists the user's registered syncs, <sync_errors> summarizes recent handler failures. Use these to know the state of the user's world without always calling list_syncs.

Write tools (create_sync, update_sync, delete_sync, run_in_sync) are coming in later phases — not yet available. If a user asks you to create or modify a sync, acknowledge the intent but explain the capability isn't wired yet.

Be direct and helpful. Lead with the answer, then add context if needed.`;
```

---

## Task 3: Context module + tests (TDD)

**Files:**

- Create: `src/agent/context.test.ts` (first)
- Create: `src/agent/context.ts`

- [ ] **Step 1: Write failing tests for the formatters**

Create `src/agent/context.test.ts` with exactly this content:

```ts
import { describe, it, expect } from "vitest";
import { formatActiveSyncs, formatSyncErrors } from "./context";
import type { Sync, SyncErrorStat } from "../db/types";

function sampleSync(overrides: Partial<Sync> = {}): Sync {
  return {
    id: "sync-abc-123",
    name: "linear_bugs",
    integration: "linear",
    handler_code: "export default {};",
    schema_ddl: "CREATE TABLE issues (id TEXT PRIMARY KEY)",
    filter_description: null,
    webhook_secret: "secret",
    upstream_webhook_id: null,
    code_id: "code-v1",
    version: 1,
    created_at: 1_000_000,
    updated_at: 1_000_000,
    ...overrides
  };
}

describe("formatActiveSyncs", () => {
  it("formats empty list with a clear stub message", () => {
    const output = formatActiveSyncs([]);
    expect(output).toContain("<active_syncs>");
    expect(output).toContain("</active_syncs>");
    expect(output.toLowerCase()).toContain("no syncs");
  });

  it("formats a populated list as a markdown table with id/name/integration", () => {
    const output = formatActiveSyncs([
      sampleSync({ id: "s-1", name: "linear_bugs", integration: "linear" }),
      sampleSync({ id: "s-2", name: "linear_cycles", integration: "linear" })
    ]);
    expect(output).toContain("<active_syncs>");
    expect(output).toContain("| sync_id | name | integration |");
    expect(output).toContain("s-1");
    expect(output).toContain("linear_bugs");
    expect(output).toContain("s-2");
    expect(output).toContain("linear_cycles");
  });
});

describe("formatSyncErrors", () => {
  it("formats empty list with a clear stub message", () => {
    const output = formatSyncErrors([]);
    expect(output).toContain("<sync_errors>");
    expect(output).toContain("</sync_errors>");
    expect(output.toLowerCase()).toContain("no recent errors");
  });

  it("formats a populated list as a markdown table with sync_id/count/last_error", () => {
    const stats: SyncErrorStat[] = [
      {
        sync_id: "s-1",
        error_count: 7,
        last_error_message:
          "TypeError: Cannot read property 'team' of undefined",
        last_occurred_at: 1_700_000_000
      }
    ];
    const output = formatSyncErrors(stats);
    expect(output).toContain("<sync_errors>");
    expect(output).toContain("s-1");
    expect(output).toContain("7");
    expect(output).toContain("TypeError");
  });

  it("truncates very long error messages in the table", () => {
    const longMessage = "x".repeat(500);
    const output = formatSyncErrors([
      {
        sync_id: "s-1",
        error_count: 1,
        last_error_message: longMessage,
        last_occurred_at: 1_700_000_000
      }
    ]);
    // We don't need an exact cap; just confirm the formatter doesn't
    // pipe 500 literal chars into the table. Anywhere between 100-300
    // is a reasonable truncation threshold.
    const tableLine = output.split("\n").find((l) => l.includes("s-1"))!;
    expect(tableLine.length).toBeLessThan(400);
  });
});
```

- [ ] **Step 2: Run tests — verify they fail** (module doesn't exist yet)

```bash
pnpm test src/agent/context.test.ts
```

Expected: failures because `./context` doesn't exist.

- [ ] **Step 3: Implement `src/agent/context.ts`**

Create with exactly this content:

```ts
import type { ModelMessage } from "ai";
import { listSyncs } from "../db/syncs";
import { getSyncErrorStats } from "../db/sync-errors";
import type { Sync, SyncErrorStat, SqlTag } from "../db/types";

const ERROR_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const ERROR_MESSAGE_TRUNCATE = 160;

/**
 * Build the two ambient context messages injected before the chat
 * history on every turn. Both tags are present every turn — empty
 * state is conveyed by a clear stub message rather than omitting the
 * block, so the agent can always rely on their presence.
 */
export function buildContextMessages(sql: SqlTag): ModelMessage[] {
  const syncs = listSyncs(sql);
  const errorStats = getSyncErrorStats(sql, Date.now() - ERROR_WINDOW_MS);
  return [
    { role: "user", content: formatActiveSyncs(syncs) },
    { role: "user", content: formatSyncErrors(errorStats) }
  ];
}

export function formatActiveSyncs(syncs: Sync[]): string {
  if (syncs.length === 0) {
    return "<active_syncs>No syncs registered yet. Write tools are not yet available in this phase — sync creation arrives in a later phase.</active_syncs>";
  }
  const rows = syncs
    .map((s) => `| ${s.id} | ${s.name} | ${s.integration} |`)
    .join("\n");
  return `<active_syncs>
| sync_id | name | integration |
|---|---|---|
${rows}
</active_syncs>`;
}

export function formatSyncErrors(stats: SyncErrorStat[]): string {
  if (stats.length === 0) {
    return "<sync_errors>No recent errors (last hour).</sync_errors>";
  }
  const rows = stats
    .map((s) => {
      const msg = truncate(s.last_error_message, ERROR_MESSAGE_TRUNCATE);
      return `| ${s.sync_id} | ${s.error_count} | ${msg} |`;
    })
    .join("\n");
  return `<sync_errors>
| sync_id | errors_last_hour | last_error |
|---|---|---|
${rows}
</sync_errors>`;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
pnpm test src/agent/context.test.ts
```

Expected: 5 tests pass.

---

## Task 4: Read tools

Each tool gets its own file under `src/agent/tools/read/`. Each file exports a factory function `<name>Tool(agent)` that returns a configured `Tool` object.

**Files:**

- Create: `src/agent/tools/read/list-syncs.ts`
- Create: `src/agent/tools/read/get-sync.ts`
- Create: `src/agent/tools/read/get-sync-errors.ts`
- Create: `src/agent/tools/read/web-search.ts`

- [ ] **Step 1: Create `src/agent/tools/read/list-syncs.ts` with exactly this content:**

```ts
import { tool } from "ai";
import { z } from "zod";
import { listSyncs } from "../../../db/syncs";
import type { ChatAgent } from "../../../server";

export function listSyncsTool(agent: ChatAgent) {
  return tool({
    description:
      "List all syncs registered for this user. Returns id, name, integration, version, and creation/update timestamps. Use this when the user asks about their syncs generally, or when you need to disambiguate which sync they mean.",
    inputSchema: z.object({}),
    execute: async () => {
      const sql = agent.sql.bind(agent);
      const syncs = listSyncs(sql);
      return {
        count: syncs.length,
        syncs: syncs.map((s) => ({
          sync_id: s.id,
          name: s.name,
          integration: s.integration,
          version: s.version,
          created_at: s.created_at,
          updated_at: s.updated_at
        }))
      };
    }
  });
}
```

- [ ] **Step 2: Create `src/agent/tools/read/get-sync.ts` with exactly this content:**

```ts
import { tool } from "ai";
import { z } from "zod";
import { getSyncById } from "../../../db/syncs";
import { listSyncErrors } from "../../../db/sync-errors";
import type { ChatAgent } from "../../../server";

export function getSyncTool(agent: ChatAgent) {
  return tool({
    description:
      "Get full detail for a single sync — handler code, schema DDL, filter description, version, timestamps, and the 5 most-recent errors. Use when the user asks to see or discuss a specific sync.",
    inputSchema: z.object({
      sync_id: z.string().describe("The sync's UUID")
    }),
    execute: async ({ sync_id }) => {
      const sql = agent.sql.bind(agent);
      const sync = getSyncById(sql, sync_id);
      if (!sync) {
        return { error: "not_found", sync_id };
      }
      const recentErrors = listSyncErrors(sql, sync_id, 5);
      return {
        sync_id: sync.id,
        name: sync.name,
        integration: sync.integration,
        handler_code: sync.handler_code,
        schema_ddl: sync.schema_ddl,
        filter_description: sync.filter_description,
        version: sync.version,
        created_at: sync.created_at,
        updated_at: sync.updated_at,
        recent_errors: recentErrors.map((e) => ({
          occurred_at: e.occurred_at,
          error_message: e.error_message,
          handler_version: e.handler_version
        }))
      };
    }
  });
}
```

- [ ] **Step 3: Create `src/agent/tools/read/get-sync-errors.ts` with exactly this content:**

```ts
import { tool } from "ai";
import { z } from "zod";
import { listSyncErrors } from "../../../db/sync-errors";
import type { ChatAgent } from "../../../server";

export function getSyncErrorsTool(agent: ChatAgent) {
  return tool({
    description:
      "List recent runtime errors for a sync, newest first. Use when diagnosing why a sync is failing or when the user asks about error details. The ambient <sync_errors> context only shows the most recent message per sync; call this for full history with stack traces and payload previews.",
    inputSchema: z.object({
      sync_id: z.string().describe("The sync's UUID"),
      limit: z.number().int().positive().max(100).default(20)
    }),
    execute: async ({ sync_id, limit }) => {
      const sql = agent.sql.bind(agent);
      const errors = listSyncErrors(sql, sync_id, limit);
      return {
        count: errors.length,
        errors: errors.map((e) => ({
          id: e.id,
          occurred_at: e.occurred_at,
          error_message: e.error_message,
          stack_trace: e.stack_trace,
          payload_preview: e.payload_preview,
          handler_version: e.handler_version
        }))
      };
    }
  });
}
```

- [ ] **Step 4: Create `src/agent/tools/read/web-search.ts` with exactly this content:**

```ts
import { tool } from "ai";
import { z } from "zod";
import Parallel, { APIError } from "parallel-web";
import type { ChatAgent } from "../../../server";

const DEFAULT_MODE = "agentic" as const;
const DEFAULT_EXCERPT_CHARS = 4000;

export function webSearchTool(agent: ChatAgent) {
  return tool({
    description:
      "Search the web for current information via Parallel AI's agentic search. Use for: verifying an integration's API/webhook shape, looking up error-code meanings, researching recent API changes, fact-checking. Returns up to 10 excerpts of ~4KB each ranked by relevance.",
    inputSchema: z.object({
      objective: z
        .string()
        .describe(
          "Natural-language description of what you're trying to find. Keep it focused on ONE concrete question — this drives quality more than keyword queries."
        ),
      search_queries: z
        .array(z.string().max(200))
        .max(5)
        .optional()
        .describe(
          "(optional) Up to 5 keyword queries (≤200 chars each) to seed the search. Leave unset for agentic-mode default behavior."
        )
    }),
    execute: async ({ objective, search_queries }) => {
      const client = new Parallel({ apiKey: agent.env.PARALLEL_API_KEY });
      try {
        const result = await client.beta.search({
          objective,
          search_queries: search_queries ?? null,
          mode: DEFAULT_MODE,
          excerpts: { max_chars_per_result: DEFAULT_EXCERPT_CHARS }
        });
        return {
          objective,
          search_id: result.search_id,
          result_count: result.results.length,
          results: result.results.map((r) => ({
            url: r.url,
            title: r.title ?? null,
            excerpts: r.excerpts ?? [],
            publish_date: r.publish_date ?? null
          }))
        };
      } catch (e) {
        if (e instanceof APIError) {
          return {
            error: "parallel_ai_request_failed",
            status: e.status,
            detail: e.message
          };
        }
        throw e;
      }
    }
  });
}
```

Why the SDK over bare `fetch()`: typed `SearchResult` + `WebSearchResult` responses (no hand-rolled interfaces drifting from Parallel's actual API), typed error subclasses (`APIError` has `.status` + `.message`; catching it as a distinct return shape lets the agent see failure vs. success clearly), and auto-inherited fixes as Parallel iterates.

- [ ] **Step 5: Create the tool registry**

Create `src/agent/tools/index.ts`:

```ts
import { listSyncsTool } from "./read/list-syncs";
import { getSyncTool } from "./read/get-sync";
import { getSyncErrorsTool } from "./read/get-sync-errors";
import { webSearchTool } from "./read/web-search";
import type { ChatAgent } from "../../server";

/**
 * Build the tool map passed to streamText. Each tool factory takes
 * the agent instance so tools can read/write the supervisor SQLite
 * and reach the env bindings (ANTHROPIC_API_KEY, PARALLEL_API_KEY).
 *
 * Write tools (create_sync, update_sync, delete_sync, run_in_sync)
 * are added in Phase 08+.
 */
export function buildTools(agent: ChatAgent) {
  return {
    list_syncs: listSyncsTool(agent),
    get_sync: getSyncTool(agent),
    get_sync_errors: getSyncErrorsTool(agent),
    web_search: webSearchTool(agent)
  };
}
```

---

## Task 5: Rewrite `src/server.ts`

This is the biggest single diff in the phase. The starter's inline tools and `inlineDataUrls` helper get deleted. The `onChatMessage` body becomes orchestration over the extracted modules.

**Files:**

- Modify: `src/server.ts`

- [ ] **Step 1: Replace the file with this content**

```ts
import { createAnthropic } from "@ai-sdk/anthropic";
import { callable, routeAgentRequest } from "agents";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { convertToModelMessages, stepCountIs, streamText } from "ai";
import { applySchemaMigrations } from "./db/schema";
import { buildContextMessages } from "./agent/context";
import { buildTools } from "./agent/tools";
import { SYSTEM_PROMPT } from "./agent/system-prompt";

const MODEL_ID = "claude-opus-4-7";

export class ChatAgent extends AIChatAgent<Env> {
  maxPersistedMessages = 100;

  onStart() {
    applySchemaMigrations(this.sql.bind(this));

    // Configure OAuth popup behavior for MCP servers that require authentication
    this.mcp.configureOAuthCallback({
      customHandler: (result) => {
        if (result.authSuccess) {
          return new Response("<script>window.close();</script>", {
            headers: { "content-type": "text/html" },
            status: 200
          });
        }
        return new Response(
          `Authentication Failed: ${result.authError || "Unknown error"}`,
          { headers: { "content-type": "text/plain" }, status: 400 }
        );
      }
    });
  }

  @callable()
  async addServer(name: string, url: string) {
    return await this.addMcpServer(name, url);
  }

  @callable()
  async removeServer(serverId: string) {
    await this.removeMcpServer(serverId);
  }

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const anthropic = createAnthropic({ apiKey: this.env.ANTHROPIC_API_KEY });
    const sql = this.sql.bind(this);

    const messages = [
      ...buildContextMessages(sql),
      ...(await convertToModelMessages(this.messages))
    ];

    const mcpTools = this.mcp.getAITools();

    const result = streamText({
      model: anthropic(MODEL_ID),
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT,
          providerOptions: {
            anthropic: { cacheControl: { type: "ephemeral" } }
          }
        }
      ],
      messages,
      tools: {
        ...mcpTools,
        ...buildTools(this)
      },
      stopWhen: stepCountIs(5),
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
```

What's gone vs. the current file:

- All starter demo tools (getWeather, getUserTimezone, calculate, scheduleTask, getScheduledTasks, cancelScheduledTask)
- `inlineDataUrls` helper (we're text-only for V1; no image attachments)
- `pruneMessages` usage (we're not pruning for V1 — history is small)
- `executeTask` method (no scheduled tasks)
- Import of `Schedule`, `getSchedulePrompt`, `scheduleSchema`, `pruneMessages`, `tool`, `z`, `ModelMessage` (no longer referenced here)

What stays:

- `@callable` methods for MCP (`addServer`, `removeServer`) — MCP is still supported even if not load-bearing for our agent
- `onStart` schema migration call from Phase 02
- `AIChatAgent` base class behavior (message persistence, WebSocket handling)

- [ ] **Step 2: Type check**

```bash
pnpm exec tsc --noEmit
```

Expected: zero errors. If the circular import between `server.ts` → `tools/index.ts` → tool files → `type ChatAgent` causes issues, ensure every tool file's `ChatAgent` import uses `import type` and not a value import.

---

## Task 6: Integration tests for read tools

**Files:**

- Create: `tests/agent-read-tools.test.ts`

- [ ] **Step 1: Create `tests/agent-read-tools.test.ts` with exactly this content:**

```ts
import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { createSync } from "../src/db/syncs";
import { logSyncError } from "../src/db/sync-errors";
import { buildTools } from "../src/agent/tools";
import type { NewSync } from "../src/db/types";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

function getStub(userName: string) {
  return env.ChatAgent.get(env.ChatAgent.idFromName(userName));
}

function sampleSync(overrides: Partial<NewSync> = {}): NewSync {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    name: overrides.name ?? `test-${crypto.randomUUID().slice(0, 8)}`,
    integration: "linear",
    handler_code: "export default {};",
    schema_ddl: "CREATE TABLE issues (id TEXT PRIMARY KEY)",
    webhook_secret: "test-secret",
    code_id: `code-${crypto.randomUUID().slice(0, 8)}`,
    ...overrides
  };
}

/**
 * Kick the Agents SDK lifecycle so onStart (and thus the schema
 * migration) fires. Same pattern as tests/supervisor-data-model.test.ts.
 */
async function ensureReady(
  instance: InstanceType<typeof env.ChatAgent>,
  name: string
) {
  await instance.setName(name);
}

describe("agent read tools", () => {
  describe("list_syncs", () => {
    it("returns empty array for a fresh DO", async () => {
      const stub = getStub("read-list-empty");
      await runInDurableObject(stub, async (instance) => {
        await ensureReady(instance, "read-list-empty");
        const tools = buildTools(instance);
        const result = await tools.list_syncs.execute!({}, {} as never);
        expect(result).toMatchObject({ count: 0, syncs: [] });
      });
    });

    it("returns registered syncs with expected shape", async () => {
      const stub = getStub("read-list-populated");
      await runInDurableObject(stub, async (instance) => {
        await ensureReady(instance, "read-list-populated");
        const sql = instance.sql.bind(instance);
        createSync(sql, sampleSync({ name: "linear_bugs" }));
        createSync(sql, sampleSync({ name: "linear_cycles" }));

        const tools = buildTools(instance);
        const result = await tools.list_syncs.execute!({}, {} as never);
        expect(result.count).toBe(2);
        const names = result.syncs.map((s: { name: string }) => s.name).sort();
        expect(names).toEqual(["linear_bugs", "linear_cycles"]);
        expect(result.syncs[0]).toHaveProperty("sync_id");
        expect(result.syncs[0]).toHaveProperty("integration", "linear");
        expect(result.syncs[0]).toHaveProperty("version", 1);
        expect(result.syncs[0]).toHaveProperty("created_at");
      });
    });
  });

  describe("get_sync", () => {
    it("returns { error: 'not_found' } for unknown sync_id", async () => {
      const stub = getStub("read-get-missing");
      await runInDurableObject(stub, async (instance) => {
        await ensureReady(instance, "read-get-missing");
        const tools = buildTools(instance);
        const result = await tools.get_sync.execute!(
          { sync_id: "no-such-id" },
          {} as never
        );
        expect(result).toMatchObject({
          error: "not_found",
          sync_id: "no-such-id"
        });
      });
    });

    it("returns full sync detail + empty recent_errors when none", async () => {
      const stub = getStub("read-get-detail");
      const input = sampleSync({ name: "linear_bugs" });
      await runInDurableObject(stub, async (instance) => {
        await ensureReady(instance, "read-get-detail");
        const sql = instance.sql.bind(instance);
        createSync(sql, input);

        const tools = buildTools(instance);
        const result = await tools.get_sync.execute!(
          { sync_id: input.id },
          {} as never
        );
        expect(result).toMatchObject({
          sync_id: input.id,
          name: "linear_bugs",
          integration: "linear",
          version: 1,
          handler_code: input.handler_code,
          schema_ddl: input.schema_ddl,
          recent_errors: []
        });
      });
    });

    it("includes recent errors when present", async () => {
      const stub = getStub("read-get-errors");
      const input = sampleSync({ name: "linear_error_sync" });
      await runInDurableObject(stub, async (instance) => {
        await ensureReady(instance, "read-get-errors");
        const sql = instance.sql.bind(instance);
        createSync(sql, input);
        logSyncError(sql, {
          sync_id: input.id,
          error_message: "boom",
          handler_version: 1
        });

        const tools = buildTools(instance);
        const result = await tools.get_sync.execute!(
          { sync_id: input.id },
          {} as never
        );
        expect(result.recent_errors).toHaveLength(1);
        expect(result.recent_errors[0]).toMatchObject({
          error_message: "boom",
          handler_version: 1
        });
      });
    });
  });

  describe("get_sync_errors", () => {
    it("returns empty array for a sync with no errors", async () => {
      const stub = getStub("read-errors-empty");
      const input = sampleSync();
      await runInDurableObject(stub, async (instance) => {
        await ensureReady(instance, "read-errors-empty");
        const sql = instance.sql.bind(instance);
        createSync(sql, input);

        const tools = buildTools(instance);
        const result = await tools.get_sync_errors.execute!(
          { sync_id: input.id, limit: 20 },
          {} as never
        );
        expect(result).toMatchObject({ count: 0, errors: [] });
      });
    });

    it("returns errors newest-first with the expected shape", async () => {
      const stub = getStub("read-errors-populated");
      const input = sampleSync();
      await runInDurableObject(stub, async (instance) => {
        await ensureReady(instance, "read-errors-populated");
        const sql = instance.sql.bind(instance);
        createSync(sql, input);
        logSyncError(sql, {
          sync_id: input.id,
          error_message: "first",
          handler_version: 1
        });
        await new Promise((r) => setTimeout(r, 2));
        logSyncError(sql, {
          sync_id: input.id,
          error_message: "second",
          handler_version: 1
        });

        const tools = buildTools(instance);
        const result = await tools.get_sync_errors.execute!(
          { sync_id: input.id, limit: 20 },
          {} as never
        );
        expect(result.count).toBe(2);
        expect(result.errors[0]).toMatchObject({
          error_message: "second",
          handler_version: 1
        });
        expect(result.errors[1]).toMatchObject({
          error_message: "first",
          handler_version: 1
        });
      });
    });
  });

  describe("web_search", () => {
    it("is registered with the expected schema (no live API call)", async () => {
      const stub = getStub("read-websearch-wiring");
      await runInDurableObject(stub, async (instance) => {
        await ensureReady(instance, "read-websearch-wiring");
        const tools = buildTools(instance);
        // Confirm the tool is present with its metadata; do NOT call
        // execute in tests (would hit Parallel AI with a stub key).
        expect(tools.web_search).toBeDefined();
        expect(tools.web_search.description).toMatch(/parallel|search/i);
      });
    });
  });
});
```

- [ ] **Step 2: Run tests**

```bash
pnpm test
```

Expected: **35 passing** across 6 test files.

Breakdown:

- tests/smoke.test.ts (1)
- src/identity.test.ts (8)
- tests/per-user-do.test.ts (2)
- tests/supervisor-data-model.test.ts (11)
- src/agent/context.test.ts (5)
- tests/agent-read-tools.test.ts (8)

Total: 1 + 8 + 2 + 11 + 5 + 8 = **35**.

---

## Task 7: Full check pipeline

- [ ] **Step 1:**

```bash
pnpm run check
```

Expected: all four stages (oxfmt, oxlint, tsc, vitest) green.

---

## Task 8: Commit and push

**Files:**

- Phase 04 changes: `.dev.vars.example`, `vitest.config.ts`, `env.d.ts`, `src/server.ts`, new modules under `src/agent/`, new tests.

- [ ] **Step 1: Stage and verify**

```bash
git add -A
git status --short
git diff --cached --stat
```

Expected: ~12 files changed or created. `.dev.vars` NOT staged (gitignored).

- [ ] **Step 2: Commit**

```bash
git commit -m "$(cat <<'EOF'
Phase 04: read tools + context injection + server.ts refactor

First LLM-facing phase. Extracts the monolithic ChatAgent body into
focused modules under src/agent/, wires 4 read tools (list_syncs,
get_sync, get_sync_errors, web_search) into streamText, and injects
<active_syncs> + <sync_errors> ambient context before conversation
history on every turn — respecting Anthropic's prompt cache by keeping
the system prompt stable and the dynamic bits in user-role context
messages.

Module structure (lightweight NodeConfig-style decomposition, minus
the generic wrapper class — YAGNI for one agent):
- src/agent/system-prompt.ts: SYSTEM_PROMPT string (placeholder for
  Phase 07 polish; functional enough to reason about syncs now)
- src/agent/context.ts: buildContextMessages + formatActiveSyncs +
  formatSyncErrors. Pure. Unit-tested.
- src/agent/tools/index.ts: buildTools(agent) registry
- src/agent/tools/read/{list-syncs,get-sync,get-sync-errors,web-search}.ts

Tool behavior:
- list_syncs: returns { count, syncs[] } from supervisor SQLite
- get_sync: full detail + top-5 recent errors; { error: "not_found" }
  for unknown sync_id
- get_sync_errors: paginated recent errors, newest-first, limit up to 100
- web_search: Parallel AI agentic search via bare fetch (no new deps),
  10 results, ~4KB excerpts, mode=agentic

server.ts shrinks dramatically:
- Deleted inline demo tools (getWeather, getUserTimezone, calculate,
  scheduleTask, getScheduledTasks, cancelScheduledTask)
- Deleted inlineDataUrls helper (text-only for V1)
- Deleted executeTask + Schedule imports
- Kept addServer/removeServer @callable methods (MCP still supported)

Env wiring:
- Added PARALLEL_API_KEY to .dev.vars.example and vitest miniflare
  bindings override
- Regenerated env.d.ts so PARALLEL_API_KEY is typed on Env

Test count: 22 -> 35 across 6 files.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 3: Push**

```bash
git push
```

---

## Phase 04 done when…

- [ ] `pnpm test` shows **35 passing** across 6 test files
- [ ] `pnpm run check` green end-to-end
- [ ] `src/server.ts` is ~75 lines (thin orchestrator; tools live in `src/agent/tools/`)
- [ ] Starter demo tools are gone; only our 4 read tools + MCP's inherited tools remain in `buildTools` composition
- [ ] Ambient context messages are built fresh per turn, placed before conversation history, with the system prompt marked `cache_control: ephemeral`
- [ ] Commit pushed to origin/main

Next phase: **Phase 05 — Context injection** would have been a separate phase but is bundled into Phase 04 above. So the next phase is actually **Phase 06 — Proxy**: `CredentialSource` interface, `EnvCredentialSource` impl, `/__proxy/*` Hono route, and tests that prove unknown hosts get rejected. (Note: the phase numbering carries even though the original 12-phase list shifts down by one — we'll keep "Phase 06" for clarity.)
