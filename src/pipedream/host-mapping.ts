/**
 * Static hostname → Pipedream app-slug lookup. Used by HttpGateway to
 * pick the user's connected account for an outbound request. Keys are
 * lowercase; callers lowercase the hostname before lookup.
 *
 * Linear is included — outbound Linear API calls route through
 * Pipedream just like every other app. The standalone Linear-specific
 * token path was removed in Phase D once agent-authored webhook
 * registration took over.
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
