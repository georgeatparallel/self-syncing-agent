# Phase F: Google Auth + Agent-Declared Egress Allowlist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the last two hardcoded surfaces in the system by making them agent-authored — but only after locking down the trust boundary with real auth so that "agent-authored" doesn't mean "prompt-injection-authored."

Two deliverables, one plan:

1. **Google OAuth** replaces the localStorage-UUID userId. After this, the userId is a verified Google `sub` claim carried in an HMAC-signed session cookie. The current scheme's "copy someone's UUID, become them" impersonation vector goes away.
2. **Agent-declared egress allowlist** replaces the hardcoded `HOST_TO_APP_SLUG` map. `connected_accounts` and `syncs` each grow an `api_hosts TEXT` JSON column. At Pipedream-connect time, we pre-populate `connected_accounts.api_hosts` from a curated JSON catalog of ~20 well-known apps. At `create_sync` time, the agent can declare ADDITIONAL hosts its handler will call (for the long-tail integrations not in the catalog). The gateway walks the user's DB rows instead of a static TS enum, so adding a new integration requires zero supervisor code changes.

**Why both in one phase:** the thesis-pure answer to "no hardcoded host map" requires the agent to declare hosts, which requires trusting the agent's declarations, which requires trusting the prompt source, which requires real auth. They're coupled. Sequencing them separately makes no sense.

**Architecture:**

- **Auth:** Google Identity Services (GIS) browser library for the sign-in button. User clicks, Google popup returns a `credential` (an RS256-signed ID token JWT). Frontend POSTs it to `/api/auth/login`. Backend verifies the token against Google's JWKs (`https://www.googleapis.com/oauth2/v3/certs`) via the `jose` library, extracts the stable `sub` claim, issues an HMAC-signed session cookie containing `{sub, iat, exp}`. Cookie is `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800` (7 days). `userId = sub` throughout the system. `src/identity.ts` deprecated.
- **Route protection:** middleware that runs before any `/api/*` handler (except `/api/auth/*`). Reads the session cookie, verifies signature, extracts sub. If missing/tampered/expired → 401. Injects `userId` on the Hono context. Existing routes that accept `:userId` in the path (e.g., `/api/user/:userId/syncs-summary`) get a defense-in-depth check that the path userId matches the authenticated sub — this prevents a user from manually navigating to `/api/user/<other>/...` and pulling someone else's data. Webhook routes (`/webhook/:userId/:syncId`) stay unauth — they're called by upstreams, not users; authentication is via the per-sync signature.
- **Schema migration:** `connected_accounts.api_hosts TEXT NOT NULL DEFAULT '[]'` and `syncs.api_hosts TEXT NOT NULL DEFAULT '[]'`. Both hold JSON-encoded `string[]`. Agents SDK-style `ALTER TABLE ADD COLUMN` with `addColumnIfNotExists` guard.
- **Catalog:** new file `src/pipedream/app-hosts.json` — curated map `{appSlug: string[]}` with Tier 1+2 entries (GitHub, Linear, Stripe, Slack, Shopify, HubSpot, Intercom, Vercel, GitLab, Notion, PagerDuty, Sentry, Twilio, Typeform, Calendly, Mailgun, Zendesk, Jira Cloud, Bitbucket, ClickUp — ~20 apps). Loaded once at module init.
- **Populate at connect time:** when `persistPipedreamAccount` inserts a new `connected_accounts` row, look up `appHostsCatalog[app_slug]`; insert that as the initial `api_hosts`. If the slug isn't in the catalog, insert `[]` — user or agent can enrich later via update.
- **Agent declaration at `create_sync`:** `create_sync` gains an optional `api_hosts: z.array(z.string()).optional()` input. Agent drafts these based on its fetch_docs research. Supervisor persists on the sync row. Approval UI renders these prominently alongside handler_code.
- **Gateway egress resolution (new flow):** given an outbound request's hostname:
  1. **SSRF denylist (non-negotiable):** reject private IPs (127/8, 10/8, 172.16/12, 192.168/16, 169.254/16 covers AWS/GCP metadata), IPv6 loopback + ULA, `localhost`, `.internal`. 403 `denied_host` regardless of allowlist match.
  2. Load user's `connected_accounts` rows. For each row, check if hostname ∈ row's `api_hosts`. If match → use that row's `account_id`. Primary path.
  3. Load user's `syncs` rows. For each, check if hostname ∈ sync's `api_hosts`. If match → look up `connected_accounts WHERE app_slug = sync.integration`, use that account_id. Covers agent-declared hosts for long-tail apps where the user has connected the app but the catalog didn't know about this specific host.
  4. No match → 403 `unknown_host`.
- **HOST_TO_APP_SLUG deleted.** Its entries move into the JSON catalog.

**Tech Stack:** `jose` npm package (Workers-compatible JWT library, ~4KB), Google Identity Services browser library (loaded via `<script>`), Web Crypto for cookie HMAC, Hono for route middleware, Vitest with mocked fetchers for JWK retrieval + mocked crypto for cookie verification.

**Branch:** `feat/auth-and-allowlist` (new branch off `main`).

**Migration note (user-facing):** existing data (localStorage UUIDs, their DOs, their connected_accounts, their syncs) becomes unreachable after this phase. New userId = Google sub ≠ old UUID → different DO. For the trial demo this is fine (fresh slate is cleaner anyway). For production, a one-time "link your old UUID" flow could be added; out of scope here.

---

## Prerequisite (user action, not a task)

Before Task 1 starts, the user must:

1. **Create a Google OAuth client:**
   - Go to https://console.cloud.google.com/apis/credentials
   - "Create Credentials" → "OAuth client ID" → "Web application"
   - Authorized JavaScript origins: `http://localhost:5173` (dev) + `https://<prod-domain>` (prod worker URL)
   - Authorized redirect URIs: leave empty (GIS popup mode doesn't need them)
   - Copy the `client_id`.

2. **Generate a session secret:**
   ```bash
   openssl rand -base64 32
   ```

3. **Set both on dev + prod:**
   ```bash
   echo 'GOOGLE_CLIENT_ID=<paste>' >> .dev.vars
   echo 'SESSION_SECRET=<paste>' >> .dev.vars
   printf '%s' '<the-client-id>' | npx wrangler secret put GOOGLE_CLIENT_ID
   printf '%s' '<the-secret>' | npx wrangler secret put SESSION_SECRET
   npx wrangler types env.d.ts --include-runtime false
   ```

4. Confirm with implementer that both are in place before Task 1.

---

## File Structure

**New files:**

- `src/auth/session.ts` — cookie signing + verification. Pure functions: `signSession({sub, iat, exp}, secret)` → cookie string, `verifySession(cookieValue, secret)` → `{sub, iat, exp}` or throws. HMAC-SHA256 via Web Crypto.
- `src/auth/session.test.ts` — roundtrip, tampered payload, tampered signature, expired token.
- `src/auth/google.ts` — Google ID token verification. `verifyGoogleIdToken(token, clientId, fetcher?)` → `{sub, email}` or throws. Fetches JWKs from Google's endpoint (cached 1 hour, module-level), verifies RS256 via `jose`.
- `src/auth/google.test.ts` — happy path with mocked JWK fetcher + `jose.SignJWT` to construct a valid test token; wrong aud, wrong iss, expired, bad sig.
- `src/auth/middleware.ts` — Hono middleware `requireAuth(c, next)` that reads `self-syncing-agent:session` cookie, verifies via `verifySession`, puts `userId = sub` on `c.var.userId`, or returns 401. Plus `requireAuthAndUserIdMatch(c, next)` for routes that take `:userId` in the path (defense-in-depth check).
- `src/auth/middleware.test.ts` — no cookie → 401, bad cookie → 401, valid → passes and sets c.var.userId, path-userId-mismatch → 403.
- `src/pipedream/app-hosts.json` — catalog map `{appSlug: string[]}`. ~20 entries.
- `src/pipedream/app-hosts.ts` — typed loader. Exports `appHostsCatalog: ReadonlyMap<string, readonly string[]>` built from the JSON at module init + `getCatalogHosts(appSlug): readonly string[]` lookup. Also exports `SSRF_DENYLIST_PATTERNS` as precompiled regex / CIDR checks + `isDeniedHost(hostname): boolean`.
- `src/pipedream/app-hosts.test.ts` — catalog roundtrip for a few known slugs, SSRF denylist matches for private IPs / localhost / metadata endpoints, unknown slugs return empty array.
- `src/ui/GoogleSignIn.tsx` — loads GIS `<script>` once (idempotent), renders the Google sign-in button, on credential callback POSTs to `/api/auth/login`, handles redirect back into the app on success.
- `src/ui/useAuth.ts` — hook that checks `/api/auth/me` on mount, returns `{user: {sub, email} | null, loading, logout}`.

**Modified files:**

- `package.json` — add `jose` dep.
- `src/server.ts` — add routes: `POST /api/auth/login` (verify Google token, set cookie, return `{sub, email}`), `POST /api/auth/logout` (clear cookie), `GET /api/auth/me` (read cookie, return `{sub, email}` or 401). Wrap protected `/api/*` routes with `requireAuth`. Wrap `/api/user/:userId/*` routes with `requireAuthAndUserIdMatch`. Webhook route stays unauth. Update `persistPipedreamAccount` to look up `getCatalogHosts(app_slug)` and populate the new row's `api_hosts` field.
- `src/db/schema.ts` — add `ALTER TABLE connected_accounts ADD COLUMN api_hosts TEXT NOT NULL DEFAULT '[]'` and same for `syncs`. Guard with a helper `addColumnIfNotExists(sql, table, column, defSql)` that queries `pragma_table_info` and is idempotent.
- `src/db/types.ts` — add `api_hosts: string[]` to `ConnectedAccount` and `Sync` interfaces. Add JSON decode at read sites.
- `src/db/connected-accounts.ts` — `upsertConnectedAccount` now accepts + persists `api_hosts`. `listConnectedAccounts` decodes JSON.
- `src/db/syncs.ts` — same pattern for `createSync`, `listSyncs`, `getSyncById`. Decode JSON.
- `src/proxy/http-gateway.ts` — new `resolveAccountIdForHost(env, userId, hostname): Promise<{accountId, appSlug} | null>` that walks the DB as described in Architecture. Replace the `resolveAppSlug` static lookup. Wire SSRF denylist as first check. Add explicit 403 shape for `denied_host`.
- `src/pipedream/host-mapping.ts` — **DELETED.** Its 6 entries move into `app-hosts.json`.
- `src/pipedream/index.ts` — remove `resolveAppSlug, HOST_TO_APP_SLUG` exports; add `appHostsCatalog, getCatalogHosts, isDeniedHost` exports from `app-hosts.ts`.
- `src/agent/tools/write/create-sync.ts` — add optional `api_hosts` input (`z.array(z.string()).optional()`). Persist on the sync row. Tool description documents the declaration with an example and payload-vs-contracts guardrail reminder.
- `src/agent/tools/write/update-sync.ts` — add optional `api_hosts` input so agents can amend declarations post-hoc without delete+recreate.
- `src/agent/system-prompt.ts` — new bullet under "## Creating a sync": declare your api_hosts at create_sync. Reference fetch_docs for discovery.
- `src/identity.ts` — **DELETED.** Client-side userId minting is replaced by the auth system.
- `src/ui/App.tsx` (or wherever the top-level user resolution happens) — remove `getOrMintUserId()` / `userIdFromPath` calls. Wrap the app in an auth gate: if `useAuth().user === null`, render `<GoogleSignIn />`; else render the normal app with `userId = user.sub`.
- `src/ui/useConnections.ts`, `src/ui/useSyncsSummary.ts`, `src/ui/useSyncDetails.ts` — no longer take `userId` as an arg; URL path either stays `/api/user/:userId/...` (middleware enforces match) or simplifies to `/api/me/...`. For minimal refactor, keep the existing URL pattern and let the hook read userId from the auth context.
- `src/ui/ConnectionsPanel.tsx` — same: reads `userId` from auth context.
- `.dev.vars.example` — add `GOOGLE_CLIENT_ID=...`, `SESSION_SECRET=...`.
- `README.md` — (brief) note that the app now requires Google sign-in; migration note about old syncs.

**Deleted files:**

- `src/identity.ts`
- `src/identity.test.ts`
- `src/pipedream/host-mapping.ts`
- `src/pipedream/host-mapping.test.ts` (entries migrate into `app-hosts.test.ts`)

---

## Task 1: Google ID token verification + session cookie primitives

**Files:**

- Create: `src/auth/google.ts`, `src/auth/google.test.ts`
- Create: `src/auth/session.ts`, `src/auth/session.test.ts`
- Modify: `package.json` (add `jose`)

**Context:** Two pure-function modules. `google.ts` verifies Google-minted ID tokens. `session.ts` signs and verifies our own session cookies. Both are 100% testable without any Hono / Worker wiring.

**Google token verification** — `verifyGoogleIdToken(token, clientId, fetcher?)` does:
1. Parse the JWT header to get `kid`.
2. Fetch Google's JWK Set from `https://www.googleapis.com/oauth2/v3/certs` (cache in a module-level `Map<kid, CryptoKey>`; cache refresh if kid not found → refetch once; TTL via the response's `Cache-Control: max-age` header).
3. Find the matching JWK, use `jose.importJWK` to get a `CryptoKey`.
4. `jose.jwtVerify(token, key, { issuer: ["https://accounts.google.com", "accounts.google.com"], audience: clientId })`.
5. Validate `exp > now` (jose does this).
6. Return `{sub, email}`.

Errors throw with distinct messages for wrong aud / wrong iss / expired / bad sig / network-failure-on-JWK-fetch.

**Session cookie** — HMAC-SHA256 signed JSON.

Format: `base64url(JSON.stringify({sub, iat, exp})) + "." + base64url(HMAC-SHA256(payload, secret))`.

No JWT header overhead — we control both sides, a plain HMAC-signed payload is simpler and cheaper to verify. `signSession({sub, iat, exp}, secret) → cookieValue`. `verifySession(cookieValue, secret) → {sub, iat, exp}` or throws `"tampered" | "expired" | "malformed"`.

- [ ] **Step 1: Install `jose`**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npm install jose
```

Verify it lands in package.json + pnpm-lock.yaml.

- [ ] **Step 2: Write failing tests for `session.ts`**

```ts
// src/auth/session.test.ts
import { describe, it, expect } from "vitest";
import { signSession, verifySession } from "./session";

const SECRET = "test-secret-32-bytes-long-abcdefgh";

describe("session cookie", () => {
  it("roundtrip: sign then verify returns the same payload", async () => {
    const now = Math.floor(Date.now() / 1000);
    const cookie = await signSession(
      { sub: "user-123", iat: now, exp: now + 3600 },
      SECRET
    );
    const decoded = await verifySession(cookie, SECRET);
    expect(decoded).toEqual({ sub: "user-123", iat: now, exp: now + 3600 });
  });

  it("rejects a tampered payload", async () => {
    const now = Math.floor(Date.now() / 1000);
    const cookie = await signSession(
      { sub: "user-123", iat: now, exp: now + 3600 },
      SECRET
    );
    const [payload, sig] = cookie.split(".");
    // Flip a byte in the payload.
    const tampered = payload.slice(0, -1) + "X" + "." + sig;
    await expect(verifySession(tampered, SECRET)).rejects.toThrow(/tampered/);
  });

  it("rejects a tampered signature", async () => {
    const now = Math.floor(Date.now() / 1000);
    const cookie = await signSession(
      { sub: "user-123", iat: now, exp: now + 3600 },
      SECRET
    );
    const [payload] = cookie.split(".");
    const bogus = payload + ".aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    await expect(verifySession(bogus, SECRET)).rejects.toThrow(/tampered/);
  });

  it("rejects an expired token", async () => {
    const now = Math.floor(Date.now() / 1000);
    const cookie = await signSession(
      { sub: "user-123", iat: now - 7200, exp: now - 3600 },
      SECRET
    );
    await expect(verifySession(cookie, SECRET)).rejects.toThrow(/expired/);
  });

  it("rejects malformed input", async () => {
    await expect(verifySession("not-a-cookie", SECRET)).rejects.toThrow(
      /malformed/
    );
    await expect(verifySession("", SECRET)).rejects.toThrow(/malformed/);
  });
});
```

- [ ] **Step 3: Implement `session.ts`**

```ts
// src/auth/session.ts

