# Phase D: Agent-Authored Webhook Registration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move upstream webhook registration out of the supervisor and into agent-authored handler code. After this phase, the supervisor contains ZERO per-integration code — signing schemes (Phase C), payload parsing (Phase 08), AND webhook registration all live in the agent-authored `handler.js`. Adding a new integration requires no supervisor changes: the user connects the app via Pipedream, asks the agent, the agent drafts a handler with all four exports. That's the complete thesis of "programmable surface."

**Architecture:**

- The facet wrapper (`FACET_WRAPPER_SOURCE`) gains two new RPC methods: `__registerWebhook(config) → { id, secret }` and `__unregisterWebhook(config) → { ok, reason? }`. Each delegates to an optional handler.js export via the existing `handlerModule` namespace import (added in Phase C). `registerWebhook` is REQUIRED (missing → throw → create_sync fails); `unregisterWebhook` is STRONGLY RECOMMENDED (missing → graceful-skip with warning, so pre-Phase-D legacy syncs can still be deleted).
- The handler contract gains two new exports:
  - `async function registerWebhook(fetch, config): Promise<{ id, secret }>` — called ONCE at create_sync time. `fetch` is the global fetch, routes through the existing HttpGateway→Pipedream proxy, so auth is injected automatically. `config` is `{ callbackUrl, label }`. Returns the upstream's webhook id + signing secret (Linear returns one; for GitHub, the agent generates the secret and passes it to GitHub at creation).
  - `async function unregisterWebhook(fetch, config): Promise<void>` — called by delete_sync. `config` is `{ id, label }` where id is what registerWebhook returned.
- **Flow inversion in `create_sync`:** today's flow is `registerLinearWebhook → DB write → attachFacet`. Phase D inverts the first two: `attachFacet` (with `__supervisorPing` to force compilation and catch handler syntax errors) → `facet.__registerWebhook({callbackUrl, label})` → persist DB row with returned `{id, secret}`. The facet must be compiled before its registerWebhook can be invoked, so the attach moves first. Rollback mirrors: if registerWebhook throws, delete the facet; if persist fails, call `__unregisterWebhook` best-effort on the just-created webhook before deleting the facet.
- **`delete_sync`** swaps `unregisterLinearWebhook` for `facet.__unregisterWebhook`. Missing handler export returns `{ok: false, reason: "no unregister export"}` — delete_sync logs that to sync_errors, tells the user "webhook was not deregistered upstream, clean up manually if needed," and proceeds with local cleanup. Legacy Linear sync can be deleted cleanly this way.
- **`integration` field becomes metadata, not a code selector.** Current `create_sync` input has `integration: z.enum(["linear"])` — hardcoded because the supervisor branched on it. Post-Phase-D: `z.string().min(1)` — freeform label used for UI display ("this is the GitHub sync") and ambient context, never for code routing.
- **`resource_types` field deleted from `create_sync` input.** It was Linear-specific. Each upstream takes a different shape of config (GitHub wants `events` + `owner/repo`, Slack uses Events API subscriptions, Stripe wants `enabled_events`) — no generic flat-string-array captures it. Agent embeds the right shape directly inside `registerWebhook`'s code: Linear's `resourceTypes: ["Issue"]`, GitHub's `events: ["issues"]`, etc. One less input field for the LLM to populate correctly.
- **`LINEAR_ACCESS_TOKEN` dies.** Removed from `Env` type, `wrangler.jsonc`, `.dev.vars`, and as a prod secret. Linear auth now rides through the user's Pipedream-connected Linear account (injected by the HttpGateway just like any other integration). The `src/integrations/linear-api.ts` module is deleted.

**Tech Stack:** Cloudflare Workers Durable Object Facets, Worker Loader dynamic bundles, agent-authored JS modules running inside per-sync isolates, Pipedream Connect for credential injection on the outbound path. No new dependencies.

**Branch:** `feat/pipedream` (continuing from Phase C).

---

## File Structure

**New files:** none.

**Modified files:**

- `src/facet/wrapper.ts` — extend `FACET_WRAPPER_SOURCE` with two new methods:
  - `async __registerWebhook(config)` — throws if `handlerModule.registerWebhook` isn't a function (REQUIRED export). On success, returns whatever the handler returned (the supervisor validates shape at the call site). Errors bubble as-is (different from `__verifySignature`'s fail-closed-to-false) because create_sync needs to see WHY registration failed to give the user a meaningful error.
  - `async __unregisterWebhook(config)` — if `handlerModule.unregisterWebhook` isn't a function, returns `{ ok: false, reason: "no_unregister_export" }`. Otherwise awaits it and returns `{ ok: true }` on success, `{ ok: false, reason: "threw", detail: <message> }` on throw. delete_sync gracefully handles both non-ok shapes.
- `src/facet/bundle.test.ts` — regex assertions: `/async __registerWebhook\(/` and `/async __unregisterWebhook\(/`.
- `src/agent/tools/write/create-sync.ts` — significant rewrite:
  - Remove imports of `registerLinearWebhook`, `unregisterLinearWebhook`, `LinearApiError` from `../../../integrations/linear-api`.
  - Input schema: change `integration` from `z.enum(["linear"])` to `z.string().min(1)`. Remove `resource_types` field entirely.
  - Execute flow: generate sync_id → compute callbackUrl + label → attach facet with a temporary `NewSync` record that has placeholder webhook id/secret → `__supervisorPing` (catches compile errors) → `facet.__registerWebhook({callbackUrl, label})` → persist DB row with returned `{id, secret}` → return success. Rollback: if ping or registerWebhook fails, delete facet; if persist fails after register succeeds, call `facet.__unregisterWebhook` best-effort, then delete facet.
  - The temporary-NewSync-with-placeholder challenge: `attachFacet` currently takes a `Sync` row. We need to attach BEFORE we have webhook_secret. Two options — (a) extend attachFacet to accept a preliminary record without webhook_secret (but then the facet has no secret for its fetch path — actually fine, verifySignature reads `secret` as a call arg, not from the bundle), or (b) reorganize `attachFacet` callers. Pick (a): the facet's compiled bundle doesn't actually embed the webhook_secret anywhere — the secret lives in the DB row and is passed to `__verifySignature` at call time. So attaching with an empty-string webhook_secret is harmless; the supervisor just has to remember to persist the REAL secret after registerWebhook returns.
