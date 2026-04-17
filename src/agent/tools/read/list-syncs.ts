import { tool } from "ai";
import { z } from "zod";
import { listSyncs } from "../../../db/syncs";
import type { ChatAgent } from "../../../server";

export function listSyncsTool(agent: ChatAgent) {
  return tool({
    description:
      "List all syncs registered for this user. Returns id, name, integration, version, and creation/update timestamps. Use this when the user asks about their syncs generally, or when you need to disambiguate which sync they mean.",
    inputSchema: z.object({}),
    execute: async () => {
      const sql = agent.sql.bind(agent);
      const syncs = listSyncs(sql);
      return {
        count: syncs.length,
        syncs: syncs.map((s) => ({
          sync_id: s.id,
          name: s.name,
          integration: s.integration,
          version: s.version,
          created_at: s.created_at,
          updated_at: s.updated_at
        }))
      };
    }
  });
}
