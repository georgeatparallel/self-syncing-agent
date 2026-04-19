import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { createSync } from "../src/db/syncs";
import { upsertConnectedAccount } from "../src/db/connected-accounts";
import type { SqlTag } from "../src/db/types";
import type { ChatAgent } from "../src/server";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

/**
 * ChatAgent.resolveEgress is the single source of truth the HttpGateway
 * consults on every facet/exec-isolate fetch. This suite pins its five
 * outcomes against a real DO so the sqlite path is exercised end-to-end,
 * not mocked.
 *
 * Setup pattern: stub.callable... doesn't expose private shape, so we
 * `runInDurableObject` to seed syncs + connected_accounts directly, then
 * invoke `resolveEgress` via the public RPC surface (`stub.resolveEgress`).
 */

function getStub(userName: string) {
  const stub = env.ChatAgent.get(env.ChatAgent.idFromName(userName));
  return { stub, userName };
}

function bindSql<T extends { sql: (...args: never[]) => unknown }>(
  instance: T
): T["sql"] {
  return instance.sql.bind(instance) as T["sql"];
}

async function ensureReady(instance: unknown, userName: string): Promise<void> {
  await (instance as { setName: (name: string) => Promise<void> }).setName(
    userName
  );
}

async function seedSync(
  instance: unknown,
  userName: string,
  syncId: string,
  apiHosts: string[],
  integration: string = "linear"
): Promise<void> {
  await ensureReady(instance, userName);
  const sql = bindSql(
    instance as { sql: (...args: never[]) => unknown }
  ) as unknown as SqlTag;
  createSync(sql, {
    id: syncId,
    name: `test-${syncId}`,
    integration,
    handler_code: "export default { async fetch() {} }",
    schema_ddl: "CREATE TABLE x (id TEXT PRIMARY KEY)",
    webhook_secret: "test-secret",
    code_id: `code-${syncId}`,
    api_hosts: apiHosts
  });
}

async function seedAccount(
  instance: unknown,
  userName: string,
  userId: string,
  appSlug: string,
  accountId: string
): Promise<void> {
  await ensureReady(instance, userName);
  const sql = bindSql(
    instance as { sql: (...args: never[]) => unknown }
  ) as unknown as SqlTag;
  upsertConnectedAccount(sql, {
    user_id: userId,
    app_slug: appSlug,
    account_id: accountId,
    connected_at: Date.now()
  });
}

type ResolveEgressResult =
  | { ok: true; accountId: string }
  | {
      ok: false;
      error: "sync_not_found" | "unknown_host" | "account_not_connected";
    };

async function callResolveEgress(
  stub: DurableObjectStub<ChatAgent>,
  userId: string,
  syncId: string,
  host: string,
  appSlug: string
): Promise<ResolveEgressResult> {
  return (
    stub as unknown as {
      resolveEgress: (
        u: string,
        s: string,
        h: string,
        a: string
      ) => Promise<ResolveEgressResult>;
    }
  ).resolveEgress(userId, syncId, host, appSlug);
}

