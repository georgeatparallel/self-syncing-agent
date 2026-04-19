import { describe, it, expect, vi } from "vitest";
import { scrapeToMarkdown } from "./firecrawl";

const API_KEY = "fc-test-key";

interface MockResponseInit {
  status?: number;
  body?: string;
}

function mockFetcher(
  response: MockResponseInit | ((req: Request) => Promise<Response>)
): typeof fetch {
  if (typeof response === "function") {
    return response as unknown as typeof fetch;
  }
  return (async () =>
    new Response(response.body ?? JSON.stringify({ success: true, data: {} }), {
      status: response.status ?? 200,
      headers: { "content-type": "application/json" }
    })) as unknown as typeof fetch;
}

describe("scrapeToMarkdown", () => {
  it("returns {title, markdown, sourceUrl} on a successful scrape", async () => {
    const fetcher = vi.fn(
      async (_req: Request) =>
        new Response(
          JSON.stringify({
            success: true,
            data: {
              markdown: "# Stripe Webhooks\n\nStripe uses…",
              metadata: {
                title: "Stripe Webhooks",
                sourceURL: "https://docs.stripe.com/webhooks/signatures",
                statusCode: 200
              }
            }
          }),
          { status: 200 }
        )
    );
    const result = await scrapeToMarkdown({
      apiKey: API_KEY,
      url: "https://docs.stripe.com/webhooks/signatures",
      fetcher: fetcher as unknown as typeof fetch
    });
    expect(result.title).toBe("Stripe Webhooks");
    expect(result.markdown).toContain("Stripe uses");
    expect(result.sourceUrl).toBe(
      "https://docs.stripe.com/webhooks/signatures"
    );

    // Verify request shape.
    expect(fetcher).toHaveBeenCalledTimes(1);
    const sent = fetcher.mock.calls[0][0] as unknown as Request;
    expect(sent.url).toBe("https://api.firecrawl.dev/v2/scrape");
    expect(sent.method).toBe("POST");
    expect(sent.headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
    const body = await sent.clone().json();
    expect(body).toEqual({
      url: "https://docs.stripe.com/webhooks/signatures",
      formats: ["markdown"],
      onlyMainContent: true
    });
  });

  it("maps 401 → auth_failed", async () => {
    const fetcher = mockFetcher({ status: 401, body: "Unauthorized" });
    await expect(
      scrapeToMarkdown({
        apiKey: "fc-bad",
        url: "https://example.com",
        fetcher
      })
    ).rejects.toMatchObject({
      name: "FirecrawlError",
      code: "auth_failed"
    });
  });

  it("maps 403 → auth_failed", async () => {
    const fetcher = mockFetcher({ status: 403, body: "Forbidden" });
    await expect(
      scrapeToMarkdown({
        apiKey: API_KEY,
        url: "https://example.com",
        fetcher
      })
    ).rejects.toMatchObject({ code: "auth_failed" });
  });

  it("maps 402 → quota_exhausted", async () => {
    const fetcher = mockFetcher({ status: 402, body: "Payment required" });
    await expect(
      scrapeToMarkdown({
        apiKey: API_KEY,
        url: "https://example.com",
        fetcher
      })
    ).rejects.toMatchObject({ code: "quota_exhausted" });
  });

  it("maps {success: false} → scrape_failed with upstream detail", async () => {
    const fetcher = mockFetcher({
      status: 200,
      body: JSON.stringify({
        success: false,
        error: "Failed to scrape: URL returned 404"
      })
    });
    await expect(
      scrapeToMarkdown({
        apiKey: API_KEY,
        url: "https://example.com/404",
        fetcher
      })
    ).rejects.toMatchObject({
      code: "scrape_failed",
      message: expect.stringContaining("URL returned 404")
    });
  });

  it("maps generic 5xx → scrape_failed", async () => {
    const fetcher = mockFetcher({
      status: 500,
      body: "Internal Server Error"
    });
    await expect(
      scrapeToMarkdown({
        apiKey: API_KEY,
        url: "https://example.com",
        fetcher
      })
    ).rejects.toMatchObject({ code: "scrape_failed" });
  });

  it("maps malformed JSON → scrape_failed", async () => {
    const fetcher = mockFetcher({
      status: 200,
      body: "<html>not json</html>"
    });
    await expect(
      scrapeToMarkdown({
        apiKey: API_KEY,
        url: "https://example.com",
        fetcher
      })
    ).rejects.toMatchObject({ code: "scrape_failed" });
  });

  it("propagates fetch-level exceptions without wrapping", async () => {
    const fetcher = vi.fn(async (_req: Request): Promise<Response> => {
      throw new TypeError("network down");
    });
    await expect(
      scrapeToMarkdown({
        apiKey: API_KEY,
        url: "https://example.com",
        fetcher: fetcher as unknown as typeof fetch
      })
    ).rejects.toThrow(TypeError);
  });

  it("uses metadata.title if present, falls back to null otherwise", async () => {
    const fetcher = mockFetcher({
      status: 200,
      body: JSON.stringify({
        success: true,
        data: {
          markdown: "Some content",
          metadata: { sourceURL: "https://example.com" }
        }
      })
    });
    const result = await scrapeToMarkdown({
      apiKey: API_KEY,
      url: "https://example.com",
      fetcher
    });
    expect(result.title).toBeNull();
    expect(result.markdown).toBe("Some content");
  });
});
