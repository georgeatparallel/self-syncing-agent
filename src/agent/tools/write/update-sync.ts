import { tool } from "ai";
import { z } from "zod";
import { getSyncById, updateSync } from "../../../db/syncs";
import { attachFacet } from "../../../facet/loader";
import type { ChatAgent } from "../../../server";

type SqlExecResult =
  | { ok: true; rowsWritten: number; rowsRead: number }
  | { ok: false; error: string };

interface FacetRpcSurface {
  __sqlExec(sql: string, ...bindings: unknown[]): Promise<SqlExecResult>;
  __supervisorPing(): Promise<void>;
}

type UpdateSyncResult =
  | { error: "not_found"; sync_id: string }
  | { ok: false; error: "no_changes" }
  | { ok: false; error: "migration_failed"; detail: string }
  | { ok: false; error: "facet_abort_failed"; detail: string }
  | { ok: false; error: "facet_load_failed"; detail: string }
  | { ok: true; new_version: number };

export function updateSyncTool(agent: ChatAgent) {
  return tool({
    description:
      "Update an existing sync's handler code and/or schema. Approval-gated. All fields except sync_id are optional — send only what's changing. When schema_ddl is provided, send the FULL target schema (all CREATE TABLE / CREATE INDEX statements), not a diff. When the schema is materially changing (new columns, new tables), pair it with migration_ddl (ALTER TABLE statements) that transitions existing data. If a bad handler_code prevents the new bundle from compiling, the update is rolled back and the sync stays on its old version. Use for bug fixes in handler_code, schema evolution, and filter changes.",
    inputSchema: z
      .object({
        sync_id: z.string().describe("The sync's UUID."),
        handler_code: z
          .string()
          .min(1)
          .optional()
          .describe(
            "New handler.js source. Must export `async function handleWebhook(request, sql)`. Omit if handler isn't changing."
          ),
        schema_ddl: z
          .string()
          .min(1)
          .optional()
          .describe(
            "FULL target schema as CREATE TABLE / CREATE INDEX statements separated by semicolons. Not a diff — send the entire schema even for a single-column change. Use CREATE TABLE IF NOT EXISTS so re-applying is safe. Omit if schema isn't changing."
          ),
        migration_ddl: z
          .string()
          .min(1)
          .optional()
          .describe(
            "ALTER TABLE / ALTER INDEX / etc. that transitions the facet's existing SQLite from the old schema to the new one. Required when schema_ddl materially changes an existing table (ADD COLUMN, rename, type change). Not needed for adding entirely new tables (the new schema_ddl's CREATE TABLE IF NOT EXISTS covers that). Runs against the LIVE facet before the bundle swap."
          )
      })
      .refine(
        (d) =>
          d.handler_code !== undefined ||
          d.schema_ddl !== undefined ||
          d.migration_ddl !== undefined,
        {
          message:
            "at least one of handler_code, schema_ddl, migration_ddl must be provided"
        }
      ),
    needsApproval: true,
    execute: async ({
      sync_id,
      handler_code,
      schema_ddl,
      migration_ddl
    }): Promise<UpdateSyncResult> => {
      const sql = agent.sql.bind(agent);
      const oldSync = getSyncById(sql, sync_id);
      if (!oldSync) return { error: "not_found" as const, sync_id };

      // Defence-in-depth: zod's refine should already catch this, but tools
      // called with unexpected shapes surface a cleaner error than a schema
      // exception.
      if (
        handler_code === undefined &&
        schema_ddl === undefined &&
        migration_ddl === undefined
      ) {
        return { ok: false as const, error: "no_changes" as const };
      }

      // 1. Migration runs against the LIVE facet. __sqlExec requires a live
      //    isolate; we can't abort first. For ADD COLUMN and similar
      //    additive changes, the old handler keeps writing the old shape
      //    harmlessly until the swap lands.
      if (migration_ddl !== undefined) {
        const oldFacet = attachFacet(
          agent.env,
          agent.ctx.facets,
          oldSync,
          agent.name
        );
        const result = await (oldFacet as unknown as FacetRpcSurface).__sqlExec(
          migration_ddl
        );
        if (!result.ok) {
          return {
            ok: false as const,
            error: "migration_failed" as const,
            detail: result.error
          };
        }
      }

      // 2. Persist the new row with bumped version + new code_id. This is
      //    the "commit point" — anything that fails after here requires
      //    rollback to keep DB and facet in sync.
      const newVersion = oldSync.version + 1;
      const newCodeId = `sync:${oldSync.id}:v${newVersion}`;
      const newSync = updateSync(sql, sync_id, {
        handler_code,
        schema_ddl,
        version: newVersion,
        code_id: newCodeId
      });

      // 3. Abort the old isolate. Facet storage persists across aborts —
      //    only the running class/isolate is torn down. Tolerate "not
      //    running" the same way delete_sync does: a facet that never
      //    materialized doesn't need aborting.
      try {
        agent.ctx.facets.abort(
          oldSync.name,
          new Error(`update_sync: swapping to v${newVersion}`)
        );
      } catch (e) {
        if (
          !(e instanceof Error) ||
          !/not running|no such facet/i.test(e.message)
        ) {
          // Unexpected abort failure. Roll back the DB row; facet may still
          // be running in a half-aborted state, but subsequent webhook
          // delivery will re-attach correctly against the v1 code_id.
          updateSync(sql, sync_id, {
            handler_code: oldSync.handler_code,
            schema_ddl: oldSync.schema_ddl,
            version: oldSync.version,
            code_id: oldSync.code_id
          });
          return {
            ok: false as const,
            error: "facet_abort_failed" as const,
            detail: e instanceof Error ? e.message : String(e)
          };
        }
      }

      // 4. Re-attach with the new code_id. Worker Loader sees a cache miss
      //    (code_id changed) and compiles the new bundle. __supervisorPing
      //    is a no-op RPC whose only job is to force compile — if handler_code
      //    has a syntax error, the ping rejects and we rollback.
      try {
        const newFacet = attachFacet(
          agent.env,
          agent.ctx.facets,
          newSync,
          agent.name
        );
        await (newFacet as unknown as FacetRpcSurface).__supervisorPing();
      } catch (e) {
        // Rollback. Four ordered steps — each best-effort but they fire
        // in this order so the observable state transitions correctly:
        //
        // 1. Restore DB row to v1 FIRST so any concurrent webhook
        //    delivery sees v1 code_id and would attempt to attach v1.
        // 2. Abort the failed-v2 facet. Critical — `ctx.facets.get(name,
        //    cb)` skips the callback for a facet that's already
        //    registered under a class. Without this abort, step 3's
        //    attachFacet returns a stub still pointing to the broken v2
        //    bundle (diagnosed in a live smoke test where webhook
        //    deliveries kept hitting the bad handler after rollback
        //    "succeeded"). `abort()` invalidates the name↔class binding
        //    so the subsequent `get(name, cb)` fires the callback fresh.
        // 3. Re-attach with the old sync — the cb now runs, returns the
        //    v1 class; Worker Loader's cache still has v1 compiled from
        //    earlier so this is fast.
        // 4. Ping to force the compile path (if Worker Loader happened
        //    to have evicted v1). Tolerated — if this also fails, the
        //    next webhook delivery will retry attach on its own.
        updateSync(sql, sync_id, {
          handler_code: oldSync.handler_code,
          schema_ddl: oldSync.schema_ddl,
          version: oldSync.version,
          code_id: oldSync.code_id
        });
        try {
          agent.ctx.facets.abort(
            oldSync.name,
            new Error("update_sync: invalidating failed bundle")
          );
        } catch {
          // Tolerate any abort error during rollback — best-effort.
        }
        try {
          const restored = attachFacet(
            agent.env,
            agent.ctx.facets,
            oldSync,
            agent.name
          );
          await (restored as unknown as FacetRpcSurface).__supervisorPing();
        } catch {
          // Best-effort. If this fails, the DB is already v1 and the
          // next webhook delivery's handleWebhookDelivery will retry.
        }
        return {
          ok: false as const,
          error: "facet_load_failed" as const,
          detail: e instanceof Error ? e.message : String(e)
        };
      }

      return { ok: true as const, new_version: newVersion };
    }
  });
}
