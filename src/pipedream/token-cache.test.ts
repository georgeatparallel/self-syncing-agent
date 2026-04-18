import { describe, it, expect, vi, beforeEach } from "vitest";
import { getCachedAccessToken, _clearCacheForTests } from "./token-cache";
import * as api from "./api";

const makeEnv = (): Env =>
  ({
    PIPEDREAM_CLIENT_ID: "cid",
    PIPEDREAM_CLIENT_SECRET: "csec",
    PIPEDREAM_PROJECT_ID: "proj_xyz",
    PIPEDREAM_ENVIRONMENT: "development"
  }) as unknown as Env;

describe("getCachedAccessToken", () => {
  beforeEach(() => {
    _clearCacheForTests();
    vi.restoreAllMocks();
  });

  it("calls getAccessToken on first request", async () => {
    const spy = vi.spyOn(api, "getAccessToken").mockResolvedValue({
      accessToken: "t1",
      expiresInSeconds: 3600
    });
    const tok = await getCachedAccessToken(makeEnv());
    expect(tok).toBe("t1");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("returns cached token on second request within TTL", async () => {
    const spy = vi.spyOn(api, "getAccessToken").mockResolvedValue({
      accessToken: "t1",
      expiresInSeconds: 3600
    });
    await getCachedAccessToken(makeEnv());
    await getCachedAccessToken(makeEnv());
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("refreshes when the token is within 60s of expiry", async () => {
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValue(0);
    const apiSpy = vi
      .spyOn(api, "getAccessToken")
      .mockResolvedValueOnce({ accessToken: "t1", expiresInSeconds: 120 })
      .mockResolvedValueOnce({ accessToken: "t2", expiresInSeconds: 3600 });

    await getCachedAccessToken(makeEnv());
    // usableUntilMs = 0 + 120_000 - 60_000 = 60_000
    nowSpy.mockReturnValue(30_000); // 30s elapsed — 30s still usable, cached
    const t2 = await getCachedAccessToken(makeEnv());
    expect(t2).toBe("t1");
    expect(apiSpy).toHaveBeenCalledTimes(1);

    nowSpy.mockReturnValue(70_000); // past usableUntilMs (60_000) — refresh
    const t3 = await getCachedAccessToken(makeEnv());
    expect(t3).toBe("t2");
    expect(apiSpy).toHaveBeenCalledTimes(2);
  });
});
