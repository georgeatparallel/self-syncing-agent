import { describe, it, expect, vi } from "vitest";
import { proxiedFetch } from "./proxy";

const makeEnv = (): Env =>
  ({
    PIPEDREAM_PROJECT_ID: "proj_xyz",
    PIPEDREAM_ENVIRONMENT: "development"
  }) as unknown as Env;

describe("proxiedFetch", () => {
  it("constructs the correct proxy URL with base64-encoded target + query params", async () => {
    const forwarder = vi
      .fn()
      .mockResolvedValue(new Response("ok", { status: 200 }));
    await proxiedFetch({
      env: makeEnv(),
      accessToken: "pd_access_abc",
      accountId: "apn_gh_1",
      externalUserId: "user-42",
      request: new Request("https://api.github.com/user/repos", {
        method: "GET"
      }),
      forwarder
    });
    expect(forwarder).toHaveBeenCalledTimes(1);
    const sentReq = forwarder.mock.calls[0][0] as Request;
    const sentUrl = new URL(sentReq.url);
    expect(sentUrl.origin).toBe("https://api.pipedream.com");
    expect(sentUrl.pathname).toMatch(
      /^\/v1\/connect\/proj_xyz\/proxy\/[A-Za-z0-9_-]+$/
    );
    expect(sentUrl.searchParams.get("external_user_id")).toBe("user-42");
    expect(sentUrl.searchParams.get("account_id")).toBe("apn_gh_1");

    // Decode the URL-safe base64 segment and confirm it's the original URL.
    const encoded = sentUrl.pathname.split("/").pop()!;
    const padded =
      encoded.replace(/-/g, "+").replace(/_/g, "/") +
      "=".repeat((4 - (encoded.length % 4)) % 4);
    expect(atob(padded)).toBe("https://api.github.com/user/repos");
  });

  it("sets Authorization and X-PD-Environment on the outgoing request", async () => {
    const forwarder = vi
      .fn()
      .mockResolvedValue(new Response("ok", { status: 200 }));
    await proxiedFetch({
      env: makeEnv(),
      accessToken: "pd_access_abc",
      accountId: "apn_gh_1",
      externalUserId: "u",
      request: new Request("https://api.github.com/user/repos"),
      forwarder
    });
    const sentReq = forwarder.mock.calls[0][0] as Request;
    expect(sentReq.headers.get("Authorization")).toBe("Bearer pd_access_abc");
    expect(sentReq.headers.get("X-PD-Environment")).toBe("development");
  });

  it("prefixes non-system headers with x-pd-proxy- and strips system headers", async () => {
    const forwarder = vi
      .fn()
      .mockResolvedValue(new Response("ok", { status: 200 }));
    await proxiedFetch({
      env: makeEnv(),
      accessToken: "pd_access_abc",
      accountId: "apn_gh_1",
      externalUserId: "u",
      request: new Request("https://api.github.com/user/repos", {
        headers: {
          "content-type": "application/json",
          "x-github-api-version": "2022-11-28",
          accept: "application/vnd.github+json"
        }
      }),
      forwarder
    });
    const sentReq = forwarder.mock.calls[0][0] as Request;
    expect(sentReq.headers.get("x-pd-proxy-content-type")).toBe(
      "application/json"
    );
    expect(sentReq.headers.get("x-pd-proxy-x-github-api-version")).toBe(
      "2022-11-28"
    );
    expect(sentReq.headers.get("x-pd-proxy-accept")).toBe(
      "application/vnd.github+json"
    );
    // Ensure no raw unprefixed version of the original custom headers leaked through.
    expect(sentReq.headers.get("x-github-api-version")).toBeNull();
  });

  it("preserves method and body", async () => {
    const forwarder = vi
      .fn()
      .mockResolvedValue(new Response("ok", { status: 201 }));
    const body = JSON.stringify({ channel: "C1", text: "hello" });
    await proxiedFetch({
      env: makeEnv(),
      accessToken: "pd_access_abc",
      accountId: "apn_sl_1",
      externalUserId: "u",
      request: new Request("https://slack.com/api/chat.postMessage", {
        method: "POST",
        body,
        headers: { "content-type": "application/json" }
      }),
      forwarder
    });
    const sentReq = forwarder.mock.calls[0][0] as Request;
    expect(sentReq.method).toBe("POST");
    expect(await sentReq.text()).toBe(body);
  });

  it("returns the upstream Response unchanged", async () => {
    const upstream = new Response("upstream body", {
      status: 418,
      headers: { "x-upstream": "marker" }
    });
    const forwarder = vi.fn().mockResolvedValue(upstream);
    const res = await proxiedFetch({
      env: makeEnv(),
      accessToken: "pd_access_abc",
      accountId: "apn_gh_1",
      externalUserId: "u",
      request: new Request("https://api.github.com/user/repos"),
      forwarder
    });
    expect(res.status).toBe(418);
    expect(res.headers.get("x-upstream")).toBe("marker");
    expect(await res.text()).toBe("upstream body");
  });
});
