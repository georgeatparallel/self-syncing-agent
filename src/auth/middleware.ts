import { createMiddleware } from "hono/factory";
import { createRemoteJWKSet, jwtVerify } from "jose";

/**
 * Header Cloudflare Access injects on every authenticated request that
 * reaches an application behind it. Carries a signed JWT we verify
 * against the team's JWKS endpoint. We use the JWT (not the bare email
 * header) because:
 *  - `sub` is a stable UUID; the IdP-provided email can change.
 *  - A signed, audience-scoped token is resistant to spoofing if the
 *    Worker is ever reachable outside the Access-protected domain.
 *
 * The one exception is /webhook/*, which has its own Access app that
 * bypasses authentication at the edge — those handlers never call this
 * middleware, so the header-may-be-absent path below is about local
 * `wrangler dev` (no Access in front), not about production bypasses.
 */
export const CF_ACCESS_JWT_HEADER = "cf-access-jwt-assertion";

type AuthedEnv = {
  Bindings: {
    CF_ACCESS_TEAM_DOMAIN: string;
    CF_ACCESS_AUD: string;
    DEV_FALLBACK_USER?: string;
  };
  Variables: { userId: string; email: string };
};

/**
 * JWKS fetch is expensive (HTTPS round-trip to the team's certs endpoint,
 * then JWK parsing). `jose`'s `createRemoteJWKSet` returns a resolver that
 * transparently caches keys in-memory with its own TTL, so we only need to
 * cache the resolver itself at module scope. Keyed by team domain so a
 * future multi-tenant deployment (different domain per binding) still works.
 */
type JwksCacheEntry = {
  jwks: ReturnType<typeof createRemoteJWKSet>;
  teamDomain: string;
};
let jwksCache: JwksCacheEntry | null = null;

function getJwks(teamDomain: string): ReturnType<typeof createRemoteJWKSet> {
  if (jwksCache && jwksCache.teamDomain === teamDomain) return jwksCache.jwks;
  const jwks = createRemoteJWKSet(
    new URL(`https://${teamDomain}/cdn-cgi/access/certs`)
  );
  jwksCache = { jwks, teamDomain };
  return jwks;
}

/**
 * Resolve the authenticated user's identity from (in order):
 * 1. A verified `cf-access-jwt-assertion` header — `sub` becomes `userId`
 *    and the custom `email` claim is kept separately for display.
 * 2. The `DEV_FALLBACK_USER` env binding (local dev, set in .dev.vars).
 *    The single value is used as BOTH `userId` and `email` so existing
 *    test fixtures and dev flows don't need to juggle two fields.
 *
 * Returns null on any failure (missing header + no fallback, invalid
 * token, missing claims) — the caller decides the status code. `email`
 * is lowercased so downstream comparisons are normalization-free.
 */
async function resolveIdentity(c: {
  req: { header: (k: string) => string | undefined };
  env: AuthedEnv["Bindings"];
}): Promise<{ userId: string; email: string } | null> {
  const jwt = c.req.header(CF_ACCESS_JWT_HEADER);
  if (jwt) {
    try {
      const { payload } = await jwtVerify(
        jwt,
        getJwks(c.env.CF_ACCESS_TEAM_DOMAIN),
        {
          issuer: `https://${c.env.CF_ACCESS_TEAM_DOMAIN}`,
          audience: c.env.CF_ACCESS_AUD
        }
      );
      const sub = typeof payload.sub === "string" ? payload.sub : null;
      // `email` is a custom Cloudflare Access claim, not a standard JWT
      // claim — narrow the type explicitly rather than trust the declared
      // `JWTPayload` shape.
      const rawEmail = (payload as { email?: unknown }).email;
      const email =
        typeof rawEmail === "string" ? rawEmail.toLowerCase() : null;
      if (sub && email) return { userId: sub, email };
      return null;
    } catch {
      // Signature/audience/issuer/expiry mismatch — treat any verification
      // failure uniformly as "no valid identity".
      return null;
    }
  }
  const dev = c.env.DEV_FALLBACK_USER;
  if (dev) {
    const v = dev.toLowerCase();
    return { userId: v, email: v };
  }
  return null;
}

/**
 * Gate a route on "an authenticated user exists", without cross-checking
 * against a path param. Use for routes like GET /api/auth/me where the
 * handler's whole job is to report back who the caller is.
 */
export const requireAuth = createMiddleware<AuthedEnv>(async (c, next) => {
  const id = await resolveIdentity(c);
  if (!id) return c.json({ error: "unauthenticated" }, 401);
  c.set("userId", id.userId);
  c.set("email", id.email);
  await next();
});

/**
 * Gate a route on "the authenticated sub matches the :userId path param".
 * Defense-in-depth for /api/user/:userId/* — Cloudflare Access is the
 * primary authorization layer, but this middleware prevents one authed
 * user from targeting another user's Durable Object by typing a foreign
 * sub UUID into the URL. Cheap insurance against future policy loosening.
 */
export const requireAuthAndUserIdMatch = createMiddleware<AuthedEnv>(
  async (c, next) => {
    const id = await resolveIdentity(c);
    if (!id) return c.json({ error: "unauthenticated" }, 401);
    const pathUserId = c.req.param("userId");
    if (pathUserId && pathUserId !== id.userId) {
      return c.json({ error: "user_id_mismatch" }, 403);
    }
    c.set("userId", id.userId);
    c.set("email", id.email);
    await next();
  }
);