describe("ChatAgent.resolveEgress", () => {
  it("returns sync_not_found for an unknown syncId", async () => {
    const { stub, userName } = getStub("re-not-found");
    const res = await callResolveEgress(
      stub,
      userName,
      "sync-does-not-exist",
      "api.github.com",
      "github"
    );
    expect(res).toEqual({ ok: false, error: "sync_not_found" });
  });

  it("returns unknown_host when host is not in api_hosts", async () => {
    const { stub, userName } = getStub("re-unknown-host");
    const syncId = crypto.randomUUID();

    await runInDurableObject(stub, async (instance) => {
      await seedSync(instance, userName, syncId, ["api.github.com"]);
      await seedAccount(instance, userName, userName, "github", "apn_gh");
    });

    const res = await callResolveEgress(
      stub,
      userName,
      syncId,
      "api.slack.com", // not declared
      "github"
    );
    expect(res).toEqual({ ok: false, error: "unknown_host" });
  });

  it("returns account_not_connected when user hasn't connected appSlug", async () => {
    const { stub, userName } = getStub("re-no-account");
    const syncId = crypto.randomUUID();

    await runInDurableObject(stub, async (instance) => {
      await seedSync(instance, userName, syncId, ["api.github.com"]);
      // Deliberately no account seeded.
    });

    const res = await callResolveEgress(
      stub,
      userName,
      syncId,
      "api.github.com",
      "github"
    );
    expect(res).toEqual({ ok: false, error: "account_not_connected" });
  });

  it("returns {ok, accountId} on host + app both matching", async () => {
    const { stub, userName } = getStub("re-happy");
    const syncId = crypto.randomUUID();

    await runInDurableObject(stub, async (instance) => {
      await seedSync(instance, userName, syncId, ["api.github.com"]);
      await seedAccount(instance, userName, userName, "github", "apn_gh_ok");
    });

    const res = await callResolveEgress(
      stub,
      userName,
      syncId,
      "api.github.com",
      "github"
    );
    expect(res).toEqual({ ok: true, accountId: "apn_gh_ok" });
  });

  it("matches a subdomain via dot-boundary suffix (myshopify.com → mystore.myshopify.com)", async () => {
    const { stub, userName } = getStub("re-suffix");
    const syncId = crypto.randomUUID();

    await runInDurableObject(stub, async (instance) => {
      await seedSync(instance, userName, syncId, ["myshopify.com"], "shopify");
      await seedAccount(instance, userName, userName, "shopify", "apn_shop");
    });

    const res = await callResolveEgress(
      stub,
      userName,
      syncId,
      "mystore.myshopify.com",
      "shopify"
    );
    expect(res).toEqual({ ok: true, accountId: "apn_shop" });
  });

  it("supports cross-app flexibility: a linear-sync can fetch Slack with Slack creds", async () => {
    // Sync is labelled "linear" but declared api.slack.com in api_hosts
    // up front; user has BOTH linear and slack connected. The handler's
    // fetch with X-Pd-App: slack resolves to the Slack account — this
    // is the supported shape for cross-integration handlers.
    const { stub, userName } = getStub("re-cross-app");
    const syncId = crypto.randomUUID();

    await runInDurableObject(stub, async (instance) => {
      await seedSync(
        instance,
        userName,
        syncId,
        ["api.linear.app", "api.slack.com"],
        "linear"
      );
      await seedAccount(instance, userName, userName, "linear", "apn_linear");
      await seedAccount(instance, userName, userName, "slack", "apn_slack");
    });

    const res = await callResolveEgress(
      stub,
      userName,
      syncId,
      "api.slack.com",
      "slack"
    );
    expect(res).toEqual({ ok: true, accountId: "apn_slack" });
  });

  it("wrong-billing residual (documented accepted trade-off): slack host + stripe slug → stripe account", async () => {
    // Same sync, but this time the caller passes X-Pd-App: stripe for a
    // slack host. Because both host and slug validate independently,
    // resolveEgress returns stripe's account_id — which the upstream
    // (slack.com) will reject as a wrong-audience Bearer. This pins the
    // accepted residual documented in the gateway's threat model: an
    // attacker who owns the header (via prompt injection into the
    // handler) can route a declared host through the wrong app's creds,
    // but cannot exfiltrate to attacker infra.
    const { stub, userName } = getStub("re-residual");
    const syncId = crypto.randomUUID();

    await runInDurableObject(stub, async (instance) => {
      await seedSync(
        instance,
        userName,
        syncId,
        ["api.linear.app", "api.slack.com"],
        "linear"
      );
      await seedAccount(instance, userName, userName, "linear", "apn_linear");
      await seedAccount(instance, userName, userName, "stripe", "apn_stripe");
    });

    const res = await callResolveEgress(
      stub,
      userName,
      syncId,
      "api.slack.com",
      "stripe"
    );
    expect(res).toEqual({ ok: true, accountId: "apn_stripe" });
  });
});
