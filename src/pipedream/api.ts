/**
 * Low-level Pipedream REST calls. No caching — see token-cache.ts for
 * the cached bearer access_token dance. Kept pure so unit tests can
 * mock `fetch` without touching cache state.
 *
 * Refs:
 * - POST /v1/oauth/token: https://pipedream.com/docs/rest-api/auth/#oauth
 * - POST /v1/connect/{projectId}/tokens: https://pipedream.com/docs/connect/managed-auth/tokens
 */

export interface AccessTokenResult {
  accessToken: string;
  expiresInSeconds: number;
}

export interface ConnectTokenResult {
  token: string;
  connectLinkUrl: string;
}

export async function getAccessToken(env: Env): Promise<AccessTokenResult> {
  const res = await fetch("https://api.pipedream.com/v1/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: env.PIPEDREAM_CLIENT_ID,
      client_secret: env.PIPEDREAM_CLIENT_SECRET
    })
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `Pipedream getAccessToken failed: ${res.status} ${res.statusText} — ${detail.slice(0, 200)}`
    );
  }
  const body = (await res.json()) as {
    access_token: string;
    expires_in: number;
  };
  return { accessToken: body.access_token, expiresInSeconds: body.expires_in };
}

export async function createConnectToken(
  env: Env,
  accessToken: string,
  externalUserId: string
): Promise<ConnectTokenResult> {
  const res = await fetch(
    `https://api.pipedream.com/v1/connect/${env.PIPEDREAM_PROJECT_ID}/tokens`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
        "X-PD-Environment": env.PIPEDREAM_ENVIRONMENT
      },
      body: JSON.stringify({ external_user_id: externalUserId })
    }
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `Pipedream createConnectToken failed: ${res.status} ${res.statusText} — ${detail.slice(0, 200)}`
    );
  }
  const body = (await res.json()) as {
    token: string;
    connect_link_url: string;
  };
  return { token: body.token, connectLinkUrl: body.connect_link_url };
}
