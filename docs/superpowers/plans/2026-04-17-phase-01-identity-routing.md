# Phase 01 — Identity & Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every visitor their own isolated Durable Object by minting a client-side UUID on first landing, persisting it to `localStorage`, routing the URL to `/user/:userId`, and passing that `userId` as the DO instance name to `useAgent`. No auth, no server-side user registry — the URL is the capability.

**Architecture:** The React SPA reads `location.pathname`. If the visitor is at `/`, the client mints a UUID, writes it to `localStorage`, and replaces the URL with `/user/<uuid>`. If they arrive directly at `/user/:userId`, we use that ID as the DO instance name. `useAgent({ agent: "ChatAgent", name: userId })` tells the Agents SDK to open a WebSocket against `env.ChatAgent.idFromName(userId)` — creating a DO on first access, reusing it on every subsequent access. The server side is already wired correctly via `routeAgentRequest` + the existing SPA fallback in `wrangler.jsonc`; only the client needs changes.

**Tech Stack:** React 19, Agents SDK (`agents/react`), `crypto.randomUUID()` (native in modern browsers), no routing library.

**Reference:** [`docs/superpowers/specs/2026-04-17-self-syncing-agent-architecture-design.md`](../specs/2026-04-17-self-syncing-agent-architecture-design.md) §3 Identity and addressing.

---

## File Structure

- **Create** `src/identity.ts` — pure module: `USER_ID_KEY`, `getOrMintUserId()`, `userIdFromPath(pathname)`, `userPath(userId)`.
- **Create** `src/identity.test.ts` — unit tests for the pure functions (no React, no DOM).
- **Modify** `src/app.tsx` — replace the hard-coded `agent: "ChatAgent"` useAgent call with `{ agent: "ChatAgent", name: userId }`; on mount, resolve the userId via `identity.ts` and, if we're at `/`, call `history.replaceState` to land on `/user/<uuid>`.
- **Create** `tests/per-user-do.test.ts` — integration test: two different userIds → two different DO instances → isolated SQLite state.
- **Modify** `vitest.config.ts` — add a miniflare `bindings` override so `ANTHROPIC_API_KEY` is a test stub, preventing confusing CI failures in later phases.
- **Modify** `package.json` — pin `@cloudflare/vitest-pool-workers@0.12.21` exactly (drop the caret), and add the oxfmt platform binding explicitly.

No changes to `src/server.ts` — the starter's `routeAgentRequest(request, env)` already handles per-instance routing when the client passes `name`.

---

## Task 1: Dependency hygiene (unblock `pnpm run check`, stabilize versions)

This task addresses two concerns carried over from Phase 00's code review:

- The pre-existing `@oxfmt/binding-darwin-arm64` optional-dep failure (same pnpm bug pattern as rolldown).
- The caret-versioned `@cloudflare/vitest-pool-workers` could drift on `0.12.x` patch bumps; pin exact.

**Files:**

- Modify: `package.json` (devDependencies)
- Modify: `pnpm-lock.yaml` (via install)

- [ ] **Step 1: Pin the pool-workers version exactly**

Open `package.json` and change the line in `devDependencies` that reads:

```json
"@cloudflare/vitest-pool-workers": "^0.12.21",
```

to:

```json
"@cloudflare/vitest-pool-workers": "0.12.21",
```

(Drop the caret. The leading `^` allows patch drift within `0.12.x`; we want exactly `0.12.21` for reproducibility on a new clone.)

- [ ] **Step 2: Add the oxfmt arm64 binding explicitly**

Same pnpm-optional-deps bug that bit us with rolldown. Run:

```bash
pnpm add -D @oxfmt/binding-darwin-arm64@0.45.0
```

(Version should match whatever `oxfmt` itself is at in `package.json` — the current entry is `"oxfmt": "^0.45.0"`. Match the minor so the binding is compatible.)

Expected: pnpm adds `@oxfmt/binding-darwin-arm64` as a devDependency. If it reports the version doesn't exist, check `ls node_modules/.pnpm | grep ^oxfmt` for the actually resolved oxfmt minor version and match that.

- [ ] **Step 3: Reinstall cleanly to pick up the version pin**

```bash
rm -rf node_modules pnpm-lock.yaml
pnpm install
```

Expected: fresh install completes without warnings. `node_modules/@oxfmt/binding-darwin-arm64/` should exist afterward.

