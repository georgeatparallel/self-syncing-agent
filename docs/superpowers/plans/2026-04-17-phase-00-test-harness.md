# Phase 00 — Test Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire up Vitest with `@cloudflare/vitest-pool-workers` so subsequent phases can write unit tests (pure logic) and Workers-runtime integration tests (DO + Worker Loader + Facets) with one test command.

**Architecture:** `@cloudflare/vitest-pool-workers` runs tests inside a real `miniflare` Worker environment, letting us instantiate our actual `ChatAgent` DO from tests and hit the Worker's HTTP surface via a `SELF` helper. We configure it to read our existing `wrangler.jsonc` so every DO binding, migration, and env var defined for production also works in tests.

**Tech Stack:** Vitest 2.x, `@cloudflare/vitest-pool-workers`, existing `wrangler.jsonc`.

**Reference:** [`docs/superpowers/specs/2026-04-17-self-syncing-agent-architecture-design.md`](../specs/2026-04-17-self-syncing-agent-architecture-design.md)

---

## File Structure

This phase creates/modifies:

- **Modify** `package.json` — add `vitest` + `@cloudflare/vitest-pool-workers` devDeps; add `test` / `test:watch` scripts
- **Create** `vitest.config.ts` — root-level vitest config pointing the Workers pool at `wrangler.jsonc`
- **Create** `tests/smoke.test.ts` — one smoke test proving the harness works end-to-end against the real Worker
- **Modify** `tsconfig.json` — add Cloudflare test types so test files type-check cleanly

No source code under `src/` changes in this phase. The goal is purely harness setup.

---

## Task 1: Install test dependencies

**Files:**

- Modify: `package.json` (via `pnpm add -D`)

- [ ] **Step 1: Install vitest + Cloudflare Workers pool**

Run this in the project root:

```bash
pnpm add -D vitest@^2 @cloudflare/vitest-pool-workers
```

Expected: `devDependencies` updated to include `vitest` (^2.x.x) and `@cloudflare/vitest-pool-workers` (latest). pnpm-lock.yaml regenerated with no errors.

- [ ] **Step 2: Verify they landed in package.json**

Open `package.json`. The `devDependencies` block should now include two new entries:

```json
    "vitest": "^2.x.x",
    "@cloudflare/vitest-pool-workers": "^x.x.x"
```

If either is missing, rerun Step 1 — don't proceed.

---

## Task 2: Add test scripts to package.json

**Files:**

- Modify: `package.json:13-21` — `"scripts"` block

- [ ] **Step 1: Add `test` and `test:watch` scripts**

Replace the current `"scripts"` block in `package.json` with:

```json
  "scripts": {
    "dev": "vite dev",
    "start": "vite dev",
    "deploy": "vite build && wrangler deploy",
    "types": "wrangler types env.d.ts --include-runtime false",
    "format": "oxfmt --write .",
    "lint": "oxlint src/",
    "check": "oxfmt --check . && oxlint src/ && tsc && vitest run",
    "test": "vitest run",
    "test:watch": "vitest"
  },
```

Two changes: added the `test` and `test:watch` scripts, and appended `&& vitest run` to the existing `check` script so CI-style validation includes tests.

---

## Task 3: Configure Vitest to use the Workers pool

**Files:**

- Create: `vitest.config.ts` (project root)

- [ ] **Step 1: Create `vitest.config.ts` at the project root**