- `src/agent/tools/write/create-sync.test.ts` — tests updated:
  - Mock `facet.__registerWebhook` to return `{id: "wh_test", secret: "sec_test"}`; assert the DB row has those values.
  - Test rollback: `__registerWebhook` throws → DB row not created + facet deleted.
  - Test rollback: DB persist fails after registerWebhook succeeds → `__unregisterWebhook` called before facet delete.
  - Remove any tests that mock the Linear-API module.
- `src/agent/tools/write/delete-sync.ts` — swap logic:
  - Remove imports from `../../../integrations/linear-api`.
  - Replace the `unregisterLinearWebhook` call with `facet.__unregisterWebhook({ id: sync.upstream_webhook_id, label })`. If the RPC returns `{ok: false, reason}`, log to sync_errors with a descriptive message ("webhook cleanup skipped: <reason>"), continue with facet delete + DB cleanup. Don't short-circuit — the user wants the sync gone locally regardless.
  - Need to ATTACH the facet before calling `__unregisterWebhook` (the facet may have been evicted since its last use). `attachFacet(...)` just before the RPC call.
- `src/agent/tools/write/delete-sync.test.ts` — tests updated:
  - Mock `__unregisterWebhook` returning `{ok: true}`, `{ok: false, reason: "no_unregister_export"}`, `{ok: false, reason: "threw", detail: "..."}`. Verify local cleanup still happens in all three cases.
- `src/agent/tools/write/update-sync.ts` — tool description only: `handler_code` zod description extended to mention all FOUR exports (verifySignature, handleWebhook, registerWebhook, unregisterWebhook — the last two frozen after create_sync; update_sync can change them but the upstream webhook registration itself doesn't re-run, so changing registerWebhook's code has no effect until delete+recreate). Noted as a known limitation.
- `src/agent/tools/write/create-sync.ts` tool description — rewritten to document all FOUR exports with Linear AND GitHub examples, so the agent has two concrete patterns for different API styles (GraphQL vs REST; upstream-generates-secret vs caller-provides-secret).
- `worker-configuration.d.ts` (or wherever `Env` is declared) — remove `LINEAR_ACCESS_TOKEN: string` from the env interface. Run `npx wrangler types` to regenerate if auto-generated, or manually edit if hand-written.
- `wrangler.jsonc` — if `LINEAR_ACCESS_TOKEN` appears in a `vars` section, remove it. (It may only be a secret via `wrangler secret put`, in which case nothing to change in the JSONC.)
- `.dev.vars` — remove the `LINEAR_ACCESS_TOKEN=...` line.

**Deleted files:**

- `src/integrations/linear-api.ts`
- `src/integrations/linear-api.test.ts` (if it exists — implementer should check)
- Parent `src/integrations/` directory if it becomes empty.

**Prod cleanup (manual, post-merge):**

- `wrangler secret delete LINEAR_ACCESS_TOKEN` on the production `self-syncing-agent` worker after Phase D deploys. Documented in Task 6's smoke notes — not automated.

---

## Task 1: Wrapper `__registerWebhook` + `__unregisterWebhook` RPCs

**Files:**

- Modify: `src/facet/wrapper.ts`
- Modify: `src/facet/bundle.test.ts`

**Context:** Same pattern as Phase C's `__verifySignature`: delegate to an optional handler.js export via the existing `handlerModule` namespace import. Two semantic differences from `__verifySignature`:

1. **`__registerWebhook` does NOT fail-closed.** If the handler doesn't export `registerWebhook`, we THROW (the supervisor catches and returns a clean tool-call error with the message "handler.js missing required export: registerWebhook"). Reason: during create_sync, missing registerWebhook is unrecoverable and the agent needs the exact error message to fix the handler. Fail-closed-to-false would confuse the rollback logic (it'd look like a legitimate registration that returned garbage).
2. **`__unregisterWebhook` fails soft with reason codes.** Missing export → `{ok: false, reason: "no_unregister_export"}`. Thrown error → `{ok: false, reason: "threw", detail: message}`. Success → `{ok: true}`. delete_sync reads the reason and decides how to surface it.

The supervisor is responsible for validating the SHAPE of what `registerWebhook` returns — i.e., checking that the result has `id: string` and `secret: string`. The wrapper just passes through whatever the handler returned.

- [ ] **Step 1: Update the wrapper source**

In `src/facet/wrapper.ts`, extend the `App` class inside `FACET_WRAPPER_SOURCE` with the two new methods. Placement: after `__verifySignature`, before the closing `}` of the class. The namespace import `import * as handlerModule from "./handler.js"` is already in place from Phase C.

Also update the top-of-file jsdoc block to document the new responsibilities (`__registerWebhook` and `__unregisterWebhook`) and the new handler contract (required `registerWebhook` export + optional `unregisterWebhook` export).

New methods:

```js
async __registerWebhook(config) {
  if (typeof handlerModule.registerWebhook !== "function") {
    throw new Error("handler.js missing required export: registerWebhook");
  }
  // fetch is globally available inside the facet; routes through the same
  // HttpGateway→Pipedream proxy the handler uses. Pass it in so the agent's
  // code has an explicit parameter rather than depending on the global.
  return await handlerModule.registerWebhook(fetch, config);
}

async __unregisterWebhook(config) {
  if (typeof handlerModule.unregisterWebhook !== "function") {
    return { ok: false, reason: "no_unregister_export" };
  }
  try {
    await handlerModule.unregisterWebhook(fetch, config);
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      reason: "threw",
      detail: e instanceof Error ? e.message : String(e)
    };
  }
}
```

