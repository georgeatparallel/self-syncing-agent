# Phase 06 — HTTP Gateway (credential injection via `WorkerEntrypoint`)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `HttpGateway` `WorkerEntrypoint` that facets will use as their `globalOutbound` in Phase 08. The gateway intercepts every outbound `fetch()` from facet code, matches the target host against a small set of known integrations, injects the right `Authorization: Bearer <token>` header from Worker env secrets, and forwards the request. Unknown hosts return `403`.

**Architecture change from prior plan:** Earlier I sketched a `CredentialSource` interface + `EnvCredentialSource` + separate `proxy-handler.ts` function. That's over-abstraction for V1's one integration. Cloudflare's own docs show a canonical pattern — a `WorkerEntrypoint` with a `switch` on `hostname` inside — and that's what V2 Pipedream will replace by swapping the whole gateway body out. No shared interface between V1 and V2 is actually needed.

Also corrected: the secret is `LINEAR_ACCESS_TOKEN` (OAuth access token from a Linear app we register), not `LINEAR_API_KEY`. OAuth tokens always use the `Bearer` prefix; this keeps the header format identical across V1 (env-sourced) and V2 (Pipedream-sourced).

**Tech Stack:** TypeScript, `WorkerEntrypoint` from `cloudflare:workers`, Vitest, `@cloudflare/vitest-pool-workers`.

**References:**

- [`docs/superpowers/specs/2026-04-17-self-syncing-agent-architecture-design.md`](../specs/2026-04-17-self-syncing-agent-architecture-design.md) §6 (outbound egress + credentials), §15 (Worker env secrets)
- Cloudflare Dynamic Workers docs: egress control, bindings, API reference. All quoted in the local `dynamic-workers.md` reference file.

---

## File Structure

**Created:**

- `src/proxy/http-gateway.ts` — `HttpGateway` class (WorkerEntrypoint) + pure `handleGatewayRequest` helper
- `src/proxy/http-gateway.test.ts` — 3 unit tests via the pure function (mocked forwarder)

**Modified:**

- `src/server.ts` — `export { HttpGateway } from "./proxy/http-gateway"` so `ctx.exports.HttpGateway` resolves at facet-load time
- `wrangler.jsonc` — add `"worker_loaders": [{ "binding": "LOADER" }]` (needed for Phase 08; adding now so `env.d.ts` has it)
- `.dev.vars.example` — add `LINEAR_ACCESS_TOKEN=` template
- `.dev.vars` — add `LINEAR_ACCESS_TOKEN=` placeholder (user swaps in a real token later)
- `vitest.config.ts` — add `LINEAR_ACCESS_TOKEN: "test-stub-token"` to miniflare bindings override
- `env.d.ts` — regenerated
- `.gitignore` — add `dynamic-workers.md` so the CF reference dump stays local
- `docs/superpowers/specs/2026-04-17-self-syncing-agent-architecture-design.md` — §6 rewritten to reflect actual pattern, §15 renames `LINEAR_API_KEY` → `LINEAR_ACCESS_TOKEN`

No changes to `src/agent/*`, `src/db/*`, `src/app.tsx`, or existing tests.

---

## Pre-flight context

### Canonical pattern from Cloudflare docs (verbatim, from `dynamic-workers.md` lines 1697-1780)

```ts
import { WorkerEntrypoint } from "cloudflare:workers";

export class HttpGateway extends WorkerEntrypoint {
  async fetch(request) {
    let url = new URL(request.url);
    const headers = new Headers(request.headers);

    if (url.hostname === "api.example.com") {
      headers.set("Authorization", `Bearer ${this.env.API_TOKEN}`);
      headers.set("X-Tenant-Id", this.ctx.props.tenantId);
    }

    return fetch(request, { headers });
  }
}
```

Usage at facet-load time (from Phase 08):

```ts
globalOutbound: ctx.exports.HttpGateway({ props: { userId } }),
```

The gateway instance sees `this.ctx.props.userId` for that specific facet. V1 ignores it (shared demo workspace token); V2 uses it to look up per-user Pipedream credentials.

### `WorkerEntrypoint` typing

Generic form: `class HttpGateway extends WorkerEntrypoint<Env, Props>`. `Env` is our Worker env (`Env` from auto-generated types). `Props` is whatever we declare — for us, `{ userId: string }` or `{ userId?: string }` so V1 works without strictly requiring it.

### `worker_loaders` binding

