# Phase B: HttpGateway Through Pipedream Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teach `HttpGateway.handleGatewayRequest` (the facet's credential-injection proxy) how to route outbound calls through Pipedream Connect for hosts the user has connected via Phase A's flow. After this phase, a handler or sub-agent `fetch("https://api.github.com/...")` works end-to-end: gateway looks up the user's GitHub `account_id` from `connected_accounts`, builds a Pipedream proxy URL, forwards with auth injected.

**Architecture:**

- Linear migrates to Pipedream in this phase — the hardcoded `LINEAR_ACCESS_TOKEN` outbound path is removed. One code path for all integrations; matches the "zero per-integration supervisor code" thesis. Cost: user must click "Connect Linear" once in the Connections panel before handler/sub-agent outbound to `api.linear.app` works. Webhook delivery (incoming) is unaffected — that path uses the stored `webhook_secret` for signature verification, orthogonal to outbound auth. `LINEAR_ACCESS_TOKEN` env secret stays until Phase D (still used by `registerLinearWebhook`).
- A new hostname → Pipedream app-slug map handles the "which app does this URL belong to" lookup. Static, 6 entries for V1 (linear, github, slack, notion, google_sheets, google_drive).
- `handleGatewayRequest` gets one new parameter — an async `accountLookup: (userId, appSlug) => Promise<string | null>` capability. Real implementation RPCs into the user's `ChatAgent` DO via `env.ChatAgent.get(idFromName(userId)).getConnectedAccountId(...)`. Tests pass a mock.
- New `src/pipedream/proxy.ts` module exports `proxiedFetch(...)` — given a request + access token + account_id + userId, it constructs the Pipedream proxy URL (`/v1/connect/{project}/proxy/{base64(url)}?external_user_id=X&account_id=Y`), prefixes non-system headers with `x-pd-proxy-`, forwards with the bearer token, and returns the upstream response.
- New ChatAgent method `getConnectedAccountId(userId, appSlug)` wraps the existing `listConnectedAccounts` DB helper to return just the account_id for a specific app (or null if not connected).

**Tech Stack:** Cloudflare Workers, WorkerEntrypoint RPC into ChatAgent DO, raw `fetch` to Pipedream proxy endpoint, Vitest for unit tests.

**Branch:** `feat/pipedream` (continuing from Phase A).

---

## File Structure

**New files:**

- `src/pipedream/host-mapping.ts` — static map `HOST_TO_APP_SLUG: Record<string, string>` + `resolveAppSlug(hostname): string | null`.
- `src/pipedream/host-mapping.test.ts` — unit tests: known/unknown/case-insensitive hostname lookups.
- `src/pipedream/proxy.ts` — `proxiedFetch(args)` helper. Pure function, takes the original request + creds + forwarder, returns the upstream Response.
- `src/pipedream/proxy.test.ts` — unit tests: URL construction (base64-encoded target URL, query params), header translation (system headers stripped, others prefixed), body passthrough, method preservation.

**Modified files:**

- `src/pipedream/index.ts` — re-export `proxiedFetch`, `resolveAppSlug`.
- `src/server.ts` — add `ChatAgent.getConnectedAccountId(userId, appSlug): Promise<string | null>` method.
- `src/proxy/http-gateway.ts` — extend `handleGatewayRequest` signature with an `accountLookup` callback parameter. Inside: when hostname has a Pipedream mapping + user has connected the app, route through `proxiedFetch`. Existing Linear hardcoded path stays. Update `HttpGateway.fetch` to wire in the real account lookup via `env.ChatAgent`.
- `src/proxy/http-gateway.test.ts` — add new tests for the Pipedream path (mocking `accountLookup` + forwarder).

**No frontend changes.** Phase B is purely supervisor-side.

---

## Task 1: Host → app-slug mapping

**Files:**

- Create: `src/pipedream/host-mapping.ts`
- Create: `src/pipedream/host-mapping.test.ts`

