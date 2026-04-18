import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { runInSyncTool } from "./run-in-sync";
import { createSync } from "../../../db/syncs";
import type { NewSync, SqlTag } from "../../../db/types";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

interface LogEntry {
  level: "log" | "info" | "warn" | "error";
  message: string;
  ts: number;
}
type FakeRunResult =
  | { ok: true; result: unknown; logs: LogEntry[] }
  | {
      ok: false;
      error: string;
      detail?: string;
      stack?: string | null;
      logs: LogEntry[];
    };

interface FakeEntrypoint {
  run: (facet: unknown) => Promise<FakeRunResult>;
}
interface FakeWorkerStub {
  getEntrypoint: () => FakeEntrypoint;
}
interface FakeLoader {
  load: (code: unknown) => FakeWorkerStub;
}
interface FakeFacets {
  get(name: string, cb: () => unknown): unknown;
  abort: (name: string, reason?: unknown) => void;
  delete: (name: string) => void;
}

function installFakeLoader(instance: unknown, loader: FakeLoader): () => void {
  const agentEnv = (instance as { env: Record<string, unknown> }).env;
  const prev = agentEnv.LOADER;
  agentEnv.LOADER = loader;
  return () => {
    agentEnv.LOADER = prev;
  };
}

function installFakeFacets(instance: unknown, facets: FakeFacets): () => void {
  const ctx = (instance as { ctx: { facets?: FakeFacets } }).ctx;
  const prev = ctx.facets;
  ctx.facets = facets;
  return () => {
    ctx.facets = prev;
  };
}

function seedSync(instance: unknown): string {
  const sql = (instance as { sql: SqlTag }).sql.bind(instance) as SqlTag;
  const id = crypto.randomUUID();
  const input: NewSync = {
    id,
    name: `sync-${id.slice(0, 8)}`,
    integration: "linear",
    handler_code:
      "export async function handleWebhook(){ return new Response('ok'); }",
    schema_ddl: "CREATE TABLE IF NOT EXISTS x (id TEXT);",
    filter_description: null,
    webhook_secret: "s",
    upstream_webhook_id: "wh_test_abc",
    code_id: `sync:${id}:v1`
  };
  createSync(sql, input);
  return id;
}

function makeFakeLoader(run: FakeEntrypoint["run"]): FakeLoader {
  return {
    load: () => ({
      getEntrypoint: () => ({ run })
    })
  };
}

const noopFacets: FakeFacets = {
  get: () => ({ fetch: async () => new Response("ok") }),
  abort: () => {},
  delete: () => {}
};

