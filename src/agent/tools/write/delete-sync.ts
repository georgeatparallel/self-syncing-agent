import { tool } from "ai";
import { z } from "zod";
import { getSyncById, deleteSync } from "../../../db/syncs";
import {
  unregisterLinearWebhook,
  LinearApiError
} from "../../../integrations/linear-api";
import type { ChatAgent } from "../../../server";

export function deleteSyncTool(agent: ChatAgent) {
  return tool({
    description:
      "Remove a sync entirely. Unregisters the upstream webhook (so delivery stops), drops the facet + its SQLite database (data is unrecoverable), and deletes the sync row + its error history. Approval-gated — user confirms in the dialog before anything is destroyed. Use when the user asks to delete, remove, or unsubscribe a sync. There's no 'pause' flow yet; say so if asked.",
    inputSchema: z.object({
      sync_id: z.string().describe("The sync's UUID")
    }),
    needsApproval: true,
    execute: async ({
      sync_id
    }): Promise<
      | { ok: true }
      | { ok: false; error: string; detail: string }
      | { error: "not_found"; sync_id: string }
    > => {
      const sql = agent.sql.bind(agent);
      const sync = getSyncById(sql, sync_id);
      if (!sync) return { error: "not_found", sync_id };

      // 1. Unregister upstream webhook (network-touching, may fail).
      //    Skip gracefully if the row somehow has no upstream id.
      if (sync.upstream_webhook_id) {
        try {
          await unregisterLinearWebhook(
            agent.env.LINEAR_ACCESS_TOKEN,
            sync.upstream_webhook_id
          );
        } catch (e) {
          if (e instanceof LinearApiError) {
            return { ok: false, error: e.code, detail: e.message };
          }
          throw e;
        }
      }

      // 2. Drop the facet and its SQLite. Unlike create_sync, once this
      //    runs there's no rollback path — we'd need the old bundle
      //    bytes to re-attach. Order matters: Linear first (reversible
      //    via re-register if we kept the URL), facet second.
      try {
        agent.ctx.facets.delete(sync.name);
      } catch (e) {
        // ctx.facets.delete throws if the facet never started; tolerate
        // that case so a sync whose facet never materialized can still
        // be removed from the registry.
        if (
          !(e instanceof Error) ||
          !/not running|no such facet/i.test(e.message)
        ) {
          return {
            ok: false,
            error: "local_cleanup_failed",
            detail: e instanceof Error ? e.message : String(e)
          };
        }
      }

      // 3. Cascade-clean sync_errors, then remove the registry row.
      sql`DELETE FROM sync_errors WHERE sync_id = ${sync_id}`;
      deleteSync(sql, sync_id);

      return { ok: true };
    }
  });
}