**Context:** Tiny lookup module. A hostname like `api.github.com` maps to the Pipedream app slug `github`. Several apps share hosts (e.g., `sheets.googleapis.com` and `drive.googleapis.com` both belong to the user's Google account, but in Pipedream they're usually distinct slugs — keep them distinct in our map). **Linear IS included** — Phase B migrates Linear outbound to Pipedream too.

- [ ] **Step 1: Write the failing tests**

```ts
// src/pipedream/host-mapping.test.ts
import { describe, it, expect } from "vitest";
import { resolveAppSlug, HOST_TO_APP_SLUG } from "./host-mapping";

describe("resolveAppSlug", () => {
  it("maps api.github.com to github", () => {
    expect(resolveAppSlug("api.github.com")).toBe("github");
  });
  it("maps slack.com to slack", () => {
    expect(resolveAppSlug("slack.com")).toBe("slack");
  });
  it("maps api.notion.com to notion", () => {
    expect(resolveAppSlug("api.notion.com")).toBe("notion");
  });
  it("is case-insensitive on hostname", () => {
    expect(resolveAppSlug("API.GITHUB.COM")).toBe("github");
  });
  it("maps api.linear.app to linear", () => {
    expect(resolveAppSlug("api.linear.app")).toBe("linear");
  });
  it("returns null for unknown hosts", () => {
    expect(resolveAppSlug("example.com")).toBeNull();
  });
  it("HOST_TO_APP_SLUG exposes the full map", () => {
    expect(Object.keys(HOST_TO_APP_SLUG)).toEqual(
      Object.keys(HOST_TO_APP_SLUG).map((h) => h.toLowerCase())
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they FAIL**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npx vitest run src/pipedream/host-mapping.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write the implementation**

```ts
// src/pipedream/host-mapping.ts

/**
 * Static hostname → Pipedream app-slug lookup. Used by HttpGateway to
 * pick the user's connected account for an outbound request. Keys are
 * lowercase; callers lowercase the hostname before lookup.
 *
 * Linear is included — Phase B migrates outbound Linear API calls
 * through Pipedream too. LINEAR_ACCESS_TOKEN env secret survives in
 * the codebase for now (still used by the hardcoded
 * registerLinearWebhook in src/integrations/linear-api.ts); that
 * gets removed in Phase D.
 */
export const HOST_TO_APP_SLUG: Record<string, string> = {
  "api.linear.app": "linear",
  "api.github.com": "github",
  "slack.com": "slack",
  "api.notion.com": "notion",
  "sheets.googleapis.com": "google_sheets",
  "www.googleapis.com": "google_drive"
};

export function resolveAppSlug(hostname: string): string | null {
  return HOST_TO_APP_SLUG[hostname.toLowerCase()] ?? null;
}
```

- [ ] **Step 4: Run tests to verify they PASS**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npx vitest run src/pipedream/host-mapping.test.ts`
Expected: PASS (6/6).

- [ ] **Step 5: Commit**

```bash
git add src/pipedream/host-mapping.ts src/pipedream/host-mapping.test.ts
git commit -m "feat(pipedream): host→app-slug mapping for gateway routing"
```

---

## Task 2: `proxiedFetch` helper

**Files:**

- Create: `src/pipedream/proxy.ts`
- Create: `src/pipedream/proxy.test.ts`

**Context:** Given a `Request` destined for (say) `https://api.github.com/user/repos` + a Pipedream access token + an `account_id` + an `external_user_id`, construct and fire the Pipedream proxy call. Pure function taking an injectable `forwarder` for testability — defaults to the global `fetch`.

Pipedream proxy URL shape (from their docs):

```
POST https://api.pipedream.com/v1/connect/{project_id}/proxy/{url_safe_base64_encoded_url}?external_user_id={external_user_id}&account_id={account_id}
```

Headers:

- `Authorization: Bearer {access_token}` — our bearer, so Pipedream authenticates us.
- `X-PD-Environment: {env.PIPEDREAM_ENVIRONMENT}` — development or production namespace.
- Non-system headers from the original request are forwarded to the upstream via `x-pd-proxy-{original-header-name}`. System headers (`host`, `connection`, `cookie`, `authorization`, `content-length`, `transfer-encoding`) are stripped.

