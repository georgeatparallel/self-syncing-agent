import { tool } from "ai";
import { z } from "zod";
import type { ChatAgent } from "../../../server";
import { createSync, getSyncByName } from "../../../db/syncs";
import { attachFacet } from "../../../facet/loader";
import type { NewSync, Sync } from "../../../db/types";

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
    description: `Create a new sync. Compiles the agent-authored handler into an isolated facet runtime with its own SQLite, applies the schema DDL, calls the handler's registerWebhook export to register the webhook with the upstream service, and persists the sync registry row. Approval-gated — the user sees the drafted schema_ddl and handler_code in the approval dialog before anything runs. Call this AFTER you've shown the draft in chat.

handler_code contract: JavaScript module source that MUST export FOUR async functions (the last is technically optional but strongly recommended for clean deletes).

1) \`async function verifySignature(body, headers, secret): Promise<boolean>\`
   Called BEFORE handleWebhook on every delivery. Return true to accept, false (or throw) to reject with 401.
   - body: Uint8Array of raw request body
   - headers: Record<string, string> with lowercased keys
   - secret: the secret returned from registerWebhook
   REQUIRED. Missing → every delivery 401s.

2) \`async function handleWebhook(request, sql, ctx): Promise<Response>\`
   Called AFTER signature has been verified.
   - request: raw webhook POST
   - sql: the facet's own SQLite. sql.exec(query, ...bindings) for writes; sql.exec(...).toArray() for reads.
   - ctx: { waitUntil, agent } — waitUntil for background work; ctx.agent({model, system, messages, maxSteps}) for sub-agent ReAct loops inside the delivery.
   Return a 2xx Response on success. Be idempotent (INSERT OR REPLACE keyed on stable upstream id).
   REQUIRED.

3) \`async function registerWebhook(fetch, config): Promise<{ id: string, secret: string }>\`
   Called ONCE at create_sync time to register the webhook with the upstream.
   - fetch: the global fetch, routes through the Pipedream credential-injecting proxy — auth headers are injected automatically for Pipedream-connected apps. You do NOT set Authorization headers yourself.
   - config: { callbackUrl: string, label: string } — callbackUrl is the URL the upstream should POST to; label is a human-readable tag.
   - Returns: { id: string, secret: string } — id used for later unregister; secret used by verifySignature. How you obtain \`secret\` depends on the upstream:
     - Some upstreams (Linear) return the secret from their webhookCreate mutation.
     - Others (GitHub) require you to generate a random secret and pass it at creation.
   REQUIRED. A thrown error or wrong return shape aborts create_sync.

4) \`async function unregisterWebhook(fetch, config): Promise<void>\`
   Called from delete_sync.
   - fetch: same proxy as above.
   - config: { id: string, label: string } where id is what registerWebhook returned.
   STRONGLY RECOMMENDED. If omitted, delete_sync deletes the local sync but leaves the upstream webhook registered (the user will see it in the upstream's dashboard and clean up manually). Provide this unless you know the upstream auto-cleans stale webhooks.

Handler-level guidance:
- No imports beyond the parameters. \`fetch\` and \`crypto\` are global; \`Date\`, \`TextEncoder\`, etc. work normally.
- Keep handleWebhook fast. Upstream timeouts are typically 5–30s. For longer reasoning, \`ctx.waitUntil(ctx.agent(...))\`.
- Include a \`created_at INTEGER NOT NULL\` column on every table (populated with \`Date.now()\` at INSERT) so debugging is tractable (see the system prompt's 401-triage rubric).
- For unfamiliar integrations: use the probe loop from the system prompt. Don't guess signing schemes, payload shapes, or webhook-creation APIs from training data.

Example 1 — Linear (GraphQL, upstream-generates-secret):

\`\`\`js
const LINEAR_API = "https://api.linear.app/graphql";

export async function registerWebhook(fetch, { callbackUrl, label }) {
  const res = await fetch(LINEAR_API, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query: \`mutation($url: String!, $types: [String!]!, $label: String!) {
        webhookCreate(input: { url: $url, resourceTypes: $types, allPublicTeams: true, label: $label }) {
          success webhook { id secret }
        }
      }\`,
      variables: { url: callbackUrl, types: ["Issue"], label }
    })
  });
  const body = await res.json();
  if (!body.data?.webhookCreate?.success) {
    throw new Error("Linear webhookCreate failed: " + JSON.stringify(body));
  }
  const wh = body.data.webhookCreate.webhook;
  return { id: wh.id, secret: wh.secret };
}

export async function unregisterWebhook(fetch, { id }) {
  const res = await fetch(LINEAR_API, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query: \`mutation($id: String!) { webhookDelete(id: $id) { success } }\`,
      variables: { id }
    })
  });
  const body = await res.json();
  if (!body.data?.webhookDelete?.success) {
    throw new Error("Linear webhookDelete failed: " + JSON.stringify(body));
  }
}

export async function verifySignature(body, headers, secret) {
  const sig = headers["linear-signature"];
  if (!sig) return false;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const computed = await crypto.subtle.sign("HMAC", key, body);
  const hex = [...new Uint8Array(computed)].map(b => b.toString(16).padStart(2, "0")).join("");
  return hex === sig;
}

export async function handleWebhook(request, sql, ctx) {
  const payload = await request.json();
  const issue = payload.data;
  sql.exec(
    "INSERT OR REPLACE INTO issues (id, title, priority, created_at) VALUES (?, ?, ?, ?)",
    issue.id, issue.title, issue.priority, Date.now()
  );
  return new Response("ok", { status: 200 });
}
\`\`\`

Example 2 — GitHub (REST, caller-provides-secret):

\`\`\`js
// Substitute OWNER/REPO with whatever the user asked to track.
const GH_API = "https://api.github.com/repos/OWNER/REPO/hooks";

export async function registerWebhook(fetch, { callbackUrl, label }) {
  // GitHub requires the caller to provide the secret at creation.
  // Generate a random one; we return it so the supervisor persists it
  // for verifySignature to use later.
  const secret = crypto.randomUUID() + crypto.randomUUID(); // ~256 bits

  const res = await fetch(GH_API, {
    method: "POST",
    headers: { "content-type": "application/json", "accept": "application/vnd.github+json" },
    body: JSON.stringify({
      name: "web",
      active: true,
      events: ["issues"],
      config: { url: callbackUrl, content_type: "json", secret, insecure_ssl: "0" }
    })
  });
  if (!res.ok) throw new Error("GitHub webhook create failed: " + res.status + " " + await res.text());
  const body = await res.json();
  return { id: String(body.id), secret };
}

export async function unregisterWebhook(fetch, { id }) {
  const res = await fetch(\`\${GH_API}/\${id}\`, { method: "DELETE" });
  // GitHub returns 204 on success, 404 if already gone — both fine.
  if (!res.ok && res.status !== 404) {
    throw new Error("GitHub webhook delete failed: " + res.status);
  }
}

export async function verifySignature(body, headers, secret) {
  const sig = headers["x-hub-signature-256"];
  if (!sig || !sig.startsWith("sha256=")) return false;
  const expected = sig.slice("sha256=".length);
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const computed = await crypto.subtle.sign("HMAC", key, body);
  const hex = [...new Uint8Array(computed)].map(b => b.toString(16).padStart(2, "0")).join("");
  return hex === expected;
}

export async function handleWebhook(request, sql, ctx) {
  const payload = await request.json();
  if (payload.action !== "opened" && payload.action !== "edited") {
    return new Response("ignored", { status: 200 });
  }
  const issue = payload.issue;
  sql.exec(
    "INSERT OR REPLACE INTO issues (id, number, title, state, created_at) VALUES (?, ?, ?, ?, ?)",
    issue.id, issue.number, issue.title, issue.state, Date.now()
  );
  return new Response("ok", { status: 200 });
}
\`\`\`

**Egress contract — YOU MUST declare api_hosts AND set X-Pd-App on every fetch from your handler.**

1. **api_hosts declaration at create_sync.** The gateway default-denies any fetch() to a host not in this sync's api_hosts. Before drafting the handler, use fetch_docs on the upstream's API reference to enumerate all hosts your registerWebhook + handleWebhook code will hit (main API, webhook registration endpoint, CDN/uploads, webhook signature verification callbacks). Include all of them. The user sees the list at approval time.

2. **Per-fetch X-Pd-App header.** Each outbound fetch from your handler MUST set the \`X-Pd-App\` header to one of the user's connected app slugs (see the \`<connected_accounts>\` context block — use the slugs verbatim). The gateway uses this header to pick which connected Pipedream account's OAuth token to inject via the proxy.

3. **Cross-app is allowed.** A Linear sync handler may declare \`api_hosts: ["api.linear.app", "api.slack.com"]\` and fetch api.slack.com with \`X-Pd-App: slack\` — the user approves this at create_sync. The gateway will use the user's connected Slack account's token for that fetch.

4. **Runtime errors are 403 with a specific error code**, surfaced in tool results:
   - \`denied_host\` — host is on SSRF denylist (private IPs, metadata, etc.)
   - \`missing_app_header\` — fetch has no X-Pd-App header
   - \`unknown_host\` — host not in this sync's api_hosts
   - \`account_not_connected\` — user hasn't connected an app with that slug
   - \`sync_not_found\` — sync deleted or invalid (shouldn't happen during normal handler execution)

5. **Example handler fetch shape:**
   \`\`\`ts
   await fetch("https://api.slack.com/chat.postMessage", {
     method: "POST",
     headers: {
       "X-Pd-App": "slack",
       "Content-Type": "application/json"
     },
     body: JSON.stringify({ channel: "C123", text: "new linear issue" })
   });
   \`\`\``,
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
          "JavaScript module source exporting FOUR async functions: `verifySignature(body, headers, secret)`, `handleWebhook(request, sql, ctx)`, `registerWebhook(fetch, config)` (all required), and `unregisterWebhook(fetch, config)` (strongly recommended). See the tool description for the full contract and worked examples for Linear + GitHub."
        ),
      filter_description: z
        .string()
        .optional()
        .describe(
          "One-line human summary of what this sync tracks, e.g. 'only issues labeled bug in Core team'. Displayed in the UI and in ambient context."
        ),
      api_hosts: z
        .array(z.string().min(1))
        .optional()
        .describe(
          "Hostnames your handler code will fetch. The gateway default-denies any fetch() to a host NOT in this list for this sync. Required if your handler calls ANY upstream — including the integration you're syncing from. Use fetch_docs to discover exact hosts (often more than one: main API + webhook registration endpoint + uploads + CDN). Over-declaring is fine (user approves the list at create_sync); under-declaring produces 403 unknown_host at runtime, aborting the handler mid-execution."
        )
    }),
    needsApproval: true,
    execute: async ({
      name,
      integration,
      schema_ddl,
      handler_code,
      filter_description,
      api_hosts
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
        integration,
        handler_code,
        schema_ddl,
        filter_description: filter_description ?? null,
        webhook_secret: "",
        upstream_webhook_id: "",
        code_id: codeId,
        api_hosts: api_hosts ?? []
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
        upstream_webhook_id: registered.id,
        api_hosts: api_hosts ?? []
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
