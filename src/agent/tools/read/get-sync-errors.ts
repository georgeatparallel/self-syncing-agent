import { tool } from "ai";
import { z } from "zod";
import { listSyncErrors } from "../../../db/sync-errors";
import type { ChatAgent } from "../../../server";

export function getSyncErrorsTool(agent: ChatAgent) {
  return tool({
    description:
      "List recent runtime errors for a sync, newest first. Use when diagnosing why a sync is failing or when the user asks about error details. The ambient <sync_errors> context only shows the most recent message per sync; call this for full history with stack traces and payload previews.",
    inputSchema: z.object({
      sync_id: z.string().describe("The sync's UUID"),
      limit: z.number().int().positive().max(100).default(20)
    }),
    execute: async ({ sync_id, limit }) => {
      const sql = agent.sql.bind(agent);
      const errors = listSyncErrors(sql, sync_id, limit);
      return {
        count: errors.length,
        errors: errors.map((e) => ({
          id: e.id,
          occurred_at: e.occurred_at,
          error_message: e.error_message,
          stack_trace: e.stack_trace,
          payload_preview: e.payload_preview,
          handler_version: e.handler_version
        }))
      };
    }
  });
}