Method + body of the original request are passed as-is to Pipedream (which then passes them to the upstream with the `x-pd-proxy-*` headers flattened back to real headers).

- [ ] **Step 1: Write the failing tests**

```ts
// src/pipedream/proxy.test.ts
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

    // Decode the base64 segment and confirm it's the original URL.
    const encoded = sentUrl.pathname.split("/").pop()!;
    // URL-safe base64 → standard base64
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
          accept: "application/vnd.github+json",
          host: "api.github.com" // system header — must NOT be forwarded
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
    expect(sentReq.headers.get("x-pd-proxy-host")).toBeNull();
  });

  it("preserves method and body", async () => {
    const forwarder = vi
      .fn()
      .mockResolvedValue(new Response("ok", { status: 201 }));
    await proxiedFetch({
      env: makeEnv(),
      accessToken: "pd_access_abc",
      accountId: "apn_sl_1",
      externalUserId: "u",
      request: new Request("https://slack.com/api/chat.postMessage", {
        method: "POST",
        body: JSON.stringify({ channel: "C1", text: "hello" }),
        headers: { "content-type": "application/json" }
      }),
      forwarder
    });
    const sentReq = forwarder.mock.calls[0][0] as Request;
    expect(sentReq.method).toBe("POST");
    expect(await sentReq.text()).toBe(
      JSON.stringify({ channel: "C1", text: "hello" })
    );
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
```

- [ ] **Step 2: Run tests to verify they FAIL**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npx vitest run src/pipedream/proxy.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write the implementation**

```ts
// src/pipedream/proxy.ts

/**
 * Pipedream Connect API proxy — outbound-call credential injection.
 * Given the original request the handler/sub-agent made (e.g., to
 * api.github.com) plus a Pipedream access token + the user's account_id,
 * builds and fires the Pipedream proxy call. Pipedream injects the
 * user's stored credentials for that app and forwards to the upstream.
 *
 * Ref: https://pipedream.com/docs/connect/api-proxy
 */

interface ProxiedFetchArgs {
  env: Env;
  accessToken: string;
  accountId: string;
  externalUserId: string;
  request: Request;
  forwarder?: (req: Request) => Promise<Response>;
}

/**
 * Headers that must NOT be forwarded via the `x-pd-proxy-` prefix —
 * Pipedream's proxy rejects requests with these (per its docs). Our
 * own Authorization header to Pipedream is set separately.
 */
const SYSTEM_HEADERS = new Set([
  "host",
  "connection",
  "cookie",
  "authorization",
  "content-length",
  "transfer-encoding"
]);

function toUrlSafeBase64(s: string): string {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function proxiedFetch(args: ProxiedFetchArgs): Promise<Response> {
  const { env, accessToken, accountId, externalUserId, request } = args;
  const forwarder = args.forwarder ?? fetch;

  const encodedUrl = toUrlSafeBase64(request.url);
  const proxyUrl = new URL(
    `https://api.pipedream.com/v1/connect/${env.PIPEDREAM_PROJECT_ID}/proxy/${encodedUrl}`
  );
  proxyUrl.searchParams.set("external_user_id", externalUserId);
  proxyUrl.searchParams.set("account_id", accountId);

  const outgoingHeaders = new Headers({
    Authorization: `Bearer ${accessToken}`,
    "X-PD-Environment": env.PIPEDREAM_ENVIRONMENT
  });
  for (const [key, value] of request.headers.entries()) {
    if (SYSTEM_HEADERS.has(key.toLowerCase())) continue;
    outgoingHeaders.set(`x-pd-proxy-${key}`, value);
  }

  // Clone the body so we don't consume the caller's Request.
  const body = request.body ? await request.clone().arrayBuffer() : undefined;

  const outgoing = new Request(proxyUrl.toString(), {
    method: request.method,
    headers: outgoingHeaders,
    body
  });
  return forwarder(outgoing);
}
```

- [ ] **Step 4: Run tests to verify they PASS**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npx vitest run src/pipedream/proxy.test.ts`
Expected: PASS (5/5).

