/**
 * Linear GraphQL API helpers. Called by create_sync / delete_sync tools
 * from the supervisor DO — NOT by agent-authored facet handler code.
 * Uses env.LINEAR_ACCESS_TOKEN (OAuth access token from our demo app).
 *
 * For each mutation we hand-write the GraphQL query and types rather
 * than pulling in a Linear SDK, since we only need two endpoints and
 * no codegen setup is worth it for V1.
 */

const LINEAR_API_URL = "https://api.linear.app/graphql";

type GraphQLResponse<T> = {
  data?: T;
  errors?: Array<{ message: string; extensions?: Record<string, unknown> }>;
};

type WebhookCreateData = {
  webhookCreate: {
    success: boolean;
    webhook: {
      id: string;
      secret: string;
      enabled: boolean;
    };
  };
};

export interface RegisteredWebhook {
  id: string;
  secret: string;
  enabled: boolean;
}

/**
 * Register a webhook with Linear for the given resource types.
 * Returns the upstream webhook id + signing secret. Signing secret is
 * only returned on this initial registration — the caller must persist
 * it for later signature verification in Phase 09.
 *
 * Errors:
 *  - "linear_api_auth_failed" when LINEAR_ACCESS_TOKEN is invalid
 *  - "linear_api_error" with GraphQL error messages for any other failure
 *  - fetch-level errors propagate as-is (network failure, timeout)
 */
export async function registerLinearWebhook(
  accessToken: string,
  url: string,
  resourceTypes: string[],
  label: string,
  fetcher: typeof fetch = fetch
): Promise<RegisteredWebhook> {
  const query = /* GraphQL */ `
    mutation WebhookCreate(
      $url: String!
      $resourceTypes: [String!]!
      $label: String!
    ) {
      webhookCreate(
        input: {
          url: $url
          resourceTypes: $resourceTypes
          allPublicTeams: true
          label: $label
        }
      ) {
        success
        webhook {
          id
          secret
          enabled
        }
      }
    }
  `;
  const variables = { url, resourceTypes, label };

  const res = await fetcher(LINEAR_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify({ query, variables })
  });

  if (res.status === 401 || res.status === 403) {
    throw new LinearApiError(
      "linear_api_auth_failed",
      `Linear rejected the access token (HTTP ${res.status}).`
    );
  }

  const body = (await res.json()) as GraphQLResponse<WebhookCreateData>;
  if (body.errors && body.errors.length > 0) {
    throw new LinearApiError(
      "linear_api_error",
      body.errors.map((e) => e.message).join("; ")
    );
  }
  if (!body.data || !body.data.webhookCreate.success) {
    throw new LinearApiError(
      "linear_api_error",
      "webhookCreate returned success=false without explicit errors"
    );
  }

  const wh = body.data.webhookCreate.webhook;
  return { id: wh.id, secret: wh.secret, enabled: wh.enabled };
}

type WebhookDeleteData = {
  webhookDelete: { success: boolean };
};

/**
 * Unregister a webhook with Linear. Used by create_sync's rollback on
 * downstream failure, and by delete_sync (Phase 10). Best-effort:
 * returns void on success, throws on any non-success response.
 */
export async function unregisterLinearWebhook(
  accessToken: string,
  webhookId: string,
  fetcher: typeof fetch = fetch
): Promise<void> {
  const query = /* GraphQL */ `
    mutation WebhookDelete($id: String!) {
      webhookDelete(id: $id) {
        success
      }
    }
  `;
  const res = await fetcher(LINEAR_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify({ query, variables: { id: webhookId } })
  });
  const body = (await res.json()) as GraphQLResponse<WebhookDeleteData>;
  if (body.errors || !body.data?.webhookDelete.success) {
    throw new LinearApiError(
      "linear_api_error",
      `webhookDelete failed for ${webhookId}: ${body.errors?.map((e) => e.message).join("; ") ?? "unknown"}`
    );
  }
}

export class LinearApiError extends Error {
  constructor(
    public code: "linear_api_auth_failed" | "linear_api_error",
    message: string
  ) {
    super(message);
    this.name = "LinearApiError";
  }
}
