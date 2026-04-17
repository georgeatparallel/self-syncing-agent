import { tool } from "ai";
import { z } from "zod";
import { getSyncById } from "../../../db/syncs";
import { attachFacet } from "../../../facet/loader";
import type { ChatAgent } from "../../../server";

const ROW_CAP = 200;

/**
 * Read-only SQL validator. Runs three checks after stripping SQL
 * block and line comments:
 *   1. First token is SELECT or WITH (CTE).
 *   2. No additional ';' after an optional trailing one — blocks
 *      `SELECT 1; DROP TABLE x` and similar multi-statement chains.
 *   3. No destructive keyword (INSERT/UPDATE/DELETE/REPLACE/DROP/
 *      CREATE/ALTER/TRUNCATE/ATTACH/DETACH/REINDEX/PRAGMA) as a
 *      whole word. This closes the `WITH t AS (...) INSERT INTO x`
 *      bypass that the prefix check alone lets through.
 *
 * The denylist can over-reject SELECTs containing those keywords
 * inside string literals (e.g., `WHERE msg = 'DROP me'`). That's an
 * acceptable tradeoff: the error is clear and the agent can
 * paraphrase the literal.
 */
const DESTRUCTIVE_KEYWORDS =
  /\b(insert|update|delete|replace|drop|create|alter|truncate|attach|detach|reindex|pragma)\b/i;

function isReadOnlyQuery(sql: string): boolean {
  const stripped = sql
    .replaceAll(/\/\*[\s\S]*?\*\//g, "")
    .replaceAll(/--[^\n]*/g, "")
    .trim()
    .replace(/;\s*$/, "")
    .trim();
  if (stripped.length === 0) return false;
  if (stripped.includes(";")) return false;
  if (DESTRUCTIVE_KEYWORDS.test(stripped)) return false;
  const firstToken = stripped.slice(0, 6).toLowerCase();
  return firstToken === "select" || firstToken.startsWith("with");
}

export function querySyncTool(agent: ChatAgent) {
  return tool({
    description:
      "Run a read-only SQL query against a sync's facet SQLite. Use to answer 'how many X are there?', 'show me recent Y', and similar data questions the user asks about their synced data. Must start with SELECT or WITH; anything else is rejected. Results capped at 200 rows — narrow via WHERE / LIMIT / aggregation instead of relying on the cap.",
    inputSchema: z.object({
      sync_id: z.string().describe("The sync's UUID."),
      query: z
        .string()
        .min(1)
        .describe(
          "A single SQL statement starting with SELECT or WITH. SQL comments are allowed. No parameter binding — embed literals directly (escape single quotes by doubling)."
        )
    }),
    execute: async ({ sync_id, query }) => {
      const sql = agent.sql.bind(agent);
      const sync = getSyncById(sql, sync_id);
      if (!sync) {
        return { error: "not_found" as const, sync_id };
      }
      if (!isReadOnlyQuery(query)) {
        return {
          error: "invalid_sql" as const,
          detail: "query must start with SELECT or WITH"
        };
      }

      const facet = attachFacet(agent.env, agent.ctx.facets, sync, agent.name);
      const result = await (
        facet as unknown as {
          __query: (
            sql: string
          ) => Promise<
            { ok: true; rows: unknown[] } | { ok: false; error: string }
          >;
        }
      ).__query(query);

      if (!result.ok) {
        return { error: "sqlite_error" as const, detail: result.error };
      }

      const truncated = result.rows.length > ROW_CAP;
      const rows = truncated ? result.rows.slice(0, ROW_CAP) : result.rows;
      return {
        row_count: rows.length,
        rows,
        ...(truncated ? { truncated: true } : {})
      };
    }
  });
}
