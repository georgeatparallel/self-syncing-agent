/**
 * HttpGateway — the credential-injection layer for facet-initiated
 * outbound requests.
 *
 * Facets are loaded with `globalOutbound: ctx.exports.HttpGateway({ props: { userId } })`.
 * Every `fetch()` and `connect()` from within a facet is intercepted by this
 * WorkerEntrypoint's `fetch()` method. We look at the target host, resolve
 * it to a Pipedream app slug, and forward through the Pipedream Connect
 * proxy using the user's connected account. Unknown hosts are rejected
 * with 403 — facet code cannot reach the open internet.
 *
 * Linear was historically routed via a hardcoded Authorization header
 * using `LINEAR_ACCESS_TOKEN`. Phase B migrates Linear onto the same
 * per-user Pipedream path as every other app. The env secret is still
 * referenced by `registerLinearWebhook` in `src/integrations/linear-api.ts`
 * (Phase D cleanup).
 *
 * Testability: the class is a thin wrapper over `handleGatewayRequest`, a
 * pure async function that takes (request, env, props, options). Tests
 * inject a mock forwarder + accountLookup; no network is hit.
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import { resolveAppSlug } from "../pipedream/host-mapping";
import { proxiedFetch } from "../pipedream/proxy";
import { getCachedAccessToken } from "../pipedream/token-cache";

export interface HttpGatewayProps {
  /**
   * The user DO instance this facet belongs to. Required to look up the
   * user's connected Pipedream account for the outbound host.
   */
  userId?: string;
}

type Forwarder = (request: Request) => Promise<Response>;

/**
 * Look up the user's connected Pipedream account_id for a given app slug,
 * or null if the user has not connected that app. Injected by the
 * `HttpGateway` WorkerEntrypoint (backed by the ChatAgent DO); tests pass
 * a mock.
 */
export type AccountLookup = (
  userId: string,
  appSlug: string
) => Promise<string | null>;

export interface HandleGatewayRequestOptions {
  forwarder?: Forwarder;
  accountLookup?: AccountLookup;
}

/**
 * Pure, testable core of the gateway. Takes injectable forwarder +
 * accountLookup so tests can verify the transformed request without a
 * network call and without a real DO.
 */
export async function handleGatewayRequest(
  request: Request,
  env: Env,
  props: HttpGatewayProps,
  options: HandleGatewayRequestOptions = {}
): Promise<Response> {
  const forwarder = options.forwarder ?? fetch;
  const url = new URL(request.url);
  const host = url.hostname.toLowerCase();

  // 1. Pipedream-routable host? (Linear included — no hardcoded branch.)
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

/**
 * The WorkerEntrypoint class that facets see as `globalOutbound`. Calls
 * into `handleGatewayRequest` with env and ctx.props lifted from the
 * runtime-managed instance state, wiring the real accountLookup against
 * the user's ChatAgent DO.
 */
export class HttpGateway extends WorkerEntrypoint<Env, HttpGatewayProps> {
  async fetch(request: Request): Promise<Response> {
    const accountLookup: AccountLookup = async (userId, appSlug) => {
      const stub = this.env.ChatAgent.get(
        this.env.ChatAgent.idFromName(userId)
      );
      return (
        stub as unknown as {
          getConnectedAccountId: (
            u: string,
            app: string
          ) => Promise<string | null>;
        }
      ).getConnectedAccountId(userId, appSlug);
    };
    return handleGatewayRequest(request, this.env, this.ctx.props, {
      accountLookup
    });
  }
}