describe("run_in_sync", () => {
  it("returns not_found for an unknown sync_id", async () => {
    const stub = env.ChatAgent.get(env.ChatAgent.idFromName("r-404"));
    await runInDurableObject(stub, async (instance) => {
      await (
        instance as never as { setName: (n: string) => Promise<void> }
      ).setName("r-404");
      const tool = runInSyncTool(instance as never);
      const res = await tool.execute!(
        {
          sync_id: "00000000-0000-0000-0000-000000000000",
          code: "export async function runInSync(){ return 1; }"
        },
        {} as never
      );
      expect(res).toMatchObject({ error: "not_found" });
    });
  });

  it("happy path: runs code and returns result + logs via fake entrypoint", async () => {
    const stub = env.ChatAgent.get(env.ChatAgent.idFromName("r-happy"));
    await runInDurableObject(stub, async (instance) => {
      await (
        instance as never as { setName: (n: string) => Promise<void> }
      ).setName("r-happy");
      const syncId = seedSync(instance);

      const restoreFacets = installFakeFacets(instance, noopFacets);
      const restoreLoader = installFakeLoader(
        instance,
        makeFakeLoader(async () => ({
          ok: true,
          result: { wrote: 3 },
          logs: [{ level: "log", message: "hello", ts: 1 }]
        }))
      );

      try {
        const tool = runInSyncTool(instance as never);
        const res = (await tool.execute!(
          {
            sync_id: syncId,
            code: "export async function runInSync(){ return { wrote: 3 }; }"
          },
          {} as never
        )) as { ok: true; result: { wrote: number }; logs: LogEntry[] };
        expect(res.ok).toBe(true);
        expect(res.result).toEqual({ wrote: 3 });
        expect(res.logs).toEqual([{ level: "log", message: "hello", ts: 1 }]);
      } finally {
        restoreLoader();
        restoreFacets();
      }
    });
  });

  it("propagates exec_failed with logs from a throwing runInSync", async () => {
    const stub = env.ChatAgent.get(env.ChatAgent.idFromName("r-throw"));
    await runInDurableObject(stub, async (instance) => {
      await (
        instance as never as { setName: (n: string) => Promise<void> }
      ).setName("r-throw");
      const syncId = seedSync(instance);

      const restoreFacets = installFakeFacets(instance, noopFacets);
      const restoreLoader = installFakeLoader(
        instance,
        makeFakeLoader(async () => ({
          ok: false,
          error: "exec_failed",
          detail: "boom",
          stack: "Error: boom\n    at runInSync",
          logs: [{ level: "log", message: "step 1", ts: 1 }]
        }))
      );

      try {
        const tool = runInSyncTool(instance as never);
        const res = await tool.execute!(
          {
            sync_id: syncId,
            code: "export async function runInSync(){ console.log('step 1'); throw new Error('boom'); }"
          },
          {} as never
        );
        expect(res).toMatchObject({
          ok: false,
          error: "exec_failed",
          detail: "boom",
          logs: [{ level: "log", message: "step 1", ts: 1 }]
        });
      } finally {
        restoreLoader();
        restoreFacets();
      }
    });
  });

  it("propagates no_export when the agent's code is missing runInSync", async () => {
    const stub = env.ChatAgent.get(env.ChatAgent.idFromName("r-noexport"));
    await runInDurableObject(stub, async (instance) => {
      await (
        instance as never as { setName: (n: string) => Promise<void> }
      ).setName("r-noexport");
      const syncId = seedSync(instance);

      const restoreFacets = installFakeFacets(instance, noopFacets);
      const restoreLoader = installFakeLoader(
        instance,
        makeFakeLoader(async () => ({
          ok: false,
          error: "no_export",
          detail: "exec.js must export async function runInSync(facet, fetch)",
          logs: []
        }))
      );

      try {
        const tool = runInSyncTool(instance as never);
        const res = await tool.execute!(
          { sync_id: syncId, code: "export const notRunInSync = 1;" },
          {} as never
        );
        expect(res).toMatchObject({
          ok: false,
          error: "no_export",
          logs: []
        });
      } finally {
        restoreLoader();
        restoreFacets();
      }
    });
  });

  it("truncates oversized results and preserves logs", async () => {
    const stub = env.ChatAgent.get(env.ChatAgent.idFromName("r-trunc"));
    await runInDurableObject(stub, async (instance) => {
      await (
        instance as never as { setName: (n: string) => Promise<void> }
      ).setName("r-trunc");
      const syncId = seedSync(instance);

      // Build a payload whose JSON.stringify length is > 64KB.
      const bigArray = Array.from({ length: 5000 }, (_, i) => ({
        id: i,
        filler: "x".repeat(40)
      }));

      const restoreFacets = installFakeFacets(instance, noopFacets);
      const restoreLoader = installFakeLoader(
        instance,
        makeFakeLoader(async () => ({
          ok: true,
          result: bigArray,
          logs: [{ level: "info", message: "dumped rows", ts: 1 }]
        }))
      );

      try {
        const tool = runInSyncTool(instance as never);
        const res = (await tool.execute!(
          {
            sync_id: syncId,
            code: "export async function runInSync(){ return []; }"
          },
          {} as never
        )) as {
          ok: true;
          result: null;
          truncated: true;
          serialized_bytes: number;
          logs: LogEntry[];
        };
        expect(res.ok).toBe(true);
        expect(res.result).toBeNull();
        expect(res.truncated).toBe(true);
        expect(res.serialized_bytes).toBeGreaterThan(64 * 1024);
        expect(res.logs).toEqual([
          { level: "info", message: "dumped rows", ts: 1 }
        ]);
      } finally {
        restoreLoader();
        restoreFacets();
      }
    });
  });

  it("catches Worker Loader compile failures and returns exec_failed with empty logs", async () => {
    const stub = env.ChatAgent.get(env.ChatAgent.idFromName("r-compile"));
    await runInDurableObject(stub, async (instance) => {
      await (
        instance as never as { setName: (n: string) => Promise<void> }
      ).setName("r-compile");
      const syncId = seedSync(instance);

      // Simulate a compile failure surfaced at entrypoint.run() time.
      // Real Workers rejects here when the agent's code has a syntax
      // error; the fake loader mimics that by making run() throw.
      const restoreFacets = installFakeFacets(instance, noopFacets);
      const restoreLoader = installFakeLoader(
        instance,
        makeFakeLoader(async () => {
          throw new Error("Worker Loader: SyntaxError in exec.js");
        })
      );

      try {
        const tool = runInSyncTool(instance as never);
        const res = await tool.execute!(
          {
            sync_id: syncId,
            code: "export async function runInSync() { syntax error here }"
          },
          {} as never
        );
        expect(res).toMatchObject({
          ok: false,
          error: "exec_failed",
          detail: expect.stringMatching(/SyntaxError/),
          logs: []
        });
      } finally {
        restoreLoader();
        restoreFacets();
      }
    });
  });
});
