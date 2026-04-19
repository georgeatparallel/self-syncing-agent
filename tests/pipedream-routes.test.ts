import { describe, it, expect, beforeEach, vi } from "vitest";
import { SELF } from "cloudflare:test";

// Mock the pipedream barrel so we don't hit the network. ChatAgent imports
// from "./pipedream" (the barrel), so intercepting the barrel is enough
// without having to change production imports.
vi.mock("../src/pipedream", () => ({
  getCachedAccessToken: vi.fn().mockResolvedValue("pd_access_test"),
  createConnectToken: vi.fn().mockResolvedValue({
    token: "ctok_test",
    connectLinkUrl: "https://pipedream.com/_static/connect.html?token=ctok_test"
  })
}));

// The /api/user/:userId/* routes are wrapped with requireAuthAndUserIdMatch
// (Phase F, Task 1). Every SELF.fetch below has to carry the Access header
// matching the path :userId, or the request 401s/403s before hitting the
// handler. Using the same UUID for both sides of the match satisfies the
// middleware's case-insensitive equality check.
const CF_ACCESS_HEADER = "cf-access-authenticated-user-email";

describe("Pipedream HTTP routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("POST /api/user/:userId/pipedream/token returns {token, connectLinkUrl}", async () => {
    const userId = crypto.randomUUID();
    const res = await SELF.fetch(
      `https://test/api/user/${userId}/pipedream/token`,
      { method: "POST", headers: { [CF_ACCESS_HEADER]: userId } }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      token: "ctok_test",
      connectLinkUrl:
        "https://pipedream.com/_static/connect.html?token=ctok_test"
    });
  });

  it("POST /api/user/:userId/pipedream/account persists the mapping", async () => {
    const userId = crypto.randomUUID();
    const res = await SELF.fetch(
      `https://test/api/user/${userId}/pipedream/account`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [CF_ACCESS_HEADER]: userId
        },
        body: JSON.stringify({
          app_slug: "github",
          account_id: "apn_gh"
        })
      }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("POST /api/user/:userId/pipedream/account returns 400 on missing fields", async () => {
    const userId = crypto.randomUUID();
    const res = await SELF.fetch(
      `https://test/api/user/${userId}/pipedream/account`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [CF_ACCESS_HEADER]: userId
        },
        body: JSON.stringify({ app_slug: "github" })
      }
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "missing_fields" });
  });

  it("GET /api/user/:userId/pipedream/accounts returns prior upserts", async () => {
    const userId = crypto.randomUUID();
    await SELF.fetch(`https://test/api/user/${userId}/pipedream/account`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [CF_ACCESS_HEADER]: userId
      },
      body: JSON.stringify({ app_slug: "slack", account_id: "apn_sl" })
    });
    const res = await SELF.fetch(
      `https://test/api/user/${userId}/pipedream/accounts`,
      { headers: { [CF_ACCESS_HEADER]: userId } }
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      accounts: Array<{ app_slug: string; account_id: string }>;
    };
    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0]).toMatchObject({
      app_slug: "slack",
      account_id: "apn_sl"
    });
  });

  it("getConnectedAccountId returns account_id for a connected app, null otherwise", async () => {
    const { env } = await import("cloudflare:test");
    const userId = crypto.randomUUID();
    // Seed via the existing POST route.
    const seed = await SELF.fetch(
      `https://test/api/user/${userId}/pipedream/account`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [CF_ACCESS_HEADER]: userId
        },
        body: JSON.stringify({ app_slug: "github", account_id: "apn_gh_1" })
      }
    );
    expect(seed.status).toBe(200);

    // Look up via direct DO RPC.
    const stub = env.ChatAgent.get(env.ChatAgent.idFromName(userId));
    const hit = await (
      stub as unknown as {
        getConnectedAccountId: (
          u: string,
          app: string
        ) => Promise<string | null>;
      }
    ).getConnectedAccountId(userId, "github");
    expect(hit).toBe("apn_gh_1");

    const miss = await (
      stub as unknown as {
        getConnectedAccountId: (
          u: string,
          app: string
        ) => Promise<string | null>;
      }
    ).getConnectedAccountId(userId, "slack");
    expect(miss).toBeNull();
  });
});
