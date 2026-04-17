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
    description:
      "Create a new sync. Registers a webhook with the upstream, loads the agent-authored handler into an isolated facet with its own SQLite, runs the schema DDL, and persists the sync registry row. Approval-gated — the user sees the drafted schema_ddl and handler_code in the approval dialog before it runs. Use AFTER you've shown the draft schema + handler in chat.",
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
          "User-visible sync label. Must be unique per user. Also used as the facet's name."
        ),
      integration: z.enum(["linear"]).describe("V1 supports 'linear' only."),
      resource_types: z
        .array(z.string().min(1))
        .min(1)
        .describe(
          "Upstream resource types to subscribe the webhook to. For Linear: 'Issue', 'Comment', 'Project', 'ProjectUpdate', 'Cycle', 'IssueLabel', 'IssueAttachment', 'Reaction'. Pick the minimal set that covers the user's ask — fewer types means fewer no-op webhook deliveries."
        ),
      schema_ddl: z
        .string()
        .describe(
          "SQL DDL statements for the facet's SQLite, separated by semicolons. Use CREATE TABLE IF NOT EXISTS so re-applying is idempotent."
        ),
      handler_code: z
        .string()
        .describe(
          "JavaScript module source that exports handleWebhook(request, sql). See system prompt for exact contract."
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