Write the file with exactly this content:

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
          compatibilityFlags: ["nodejs_compat"]
        }
      }
    }
  }
});
```

Why each line:

- `defineWorkersConfig` — the pool's helper that wires everything
- `include` — tests can live in a top-level `tests/` folder or colocated with source as `*.test.ts`
- `singleWorker: true` — runs all tests in one Worker isolate (simpler, avoids cross-test flakiness; fine for our scale)
- `wrangler.configPath` — reuse our real wrangler config so bindings, migrations, and DOs match production
- `compatibilityFlags` — mirrors the flag in `wrangler.jsonc`; required for `nodejs_compat` APIs if any test path touches them

---

## Task 4: Update tsconfig so test files type-check

**Files:**

- Modify: `tsconfig.json` (project root)

- [ ] **Step 1: Replace tsconfig.json content**

Open `tsconfig.json`. It currently reads:

```json
{
  "extends": "agents/tsconfig",
  "compilerOptions": {
    // add your overrides here
  }
}
```

Replace the whole file with:

```json
{
  "extends": "agents/tsconfig",
  "compilerOptions": {
    "types": ["@cloudflare/workers-types", "@cloudflare/vitest-pool-workers"]
  },
  "include": ["src", "tests", "env.d.ts", "vitest.config.ts"]
}
```

Two changes:

- `compilerOptions.types` — adds the pool's ambient types (exposes `SELF`, `env`, etc. from `cloudflare:test` module)
- `include` — ensures TS checks test files and config files, not just `src/`

- [ ] **Step 2: Run type check**

Run:

```bash
pnpm exec tsc --noEmit
```

Expected: no errors. If errors appear related to `cloudflare:test` or `SELF`, the types package wasn't picked up — re-verify the `types` array in tsconfig.

---

## Task 5: Write and run a smoke test

**Files:**

- Create: `tests/smoke.test.ts`

This test validates the harness end-to-end: it spins up the real Worker, sends it an HTTP request, and asserts behavior. It does not yet touch our agent logic — just proves the plumbing works.

- [ ] **Step 1: Create `tests/smoke.test.ts`**

Write the file with exactly this content:

```ts
import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("worker harness smoke test", () => {
  it("responds with 404 to an unknown route", async () => {
    const response = await SELF.fetch(
      "https://example.com/this-path-does-not-exist"
    );

    expect(response.status).toBe(404);
    const body = await response.text();
    expect(body).toBe("Not found");
  });
});
```

Why this particular test:

- Our current `src/server.ts` wires `routeAgentRequest(request, env)` as the only custom handler, and falls through to `new Response("Not found", { status: 404 })` for anything unmatched. That fallthrough is the most stable, assumption-free behavior to lock in as the first test.
- `SELF.fetch` is how `@cloudflare/vitest-pool-workers` exposes the running Worker to tests.
- Any failure in harness setup (missing bindings, DO migrations not applied, wrangler config unreachable) will surface before the assertion — making this a real smoke test, not a tautology.

- [ ] **Step 2: Run tests**

Run:

```bash
pnpm test
```

Expected output (condensed):

```
 ✓ tests/smoke.test.ts (1) ...
   ✓ worker harness smoke test (1) ...
     ✓ responds with 404 to an unknown route

 Test Files  1 passed (1)
      Tests  1 passed (1)
```

If it hangs: the pool may be failing silently on wrangler config parsing. Run with `DEBUG=miniflare*` to see why.

If it fails with "Cannot find module 'cloudflare:test'": the `types` config in `tsconfig.json` wasn't applied — revisit Task 4.

If it fails with a DO migration error: the starter's `"new_sqlite_classes": ["ChatAgent"]` migration should be applied automatically by the pool. If not, add `{"new_classes": ["ChatAgent"]}` fallback and rerun. (This shouldn't be needed but is the first place to look.)

---

## Task 6: Commit Phase 00

**Files:**

- All Phase 00 changes

- [ ] **Step 1: Stage and commit**

```bash
git add package.json pnpm-lock.yaml vitest.config.ts tsconfig.json tests/smoke.test.ts
git status
```

Expected: the five files above staged, nothing else modified.

```bash
git commit -m "$(cat <<'EOF'
Phase 00: wire up Vitest with @cloudflare/vitest-pool-workers

Adds the test harness that later phases depend on:
- vitest@^2 + @cloudflare/vitest-pool-workers as devDeps
- vitest.config.ts using the Workers pool, singleWorker, pointed at
  our real wrangler.jsonc so DO bindings and migrations apply in tests
- tsconfig includes the pool's types (exposes SELF, env, etc. from
  the cloudflare:test module) and covers the tests/ folder
- tests/smoke.test.ts locks in the 404-on-unknown-route behavior as
  the first end-to-end proof the harness works

test and test:watch scripts added; check script now also runs vitest.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 2: Push**

```bash
git push
```

Expected: fast-forward push to origin/main with no issues.

---

## Phase 00 done when…

- [ ] `pnpm test` runs and the smoke test passes
- [ ] `pnpm exec tsc --noEmit` passes with no errors
- [ ] `pnpm run check` (which now also runs `vitest run`) passes
- [ ] Commit is pushed to `main`

Next phase: **Phase 01 — Identity & Routing** (`/user/:userId`, client-minted UUID, chat still works under the new URL shape).