- [ ] **Step 2: Add regex assertions**

In `src/facet/bundle.test.ts`, find the test that asserts `__verifySignature` appears in the wrapper source (renamed in Phase C to "wrapper source exposes __query, __sqlExec, __verifySignature, and #ensureSchema"). Rename it again to include the two new methods, and add two new assertions:

```ts
expect(main).toMatch(/async __registerWebhook\(/);
expect(main).toMatch(/async __unregisterWebhook\(/);
```

- [ ] **Step 3: Run tests**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npx vitest run src/facet/bundle.test.ts`
Expected: PASS.

- [ ] **Step 4: Typecheck**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/facet/wrapper.ts src/facet/bundle.test.ts
git commit -m "feat(facet): __registerWebhook + __unregisterWebhook RPCs"
```

---

## Task 2: Rewire `create_sync` execute flow

**Files:**

- Modify: `src/agent/tools/write/create-sync.ts`
- Modify: `src/agent/tools/write/create-sync.test.ts`

**Context:** The largest behavior change in Phase D. The existing create_sync execute (src/agent/tools/write/create-sync.ts:104-213) does:

1. Check PUBLIC_BASE_URL is set.
2. Check sync name uniqueness.
3. Call `registerLinearWebhook` (network) → get {id, secret}.
4. Build NewSync record with secret + upstream_webhook_id; call `createSync` (DB write).
5. Attach facet + `__supervisorPing` (compile check). On failure: rollback DB + Linear.

Phase D inverts 3 and 4, and swaps the Linear-specific registerLinearWebhook for a facet RPC:

1. Check PUBLIC_BASE_URL is set (unchanged).
2. Check name uniqueness (unchanged).
3. Build a preliminary NewSync with placeholder `webhook_secret: ""` and `upstream_webhook_id: ""`. Attach facet with that record. `__supervisorPing` to compile + catch syntax errors. (This is the "temporary attach" — we need the facet live to call its registerWebhook.)
4. Call `facet.__registerWebhook({callbackUrl, label})` (network via Pipedream proxy). Validate the return shape: `{id: string, secret: string}`. If shape is wrong, throw a descriptive error.
5. Persist DB row with the real `{id, secret}` values. `createSync(sql, finalNewSync)`.
6. Return `{ok: true, sync_id, upstream_webhook_id: id}`.

Rollback points:
- `__supervisorPing` throws (compile error) → `agent.ctx.facets.delete(name)`, return `{ok: false, error: "facet_load_failed", detail}`.
- `__registerWebhook` throws → `agent.ctx.facets.delete(name)`, return `{ok: false, error: "webhook_register_failed", detail}`.
- `__registerWebhook` returns bad shape → same as throw.
- `createSync` throws (e.g., race on name uniqueness) → best-effort call `facet.__unregisterWebhook({id, label})` first, then `agent.ctx.facets.delete(name)`, return `{ok: false, error: "persist_failed", detail}`. If the unregister itself returns `{ok: false}`, just log the reason — we still want to delete the facet and return the persist-failed error.

The `NewSync` type currently requires `webhook_secret` and `upstream_webhook_id`. For Phase D's preliminary attach, pass empty strings — the facet bundle doesn't bake these into anything (the secret is an argument to `__verifySignature` at call time, and the upstream_webhook_id is stored only in the DB). Verify this assumption by reading `src/facet/loader.ts` — confirm `attachFacet` doesn't embed `webhook_secret` anywhere in the bundle.

### Input schema change

Replace:

```ts
integration: z.enum(["linear"]).describe("Upstream integration identifier."),
resource_types: z
  .array(z.string().min(1))
  .min(1)
  .describe("Upstream resource types to subscribe the webhook to..."),
```

With:

```ts
integration: z
  .string()
  .min(1)
  .describe(
    "Human-readable label for the upstream service (e.g., 'linear', 'github', 'slack'). Used for UI display and ambient context — not a code selector, you can use any slug you want as long as it's consistent within the user's sync list."
  ),
// resource_types field removed entirely; the agent encodes which events to
// subscribe to inside registerWebhook's code (Linear's resourceTypes,
// GitHub's events, etc.).
```

### Imports to remove

Delete these lines at the top of `src/agent/tools/write/create-sync.ts`:

```ts
import {
  registerLinearWebhook,
  unregisterLinearWebhook,
  LinearApiError
} from "../../../integrations/linear-api";
```

And remove the `safeUnregister` helper at the bottom of the file — its only caller was the old rollback path.

### Test updates

Open `src/agent/tools/write/create-sync.test.ts` and find the tests that mock `registerLinearWebhook`. They need to be rewritten to mock the facet's `__registerWebhook` and `__supervisorPing` via the existing `installFakeFacets` pattern (same pattern as webhook-delivery.test.ts). A fake that returns `{id: "wh_test", secret: "sec_test"}`:

```ts
installFakeFacets(instance, {
  get() {
    return {
      fetch: async () => new Response("ok", { status: 200 }),
      __supervisorPing: async () => {},
      __verifySignature: async () => true,
      __registerWebhook: async () => ({ id: "wh_test", secret: "sec_test" }),
      __unregisterWebhook: async () => ({ ok: true })
    };
  },
  abort: () => {},
  delete: () => {}
});
```

Then assertions: after create_sync returns `{ok: true}`, verify `getSyncById(sql, sync_id).upstream_webhook_id === "wh_test"` and `.webhook_secret === "sec_test"`.

**Rollback tests to add (three scenarios):**

