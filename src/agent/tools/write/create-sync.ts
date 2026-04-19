import { tool } from "ai";
import { z } from "zod";
import type { ChatAgent } from "../../../server";
import { createSync, getSyncByName } from "../../../db/syncs";
import {
  registerLinearWebhook,
  unregisterLinearWebhook,
  LinearApiError
} from "../../../integrations/linear-api";
import { attachFacet } from "../../../facet/loader";
import type { NewSync } from "../../../db/types";

export function createSyncTool(agent: ChatAgent) {
  return tool({
    description: `Create a new sync. Registers a webhook with the upstream service, loads the agent-authored handler into an isolated facet runtime with its own SQLite, applies the schema DDL, and persists the sync registry row. Approval-gated — the user sees the drafted schema_ddl and handler_code in the approval dialog before anything runs. Call this AFTER you've shown the draft in chat.

handler_code contract: JavaScript module source that MUST export TWO async functions:

1) \`async function verifySignature(body, headers, secret): Promise<boolean>\`
   — Called by the supervisor BEFORE handleWebhook on every delivery.
   - \`body\` is a Uint8Array of the raw request body.
   - \`headers\` is a Record<string, string> with lowercased keys.
   - \`secret\` is the webhook_secret the upstream registration returned (stored for you, passed in at call time — never hardcode it).
   - Return true to accept the delivery, false (or throw) to reject it — the supervisor returns 401 on false / thrown.
   - REQUIRED. A missing export fails closed (supervisor returns 401 for every delivery), so every handler must own its signature verification. Each upstream signs differently: Linear uses HMAC-SHA256-hex in \`linear-signature\`; GitHub uses \`x-hub-signature-256: sha256=<hex>\`; Slack uses \`v0:<timestamp>:<body>\` signed with HMAC and shipped in \`x-slack-signature\` as \`v0=<hex>\`. Check the upstream's docs if unsure.

2) \`async function handleWebhook(request, sql, ctx): Promise<Response>\`
   — Called AFTER the signature has been verified.
   - \`request\` is the raw webhook POST.
   - \`sql\` is the facet's own SQLite. \`sql.exec(query, ...bindings)\` for inserts/updates; \`sql.exec(query, ...bindings).toArray()\` for reads.
   - \`ctx\` carries two capabilities:
     - \`ctx.waitUntil(promise)\` — keep background work alive past the 200 response. Use this so the webhook returns a fast 200 while enrichment runs afterwards.
     - \`ctx.agent({ model?, system, messages, maxSteps? })\` — spawn a sub-agent ReAct loop and get back a string. \`model\` is \`"haiku" | "sonnet" | "opus"\` (default \`"sonnet"\`). The sub-agent has three built-in tools: \`sql\` (reads + writes the facet's SQLite), \`fetch\` (upstream HTTP through the same credential-injecting proxy as the handler's own fetch), and \`exec\` (runs an agent-authored JS module in a fresh isolate). No nested \`ctx.agent()\` calls permitted.
   - Return a 2xx Response for successful processing (including "filtered out, nothing to write" — use 200). Return 5xx only if you want the upstream to retry.
   - Be idempotent. Upstreams may deliver the same event twice — use INSERT OR REPLACE or ON CONFLICT keyed on the resource's stable id from the payload.
   - Do not import anything beyond the parameters. \`fetch\` is globally available for upstream API calls (the proxy injects auth automatically); most write-path handlers don't need it.
   - Keep it fast. Upstream webhook timeouts are typically 5–30 seconds. If you need longer LLM reasoning, run it inside \`ctx.waitUntil(ctx.agent(...))\` so the 200 returns immediately and the sub-agent enriches the row in the background.

Example handler for Linear (HMAC-SHA256-hex signature scheme):
\`\`\`js
export async function verifySignature(body, headers, secret) {
  const sig = headers["linear-signature"];
  if (!sig) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const computed = await crypto.subtle.sign("HMAC", key, body);
  const hex = [...new Uint8Array(computed)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hex === sig;
}

export async function handleWebhook(request, sql, ctx) {
  const payload = await request.json();
  const id = payload.data.id;
  sql.exec(
    "INSERT OR REPLACE INTO issues (id, title, priority, created_at) VALUES (?, ?, ?, ?)",
    id,
    payload.data.title,
    payload.data.priority,
    Date.now()
  );
  if (payload.data.priority === 1) {
    ctx.waitUntil(
      ctx.agent({
        model: "sonnet",
        system: "You are a Linear triage bot. Given an issue payload, write one sentence describing the likely root cause or next action.",
        messages: [{ role: "user", content: JSON.stringify(payload.data) }]
      }).then((note) =>
        sql.exec("UPDATE issues SET triage = ? WHERE id = ?", note, id)
      )
    );
  }
  return new Response("ok", { status: 200 });
}
\`\`\`

For unfamiliar integrations or resource types: use the probe loop (described in the system prompt) before drafting the real handler. Don't guess payload field names from training data. Likewise, don't guess signature schemes — check the upstream's webhook documentation for which header name, hashing algorithm, and encoding (hex vs base64, prefix, etc.) the upstream uses.`,
    inputSchema: z.object({
      name: z
        .string()
        .min(1)
        .max(64)
        .regex(
          /^[a-zA-Z0-9_-]+$/,
          "name must be alphanumeric + hyphens/underscores only (it is used as the facet name)"
        )
        .describe(
          "User-visible sync label. Must be unique per user. Also used as the facet's name. Prefix throwaway probe syncs with 'probe-' so they're obviously disposable."
        ),
      integration: z
        .enum(["linear"])
        .describe("Upstream integration identifier."),
      resource_types: z
        .array(z.string().min(1))
        .min(1)
        .describe(
          "Upstream resource types to subscribe the webhook to. Pick the minimal set that covers the user's ask — extra types just wake the facet for no-op deliveries. Look up valid values per integration via web_search if unsure."
        ),
      schema_ddl: z
        .string()
        .describe(
          "One or more CREATE TABLE / CREATE INDEX statements separated by semicolons. Use CREATE TABLE IF NOT EXISTS so re-applying is safe. SQLite types only: TEXT, INTEGER, REAL, BLOB, NULL. Store JSON-shaped fields (arrays, nested metadata) as TEXT and parse at read time. REQUIRED: include a `created_at INTEGER NOT NULL` column on every table holding webhook-ingested rows, populated with `Date.now()` at INSERT time. This is a debuggability requirement — the 401-triage rubric (see the system prompt) cross-references ingestion timestamps against sync_errors.occurred_at to distinguish 'verifier broken' from 'scanner noise'. Without it, the agent cannot self-diagnose why a sync has gone silent."
        ),
      handler_code: z
        .string()
        .describe(
          "JavaScript module source that exports `async function verifySignature(body, headers, secret)` AND `async function handleWebhook(request, sql, ctx)`. Both exports are required. See the tool description for the full contract and a Linear example."
        ),
      filter_description: z
        .string()
        .optional()
        .describe(
          "One-line human summary of what this sync tracks, e.g. 'only issues labeled bug in Core team'. Displayed in the UI and in ambient context."
        )
    }),
    needsApproval: true,
    execute: async ({
      name,
      integration,
      resource_types,
      schema_ddl,
      handler_code,
      filter_description
    }): Promise<
      | { ok: true; sync_id: string; linear_webhook_id: string }
      | { ok: false; error: string; detail: string }
    > => {
      const sql = agent.sql.bind(agent);
      const userId = agent.name;

      // 0. Misconfiguration guard: PUBLIC_BASE_URL must be set to a public
      //    URL before Linear can reach our webhooks. Catching here turns a
      //    mysterious "Linear rejected the URL" error into an actionable
      //    ops error the user can explain to whoever deployed the worker.
      if (!agent.env.PUBLIC_BASE_URL) {
        return {
          ok: false,
          error: "misconfigured",
          detail:
            "PUBLIC_BASE_URL is not set. Set it to the worker's public URL (e.g. https://self-syncing-agent.<account>.workers.dev) before creating syncs."
        };
      }

      // 1. Uniqueness check (friendly error before we start doing real work)
      if (getSyncByName(sql, name)) {
        return {
          ok: false,
          error: "duplicate_name",
          detail: `A sync named "${name}" already exists for this user.`
        };
      }

      const syncId = crypto.randomUUID();
      const webhookUrl = `${agent.env.PUBLIC_BASE_URL}/webhook/${userId}/${syncId}`;
      const webhookLabel = `self-syncing-agent:${userId.slice(0, 8)}:${name}`;

      // 2. Register webhook with Linear (this is the network-touching step;
      //    if it fails we haven't touched any local state yet)
      let registered;
      try {
        registered = await registerLinearWebhook(
          agent.env.LINEAR_ACCESS_TOKEN,
          webhookUrl,
          resource_types,
          webhookLabel
        );
      } catch (e) {
        if (e instanceof LinearApiError) {
          return { ok: false, error: e.code, detail: e.message };
        }
        throw e;
      }

      // 3. Build the NewSync record and persist. If this throws (e.g., UNIQUE
      //    name check lost a race), roll back the upstream webhook.
      const codeId = `sync:${syncId}:v1`;
      const newSync: NewSync = {
        id: syncId,
        name,
        integration,
        handler_code,
        schema_ddl,
        filter_description: filter_description ?? null,
        webhook_secret: registered.secret,
        upstream_webhook_id: registered.id,
        code_id: codeId
      };

      let created;
      try {
        created = createSync(sql, newSync);
      } catch (e) {
        // Rollback step 2.
        await safeUnregister(agent.env.LINEAR_ACCESS_TOKEN, registered.id);
        return {
          ok: false,
          error: "persist_failed",
          detail: e instanceof Error ? e.message : String(e)
        };
      }

      // 4. Attach the facet and force Worker Loader to compile the bundle.
      //    If the agent's handler.js has a syntax error or is missing the
      //    handleWebhook export, the ping call rejects and we roll back
      //    both the DB row and the upstream webhook. Schema application
      //    stays on the fetch path — the first real webhook will apply it.
      try {
        const facet = attachFacet(agent.env, agent.ctx.facets, created, userId);
        await (
          facet as unknown as { __supervisorPing(): Promise<void> }
        ).__supervisorPing();
      } catch (e) {
        // Rollback step 3 (DB) and step 2 (Linear).
        try {
          agent.ctx.facets.delete(name);
        } catch {
          // facets.delete throws if the facet never actually started;
          // swallow since our DB row still needs cleanup.
        }
        sql`DELETE FROM syncs WHERE id = ${syncId}`;
        await safeUnregister(agent.env.LINEAR_ACCESS_TOKEN, registered.id);
        return {
          ok: false,
          error: "facet_load_failed",
          detail: e instanceof Error ? e.message : String(e)
        };
      }

      return {
        ok: true,
        sync_id: syncId,
        linear_webhook_id: registered.id
      };
    }
  });
}

async function safeUnregister(
  accessToken: string,
  webhookId: string
): Promise<void> {
  try {
    await unregisterLinearWebhook(accessToken, webhookId);
  } catch (e) {
    // Rollback best-effort — the user gets an error message about the
    // original failure; the orphaned Linear webhook can be cleaned up
    // out-of-band via Linear UI if this ever happens in practice.
    console.error(
      `safeUnregister: failed to unregister ${webhookId}:`,
      e instanceof Error ? e.message : e
    );
  }
}
