import { createAnthropic } from "@ai-sdk/anthropic";
import { callable, routeAgentRequest } from "agents";
import {
  AIChatAgent,
  type OnChatMessageOptions,
  type ChatResponseResult
} from "@cloudflare/ai-chat";
import { convertToModelMessages, stepCountIs, streamText } from "ai";
import { Hono } from "hono";
import { applySchemaMigrations } from "./db/schema";
import { buildContextMessages } from "./agent/context";
import { buildTools } from "./agent/tools";
import { SYSTEM_PROMPT } from "./agent/system-prompt";
import {
  getSyncById,
  listSyncs,
  getSyncErrorCountSince,
  touchSyncUpdatedAt
} from "./db/syncs";
import { logSyncError, getRecentSyncErrors } from "./db/sync-errors";
import {
  upsertConnectedAccount,
  listConnectedAccounts
} from "./db/connected-accounts";
import type { ConnectedAccount } from "./db/types";
import { getCachedAccessToken, createConnectToken } from "./pipedream";
import { attachFacet } from "./facet/loader";

export { HttpGateway } from "./proxy/http-gateway";
export { LLMGateway } from "./agent-runtime/llm-gateway";

const MODEL_ID = "claude-opus-4-7";

export class ChatAgent extends AIChatAgent<Env, { syncChangeTick: number }> {
  maxPersistedMessages = 100;

  /**
   * Default state for new/fresh DO instances. The Agents SDK's state
   * getter returns this when no state has been persisted yet, which
   * removes the need for null-fallbacks in every setState writer.
   */
  initialState = { syncChangeTick: 0 };

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

  /**
   * The DO state shape is declared via the `AIChatAgent<Env, State>` generic
   * above — `{ syncChangeTick: number }`. The Agents SDK syncs this state
   * to every connected client via WebSocket. `syncChangeTick` is a dataless
   * signal — a monotonically-increasing integer bumped whenever something
   * in the user's syncs may have changed (a tool call finished, a webhook
   * landed, etc.). The client hook watches this field and refetches the
   * summary when it changes. No payload needed; the tick's only job is
   * "something changed, go look again."
   */

