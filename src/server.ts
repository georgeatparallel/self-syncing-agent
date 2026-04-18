import { createAnthropic } from "@ai-sdk/anthropic";
import { callable, routeAgentRequest } from "agents";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { convertToModelMessages, stepCountIs, streamText } from "ai";
import { Hono } from "hono";
import { applySchemaMigrations } from "./db/schema";
import { buildContextMessages } from "./agent/context";
import { buildTools } from "./agent/tools";
import { SYSTEM_PROMPT } from "./agent/system-prompt";
import { getSyncById, listSyncs, getSyncErrorCountSince } from "./db/syncs";
import { logSyncError, getRecentSyncErrors } from "./db/sync-errors";
import { attachFacet } from "./facet/loader";
import { verifyLinearSignature } from "./webhook/hmac";

export { HttpGateway } from "./proxy/http-gateway";

const MODEL_ID = "claude-opus-4-7";

export class ChatAgent extends AIChatAgent<Env> {
  maxPersistedMessages = 100;

  /**
   * Re-declare `env` as public so tool factories can reach bindings
   * (ANTHROPIC_API_KEY, PARALLEL_API_KEY) via `agent.env.*`. The base
   * DurableObject declares it `protected`, which is fine inside methods
   * of this class but blocks access from extracted modules.
   */
  declare env: Env;

  /**
   * Same story as `env`: expose `ctx` publicly so tools can access
   * `agent.ctx.facets` for Durable Object Facet operations (create_sync
   * and friends from Phase 08 onwards). The base's declared type
   * parameterizes on `{}` (Props); our tools only use `ctx.facets`, so
   * the widening to `unknown` Props is harmless.
   */
  declare ctx: DurableObjectState<{}>;

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

