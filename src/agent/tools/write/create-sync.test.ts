import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect, vi } from "vitest";
import { createSyncTool } from "./create-sync";
import { listSyncs } from "../../../db/syncs";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

function getStub(userName: string) {
  return env.ChatAgent.get(env.ChatAgent.idFromName(userName));
}

async function ensureReady(instance: unknown, userName: string): Promise<void> {
  await (instance as { setName: (n: string) => Promise<void> }).setName(
    userName
  );
}

const SAMPLE_HANDLER = `
export async function handleWebhook(request, sql) {
  const payload = await request.json().catch(() => ({}));
  return new Response("ok", { status: 200 });
}
`;

const SAMPLE_SCHEMA =
  "CREATE TABLE IF NOT EXISTS issues (id TEXT PRIMARY KEY, title TEXT);";

describe("createSyncTool", () => {
  it("rejects duplicate sync names before touching the network", async () => {
    const stub = getStub("create-dup");
    const userName = "create-dup";

    await runInDurableObject(stub, async (instance) => {
      await ensureReady(instance, userName);
      const tools = createSyncTool(instance);
      // Pre-seed a sync with the same name.
      const sql = instance.sql.bind(instance);
      sql`
        INSERT INTO syncs (
          id, name, integration, handler_code, schema_ddl,
          filter_description, webhook_secret, upstream_webhook_id,
          code_id, version, created_at, updated_at
        ) VALUES (
          'existing-1', 'taken-name', 'linear', '', '',
          NULL, 's', NULL, 'c', 1, ${Date.now()}, ${Date.now()}
        )
      `;

      const result = await tools.execute!(
        {
          name: "taken-name",
          integration: "linear",
          schema_ddl: SAMPLE_SCHEMA,
          handler_code: SAMPLE_HANDLER
        },
        {} as never
      );

      expect(result).toMatchObject({
        ok: false,
        error: "duplicate_name"
      });
    });
  });

  it("propagates Linear API errors as tagged failure results", async () => {
    const stub = getStub("create-linearfail");
    const userName = "create-linearfail";

    // Intercept Linear's API at the module level. The tool calls
    // registerLinearWebhook which uses the global fetch; we stub fetch
    // within the runInDurableObject closure.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("api.linear.app")) {
        return new Response(
          JSON.stringify({
            errors: [{ message: "simulated linear outage" }]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return originalFetch(url as never);
    }) as typeof fetch;

    try {
      await runInDurableObject(stub, async (instance) => {
        await ensureReady(instance, userName);
        const tools = createSyncTool(instance);
        const result = await tools.execute!(
          {
            name: "linear-bugs",
            integration: "linear",
            schema_ddl: SAMPLE_SCHEMA,
            handler_code: SAMPLE_HANDLER
          },
          {} as never
        );

        expect(result).toMatchObject({
          ok: false,
          error: "linear_api_error",
          detail: expect.stringMatching(/simulated linear outage/)
        });

        // No sync row should have been persisted on Linear failure.
        const sql = instance.sql.bind(instance);
        expect(listSyncs(sql)).toHaveLength(0);
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
