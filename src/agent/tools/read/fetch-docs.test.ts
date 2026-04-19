import { describe, it, expect, vi } from "vitest";
import { fetchDocsTool } from "./fetch-docs";
import { FirecrawlError } from "../../../integrations/firecrawl";
import type { ChatAgent } from "../../../server";

type ToolDef = ReturnType<typeof fetchDocsTool>;

function makeAgent(): ChatAgent {
  return {
    env: { FIRECRAWL_API_KEY: "fc-test" }
  } as unknown as ChatAgent;
}

async function invoke(toolDef: ToolDef, input: { url: string }) {
  // Tool#execute's second arg is ToolCallOptions; we don't use it.
  return (
    toolDef.execute as (input: unknown, options: unknown) => Promise<unknown>
  )(input, {});
}

describe("fetch_docs tool", () => {
  it("returns {ok: true, url, title, markdown} on happy path", async () => {
    const agent = makeAgent();
    const scrape = vi.fn(async () => ({
      title: "Stripe Webhooks",
      markdown: "# Stripe Webhooks\n\nStripe signs…",
      sourceUrl: "https://docs.stripe.com/webhooks/signatures"
    }));
    const toolDef = fetchDocsTool(agent, { scrape });
    const result = await invoke(toolDef, {
      url: "https://docs.stripe.com/webhooks/signatures"
    });
    expect(result).toEqual({
      ok: true,
      url: "https://docs.stripe.com/webhooks/signatures",
      title: "Stripe Webhooks",
      markdown: "# Stripe Webhooks\n\nStripe signs…"
    });
    expect(scrape).toHaveBeenCalledWith({
      apiKey: "fc-test",
      url: "https://docs.stripe.com/webhooks/signatures"
    });
  });

  it("rejects non-http(s) URLs with invalid_url error (no scrape call)", async () => {
    const agent = makeAgent();
    const scrape = vi.fn();
    const toolDef = fetchDocsTool(agent, { scrape });
    const result = await invoke(toolDef, {
      url: "file:///etc/passwd"
    });
    expect(result).toMatchObject({
      ok: false,
      error: "invalid_url"
    });
    expect(scrape).not.toHaveBeenCalled();
  });

  it("rejects malformed URLs", async () => {
    const agent = makeAgent();
    const scrape = vi.fn();
    const toolDef = fetchDocsTool(agent, { scrape });
    const result = await invoke(toolDef, { url: "not a url" });
    expect(result).toMatchObject({ ok: false, error: "invalid_url" });
    expect(scrape).not.toHaveBeenCalled();
  });

  it("maps auth_failed", async () => {
    const agent = makeAgent();
    const scrape = vi.fn(async () => {
      throw new FirecrawlError("auth_failed", "HTTP 401");
    });
    const toolDef = fetchDocsTool(agent, { scrape });
    const result = await invoke(toolDef, {
      url: "https://example.com"
    });
    expect(result).toMatchObject({
      ok: false,
      error: "firecrawl_auth_failed"
    });
  });

  it("maps quota_exhausted", async () => {
    const agent = makeAgent();
    const scrape = vi.fn(async () => {
      throw new FirecrawlError("quota_exhausted", "HTTP 402");
    });
    const toolDef = fetchDocsTool(agent, { scrape });
    const result = await invoke(toolDef, {
      url: "https://example.com"
    });
    expect(result).toMatchObject({
      ok: false,
      error: "firecrawl_quota_exhausted"
    });
  });

  it("maps scrape_failed", async () => {
    const agent = makeAgent();
    const scrape = vi.fn(async () => {
      throw new FirecrawlError("scrape_failed", "404");
    });
    const toolDef = fetchDocsTool(agent, { scrape });
    const result = await invoke(toolDef, {
      url: "https://example.com/404"
    });
    expect(result).toMatchObject({
      ok: false,
      error: "scrape_failed",
      detail: expect.stringContaining("404")
    });
  });

  it("maps network throws to unreachable", async () => {
    const agent = makeAgent();
    const scrape = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const toolDef = fetchDocsTool(agent, { scrape });
    const result = await invoke(toolDef, {
      url: "https://example.com"
    });
    expect(result).toMatchObject({
      ok: false,
      error: "unreachable"
    });
  });
});
