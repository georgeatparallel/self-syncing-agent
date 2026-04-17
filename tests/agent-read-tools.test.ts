import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { createSync } from "../src/db/syncs";
import { logSyncError } from "../src/db/sync-errors";
import { buildTools } from "../src/agent/tools";
import type { NewSync } from "../src/db/types";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

function getStub(userName: string) {
  return env.ChatAgent.get(env.ChatAgent.idFromName(userName));
}

function sampleSync(overrides: Partial<NewSync> = {}): NewSync {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    name: overrides.name ?? `test-${crypto.randomUUID().slice(0, 8)}`,
    integration: "linear",
    handler_code: "export default {};",
    schema_ddl: "CREATE TABLE issues (id TEXT PRIMARY KEY)",
    webhook_secret: "test-secret",
    code_id: `code-${crypto.randomUUID().slice(0, 8)}`,
    ...overrides
  };
}

/**
 * Kick the Agents SDK lifecycle so onStart (and thus the schema
 * migration) fires. Same pattern as tests/supervisor-data-model.test.ts.
 */
async function ensureReady(instance: unknown, name: string) {
  await (instance as { setName: (name: string) => Promise<void> }).setName(
    name
  );
}

/**
 * The `ai` SDK types tool.execute() as returning
 * `OUTPUT | PromiseLike<OUTPUT> | AsyncIterable<OUTPUT>` — the latter
 * for streaming tools. Our tools only ever resolve to a plain object,
 * so we narrow here for the tests' sake. Runtime shape is identical.
 */
async function runTool<T>(
  execute: ((args: never, ctx: never) => unknown) | undefined,
  args: unknown
): Promise<T> {
  return (await execute!(args as never, {} as never)) as T;
}

type ListSyncsResult = {
  count: number;
  syncs: Array<{
    sync_id: string;
    name: string;
    integration: string;
    version: number;
    created_at: number;
    updated_at: number;
  }>;
};

type GetSyncResult =
  | { error: string; sync_id: string }
  | {
      sync_id: string;
      name: string;
      integration: string;
      handler_code: string;
      schema_ddl: string;
      version: number;
      recent_errors: Array<{
        occurred_at: number;
        error_message: string;
        handler_version: number;
      }>;
    };

type GetSyncErrorsResult = {
  count: number;
  errors: Array<{
    id: number;
    occurred_at: number;
    error_message: string;
    handler_version: number;
  }>;
};

