import { tool } from "ai";
import { z } from "zod";
import { getSyncById, deleteSync } from "../../../db/syncs";
import { attachFacet } from "../../../facet/loader";
import type { ChatAgent } from "../../../server";

// Typed RPC surface for the facet's Phase D unregister method. The cast is
// local to this file — matches the pattern used in create-sync.ts for facet
// RPCs that aren't on the generic DurableObjectStub type.
interface FacetUnregisterRpc {
  __unregisterWebhook(config: {
    id: string;
    label: string;
  }): Promise<{ ok: true } | { ok: false; reason: string; detail?: string }>;
}

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
      | { ok: true; warnings?: string[] }
      | { ok: false; error: string; detail: string }
      | { error: "not_found"; sync_id: string }
    > => {
      const sql = agent.sql.bind(agent);
      const sync = getSyncById(sql, sync_id);
      if (!sync) return { error: "not_found", sync_id };

      const warnings: string[] = [];

      // 1. Delegate upstream webhook cleanup to the handler's
      //    unregisterWebhook export. Graceful-skip: if the export is missing
      //    (legacy sync from pre-Phase-D) or the handler throws, surface a
      //    warning to the user and proceed with local cleanup. The user ran
      //    delete_sync because they want this sync gone — a network failure
      //    or missing export shouldn't leave them with a half-deleted sync.
      //    The warning includes guidance to clean up upstream manually.
      if (sync.upstream_webhook_id) {
        const label = `self-syncing-agent:${agent.name.slice(0, 8)}:${sync.name}`;
        const facet = attachFacet(
          agent.env,
          agent.ctx.facets,
          sync,
          agent.name
        ) as unknown as FacetUnregisterRpc;
        const unregResult = await facet.__unregisterWebhook({
          id: sync.upstream_webhook_id,
          label
        });
        if (!unregResult.ok) {
          const detailPart =
            "detail" in unregResult && unregResult.detail
              ? ` (${unregResult.detail})`
              : "";
          warnings.push(
            `Upstream webhook cleanup skipped: ${unregResult.reason}${detailPart}. ` +
              `The sync was deleted locally but the upstream webhook may still be registered — ` +
              `clean it up manually in the upstream's dashboard if you want to remove it fully.`
          );
        }
      }

      // 2. Drop the facet and its SQLite. No rollback path once this runs —
      //    we'd need the old bundle bytes to re-attach. Order matters:
      //    upstream first (reversible by re-register if we kept the URL),
      //    facet second.
      try {
        agent.ctx.facets.delete(sync.name);
      } catch (e) {
        // ctx.facets.delete throws if the facet never started; tolerate
        // that case so a sync whose facet never materialized can still be
        // removed from the registry.
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

      return warnings.length > 0 ? { ok: true, warnings } : { ok: true };
    }
  });
}
