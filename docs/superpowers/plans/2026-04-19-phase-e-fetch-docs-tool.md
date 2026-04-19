# Phase E: `fetch_docs` Tool — Firecrawl-Backed Docs Reader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the contract-discovery gap. After Phase D, the agent can author entire integrations, but when it encounters an upstream it hasn't seen before, it relies on `web_search` excerpts to figure out signing algorithms, webhook-registration APIs, and auth scope requirements. Search excerpts are lossy — the "signed string is `v0:{timestamp}:{body}`, not just the body" kind of detail often lives past the snippet boundary. Phase E adds a `fetch_docs(url)` tool backed by Firecrawl that pulls the full content of any web page as clean markdown. Agent uses `web_search` to find the URL; `fetch_docs` to read it deeply. Same two-step pattern a human uses.

**Architecture:**

- New tool: `fetch_docs(url: string)` registered alongside `web_search` in `buildTools`. Pure read-side tool, no approval gate.
- Firecrawl-backed. Firecrawl's `POST /v2/scrape` endpoint with `{formats: ["markdown"], onlyMainContent: true}` returns extracted main content as markdown, stripping navigation / footers / sidebars. Handles JS-rendered SPAs (which plain HTTP fetch cannot). Free tier (500 pages/mo) is plenty for a trial demo; ~$0.0015/page on the paid tier.
- Tool runs in the ChatAgent (supervisor) isolate, not in a facet — so it uses direct `fetch`, no HttpGateway routing. `FIRECRAWL_API_KEY` is a new supervisor env secret.
- Agent discipline enforced via system prompt + tool description:
  - **Use** for: signing algorithms, webhook-registration endpoint specs, OAuth scope requirements, rate-limit documentation, API reference pages when search excerpts aren't enough.
  - **Don't use** for: payload shape discovery — that's what the probe loop is for. Docs contradict live payload shapes often enough that relying on them is a worse default than just observing.
  - **Workflow**: `web_search` to discover the URL, `fetch_docs` to read it. Avoid blind-fetching URLs the agent hasn't validated.