describe("agent read tools", () => {
  describe("list_syncs", () => {
    it("returns empty array for a fresh DO", async () => {
      const stub = getStub("read-list-empty");
      await runInDurableObject(stub, async (instance) => {
        await ensureReady(instance, "read-list-empty");
        const tools = buildTools(instance);
        const result = await runTool<ListSyncsResult>(
          tools.list_syncs.execute,
          {}
        );
        expect(result).toMatchObject({ count: 0, syncs: [] });
      });
    });

    it("returns registered syncs with expected shape", async () => {
      const stub = getStub("read-list-populated");
      await runInDurableObject(stub, async (instance) => {
        await ensureReady(instance, "read-list-populated");
        const sql = instance.sql.bind(instance);
        createSync(sql, sampleSync({ name: "linear_bugs" }));
        createSync(sql, sampleSync({ name: "linear_cycles" }));

        const tools = buildTools(instance);
        const result = await runTool<ListSyncsResult>(
          tools.list_syncs.execute,
          {}
        );
        expect(result.count).toBe(2);
        const names = result.syncs.map((s) => s.name).sort();
        expect(names).toEqual(["linear_bugs", "linear_cycles"]);
        expect(result.syncs[0]).toHaveProperty("sync_id");
        expect(result.syncs[0]).toHaveProperty("integration", "linear");
        expect(result.syncs[0]).toHaveProperty("version", 1);
        expect(result.syncs[0]).toHaveProperty("created_at");
      });
    });
  });

  describe("get_sync", () => {
    it("returns { error: 'not_found' } for unknown sync_id", async () => {
      const stub = getStub("read-get-missing");
      await runInDurableObject(stub, async (instance) => {
        await ensureReady(instance, "read-get-missing");
        const tools = buildTools(instance);
        const result = await runTool<GetSyncResult>(tools.get_sync.execute, {
          sync_id: "no-such-id"
        });
        expect(result).toMatchObject({
          error: "not_found",
          sync_id: "no-such-id"
        });
      });
    });

    it("returns full sync detail + empty recent_errors when none", async () => {
      const stub = getStub("read-get-detail");
      const input = sampleSync({ name: "linear_bugs" });
      await runInDurableObject(stub, async (instance) => {
        await ensureReady(instance, "read-get-detail");
        const sql = instance.sql.bind(instance);
        createSync(sql, input);

        const tools = buildTools(instance);
        const result = await runTool<GetSyncResult>(tools.get_sync.execute, {
          sync_id: input.id
        });
        expect(result).toMatchObject({
          sync_id: input.id,
          name: "linear_bugs",
          integration: "linear",
          version: 1,
          handler_code: input.handler_code,
          schema_ddl: input.schema_ddl,
          recent_errors: []
        });
      });
    });

    it("includes recent errors when present", async () => {
      const stub = getStub("read-get-errors");
      const input = sampleSync({ name: "linear_error_sync" });
      await runInDurableObject(stub, async (instance) => {
        await ensureReady(instance, "read-get-errors");
        const sql = instance.sql.bind(instance);
        createSync(sql, input);
        logSyncError(sql, {
          sync_id: input.id,
          error_message: "boom",
          handler_version: 1
        });

        const tools = buildTools(instance);
        const result = await runTool<GetSyncResult>(tools.get_sync.execute, {
          sync_id: input.id
        });
        if ("error" in result) throw new Error("expected sync, got error");
        expect(result.recent_errors).toHaveLength(1);
        expect(result.recent_errors[0]).toMatchObject({
          error_message: "boom",
          handler_version: 1
        });
      });
    });
  });

  describe("get_sync_errors", () => {
    it("returns empty array for a sync with no errors", async () => {
      const stub = getStub("read-errors-empty");
      const input = sampleSync();
      await runInDurableObject(stub, async (instance) => {
        await ensureReady(instance, "read-errors-empty");
        const sql = instance.sql.bind(instance);
        createSync(sql, input);

        const tools = buildTools(instance);
        const result = await runTool<GetSyncErrorsResult>(
          tools.get_sync_errors.execute,
          { sync_id: input.id, limit: 20 }
        );
        expect(result).toMatchObject({ count: 0, errors: [] });
      });
    });

    it("returns errors newest-first with the expected shape", async () => {
      const stub = getStub("read-errors-populated");
      const input = sampleSync();
      await runInDurableObject(stub, async (instance) => {
        await ensureReady(instance, "read-errors-populated");
        const sql = instance.sql.bind(instance);
        createSync(sql, input);
        logSyncError(sql, {
          sync_id: input.id,
          error_message: "first",
          handler_version: 1
        });
        await new Promise((r) => setTimeout(r, 2));
        logSyncError(sql, {
          sync_id: input.id,
          error_message: "second",
          handler_version: 1
        });

        const tools = buildTools(instance);
        const result = await runTool<GetSyncErrorsResult>(
          tools.get_sync_errors.execute,
          { sync_id: input.id, limit: 20 }
        );
        expect(result.count).toBe(2);
        expect(result.errors[0]).toMatchObject({
          error_message: "second",
          handler_version: 1
        });
        expect(result.errors[1]).toMatchObject({
          error_message: "first",
          handler_version: 1
        });
      });
    });
  });

  describe("web_search", () => {
    it("is registered with the expected schema (no live API call)", async () => {
      const stub = getStub("read-websearch-wiring");
      await runInDurableObject(stub, async (instance) => {
        await ensureReady(instance, "read-websearch-wiring");
        const tools = buildTools(instance);
        // Confirm the tool is present with its metadata; do NOT call
        // execute in tests (would hit Parallel AI with a stub key).
        expect(tools.web_search).toBeDefined();
        expect(tools.web_search.description).toMatch(/parallel|search/i);
      });
    });
  });
});
