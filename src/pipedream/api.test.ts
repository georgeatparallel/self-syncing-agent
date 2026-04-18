import { describe, it, expect, vi, beforeEach } from "vitest";
import { getAccessToken, createConnectToken } from "./api";

const makeEnv = (): Env =>
  ({
    PIPEDREAM_CLIENT_ID: "cid",
    PIPEDREAM_CLIENT_SECRET: "csec",
    PIPEDREAM_PROJECT_ID: "proj_xyz",
    PIPEDREAM_ENVIRONMENT: "development"
  }) as unknown as Env;

describe("getAccessToken", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs to /v1/oauth/token and returns token + expiry", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "pd_access_xyz",
          expires_in: 3600,
          token_type: "Bearer"
        }),
        { status: 200 }
      )
    );
    const res = await getAccessToken(makeEnv());
    expect(res).toEqual({
      accessToken: "pd_access_xyz",
      expiresInSeconds: 3600
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://api.pipedream.com/v1/oauth/token");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({
      grant_type: "client_credentials",
      client_id: "cid",
      client_secret: "csec"
    });
  });

  it("throws on non-2xx with body context", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("bad creds", { status: 401 })
    );
    await expect(getAccessToken(makeEnv())).rejects.toThrow(/401/);
  });
});

describe("createConnectToken", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs to /v1/connect/{projectId}/tokens with bearer + env header", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          token: "ctok_abc",
          expires_at: "2099-01-01T00:00:00Z",
          connect_link_url:
            "https://pipedream.com/_static/connect.html?token=ctok_abc"
        }),
        { status: 200 }
      )
    );
    const res = await createConnectToken(
      makeEnv(),
      "pd_access_xyz",
      "external-user-1"
    );
    expect(res).toEqual({
      token: "ctok_abc",
      connectLinkUrl:
        "https://pipedream.com/_static/connect.html?token=ctok_abc"
    });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://api.pipedream.com/v1/connect/proj_xyz/tokens");
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer pd_access_xyz");
    expect(headers.get("X-PD-Environment")).toBe("development");
    expect(JSON.parse(init?.body as string)).toEqual({
      external_user_id: "external-user-1"
    });
  });

  it("throws on non-2xx response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("nope", { status: 500 })
    );
    await expect(
      createConnectToken(makeEnv(), "pd_access_xyz", "u-1")
    ).rejects.toThrow(/500/);
  });
});
