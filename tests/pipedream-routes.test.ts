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

describe("Pipedream HTTP routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("POST /api/user/:userId/pipedream/token returns {token, connectLinkUrl}", async () => {
    const userId = crypto.randomUUID();
    const res = await SELF.fetch(
      `https://test/api/user/${userId}/pipedream/token`,
      { method: "POST" }
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
        headers: { "content-type": "application/json" },
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
        headers: { "content-type": "application/json" },
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
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_slug: "slack", account_id: "apn_sl" })
    });
    const res = await SELF.fetch(
      `https://test/api/user/${userId}/pipedream/accounts`
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
});