1. `__supervisorPing` throws → result is `{ok: false, error: "facet_load_failed"}`, no DB row exists, facet was deleted.
2. `__registerWebhook` throws → result is `{ok: false, error: "webhook_register_failed"}`, no DB row, facet deleted. `__unregisterWebhook` was NOT called (nothing to unregister).
3. `createSync` (DB write) throws after `__registerWebhook` succeeded → result is `{ok: false, error: "persist_failed"}`, `__unregisterWebhook` was called with the just-registered id, facet deleted. (To trigger a createSync throw in the test, seed a conflicting sync with the same `name` in setup so the UNIQUE constraint fires.)

- [ ] **Step 1: Verify the facet-loader assumption**

Read `src/facet/loader.ts`. Confirm `attachFacet` does NOT embed `webhook_secret` or `upstream_webhook_id` anywhere in the compiled bundle. If it does, flag as BLOCKED — the preliminary-attach strategy won't work and we need a redesign.

- [ ] **Step 2: Rewrite create_sync execute**

Apply the schema changes, import changes, flow restructure, and safeUnregister removal per above.

- [ ] **Step 3: Rewrite the tests**

Replace Linear-API mocks with fake-facets. Add the three rollback tests.

- [ ] **Step 4: Run tests**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npx vitest run src/agent/tools/write/create-sync.test.ts`
Expected: PASS.

- [ ] **Step 5: Run full check**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npm run check`
Expected: NEAR-green. It will fail because `tests/create-sync-integration.test.ts` (the integration test) may still use the old signature. Check if it exists and update it the same way if so. `tsc` may also fail because `src/integrations/linear-api.ts` still exists and the delete_sync tool still imports from it — that's fixed in Task 3.

If the only failures are in `delete-sync.ts` / `delete-sync.test.ts` / `src/integrations/linear-api.ts` (Task 3 / Task 5 territory), proceed. Otherwise fix here.

- [ ] **Step 6: Commit**

```bash
git add src/agent/tools/write/create-sync.ts src/agent/tools/write/create-sync.test.ts tests/create-sync-integration.test.ts
git commit -m "feat(create_sync): delegate webhook registration to handler"
```

---

## Task 3: Rewire `delete_sync` to use `__unregisterWebhook`

**Files:**

- Modify: `src/agent/tools/write/delete-sync.ts`
- Modify: `src/agent/tools/write/delete-sync.test.ts`

**Context:** delete_sync currently imports `unregisterLinearWebhook` from the Linear module. Swap it for `facet.__unregisterWebhook({id, label})`. The facet may have been evicted since last use, so call `attachFacet` first.

New flow (replacing lines 29-43 of the current delete-sync.ts):

```ts
// 1. Unregister upstream webhook via the handler's unregisterWebhook
//    export. Graceful-skip if the handler lacks the export (legacy sync
//    from pre-Phase-D days) or if the call throws — local cleanup
//    proceeds regardless; user can clean up upstream manually if needed.
if (sync.upstream_webhook_id) {
  const facet = attachFacet(agent.env, agent.ctx.facets, sync, agent.name);
  const unregResult = await (
    facet as unknown as {
      __unregisterWebhook(config: {
        id: string;
        label: string;
      }): Promise<
        | { ok: true }
        | { ok: false; reason: string; detail?: string }
      >;
    }
  ).__unregisterWebhook({
    id: sync.upstream_webhook_id,
    label: `self-syncing-agent:${agent.name.slice(0, 8)}:${sync.name}`
  });
  if (!unregResult.ok) {
    // Log the skip so the user sees it in sync_errors / ops panel
    // context. This is informational, not a hard failure — delete
    // continues.
    logSyncError(sql, {
      sync_id,
      payload_preview: null,
      error_message: `webhook upstream cleanup skipped: ${unregResult.reason}${
        unregResult.detail ? ` (${unregResult.detail})` : ""
      }`,
      stack_trace: null,
      handler_version: sync.version
    });
  }
}
```

Note: `logSyncError` needs to be imported if it isn't already. The label format matches what create_sync used in Phase A/B (`self-syncing-agent:{userId.slice(0,8)}:{name}`).

The catch-block for `LinearApiError` disappears — no more Linear-specific errors.

### Test updates

Open `src/agent/tools/write/delete-sync.test.ts`. Tests that mocked `unregisterLinearWebhook` need to mock `__unregisterWebhook` via `installFakeFacets`. Add three test scenarios:

1. `__unregisterWebhook` returns `{ok: true}` → no sync_errors row logged, local cleanup happens, returns `{ok: true}`.
2. `__unregisterWebhook` returns `{ok: false, reason: "no_unregister_export"}` → ONE sync_errors row with message matching `/webhook upstream cleanup skipped: no_unregister_export/`, local cleanup still happens, returns `{ok: true}`.
3. `__unregisterWebhook` returns `{ok: false, reason: "threw", detail: "network error"}` → ONE sync_errors row matching `/threw.*network error/`, local cleanup still happens, returns `{ok: true}`.

Note the asymmetry with the current behavior: pre-Phase-D, a failing `unregisterLinearWebhook` returned `{ok: false}` and aborted the delete. Post-Phase-D, it logs and continues. Rationale: the user ran delete_sync because they want this sync gone. A network failure upstream shouldn't leave them with a half-deleted sync in the UI.

- [ ] **Step 1: Update delete-sync.ts**

Remove Linear imports. Add `attachFacet` + `logSyncError` imports. Restructure the unregister step per above.

- [ ] **Step 2: Update delete-sync.test.ts**

Replace Linear-API mocks with fake-facets. Add the three scenarios.

