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
