import { tool } from "ai";
import { z } from "zod";
import {
  scrapeToMarkdown,
  FirecrawlError,
  type ScrapeArgs,
  type ScrapeResult
} from "../../../integrations/firecrawl";
import type { ChatAgent } from "../../../server";

type ScrapeFn = (args: ScrapeArgs) => Promise<ScrapeResult>;

interface FetchDocsDeps {
  scrape?: ScrapeFn;
}

export function fetchDocsTool(agent: ChatAgent, deps: FetchDocsDeps = {}) {
  const scrape = deps.scrape ?? scrapeToMarkdown;
  return tool({
    description:
      "Fetch the full content of a single web page as markdown via Firecrawl. See system prompt for usage patterns.",
    inputSchema: z.object({
      url: z
        .string()
        .describe(
          "Full http(s) URL of the page to fetch. Must start with http:// or https://. One page per call — for multi-page references, call fetch_docs multiple times with specific URLs."
        )
    }),
    execute: async ({ url }) => {
      // URL validation: parse and require http/https. Keeps the surface
      // small; we don't try to implement SSRF protection here because
      // Firecrawl does the fetching from its own infra anyway.
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return {
          ok: false as const,
          error: "invalid_url" as const,
          detail: `Could not parse "${url}" as a URL.`
        };
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return {
          ok: false as const,
          error: "invalid_url" as const,
          detail: `URL must use http:// or https:// (got ${parsed.protocol}).`
        };
      }

      try {
        const result = await scrape({
          apiKey: agent.env.FIRECRAWL_API_KEY,
          url
        });
        return {
          ok: true as const,
          url: result.sourceUrl,
          title: result.title,
          markdown: result.markdown
        };
      } catch (e) {
        if (e instanceof FirecrawlError) {
          // Map narrow codes to tool-layer codes. The firecrawl_ prefix on
          // auth/quota flags infrastructure problems the user may need to
          // act on (rotate key, upgrade plan). Plain scrape_failed covers
          // target-URL issues (404, blocked by robots, JS-only page even
          // Firecrawl can't render).
          if (e.code === "auth_failed") {
            return {
              ok: false as const,
              error: "firecrawl_auth_failed" as const,
              detail: e.message
            };
          }
          if (e.code === "quota_exhausted") {
            return {
              ok: false as const,
              error: "firecrawl_quota_exhausted" as const,
              detail: e.message
            };
          }
          return {
            ok: false as const,
            error: "scrape_failed" as const,
            detail: e.message
          };
        }
        // Network / DNS / connection reset — anything the fetch itself
        // threw (TypeError from Cloudflare Workers' fetch, etc.).
        return {
          ok: false as const,
          error: "unreachable" as const,
          detail: e instanceof Error ? e.message : String(e)
        };
      }
    }
  });
}