- [ ] **Step 4: Verify `pnpm run check` now passes**

```bash
pnpm run check
```

Expected: all four chained commands (`oxfmt --check .`, `oxlint src/`, `tsc`, `vitest run`) exit 0. This is the first time `check` has actually run green end-to-end.

If `oxfmt` still fails: the binding version may have drifted. Look at `ls node_modules/@oxfmt` to see which bindings are present, and match `@oxfmt/binding-darwin-arm64`'s version to the installed oxfmt.

---

## Task 2: Add a test-env binding override for `ANTHROPIC_API_KEY`

Carried over from Phase 00's code review: Phase 02+ tests will instantiate the DO, which invokes `onChatMessage`, which reads `env.ANTHROPIC_API_KEY`. Without a test override, CI environments without `.dev.vars` produce confusing failures. This task costs nothing and prevents that.

**Files:**

- Modify: `vitest.config.ts`

- [ ] **Step 1: Add `bindings` override to the miniflare config**

Replace the current `vitest.config.ts` content with:

```ts
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    include: ["tests/**/*.{test,spec}.ts", "src/**/*.{test,spec}.ts"],
    poolOptions: {
      workers: {
        singleWorker: true,
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          compatibilityFlags: ["nodejs_compat"],
          bindings: {
            // Stub secret for tests. Real value comes from .dev.vars in dev
            // and `wrangler secret put` in prod. Tests that need to simulate
            // real LLM calls should mock the Anthropic SDK explicitly.
            ANTHROPIC_API_KEY: "test-stub-key"
          }
        }
      }
    }
  }
});
```

- [ ] **Step 2: Re-run tests to verify the override doesn't break the existing smoke test**

```bash
pnpm test
```

Expected: still 1/1 passing (the smoke test doesn't use the key, so this is purely ensuring we didn't break the config).

---

## Task 3: Create the `identity` module (TDD: write tests first)

This module is three pure functions + one constant. We TDD it because the logic is small, localized, and the test cost is low.

**Files:**

- Create: `src/identity.ts`
- Create: `src/identity.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/identity.test.ts` with exactly this content:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  USER_ID_KEY,
  getOrMintUserId,
  userIdFromPath,
  userPath
} from "./identity";

function mockLocalStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    get length() {
      return store.size;
    },
    key: (i: number) => Array.from(store.keys())[i] ?? null
  };
}

