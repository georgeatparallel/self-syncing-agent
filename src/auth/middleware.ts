import { createMiddleware } from "hono/factory";

/**
 * Header Cloudflare Access injects on every authenticated request that
 * reaches an application behind it. Present iff the JWT Access minted was
 * valid — we don't have to re-verify the JWT ourselves because the Worker
 * is only reachable via the Access-protected custom domain (workers_dev
 * is off in wrangler.jsonc).
 *
 * The one exception is /webhook/*, which has its own Access app that
 * bypasses authentication at the edge — those handlers never call this
 * middleware, so the header-may-be-absent path below is about local
 * `wrangler dev` (no Access in front), not about production bypasses.
 */
export const CF_ACCESS_HEADER = "cf-access-authenticated-user-email";

type AuthedEnv = {
  Bindings: { DEV_FALLBACK_USER?: string };
  Variables: { userId: string };
};

/**
 * Resolve the authenticated user's email from (in order):
 * 1. The `cf-access-authenticated-user-email` header (prod).
 * 2. The `DEV_FALLBACK_USER` env binding (local dev, set in .dev.vars).
 *
 * Returned lowercased so downstream comparisons (e.g. path :userId vs.
 * authenticated email) don't have to normalize at every callsite.
 */
function resolveAuthenticatedEmail(c: {
  req: { header: (k: string) => string | undefined };
  env: { DEV_FALLBACK_USER?: string };
}): string | null {
  const fromAccess = c.req.header(CF_ACCESS_HEADER);
  if (fromAccess) return fromAccess.toLowerCase();
  const dev = c.env.DEV_FALLBACK_USER;
  if (dev) return dev.toLowerCase();
  return null;
}

/**
 * Gate a route on "an authenticated user exists", without cross-checking
 * against a path param. Use for routes like GET /api/auth/me where the
 * handler's whole job is to report back who the caller is.
 */
export const requireAuth = createMiddleware<AuthedEnv>(async (c, next) => {
  const email = resolveAuthenticatedEmail(c);
  if (!email) return c.json({ error: "unauthenticated" }, 401);
  c.set("userId", email);
  await next();
});

/**
 * Gate a route on "the authenticated email matches the :userId path param".
 * Defense-in-depth for /api/user/:userId/* — Cloudflare Access is the
 * primary authorization layer, but this middleware prevents one authed
 * user from targeting another user's Durable Object by typing their
 * email into the URL. Cheap insurance against future policy loosening.
 */
export const requireAuthAndUserIdMatch = createMiddleware<AuthedEnv>(
  async (c, next) => {
    const email = resolveAuthenticatedEmail(c);
    if (!email) return c.json({ error: "unauthenticated" }, 401);
    const pathUserId = c.req.param("userId");
    if (pathUserId && pathUserId !== email) {
      return c.json({ error: "user_id_mismatch" }, 403);
    }
    c.set("userId", email);
    await next();
  }
);