export interface SessionPayload {
  sub: string;
  iat: number;
  exp: number;
}

const te = new TextEncoder();
const td = new TextDecoder();

function base64urlEncode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64urlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacSha256(payloadBytes: Uint8Array, secret: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    te.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, payloadBytes);
  return new Uint8Array(sig);
}

export async function signSession(payload: SessionPayload, secret: string): Promise<string> {
  const payloadJson = JSON.stringify(payload);
  const payloadBytes = te.encode(payloadJson);
  const payloadB64 = base64urlEncode(payloadBytes);
  const sig = await hmacSha256(payloadBytes, secret);
  return payloadB64 + "." + base64urlEncode(sig);
}

export async function verifySession(cookie: string, secret: string): Promise<SessionPayload> {
  const parts = cookie.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error("session malformed");
  }
  const payloadBytes = base64urlDecode(parts[0]);
  const claimedSig = base64urlDecode(parts[1]);
  const expectedSig = await hmacSha256(payloadBytes, secret);
  if (!timingSafeEqual(claimedSig, expectedSig)) {
    throw new Error("session tampered");
  }
  let payload: SessionPayload;
  try {
    payload = JSON.parse(td.decode(payloadBytes));
  } catch {
    throw new Error("session malformed");
  }
  if (typeof payload.sub !== "string" || typeof payload.exp !== "number") {
    throw new Error("session malformed");
  }
  if (payload.exp <= Math.floor(Date.now() / 1000)) {
    throw new Error("session expired");
  }
  return payload;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
```

- [ ] **Step 4: Run session tests — PASS**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npx vitest run src/auth/session.test.ts`
Expected: PASS (5/5).

- [ ] **Step 5: Write failing tests for `google.ts`**

```ts
// src/auth/google.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SignJWT, generateKeyPair, exportJWK } from "jose";
import { verifyGoogleIdToken, _clearJwkCacheForTests } from "./google";

const CLIENT_ID = "test-client-id";

async function mintGoogleToken(
  privateKey: CryptoKey,
  kid: string,
  overrides: { aud?: string; iss?: string; exp?: number; sub?: string; email?: string } = {}
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({
    email: overrides.email ?? "test@example.com"
  })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuedAt(now)
    .setIssuer(overrides.iss ?? "https://accounts.google.com")
    .setAudience(overrides.aud ?? CLIENT_ID)
    .setSubject(overrides.sub ?? "google-sub-123")
    .setExpirationTime(overrides.exp ?? now + 3600)
    .sign(privateKey);
}

function makeJwkFetcher(publicJwk: unknown, kid: string) {
  return vi.fn(
    async () =>
      new Response(
        JSON.stringify({ keys: [{ ...(publicJwk as object), kid, alg: "RS256", use: "sig" }] }),
        { status: 200, headers: { "cache-control": "max-age=3600" } }
      )
  );
}

describe("verifyGoogleIdToken", () => {
  beforeEach(() => _clearJwkCacheForTests());

  it("returns {sub, email} on a valid token", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const kid = "kid-1";
    const jwk = await exportJWK(publicKey);
    const token = await mintGoogleToken(privateKey, kid);
    const fetcher = makeJwkFetcher(jwk, kid);
    const result = await verifyGoogleIdToken(token, CLIENT_ID, fetcher as unknown as typeof fetch);
    expect(result).toEqual({ sub: "google-sub-123", email: "test@example.com" });
  });

  it("rejects a token with wrong audience", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const kid = "kid-1";
    const jwk = await exportJWK(publicKey);
    const token = await mintGoogleToken(privateKey, kid, { aud: "other-client" });
    const fetcher = makeJwkFetcher(jwk, kid);
    await expect(
      verifyGoogleIdToken(token, CLIENT_ID, fetcher as unknown as typeof fetch)
    ).rejects.toThrow();
  });

  it("rejects a token with wrong issuer", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const kid = "kid-1";
    const jwk = await exportJWK(publicKey);
    const token = await mintGoogleToken(privateKey, kid, { iss: "https://evil.com" });
    const fetcher = makeJwkFetcher(jwk, kid);
    await expect(
      verifyGoogleIdToken(token, CLIENT_ID, fetcher as unknown as typeof fetch)
    ).rejects.toThrow();
  });

  it("rejects an expired token", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const kid = "kid-1";
    const jwk = await exportJWK(publicKey);
    const now = Math.floor(Date.now() / 1000);
    const token = await mintGoogleToken(privateKey, kid, { exp: now - 3600 });
    const fetcher = makeJwkFetcher(jwk, kid);
    await expect(
      verifyGoogleIdToken(token, CLIENT_ID, fetcher as unknown as typeof fetch)
    ).rejects.toThrow();
  });

  it("rejects a token signed with a different key (bad sig)", async () => {
    const { privateKey: wrongKey } = await generateKeyPair("RS256");
    const { publicKey } = await generateKeyPair("RS256");
    const kid = "kid-1";
    const publicJwk = await exportJWK(publicKey);
    const token = await mintGoogleToken(wrongKey, kid);
    const fetcher = makeJwkFetcher(publicJwk, kid);
    await expect(
      verifyGoogleIdToken(token, CLIENT_ID, fetcher as unknown as typeof fetch)
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 6: Implement `google.ts`**

```ts
// src/auth/google.ts
import { jwtVerify, importJWK, type JWK } from "jose";

const JWK_URL = "https://www.googleapis.com/oauth2/v3/certs";

interface CachedKey {
  key: CryptoKey;
  expiresAt: number;
}
const jwkCache = new Map<string, CachedKey>();

/** Test hatch: clear the JWK cache between tests. */
export function _clearJwkCacheForTests(): void {
  jwkCache.clear();
}

async function fetchJwks(fetcher: typeof fetch): Promise<{ keys: JWK[]; ttlSeconds: number }> {
  const res = await fetcher(JWK_URL);
  if (!res.ok) throw new Error(`Google JWK fetch failed: ${res.status}`);
  const body = (await res.json()) as { keys: JWK[] };
  const cacheControl = res.headers.get("cache-control") ?? "";
  const maxAgeMatch = cacheControl.match(/max-age=(\d+)/);
  const ttlSeconds = maxAgeMatch ? Number(maxAgeMatch[1]) : 3600;
  return { keys: body.keys, ttlSeconds };
}

async function getKey(kid: string, fetcher: typeof fetch): Promise<CryptoKey> {
  const now = Math.floor(Date.now() / 1000);
  const cached = jwkCache.get(kid);
  if (cached && cached.expiresAt > now) return cached.key;

  const { keys, ttlSeconds } = await fetchJwks(fetcher);
  for (const jwk of keys) {
    if (!jwk.kid) continue;
    const key = (await importJWK(jwk, jwk.alg ?? "RS256")) as CryptoKey;
    jwkCache.set(jwk.kid, { key, expiresAt: now + ttlSeconds });
  }
  const refreshed = jwkCache.get(kid);
  if (!refreshed) throw new Error(`Google JWK kid ${kid} not found`);
  return refreshed.key;
}

