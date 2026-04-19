import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Pipedream token cache so tests never hit the network. The
// mock is hoisted by vitest above the handleGatewayRequest import below.
vi.mock("../pipedream/token-cache", () => ({
  getCachedAccessToken: vi.fn().mockResolvedValue("pd_access_test")
}));

import {
  handleGatewayRequest,
  matchesHost,
  X_PD_APP_HEADER
} from "./http-gateway";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ANTHROPIC_API_KEY: "anthro-stub",
    PARALLEL_API_KEY: "parallel-stub",
    PIPEDREAM_PROJECT_ID: "proj_test",
    PIPEDREAM_CLIENT_ID: "client_test",
    PIPEDREAM_CLIENT_SECRET: "secret_test",
    PIPEDREAM_ENVIRONMENT: "development",
    // Additional bindings (ChatAgent, LOADER, etc.) aren't exercised by
    // these tests; cast to Env for type-compat with the real interface.
    ...overrides
  } as Env;
}

describe("matchesHost", () => {
  it("returns false for an empty declared list", () => {
    expect(matchesHost([], "api.github.com")).toBe(false);
  });

  it("matches an exact host (case-insensitive)", () => {
    expect(matchesHost(["api.github.com"], "api.github.com")).toBe(true);
    expect(matchesHost(["api.github.com"], "API.GITHUB.COM")).toBe(true);
    expect(matchesHost(["API.GITHUB.COM"], "api.github.com")).toBe(true);
  });

  it("matches a subdomain via dot-boundary suffix", () => {
    expect(matchesHost(["myshopify.com"], "mystore.myshopify.com")).toBe(true);
    expect(matchesHost(["myshopify.com"], "a.b.c.myshopify.com")).toBe(true);
  });

  it("does NOT match a prefix-squatting host (no dot boundary)", () => {
    // The critical anti-bypass: `evilmyshopify.com` has `myshopify.com`
    // as a trailing substring but is not a subdomain of it.
    expect(matchesHost(["myshopify.com"], "evilmyshopify.com")).toBe(false);
    // Same rule: the suffix requires a dot before the declared host.
    expect(matchesHost(["github.com"], "fakegithub.com")).toBe(false);
  });

  it("checks every entry in the list and returns true on any hit", () => {
    const declared = ["api.slack.com", "myshopify.com"];
    expect(matchesHost(declared, "mystore.myshopify.com")).toBe(true);
    expect(matchesHost(declared, "api.slack.com")).toBe(true);
    expect(matchesHost(declared, "example.com")).toBe(false);
  });
});

