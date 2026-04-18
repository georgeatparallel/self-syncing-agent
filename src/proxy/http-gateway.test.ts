import { describe, it, expect, vi } from "vitest";
import { handleGatewayRequest } from "./http-gateway";

// ProvidedEnv augmentation is project-wide from earlier test files;
// we don't need to redeclare it here.

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ANTHROPIC_API_KEY: "anthro-stub",
    PARALLEL_API_KEY: "parallel-stub",
    LINEAR_ACCESS_TOKEN: "linear-test-token",
    // Additional bindings (ChatAgent, LOADER, etc.) aren't exercised by
    // these tests; cast to Env for type-compat with the real interface.
    ...overrides
  } as Env;
}

describe("handleGatewayRequest", () => {
  it("injects Authorization: Bearer <token> for OAuth tokens on api.linear.app and forwards", async () => {
    const env = makeEnv({ LINEAR_ACCESS_TOKEN: "lin_oauth_test-token" });
    const forwarder = vi.fn(async (_req: Request) => {
      return new Response("ok from upstream", { status: 200 });
    });

    const request = new Request("https://api.linear.app/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "query { viewer { id } }" })
    });

    const response = await handleGatewayRequest(
      request,
      env,
      { userId: "u-1" },
      forwarder
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok from upstream");

    // Forwarder was called exactly once with the transformed request
    expect(forwarder).toHaveBeenCalledTimes(1);
    const forwarded = forwarder.mock.calls[0][0];
    expect(forwarded.url).toBe("https://api.linear.app/graphql");
    expect(forwarded.method).toBe("POST");
    expect(forwarded.headers.get("Authorization")).toBe(
      "Bearer lin_oauth_test-token"
    );
    expect(forwarded.headers.get("content-type")).toBe("application/json");
  });

  it("injects a bare personal API key (no Bearer prefix) for api.linear.app", async () => {
    const env = makeEnv({ LINEAR_ACCESS_TOKEN: "lin_api_test-token" });
    const forwarder = vi.fn(async (_req: Request) => {
      return new Response("ok from upstream", { status: 200 });
    });

    const request = new Request("https://api.linear.app/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "query { viewer { id } }" })
    });

    const response = await handleGatewayRequest(
      request,
      env,
      { userId: "u-1" },
      forwarder
    );

    expect(response.status).toBe(200);
    expect(forwarder).toHaveBeenCalledTimes(1);
    const forwarded = forwarder.mock.calls[0][0];
    // Personal API keys must NOT be prefixed with Bearer — Linear rejects
    // that with "It looks like you're trying to use an API key as a
    // Bearer token." The linearAuthHeader helper branches on the
    // lin_oauth_ prefix to distinguish.
    expect(forwarded.headers.get("Authorization")).toBe("lin_api_test-token");
  });

  it("returns 403 with error JSON for unknown hosts and does NOT call the forwarder", async () => {
    const env = makeEnv();
    const forwarder = vi.fn(async () => {
      throw new Error("forwarder must not be called for unknown host");
    });

    const request = new Request("https://evil.example.com/exfiltrate", {
      method: "GET"
    });

    const response = await handleGatewayRequest(
      request,
      env,
      { userId: "u-1" },
      forwarder
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

    expect(forwarder).not.toHaveBeenCalled();
  });

  it("preserves the original request body and method when forwarding", async () => {
    const env = makeEnv();
    let seenBody: string | null = null;
    const forwarder = vi.fn(async (req: Request) => {
      seenBody = await req.text();
      return new Response("ok", { status: 200 });
    });

    const payload = JSON.stringify({
      query: "mutation { webhookCreate(input: {...}) { success } }"
    });
    const request = new Request("https://api.linear.app/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload
    });

    await handleGatewayRequest(request, env, { userId: "u-2" }, forwarder);

    expect(forwarder).toHaveBeenCalledTimes(1);
    const forwarded = forwarder.mock.calls[0][0];
    expect(forwarded.method).toBe("POST");
    expect(seenBody).toBe(payload);
  });
});