- [ ] **Step 5: Commit**

```bash
git add src/pipedream/proxy.ts src/pipedream/proxy.test.ts
git commit -m "feat(pipedream): proxiedFetch — build + fire Pipedream proxy URL"
```

---

## Task 3: `getConnectedAccountId` ChatAgent method

**Files:**

- Modify: `src/server.ts`

**Context:** HttpGateway (running in the supervisor worker's own isolate, not inside the user's DO) needs to ask: "for user X, is there a connected account for app slug Y?" The `connected_accounts` table lives in the user's ChatAgent DO — so we RPC in. Add a lean method returning just the `account_id` string or `null`.

- [ ] **Step 1: Add the method**

In `src/server.ts`, inside the `ChatAgent` class, near `listPipedreamAccounts`, add:

```ts
async getConnectedAccountId(
  userId: string,
  appSlug: string
): Promise<string | null> {
  await this.setName(userId);
  this.#ensureSchema();
  const rows = listConnectedAccounts(this.sql.bind(this), userId);
  const found = rows.find((r) => r.app_slug === appSlug);
  return found ? found.account_id : null;
}
```

Imports already cover `listConnectedAccounts` from Task 6 of Phase A — no new imports needed.

- [ ] **Step 2: Write a quick unit test**

Extend `tests/pipedream-routes.test.ts` (or add a focused test on the RPC method). Simplest: use the existing `runInDurableObject` pattern to drive the method directly. Example additional test inside the existing Pipedream test file (or its own file):

```ts
// Add inside the existing describe block in tests/pipedream-routes.test.ts
it("getConnectedAccountId returns account_id for connected app or null otherwise", async () => {
  const userId = crypto.randomUUID();
  // seed
  await SELF.fetch(`https://test/api/user/${userId}/pipedream/account`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app_slug: "github", account_id: "apn_gh_1" })
  });
  // lookup via direct RPC
  const { env } = await import("cloudflare:test");
  const stub = env.ChatAgent.get(env.ChatAgent.idFromName(userId));
  // @ts-expect-error — custom RPC method, widened for test usage
  const hit: string | null = await stub.getConnectedAccountId(userId, "github");
  expect(hit).toBe("apn_gh_1");
  // @ts-expect-error — same
  const miss: string | null = await stub.getConnectedAccountId(userId, "slack");
  expect(miss).toBeNull();
});
```

If `SELF.fetch` + direct RPC inside the same test doesn't play nicely (e.g., the DO instance diverges), use `runInDurableObject` as the existing DB tests do and call the method directly. Pick whichever pattern the codebase already uses for this kind of test.

- [ ] **Step 3: Run tests**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npx vitest run tests/pipedream-routes.test.ts`
Expected: PASS.

- [ ] **Step 4: Run full check**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npm run check`
Expected: fully green.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts tests/pipedream-routes.test.ts
git commit -m "feat(pipedream): getConnectedAccountId ChatAgent RPC method"
```

---

## Task 4: Wire Pipedream into `handleGatewayRequest`

**Files:**

- Modify: `src/proxy/http-gateway.ts`
- Modify: `src/proxy/http-gateway.test.ts`

**Context:** The central file. Remove the hardcoded `api.linear.app` case; everything with an entry in `HOST_TO_APP_SLUG` (Linear included) goes through the Pipedream path.

### Current shape (read first)

```ts
export async function handleGatewayRequest(
  request: Request,
  env: Env,
  _props: HttpGatewayProps,
  forwarder: Forwarder = fetch
): Promise<Response> {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  switch (url.hostname) {
    case "api.linear.app":
      headers.set("Authorization", linearAuthHeader(env.LINEAR_ACCESS_TOKEN));
      break;
    default:
      return new Response(
        JSON.stringify({ error: "unknown_host", host: url.hostname, ... }),
        { status: 403, ... }
      );
  }
  const forwarded = new Request(request, { headers });
  return forwarder(forwarded);
}
```

