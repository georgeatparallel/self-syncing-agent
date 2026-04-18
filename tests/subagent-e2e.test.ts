import { describe, it, expect, beforeEach, vi } from "vitest";

// Must be top-level so vitest hoists the mock before `ai` is imported by
// anything under test. The LLMGateway's runAgent (src/agent-runtime/llm-gateway.ts)
// calls generateText from "ai"; intercepting it here makes the sub-agent
// call return our deterministic string instead of hitting Anthropic.
//
// This is the same mock pattern validated in
// src/agent-runtime/llm-gateway.test.ts — confirmed to propagate into the
// vitest-pool-workers runtime.
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

import { env, runInDurableObject } from "cloudflare:test";
import { createSync } from "../src/db/syncs";
import { FacetAgentBridge } from "../src/agent-runtime/facet-agent-bridge";
import { runAgent } from "../src/agent-runtime/llm-gateway";
import type { NewSync, SqlTag } from "../src/db/types";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const WEBHOOK_SECRET = "lin_wh_e2e_subagent_secret";

async function hmacHex(body: Uint8Array, secret: string): Promise<string> {
  const normalized = new Uint8Array(body);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, normalized);
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Fake-facet bridge layer.
 *
 * Context: vitest-pool-workers' bundled workerd does not ship Durable
 * Object Facets nor the full Worker Loader API (`worker.getDurableObjectClass`
 * is absent). Real facets only work in `wrangler dev` + deploy. See the
 * comment at the top of tests/create-sync-integration.test.ts.
 *
 * To exercise the sub-agent primitive end-to-end in tests, we install a
 * fake facets implementation that reconstructs exactly what the real
 * facet wrapper (src/facet/wrapper.ts) does on a webhook delivery:
 *
 *   1. Run SCHEMA_DDL against a SqlStorage instance (we reuse the
 *      supervisor DO's storage.sql — the isolation boundary isn't what's
 *      under test here).
 *   2. Build a FacetAgentBridge bound to that sql + fetch + userId.
 *   3. Build `ctx = { agent, waitUntil }` exactly like the wrapper does,
 *      where `agent(request)` delegates to the real LLMGateway runAgent
 *      (running under the mocked `ai.generateText`).
 *   4. Invoke the handler function as a plain JS function. This is
 *      equivalent to what Worker Loader would do after compiling
 *      handler.js into a module — we skip the isolate boundary but
 *      exercise the full primitive wiring.
 *
 * The only thing this stubs out is the Worker Loader isolate boundary.
 * Everything under test — ctx.agent, runAgent, FacetAgentBridge,
 * waitUntil composition, sql.exec writeback — runs for real.
 */
interface FakeFacetStub {
  fetch: (req: Request) => Promise<Response>;
  __supervisorPing: () => Promise<void>;
  __query: (
    q: string
  ) => Promise<{ ok: true; rows: unknown[] } | { ok: false; error: string }>;
}
interface FakeFacets {
  get(name: string, cb?: () => unknown): FakeFacetStub;
  abort: (name: string, reason?: unknown) => void;
  delete: (name: string) => void;
}
function installFakeFacets(instance: unknown, facets: FakeFacets): () => void {
  const ctx = (instance as { ctx: { facets?: FakeFacets } }).ctx;
  const prev = ctx.facets;
  ctx.facets = facets;
  return () => {
    ctx.facets = prev;
  };
}

/**
 * Agent-authored handler under test. Mirrors what a real handler
 * produced by create_sync would look like: store the incoming issue,
 * fire off a sub-agent for triage in the background, and update the
 * row once the triage text arrives.
 */
async function testHandler(
  request: Request,
  sql: SqlStorage,
  ctx: {
    agent: (req: unknown) => Promise<string>;
    waitUntil: (p: Promise<unknown>) => void;
  }
): Promise<Response> {
  const payload = (await request.json()) as {
    data: { id: string; title: string };
  };
  const id = payload.data.id;
  const title = payload.data.title;
  sql.exec(
    "INSERT OR REPLACE INTO issues (id, title, triage) VALUES (?, ?, NULL)",
    id,
    title
  );
  ctx.waitUntil(
    ctx
      .agent({
        model: "sonnet",
        system: "triage",
        messages: [{ role: "user", content: JSON.stringify(payload) }]
      })
      .then((note) => {
        sql.exec("UPDATE issues SET triage = ? WHERE id = ?", note, id);
      })
  );
  return new Response("ok", { status: 200 });
}

const SCHEMA_DDL =
  "CREATE TABLE IF NOT EXISTS issues (id TEXT PRIMARY KEY, title TEXT, triage TEXT);";

function seedSubAgentSync(instance: unknown, userId: string): string {
  const sql = (instance as { sql: SqlTag }).sql.bind(instance) as SqlTag;
  const id = crypto.randomUUID();
  const input: NewSync = {
    id,
    name: `subagent-sync-${id.slice(0, 8)}`,
    integration: "linear",
    handler_code:
      "export async function handleWebhook(request, sql, ctx) { /* see testHandler */ }",
    schema_ddl: SCHEMA_DDL,
    filter_description: null,
    webhook_secret: WEBHOOK_SECRET,
    upstream_webhook_id: `wh_${userId}`,
    code_id: `sync:${id}:v1`
  };
  createSync(sql, input);
  return id;
}