  /**
   * Bump the signal tick. Safe to call multiple times in one turn —
   * the client collapses consecutive updates via React's dep array.
   */
  #bumpChangeTick() {
    this.setState({
      ...this.state,
      syncChangeTick: this.state.syncChangeTick + 1
    });
  }

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
  // this.name throws.
  //
  // Phase 13 introduced #bumpChangeTick() in the finally block below,
  // which calls this.setState(...). The SDK's setState internally emits
  // to all connected clients and reads this.name to tag the broadcast —
  // so simply accepting userId as a parameter isn't enough anymore; we
  // have to hydrate this.name explicitly. setName is idempotent (no-op
  // if already set) and does not re-trigger onStart.
  async handleWebhookDelivery(
    userId: string,
    syncId: string,
    bodyBytes: ArrayBuffer,
    headers: Record<string, string>
  ): Promise<{ status: number; body: string }> {
    await this.setName(userId);
    this.#ensureSchema();
    const sql = this.sql.bind(this);
    const sync = getSyncById(sql, syncId);
    if (!sync) return { status: 404, body: "sync not found" };

    const body = new Uint8Array(bodyBytes);

    // Attach the facet before the signature check — verifySignature lives
    // inside handler.js and needs the facet isolate running. Worker Loader
    // caches the compiled bundle, so invalid-signature deliveries pay the
    // compilation cost once per facet lifetime (cheap), not per delivery.
    const facet = attachFacet(this.env, this.ctx.facets, sync, userId);

    try {
      // Signature verification is delegated to the handler's verifySignature
      // export via the facet wrapper's __verifySignature RPC. Missing export
      // or thrown error → false → 401. See src/facet/wrapper.ts for contract.
      const verifyResult = await (
        facet as unknown as {
          __verifySignature(
            body: Uint8Array,
            headers: Record<string, string>,
            secret: string
          ): Promise<boolean>;
        }
      ).__verifySignature(body, headers, sync.webhook_secret);
      if (!verifyResult) {
        // Log the rejection so accumulated 401s are visible in sync_errors
        // (with occurred_at timestamps) — the agent's 401-triage rubric in
        // the system prompt relies on this. Pre-Phase-C, 401 was an early
        // return that skipped logging ("nothing new for the sidebar"); that
        // changes here because a 401 now almost certainly means the agent's
        // verifySignature is buggy, which the agent must be able to see.
        logSyncError(sql, {
          sync_id: sync.id,
          payload_preview: payloadPreview(body),
          error_message: "signature verification rejected by handler",
          stack_trace: null,
          handler_version: sync.version
        });
        return { status: 401, body: "invalid signature" };
      }

      // Rebuild a minimal Request for the facet. Agent handlers read the
      // body via request.json(); headers beyond content-type are not part
      // of the documented handler contract.
      const facetRequest = new Request("https://facet.internal/webhook", {
        method: "POST",
        body: body,
        headers: { "content-type": "application/json" }
      });
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
      //
      // Touch the supervisor's syncs.updated_at so the ops-panel
      // summary's relative timestamp reflects real webhook activity,
      // not just create/update_sync calls. The facet is unaffected.
      touchSyncUpdatedAt(sql, sync.id);
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
    } finally {
      // Fires on every non-404 path (2xx, 401, 5xx, throw) — all of which
      // log something actionable (the 200 path bumps updated_at via
      // touchSyncUpdatedAt; the 401/5xx/throw paths write a sync_errors
      // row). 404 early-returns before the try, so it still skips the bump
      // — nothing changed for that path and no row was touched.
      this.#bumpChangeTick();
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

  /**
   * Mint a short-lived Pipedream connect token scoped to this user. The
   * token is handed to Pipedream's Connect Link UI so the user can complete
   * OAuth without us brokering credentials. No DB access — this.env holds
   * the project/client creds, and the cached access_token lives in a
   * module-level map in token-cache.ts.
   *
   * userId is a parameter (not read from this.name) because this method is
   * reached via direct RPC from the Hono route, which bypasses the Agents
   * SDK routing that would normally call setName(). Same pattern as
   * handleWebhookDelivery/getSyncDetails.
   */
  async mintPipedreamToken(
    userId: string
  ): Promise<{ token: string; connectLinkUrl: string }> {
    await this.setName(userId);
    const accessToken = await getCachedAccessToken(this.env);
    return createConnectToken(this.env, accessToken, userId);
  }

  /**
   * Persist a (user_id, app_slug, account_id) mapping after a successful
   * Pipedream Connect flow. Idempotent via INSERT OR REPLACE on the
   * composite PK — re-connecting the same app for the same user overwrites
   * the prior account_id. Bumps the change-tick so the sidebar refetches.
   */
  async persistPipedreamAccount(
    userId: string,
    app_slug: string,
    account_id: string
  ): Promise<void> {
    await this.setName(userId);
    this.#ensureSchema();
    upsertConnectedAccount(this.sql.bind(this), {
      user_id: userId,
      app_slug,
      account_id,
      connected_at: Date.now()
    });
    this.#bumpChangeTick();
  }

  /**
   * List all connected accounts for this user, newest-first. Supervisor-
   * SQLite-only; no facet attach.
   */
  async listPipedreamAccounts(userId: string): Promise<ConnectedAccount[]> {
    await this.setName(userId);
    this.#ensureSchema();
    return listConnectedAccounts(this.sql.bind(this), userId);
  }

  /**
   * Resolve a single app's connected account_id for this user, or null if
   * the user hasn't linked that app. Supervisor-SQLite-only; no facet
   * attach. Same direct-RPC hydration pattern as siblings — setName first,
   * then ensure schema.
   */
  async getConnectedAccountId(
    userId: string,
    appSlug: string
  ): Promise<string | null> {
    await this.setName(userId);
    this.#ensureSchema();
    const rows = listConnectedAccounts(this.sql.bind(this), userId);
    const found = rows.find((r) => r.app_slug === appSlug);
    return found ? found.account_id : null;
  }

  @callable()
  async addServer(name: string, url: string) {
    return await this.addMcpServer(name, url);
  }

  @callable()
  async removeServer(serverId: string) {
    await this.removeMcpServer(serverId);
  }

  /**
   * Fires on every turn-completion path: normal completion, abort, and
   * errors — strictly broader than streamText's onFinish callback, which
   * doesn't fire on client-initiated abort. We use this as the signal
   * source for the ops panel because an aborted turn may still have
   * completed tool calls that mutated supervisor or facet state before
   * the abort landed; the sidebar should refetch regardless of outcome.
   */
  protected onChatResponse(_result: ChatResponseResult) {
    this.#bumpChangeTick();
  }

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const anthropic = createAnthropic({ apiKey: this.env.ANTHROPIC_API_KEY });
    const sql = this.sql.bind(this);

    const messages = [
      ...buildContextMessages(sql),
      ...(await convertToModelMessages(this.messages))
    ];

    // Breakpoint b4: cache up through the new user message. Writes a
    // fresh entry each turn; next turn's request walks back within the
    // 20-block lookback window and hits the prior write at what is now
    // a frozen history position. Mutation is local to this messages
    // array — `this.messages` is untouched.
    if (messages.length > 0) {
      const last = messages[messages.length - 1];
      last.providerOptions = {
        ...last.providerOptions,
        anthropic: { cacheControl: { type: "ephemeral" } }
      };
    }

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
  // Pass all request headers through (lowercased keys) so the handler's
  // verifySignature export can read whatever header its upstream uses
  // (linear-signature, x-hub-signature-256, x-slack-signature, etc.).
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  const result = await stub.handleWebhookDelivery(
    userId,
    syncId,
    bodyBytes,
    headers
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

app.post("/api/user/:userId/pipedream/token", async (c) => {
  const { userId } = c.req.param();
  const stub = c.env.ChatAgent.get(c.env.ChatAgent.idFromName(userId));
  const result = await stub.mintPipedreamToken(userId);
  return c.json(result);
});

app.post("/api/user/:userId/pipedream/account", async (c) => {
  const { userId } = c.req.param();
  const body = await c.req.json<{ app_slug?: string; account_id?: string }>();
  if (!body.app_slug || !body.account_id) {
    return c.json({ error: "missing_fields" }, 400);
  }
  const stub = c.env.ChatAgent.get(c.env.ChatAgent.idFromName(userId));
  await stub.persistPipedreamAccount(userId, body.app_slug, body.account_id);
  return c.json({ ok: true });
});

app.get("/api/user/:userId/pipedream/accounts", async (c) => {
  const { userId } = c.req.param();
  const stub = c.env.ChatAgent.get(c.env.ChatAgent.idFromName(userId));
  const accounts = await stub.listPipedreamAccounts(userId);
  return c.json({ accounts });
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