### New shape

```ts
export type AccountLookup = (
  userId: string,
  appSlug: string
) => Promise<string | null>;

export interface HandleGatewayRequestOptions {
  forwarder?: Forwarder;
  accountLookup?: AccountLookup;
}

export async function handleGatewayRequest(
  request: Request,
  env: Env,
  props: HttpGatewayProps,
  options: HandleGatewayRequestOptions = {}
): Promise<Response> {
  const forwarder = options.forwarder ?? fetch;
  const url = new URL(request.url);
  const host = url.hostname.toLowerCase();

  // 1. Pipedream-routable host?  (Linear included.)
  const appSlug = resolveAppSlug(host);
  if (appSlug && props.userId && options.accountLookup) {
    const accountId = await options.accountLookup(props.userId, appSlug);
    if (!accountId) {
      return new Response(
        JSON.stringify({
          error: "account_not_connected",
          host,
          app_slug: appSlug,
          message: `User has not connected ${appSlug} via Pipedream. Connect it in the Connections panel.`
        }),
        { status: 403, headers: { "content-type": "application/json" } }
      );
    }
    const accessToken = await getCachedAccessToken(env);
    return proxiedFetch({
      env,
      accessToken,
      accountId,
      externalUserId: props.userId,
      request,
      forwarder
    });
  }

  // 2. Unknown host — reject.
  return new Response(
    JSON.stringify({
      error: "unknown_host",
      host,
      message:
        "HttpGateway rejected the request. Connect the app via the Connections panel, or add a host mapping."
    }),
    { status: 403, headers: { "content-type": "application/json" } }
  );
}
```

**IMPORTANT**: this is a signature change (4th argument goes from `Forwarder` to `HandleGatewayRequestOptions`). ALL callers must update. Today the only caller is `HttpGateway.fetch` in the same file. Update that, and double-check via `grep -rn handleGatewayRequest src/` that no other usage exists.

### Update `HttpGateway.fetch` to inject the real accountLookup

```ts
export class HttpGateway extends WorkerEntrypoint<Env, HttpGatewayProps> {
  async fetch(request: Request): Promise<Response> {
    const accountLookup: AccountLookup = async (userId, appSlug) => {
      const stub = this.env.ChatAgent.get(
        this.env.ChatAgent.idFromName(userId)
      );
      // @ts-expect-error — custom RPC method typed on the ChatAgent class
      return stub.getConnectedAccountId(userId, appSlug);
    };
    return handleGatewayRequest(request, this.env, this.ctx.props, {
      accountLookup
    });
  }
}
```

### Update + extend the test file

Keep existing tests (unknown host 403, Linear path). Add four new ones:

```ts
describe("handleGatewayRequest — Pipedream routing", () => {
  it("returns 403 account_not_connected when user has no account for the app", async () => {
    const forwarder = vi.fn();
    const accountLookup = vi.fn().mockResolvedValue(null);
    const res = await handleGatewayRequest(
      new Request("https://api.github.com/user/repos"),
      makeEnv(),
      { userId: "u-1" },
      { forwarder, accountLookup }
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("account_not_connected");
    expect(forwarder).not.toHaveBeenCalled();
  });

  it("routes through Pipedream when user has a connected account", async () => {
    const forwarder = vi
      .fn()
      .mockResolvedValue(new Response("upstream data", { status: 200 }));
    const accountLookup = vi.fn().mockResolvedValue("apn_gh_1");

    // Also need to mock getCachedAccessToken. It's imported from ../pipedream;
    // mock that module.
    vi.mock("../pipedream", async () => {
      const actual =
        await vi.importActual<typeof import("../pipedream")>("../pipedream");
      return {
        ...actual,
        getCachedAccessToken: vi.fn().mockResolvedValue("pd_access_abc")
      };
    });

    const res = await handleGatewayRequest(
      new Request("https://api.github.com/user/repos"),
      makeEnv(),
      { userId: "u-1" },
      { forwarder, accountLookup }
    );
    expect(res.status).toBe(200);
    expect(accountLookup).toHaveBeenCalledWith("u-1", "github");
    expect(forwarder).toHaveBeenCalledTimes(1);
    const sentReq = forwarder.mock.calls[0][0] as Request;
    expect(sentReq.url).toContain("api.pipedream.com/v1/connect/");
    expect(sentReq.url).toContain("account_id=apn_gh_1");
    expect(sentReq.url).toContain("external_user_id=u-1");
  });

  it("routes api.linear.app through Pipedream (not hardcoded anymore)", async () => {
    const forwarder = vi
      .fn()
      .mockResolvedValue(new Response("ok", { status: 200 }));
    const accountLookup = vi.fn().mockResolvedValue("apn_linear_1");
    await handleGatewayRequest(
      new Request("https://api.linear.app/graphql", { method: "POST" }),
      makeEnv(),
      { userId: "u-1" },
      { forwarder, accountLookup }
    );
    expect(accountLookup).toHaveBeenCalledWith("u-1", "linear");
    const sentReq = forwarder.mock.calls[0][0] as Request;
    expect(sentReq.url).toContain("api.pipedream.com/v1/connect/");
    expect(sentReq.url).toContain("account_id=apn_linear_1");
  });

  it("rejects unknown hosts even when accountLookup is provided", async () => {
    const forwarder = vi.fn();
    const accountLookup = vi.fn();
    const res = await handleGatewayRequest(
      new Request("https://example.com/api"),
      makeEnv(),
      { userId: "u-1" },
      { forwarder, accountLookup }
    );
    expect(res.status).toBe(403);
    expect(accountLookup).not.toHaveBeenCalled();
    expect(forwarder).not.toHaveBeenCalled();
  });
});
```

(Adapt `makeEnv` to include the Pipedream fields; see existing test helpers in `src/proxy/http-gateway.test.ts` for the current shape.)

Also update any existing tests that called `handleGatewayRequest(request, env, props, forwarder)` with the positional `forwarder` arg to use the new `{forwarder}` object form.

- [ ] **Step 1: Update the exports, signature, and implementation per above**

- [ ] **Step 2: Update callers (`HttpGateway.fetch`)**

- [ ] **Step 3: Update + extend tests**

- [ ] **Step 4: Run tests**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npx vitest run src/proxy/http-gateway.test.ts`
Expected: PASS (all existing + 4 new).

- [ ] **Step 5: Run full check**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npm run check`
Expected: fully green.

- [ ] **Step 6: Commit**

```bash
git add src/proxy/http-gateway.ts src/proxy/http-gateway.test.ts
git commit -m "feat(pipedream): route connected-app outbound through proxy in HttpGateway"
```

---

## Task 5: Module barrel update

**Files:**

- Modify: `src/pipedream/index.ts`

Re-export `proxiedFetch` and `resolveAppSlug` for clean imports.

- [ ] **Step 1: Extend the barrel**

```ts
// src/pipedream/index.ts
export { getAccessToken, createConnectToken } from "./api";
export type { AccessTokenResult, ConnectTokenResult } from "./api";
export { getCachedAccessToken } from "./token-cache";
export { proxiedFetch } from "./proxy";
export { resolveAppSlug, HOST_TO_APP_SLUG } from "./host-mapping";
```

