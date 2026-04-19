#!/usr/bin/env node
/**
 * Refresh public/pipedream-apps.json from Pipedream's Connect app API.
 *
 * Usage: pnpm refresh:apps
 *
 * Reads PIPEDREAM_CLIENT_ID and PIPEDREAM_CLIENT_SECRET from .dev.vars.
 * Writes the full app catalog as alphabetically-sorted JSON to
 * public/pipedream-apps.json. Run before a release or whenever a new
 * integration matters for a demo.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

interface AppEntry {
  name_slug: string;
  name: string;
  img_src: string;
  description: string | null;
  auth_type: "keys" | "oauth" | "none" | null;
  categories: string[];
  featured_weight: number;
}

function loadDotDevVars(): Record<string, string> {
  const path = resolve(process.cwd(), ".dev.vars");
  const content = readFileSync(path, "utf-8");
  const vars: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return vars;
}

async function fetchAccessToken(env: Record<string, string>): Promise<string> {
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
    throw new Error(`token fetch failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { access_token: string };
  return body.access_token;
}

async function walk(token: string): Promise<AppEntry[]> {
  const out: AppEntry[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 100; i++) {
    const url = new URL("https://api.pipedream.com/v1/connect/apps");
    if (cursor) url.searchParams.set("after", cursor);
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}` }
    });
    if (!res.ok) {
      throw new Error(
        `/v1/connect/apps page ${i} failed: ${res.status} ${await res.text()}`
      );
    }
    const body = (await res.json()) as {
      data: AppEntry[];
      page_info: { end_cursor: string | null };
    };
    out.push(...body.data);
    process.stderr.write(
      `  page ${i + 1}: +${body.data.length} apps (total ${out.length})\n`
    );
    if (!body.page_info.end_cursor) break;
    cursor = body.page_info.end_cursor;
  }
  return out;
}

async function main() {
  const env = loadDotDevVars();
  for (const key of [
    "PIPEDREAM_CLIENT_ID",
    "PIPEDREAM_CLIENT_SECRET"
  ] as const) {
    if (!env[key]) {
      throw new Error(`missing ${key} in .dev.vars`);
    }
  }
  process.stderr.write("minting access token…\n");
  const token = await fetchAccessToken(env);
  process.stderr.write("walking /v1/connect/apps…\n");
  const apps = await walk(token);
  const outPath = resolve(process.cwd(), "public/pipedream-apps.json");
  const sorted = apps.sort((a, b) => a.name.localeCompare(b.name));
  writeFileSync(outPath, JSON.stringify({ apps: sorted }, null, 2));
  process.stderr.write(`wrote ${sorted.length} apps to ${outPath}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