- [ ] **Step 3: Run tests**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npx vitest run src/agent/tools/write/delete-sync.test.ts`
Expected: PASS.

- [ ] **Step 4: Run full check**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npm run check`
Expected: still failing on `src/integrations/linear-api.ts` being unreferenced from src/ but its test file still running — fixed in Task 5. If other errors, fix here.

- [ ] **Step 5: Commit**

```bash
git add src/agent/tools/write/delete-sync.ts src/agent/tools/write/delete-sync.test.ts
git commit -m "feat(delete_sync): delegate webhook cleanup to handler, graceful-skip on missing export"
```

---

## Task 4: Teach the agent — tool descriptions + system-prompt nudge

**Files:**

- Modify: `src/agent/tools/write/create-sync.ts` (tool description only)
- Modify: `src/agent/tools/write/update-sync.ts` (tool description only)
- Modify: `src/agent/system-prompt.ts` (minor addition)

**Context:** The create_sync tool description currently documents two required exports (Phase C). Now it documents FOUR — two required (verifySignature, handleWebhook, registerWebhook) and one strongly recommended (unregisterWebhook). Wait — that's three required. Let me restate:

- `verifySignature` — REQUIRED.
- `handleWebhook` — REQUIRED.
- `registerWebhook` — REQUIRED.
- `unregisterWebhook` — STRONGLY RECOMMENDED. Missing → upstream cleanup skipped on delete_sync, user warned.

The example in the tool description grows to show all four exports for one integration (Linear). A second example (GitHub) illustrates the REST + caller-provides-secret pattern, which is stylistically different enough from Linear's GraphQL + upstream-provides-secret pattern that the LLM benefits from seeing both.

### create_sync description — the new block

Replace the existing description template literal (starts at line 15 of create-sync.ts currently). The new block:

```
Create a new sync. Compiles the agent-authored handler into an isolated facet runtime with its own SQLite, applies the schema DDL, calls the handler's registerWebhook export to register the webhook with the upstream service, and persists the sync registry row. Approval-gated — the user sees the drafted schema_ddl and handler_code in the approval dialog before anything runs. Call this AFTER you've shown the draft in chat.

handler_code contract: JavaScript module source that MUST export FOUR async functions (the last one is technically optional but strongly recommended for clean deletes).

1) \`async function verifySignature(body, headers, secret): Promise<boolean>\`
   Called BEFORE handleWebhook on every delivery. Return true to accept, false (or throw) to reject with 401.
   - body: Uint8Array of raw request body
   - headers: Record<string, string> with lowercased keys
   - secret: the secret returned from registerWebhook
   REQUIRED. Missing → every delivery 401s.

2) \`async function handleWebhook(request, sql, ctx): Promise<Response>\`
   Called AFTER signature has been verified.
   - request: raw webhook POST
   - sql: the facet's own SQLite. sql.exec(query, ...bindings) for writes; sql.exec(...).toArray() for reads.
   - ctx: { waitUntil, agent } — waitUntil for background work; ctx.agent({model, system, messages, maxSteps}) for sub-agent ReAct loops inside the delivery.
   Return a 2xx Response on success. Be idempotent (INSERT OR REPLACE keyed on stable upstream id).
   REQUIRED.

3) \`async function registerWebhook(fetch, config): Promise<{ id: string, secret: string }>\`
   Called ONCE at create_sync time to register the webhook with the upstream.
   - fetch: the global fetch, routes through the Pipedream credential-injecting proxy — auth headers are injected automatically for Pipedream-connected apps. You do NOT set Authorization headers yourself.
   - config: { callbackUrl: string, label: string } — callbackUrl is the URL the upstream should POST to; label is a human-readable tag.
   - Returns: { id: string, secret: string } — id used for later unregister; secret used by verifySignature. How you obtain \`secret\` depends on the upstream:
     - Some upstreams (Linear) return the secret from their webhookCreate mutation.
     - Others (GitHub) require you to generate a random secret and pass it at creation.
   REQUIRED. A thrown error or wrong return shape aborts create_sync.

4) \`async function unregisterWebhook(fetch, config): Promise<void>\`
   Called from delete_sync.
   - fetch: same proxy as above.
   - config: { id: string, label: string } where id is what registerWebhook returned.
   STRONGLY RECOMMENDED. If omitted, delete_sync deletes the local sync but leaves the upstream webhook registered (the user will see it in the upstream's dashboard and clean up manually). Provide this unless you know the upstream auto-cleans stale webhooks.

Handler-level guidance:
- No imports beyond the parameters. \`fetch\` and \`crypto\` are global; \`Date\`, \`TextEncoder\`, etc. work normally.
- Keep handleWebhook fast. Upstream timeouts are typically 5–30s. For longer reasoning, \`ctx.waitUntil(ctx.agent(...))\`.
- Include a \`created_at INTEGER NOT NULL\` column on every table (populated with \`Date.now()\` at INSERT) so debugging is tractable (see the system prompt's 401-triage rubric).
- For unfamiliar integrations: use the probe loop from the system prompt. Don't guess signing schemes, payload shapes, or webhook-creation APIs from training data.

Example 1 — Linear (GraphQL, upstream-generates-secret):

\`\`\`js
const LINEAR_API = "https://api.linear.app/graphql";

export async function registerWebhook(fetch, { callbackUrl, label }) {
  const res = await fetch(LINEAR_API, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query: \`mutation($url: String!, $types: [String!]!, $label: String!) {
        webhookCreate(input: { url: $url, resourceTypes: $types, allPublicTeams: true, label: $label }) {
          success webhook { id secret }
        }
      }\`,
      variables: { url: callbackUrl, types: ["Issue"], label }
    })
  });
  const body = await res.json();
  if (!body.data?.webhookCreate?.success) {
    throw new Error("Linear webhookCreate failed: " + JSON.stringify(body));
  }
  const wh = body.data.webhookCreate.webhook;
  return { id: wh.id, secret: wh.secret };
}

export async function unregisterWebhook(fetch, { id }) {
  const res = await fetch(LINEAR_API, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query: \`mutation($id: String!) { webhookDelete(id: $id) { success } }\`,
      variables: { id }
    })
  });
  const body = await res.json();
  if (!body.data?.webhookDelete?.success) {
    throw new Error("Linear webhookDelete failed: " + JSON.stringify(body));
  }
}

export async function verifySignature(body, headers, secret) {
  const sig = headers["linear-signature"];
  if (!sig) return false;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const computed = await crypto.subtle.sign("HMAC", key, body);
  const hex = [...new Uint8Array(computed)].map(b => b.toString(16).padStart(2, "0")).join("");
  return hex === sig;
}

export async function handleWebhook(request, sql, ctx) {
  const payload = await request.json();
  const issue = payload.data;
  sql.exec(
    "INSERT OR REPLACE INTO issues (id, title, priority, created_at) VALUES (?, ?, ?, ?)",
    issue.id, issue.title, issue.priority, Date.now()
  );
  return new Response("ok", { status: 200 });
}
\`\`\`

Example 2 — GitHub (REST, caller-provides-secret):

\`\`\`js
// Substitute OWNER/REPO with whatever the user asked to track.
const GH_API = "https://api.github.com/repos/OWNER/REPO/hooks";

export async function registerWebhook(fetch, { callbackUrl, label }) {
  // GitHub requires the caller to provide the secret at creation.
  // Generate a random one; we return it so the supervisor persists it
  // for verifySignature to use later.
  const secret = crypto.randomUUID() + crypto.randomUUID(); // ~256 bits

  const res = await fetch(GH_API, {
    method: "POST",
    headers: { "content-type": "application/json", "accept": "application/vnd.github+json" },
    body: JSON.stringify({
      name: "web",
      active: true,
      events: ["issues"],
      config: { url: callbackUrl, content_type: "json", secret, insecure_ssl: "0" }
    })
  });
  if (!res.ok) throw new Error("GitHub webhook create failed: " + res.status + " " + await res.text());
  const body = await res.json();
  return { id: String(body.id), secret };
}

export async function unregisterWebhook(fetch, { id }) {
  const res = await fetch(\`\${GH_API}/\${id}\`, { method: "DELETE" });
  // GitHub returns 204 on success, 404 if already gone — both fine.
  if (!res.ok && res.status !== 404) {
    throw new Error("GitHub webhook delete failed: " + res.status);
  }
}

export async function verifySignature(body, headers, secret) {
  const sig = headers["x-hub-signature-256"];
  if (!sig || !sig.startsWith("sha256=")) return false;
  const expected = sig.slice("sha256=".length);
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const computed = await crypto.subtle.sign("HMAC", key, body);
  const hex = [...new Uint8Array(computed)].map(b => b.toString(16).padStart(2, "0")).join("");
  return hex === expected;
}

export async function handleWebhook(request, sql, ctx) {
  const payload = await request.json();
  if (payload.action !== "opened" && payload.action !== "edited") {
    return new Response("ignored", { status: 200 });
  }
  const issue = payload.issue;
  sql.exec(
    "INSERT OR REPLACE INTO issues (id, number, title, state, created_at) VALUES (?, ?, ?, ?, ?)",
    issue.id, issue.number, issue.title, issue.state, Date.now()
  );
  return new Response("ok", { status: 200 });
}
\`\`\`
```