  /**
   * Ensure schema is applied before any supervisor-SQLite read. Required
   * for any method reached via direct DO RPC (which bypasses the Agents
   * SDK routing that normally runs setName → onStart). Idempotent —
   * applySchemaMigrations is CREATE TABLE IF NOT EXISTS.
   */
  #ensureSchema() {
    applySchemaMigrations(this.sql.bind(this));
  }

  // userId is taken from the URL path by the webhook route, not from
  // this.name — the webhook path reaches the DO via direct RPC and
  // bypasses the Agents SDK routing that normally calls setName().
  // On a cold-started instance (webhook delivery after DO hibernated),
  // this.name throws. Accepting userId as a parameter keeps this method
  // self-contained and avoids depending on SDK name-hydration behavior.
  async handleWebhookDelivery(
    userId: string,
    syncId: string,
    bodyBytes: ArrayBuffer,
    signatureHex: string | null
  ): Promise<{ status: number; body: string }> {
    this.#ensureSchema();
    const sql = this.sql.bind(this);
    const sync = getSyncById(sql, syncId);
    if (!sync) return { status: 404, body: "sync not found" };

    const body = new Uint8Array(bodyBytes);
    if (
      !signatureHex ||
      !(await verifyLinearSignature(body, signatureHex, sync.webhook_secret))
    ) {
      return { status: 401, body: "invalid signature" };
    }

    const facet = attachFacet(this.env, this.ctx.facets, sync, userId);

    // Rebuild a minimal Request for the facet. Agent handlers read the
    // body via request.json(); headers beyond content-type are not part
    // of the documented handler contract.
    const facetRequest = new Request("https://facet.internal/webhook", {
      method: "POST",
      body: body,
      headers: { "content-type": "application/json" }
    });

    try {
      const facetResponse = await facet.fetch(facetRequest);
      if (facetResponse.status >= 500) {
        logSyncError(sql, {
          sync_id: sync.id,
          payload_preview: payloadPreview(body),
          error_message: `facet returned ${facetResponse.status}`,
          stack_trace: null,
          handler_version: sync.version
        });
        return { status: 500, body: "handler failed" };
      }
      // 2xx or 4xx from the handler both mean "processed" from Linear's
      // point of view — the handler intentionally returning 4xx is its
      // way of saying "I saw this and dropped it". Either way, we tell
      // Linear 200 so it doesn't retry.
      return { status: 200, body: "ok" };
    } catch (e) {
      logSyncError(sql, {
        sync_id: sync.id,
        payload_preview: payloadPreview(body),
        error_message: e instanceof Error ? e.message : String(e),
        stack_trace: e instanceof Error ? (e.stack ?? null) : null,
        handler_version: sync.version
      });
      return { status: 500, body: "handler failed" };
    }
  }

  /**
   * Supervisor-SQLite-only summary of this user's syncs. No facet attach —
   * cheap enough to be safe on every signal-driven refetch. Fields are
   * sized to what the sidebar card renders: id/name/integration/version,
   * error count in the last hour (red badge if >0), last-updated timestamp.
   */
  async listSyncsSummary(): Promise<
    Array<{
      id: string;
      name: string;
      integration: string;
      version: number;
      error_count_1h: number;
      updated_at: number;
    }>
  > {
    // Defensive: direct RPC calls bypass the Agents SDK's routing path
    // that normally calls setName() → onStart(). For a fresh DO that's
    // never been touched, the syncs table wouldn't exist yet.
    // #ensureSchema is idempotent (CREATE TABLE IF NOT EXISTS).
    this.#ensureSchema();
    const sql = this.sql.bind(this);
    const syncs = listSyncs(sql);
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    return syncs.map((s) => ({
      id: s.id,
      name: s.name,
      integration: s.integration,
      version: s.version,
      error_count_1h: getSyncErrorCountSince(sql, s.id, oneHourAgo),
      updated_at: s.updated_at
    }));
  }

  /**
   * Full per-sync payload for the sidebar's expanded card. Hits the facet
   * via `__query` once per table to get row counts — more expensive than
   * the summary, so this is fetched lazily when a user expands a card,
   * not on every change-tick.
   *
   * userId is accepted as a parameter (not read from this.name) because
   * this method is reached via direct RPC from the Hono route and bypasses
   * the Agents SDK routing that would normally call setName(). Same
   * pattern as handleWebhookDelivery — see its jsdoc for the full
   * rationale.
   */
  async getSyncDetails(
    userId: string,
    syncId: string
  ): Promise<{
    sync: {
      id: string;
      name: string;
      integration: string;
      version: number;
      handler_code: string;
      schema_ddl: string;
      updated_at: number;
    };
    row_counts: Record<string, number>;
    errors: Array<{
      created_at: number;
      error_message: string;
      stack_trace: string | null;
      payload_preview: string | null;
      handler_version: number;
    }>;
  } | null> {
    // Same rationale as listSyncsSummary: defensive idempotent migration
    // for first-touch-via-RPC cases.
    this.#ensureSchema();
    const sql = this.sql.bind(this);
    const sync = getSyncById(sql, syncId);
    if (!sync) return null;

    // Parse CREATE TABLE statements from the sync's schema_ddl to get the
    // table names we should COUNT(*) against. Naive — splits on ";" then
    // regex-matches the table name. Robust enough for the CREATE TABLE
    // IF NOT EXISTS shape the agent writes; skips CREATE INDEX / other.
    const tableNames = extractTableNames(sync.schema_ddl);

    const facet = attachFacet(this.env, this.ctx.facets, sync, userId);
    const row_counts: Record<string, number> = {};
    for (const table of tableNames) {
      const result = await (
        facet as unknown as {
          __query: (
            sql: string
          ) => Promise<
            | { ok: true; rows: Array<{ c: number }> }
            | { ok: false; error: string }
          >;
        }
      ).__query(`SELECT COUNT(*) as c FROM ${table}`);
      row_counts[table] = result.ok ? (result.rows[0]?.c ?? 0) : 0;
    }

    // Re-map `occurred_at` (the schema column name) to `created_at` in
    // the public API payload. The plan and the sidebar UI speak the
    // `created_at` name, while the DB has historically used
    // `occurred_at`.
    const errors = getRecentSyncErrors(sql, syncId, 10).map((e) => ({
      created_at: e.occurred_at,
      error_message: e.error_message,
      stack_trace: e.stack_trace,
      payload_preview: e.payload_preview,
      handler_version: e.handler_version
    }));

    return {
      sync: {
        id: sync.id,
        name: sync.name,
        integration: sync.integration,
        version: sync.version,
        handler_code: sync.handler_code,
        schema_ddl: sync.schema_ddl,
        updated_at: sync.updated_at
      },
      row_counts,
      errors
    };
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
      system: {
        role: "system",
        content: SYSTEM_PROMPT,
        providerOptions: {
          anthropic: { cacheControl: { type: "ephemeral" } }
        }
      },
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

/**
 * HTTP router. /webhook/:userId/:syncId is handled directly; everything
 * else falls through to the Agents SDK (chat, MCP, WebSocket upgrade).
 * Keeping Agents SDK as the catch-all (rather than mounting it under a
 * prefix) matches the default template we started from.
 */
const app = new Hono<{ Bindings: Env }>();

app.post("/webhook/:userId/:syncId", async (c) => {
  const { userId, syncId } = c.req.param();
  const stub = c.env.ChatAgent.get(c.env.ChatAgent.idFromName(userId));
  const bodyBytes = await c.req.arrayBuffer();
  const signatureHex = c.req.header("linear-signature") ?? null;
  const result = await stub.handleWebhookDelivery(
    userId,
    syncId,
    bodyBytes,
    signatureHex
  );
  // `new Response` instead of `c.text(body, status)` because Hono's
  // helpers type `status` as its `StatusCode` union — our RPC return
  // is a plain `number`, and widening the cast at every return site
  // is noisier than constructing the Response directly.
  return new Response(result.body, { status: result.status });
});

// Any non-POST method on the webhook path → 405. Hono evaluates route
// registrations in order, so this `.all(...)` only fires when the more
// specific `.post(...)` above has already rejected the method.
app.all("/webhook/:userId/:syncId", (c) =>
  c.text("method not allowed", 405, { Allow: "POST" })
);

app.get("/api/user/:userId/syncs-summary", async (c) => {
  const { userId } = c.req.param();
  const stub = c.env.ChatAgent.get(c.env.ChatAgent.idFromName(userId));
  const syncs = await stub.listSyncsSummary();
  return c.json({ syncs });
});

app.get("/api/user/:userId/syncs/:syncId/details", async (c) => {
  const { userId, syncId } = c.req.param();
  const stub = c.env.ChatAgent.get(c.env.ChatAgent.idFromName(userId));
  const details = await stub.getSyncDetails(userId, syncId);
  if (!details) return c.json({ error: "not_found" }, 404);
  return c.json(details);
});

// Fallthrough: everything else (chat WebSocket upgrade, MCP, etc.)
// goes to the Agents SDK router.
app.all("*", async (c) => {
  const res = await routeAgentRequest(c.req.raw, c.env);
  return res ?? c.text("Not found", 404);
});

export default {
  fetch: app.fetch
} satisfies ExportedHandler<Env>;

/**
 * First ~2KB of the raw webhook body, decoded as UTF-8. Stored on
 * sync_errors rows so the agent can look at what actually arrived
 * without re-asking Linear. Truncated hard at 2048 bytes; no attempt
 * to avoid splitting a UTF-8 codepoint because lossy previews are
 * fine for human debugging.
 */
const PAYLOAD_PREVIEW_MAX_BYTES = 2048;
function payloadPreview(body: Uint8Array): string {
  const slice = body.subarray(0, PAYLOAD_PREVIEW_MAX_BYTES);
  return new TextDecoder("utf-8", { fatal: false }).decode(slice);
}

/**
 * Pull table names from a `CREATE TABLE [IF NOT EXISTS] <name> (...)`
 * sequence in the schema DDL. Skips CREATE INDEX / triggers / anything
 * that isn't CREATE TABLE. Naive regex — sufficient for the schema
 * shapes the agent is trained to emit.
 */
function extractTableNames(ddl: string): string[] {
  const names: string[] = [];
  const pattern =
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?([a-zA-Z_][a-zA-Z0-9_]*)["`]?/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(ddl)) !== null) {
    if (match[1]) names.push(match[1]);
  }
  return names;
}