- [ ] **Step 2: Verify compile**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/pipedream/index.ts
git commit -m "feat(pipedream): extend module barrel with proxy + host-mapping"
```

---

## Task 6: Manual smoke test end-to-end

**Files:**

- None (manual verification)

**Context:** Prove that a handler or sub-agent calling e.g. `fetch("https://api.github.com/user/repos")` actually reaches GitHub via Pipedream with the user's injected token.

- [ ] **Step 1: Start dev server with Node 22**

Run (in a background terminal): `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npm run dev`

- [ ] **Step 2: Confirm GitHub is already connected**

From the Phase A smoke test, the user should already have `github apn_XXX` in their Connections panel. If not, connect it now via the UI.

- [ ] **Step 3: Use `run_in_sync` to hit GitHub via the gateway**

In the main chat, pick any existing sync (the Linear one is fine — we're just borrowing its facet runtime). Ask the agent:

> "Use run_in_sync on the linear-high-urgent-issues sync to call `fetch('https://api.github.com/user')` and return the response body."

The agent should author a tiny `runInSync` that calls `fetch(...)` and returns the parsed JSON. Approve when prompted.

Expected: the returned JSON is the GitHub user profile of the account the user connected in Phase A. Proves:

- Gateway recognized `api.github.com` → `github` slug.
- accountLookup found `apn_XXX` for this user.
- proxiedFetch built the Pipedream URL, fired with bearer auth.
- Pipedream injected the user's GitHub token and forwarded.
- Response bounced back through the exec isolate → tool result → agent.

- [ ] **Step 4: Alternative verification via `curl`**

If the chat-driven verification is flaky, hit the internal path directly from the facet via the `/run_in_sync` flow using whatever the existing run_in_sync test patterns use. Or, during a dev session, use `wrangler tail` + a real webhook to observe the path.

- [ ] **Step 5: Document the result**

If it works, push the branch and move to Phase C:

```bash
git push origin feat/pipedream
```

If it doesn't, capture the error (browser console, wrangler logs, or the returned tool result) and diagnose before moving on. Common failure modes:

- Pipedream account not fully approved for this app (check Pipedream dashboard).
- `X-PD-Environment` mismatch (development vs production) — we're on development.
- Upstream API returns an error because the user's grants were too narrow (e.g., they granted read-only but handler wants write). Not a gateway bug.

---

## Self-Review Checklist

**1. Spec coverage:**

- ✅ Unknown-host rejection preserved (`unknown_host` 403).
- ✅ Linear migrated to Pipedream path — no more hardcoded `api.linear.app` branch.
- ✅ Any Pipedream-mapped host + connected user routes through Pipedream.
- ✅ Missing-connection case returns informative 403.
- ✅ Integration point for the subagent/handler fetch is unchanged (`globalOutbound: HttpGateway` still the only interception point).

**2. Type consistency:**

- `AccountLookup` type defined in Task 4 and imported by `HttpGateway.fetch` — single canonical definition.
- `ProxiedFetchArgs` shape (Task 2) is consumed directly by `handleGatewayRequest` (Task 4), so any field name drift between them surfaces at tsc.
- Barrel re-exports don't introduce new names — just re-exports from the source modules (Task 5).

**3. Backward compat:**

- `handleGatewayRequest` signature changed from `(req, env, props, forwarder)` to `(req, env, props, options)`. This is a breaking change for any caller that passed `forwarder` positionally. Task 4 Step 2 explicitly updates the only known caller (`HttpGateway.fetch`). Any forgotten caller will surface in `npm run check`.

---

## Future Work (noted, not planned here)

- **Remove `LINEAR_ACCESS_TOKEN` env secret** (Phase D). Still used by `registerLinearWebhook` in `src/integrations/linear-api.ts` for the create_sync flow; Phase D replaces that with agent-authored webhook registration, at which point the env var can go.
- **Multi-account-per-app** (V2). Currently a user has one `account_id` per app. If someone wants two Slack workspaces, they'd need two accounts. Schema change: primary key becomes `(user_id, app_slug, account_id)` plus a `label` column for disambiguation.
- **Request timeout / Pipedream 30s limit.** Pipedream returns 504 if the upstream takes over 30s. We don't currently add our own abort signal — fine for demo; worth an `AbortController` with a 25s cutoff in production.
- **Response header passthrough.** Today the gateway returns whatever Pipedream returned. Pipedream may add its own headers (e.g., `x-pd-*`). Fine for demo; production might want to strip them.
