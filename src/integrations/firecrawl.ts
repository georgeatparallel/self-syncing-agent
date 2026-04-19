/**
 * Firecrawl API client — wraps POST /v2/scrape.
 * Used by the `fetch_docs` tool to pull clean markdown for a single URL.
 * Supervisor-isolate only (the tool runs in the ChatAgent DO); handlers
 * do not call this module.
 *
 * Errors are surfaced as `FirecrawlError` with a narrow `code` union so
 * the tool layer can map to distinct agent-visible shapes. Fetch-level
 * exceptions (network / DNS) propagate untouched — the tool's catch
 * handles those as a generic "upstream unreachable" case.
 *
 * Ref: https://docs.firecrawl.dev/api-reference/endpoint/scrape
 */

export interface ScrapeArgs {
  apiKey: string;
  url: string;
  fetcher?: typeof fetch;
}

export interface ScrapeResult {
  title: string | null;
  markdown: string;
  sourceUrl: string;
}

export type FirecrawlErrorCode =
  | "auth_failed"
  | "quota_exhausted"
  | "scrape_failed";

export class FirecrawlError extends Error {
  constructor(
    public code: FirecrawlErrorCode,
    message: string
  ) {
    super(message);
    this.name = "FirecrawlError";
  }
}

const SCRAPE_URL = "https://api.firecrawl.dev/v2/scrape";

export async function scrapeToMarkdown(
  args: ScrapeArgs
): Promise<ScrapeResult> {
  const fetcher = args.fetcher ?? fetch;

  const req = new Request(SCRAPE_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${args.apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      url: args.url,
      formats: ["markdown"],
      onlyMainContent: true
    })
  });

  const res = await fetcher(req);

  if (res.status === 401 || res.status === 403) {
    throw new FirecrawlError(
      "auth_failed",
      `Firecrawl rejected the API key (HTTP ${res.status}).`
    );
  }
  if (res.status === 402) {
    throw new FirecrawlError(
      "quota_exhausted",
      "Firecrawl quota exhausted (HTTP 402). Upgrade or wait for the monthly reset."
    );
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new FirecrawlError(
      "scrape_failed",
      `Firecrawl returned non-JSON body (HTTP ${res.status}).`
    );
  }

  if (!res.ok) {
    const detail =
      typeof body === "object" && body && "error" in body
        ? String((body as { error: unknown }).error)
        : String(res.status);
    throw new FirecrawlError(
      "scrape_failed",
      `Firecrawl HTTP ${res.status}: ${detail}`
    );
  }

  // 2xx with {success: false} — Firecrawl's own error path.
  if (
    typeof body !== "object" ||
    !body ||
    !("success" in body) ||
    (body as { success: unknown }).success !== true
  ) {
    const detail =
      typeof body === "object" && body && "error" in body
        ? String((body as { error: unknown }).error)
        : "unknown Firecrawl error";
    throw new FirecrawlError("scrape_failed", detail);
  }

  const data = (body as { data?: unknown }).data;
  if (typeof data !== "object" || !data || !("markdown" in data)) {
    throw new FirecrawlError(
      "scrape_failed",
      "Firecrawl response missing data.markdown"
    );
  }

  const markdown = String((data as { markdown: unknown }).markdown);
  const rawMetadata = (data as { metadata?: unknown }).metadata;
  const metadata: Record<string, unknown> =
    typeof rawMetadata === "object" && rawMetadata !== null
      ? (rawMetadata as Record<string, unknown>)
      : {};
  const title = typeof metadata.title === "string" ? metadata.title : null;
  const sourceUrl =
    typeof metadata.sourceURL === "string" ? metadata.sourceURL : args.url;

  return { title, markdown, sourceUrl };
}
