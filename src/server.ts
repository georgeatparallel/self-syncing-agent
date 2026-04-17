import { createAnthropic } from "@ai-sdk/anthropic";
import { callable, routeAgentRequest } from "agents";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { convertToModelMessages, stepCountIs, streamText } from "ai";
import { Hono } from "hono";
import { applySchemaMigrations } from "./db/schema";
import { buildContextMessages } from "./agent/context";
import { buildTools } from "./agent/tools";
import { SYSTEM_PROMPT } from "./agent/system-prompt";
import { getSyncById } from "./db/syncs";
import { logSyncError } from "./db/sync-errors";
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

  async handleWebhookDelivery(
    syncId: string,
    bodyBytes: ArrayBuffer,
    signatureHex: string | null
  ): Promise<{ status: number; body: string }> {
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

    const userId = this.name;
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
