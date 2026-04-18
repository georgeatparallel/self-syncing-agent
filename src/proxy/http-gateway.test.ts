import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Pipedream token cache so tests never hit the network. The
// mock is hoisted by vitest above the handleGatewayRequest import below.
vi.mock("../pipedream/token-cache", () => ({
  getCachedAccessToken: vi.fn().mockResolvedValue("pd_access_test")
}));

import { handleGatewayRequest } from "./http-gateway";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ANTHROPIC_API_KEY: "anthro-stub",
    PARALLEL_API_KEY: "parallel-stub",
    LINEAR_ACCESS_TOKEN: "linear-test-token",
    PIPEDREAM_PROJECT_ID: "proj_test",
    PIPEDREAM_CLIENT_ID: "client_test",
    PIPEDREAM_CLIENT_SECRET: "secret_test",
    PIPEDREAM_ENVIRONMENT: "development",
    // Additional bindings (ChatAgent, LOADER, etc.) aren't exercised by
    // these tests; cast to Env for type-compat with the real interface.
    ...overrides
  } as Env;
}

describe("handleGatewayRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes through Pipedream when user has a connected account (github)", async () => {
    const forwarder = vi
      .fn()
      .mockResolvedValue(new Response("ok from upstream", { status: 200 }));
    const accountLookup = vi.fn().mockResolvedValue("apn_gh_1");

    const request = new Request("https://api.github.com/user/repos", {
      method: "GET",
      headers: { "content-type": "application/json" }
    });

    const response = await handleGatewayRequest(
      request,
      makeEnv(),
      { userId: "u-1" },
      { forwarder, accountLookup }
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok from upstream");
    expect(accountLookup).toHaveBeenCalledTimes(1);
    expect(accountLookup).toHaveBeenCalledWith("u-1", "github");

    expect(forwarder).toHaveBeenCalledTimes(1);
    const sentReq = forwarder.mock.calls[0][0] as Request;
    expect(sentReq.url).toContain("api.pipedream.com/v1/connect/");
    expect(sentReq.url).toContain("account_id=apn_gh_1");
    expect(sentReq.url).toContain("external_user_id=u-1");
    expect(sentReq.headers.get("Authorization")).toBe("Bearer pd_access_test");
    expect(sentReq.headers.get("X-PD-Environment")).toBe("development");
  });

  it("routes api.linear.app through Pipedream (not hardcoded anymore)", async () => {
    const forwarder = vi
      .fn()
      .mockResolvedValue(new Response("ok", { status: 200 }));
    const accountLookup = vi.fn().mockResolvedValue("apn_linear_1");

    const request = new Request("https://api.linear.app/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "query { viewer { id } }" })
    });

    const response = await handleGatewayRequest(
      request,
      makeEnv(),
      { userId: "u-1" },
      { forwarder, accountLookup }
    );

    expect(response.status).toBe(200);
    expect(accountLookup).toHaveBeenCalledWith("u-1", "linear");

    expect(forwarder).toHaveBeenCalledTimes(1);
    const sentReq = forwarder.mock.calls[0][0] as Request;
    expect(sentReq.url).toContain("api.pipedream.com/v1/connect/");
    expect(sentReq.url).toContain("account_id=apn_linear_1");
    // The Linear path must NOT attach the old hardcoded
    // `Bearer ${LINEAR_ACCESS_TOKEN}` — the only Authorization header
    // present should be the Pipedream bearer access token.
    expect(sentReq.headers.get("Authorization")).toBe("Bearer pd_access_test");
  });

  it("returns 403 account_not_connected when user has no account for the app", async () => {
    const forwarder = vi.fn(async () => {
      throw new Error("forwarder must not be called when account missing");
    });
    const accountLookup = vi.fn().mockResolvedValue(null);

    const response = await handleGatewayRequest(
      new Request("https://api.github.com/user/repos"),
      makeEnv(),
      { userId: "u-1" },
      { forwarder, accountLookup }
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toBe("application/json");
    const body = (await response.json()) as {
      error: string;
      host: string;
      app_slug: string;
      message: string;
    };
    expect(body.error).toBe("account_not_connected");
    expect(body.host).toBe("api.github.com");
    expect(body.app_slug).toBe("github");
    expect(body.message).toMatch(/connect/i);

    expect(accountLookup).toHaveBeenCalledWith("u-1", "github");
    expect(forwarder).not.toHaveBeenCalled();
  });

  it("rejects unknown hosts even when accountLookup is provided", async () => {
    const forwarder = vi.fn(async () => {
      throw new Error("forwarder must not be called for unknown host");
    });
    const accountLookup = vi.fn();

    const response = await handleGatewayRequest(
      new Request("https://evil.example.com/exfiltrate", { method: "GET" }),
      makeEnv(),
      { userId: "u-1" },
      { forwarder, accountLookup }
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toBe("application/json");
    const body = (await response.json()) as {
      error: string;
      host: string;
      message: string;
    };
    expect(body.error).toBe("unknown_host");
    expect(body.host).toBe("evil.example.com");
    expect(body.message).toMatch(/rejected/i);

    expect(accountLookup).not.toHaveBeenCalled();
    expect(forwarder).not.toHaveBeenCalled();
  });

  it("rejects unknown hosts when no accountLookup/userId is provided", async () => {
    const forwarder = vi.fn(async () => {
      throw new Error("forwarder must not be called for unknown host");
    });

    const response = await handleGatewayRequest(
      new Request("https://evil.example.com/exfiltrate"),
      makeEnv(),
      { userId: "u-1" },
      { forwarder }
    );

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("unknown_host");
    expect(forwarder).not.toHaveBeenCalled();
  });

  it("preserves the original request body and method when forwarding", async () => {
    let seenBody: string | null = null;
    const forwarder = vi.fn(async (req: Request) => {
      seenBody = await req.text();
      return new Response("ok", { status: 200 });
    });
    const accountLookup = vi.fn().mockResolvedValue("apn_linear_1");

    const payload = JSON.stringify({
      query: "mutation { webhookCreate(input: {...}) { success } }"
    });
    const request = new Request("https://api.linear.app/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload
    });

    await handleGatewayRequest(
      request,
      makeEnv(),
      { userId: "u-2" },
      { forwarder, accountLookup }
    );

    expect(forwarder).toHaveBeenCalledTimes(1);
    const forwarded = forwarder.mock.calls[0][0] as Request;
    expect(forwarded.method).toBe("POST");
    expect(seenBody).toBe(payload);
    // The Pipedream proxy wraps app-specific headers under x-pd-proxy-*.
    expect(forwarded.headers.get("x-pd-proxy-content-type")).toBe(
      "application/json"
    );
  });
});
