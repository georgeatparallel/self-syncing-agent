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
 * Pipedream's proxy rejects requests with these. Our own Authorization
 * header to Pipedream is set separately.
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