### create_sync zod descriptions

Update these two (already touched in Phase C):

```ts
integration: z
  .string()
  .min(1)
  .describe(
    "Human-readable label for the upstream service (e.g., 'linear', 'github', 'slack'). Freeform — used for UI display and ambient context, not as a code selector. Use a consistent slug across the user's sync list."
  ),
```

The `resource_types` field is deleted — not replaced.

`handler_code` zod description updated:

```ts
handler_code: z
  .string()
  .describe(
    "JavaScript module source exporting FOUR async functions: `verifySignature(body, headers, secret)`, `handleWebhook(request, sql, ctx)`, `registerWebhook(fetch, config)` (all required), and `unregisterWebhook(fetch, config)` (strongly recommended). See the tool description for the full contract and worked examples for Linear + GitHub."
  ),
```

### update_sync description

In `src/agent/tools/write/update-sync.ts`, update the `handler_code` zod description:

```ts
handler_code: z
  .string()
  .min(1)
  .optional()
  .describe(
    "New handler.js source. Must export `verifySignature`, `handleWebhook`, `registerWebhook` (all required), and ideally `unregisterWebhook` — see create_sync's description for the full contract. NOTE: registerWebhook's CODE can be updated here but the upstream webhook REGISTRATION itself doesn't re-run — changing which resource types you subscribe to requires delete_sync + create_sync. Update update_sync is for handler logic (signature verification, payload handling) and schema evolution. Omit if handler isn't changing."
  ),
```

### System-prompt nudge

In `src/agent/system-prompt.ts`, find the "## Creating a sync" section (around line 40). Extend the first bullet to mention that the agent now owns upstream registration:

```
1. **Restate and clarify.** "Track all Linear issues" vs "only high-priority bugs" is a real difference — ask when the scope is ambiguous. For integrations that scope webhooks per-resource (GitHub is per-repo, Slack is per-channel), ask which specific resource the user wants tracked — this information is baked into your registerWebhook code and is immutable for the sync's lifetime (delete + recreate to change).
```

And in the tools listing (around line 25), the `create_sync` description one-liner changes from "registers a webhook with the upstream, spins up an isolated facet" to:

```
- \`create_sync(name, integration, schema_ddl, handler_code, filter_description?)\` — compiles the agent-authored handler into an isolated facet, calls the handler's registerWebhook export to register the upstream webhook, and persists the sync registry row.
```

(`resource_types` removed from the arglist.)

