/**
 * Shape of entries in public/pipedream-apps.json (refreshed by
 * scripts/refresh-pipedream-apps.ts). Mirrors Pipedream's
 * /v1/connect/apps response per-item shape, narrowed to the fields
 * the UI actually consumes.
 */
export interface AppEntry {
  name_slug: string;
  name: string;
  img_src: string;
  description: string | null;
  auth_type: "keys" | "oauth" | "none" | null;
  categories: string[];
  featured_weight: number;
}
