import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  listConnectApps,
  __resetAppsCacheForTests,
  type AppEntry
} from "./apps";

// Mock getCachedAccessToken — its actual value doesn't matter for these
// tests, just that it returns *some* string and is awaited.
vi.mock("./token-cache", () => ({
  getCachedAccessToken: vi.fn().mockResolvedValue("fake-pd-token")
}));

const makeEnv = (): Env => ({}) as unknown as Env;

const appA: AppEntry = {
  name_slug: "slack",
  name: "Slack",
  img_src: "https://example.com/slack.png",
  description: null,
  auth_type: "oauth",
  categories: [],
  featured_weight: 0
};
const appB: AppEntry = {
  name_slug: "github",
  name: "GitHub",
  img_src: "https://example.com/github.png",
  description: null,
  auth_type: "oauth",
  categories: [],
  featured_weight: 0
};
const appC: AppEntry = {
  name_slug: "notion",
  name: "Notion",
  img_src: "https://example.com/notion.png",
  description: null,
  auth_type: "oauth",
  categories: [],
  featured_weight: 0
};

function pageResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

describe("listConnectApps", () => {
  beforeEach(() => {
    __resetAppsCacheForTests();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("single-page walk: returns data and fetches once", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        pageResponse({ data: [appA], page_info: { end_cursor: null } })
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await listConnectApps(makeEnv());
    expect(result).toEqual([appA]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("multi-page stitch: follows end_cursor and concatenates pages", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        pageResponse({ data: [appA, appB], page_info: { end_cursor: "c1" } })
      )
      .mockResolvedValueOnce(
        pageResponse({ data: [appC], page_info: { end_cursor: null } })
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await listConnectApps(makeEnv());
    expect(result).toEqual([appA, appB, appC]);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const secondCallArg = fetchMock.mock.calls[1][0] as URL | Request;
    const secondUrl =
      secondCallArg instanceof URL
        ? secondCallArg
        : new URL((secondCallArg as Request).url);
    expect(secondUrl.searchParams.get("after")).toBe("c1");
  });

  it("cache hit within TTL: second call does not re-fetch", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        pageResponse({ data: [appA], page_info: { end_cursor: null } })
      );
    vi.stubGlobal("fetch", fetchMock);

    const first = await listConnectApps(makeEnv());
    const second = await listConnectApps(makeEnv());
    expect(first).toEqual([appA]);
    expect(second).toEqual([appA]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("cache miss past TTL: re-fetches after 24h", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        pageResponse({ data: [appA], page_info: { end_cursor: null } })
      );
    vi.stubGlobal("fetch", fetchMock);

    await listConnectApps(makeEnv());
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Advance past 24h TTL.
    vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 1);

    await listConnectApps(makeEnv());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("upstream failure with stale cache: serves stale data", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

    const fetchMock = vi
      .fn()
      // First call: seeds cache.
      .mockResolvedValueOnce(
        pageResponse({ data: [appA], page_info: { end_cursor: null } })
      )
      // Second call: upstream failure.
      .mockRejectedValueOnce(new Error("boom"));
    vi.stubGlobal("fetch", fetchMock);

    const first = await listConnectApps(makeEnv());
    expect(first).toEqual([appA]);

    vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 1);

    const second = await listConnectApps(makeEnv());
    expect(second).toEqual([appA]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("upstream failure with no cache: throws", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error("boom"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listConnectApps(makeEnv())).rejects.toThrow("boom");
  });
});