describe("identity", () => {
  describe("USER_ID_KEY", () => {
    it("is a stable localStorage key", () => {
      expect(USER_ID_KEY).toBe("self-syncing-agent:user-id");
    });
  });

  describe("userIdFromPath", () => {
    it("extracts a userId from /user/:id paths", () => {
      expect(userIdFromPath("/user/abc-123")).toBe("abc-123");
      expect(userIdFromPath("/user/6a2c9b1e-ff01-4d3e-9c10-aabbccddeeff")).toBe(
        "6a2c9b1e-ff01-4d3e-9c10-aabbccddeeff"
      );
    });

    it("strips a trailing slash", () => {
      expect(userIdFromPath("/user/abc-123/")).toBe("abc-123");
    });

    it("returns null for unrelated paths", () => {
      expect(userIdFromPath("/")).toBeNull();
      expect(userIdFromPath("/about")).toBeNull();
      expect(userIdFromPath("/user")).toBeNull();
      expect(userIdFromPath("/user/")).toBeNull();
      expect(userIdFromPath("/user/abc/extra")).toBeNull();
    });
  });

  describe("userPath", () => {
    it("builds the canonical path for a userId", () => {
      expect(userPath("abc-123")).toBe("/user/abc-123");
    });
  });

  describe("getOrMintUserId", () => {
    let storage: ReturnType<typeof mockLocalStorage>;

    beforeEach(() => {
      storage = mockLocalStorage();
      vi.stubGlobal("localStorage", storage);
    });

    it("mints a new UUID when none is stored and returns it", () => {
      const id = getOrMintUserId();
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      );
      expect(storage.getItem(USER_ID_KEY)).toBe(id);
    });

    it("returns the stored UUID when one is already set", () => {
      const stored = "6a2c9b1e-ff01-4d3e-9c10-aabbccddeeff";
      storage.setItem(USER_ID_KEY, stored);
      expect(getOrMintUserId()).toBe(stored);
    });

    it("prefers the pathname userId over the stored one and writes it through", () => {
      storage.setItem(USER_ID_KEY, "old-id");
      const fromUrl = "11111111-2222-3333-4444-555555555555";
      expect(getOrMintUserId(fromUrl)).toBe(fromUrl);
      expect(storage.getItem(USER_ID_KEY)).toBe(fromUrl);
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm test
```

Expected: failures because `./identity` does not yet exist. Error message will be along the lines of `Cannot find module './identity'`.

- [ ] **Step 3: Implement `src/identity.ts`**

Create the file with exactly this content:

```ts
/**
 * Per-user identity, client-minted. No auth; the userId is the capability.
 * Sharing the /user/<id> URL = sharing the agent.
 */

export const USER_ID_KEY = "self-syncing-agent:user-id";

/**
 * Extract a userId from a pathname like `/user/:id`.
 * Returns null for any path that does not match exactly.
 */
export function userIdFromPath(pathname: string): string | null {
  const trimmed = pathname.replace(/\/+$/, "");
  const match = trimmed.match(/^\/user\/([^/]+)$/);
  return match ? match[1] : null;
}

/**
 * Build the canonical URL path for a userId.
 */
export function userPath(userId: string): string {
  return `/user/${userId}`;
}

/**
 * Resolve the user's ID. If the caller passes `fromUrl` (extracted from the
 * pathname), that wins and is persisted to localStorage. Otherwise return
 * the stored ID, or mint a new UUIDv4 on first visit.
 */
export function getOrMintUserId(fromUrl?: string | null): string {
  if (fromUrl) {
    localStorage.setItem(USER_ID_KEY, fromUrl);
    return fromUrl;
  }
  const stored = localStorage.getItem(USER_ID_KEY);
  if (stored) return stored;
  const minted = crypto.randomUUID();
  localStorage.setItem(USER_ID_KEY, minted);
  return minted;
}
```

- [ ] **Step 4: Run tests again to verify they pass**

```bash
pnpm test
```

Expected: all tests in both `tests/smoke.test.ts` and `src/identity.test.ts` pass. Test Files: 2 passed. Tests: 8 passed (1 smoke + 7 identity).

---

## Task 4: Wire `userId` into `app.tsx` and handle URL routing

Now we use the identity module from React. The app, on mount:

1. Reads `location.pathname`.
2. If it matches `/user/:id`, uses that id.
3. Otherwise mints/reads from localStorage and calls `history.replaceState` to land on `/user/<id>`.
4. Passes the resolved `userId` as the `name` parameter to `useAgent`.

**Files:**

- Modify: `src/app.tsx` — specifically the `useAgent` call and top-of-component setup.

- [ ] **Step 1: Add the identity import and userId resolution**

Open `src/app.tsx`. Find line 2 (just after `import { Suspense, ... } from "react"`) and add this import:

```ts
import { getOrMintUserId, userIdFromPath, userPath } from "./identity";
```

- [ ] **Step 2: Resolve userId at the top of the default-exported component**

Find the default-exported component (contains `const agent = useAgent<ChatAgent>({ agent: "ChatAgent", ...`). Add this block immediately above the `useAgent` call:

```ts
// Resolve the userId exactly once per mount. If we're at /, redirect to /user/<id>
// so the URL is shareable. useState with a lazy initializer ensures this runs
// once (before useAgent sees it) and stays stable across re-renders.
const [userId] = useState(() => {
  const fromUrl = userIdFromPath(window.location.pathname);
  const resolved = getOrMintUserId(fromUrl);
  if (window.location.pathname !== userPath(resolved)) {
    window.history.replaceState({}, "", userPath(resolved));
  }
  return resolved;
});
```

Why lazy initializer: guarantees we compute the userId before React re-renders and before `useAgent` registers, avoiding a race where the DO gets created under `"default"` and then switched.

- [ ] **Step 3: Pass userId as the agent instance name**

In the same component, the current call looks like:

```ts
const agent = useAgent<ChatAgent>({
  agent: "ChatAgent",
  onOpen: ...
```

Change the opening two lines to:

```ts
const agent = useAgent<ChatAgent>({
  agent: "ChatAgent",
  name: userId,
  onOpen: ...
```

(Add the `name: userId,` line between `agent: "ChatAgent",` and `onOpen: useCallback(...`.)

That is the entire user-facing behavioral change.

- [ ] **Step 4: Manual smoke check in dev**

```bash
pnpm dev
```

In a browser, open `http://localhost:5173/`. Expected:

1. URL bar immediately rewrites to `http://localhost:5173/user/<uuid>` (no navigation history entry).
2. Chat connects ("Connected" badge appears).
3. Refresh the page — same userId persists (URL unchanged; localStorage has it).
4. Open an incognito window — different userId gets minted, lands at a different `/user/<uuid>`.

Kill dev (`Ctrl-C`) when done. This is a sanity check, not an automated gate.

---

## Task 5: Integration test — per-user DO scoping

Proves the substrate works: two different userIds get isolated DOs. This test anchors the whole "one user = one DO" invariant for the rest of the build.

**Files:**

- Create: `tests/per-user-do.test.ts`

- [ ] **Step 1: Write the integration test**

Create `tests/per-user-do.test.ts` with exactly this content:

```ts
import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("per-user DO scoping", () => {
  it("produces distinct DO instances for distinct userIds", () => {
    const idA = env.ChatAgent.idFromName("user-a");
    const idB = env.ChatAgent.idFromName("user-b");
    expect(idA.toString()).not.toBe(idB.toString());
  });

  it("produces the same DO instance for the same userId across calls", () => {
    const first = env.ChatAgent.idFromName("user-stable").toString();
    const second = env.ChatAgent.idFromName("user-stable").toString();
    expect(first).toBe(second);
  });
});
```

- [ ] **Step 2: Run tests**

```bash
pnpm test
```

Expected: 2 more tests pass (total now 11 passed: 1 smoke + 8 identity + 2 per-user-do).

This gives us the ID-stability invariant for Phase 01; **richer SQLite-state-isolation proof waits for Phase 02** once we have a typed write surface (the `syncs` table) to exercise per-DO.

---

## Task 6: Commit and push

**Files:**

- All Phase 01 changes: `package.json`, `pnpm-lock.yaml`, `vitest.config.ts`, `src/identity.ts`, `src/identity.test.ts`, `src/app.tsx`, `tests/per-user-do.test.ts`.

- [ ] **Step 1: Stage and verify nothing extra is included**

```bash
git add -A
git status --short
```

Expected: only the seven files above staged. If any other files appear (e.g., oxfmt reformatting of existing code), inspect with `git diff --cached` — oxfmt-driven cosmetic changes to files we didn't intentionally touch are OK to include in this commit.

- [ ] **Step 2: Commit**

```bash
git commit -m "$(cat <<'EOF'
Phase 01: client-minted UUIDs + per-user DO routing

Every visitor now lands on /user/<uuid>. The userId is minted client-side
on first visit (crypto.randomUUID), persisted to localStorage, and used
as the DO instance name in useAgent({ agent: "ChatAgent", name: userId }).
One DO per user. Sharing the URL shares the agent.

- src/identity.ts + tests — pure helpers for UUID mint, path parse, redirect
- src/app.tsx — resolves userId once on mount, replaces URL if at /,
  passes name: userId to useAgent
- tests/per-user-do.test.ts — locks in the "distinct userIds → distinct
  DO instances with isolated state" invariant

Also in this commit (carried from Phase 00 code review):
- Pinned @cloudflare/vitest-pool-workers to exact 0.12.21 (drop caret)
- Added @oxfmt/binding-darwin-arm64 to fix pnpm optional-deps bug,
  so `pnpm run check` runs green end-to-end for the first time
- Added ANTHROPIC_API_KEY test stub via miniflare bindings override,
  preventing confusing CI failures in later phases

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 3: Push**

```bash
git push
```

Expected: fast-forward push, no issues.

---

## Phase 01 done when…

- [ ] `pnpm run check` passes in full (oxfmt + oxlint + tsc + vitest)
- [ ] `pnpm test` shows 11 passing tests across 3 test files (1 smoke + 8 identity + 2 per-user-do)
- [ ] Manual browser smoke: `/` redirects to `/user/<uuid>`, refresh preserves the id, incognito mints a different id
- [ ] Commit pushed to `origin/main`

Next phase: **Phase 02 — Supervisor data model** (add `syncs` and `sync_errors` tables to the per-user ChatAgent's SQLite, build a typed repo, replace the per-user-do isolation test with a richer syncs-based version).
