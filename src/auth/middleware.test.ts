import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

// Mock jose BEFORE importing middleware so the module-level
// createRemoteJWKSet call (captured into the JWKS cache on first use)
// and the jwtVerify reference both point at our fakes. We don't care
// about the real crypto; we're testing the middleware's plumbing.
// `vi.hoisted` is required because `vi.mock` is hoisted above the
// surrounding `const` declarations — a plain top-level const would be
// in the TDZ when the factory runs.
const { jwtVerifyMock } = vi.hoisted(() => ({ jwtVerifyMock: vi.fn() }));
vi.mock("jose", () => ({
  createRemoteJWKSet: vi.fn(() => "jwks-stub"),
  jwtVerify: jwtVerifyMock,
  errors: {}
}));

import {
  CF_ACCESS_JWT_HEADER,
  requireAuth,
  requireAuthAndUserIdMatch
} from "./middleware";

type TestBindings = {
  CF_ACCESS_TEAM_DOMAIN: string;
  CF_ACCESS_AUD: string;
  DEV_FALLBACK_USER?: string;
};

const BASE_ENV: TestBindings = {
  CF_ACCESS_TEAM_DOMAIN: "test.cloudflareaccess.com",
  CF_ACCESS_AUD: "test-aud"
};

// Minimal Hono app builders so each test exercises one middleware in
// isolation without spinning up the full Worker. We pass an env override
// via `app.request(path, init, env)` — the third arg lands on `c.env`.
function makeAuthedApp() {
  const app = new Hono<{
    Bindings: TestBindings;
    Variables: { userId: string; email: string };
  }>();
  app.get("/me", requireAuth, (c) =>
    c.json({ userId: c.var.userId, email: c.var.email })
  );
  return app;
}

function makeUserScopedApp() {
  const app = new Hono<{
    Bindings: TestBindings;
    Variables: { userId: string; email: string };
  }>();
  app.get("/api/user/:userId/ping", requireAuthAndUserIdMatch, (c) =>
    c.json({ ok: true, userId: c.var.userId, email: c.var.email })
  );
  return app;
}

describe("requireAuth", () => {
  beforeEach(() => {
    jwtVerifyMock.mockReset();
  });

  it("returns 401 when no JWT header and no DEV_FALLBACK_USER", async () => {
    const app = makeAuthedApp();
    const res = await app.request("/me", {}, { ...BASE_ENV });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthenticated" });
  });

  it("accepts a valid JWT and sets userId=sub and lowercased email", async () => {
    jwtVerifyMock.mockResolvedValueOnce({
      payload: { sub: "user-uuid-1", email: "User@Example.COM" },
      protectedHeader: {}
    });
    const app = makeAuthedApp();
    const res = await app.request(
      "/me",
      { headers: { [CF_ACCESS_JWT_HEADER]: "valid.jwt.token" } },
      { ...BASE_ENV }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      userId: "user-uuid-1",
      email: "user@example.com"
    });
  });

  it("falls back to DEV_FALLBACK_USER when no JWT header is present", async () => {
    const app = makeAuthedApp();
    const res = await app.request(
      "/me",
      {},
      { ...BASE_ENV, DEV_FALLBACK_USER: "dev@local" }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      userId: "dev@local",
      email: "dev@local"
    });
    // Verify that no JWT verification was attempted.
    expect(jwtVerifyMock).not.toHaveBeenCalled();
  });

  it("prefers the JWT over DEV_FALLBACK_USER when both are present", async () => {
    jwtVerifyMock.mockResolvedValueOnce({
      payload: { sub: "real-sub", email: "real@example.com" },
      protectedHeader: {}
    });
    const app = makeAuthedApp();
    const res = await app.request(
      "/me",
      { headers: { [CF_ACCESS_JWT_HEADER]: "valid.jwt.token" } },
      { ...BASE_ENV, DEV_FALLBACK_USER: "dev@local" }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      userId: "real-sub",
      email: "real@example.com"
    });
  });

  it("returns 401 when JWT verification throws and no fallback is set", async () => {
    jwtVerifyMock.mockRejectedValueOnce(
      new Error("signature verification failed")
    );
    const app = makeAuthedApp();
    const res = await app.request(
      "/me",
      { headers: { [CF_ACCESS_JWT_HEADER]: "bogus.jwt.token" } },
      { ...BASE_ENV }
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthenticated" });
  });
});

describe("requireAuthAndUserIdMatch", () => {
  beforeEach(() => {
    jwtVerifyMock.mockReset();
  });

  it("returns 403 when the path :userId does not match the JWT sub", async () => {
    jwtVerifyMock.mockResolvedValueOnce({
      payload: { sub: "me-uuid", email: "me@example.com" },
      protectedHeader: {}
    });
    const app = makeUserScopedApp();
    const res = await app.request(
      "/api/user/other-uuid/ping",
      { headers: { [CF_ACCESS_JWT_HEADER]: "valid.jwt.token" } },
      { ...BASE_ENV }
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "user_id_mismatch" });
  });

  it("returns 200 when the path :userId matches the JWT sub", async () => {
    jwtVerifyMock.mockResolvedValueOnce({
      payload: { sub: "me-uuid", email: "Me@Example.COM" },
      protectedHeader: {}
    });
    const app = makeUserScopedApp();
    const res = await app.request(
      "/api/user/me-uuid/ping",
      { headers: { [CF_ACCESS_JWT_HEADER]: "valid.jwt.token" } },
      { ...BASE_ENV }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      userId: "me-uuid",
      email: "me@example.com"
    });
  });
});