/**
 * Install a fake facets that behaves like the real wrapper for the
 * single sync under test, then track the waitUntil promise so the test
 * can await it deterministically.
 */
function installSubAgentFacet(
  instance: unknown,
  userId: string,
  sql: SqlStorage,
  env: Env
): { restore: () => void; pendingWork: Promise<unknown>[] } {
  // Apply schema once, same as the wrapper's #ensureSchema().
  for (const stmt of SCHEMA_DDL.split(/;\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean)) {
    sql.exec(stmt);
  }

  const pendingWork: Promise<unknown>[] = [];

  const restore = installFakeFacets(instance, {
    get() {
      return {
        fetch: async (req: Request) => {
          const bridge = new FacetAgentBridge({ sql, userId });
          let callsInFlight = 0;
          const agent = async (request: unknown): Promise<string> => {
            if (callsInFlight > 0) {
              throw new Error(
                "agent(): nested calls are not permitted inside a single handler invocation"
              );
            }
            callsInFlight++;
            try {
              const result = await runAgent(request as never, bridge, env);
              if (!result.ok) {
                throw new Error(
                  `agent() failed: ${result.error}${
                    result.detail ? ": " + result.detail : ""
                  }`
                );
              }
              return result.text;
            } finally {
              callsInFlight--;
            }
          };
          const ctx = {
            agent,
            waitUntil: (p: Promise<unknown>) => {
              // Capture the background promise so the test can flush it.
              // The real facet routes waitUntil to DO.ctx.waitUntil; in
              // tests we track it explicitly instead of relying on a
              // timer.
              pendingWork.push(p);
            }
          };
          return testHandler(req, sql, ctx);
        },
        __supervisorPing: async () => {},
        __query: async (q: string) => {
          try {
            const rows = sql.exec(q).toArray();
            return { ok: true as const, rows };
          } catch (e) {
            return {
              ok: false as const,
              error: e instanceof Error ? e.message : String(e)
            };
          }
        }
      };
    },
    abort: () => {},
    delete: () => {}
  });

  return { restore, pendingWork };
}

describe("webhook sub-agent primitive (E2E)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("a handler that calls ctx.agent writes the mocked triage back via sql.exec", async () => {
    const userId = `subagent-e2e-${crypto.randomUUID()}`;
    const stub = env.ChatAgent.get(env.ChatAgent.idFromName(userId));

    const issueId = `ISSUE-${crypto.randomUUID().slice(0, 8)}`;
    const body = new TextEncoder().encode(
      JSON.stringify({
        action: "create",
        type: "Issue",
        data: { id: issueId, title: "login crashes on Safari" }
      })
    );
    const sig = await hmacHex(body, WEBHOOK_SECRET);

    await runInDurableObject(stub, async (instance) => {
      await (
        instance as never as { setName: (n: string) => Promise<void> }
      ).setName(userId);
      const syncId = seedSubAgentSync(instance, userId);

      const doSql = (instance as unknown as { ctx: DurableObjectState }).ctx
        .storage.sql;
      const doEnv = (instance as unknown as { env: Env }).env;

      const { restore, pendingWork } = installSubAgentFacet(
        instance,
        userId,
        doSql,
        doEnv
      );
      try {
        // Drive the full webhook path: HTTP signature verification →
        // attachFacet (fake) → facet.fetch → testHandler → ctx.agent →
        // LLMGateway runAgent → (mocked) generateText → handler returns
        // ok → ctx.waitUntil promise captured in pendingWork.
        const res = await (
          instance as never as {
            handleWebhookDelivery: (
              userId: string,
              id: string,
              body: ArrayBuffer,
              sig: string | null
            ) => Promise<{ status: number; body: string }>;
          }
        ).handleWebhookDelivery(
          userId,
          syncId,
          body.buffer as ArrayBuffer,
          sig
        );
        expect(res.status).toBe(200);

        // The handler fires the sub-agent call under ctx.waitUntil so
        // the webhook response returns before the triage is written.
        // In the real facet runtime the DO's waitUntil keeps the
        // isolate alive until the promise settles; here we flush it
        // explicitly to make the assertion deterministic (no setTimeout
        // race).
        await Promise.all(pendingWork);

        // Row shape assertion: triage column populated with the mocked
        // string, proving the round-trip ran end-to-end and the
        // sub-agent's response actually reached sql.exec.
        const rows = doSql
          .exec("SELECT id, title, triage FROM issues WHERE id = ?", issueId)
          .toArray() as Array<{
          id: string;
          title: string;
          triage: string | null;
        }>;
        expect(rows).toHaveLength(1);
        expect(rows[0].id).toBe(issueId);
        expect(rows[0].title).toBe("login crashes on Safari");
        expect(rows[0].triage).toBe("TRIAGE: duplicate of LIN-42");
      } finally {
        restore();
      }
    });
  });
});
