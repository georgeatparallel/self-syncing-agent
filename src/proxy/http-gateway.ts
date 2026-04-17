/**
 * HttpGateway — the credential-injection layer for facet-initiated
 * outbound requests.
 *
 * Facets are loaded with `globalOutbound: ctx.exports.HttpGateway({ props: { userId } })`.
 * Every `fetch()` and `connect()` from within a facet is intercepted by this
 * WorkerEntrypoint's `fetch()` method. We look at the target host, look up
 * the right credential from Worker env secrets, inject the Authorization
 * header, and forward. Unknown hosts are rejected with 403 — facet code
 * cannot reach the open internet.
 *
 * V1 supports only Linear (via OAuth access token from a Linear app we
 * registered for the demo). V2 (Pipedream Connect) replaces the switch
 * body with a per-user lookup against Pipedream, using this.ctx.props.userId.
 *
 * Testability: the class is a thin wrapper over `handleGatewayRequest`, a
 * pure async function that takes (request, env, props, forwarder). Unit
 * tests pass a mocked forwarder; no network is hit.
 */

import { WorkerEntrypoint } from "cloudflare:workers";

export interface HttpGatewayProps {
  /**
   * The user DO instance this facet belongs to. V1 ignores this (demo
   * workspace token is shared); V2 uses it to look up per-user Pipedream
   * credentials.
   */
  userId?: string;
}

type Forwarder = (request: Request) => Promise<Response>;

/**
 * Pure, testable core of the gateway. Takes an injectable forwarder so
 * tests can verify the transformed request without a network call.
 */
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
      headers.set("Authorization", `Bearer ${env.LINEAR_ACCESS_TOKEN}`);
      break;
    default:
      return new Response(
        JSON.stringify({
          error: "unknown_host",
          host: url.hostname,
          message:
            "HttpGateway rejected the request. Facet code can only reach hosts with configured credentials."
        }),
        {
          status: 403,
          headers: { "content-type": "application/json" }
        }
      );
  }

  // Forward with the transformed headers. We construct a new Request so
  // the original body/method/etc. are preserved but headers are replaced.
  const forwarded = new Request(request, { headers });
  return forwarder(forwarded);
}

/**
 * The WorkerEntrypoint class that facets see as `globalOutbound`. Calls
 * into `handleGatewayRequest` with env and ctx.props lifted from the
 * runtime-managed instance state.
 */
export class HttpGateway extends WorkerEntrypoint<Env, HttpGatewayProps> {
  async fetch(request: Request): Promise<Response> {
    return handleGatewayRequest(request, this.env, this.ctx.props);
  }
}
