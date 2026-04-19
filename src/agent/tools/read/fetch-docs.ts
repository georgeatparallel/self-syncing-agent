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
    description: `Fetch the full content of a single web page as markdown. Backed by Firecrawl — handles JS-rendered pages and extracts the main content (strips nav, footers, sidebars). Use for contract-level precision when \`web_search\`'s excerpts aren't enough.

**Use when:**
- Pinning down signing algorithms, header names, encodings (hex vs base64, \`sha256=\` prefix, timestamp replay windows).
- Reading webhook-creation API references (endpoint URL, request body shape, OAuth scopes needed, which resource the webhook is scoped to).
- Verifying rate limits, request/response size caps, retry behavior — anything where a missed detail produces a bug.

**Don't use when:**
- Discovering payload shapes (what fields does this integration send?). Use the probe loop — docs contradict reality more often than you'd expect.
- Fishing for "any relevant info" — that's \`web_search\`. \`fetch_docs\` is for a specific URL you've already decided to read.

**Workflow:**
1. \`web_search\` with a focused objective ("Stripe webhook signature verification algorithm").
2. Pick the most authoritative URL from the results (upstream's own docs beat third-party explainers).
3. \`fetch_docs(url)\` to pull the full page.
4. If the answer lives on a linked sub-page, fetch that too — one page per call.

**Output:**
- \`{ok: true, url, title, markdown}\` — title is best-effort (sometimes null); markdown is the extracted main content. Pages are typically 2-30KB; a huge API reference (Stripe's webhook events index) can be 100KB+ — in that case, fetch a specific sub-page instead.
- \`{ok: false, error, detail}\` — errors:
  - \`invalid_url\`: the url didn't parse as http/https.
  - \`firecrawl_auth_failed\`: server's FIRECRAWL_API_KEY is wrong (tell the user — this is their problem, not yours).
  - \`firecrawl_quota_exhausted\`: free tier used up (same — user upgrade needed).
  - \`scrape_failed\`: Firecrawl couldn't fetch the page (404, rate limit on the upstream, JS-only page that even Firecrawl couldn't render, etc.).
  - \`unreachable\`: network-level failure between supervisor and Firecrawl.

On \`scrape_failed\` or \`unreachable\`, fall back to \`web_search\` excerpts — don't give up on the question.`,
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
