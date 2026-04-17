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
import type { Integration, NewSync } from "../../../db/types";
import type { FacetsApi, WorkerLoaderLike } from "../../../facet/loader";

/**
 * Resource types passed to Linear's webhookCreate per integration + sync.
 * For V1 we only support Linear's Issue resource, but sync creation could
 * later allow the agent to pick different resource types (e.g., Comments,
 * Cycles). For now it's fixed.
 */
const LINEAR_DEFAULT_RESOURCE_TYPES = ["Issue"];

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
      schema_ddl,
      handler_code,
      filter_description
    }): Promise<
      | { ok: true; sync_id: string; linear_webhook_id: string }
      | { ok: false; error: string; detail: string }
    > => {
      const sql = agent.sql.bind(agent);
      const userId = agent.name;

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
          resourceTypesFor(integration),
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

      // 4. Attach the facet. If Worker Loader rejects the code (syntax
      //    error, missing handleWebhook export, etc.), we roll back both
      //    the DB row and the upstream webhook.
      try {
        const facet = attachFacet(
          { LOADER: agent.env.LOADER as unknown as WorkerLoaderLike },
          agent.ctx.facets as unknown as FacetsApi,
          created,
          userId
        );
        // Trigger facet initialization (wrapper applies schema on first fetch).
        // We hit a no-op health-check path; wrapper still applies schema because
        // it runs on EVERY fetch until #schemaApplied is true.
        const initResponse = await facet.fetch(
          new Request("https://facet.internal/__init__", { method: "POST" })
        );
        if (initResponse.status >= 500) {
          throw new Error(
            `Facet init returned ${initResponse.status} — handler likely threw before returning.`
          );
        }
      } catch (e) {
        // Rollback step 3 (DB) and step 2 (Linear).
        try {
          (agent.ctx.facets as unknown as FacetsApi).delete(name);
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

function resourceTypesFor(integration: Integration): string[] {
  switch (integration) {
    case "linear":
      return LINEAR_DEFAULT_RESOURCE_TYPES;
    // default case unreachable while Integration = "linear"
  }
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