- [ ] **Step 1: Update create-sync.ts description + zod shapes**

- [ ] **Step 2: Update update-sync.ts description**

- [ ] **Step 3: Update system-prompt.ts**

- [ ] **Step 4: Run tests**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npx vitest run src/agent/tools/write/create-sync.test.ts src/agent/tools/write/update-sync.test.ts`
Expected: PASS.

- [ ] **Step 5: Run full check**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npm run check`
Expected: fully green except any lingering Linear-API imports (Task 5).

- [ ] **Step 6: Commit**

```bash
git add src/agent/tools/write/create-sync.ts src/agent/tools/write/update-sync.ts src/agent/system-prompt.ts
git commit -m "feat(agent): document four-export handler contract + GitHub example"
```

---

## Task 5: Delete `src/integrations/linear-api.ts` + clean up env

**Files:**

- Delete: `src/integrations/linear-api.ts`
- Delete: `src/integrations/linear-api.test.ts` (if exists)
- Delete: `src/integrations/` directory (if empty after the above)
- Modify: `worker-configuration.d.ts` (or wherever `Env` is declared)
- Modify: `.dev.vars`
- Modify: `wrangler.jsonc` (only if `LINEAR_ACCESS_TOKEN` is listed there)

**Context:** After Tasks 2 and 3, no production code imports from `src/integrations/linear-api.ts`. Delete it and remove the env var everywhere.

- [ ] **Step 1: Grep to verify no remaining imports**

Grep for `linearAuthHeader`, `registerLinearWebhook`, `unregisterLinearWebhook`, `LinearApiError`, `integrations/linear-api`, and `LINEAR_ACCESS_TOKEN` across `src/` and `tests/`. Only hits should be inside the files you're about to delete, and `LINEAR_ACCESS_TOKEN` in `.dev.vars` / `worker-configuration.d.ts`.

- [ ] **Step 2: Delete the files**

```bash
rm src/integrations/linear-api.ts
rm -f src/integrations/linear-api.test.ts
rmdir src/integrations 2>/dev/null || true
```

- [ ] **Step 3: Remove LINEAR_ACCESS_TOKEN from Env type**

Read `worker-configuration.d.ts`. If `LINEAR_ACCESS_TOKEN: string` appears in the generated `Env` interface, either:
- Run `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npx wrangler types` to regenerate (if wrangler auto-generates it from secrets+vars), OR
- Manually delete the line (if it's hand-written).

Check whether `wrangler types` regeneration is the right path by reading the top of the file — if it starts with `// Generated by Wrangler`, use the regenerate path; otherwise manual delete.

- [ ] **Step 4: Remove from .dev.vars**

Open `.dev.vars`, delete the line starting with `LINEAR_ACCESS_TOKEN=`. Verify other secrets stay.

- [ ] **Step 5: Check wrangler.jsonc**

If `LINEAR_ACCESS_TOKEN` appears in a `vars` or similar section of `wrangler.jsonc`, remove it. In our current config it's not there (it's a prod secret), so likely no-op.

- [ ] **Step 6: Run full check**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npm run check`
Expected: fully green. Zero per-integration code in the supervisor now.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore(linear): delete integrations/linear-api + drop LINEAR_ACCESS_TOKEN env"
```

---

## Task 6: Manual smoke — migrate legacy sync, demo GitHub end-to-end

**Files:** none (manual verification).

**Context:** Phase D's payoff demo — a fresh GitHub sync created end-to-end without touching the supervisor. Plus verify the legacy Linear sync deletes cleanly via the graceful-skip path.

- [ ] **Step 1: Start dev server**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npm run dev`

- [ ] **Step 2: Delete the pre-Phase-D Linear sync (exercise graceful-skip)**

In chat:

> "Delete the linear-high-urgent-issues sync."

Approve when prompted. Expected:
- delete_sync attaches the facet, calls `__unregisterWebhook`.
- The legacy handler doesn't have `unregisterWebhook` OR it might (if you migrated it with the verifySignature update in Phase C). Whichever.
  - If no unregister export: wrapper returns `{ok: false, reason: "no_unregister_export"}`, delete_sync logs a sync_errors row ("webhook upstream cleanup skipped: no_unregister_export"), proceeds with local delete.
  - If unregister is present and works: all quiet, clean delete.
- In EITHER case, the sync row + facet + SQLite are gone; the upstream webhook in Linear's dashboard may still exist (if graceful-skipped).

Verify: go to Linear's webhook settings page for your workspace. If the webhook labeled `self-syncing-agent:...:linear-high-urgent-issues` is still listed, delete it manually.

Ask agent: `list_syncs` → empty or just non-Linear syncs.

- [ ] **Step 3: Connect GitHub via the Connections panel**

If not already connected from Phase B smoke, click the Connections panel, pick GitHub, complete the Pipedream OAuth flow. Verify `github apn_...` appears in the connections list.

- [ ] **Step 4: Ask the agent to create a GitHub sync**

In chat:

> "Create a sync that tracks opened and edited issues in my rtpa25/<some-public-repo-of-yours> GitHub repo. Store them in a table with id, number, title, state, created_at. Use the GitHub webhook example in create_sync's description as a template."

The agent should draft schema_ddl and handler_code in chat (all four exports, GitHub REST pattern). You approve. create_sync execute:

1. Attach facet, __supervisorPing compiles the bundle.
2. `facet.__registerWebhook({callbackUrl: "...PUBLIC_BASE_URL.../webhook/<userId>/<syncId>", label: "self-syncing-agent:<prefix>:<name>"})`.
   - Agent's registerWebhook POSTs to `https://api.github.com/repos/<owner>/<repo>/hooks`.
   - Request routes through HttpGateway → Pipedream proxy → GitHub with user's connected GitHub token.
   - GitHub returns `{id: <number>, config: {...}}`. Agent returns `{id: String(body.id), secret: <the secret it generated>}`.