Adding it to `wrangler.jsonc` now (even though Phase 06 doesn't use it) so the regenerated `env.d.ts` exposes `env.LOADER: WorkerLoader` for Phase 08 to consume without re-running types. Shape from docs (lines 112-120 of `dynamic-workers.md`):

```jsonc
"worker_loaders": [
  { "binding": "LOADER" }
]
```

### Tests

Pure function is testable by passing a mock `forwarder` (the `fetch`-shaped callable). No need to instantiate `HttpGateway` directly in tests — the class is a 2-line wrapper. Direct invocation of `WorkerEntrypoint` constructors isn't cleanly supported outside the runtime anyway.

---

## Task 1: Wire `LINEAR_ACCESS_TOKEN` + `worker_loaders` binding

**Files:**

- Modify: `.dev.vars.example`, `.dev.vars`, `vitest.config.ts`, `wrangler.jsonc`, `env.d.ts` (regenerated)

- [ ] **Step 1: Add to `.dev.vars.example`**

Append to `.dev.vars.example`:

```
LINEAR_ACCESS_TOKEN=your-linear-oauth-access-token-here
```

- [ ] **Step 2: Add placeholder to `.dev.vars`**

Append to `.dev.vars`:

```
LINEAR_ACCESS_TOKEN=stub-for-phase-06
```

For Phase 06 tests, a stub is fine — tests never forward to Linear live. Real token is needed by Phase 08 when facets actually exercise the gateway.

- [ ] **Step 3: Add test-env binding override**

In `vitest.config.ts`, inside `poolOptions.workers.miniflare.bindings`, add:

```ts
LINEAR_ACCESS_TOKEN: "test-stub-token",
```

Alongside the existing `ANTHROPIC_API_KEY` and `PARALLEL_API_KEY` stubs.

- [ ] **Step 4: Add `worker_loaders` binding to `wrangler.jsonc`**

Find the existing bindings block. Add at the top level (sibling of `"durable_objects"`, `"assets"`, etc.):

```jsonc
"worker_loaders": [
  { "binding": "LOADER" }
],
```

- [ ] **Step 5: Regenerate `env.d.ts`**

```bash
pnpm run types
```

Expected: `env.d.ts` now includes both `LINEAR_ACCESS_TOKEN: string` and `LOADER: WorkerLoader` in the `Cloudflare.Env` interface. `pnpm exec tsc --noEmit` passes.

- [ ] **Step 6: Gitignore the local CF reference dump**

Find the "Local doc / reference dumps" block in `.gitignore` (around the `*-full-docs.txt` pattern). Add one more line so the full CF docs file stays local:

```
# Local doc / reference dumps kept out of the repo
*-full-docs.txt
dynamic-workers.md
```

Verify the file is now ignored:

```bash
git check-ignore dynamic-workers.md
```

Expected: prints `dynamic-workers.md` and exits 0.

---

## Task 2: Create `src/proxy/http-gateway.ts`

**Files:**

- Create: `src/proxy/http-gateway.ts`

- [ ] **Step 1: Create the file with exactly this content:**

```ts
/**
 * HttpGateway — the credential-injection layer for facet-initiated
 * outbound requests.
 *
 * Facets are loaded with `globalOutbound: ctx.exports.HttpGateway({ props: { userId } })`.
 * Every `fetch()` and `connect()` from within a facet is intercepted by this
 * WorkerEntrypoint's `fetch()` method. We look at the target host, look up
 * the right credential from Worker env secrets, inject the Authorization
 * header, and forward. Unknown hosts are rejected with 403 — facet code
 * cannot reach the open internet.
 *
 * V1 supports only Linear (via OAuth access token from a Linear app we
 * registered for the demo). V2 (Pipedream Connect) replaces the switch
 * body with a per-user lookup against Pipedream, using this.ctx.props.userId.
 *
 * Testability: the class is a thin wrapper over `handleGatewayRequest`, a
 * pure async function that takes (request, env, props, forwarder). Unit
 * tests pass a mocked forwarder; no network is hit.
 */

import { WorkerEntrypoint } from "cloudflare:workers";

export interface HttpGatewayProps {
  /**
   * The user DO instance this facet belongs to. V1 ignores this (demo
   * workspace token is shared); V2 uses it to look up per-user Pipedream
   * credentials.
   */
  userId?: string;
}

type Forwarder = (request: Request) => Promise<Response>;

/**
 * Pure, testable core of the gateway. Takes an injectable forwarder so
 * tests can verify the transformed request without a network call.
 */
export async function handleGatewayRequest(
  request: Request,
  env: Env,
  _props: HttpGatewayProps,
  forwarder: Forwarder = fetch
): Promise<Response> {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);

  switch (url.hostname) {
    case "api.linear.app":
      headers.set("Authorization", `Bearer ${env.LINEAR_ACCESS_TOKEN}`);
      break;
    default:
      return new Response(
        JSON.stringify({
          error: "unknown_host",
          host: url.hostname,
          message:
            "HttpGateway rejected the request. Facet code can only reach hosts with configured credentials."
        }),
        {
          status: 403,
          headers: { "content-type": "application/json" }
        }
      );
  }

  // Forward with the transformed headers. We construct a new Request so
  // the original body/method/etc. are preserved but headers are replaced.
  const forwarded = new Request(request, { headers });
  return forwarder(forwarded);
}

/**
 * The WorkerEntrypoint class that facets see as `globalOutbound`. Calls
 * into `handleGatewayRequest` with env and ctx.props lifted from the
 * runtime-managed instance state.
 */
export class HttpGateway extends WorkerEntrypoint<Env, HttpGatewayProps> {
  async fetch(request: Request): Promise<Response> {
    return handleGatewayRequest(request, this.env, this.ctx.props);
  }
}
```

Notes:

- The `_props` underscore prefix indicates intentional non-use in V1. Kept in the signature for V2 swap-in.
- `new Request(request, { headers })` clones the request with new headers. Preserves method, body, credentials mode — everything except headers.
- `HttpGatewayProps.userId` is optional because V1's shared-workspace model doesn't require it. V2 will type it as required on a new `PipedreamGateway` class.

---

## Task 3: Create `src/proxy/http-gateway.test.ts` (TDD — tests first)

**Files:**

- Create: `src/proxy/http-gateway.test.ts`

Test via the pure function `handleGatewayRequest` using a mocked forwarder. No DO setup, no `runInDurableObject`, no live network.

- [ ] **Step 1: Create the file with exactly this content:**

```ts
import { describe, it, expect, vi } from "vitest";
import { handleGatewayRequest } from "./http-gateway";

// ProvidedEnv augmentation is project-wide from earlier test files;
// we don't need to redeclare it here.

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ANTHROPIC_API_KEY: "anthro-stub",
    PARALLEL_API_KEY: "parallel-stub",
    LINEAR_ACCESS_TOKEN: "linear-test-token",
    // Additional bindings (ChatAgent, LOADER, etc.) aren't exercised by
    // these tests; cast to Env for type-compat with the real interface.
    ...overrides
  } as Env;
}

describe("handleGatewayRequest", () => {
  it("injects Authorization: Bearer <LINEAR_ACCESS_TOKEN> for api.linear.app and forwards", async () => {
    const env = makeEnv();
    const forwarder = vi.fn(async (req: Request) => {
      return new Response("ok from upstream", { status: 200 });
    });

    const request = new Request("https://api.linear.app/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "query { viewer { id } }" })
    });

    const response = await handleGatewayRequest(
      request,
      env,
      { userId: "u-1" },
      forwarder
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok from upstream");

    // Forwarder was called exactly once with the transformed request
    expect(forwarder).toHaveBeenCalledTimes(1);
    const forwarded = forwarder.mock.calls[0][0];
    expect(forwarded.url).toBe("https://api.linear.app/graphql");
    expect(forwarded.method).toBe("POST");
    expect(forwarded.headers.get("Authorization")).toBe(
      "Bearer linear-test-token"
    );
    expect(forwarded.headers.get("content-type")).toBe("application/json");
  });

  it("returns 403 with error JSON for unknown hosts and does NOT call the forwarder", async () => {
    const env = makeEnv();
    const forwarder = vi.fn(async () => {
      throw new Error("forwarder must not be called for unknown host");
    });

    const request = new Request("https://evil.example.com/exfiltrate", {
      method: "GET"
    });

    const response = await handleGatewayRequest(
      request,
      env,
      { userId: "u-1" },
      forwarder
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toBe("application/json");
    const body = (await response.json()) as {
      error: string;
      host: string;
      message: string;
    };
    expect(body.error).toBe("unknown_host");
    expect(body.host).toBe("evil.example.com");
    expect(body.message).toMatch(/rejected/i);

    expect(forwarder).not.toHaveBeenCalled();
  });

  it("preserves the original request body and method when forwarding", async () => {
    const env = makeEnv();
    let seenBody: string | null = null;
    const forwarder = vi.fn(async (req: Request) => {
      seenBody = await req.text();
      return new Response("ok", { status: 200 });
    });

    const payload = JSON.stringify({
      query: "mutation { webhookCreate(input: {...}) { success } }"
    });
    const request = new Request("https://api.linear.app/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload
    });

    await handleGatewayRequest(request, env, { userId: "u-2" }, forwarder);

    expect(forwarder).toHaveBeenCalledTimes(1);
    const forwarded = forwarder.mock.calls[0][0];
    expect(forwarded.method).toBe("POST");
    expect(seenBody).toBe(payload);
  });
});
```

- [ ] **Step 2: Run tests**

```bash
pnpm test
```

Expected: **38 passing** across 7 test files.

Breakdown:

- tests/smoke.test.ts (1)
- src/identity.test.ts (8)
- tests/per-user-do.test.ts (2)
- tests/supervisor-data-model.test.ts (11)
- src/agent/context.test.ts (5)
- tests/agent-read-tools.test.ts (8)
- src/proxy/http-gateway.test.ts (3) ← new

---

## Task 4: Re-export `HttpGateway` from `src/server.ts`

The class needs to be a named export of the worker's main module so that `ctx.exports.HttpGateway(...)` (used at facet-load time in Phase 08) resolves.

**Files:**

- Modify: `src/server.ts`

- [ ] **Step 1: Add the re-export**

Near the top of `src/server.ts` (alongside the other imports at the top of the file), add:

```ts
export { HttpGateway } from "./proxy/http-gateway";
```

Placement: after the existing imports, before the `MODEL_ID` constant. This ensures the class is part of the module's public surface.

- [ ] **Step 2: Type-check**

```bash
pnpm exec tsc --noEmit
```

Expected: zero errors.

---

## Task 5: Update the design doc to reflect reality

The design doc's §6.1 described a `CredentialSource` interface + `EnvCredentialSource` class. The real pattern is a `WorkerEntrypoint` subclass. §15 uses `LINEAR_API_KEY`; should be `LINEAR_ACCESS_TOKEN`.

**Files:**

- Modify: `docs/superpowers/specs/2026-04-17-self-syncing-agent-architecture-design.md`

- [ ] **Step 1: Replace §6 content**

Find `## 6. Outbound egress and credentials`. Replace §6.1 and §6.2 entirely with:

```markdown
### 6.1 Gateway design

Each facet is loaded with:

\`\`\`ts
globalOutbound: ctx.exports.HttpGateway({ props: { userId } })
\`\`\`

`HttpGateway` is a `WorkerEntrypoint` class exported from the supervisor worker. When facet code calls `fetch("https://api.linear.app/...")`, Cloudflare's runtime routes the request to `HttpGateway.fetch(request)`. The gateway:

1. Extracts the target hostname
2. Looks up the appropriate credential (V1: from `env.LINEAR_ACCESS_TOKEN`; V2: from a per-user Pipedream lookup using `this.ctx.props.userId`)
3. Injects `Authorization: Bearer <token>`
4. Forwards via `fetch(request, { headers })`
5. Returns `403` for unknown hosts — facet code cannot reach arbitrary URLs

Minimal V1 implementation:

\`\`\`ts
export class HttpGateway extends WorkerEntrypoint<Env, { userId?: string }> {
async fetch(request: Request): Promise<Response> {
const url = new URL(request.url);
const headers = new Headers(request.headers);
switch (url.hostname) {
case "api.linear.app":
headers.set("Authorization", \`Bearer \${this.env.LINEAR_ACCESS_TOKEN}\`);
break;
default:
return new Response(JSON.stringify({ error: "unknown_host" }), { status: 403 });
}
return fetch(request, { headers });
}
}
\`\`\`

### 6.2 V1 → V2 swap

V2 replaces the `switch` body with a Pipedream Connect lookup keyed on `this.ctx.props.userId`. No shared interface is needed because V1 and V2 aren't composed; V2 is a successor gateway class. The V1 → V2 transition is: replace the body of `HttpGateway.fetch`, or swap out the class reference at the facet-load site to a new `PipedreamGateway` class.

This is simpler than an abstract `CredentialSource` interface and matches the canonical Cloudflare pattern for egress control.
```

- [ ] **Step 2: Rename `LINEAR_API_KEY` → `LINEAR_ACCESS_TOKEN` in §15**

Find the §15 Worker env secrets table. Replace the `LINEAR_API_KEY` row with:

```
| `LINEAR_ACCESS_TOKEN` | Linear API auth (webhook registration + proxy injection) | V1 uses one shared demo-workspace OAuth access token; V2 Pipedream replaces this |
```

Also remove the `GITHUB_TOKEN` row if it's still there (V1 is Linear-only per Phase 03).

---

## Task 6: Full check

- [ ] **Step 1:**

```bash
pnpm run check
```

Expected: all four stages (oxfmt, oxlint, tsc, vitest) green. Test count: 38/38.

---

## Task 7: Commit and push

**Files staged:** `.gitignore`, `.dev.vars.example`, `vitest.config.ts`, `wrangler.jsonc`, `env.d.ts`, `src/proxy/http-gateway.ts`, `src/proxy/http-gateway.test.ts`, `src/server.ts`, `docs/superpowers/specs/2026-04-17-self-syncing-agent-architecture-design.md`, `docs/superpowers/plans/2026-04-17-phase-06-http-gateway.md` (this file).

`.dev.vars` is gitignored and won't stage. `dynamic-workers.md` is gitignored from this phase onward.

- [ ] **Step 1: Stage and verify**

```bash
git add -A
git status --short
git diff --cached --stat
```

Expected: ~10 files changed. Verify `dynamic-workers.md` is NOT staged (it should have just been added to .gitignore).

- [ ] **Step 2: Commit**

```bash
git commit -m "$(cat <<'EOF'
Phase 06: HttpGateway WorkerEntrypoint for credential injection

Implements the `globalOutbound` gateway that facets will use in Phase 08
to make authenticated outbound calls without ever seeing tokens. Follows
the canonical Cloudflare pattern from the Dynamic Workers docs:
WorkerEntrypoint subclass, switch on hostname, inject
Authorization: Bearer <token>, forward.

Revised from an earlier plan that had a CredentialSource interface +
EnvCredentialSource + proxyHandler function. That abstraction doesn't
earn its complexity for V1's one integration. V2 Pipedream will replace
the gateway body (or the entire class) — no shared interface needed.

Also: renamed LINEAR_API_KEY -> LINEAR_ACCESS_TOKEN everywhere. V1 uses
an OAuth access token from a Linear app we register; OAuth tokens use
the Bearer prefix. Same header format as V2 Pipedream, so the wire
format stays stable across the V1 -> V2 transition.

Concrete changes:
- src/proxy/http-gateway.ts — HttpGateway class + pure testable helper
- src/proxy/http-gateway.test.ts — 3 unit tests (known host injects,
  unknown host 403s, body/method preserved through forwarding)
- src/server.ts — re-export HttpGateway so ctx.exports.HttpGateway
  resolves at facet-load time
- wrangler.jsonc — add worker_loaders binding (LOADER) for Phase 08;
  env.d.ts regenerated to include LINEAR_ACCESS_TOKEN + LOADER
- .dev.vars.example + vitest bindings stubbed with LINEAR_ACCESS_TOKEN
- Design doc §6 rewritten to reflect the actual WorkerEntrypoint
  pattern; §15 secret rename
- .gitignore adds dynamic-workers.md so the local CF reference dump
  stays out of the repo

Test count: 35 -> 38.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 3: Push**

```bash
git push
```

---

## Phase 06 done when…

- [ ] `pnpm test` shows 38 passing across 7 test files
- [ ] `pnpm run check` green end-to-end
- [ ] `src/proxy/http-gateway.ts` exports `HttpGateway` (WorkerEntrypoint) + `handleGatewayRequest` (pure helper)
- [ ] `src/server.ts` re-exports `HttpGateway`
- [ ] `wrangler.jsonc` has `worker_loaders` binding; `env.d.ts` shows `LOADER: WorkerLoader` + `LINEAR_ACCESS_TOKEN: string`
- [ ] `dynamic-workers.md` in the repo root is gitignored
- [ ] Design doc §6 rewritten; §15 renamed to `LINEAR_ACCESS_TOKEN`
- [ ] Commit pushed to origin/main

Next phase: **Phase 07 — System prompt + docs-first discipline**. Replace the minimal placeholder in `src/agent/system-prompt.ts` with production prompt content (docs-first rule, Linear-specific guidance, response style rules, approval-gate explanation). Also the right time to verify `cache_control: ephemeral` actually hits on turn 2 — flagged in Phase 04's code review. After Phase 07, we're ready for Phase 08 (create_sync + facets + the gateway wired in).