export async function verifyGoogleIdToken(
  token: string,
  clientId: string,
  fetcher: typeof fetch = fetch
): Promise<{ sub: string; email: string }> {
  // Parse header to find kid without verifying yet.
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Google token malformed");
  const header = JSON.parse(
    new TextDecoder().decode(
      Uint8Array.from(atob(parts[0].replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))
    )
  ) as { kid?: string; alg?: string };
  if (!header.kid) throw new Error("Google token missing kid");

  const key = await getKey(header.kid, fetcher);

  const { payload } = await jwtVerify(token, key, {
    issuer: ["https://accounts.google.com", "accounts.google.com"],
    audience: clientId
  });

  const sub = payload.sub;
  const email = (payload as { email?: string }).email;
  if (typeof sub !== "string" || !sub) throw new Error("Google token missing sub");
  if (typeof email !== "string") throw new Error("Google token missing email");
  return { sub, email };
}
```

- [ ] **Step 7: Run google tests — PASS**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npx vitest run src/auth/google.test.ts`
Expected: PASS (5/5).

- [ ] **Step 8: Run full check**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npm run check`
Expected: fully green (no routes wired up yet, so this is pure-module-land).

- [ ] **Step 9: Commit**

```bash
git add src/auth/session.ts src/auth/session.test.ts src/auth/google.ts src/auth/google.test.ts package.json pnpm-lock.yaml
git commit -m "feat(auth): Google ID token verification + HMAC session cookies"
```

---

## Task 2: Auth middleware + /api/auth/* routes + wire protection

**Files:**

- Create: `src/auth/middleware.ts`, `src/auth/middleware.test.ts`
- Modify: `src/server.ts` (add auth routes + protect existing ones)

**Context:** This task lands the auth on the server side, end-to-end. After Task 2, a user hitting `/api/user/<anyone>/syncs-summary` without a valid cookie gets 401. With a valid cookie whose sub ≠ URL-userId → 403. With a matching cookie → passes through. Frontend changes are in Task 5.

### Routes to add

- `POST /api/auth/login` — body `{credential: string}` (the Google ID token). Calls `verifyGoogleIdToken`, signs a session cookie, returns `{sub, email}` with `Set-Cookie`.
- `POST /api/auth/logout` — clears the cookie (`Set-Cookie: self-syncing-agent:session=; Max-Age=0; ...`). Returns 204.
- `GET /api/auth/me` — reads cookie, verifies, returns `{sub, email}` or 401. (We don't have `email` in the cookie, only `sub` — so include email in the cookie payload too, or re-fetch from a cached map. Simpler: add `email` to the `SessionPayload` and store it signed. Update `session.ts` + tests from Task 1 if needed.)

Small amendment: update `SessionPayload` from Task 1 to `{sub: string; email: string; iat: number; exp: number}`. The signSession/verifySession impl is unchanged structurally.

### Middleware

`requireAuth(c, next)` reads the cookie via `getCookie(c, "self-syncing-agent:session")` (from `hono/cookie`), calls `verifySession`, sets `c.set("userId", payload.sub)` and `c.set("email", payload.email)`, then `await next()`. On any verification error, returns `401 {error: "unauthenticated"}`.

`requireAuthAndUserIdMatch(c, next)` — first runs requireAuth's logic, then reads `c.req.param("userId")` and checks it equals `c.var.userId`. If mismatch → `403 {error: "user_id_mismatch"}`.

### Route wiring

All `/api/*` except `/api/auth/*` get middleware. The existing pattern:

```ts
app.get("/api/user/:userId/syncs-summary", async (c) => { ... });
```

becomes:

```ts
app.get("/api/user/:userId/syncs-summary", requireAuthAndUserIdMatch, async (c) => { ... });
```

Wrap all 5 existing `/api/user/:userId/*` routes. The `/webhook/:userId/:syncId` routes stay OPEN (unauth).

- [ ] **Step 1: Update `SessionPayload` shape**

Amend `src/auth/session.ts` to include `email: string` in the payload. Update Task 1 tests to pass `email`. Re-run Task 1 tests to confirm still green.

- [ ] **Step 2: Write middleware tests**

```ts
// src/auth/middleware.test.ts
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { requireAuth, requireAuthAndUserIdMatch } from "./middleware";
import { signSession } from "./session";

const SECRET = "test-secret-32-bytes-long-abcdefgh";

function makeApp() {
  const app = new Hono<{ Bindings: { SESSION_SECRET: string } }>();
  app.get("/protected", requireAuth, (c) =>
    c.json({ userId: c.var.userId, email: c.var.email })
  );
  app.get("/user/:userId/resource", requireAuthAndUserIdMatch, (c) =>
    c.json({ userId: c.var.userId })
  );
  return app;
}

async function cookieHeader(sub: string, email: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const value = await signSession({ sub, email, iat: now, exp: now + 3600 }, SECRET);
  return `self-syncing-agent:session=${value}`;
}

describe("auth middleware", () => {
  it("requireAuth: 401 without cookie", async () => {
    const app = makeApp();
    const res = await app.request("/protected", {}, { SESSION_SECRET: SECRET });
    expect(res.status).toBe(401);
  });

  it("requireAuth: 401 with tampered cookie", async () => {
    const app = makeApp();
    const res = await app.request(
      "/protected",
      { headers: { cookie: "self-syncing-agent:session=garbage.garbage" } },
      { SESSION_SECRET: SECRET }
    );
    expect(res.status).toBe(401);
  });

  it("requireAuth: 200 with valid cookie + sets userId on c.var", async () => {
    const app = makeApp();
    const res = await app.request(
      "/protected",
      { headers: { cookie: await cookieHeader("user-123", "user@example.com") } },
      { SESSION_SECRET: SECRET }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: "user-123", email: "user@example.com" });
  });

  it("requireAuthAndUserIdMatch: 403 when path userId differs from cookie sub", async () => {
    const app = makeApp();
    const res = await app.request(
      "/user/user-999/resource",
      { headers: { cookie: await cookieHeader("user-123", "u@e.com") } },
      { SESSION_SECRET: SECRET }
    );
    expect(res.status).toBe(403);
  });

  it("requireAuthAndUserIdMatch: 200 when path userId matches", async () => {
    const app = makeApp();
    const res = await app.request(
      "/user/user-123/resource",
      { headers: { cookie: await cookieHeader("user-123", "u@e.com") } },
      { SESSION_SECRET: SECRET }
    );
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 3: Implement middleware**

```ts
// src/auth/middleware.ts
import { createMiddleware } from "hono/factory";
import { getCookie } from "hono/cookie";
import { verifySession } from "./session";

export const SESSION_COOKIE_NAME = "self-syncing-agent:session";

type AuthedEnv = {
  Bindings: { SESSION_SECRET: string };
  Variables: { userId: string; email: string };
};

export const requireAuth = createMiddleware<AuthedEnv>(async (c, next) => {
  const raw = getCookie(c, SESSION_COOKIE_NAME);
  if (!raw) return c.json({ error: "unauthenticated" }, 401);
  try {
    const payload = await verifySession(raw, c.env.SESSION_SECRET);
    c.set("userId", payload.sub);
    c.set("email", payload.email);
  } catch {
    return c.json({ error: "unauthenticated" }, 401);
  }
  await next();
});

export const requireAuthAndUserIdMatch = createMiddleware<AuthedEnv>(async (c, next) => {
  const raw = getCookie(c, SESSION_COOKIE_NAME);
  if (!raw) return c.json({ error: "unauthenticated" }, 401);
  try {
    const payload = await verifySession(raw, c.env.SESSION_SECRET);
    const pathUserId = c.req.param("userId");
    if (pathUserId && pathUserId !== payload.sub) {
      return c.json({ error: "user_id_mismatch" }, 403);
    }
    c.set("userId", payload.sub);
    c.set("email", payload.email);
  } catch {
    return c.json({ error: "unauthenticated" }, 401);
  }
  await next();
});
```

- [ ] **Step 4: Wire auth routes in server.ts**

Add at the top of the Hono app registration (BEFORE any other routes):

```ts
import { setCookie, deleteCookie } from "hono/cookie";
import { verifyGoogleIdToken } from "./auth/google";
import { signSession, verifySession } from "./auth/session";
import { SESSION_COOKIE_NAME, requireAuth, requireAuthAndUserIdMatch } from "./auth/middleware";

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

app.post("/api/auth/login", async (c) => {
  const body = (await c.req.json()) as { credential?: string };
  if (!body.credential) return c.json({ error: "missing_credential" }, 400);
  try {
    const { sub, email } = await verifyGoogleIdToken(body.credential, c.env.GOOGLE_CLIENT_ID);
    const now = Math.floor(Date.now() / 1000);
    const cookie = await signSession(
      { sub, email, iat: now, exp: now + SESSION_TTL_SECONDS },
      c.env.SESSION_SECRET
    );
    setCookie(c, SESSION_COOKIE_NAME, cookie, {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/",
      maxAge: SESSION_TTL_SECONDS
    });
    return c.json({ sub, email });
  } catch (e) {
    return c.json(
      { error: "invalid_credential", detail: e instanceof Error ? e.message : String(e) },
      401
    );
  }
});

app.post("/api/auth/logout", (c) => {
  deleteCookie(c, SESSION_COOKIE_NAME, { path: "/" });
  return new Response(null, { status: 204 });
});

app.get("/api/auth/me", requireAuth, (c) =>
  c.json({ sub: c.var.userId, email: c.var.email })
);
```

- [ ] **Step 5: Protect existing routes**

Find each existing `app.{get|post}("/api/user/:userId/...")` in `server.ts` and add `requireAuthAndUserIdMatch` as the second argument (before the handler). Five routes:

- `GET /api/user/:userId/syncs-summary`
- `GET /api/user/:userId/syncs/:syncId/details`
- `POST /api/user/:userId/pipedream/token`
- `POST /api/user/:userId/pipedream/account`
- `GET /api/user/:userId/pipedream/accounts`

**Do NOT protect** `POST /webhook/:userId/:syncId` — upstreams hit it directly.

Also add `SESSION_SECRET` + `GOOGLE_CLIENT_ID` to the `Env` type if they're not already there (should be after user ran `wrangler types` in the prereq step).

- [ ] **Step 6: Run tests**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npx vitest run src/auth/
```

Expected: PASS.

- [ ] **Step 7: Run full check**

Existing integration tests (e.g., `tests/pipedream-routes.test.ts`) that hit `/api/user/:userId/pipedream/*` WITHOUT a cookie will now fail with 401. Update those tests to pass a cookie — seed a session via the same helper the middleware tests use. This is the biggest scope surprise; budget ~30 min for test updates.

`PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npm run check`
Expected: fully green after test updates.

- [ ] **Step 8: Commit**

```bash
git add src/auth/middleware.ts src/auth/middleware.test.ts src/server.ts tests/pipedream-routes.test.ts env.d.ts
git commit -m "feat(auth): /api/auth/* routes + middleware, protect /api/user/:userId/*"
```

---

## Task 3: Schema migration + bootstrap host catalog + SSRF denylist

**Files:**

- Create: `src/pipedream/app-hosts.json`, `src/pipedream/app-hosts.ts`, `src/pipedream/app-hosts.test.ts`
- Modify: `src/db/schema.ts`, `src/db/types.ts`, `src/db/connected-accounts.ts`, `src/db/syncs.ts`
- Delete: `src/pipedream/host-mapping.ts`, `src/pipedream/host-mapping.test.ts`
- Modify: `src/pipedream/index.ts`

**Context:** Everything the gateway will need to resolve hosts lives in DB rows now. This task lays that data foundation + the curated catalog that pre-populates it at connection time.

### `app-hosts.json` content

```json
{
  "github": ["api.github.com", "uploads.github.com", "raw.githubusercontent.com"],
  "linear": ["api.linear.app"],
  "slack": ["slack.com", "hooks.slack.com"],
  "notion": ["api.notion.com"],
  "stripe": ["api.stripe.com"],
  "shopify": ["myshopify.com"],
  "hubspot": ["api.hubapi.com"],
  "intercom": ["api.intercom.io"],
  "vercel": ["api.vercel.com"],
  "gitlab": ["gitlab.com"],
  "pagerduty": ["api.pagerduty.com"],
  "sentry": ["sentry.io"],
  "twilio": ["api.twilio.com"],
  "typeform": ["api.typeform.com"],
  "calendly": ["api.calendly.com"],
  "mailgun": ["api.mailgun.net"],
  "zendesk": ["zendesk.com"],
  "jira": ["atlassian.net"],
  "bitbucket": ["api.bitbucket.org"],
  "clickup": ["api.clickup.com"],
  "google_sheets": ["sheets.googleapis.com"],
  "google_drive": ["www.googleapis.com"]
}
```

Shopify and Jira and Zendesk use tenant-subdomains, so the catalog entries are suffixes — the lookup must match by suffix (`hostname.endsWith("." + catalogHost) || hostname === catalogHost`). Worth handling in Task 4's gateway lookup, not in the JSON.

### `app-hosts.ts`

```ts
// src/pipedream/app-hosts.ts
import catalog from "./app-hosts.json";

const raw = catalog as Record<string, string[]>;

export const appHostsCatalog: ReadonlyMap<string, readonly string[]> = new Map(
  Object.entries(raw)
);

export function getCatalogHosts(appSlug: string): readonly string[] {
  return appHostsCatalog.get(appSlug) ?? [];
}

/**
 * SSRF denylist. Rejected hostnames never reach Pipedream regardless of
 * catalog/declaration matches. Private IPv4, link-local (includes AWS/GCP
 * metadata at 169.254.169.254), IPv6 loopback + ULA, cloud-internal
 * suffixes.
 */
