import { listSyncsTool } from "./read/list-syncs";
import { getSyncTool } from "./read/get-sync";
import { getSyncErrorsTool } from "./read/get-sync-errors";
import { querySyncTool } from "./read/query-sync";
import { webSearchTool } from "./read/web-search";
import { createSyncTool } from "./write/create-sync";
import { deleteSyncTool } from "./write/delete-sync";
import type { ChatAgent } from "../../server";

/**
 * Build the tool map passed to streamText. Each tool factory takes
 * the agent instance so tools can read/write the supervisor SQLite
 * and reach the env bindings (ANTHROPIC_API_KEY, PARALLEL_API_KEY).
 *
 * Write tools added progressively from Phase 08 onwards:
 * - create_sync (Phase 08, live)
 * - delete_sync (Phase 10, live)
 * - update_sync, run_in_sync (later phases)
 */
export function buildTools(agent: ChatAgent) {
  return {
    list_syncs: listSyncsTool(agent),
    get_sync: getSyncTool(agent),
    get_sync_errors: getSyncErrorsTool(agent),
    query_sync: querySyncTool(agent),
    web_search: webSearchTool(agent),
    create_sync: createSyncTool(agent),
    delete_sync: deleteSyncTool(agent)
  };
}
