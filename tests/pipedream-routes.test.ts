import { describe, it, expect, beforeEach, vi } from "vitest";
import { SELF, env } from "cloudflare:test";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

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

// Phase F Task 1 fix-up: the /api/user/:userId/* routes now verify a
// CF Access JWT. Minting a real JWT would mean managing a fake JWKS
// endpoint; instead, mock `jose` so the middleware accepts the placeholder
// header and returns a synthesized identity. The header value on the
// request is just a sentinel so the middleware takes the JWT path.
//
// The mock is module-scoped so vitest-pool-workers' shared-isolate model
// applies it to the Worker's own graph (per the cloudflare-test.d.ts note:
// "global mocks will apply to it too"). Each test sets the sub it wants
// via `authHeaders(userId)` — the mocked jwtVerify reads that hoisted
// holder object, so per-test identity still works even though vi.mock
// is hoisted above this file's top-level code.
const authState = vi.hoisted(() => ({ sub: "" }));
vi.mock("jose", () => ({
  createRemoteJWKSet: vi.fn(() => "jwks-stub"),
  jwtVerify: vi.fn(async () => ({
    payload: { sub: authState.sub, email: `${authState.sub}@example.test` },
    protectedHeader: {}
  })),
  errors: {}
}));

const CF_ACCESS_JWT_HEADER = "cf-access-jwt-assertion";
function authHeaders(userId: string, extra: Record<string, string> = {}) {
  authState.sub = userId;
  return { [CF_ACCESS_JWT_HEADER]: "test.jwt.token", ...extra };
}

describe("Pipedream HTTP routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("POST /api/user/:userId/pipedream/token returns {token, connectLinkUrl}", async () => {
    const userId = crypto.randomUUID();
    const res = await SELF.fetch(
      `https://test/api/user/${userId}/pipedream/token`,
      { method: "POST", headers: authHeaders(userId) }
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
        headers: authHeaders(userId, { "content-type": "application/json" }),
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
        headers: authHeaders(userId, { "content-type": "application/json" }),
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
      headers: authHeaders(userId, { "content-type": "application/json" }),
      body: JSON.stringify({ app_slug: "slack", account_id: "apn_sl" })
    });
    const res = await SELF.fetch(
      `https://test/api/user/${userId}/pipedream/accounts`,
      { headers: authHeaders(userId) }
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
    const userId = crypto.randomUUID();
    // Seed via the existing POST route.
    const seed = await SELF.fetch(
      `https://test/api/user/${userId}/pipedream/account`,
      {
        method: "POST",
        headers: authHeaders(userId, { "content-type": "application/json" }),
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