const PRIVATE_IPV4_CIDRS: Array<[number, number]> = [
  // [baseAsUint32, mask]
  [0x7f000000, 0xff000000], // 127/8
  [0x0a000000, 0xff000000], // 10/8
  [0xac100000, 0xfff00000], // 172.16/12
  [0xc0a80000, 0xffff0000], // 192.168/16
  [0xa9fe0000, 0xffff0000]  // 169.254/16 — link-local incl. cloud metadata
];

function ipv4ToUint32(hostname: string): number | null {
  const parts = hostname.split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    out = ((out << 8) | n) >>> 0;
  }
  return out;
}

export function isDeniedHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h === "ip6-localhost") return true;
  if (h.endsWith(".internal") || h.endsWith(".local")) return true;
  if (h === "::1" || h.startsWith("fc") || h.startsWith("fd")) return true; // IPv6 loopback + ULA
  const v4 = ipv4ToUint32(h);
  if (v4 !== null) {
    for (const [base, mask] of PRIVATE_IPV4_CIDRS) {
      if ((v4 & mask) === base) return true;
    }
  }
  return false;
}
```

### Schema migration

In `src/db/schema.ts`, add after the existing CREATE TABLEs:

```ts
// Phase F: api_hosts columns for gateway egress allowlist. ALTER is
// idempotent via pragma_table_info check — existing rows get default '[]'.
addColumnIfNotExists(sql, "connected_accounts", "api_hosts", "TEXT NOT NULL DEFAULT '[]'");
addColumnIfNotExists(sql, "syncs", "api_hosts", "TEXT NOT NULL DEFAULT '[]'");
```

Where `addColumnIfNotExists` is a new helper:

```ts
function addColumnIfNotExists(
  sql: SqlTag,
  table: string,
  column: string,
  defSql: string
): void {
  const rows = sql<{ name: string }>`PRAGMA table_info(${table})`;
  const existing = rows.some((r) => r.name === column);
  if (existing) return;
  // SQLite doesn't parameterize DDL identifiers/types, so we compose a
  // literal ALTER. Values here are developer-controlled (table + column
  // names), not user input, so this is safe.
  sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${defSql}`);
}
```

Note: `sql.exec()` doesn't exist on the SqlTag. The schema migrations in this project use the tagged-template form — you'll need to use raw sql.exec via `this.sql.exec(...)`. Check how the existing `addColumnIfNotExists`-style patterns work in the Agents SDK documentation or existing code.

**If raw exec isn't available from within `applySchemaMigrations`**, fall back to: wrap the ALTER in a try/catch and swallow the "duplicate column" error. Less clean but works.

### Type + persist layer changes

`src/db/types.ts`:

```ts
export interface ConnectedAccount {
  user_id: string;
  app_slug: string;
  account_id: string;
  connected_at: number;
  api_hosts: string[]; // NEW
}

// Similar: add api_hosts: string[] to the Sync interface.
```

`src/db/connected-accounts.ts` — `upsertConnectedAccount` accepts + persists `api_hosts`:

```ts
export function upsertConnectedAccount(
  sql: SqlTag,
  input: NewConnectedAccount & { api_hosts?: string[] }
): void {
  const hosts = JSON.stringify(input.api_hosts ?? []);
  sql`
    INSERT INTO connected_accounts (user_id, app_slug, account_id, connected_at, api_hosts)
    VALUES (${input.user_id}, ${input.app_slug}, ${input.account_id}, ${Date.now()}, ${hosts})
    ON CONFLICT(user_id, app_slug) DO UPDATE SET
      account_id = excluded.account_id,
      connected_at = excluded.connected_at,
      api_hosts = excluded.api_hosts
  `;
}

export function listConnectedAccounts(sql: SqlTag, user_id: string): ConnectedAccount[] {
  const rows = sql<ConnectedAccount & { api_hosts: string }>`
    SELECT * FROM connected_accounts WHERE user_id = ${user_id}
  `;
  return rows.map((r) => ({ ...r, api_hosts: JSON.parse(r.api_hosts) }));
}
```

Same pattern for `src/db/syncs.ts` — `createSync` accepts `api_hosts`, all read helpers decode JSON.

### server.ts `persistPipedreamAccount` update

In `ChatAgent.persistPipedreamAccount`, populate api_hosts from the catalog:

```ts
import { getCatalogHosts } from "./pipedream/app-hosts";

// Inside persistPipedreamAccount:
upsertConnectedAccount(sql, {
  user_id: userId,
  app_slug,
  account_id,
  api_hosts: [...getCatalogHosts(app_slug)]
});
```

### Delete `host-mapping.ts`

Grep for `HOST_TO_APP_SLUG`, `resolveAppSlug`, `host-mapping` across `src/` and `tests/` — replace all callers. Task 4 owns the main caller (`http-gateway.ts`). Remove the exports from `src/pipedream/index.ts`; add `getCatalogHosts`, `isDeniedHost` exports.

- [ ] **Step 1: Create `app-hosts.json` + `app-hosts.ts`**

- [ ] **Step 2: Write `app-hosts.test.ts`** — catalog lookup, SSRF denylist for 127.0.0.1, 169.254.169.254, 10.5.5.5, localhost, ::1, 8.8.8.8 (not denied), unknown slug returns empty.

- [ ] **Step 3: Run app-hosts tests — PASS**

- [ ] **Step 4: Schema migration + type updates**

Apply schema changes, update `ConnectedAccount` / `Sync` types, update DB helpers to encode/decode `api_hosts`.

- [ ] **Step 5: Update `persistPipedreamAccount`** to populate api_hosts from catalog.

- [ ] **Step 6: Delete `host-mapping.ts` + `host-mapping.test.ts`; update `pipedream/index.ts` exports.**

- [ ] **Step 7: Run tests**

Expected failures: `http-gateway.ts` references `resolveAppSlug` — Task 4 fixes this. Pipedream-routes tests may need updates for the new api_hosts field on stored rows.

- [ ] **Step 8: Commit**

```bash
git add src/pipedream/app-hosts.json src/pipedream/app-hosts.ts src/pipedream/app-hosts.test.ts \
        src/db/schema.ts src/db/types.ts src/db/connected-accounts.ts src/db/syncs.ts \
        src/pipedream/index.ts src/server.ts \
        tests/pipedream-routes.test.ts
git rm src/pipedream/host-mapping.ts src/pipedream/host-mapping.test.ts
git commit -m "feat(pipedream): host catalog + api_hosts columns + SSRF denylist"
```

---

## Task 4: Gateway rewrite to DB-backed resolution

**Files:**

- Modify: `src/proxy/http-gateway.ts`
- Modify: `src/proxy/http-gateway.test.ts`
- Modify: `src/server.ts` (add ChatAgent RPC method for the lookup)

**Context:** Replace the single-lookup `resolveAppSlug(host)` path with:

1. `isDeniedHost(host)` — hard reject private IPs etc.
2. RPC into the user's ChatAgent DO to walk `connected_accounts.api_hosts` and `syncs.api_hosts` and return `{accountId, appSlug}` for the first match.
3. No match → 403 `unknown_host`.

### New ChatAgent RPC: `resolveEgressAccount(userId, hostname) → {accountId, appSlug} | null`

In `src/server.ts`, add to `ChatAgent`:

```ts
async resolveEgressAccount(
  userId: string,
  hostname: string
): Promise<{ accountId: string; appSlug: string } | null> {
  await this.setName(userId);
  this.#ensureSchema();
  const sql = this.sql.bind(this);
  const host = hostname.toLowerCase();

  // 1. connected_accounts.api_hosts (primary path).
  const accounts = listConnectedAccounts(sql, userId);
  for (const acc of accounts) {
    if (matchesHost(acc.api_hosts, host)) {
      return { accountId: acc.account_id, appSlug: acc.app_slug };
    }
  }

  // 2. syncs.api_hosts (agent-declared; resolve via sync.integration → account).
  const syncs = listSyncs(sql, userId);
  for (const sync of syncs) {
    if (matchesHost(sync.api_hosts, host)) {
      const acc = accounts.find((a) => a.app_slug === sync.integration);
      if (acc) return { accountId: acc.account_id, appSlug: acc.app_slug };
    }
  }

  return null;
}
```

Where `matchesHost(declaredHosts, actual): boolean` does exact-match AND suffix-match (for tenant-subdomain apps like Shopify, Zendesk, Jira): `actual === declared || actual.endsWith("." + declared)`.

### Gateway rewrite

```ts
// src/proxy/http-gateway.ts
import { WorkerEntrypoint } from "cloudflare:workers";
import { isDeniedHost } from "../pipedream/app-hosts";
import { proxiedFetch } from "../pipedream/proxy";
import { getCachedAccessToken } from "../pipedream/token-cache";

export interface HttpGatewayProps { userId?: string; }
type Forwarder = (r: Request) => Promise<Response>;

export type EgressLookup = (
  userId: string,
  hostname: string
) => Promise<{ accountId: string; appSlug: string } | null>;

export interface HandleGatewayRequestOptions {
  forwarder?: Forwarder;
  egressLookup?: EgressLookup;
}

export async function handleGatewayRequest(
  request: Request,
  env: Env,
  props: HttpGatewayProps,
  options: HandleGatewayRequestOptions = {}
): Promise<Response> {
  const forwarder = options.forwarder ?? fetch;
  const url = new URL(request.url);
  const host = url.hostname.toLowerCase();

  if (isDeniedHost(host)) {
    return new Response(
      JSON.stringify({ error: "denied_host", host, message: "Host is on the SSRF denylist." }),
      { status: 403, headers: { "content-type": "application/json" } }
    );
  }

  if (!props.userId || !options.egressLookup) {
    return new Response(
      JSON.stringify({ error: "no_user_context", host }),
      { status: 403, headers: { "content-type": "application/json" } }
    );
  }

  const resolved = await options.egressLookup(props.userId, host);
  if (!resolved) {
    return new Response(
      JSON.stringify({
        error: "unknown_host",
        host,
        message:
          "No connected account or sync declares this host. Connect the app in the Connections panel, or declare it at create_sync via api_hosts."
      }),
      { status: 403, headers: { "content-type": "application/json" } }
    );
  }

  const accessToken = await getCachedAccessToken(env);
  return proxiedFetch({
    env,
    accessToken,
    accountId: resolved.accountId,
    externalUserId: props.userId,
    request,
    forwarder
  });
}

export class HttpGateway extends WorkerEntrypoint<Env, HttpGatewayProps> {
  async fetch(request: Request): Promise<Response> {
    const egressLookup: EgressLookup = async (userId, hostname) => {
      const stub = this.env.ChatAgent.get(this.env.ChatAgent.idFromName(userId));
      return (stub as unknown as {
        resolveEgressAccount: (u: string, h: string) => Promise<{ accountId: string; appSlug: string } | null>;
      }).resolveEgressAccount(userId, hostname);
    };
    return handleGatewayRequest(request, this.env, this.ctx.props, { egressLookup });
  }
}
```

### Tests

Extend `http-gateway.test.ts`:

- SSRF denylist: request to `http://127.0.0.1/x`, `http://169.254.169.254/latest/meta-data/`, `http://10.5.5.5/` → 403 `denied_host`, forwarder NOT called, egressLookup NOT called.
- Connected-account match: egressLookup returns `{accountId: "apn_1", appSlug: "github"}`, request to `https://api.github.com/user` → proxied. Verify forwarder got the Pipedream URL with the right account_id.
- Sync-declared match: egressLookup returns `{accountId: "apn_2", appSlug: "stripe"}` for `api.stripe.com` (simulating the syncs-table fallback). Works the same.
- No match: egressLookup returns null → 403 `unknown_host`.

Also add unit tests for the new `resolveEgressAccount` RPC in a ChatAgent test file (or extend `pipedream-routes.test.ts`) — seed a connected_accounts row with api_hosts, assert the lookup finds it.

- [ ] **Step 1: Add `resolveEgressAccount` RPC to ChatAgent in server.ts** + `matchesHost` helper.

- [ ] **Step 2: Rewrite gateway to use egressLookup + SSRF denylist**

- [ ] **Step 3: Update gateway tests**

- [ ] **Step 4: Add ChatAgent RPC test for resolveEgressAccount**

- [ ] **Step 5: Run full check**

Expected: green. Old HOST_TO_APP_SLUG test file is deleted; new tests replace.

- [ ] **Step 6: Commit**

```bash
git add src/proxy/http-gateway.ts src/proxy/http-gateway.test.ts src/server.ts tests/pipedream-routes.test.ts
git commit -m "feat(gateway): DB-backed egress resolution + SSRF denylist"
```

---

## Task 5: Agent declaration at create_sync + tool descriptions + system prompt

**Files:**

- Modify: `src/agent/tools/write/create-sync.ts`
- Modify: `src/agent/tools/write/update-sync.ts`
- Modify: `src/agent/system-prompt.ts`
- Modify: `src/agent/tools/write/create-sync.test.ts`, `src/agent/tools/write/update-sync.test.ts`

**Context:** Agent declares `api_hosts: string[]` at create_sync. Supervisor persists on the sync row. Gateway picks them up via Task 4's `syncs.api_hosts` walk.

### Input schema additions

`create_sync` input gains:

```ts
api_hosts: z
  .array(z.string().min(1))
  .optional()
  .describe(
    "Additional hostnames your handler code needs to fetch, beyond what's already in the connected account's known-hosts catalog. Example: ['api.stripe.com'] if the handler calls fetch('https://api.stripe.com/v1/webhook_endpoints'). Leave unset if the handler only calls hosts the upstream already declared at connection time."
  )
```

`update_sync` input gains the same field (optional; missing = don't change existing api_hosts).

### Persist on the sync row

In `create_sync.ts` execute, after the preliminary NewSync is built, include `api_hosts: api_hosts ?? []`. Update the `finalNewSync` spread too so it carries the same value.

In `update_sync.ts`, if `api_hosts` is provided, include it in the updated row; if omitted, carry forward the existing value.

### Tool description update

In `create_sync`'s description, add to the handler-contract section:

```
**Declare your api_hosts.** If your handler code calls hosts that aren't in the connected app's default catalog, declare them at create_sync via the `api_hosts` input. The supervisor's egress gateway walks your declared hosts when routing outbound fetches — undeclared hosts 403. Use `fetch_docs` on the upstream's docs to find the exact hostnames (often there's more than one: main API + webhook endpoints + upload endpoints). Over-declaring is fine; under-declaring will 403 at runtime.
```

### System prompt

Under "## Creating a sync", add a new bullet:

```
N. **Declare the hosts your handler will call.** Before drafting create_sync, use fetch_docs to read the upstream's API reference and identify every hostname your registerWebhook / handleWebhook code will fetch(). Pass them as api_hosts: [...]. Missing declarations 403 at the gateway. Example: for Stripe, api.stripe.com covers both webhook registration AND most event enrichment calls.
```

### Tests

- create_sync.test.ts: call with `api_hosts: ["api.stripe.com"]`, verify the persisted sync row has that value. Happy path.
- update_sync.test.ts: call with `api_hosts: ["api.stripe.com", "files.stripe.com"]`, verify update replaced the old value.

- [ ] **Step 1-5: make the changes per above.**

- [ ] **Step 6: Run tests** — targeted tool tests, then full check. Expected fully green.

- [ ] **Step 7: Commit**

```bash
git add src/agent/tools/write/create-sync.ts src/agent/tools/write/update-sync.ts src/agent/system-prompt.ts \
        src/agent/tools/write/create-sync.test.ts src/agent/tools/write/update-sync.test.ts
git commit -m "feat(agent): api_hosts declaration at create_sync + docs"
```

---

## Task 6: Frontend auth gate + smoke

**Files:**

- Create: `src/ui/GoogleSignIn.tsx`, `src/ui/useAuth.ts`
- Modify: `src/ui/App.tsx` (or main entry) — auth gate
- Modify: all hooks that took `userId` as a param — derive from auth context instead
- Delete: `src/identity.ts`, `src/identity.test.ts`
- Modify: `.dev.vars.example`

**Context:** Minimal frontend work to light the auth up. Deliberately skipping polish (no redirect UX, no user avatar in header, etc.) — just "blank page → sign-in button → authenticated app."

### GoogleSignIn component

Loads GIS script lazily, renders the One Tap + button, handles the credential callback.

```tsx
// src/ui/GoogleSignIn.tsx
import { useEffect, useRef } from "react";

const GSI_SRC = "https://accounts.google.com/gsi/client";

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: unknown) => void;
          renderButton: (el: HTMLElement, opts: unknown) => void;
        };
      };
    };
  }
}

interface Props {
  clientId: string;
  onSuccess: (user: { sub: string; email: string }) => void;
}

export function GoogleSignIn({ clientId, onSuccess }: Props) {
  const btnRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function init() {
      if (!window.google || !btnRef.current) return;
      window.google.accounts.id.initialize({
        client_id: clientId,
        callback: async (resp: { credential: string }) => {
          const res = await fetch("/api/auth/login", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ credential: resp.credential })
          });
          if (res.ok) {
            const user = (await res.json()) as { sub: string; email: string };
            onSuccess(user);
          }
        }
      });
      window.google.accounts.id.renderButton(btnRef.current, {
        type: "standard",
        size: "large",
        text: "signin_with"
      });
    }
    if (window.google) { init(); return; }
    const s = document.createElement("script");
    s.src = GSI_SRC;
    s.async = true;
    s.onload = init;
    document.head.appendChild(s);
  }, [clientId, onSuccess]);

  return (
    <div style={{ display: "grid", placeItems: "center", minHeight: "100vh" }}>
      <div>
        <h1>Self-syncing agent</h1>
        <p>Sign in to continue.</p>
        <div ref={btnRef} />
      </div>
    </div>
  );
}
```

### useAuth hook

```ts
// src/ui/useAuth.ts
import { useEffect, useState } from "react";

interface User { sub: string; email: string; }

export function useAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((u) => setUser(u as User | null))
      .finally(() => setLoading(false));
  }, []);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    setUser(null);
  }

  return { user, loading, logout, setUser };
}
```

### App.tsx gate

Replace the existing userId-resolution at the top of the app with:

```tsx
const { user, loading, setUser } = useAuth();
if (loading) return <div>Loading…</div>;
if (!user)
  return <GoogleSignIn clientId={import.meta.env.VITE_GOOGLE_CLIENT_ID} onSuccess={setUser} />;
// Pass user.sub as userId to everything downstream.
```

The `VITE_GOOGLE_CLIENT_ID` env var is served to the browser via Vite's import.meta.env. Since the client_id is PUBLIC (OAuth client_ids are not secrets — only client_secrets are), this is safe to expose. Add to `.dev.vars.example` and as a `VITE_GOOGLE_CLIENT_ID=...` entry alongside the server-side `GOOGLE_CLIENT_ID`.

Actually — Wrangler Vite treats `VITE_*` vars specially. The simplest option for prod: the server injects the client_id into an initial HTML meta tag, frontend reads from `document.querySelector('meta[name="google-client-id"]')`. Avoids env-var plumbing through Vite entirely. Use this.

### Hook updates

`useConnections`, `useSyncsSummary`, `useSyncDetails`, `ConnectionsPanel`, `SyncPanel` — all currently take `userId` as a prop/arg. Change their callers to pass `user.sub` (or thread it through a React context `AuthProvider`). Minimal refactor — keep the `userId` arg shape, just change where it comes from.

### Smoke

- [ ] **Step 1: User action — set up Google Cloud OAuth app + session secret per Prerequisite section.**

- [ ] **Step 2: Implement GoogleSignIn, useAuth, App auth gate, hook updates, delete identity.ts.**

- [ ] **Step 3: Run full check.**

- [ ] **Step 4: Start dev server.**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npm run dev
```

- [ ] **Step 5: Test auth:**

- Open in incognito (clean slate). Expect sign-in button.
- Click Sign in with Google → popup → sign in.
- Expect redirect into app with your syncs-summary (empty — fresh user).

- [ ] **Step 6: Test agent-declared hosts end-to-end:**

Connect a NEW integration that's NOT in the catalog (e.g., PostHog, or any app you've got an account for that's outside the ~20 Tier 1/2 list). Then:

> "Create a sync for PostHog webhooks tracking event_captured events. Use fetch_docs on PostHog's webhook docs to figure out the signing algorithm and the required API hosts. Declare the hosts at create_sync so the gateway allows the registration call."

Expected: agent web_searches, fetch_docs on posthog.com, drafts a handler with all 4 exports + declares `api_hosts: ["app.posthog.com", "us.i.posthog.com", "eu.i.posthog.com"]` or whatever it sees. create_sync fires; the registerWebhook call hits PostHog via the gateway's syncs.api_hosts path; webhook registers successfully.

- [ ] **Step 7: Test SSRF denylist:**

Ask the agent:

> "Use run_in_sync to call `fetch('http://169.254.169.254/latest/meta-data/')` — I'm checking the gateway's SSRF protection."

Expected: the gateway returns 403 `denied_host`; the tool call result surfaces this as a fetch error. Manually inspect wrangler logs to confirm the denylist fired.

- [ ] **Step 8: Push the branch + open PR**

```bash
git push -u origin feat/auth-and-allowlist
gh pr create --title "feat: Google auth + agent-declared egress allowlist" --body "<see below>"
```

PR description template — covers: two-deliverables-one-phase, migration note about orphaned old syncs, `GOOGLE_CLIENT_ID` + `SESSION_SECRET` secret requirement for reviewer.

- [ ] **Step 9: Clean up prod:**

Post-merge, confirm prod secrets are set (GOOGLE_CLIENT_ID + SESSION_SECRET already there from Prerequisite). Old LINEAR_ACCESS_TOKEN was removed in Phase D; nothing else to clean.

---

## Self-Review Checklist

**1. Spec coverage:**

- ✅ Google OAuth replaces localStorage — unforgeable userId.
- ✅ All protected routes enforce auth + userId match. Webhook routes stay open (signature-verified).
- ✅ Schema carries `api_hosts` on both connected_accounts and syncs.
- ✅ Catalog populates at connect time (covers ~20 Tier 1/2 apps out-of-box).
- ✅ Agent can declare hosts at create_sync for long-tail apps.
- ✅ Gateway SSRF-denylists private IPs before any allowlist lookup.
- ✅ Gateway walks DB rows, not static TS enums — zero hardcoded hosts in supervisor.
- ✅ Old hardcoded map deleted (`src/pipedream/host-mapping.ts`).

**2. Type consistency:**

- `SessionPayload` has `{sub, email, iat, exp}` everywhere — in session.ts (Task 1), middleware.ts (Task 2), login route (Task 2), useAuth hook (Task 6).
- `api_hosts` is `string[]` in the type, `TEXT` (JSON-encoded) in SQLite. Encode/decode at the helper-layer boundary (Task 3).
- `resolveEgressAccount` returns `{accountId, appSlug} | null` consistently across the ChatAgent method (Task 4) and the gateway's `EgressLookup` type (Task 4).

**3. Trust-model coverage:**

- Trust boundary is now user ↔ their authenticated agent, NOT shared localStorage.
- Agent-declared hosts are approval-gated (Task 5).
- SSRF denylist at gateway is an absolute floor (Task 4) — can't be weakened by any declaration.
- Webhook endpoints authenticate via per-sync signature (Phase C); auth gate explicitly skips them.

---

## Future Work (noted, not planned here)

- **Dynamic app catalog from Pipedream `/v1/apps`.** The UI dropdown stays hardcoded (APP_OPTIONS from Phase A). Fetching Pipedream's full app list at mount would let the user connect any of the 2500+ apps without code changes. Low-risk, 1-hour change. Skipped here because Tier 1/2 covers the realistic reviewer-test set.
- **Link existing UUID-keyed data to Google sub.** Current plan orphans old syncs. A one-time `POST /api/auth/link` flow could take a legacy UUID + OAuth credential and re-key the DO / re-issue the connected_accounts rows under the sub. Out of scope for trial.
- **Cloudflare Access alternative.** For a production deployment, Cloudflare Access with a zone policy eliminates the OAuth plumbing entirely — auth is a config change, not code. Mentioned in README.
- **Per-sync egress constraint.** Right now any sync's declared host is reachable from any other sync (user-scoped, not sync-scoped). A stricter model would scope `api_hosts` to the specific sync that declared them. Blocks the cross-integration pattern (Linear handler calling GitHub); we deliberately left this enabled per Phase B's threat-model note.
- **Revocable sessions.** Current sessions are self-contained JWTs — can't be revoked before `exp`. Server-side session store (via a Cloudflare KV binding) would allow logout-everywhere + credential-rotation. Out of scope; session TTL is 7 days which limits blast radius.
- **Rate limit on /api/auth/login.** Google's signing keys can't be brute-forced but aggressive requests could exhaust JWK fetch quota. Add a simple KV-backed rate limiter keyed on IP. Trivial follow-up.
