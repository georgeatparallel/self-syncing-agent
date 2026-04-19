import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import {
  CF_ACCESS_HEADER,
  requireAuth,
  requireAuthAndUserIdMatch
} from "./middleware";

// Minimal Hono app builders so each test exercises one middleware in
// isolation without spinning up the full Worker. We pass an env override
// via `app.request(path, init, env)` — the third arg lands on `c.env`.
function makeAuthedApp() {
  const app = new Hono<{
    Bindings: { DEV_FALLBACK_USER?: string };
    Variables: { userId: string };
  }>();
  app.get("/me", requireAuth, (c) => c.json({ userId: c.var.userId }));
  return app;
}

function makeUserScopedApp() {
  const app = new Hono<{
    Bindings: { DEV_FALLBACK_USER?: string };
    Variables: { userId: string };
  }>();
  app.get("/api/user/:userId/ping", requireAuthAndUserIdMatch, (c) =>
    c.json({ ok: true, userId: c.var.userId })
  );
  return app;
}

describe("requireAuth", () => {
  it("returns 401 when no Access header and no dev fallback", async () => {
    const app = makeAuthedApp();
    const res = await app.request("/me", {}, {});
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthenticated" });
  });

  it("accepts the Access header and sets userId to the lowercased email", async () => {
    const app = makeAuthedApp();
    const res = await app.request(
      "/me",
      { headers: { [CF_ACCESS_HEADER]: "User@Example.COM" } },
      {}
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: "user@example.com" });
  });

  it("falls back to DEV_FALLBACK_USER when the Access header is absent", async () => {
    const app = makeAuthedApp();
    const res = await app.request(
      "/me",
      {},
      { DEV_FALLBACK_USER: "Dev@Example.com" }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: "dev@example.com" });
  });

  it("prefers the real Access header over DEV_FALLBACK_USER when both are set", async () => {
    const app = makeAuthedApp();
    const res = await app.request(
      "/me",
      { headers: { [CF_ACCESS_HEADER]: "real@example.com" } },
      { DEV_FALLBACK_USER: "dev@example.com" }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: "real@example.com" });
  });
});

describe("requireAuthAndUserIdMatch", () => {
  it("returns 403 when the path :userId does not match the authenticated email", async () => {
    const app = makeUserScopedApp();
    const res = await app.request(
      "/api/user/other@example.com/ping",
      { headers: { [CF_ACCESS_HEADER]: "me@example.com" } },
      {}
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "user_id_mismatch" });
  });

  it("returns 200 when the path :userId matches the authenticated email", async () => {
    const app = makeUserScopedApp();
    const res = await app.request(
      "/api/user/me@example.com/ping",
      { headers: { [CF_ACCESS_HEADER]: "Me@Example.com" } },
      {}
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      userId: "me@example.com"
    });
  });
});