describe("handleGatewayRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("blocks localhost / loopback hosts via the SSRF denylist (127.0.0.1)", async () => {
    const forwarder = vi.fn(async () => {
      throw new Error("forwarder must not be called on denylist hit");
    });
    const egressLookup = vi.fn();

    const res = await handleGatewayRequest(
      new Request("http://127.0.0.1/admin"),
      makeEnv(),
      { userId: "u-1", syncId: "s-1" },
      { forwarder, egressLookup }
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("denied_host");
    expect(egressLookup).not.toHaveBeenCalled();
    expect(forwarder).not.toHaveBeenCalled();
  });

  it("blocks cloud metadata (169.254.169.254) via the SSRF denylist", async () => {
    const forwarder = vi.fn();
    const egressLookup = vi.fn();
    const res = await handleGatewayRequest(
      new Request("http://169.254.169.254/latest/meta-data/"),
      makeEnv(),
      { userId: "u-1", syncId: "s-1" },
      { forwarder, egressLookup }
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("denied_host");
    expect(egressLookup).not.toHaveBeenCalled();
    expect(forwarder).not.toHaveBeenCalled();
  });

  it("blocks private IPv4 space (10.5.5.5) via the SSRF denylist", async () => {
    const forwarder = vi.fn();
    const egressLookup = vi.fn();
    const res = await handleGatewayRequest(
      new Request("http://10.5.5.5/"),
      makeEnv(),
      { userId: "u-1", syncId: "s-1" },
      { forwarder, egressLookup }
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("denied_host");
    expect(egressLookup).not.toHaveBeenCalled();
    expect(forwarder).not.toHaveBeenCalled();
  });

  it("blocks IPv4-mapped IPv6 (::ffff:169.254.169.254) via the SSRF denylist", async () => {
    const forwarder = vi.fn();
    const egressLookup = vi.fn();
    const res = await handleGatewayRequest(
      new Request("http://[::ffff:169.254.169.254]/"),
      makeEnv(),
      { userId: "u-1", syncId: "s-1" },
      { forwarder, egressLookup }
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("denied_host");
    expect(egressLookup).not.toHaveBeenCalled();
    expect(forwarder).not.toHaveBeenCalled();
  });

  it("returns 403 no_user_context when userId is missing", async () => {
    const forwarder = vi.fn();
    const egressLookup = vi.fn();
    const res = await handleGatewayRequest(
      new Request("https://api.github.com/user", {
        headers: { [X_PD_APP_HEADER]: "github" }
      }),
      makeEnv(),
      { syncId: "s-1" },
      { forwarder, egressLookup }
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe(
      "no_user_context"
    );
    expect(egressLookup).not.toHaveBeenCalled();
    expect(forwarder).not.toHaveBeenCalled();
  });

  it("returns 403 no_user_context when syncId is missing", async () => {
    const forwarder = vi.fn();
    const egressLookup = vi.fn();
    const res = await handleGatewayRequest(
      new Request("https://api.github.com/user", {
        headers: { [X_PD_APP_HEADER]: "github" }
      }),
      makeEnv(),
      { userId: "u-1" },
      { forwarder, egressLookup }
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe(
      "no_user_context"
    );
    expect(egressLookup).not.toHaveBeenCalled();
    expect(forwarder).not.toHaveBeenCalled();
  });

  it("returns 403 no_user_context when egressLookup is missing", async () => {
    const forwarder = vi.fn();
    const res = await handleGatewayRequest(
      new Request("https://api.github.com/user", {
        headers: { [X_PD_APP_HEADER]: "github" }
      }),
      makeEnv(),
      { userId: "u-1", syncId: "s-1" },
      { forwarder }
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe(
      "no_user_context"
    );
    expect(forwarder).not.toHaveBeenCalled();
  });

  it("returns 403 missing_app_header when the X-Pd-App header is absent", async () => {
    const forwarder = vi.fn();
    const egressLookup = vi.fn();
    const res = await handleGatewayRequest(
      new Request("https://api.github.com/user"),
      makeEnv(),
      { userId: "u-1", syncId: "s-1" },
      { forwarder, egressLookup }
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("missing_app_header");
    expect(body.message).toContain("x-pd-app");
    expect(egressLookup).not.toHaveBeenCalled();
    expect(forwarder).not.toHaveBeenCalled();
  });

  it("maps egressLookup sync_not_found to a 403", async () => {
    const forwarder = vi.fn();
    const egressLookup = vi
      .fn()
      .mockResolvedValue({ ok: false, error: "sync_not_found" });
    const res = await handleGatewayRequest(
      new Request("https://api.github.com/user", {
        headers: { [X_PD_APP_HEADER]: "github" }
      }),
      makeEnv(),
      { userId: "u-1", syncId: "s-gone" },
      { forwarder, egressLookup }
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe(
      "sync_not_found"
    );
    expect(forwarder).not.toHaveBeenCalled();
  });

  it("maps egressLookup unknown_host to a 403", async () => {
    const forwarder = vi.fn();
    const egressLookup = vi
      .fn()
      .mockResolvedValue({ ok: false, error: "unknown_host" });
    const res = await handleGatewayRequest(
      new Request("https://api.example.com/", {
        headers: { [X_PD_APP_HEADER]: "github" }
      }),
      makeEnv(),
      { userId: "u-1", syncId: "s-1" },
      { forwarder, egressLookup }
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("unknown_host");
    expect(body.message).toContain("api_hosts");
    expect(forwarder).not.toHaveBeenCalled();
  });

  it("maps egressLookup account_not_connected to a 403", async () => {
    const forwarder = vi.fn();
    const egressLookup = vi
      .fn()
      .mockResolvedValue({ ok: false, error: "account_not_connected" });
    const res = await handleGatewayRequest(
      new Request("https://api.github.com/user", {
        headers: { [X_PD_APP_HEADER]: "github" }
      }),
      makeEnv(),
      { userId: "u-1", syncId: "s-1" },
      { forwarder, egressLookup }
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("account_not_connected");
    expect(body.message).toContain("github");
    expect(forwarder).not.toHaveBeenCalled();
  });

  it("happy path: resolves account and forwards through Pipedream proxy", async () => {
    const forwarder = vi
      .fn()
      .mockResolvedValue(new Response("ok from upstream", { status: 200 }));
    const egressLookup = vi
      .fn()
      .mockResolvedValue({ ok: true, accountId: "apn_1" });

    const request = new Request("https://api.github.com/user", {
      method: "GET",
      headers: {
        "content-type": "application/json",
        [X_PD_APP_HEADER]: "github"
      }
    });
    const response = await handleGatewayRequest(
      request,
      makeEnv(),
      { userId: "u-1", syncId: "s-1" },
      { forwarder, egressLookup }
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok from upstream");

    expect(egressLookup).toHaveBeenCalledTimes(1);
    // Argument order matters: (userId, syncId, host, appSlug).
    expect(egressLookup).toHaveBeenCalledWith(
      "u-1",
      "s-1",
      "api.github.com",
      "github"
    );

    expect(forwarder).toHaveBeenCalledTimes(1);
    const sentReq = forwarder.mock.calls[0][0] as Request;
    expect(sentReq.url).toContain("api.pipedream.com/v1/connect/");
    expect(sentReq.url).toContain("account_id=apn_1");
    expect(sentReq.url).toContain("external_user_id=u-1");
    expect(sentReq.headers.get("Authorization")).toBe("Bearer pd_access_test");
    expect(sentReq.headers.get("X-PD-Environment")).toBe("development");
  });

  it("preserves method + body through the Pipedream proxy", async () => {
    let seenBody: string | null = null;
    const forwarder = vi.fn(async (req: Request) => {
      seenBody = await req.text();
      return new Response("ok", { status: 200 });
    });
    const egressLookup = vi
      .fn()
      .mockResolvedValue({ ok: true, accountId: "apn_linear" });

    const payload = JSON.stringify({
      query: "mutation { webhookCreate(input: {...}) { success } }"
    });
    const request = new Request("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [X_PD_APP_HEADER]: "linear"
      },
      body: payload
    });

    await handleGatewayRequest(
      request,
      makeEnv(),
      { userId: "u-2", syncId: "s-2" },
      { forwarder, egressLookup }
    );

    expect(forwarder).toHaveBeenCalledTimes(1);
    const forwarded = forwarder.mock.calls[0][0] as Request;
    expect(forwarded.method).toBe("POST");
    expect(seenBody).toBe(payload);
    // Pipedream's proxy wraps non-system headers under `x-pd-proxy-*`.
    expect(forwarded.headers.get("x-pd-proxy-content-type")).toBe(
      "application/json"
    );
  });
});
