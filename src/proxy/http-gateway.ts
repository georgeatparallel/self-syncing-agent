/**
 * HttpGateway — per-fetch credential-injection layer for facet-initiated
 * outbound requests.
 *
 * Facets and exec isolates are loaded with
 *   `globalOutbound: ctx.exports.HttpGateway({ props: { userId, syncId } })`.
 * Every `fetch()` from inside those isolates hits this WorkerEntrypoint's
 * `fetch()` method. At fetch time the gateway:
 *
 *   1. SSRF denylist (absolute floor — not overridable by agent, user, or
 *      downstream lookup). Rejects private IPs, loopback, cloud metadata,
 *      and `*.internal`/`*.local`.
 *   2. Reads the `X-Pd-App` header — agent-authored code sets this on each
 *      outbound fetch to name the Pipedream app slug whose credentials it
 *      wants injected.
 *   3. RPCs into the user's ChatAgent DO:
 *        resolveEgress(userId, syncId, host, appSlug)
 *      which reads *this* sync's `api_hosts` (single-row lookup by
 *      syncId — no cross-sync walk) and the user's connected_accounts
 *      row for appSlug. Returns either a resolved `accountId` or a
 *      typed error (sync_not_found, unknown_host, account_not_connected).
 *   4. `proxiedFetch` forwards through the Pipedream Connect proxy with
 *      that accountId. Upstream token injection is entirely Pipedream's
 *      job; we never see the user's upstream credentials.
 *
 * Design note — why props carry only {userId, syncId}: Worker Loader
 * caches bundles by codeId (`sync:<syncId>:v<version>`). Anything stamped
 * on props that can change without bumping `version` goes stale silently.
 * api_hosts and connected_accounts both mutate outside version bumps
 * (user connects a new app; agent updates the allowlist). The fix is to
 * read them live from the DO's sqlite on the fetch path via RPC — the
 * {userId, syncId} pair is stable across a sync's lifetime and is all
 * the gateway needs to locate the right row.
 *
 * Accepted residual: `X-Pd-App` is agent-set, and the agent's handler code
 * runs on attacker-controlled webhook payloads — so the header is
 * prompt-injectable. An attacker cannot exfiltrate to undeclared hosts
 * (api_hosts gates that pre-attacker), but CAN route a declared host
 * through the WRONG connected app's credentials. Damage ceiling is a
 * wrong-audience Bearer token rejected at the real target — no token or
 * user data reaches attacker infra. This is accepted in exchange for
 * cross-app flexibility (a handler for a Linear sync can still fetch
 * Slack with the user's Slack token by declaring `api.slack.com` up
 * front and setting `X-Pd-App: slack` at call time).
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import { isDeniedHost } from "../pipedream/app-hosts";
import { proxiedFetch } from "../pipedream/proxy";
import { getCachedAccessToken } from "../pipedream/token-cache";

/** Lowercase because `Headers.get()` is case-insensitive on read but the
 * constant makes the expected casing obvious to agents reading error
 * messages. */
export const X_PD_APP_HEADER = "x-pd-app";

export interface HttpGatewayProps {
  userId?: string;
  syncId?: string;
}

type Forwarder = (request: Request) => Promise<Response>;

/**
 * Injected by the real HttpGateway WorkerEntrypoint; tests pass a mock.
 * Calls the ChatAgent DO's `resolveEgress` method, which reads the sync
 * row and the user's connected_account row in one place.
 */
export type EgressLookup = (
  userId: string,
  syncId: string,
  host: string,
  appSlug: string
) => Promise<
  | { ok: true; accountId: string }
  | {
      ok: false;
      error: "sync_not_found" | "unknown_host" | "account_not_connected";
    }
>;

export interface HandleGatewayRequestOptions {
  forwarder?: Forwarder;
  egressLookup?: EgressLookup;
}

function forbid(error: string, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ error, ...extra }), {
    status: 403,
    headers: { "content-type": "application/json" }
  });
}

