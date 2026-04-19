import { tool } from "ai";
import { z } from "zod";
import type { ChatAgent } from "../../../server";
import { createSync, getSyncByName } from "../../../db/syncs";
import { attachFacet } from "../../../facet/loader";
import type { NewSync, Sync, Integration } from "../../../db/types";

// Typed RPC surface for the facet's Phase D methods. The cast is local to
// this file — matches the pattern used elsewhere (query-sync.ts,
// update-sync.ts, server.ts) for facet RPCs that aren't on the generic
// DurableObjectStub type.
interface FacetRegisterRpc {
  __supervisorPing(): Promise<void>;
  __registerWebhook(config: {
    callbackUrl: string;
    label: string;
  }): Promise<{ id: string; secret: string }>;
  __unregisterWebhook(config: {
    id: string;
    label: string;
  }): Promise<{ ok: true } | { ok: false; reason: string; detail?: string }>;
}

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
        .string()
        .min(1)
        .describe(
          "Human-readable label for the upstream service (e.g., 'linear', 'github', 'slack'). Freeform — used for UI display and ambient context, not as a code selector. Use a consistent slug across the user's sync list."
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
      schema_ddl,
      handler_code,
      filter_description
    }): Promise<
      | { ok: true; sync_id: string; upstream_webhook_id: string }
      | { ok: false; error: string; detail: string }
    > => {
      const sql = agent.sql.bind(agent);
      const userId = agent.name;

      // 0. Misconfiguration guard.
      if (!agent.env.PUBLIC_BASE_URL) {
        return {
          ok: false,
          error: "misconfigured",
          detail:
            "PUBLIC_BASE_URL is not set. Set it to the worker's public URL (e.g. https://self-syncing-agent.<account>.workers.dev) before creating syncs."
        };
      }

      // 1. Uniqueness check.
      if (getSyncByName(sql, name)) {
        return {
          ok: false,
          error: "duplicate_name",
          detail: `A sync named "${name}" already exists for this user.`
        };
      }

      const syncId = crypto.randomUUID();
      const callbackUrl = `${agent.env.PUBLIC_BASE_URL}/webhook/${userId}/${syncId}`;
      const label = `self-syncing-agent:${userId.slice(0, 8)}:${name}`;

      // 2. Build a PRELIMINARY NewSync with placeholder webhook_secret +
      //    upstream_webhook_id. The facet bundle doesn't bake either of
      //    these into generated code (verified in Task 2 Step 1 against
      //    src/facet/bundle.ts — only schema_ddl, handler_code, and
      //    userId end up in the loaded modules) — the secret is a runtime
      //    arg to __verifySignature; the upstream id is only used by
      //    delete_sync. So the preliminary attach is safe.
      const codeId = `sync:${syncId}:v1`;
      const preliminarySync: NewSync = {
        id: syncId,
        name,
        // `integration` is now a free-form string on the input, but
        // NewSync.integration is still typed as the narrow `Integration`
        // union. Cast at the boundary — Phase D intentionally widens the
        // agent-visible label; a follow-up can widen the DB type if we
        // want stricter tracking.
        integration: integration as Integration,
        handler_code,
        schema_ddl,
        filter_description: filter_description ?? null,
        webhook_secret: "",
        upstream_webhook_id: "",
        code_id: codeId
      };

      // 3. Attach + ping the facet to force Worker Loader compilation. If
      //    handler.js has a syntax error or is missing required exports,
      //    __supervisorPing rejects here and we bail before any network
      //    call to the upstream.
      const facet = attachFacet(
        agent.env,
        agent.ctx.facets,
        preliminarySync as unknown as Sync,
        userId
      );
      try {
        await (facet as unknown as FacetRegisterRpc).__supervisorPing();
      } catch (e) {
        try {
          agent.ctx.facets.delete(name);
        } catch {
          // facets.delete throws if the facet never actually started;
          // tolerate because the primary error is the compile failure.
        }
        return {
          ok: false,
          error: "facet_load_failed",
          detail: e instanceof Error ? e.message : String(e)
        };
      }

      // 4. Call the handler's registerWebhook to register the upstream
      //    webhook. The facet's fetch routes through HttpGateway →
      //    Pipedream proxy, so auth is injected automatically for
      //    Pipedream-connected apps. If the account isn't connected, the
      //    handler's fetch() call will get a 403 from HttpGateway and the
      //    handler should surface that as a thrown Error.
      let registered: { id: string; secret: string };
      try {
        const raw = await (
          facet as unknown as FacetRegisterRpc
        ).__registerWebhook({
          callbackUrl,
          label
        });
        if (
          !raw ||
          typeof raw !== "object" ||
          typeof (raw as { id?: unknown }).id !== "string" ||
          typeof (raw as { secret?: unknown }).secret !== "string" ||
          (raw as { id: string }).id.length === 0 ||
          (raw as { secret: string }).secret.length === 0
        ) {
          throw new Error(
            `registerWebhook returned invalid shape — expected { id: string, secret: string }, got: ${JSON.stringify(raw)}`
          );
        }
        registered = raw;
      } catch (e) {
        try {
          agent.ctx.facets.delete(name);
        } catch {
          // Tolerate — the register failure is the primary error.
        }
        return {
          ok: false,
          error: "webhook_register_failed",
          detail: e instanceof Error ? e.message : String(e)
        };
      }

      // 5. Persist the DB row with the real webhook_secret +
      //    upstream_webhook_id returned by the handler.
      const finalSync: NewSync = {
        ...preliminarySync,
        webhook_secret: registered.secret,
        upstream_webhook_id: registered.id
      };

      try {
        createSync(sql, finalSync);
      } catch (e) {
        // Persist failed after registerWebhook succeeded. Best-effort
        // unregister upstream so we don't leave a dangling webhook
        // pointing at a sync that doesn't exist locally. Errors from
        // __unregisterWebhook are tolerated — we still want to surface
        // the original persist_failed error.
        try {
          await (facet as unknown as FacetRegisterRpc).__unregisterWebhook({
            id: registered.id,
            label
          });
        } catch {
          // Swallow — the original persist error is what matters.
        }
        try {
          agent.ctx.facets.delete(name);
        } catch {
          // Tolerate.
        }
        return {
          ok: false,
          error: "persist_failed",
          detail: e instanceof Error ? e.message : String(e)
        };
      }

      return {
        ok: true,
        sync_id: syncId,
        upstream_webhook_id: registered.id
      };
    }
  });
}