3. DB row persists with the returned id + secret.
4. Tool returns `{ok: true, sync_id, upstream_webhook_id}`.

Expected: tool call succeeds. Verify the webhook exists in the GitHub repo's settings → Webhooks page.

- [ ] **Step 5: Trigger a real GitHub event**

In that GitHub repo, open a new issue (e.g., "Phase D smoke test"). GitHub fires a webhook delivery.

Watch the wrangler logs. Expected:
- POST lands on `/webhook/<userId>/<syncId>`.
- Supervisor's `handleWebhookDelivery` attaches facet, calls `__verifySignature(body, headers, secret)`.
- Agent's verifySignature computes HMAC-SHA256 of body with the GitHub-provided secret, compares to `x-hub-signature-256` header. Should return true.
- Handler runs, INSERT into issues table, returns 200.
- Supervisor 200s to GitHub.

Verify in chat:

> "query_sync the github-<name> sync: SELECT id, number, title, state, created_at FROM issues."

Expected: your newly-created issue appears.

- [ ] **Step 6: Delete the GitHub sync (exercise happy-path unregister)**

> "Delete the github-<name> sync."

Approve. Expected:
- delete_sync attaches facet, calls `__unregisterWebhook({id: <github webhook id>, label: ...})`.
- Agent's unregisterWebhook DELETEs the webhook via GitHub API.
- Returns `{ok: true}`.
- Local facet deleted, DB row deleted.

Verify in GitHub repo's webhook settings: the webhook is gone.

- [ ] **Step 7: Clean up prod env var**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npx wrangler secret delete LINEAR_ACCESS_TOKEN
```

Confirms the prod `self-syncing-agent` worker no longer needs the Linear token. (It's fine to leave it until the Phase D merge lands on main; dev doesn't need prod secrets.)

- [ ] **Step 8: Push the branch**

```bash
git push origin feat/pipedream
```

If anything in steps 2-6 fails, capture the wrangler logs, the browser console, and any returned tool-call error shape. Common failure modes:

- **GitHub webhook create returns 404**: the user's connected GitHub account doesn't have access to the repo (maybe private + insufficient OAuth scopes, or wrong owner). Check the user's Pipedream GitHub app's granted permissions.
- **__verifySignature returns false for real GitHub deliveries**: likely a header-name or encoding typo in the agent's code. GitHub uses `x-hub-signature-256: sha256=<hex>` (the `sha256=` prefix must be stripped before comparing hex).
- **registerWebhook throws "secret too short"**: some GitHub tiers have minimum secret length requirements. Bump the generated secret to ≥32 chars.
- **Facet attach fails with "compile error"**: syntax error in the agent's handler. Read the error detail from the tool call return — it includes the V8 error message.

---

## Self-Review Checklist

**1. Spec coverage:**

- ✅ Zero per-integration code in the supervisor — `src/integrations/linear-api.ts` deleted, no Linear-specific branches anywhere in `src/`.
- ✅ `LINEAR_ACCESS_TOKEN` removed from Env, .dev.vars, and prod secrets.
- ✅ Agent-authored handlers can create upstream webhooks via `registerWebhook`.
- ✅ Agent-authored handlers can clean up via `unregisterWebhook` (with graceful-skip for legacy syncs).
- ✅ create_sync input no longer carries Linear-specific `resource_types` field.
- ✅ delete_sync works for pre-Phase-D syncs without their handlers needing retroactive updates.
- ✅ Tool descriptions document all four exports with two worked examples (Linear + GitHub).
- ✅ Tests cover happy path, all three rollback paths, and all three unregister outcomes.

**2. Type consistency:**

- `registerWebhook`'s return shape is `{id: string, secret: string}` — documented in tool description, validated at the call site in create_sync, stored in the `NewSync` record as `upstream_webhook_id` and `webhook_secret`. Single source of truth: the contract text in create_sync's description.
- `unregisterWebhook`'s result shape (`{ok: true}` vs `{ok: false, reason, detail?}`) is used consistently in the wrapper, delete_sync, and tests. No drift.
- `attachFacet` accepts a `Sync` row with empty-string `webhook_secret` and `upstream_webhook_id` for the preliminary attach in create_sync — verify this doesn't break (Task 2 Step 1).

**3. Backward compat:**

- Pre-Phase-D Linear sync (if it still exists at Phase D start): deletes cleanly via graceful-skip. Create_sync no longer works for Linear without the user re-authoring the handler with all four exports — but that's the expected migration pattern.
- `integration: z.string()` is a widening from `z.enum(["linear"])`. Existing serialized sync rows still validate (their `integration` value is "linear", which is a valid string).

---

## Future Work (noted, not planned here)

- **Multi-resource-per-sync** (e.g., one GitHub sync tracking N repos at once). Current model is one-sync-per-upstream-resource. Works fine; multi-resource would need loop logic in registerWebhook and a schema bump. Out of scope.
- **update_sync re-running registerWebhook.** Today, changing registerWebhook's code has no effect because the registration itself is immutable for the sync's lifetime. If a future phase wants to support "add events to an existing webhook," update_sync would gain an optional `re_register: bool` flag and the flow would: unregister old → register new → update DB. Noted in update_sync's description as a known limitation.
- **Detecting upstream webhook revocation.** If the user revokes the webhook in the upstream's dashboard, our DB row still points to a now-dead upstream id. Subsequent deliveries just stop. Phase E / V2 could add a periodic health check. For the trial, "the webhook disappeared, here's what to do" is a README note.
- **Shared Linear OAuth demo app.** Removing LINEAR_ACCESS_TOKEN means the shared Linear demo app goes unused. It can be deleted from Linear's app settings after Phase D merges, or left in place as a stale artifact.