- No caching layer in V1. Identical URLs fetched twice hit Firecrawl twice. Fine for demo; noted for Future Work.
- No crawling (multi-page recursive fetches). Single-page scrape only. If the agent needs multiple pages of a large reference (Stripe's webhook event types), it calls `fetch_docs` once per page — deliberate, auditable.

**Tech Stack:** Firecrawl REST API v2 (`https://api.firecrawl.dev/v2/scrape`), Cloudflare Workers `fetch` from supervisor isolate, Vitest with mocked `fetch` for unit tests.

**Branch:** `feat/fetch-docs` (new branch off `main`; `feat/pipedream` is already merged).

---

## Prerequisite (user action, not a task)

- Sign up at https://firecrawl.dev, grab an API key from the dashboard.
- Add to local dev: `echo 'FIRECRAWL_API_KEY=fc-...' >> .dev.vars`
- Add to prod: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npx wrangler secret put FIRECRAWL_API_KEY` (paste the key into the interactive prompt).
- Regenerate env types: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npx wrangler types`.

Implementer should CONFIRM with the user that both dev + prod keys are set before starting Task 1 (so the smoke test in Task 4 can actually run).

---

## File Structure

**New files:**

- `src/integrations/firecrawl.ts` — low-level Firecrawl client. Single function `scrapeToMarkdown({apiKey, url, fetcher?})` that POSTs to `/v2/scrape`, parses the response, returns `{title, markdown, sourceUrl}` on success or throws a typed error. ~80 lines.
- `src/integrations/firecrawl.test.ts` — unit tests with mocked fetcher: happy path (Firecrawl returns markdown), 401 (bad key), 402 (quota exhausted), 400 (bad URL from Firecrawl's perspective), 5xx retry-worthy upstream errors, malformed JSON response, network throw.
- `src/agent/tools/read/fetch-docs.ts` — `fetch_docs` tool definition. Wraps `scrapeToMarkdown` with the `tool()` helper. URL validation (http/https only), error normalization (maps Firecrawl errors to tool-layer discriminated union).
- `src/agent/tools/read/fetch-docs.test.ts` — tool-layer tests. Mocks the Firecrawl client, asserts tool return shape on happy path + each error branch. Assert URL validation rejects non-http URLs.

**Modified files:**

- `src/agent/tools/index.ts` — register `fetch_docs` in `buildTools`. Placement: after `web_search` (read tools grouped together). Note the cache_control breakpoint — see Task 2 for specifics.
- `src/agent/system-prompt.ts` — extend the "## Tools" section's read-tools bullet for `web_search` to cross-reference `fetch_docs`. Add a brief "## Researching an unfamiliar integration" subsection (or extend the existing probe loop) that names the two-step `web_search → fetch_docs` workflow and the payload-vs-contracts distinction.
- `worker-configuration.d.ts` (or `env.d.ts`) — regenerated via `wrangler types` after the user adds `FIRECRAWL_API_KEY`.

**No deleted files.**

**No frontend changes.**

---

## Task 1: Firecrawl API client

**Files:**

- Create: `src/integrations/firecrawl.ts`
- Create: `src/integrations/firecrawl.test.ts`

**Context:** Tiny wrapper around `POST https://api.firecrawl.dev/v2/scrape`. Firecrawl's v2 scrape response shape:

```jsonc
// Success
{
  "success": true,
  "data": {
    "markdown": "# Page Title\n\nContent…",
    "metadata": {
      "title": "Page Title",
      "sourceURL": "https://…",
      "statusCode": 200
    }
  }
}
// Failure
{
  "success": false,
  "error": "Failed to scrape URL: …"
}
```

Our client normalizes this into `{title, markdown, sourceUrl}` on success; throws a `FirecrawlError` with a `code` field on any other outcome. Three error codes:

- `"auth_failed"` — 401/403 from Firecrawl (bad or missing key).
- `"quota_exhausted"` — 402 from Firecrawl (free tier exhausted or payment required).
- `"scrape_failed"` — 4xx/5xx from Firecrawl with a body, or Firecrawl returned `{success: false}`, or the response body is malformed JSON. Message includes upstream detail.

Fetch-level exceptions (network down, DNS fail) propagate as-is — tool layer catches those separately.

- [ ] **Step 1: Write the failing tests**

```ts
// src/integrations/firecrawl.test.ts
import { describe, it, expect, vi } from "vitest";
import { scrapeToMarkdown, FirecrawlError } from "./firecrawl";

const API_KEY = "fc-test-key";

function mockFetcher(
  response: Partial<Response> | ((req: Request) => Promise<Response>)
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
      async () =>
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
    const sent = fetcher.mock.calls[0][0] as Request;
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
    const fetcher = vi.fn(async () => {
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
```

- [ ] **Step 2: Run tests to verify they FAIL**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npx vitest run src/integrations/firecrawl.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write the implementation**

```ts
// src/integrations/firecrawl.ts

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
  const metadata =
    typeof (data as { metadata?: unknown }).metadata === "object"
      ? (data as { metadata: Record<string, unknown> }).metadata
      : {};
  const title = typeof metadata.title === "string" ? metadata.title : null;
  const sourceUrl =
    typeof metadata.sourceURL === "string" ? metadata.sourceURL : args.url;

  return { title, markdown, sourceUrl };
}
```

- [ ] **Step 4: Run tests to verify they PASS**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npx vitest run src/integrations/firecrawl.test.ts`
Expected: PASS (8/8).

- [ ] **Step 5: Run typecheck**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/integrations/firecrawl.ts src/integrations/firecrawl.test.ts
git commit -m "feat(firecrawl): API client for /v2/scrape with typed errors"
```

---

## Task 2: `fetch_docs` tool + registration

**Files:**

- Create: `src/agent/tools/read/fetch-docs.ts`
- Create: `src/agent/tools/read/fetch-docs.test.ts`
- Modify: `src/agent/tools/index.ts`

**Context:** Tool-layer wrapper around `scrapeToMarkdown`. Responsibilities:

1. **URL validation.** Only `http://` or `https://` URLs. Reject anything else (`file://`, `data:`, etc.) with a clean error — this keeps the surface small without pretending to implement robust SSRF protection (which we couldn't anyway, since Firecrawl fetches from its own infrastructure).
2. **Error normalization.** Map `FirecrawlError` code → tool result's `error` field. Map generic fetch-level throws (`TypeError` from network failures) to `{error: "unreachable"}`.
3. **Success passthrough.** Return `{ok: true, url, title, markdown}`.

The tool returns a discriminated union. Agent reads the shape and decides how to respond — fall back to web_search excerpts, warn the user about quota, etc.

Register in `buildTools` AFTER `web_search`. Important gotcha: the existing `update_sync` entry carries the anthropic `cache_control` breakpoint (it's the LAST key in the returned object). That stays last. `fetch_docs` goes between `web_search` and `create_sync` — read tools grouped together, write tools after.

- [ ] **Step 1: Write the failing tool tests**

```ts
// src/agent/tools/read/fetch-docs.test.ts
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

async function invoke(
  toolDef: ToolDef,
  input: Parameters<NonNullable<ToolDef["execute"]>>[0]
) {
  // Tool#execute's second arg is the ToolCallOptions, which we don't use.
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
```

- [ ] **Step 2: Run tests to verify they FAIL**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npx vitest run src/agent/tools/read/fetch-docs.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write the implementation**

```ts
// src/agent/tools/read/fetch-docs.ts
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
      /* filled in by Task 3 — keep a minimal placeholder here */ "Fetch the full content of a single web page as markdown via Firecrawl. See system prompt for usage patterns.",
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
          // Map narrow codes to tool-layer codes with the firecrawl_ prefix
          // for auth/quota (infrastructure problems the user may need to
          // act on) and a plain scrape_failed for everything else.
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
        // Network / DNS / connection reset — anything the fetch itself threw.
        return {
          ok: false as const,
          error: "unreachable" as const,
          detail: e instanceof Error ? e.message : String(e)
        };
      }
    }
  });
}
```

- [ ] **Step 4: Run tool tests to verify they PASS**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npx vitest run src/agent/tools/read/fetch-docs.test.ts`
Expected: PASS (7/7).

- [ ] **Step 5: Register in `buildTools`**

Open `src/agent/tools/index.ts`. Import `fetchDocsTool`, add it to the returned object between `web_search` and `create_sync`. The `update_sync` tail entry with `providerOptions.cache_control` stays as-is — it's still the last key.

```ts
import { fetchDocsTool } from "./read/fetch-docs";
// …
return {
  list_syncs: listSyncsTool(agent),
  get_sync: getSyncTool(agent),
  get_sync_errors: getSyncErrorsTool(agent),
  query_sync: querySyncTool(agent),
  web_search: webSearchTool(agent),
  fetch_docs: fetchDocsTool(agent),
  create_sync: createSyncTool(agent),
  delete_sync: deleteSyncTool(agent),
  run_in_sync: runInSyncTool(agent),
  update_sync: {
    ...updateSyncTool(agent),
    providerOptions: {
      anthropic: { cacheControl: { type: "ephemeral" } }
    }
  }
};
```

Also update the jsdoc comment above `buildTools` to note `fetch_docs` is live.

- [ ] **Step 6: Run full check**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npm run check`
Expected: fully green. `FIRECRAWL_API_KEY` must be present in `.dev.vars` (user action from Prerequisite) for the type to resolve — if `wrangler types` hasn't been regenerated, `agent.env.FIRECRAWL_API_KEY` will be a tsc error. If that happens, run `npx wrangler types` and retry.

- [ ] **Step 7: Commit**

```bash
git add src/agent/tools/read/fetch-docs.ts src/agent/tools/read/fetch-docs.test.ts src/agent/tools/index.ts env.d.ts
git commit -m "feat(tools): fetch_docs — Firecrawl-backed docs reader"
```

(Include `env.d.ts` if `wrangler types` regenerated it.)

---

## Task 3: Tool description + system-prompt guidance

**Files:**

- Modify: `src/agent/tools/read/fetch-docs.ts` (description string)
- Modify: `src/agent/system-prompt.ts`

**Context:** The LLM reads the tool description before each call and the system prompt once per turn. For `fetch_docs`, the description needs to convey:

- What it does (fetch a page, return markdown).
- When to use (contract-level questions: signing algorithms, webhook-creation API specs, scope requirements).
- When NOT to use (payload shape — that's the probe loop).
- Workflow: `web_search` first to find the URL, `fetch_docs` second to read it.
- Output cost note: markdown pages can be 2-30KB. For huge references, fetch specific sub-pages.

The system prompt gets:

- A one-liner addition to the `## Tools` read-tools listing for `fetch_docs`.
- A short "## Researching an unfamiliar integration" subsection (or a note extending the existing probe loop's Phase 1) that explicitly names the `web_search → fetch_docs` two-step and the payload-vs-contracts distinction.

### Replace the placeholder description in `src/agent/tools/read/fetch-docs.ts`

```ts
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

On \`scrape_failed\` or \`unreachable\`, fall back to \`web_search\` excerpts — don't give up on the question.`;
```

### System-prompt updates

Open `src/agent/system-prompt.ts`. Two edits:

**Edit A** — extend the read-tools listing (around line 23, the `web_search` bullet). Replace:

```
- \`web_search(objective, search_queries?)\` — agentic web search via Parallel AI. Useful for: API docs (how to trigger an event, find a specific endpoint), error-code meanings, fact-checking. NOT the primary path for discovering webhook payload shapes — use the probe loop below for that.
```

With:

```
- \`web_search(objective, search_queries?)\` — agentic web search via Parallel AI. Returns ranked excerpts. Useful for: finding the right docs URL, API error-code lookups, fact-checking. NOT the primary path for discovering webhook payload shapes — use the probe loop below for that.
- \`fetch_docs(url)\` — pull the full content of a single web page as markdown (Firecrawl-backed, handles JS-rendered pages). Follow-on to \`web_search\` when excerpts aren't precise enough for contract-level questions (signing algorithms, webhook-creation endpoints, auth scope requirements). See the tool description for usage rules and the payload-vs-contracts guardrail.
```

**Edit B** — in the "## The probe loop — for unfamiliar integrations" section (around line 52), extend the intro paragraph OR add a new paragraph BEFORE the "Phase 1" subheader. Insert:

```
**Before you probe, research the contracts.** Payload shapes come from the probe loop (you capture them live). But signing algorithms, webhook-creation APIs, and auth requirements come from docs — and getting these wrong wastes a full probe cycle. Use \`web_search\` to find the upstream's webhook docs, then \`fetch_docs\` on the most authoritative URL to read the signing + registration specs in detail. Write your \`verifySignature\` and \`registerWebhook\` code against what the docs say. Write your schema + \`handleWebhook\` payload-parsing code against what the probe loop observes. The two workflows are complementary — neither substitutes for the other.
```

Leave the Phase 1/2/3 content unchanged. The 401-triage rubric section and everything below stays as-is.

- [ ] **Step 1: Replace the tool description**

- [ ] **Step 2: Apply both system-prompt edits**

- [ ] **Step 3: Run tests**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npm run check`
Expected: fully green. Description-text changes don't affect behavior tests; they're just strings.

- [ ] **Step 4: Commit**

```bash
git add src/agent/tools/read/fetch-docs.ts src/agent/system-prompt.ts
git commit -m "feat(agent): fetch_docs description + probe-loop contract-research guidance"
```

---

## Task 4: Manual smoke — agent adds a brand-new integration

**Files:** none (manual verification).

**Context:** The payoff demo. Pick an integration the agent hasn't seen before (good candidates: Stripe — rich signing scheme with timestamp replay protection; PagerDuty — quirky HMAC-SHA256 on concatenated body; Notion webhooks — uses `notion-webhook-signature` with tolerance window). The goal isn't necessarily to create a fully-working sync end-to-end (that would require a real account with the upstream); the goal is to exercise the `web_search → fetch_docs → draft handler` flow and prove the agent uses the tools correctly.

Two levels of smoke:

### Level 1 — basic tool exercise

In the dev server chat:

> "Use fetch_docs on https://docs.stripe.com/webhooks/signatures and tell me the exact signed-string format Stripe uses, including the separator character."

Expected: agent calls `fetch_docs` with that URL, returns an answer that matches the actual doc — something like: "Stripe signs the string `<timestamp>.<payload>` where timestamp is the UNIX ms from the `t=` segment of `stripe-signature` and payload is the raw request body, separated by a literal period."

Verify:

- Agent invoked `fetch_docs`, not `web_search`.
- Returned answer cites specifics that only appear in full docs (the period separator, the `t=` / `v1=` header segments, the replay-protection window).

If the agent tries to answer from training data without calling fetch_docs, the system prompt isn't landing — reconsider Edit B wording.

### Level 2 — new integration end-to-end (optional if you have a Stripe test account)

Create a Stripe connection in Pipedream (or skip if you don't have a Stripe test account — Level 1 is enough for the thesis).

Ask agent:

> "Create a sync for Stripe webhooks. Track `payment_intent.succeeded` and `payment_intent.payment_failed` events. Use fetch_docs to find the exact verifySignature algorithm Stripe uses and the Stripe API endpoint for creating webhook endpoints."

The agent should:

1. `web_search("Stripe webhook endpoint API create")` → find the URL for the Stripe API webhooks reference.
2. `fetch_docs(<stripe-api-endpoints-url>)` → read the endpoint shape.
3. `web_search("Stripe webhook signature verification")` → find the signing docs.
4. `fetch_docs("https://docs.stripe.com/webhooks/signatures")` → read the signing algorithm.
5. Draft a handler with all four exports including Stripe-specific verifySignature (with timestamp replay window) and registerWebhook (POSTing to Stripe's API endpoints endpoint).
6. `create_sync` — fires the registration.
7. Verify the webhook appears in Stripe's dashboard.

If you don't have a Stripe test account:

- Level 1 is sufficient for the Loom.
- Mention in the PR description / README that the tool CAN enable end-to-end onboarding of any integration, just limited by account access for demos.

### Verification checklist

- [ ] Agent invokes `fetch_docs` in response to contract-level questions (Level 1 passes).
- [ ] Agent uses `web_search → fetch_docs` as a two-step, not just one or the other.
- [ ] Returned content is accurate and specific (details that are NOT in search excerpts — i.e., the tool is actually adding value).
- [ ] Error cases degrade gracefully (manually test: set FIRECRAWL_API_KEY to a bogus value, ask agent to fetch_docs, verify the agent surfaces `firecrawl_auth_failed` and tells the user).

- [ ] **Step 1: Start dev server**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npm run dev`

- [ ] **Step 2: Run Level 1 smoke**

Ask the Stripe signing-format question. Verify accuracy.

- [ ] **Step 3 (optional): Run Level 2 smoke**

If a Stripe test account is available, create a real Stripe sync end-to-end.

- [ ] **Step 4: Push the branch**

```bash
git push -u origin feat/fetch-docs
```

- [ ] **Step 5: Open PR against main**

```bash
gh pr create --title "feat: fetch_docs tool — close the contract-discovery gap" --body "<body>"
```

(Draft body similar to the Phase D PR description — summary + what changed + test plan + migration note "none, purely additive.")

---

## Self-Review Checklist

**1. Spec coverage:**

- ✅ Agent can read full docs pages, not just search excerpts.
- ✅ URL validation prevents non-http(s) protocols.
- ✅ All four Firecrawl error modes (auth, quota, scrape, network) surface distinctly to the agent.
- ✅ System prompt explicitly names the payload-vs-contracts distinction so the agent doesn't accidentally replace the probe loop with docs reading.
- ✅ Tool description includes a concrete workflow (web_search → fetch_docs), not just "fetch a URL."
- ✅ Backward compat: purely additive. No existing tool, flow, or schema changes.

**2. Type consistency:**

- `ScrapeResult` (client-level) → `{ok: true, url, title, markdown}` (tool-level) — same fields under different names: `sourceUrl → url`, `markdown → markdown`, `title → title`. No drift; the mapping is in `execute`.
- `FirecrawlErrorCode` → tool-level error codes. `auth_failed → firecrawl_auth_failed`, `quota_exhausted → firecrawl_quota_exhausted`, `scrape_failed → scrape_failed`, plus a new `unreachable` for non-FirecrawlError throws. The `firecrawl_` prefix on the first two makes it clear to the agent where the failure originated (Firecrawl infra, not the target URL).

**3. Env / secrets hygiene:**

- `FIRECRAWL_API_KEY` added to `.dev.vars` (local dev) and `wrangler secret put` (prod) by the user in the Prerequisite step.
- `env.d.ts` regenerated via `npx wrangler types` picks up the new key.
- Tests use mocked fetchers + mocked scrape functions — no real Firecrawl calls in CI.
- Key never logged, never echoed in errors (the `auth_failed` message says "Firecrawl rejected the API key" without embedding the key itself).

---

## Future Work (noted, not planned here)

- **Response caching.** Identical URLs fetched twice hit Firecrawl twice. For a trial demo this is fine (< 50 fetches across the whole session). Production would want a short-lived module-level LRU keyed on URL, TTL of an hour or so.
- **Rate limiting / backoff.** Firecrawl's 402 (quota exhausted) returns a clean error today. A polite client would track recent auth_failed / quota_exhausted responses and back off before the next call. Skip for demo; noted for prod.
- **Crawl mode.** Firecrawl also supports recursive crawling (`/v2/crawl`). Useful if the agent needs to read a whole docs site. Not needed now — the agent can choose specific URLs one at a time.
- **PDF / non-HTML support.** Firecrawl handles PDFs via the same `/v2/scrape` endpoint. Our tool doesn't restrict by URL extension, so PDF URLs will work today if Firecrawl handles them. Untested; worth a note in the tool description if we confirm it works.
- **Context7 for framework docs.** Firecrawl handles scraped web docs (Stripe, GitHub, Linear). For library/framework docs (React's API, Prisma's schema DSL), Context7 MCP is probably better because the content is pre-chunked and indexed. Could be added as a complementary tool — `fetch_docs` for open-web pages, `query_library_docs` for known-library references. Not urgent for the integration-registration use case; the trial is webhook-centric.
- **Pagination for huge references.** If the agent fetches a 500KB page, it consumes a lot of output tokens. Consider adding an optional `max_chars` input that tells Firecrawl (or us, post-hoc) to truncate. For V1, let the agent manage its own budget by picking specific sub-pages.