/**
 * Case-insensitive host match with dot-boundary suffix semantics.
 * `matchesHost(["myshopify.com"], "mystore.myshopify.com")` → true
 * `matchesHost(["myshopify.com"], "evilmyshopify.com")`    → false
 *
 * Enforcing the dot boundary is what keeps the suffix rule from turning
 * into a prefix-squatting attack (`evilmyshopify.com` has the substring
 * `myshopify.com` at the end but is not a subdomain of it).
 */
export function matchesHost(declared: string[], actual: string): boolean {
  const a = actual.toLowerCase();
  for (const d of declared) {
    const dl = d.toLowerCase();
    if (a === dl) return true;
    if (a.endsWith("." + dl)) return true;
  }
  return false;
}

/**
 * Pure, testable core of the gateway. Takes an injectable forwarder +
 * egressLookup so tests can verify the transformed request without a
 * network call and without a real DO. The WorkerEntrypoint's `fetch`
 * method below is a thin shim that wires the live `egressLookup` to
 * the user's ChatAgent DO and delegates here.
 */
export async function handleGatewayRequest(
  request: Request,
  env: Env,
  props: HttpGatewayProps,
  options: HandleGatewayRequestOptions = {}
): Promise<Response> {
  const forwarder = options.forwarder ?? fetch;
  // URL.hostname keeps IPv6 literals wrapped in brackets (e.g.
  // `[::1]`). `isDeniedHost` expects the bare literal; strip once at
  // the gateway boundary so both the denylist and the `matchesHost`
  // suffix rule see the same shape downstream.
  const host = new URL(request.url).hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "");

  // 1. SSRF denylist — runs before everything else. Nothing the agent,
  //    user, or DO can say overrides this.
  if (isDeniedHost(host)) {
    return forbid("denied_host", {
      host,
      message:
        "Host is on the SSRF denylist (private IP, loopback, cloud metadata, or *.internal/*.local)."
    });
  }

  // 2. Require the stamped user/sync context + a lookup. Missing any of
  //    these means the call site (probably a test or misconfigured
  //    caller) didn't wire the gateway end-to-end; fail closed.
  if (!props.userId || !props.syncId || !options.egressLookup) {
    return forbid("no_user_context", { host });
  }

  // 3. Read the agent's declared app slug for this fetch.
  const appSlug = request.headers.get(X_PD_APP_HEADER);
  if (!appSlug) {
    return forbid("missing_app_header", {
      host,
      message: `Set the ${X_PD_APP_HEADER} header on your fetch to one of the user's connected app slugs (see <connected_accounts> in your context).`
    });
  }

  // 4. DO RPC — reads sync's api_hosts and user's connected_account.
  const result = await options.egressLookup(
    props.userId,
    props.syncId,
    host,
    appSlug
  );
  if (!result.ok) {
    const msg = {
      sync_not_found: "Sync not found for syncId.",
      unknown_host:
        "Host is not in this sync's declared api_hosts. Declare it at create_sync or update via update_sync.",
      account_not_connected: `User has not connected a Pipedream account for app_slug="${appSlug}".`
    }[result.error];
    return forbid(result.error, { host, message: msg });
  }

  // 5. Forward through Pipedream with the resolved account.
  const accessToken = await getCachedAccessToken(env);
  return proxiedFetch({
    env,
    accessToken,
    accountId: result.accountId,
    externalUserId: props.userId,
    request,
    forwarder
  });
}

/**
 * WorkerEntrypoint facets see as `globalOutbound`. Wires the live
 * `egressLookup` to the user's ChatAgent DO via direct RPC and delegates
 * everything else to `handleGatewayRequest`.
 */
export class HttpGateway extends WorkerEntrypoint<Env, HttpGatewayProps> {
  async fetch(request: Request): Promise<Response> {
    const egressLookup: EgressLookup = async (
      userId,
      syncId,
      host,
      appSlug
    ) => {
      const stub = this.env.ChatAgent.get(
        this.env.ChatAgent.idFromName(userId)
      );
      return (
        stub as unknown as {
          resolveEgress: (
            u: string,
            s: string,
            h: string,
            a: string
          ) => ReturnType<EgressLookup>;
        }
      ).resolveEgress(userId, syncId, host, appSlug);
    };
    return handleGatewayRequest(request, this.env, this.ctx.props, {
      egressLookup
    });
  }
}
