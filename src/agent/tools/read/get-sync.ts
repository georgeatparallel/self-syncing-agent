import { tool } from "ai";
import { z } from "zod";
import { getSyncById } from "../../../db/syncs";
import { listSyncErrors } from "../../../db/sync-errors";
import type { ChatAgent } from "../../../server";

export function getSyncTool(agent: ChatAgent) {
  return tool({
    description:
      "Get full detail for a single sync — handler code, schema DDL, filter description, version, timestamps, and the 5 most-recent errors. Use when the user asks to see or discuss a specific sync.",
    inputSchema: z.object({
      sync_id: z.string().describe("The sync's UUID")
    }),
    execute: async ({ sync_id }) => {
      const sql = agent.sql.bind(agent);
      const sync = getSyncById(sql, sync_id);
      if (!sync) {
        return { error: "not_found", sync_id };
      }
      const recentErrors = listSyncErrors(sql, sync_id, 5);
      return {
        sync_id: sync.id,
        name: sync.name,
        integration: sync.integration,
        handler_code: sync.handler_code,
        schema_ddl: sync.schema_ddl,
        filter_description: sync.filter_description,
        version: sync.version,
        created_at: sync.created_at,
        updated_at: sync.updated_at,
        recent_errors: recentErrors.map((e) => ({
          occurred_at: e.occurred_at,
          error_message: e.error_message,
          handler_version: e.handler_version
        }))
      };
    }
  });
}
