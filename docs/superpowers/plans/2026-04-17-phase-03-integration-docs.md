# Phase 03 — Integration Docs Bundle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a curated docs bundle for Linear — webhook event schemas, sample payloads, auth pattern, webhook-registration mechanics, and common gotchas — so Phase 04's `get_integration_docs` tool has authoritative reference data to feed the agent before it drafts handler code. **V1 scope: Linear only.** GitHub curation is deferred; V2 Pipedream will replace this entire approach with 3000+ integrations at once.

**Architecture:** A typed constant module exports `linearDocs: IntegrationDocs`. A registry function `getIntegrationDocs(name)` returns the matching docs or `null`. No I/O, no mutation — the bundle is a static part of the Worker binary, cached by V8 for free. Phase 04 wraps this in a tool; Phase 08 reads the auth/registration sections when calling Linear's API during `create_sync`.

**Tech Stack:** TypeScript constants (not raw JSON — we get compile-time shape validation and typed imports for free).

**Reference:** [`docs/superpowers/specs/2026-04-17-self-syncing-agent-architecture-design.md`](../specs/2026-04-17-self-syncing-agent-architecture-design.md) §8 (tool surface includes `get_integration_docs`) and §11.1 (Layer 1 prevention — docs-first discipline).

---

## File Structure

**Created:**

- `src/integrations/types.ts` — `IntegrationDocs`, `WebhookEventDoc`
- `src/integrations/linear.ts` — `export const linearDocs: IntegrationDocs`
- `src/integrations/index.ts` — `getIntegrationDocs(name: Integration): IntegrationDocs | null`
- `tests/integration-docs.test.ts` — shape tests + registry lookup tests

**Modified:**

- `src/db/types.ts` — narrow `Integration` from `"linear" | "github"` to `"linear"` (retroactive V1 scope cleanup)

No changes to `src/server.ts`, `wrangler.jsonc`, or anything in `src/db/syncs.ts` / `src/db/sync-errors.ts` (the repo is generic over the Integration type).

---

## Task 1: Narrow the `Integration` type

Phase 02 declared `Integration = "linear" | "github"` anticipating both. V1 ships only Linear; widening the type re-opens when we do V2 Pipedream or GitHub. Keeping the union now creates a dead code path where the type permits `"github"` but the runtime has no docs, no auth pattern, no registration logic for it.

**Files:**

- Modify: `src/db/types.ts`

- [ ] **Step 1: Narrow the type**

Open `src/db/types.ts`. Change this line:

```ts
export type Integration = "linear" | "github";
```

to:

```ts
/**
 * Supported integrations for V1. Narrow single-member union so tools and
 * runtime code are kept honest — adding a new integration requires
 * widening here AND supplying docs, auth pattern, and registration logic
 * to match. V2 (Pipedream Connect) replaces this with a dynamic registry.
 */
export type Integration = "linear";
```

- [ ] **Step 2: Verify no callers broke**

```bash
pnpm exec tsc --noEmit
```

Expected: zero errors. The repo functions and existing tests use `integration: Integration` as-is — narrowing the union tightens without breaking.

---

## Task 2: Integration docs types

**Files:**

- Create: `src/integrations/types.ts`

- [ ] **Step 1: Create `src/integrations/types.ts` with exactly this content:**

```ts
/**
 * Shape of the curated docs bundle served to the agent by the
 * `get_integration_docs` tool (wired in Phase 04). The agent consults
 * this BEFORE drafting webhook handler code, so the fields need to be
 * actionable — schemas, samples, gotchas — not marketing copy.
 */

export interface WebhookEventDoc {
  /** Event resource type as it appears in the payload (e.g. "Issue"). */
  resource: string;
  /**
   * Supported action values for this resource. Linear uses
   * "create" | "update" | "remove"; other upstreams will differ.
   */
  actions: string[];
  /** One-line description of when this event fires. */
  description: string;
  /**
   * Concrete sample webhook body (a realistic request payload). The
   * agent uses this as the shape-anchor for writing `handler.js`.
   */
  sample_payload: unknown;
  /**
   * Field-by-field notes or type hints worth flagging. Written as a
   * list so they render cleanly in the agent's context.
   */
  field_notes: string[];
}

export interface IntegrationDocs {
  /** Integration slug matching the `Integration` type. */
  integration: string;
  /** Human-readable name for the integration, for UI / chat display. */
  display_name: string;
  /** Base URL for the upstream REST/GraphQL API. */
  api_base_url: string;
  /**
   * One-sentence description of how the supervisor authenticates to
   * the upstream API (not the agent's facet code — the agent never
   * sees tokens; the proxy injects auth on its behalf).
   */
  auth_pattern: string;
  /**
   * How to register a webhook with this upstream. Includes the HTTP
   * call shape and the signing mechanism so the supervisor can verify
   * incoming deliveries.
   */
  webhook_registration: {
    description: string;
    endpoint: string;
    method: string;
    /** Name of the header that carries the HMAC signature. */
    signature_header: string;
    /** How the signature is computed (algorithm + input). */
    signature_algorithm: string;
  };
  /** Event documentation, one entry per resource type worth subscribing to in V1. */
  webhook_events: WebhookEventDoc[];
  /**
   * Things the LLM might hallucinate or get subtly wrong. Surface them
   * verbatim in the context block the agent reads; skip if empty.
   */
  common_gotchas: string[];
}
```

---

## Task 3: Curate Linear docs

**Files:**

- Create: `src/integrations/linear.ts`

This file is the whole reason Phase 03 exists. Content must be accurate, concise, and actionable. Sources consulted during curation:

- Linear webhook reference: <https://linear.app/developers/webhooks>
- Linear GraphQL API: <https://studio.apollographql.com/public/Linear-API/variant/current/home>
- Our design doc's view of Linear's webhook shape

- [ ] **Step 1: Create `src/integrations/linear.ts` with exactly this content:**

```ts
import type { IntegrationDocs } from "./types";

/**
 * Linear webhook + API docs bundle served to the agent when it creates
 * or updates a Linear sync. Focus for V1: Issue events, since that's
 * the primary resource syncs are built around.
 *
 * All content curated from Linear's public docs:
 *   https://linear.app/developers/webhooks
 *   https://studio.apollographql.com/public/Linear-API/variant/current/home
 */

export const linearDocs: IntegrationDocs = {
  integration: "linear",
  display_name: "Linear",
  api_base_url: "https://api.linear.app/graphql",
  auth_pattern:
    "HTTP header `Authorization: <LINEAR_API_KEY>` (no Bearer prefix). The supervisor injects this; agent-authored handler code calls `fetch('https://api.linear.app/graphql', ...)` and the proxy adds the header transparently.",
  webhook_registration: {
    description:
      "Register webhooks via the GraphQL mutation `webhookCreate(input: { url, resourceTypes, teamId? | allPublicTeams? })`. **Linear generates the signing secret**; the mutation response returns it only if explicitly selected — request `{ webhook { id, secret, enabled } }` in the selection set and store both values. Only workspace admins (or OAuth apps with `admin` scope) can create webhooks.",
    endpoint: "https://api.linear.app/graphql",
    method: "POST",
    signature_header: "Linear-Signature",
    signature_algorithm:
      "hex-encoded HMAC-SHA256 of the RAW request body (not re-stringified JSON) using the webhook's signing secret. Compare to the header value using a constant-time byte compare.",
  },
  webhook_events: [
    {
      resource: "Issue",
      actions: ["create", "update", "remove"],
      description:
        "Fires whenever any issue in the workspace is created, updated (state, title, labels, assignee, description, etc.), or permanently deleted.",
      sample_payload: {
        // NOTE: Linear's public docs publish a Comment webhook sample but
        // not an Issue one. The envelope below (action/actor/type/data/
        // updatedFrom/url/createdAt/organizationId/webhookTimestamp/
        // webhookId) matches Linear's documented webhook envelope; the
        // data field uses Linear's public Issue GraphQL type. Treat the
        // data shape as "fields that exist on Issue" rather than "fields
        // guaranteed in every payload" — Linear only includes changed /
        // populated fields in some events.
        action: "update",
        actor: {
          id: "b5ea5f1f-8adc-4f52-b4bd-ab4e84cf51ba",
          type: "user",
          name: "Alice Example",
          email: "alice@example.com",
          url: "https://linear.app/company/profiles/alice",
        },
        type: "Issue",
        createdAt: "2026-04-17T10:30:00.000Z",
        data: {
          id: "issue-uuid-1",
          identifier: "ENG-42",
          title: "Fix login flicker on Safari",
          description: "Users see a flash of the unauthenticated layout...",
          priority: 2,
          estimate: 3,
          state: {
            id: "state-uuid",
            name: "In Progress",
            type: "started",
            color: "#FF8A00",
          },
          team: {
            id: "team-uuid",
            key: "ENG",
            name: "Core",
          },
          assignee: {
            id: "user-uuid",
            name: "Bob Example",
            email: "bob@example.com",
          },
          creator: {
            id: "user-uuid-2",
            name: "Alice Example",
          },
          labels: {
            nodes: [
              { id: "label-uuid-1", name: "bug", color: "#E53935" },
              { id: "label-uuid-2", name: "mobile", color: "#3B82F6" },
            ],
          },
          createdAt: "2026-04-15T14:10:00.000Z",
          updatedAt: "2026-04-17T10:30:00.000Z",
          url: "https://linear.app/team-core/issue/ENG-42/fix-login-flicker",
        },
        // Present on `action: 'update'` only. Contains the PREVIOUS values
        // of fields that changed. Useful for detecting transitions.
        updatedFrom: {
          state: {
            id: "state-uuid-prior",
            name: "Todo",
            type: "unstarted",
          },
          updatedAt: "2026-04-16T09:00:00.000Z",
        },
        url: "https://linear.app/team-core/issue/ENG-42",
        organizationId: "org-uuid",
        webhookTimestamp: 1776417000000,
        webhookId: "webhook-uuid",
      },
      field_notes: [
        "`action` is one of 'create' | 'update' | 'remove' — NOT 'created'/'updated'/'deleted'",
        "`type` at the top level identifies the resource type; the real payload is `data`",
        "`updatedFrom` is present ONLY on update actions and contains the PREVIOUS values of changed fields. Use it for transition detection (e.g., 'moved from Todo to In Progress').",
        "`actor` has `{ id, type, name, email, url }`; `actor.type` can be 'user' | 'webhook' | 'oauthApp' (and others) — useful if the handler wants to filter bot-driven changes",
        "`data.labels` is an object with a `nodes` array, not a flat array of labels",
        "`data.state.type` (not `state.name`) is the stable state category: triage | unstarted | started | completed | canceled",
        "`data.assignee`, `data.creator`, `data.estimate` may be null — always guard",
        "On `action: 'remove'`, `data` still contains the issue fields so you can clean up by id",
        "Timestamps are ISO 8601 strings; `webhookTimestamp` is unix-ms",
      ],
    },
  ],
  common_gotchas: [
    "Linear's workspace API key (from Settings → API) works for webhook registration. Only workspace admins can create/read webhooks (or OAuth apps with `admin` scope).",
    "The `Authorization` header has NO 'Bearer' prefix when using a workspace API key. It's just the raw key. (OAuth access tokens DO use Bearer, but V1 uses the workspace key.)",
    "**Webhook timeout is 5 seconds.** If the handler takes longer than 5s Linear treats it as a failure and retries. Keep handlers fast — write the row, return 200, do heavier work asynchronously.",
    "**Retry schedule is max 3 attempts at 1min, 1hr, 6hr.** After that Linear may auto-disable the webhook. Non-2xx responses count as failures.",
    "**Verify `webhookTimestamp` is within ~60s of now** to prevent replay attacks. Linear explicitly recommends this in their docs.",
    "Use the RAW request body for signature verification — re-stringifying a parsed JSON body will shift whitespace and break the HMAC check.",
    "A single issue change can fire multiple webhook deliveries — make the handler idempotent on `data.id` (use `INSERT OR REPLACE` or `ON CONFLICT(id) DO UPDATE`).",
    "Nested fields (state, team, assignee, labels) are the full linked resources, not just IDs — you can store the id + snapshot name without a separate fetch.",
  ],
};
```

---

## Task 4: Integration registry

**Files:**

- Create: `src/integrations/index.ts`

- [ ] **Step 1: Create `src/integrations/index.ts` with exactly this content:**

```ts
import type { Integration } from "../db/types";
import type { IntegrationDocs } from "./types";
import { linearDocs } from "./linear";

const REGISTRY: Record<Integration, IntegrationDocs> = {
  linear: linearDocs,
};

/**
 * Look up the docs bundle for an integration. Returns null for any
 * integration the V1 registry doesn't cover — callers (Phase 04's
 * `get_integration_docs` tool) should surface a clear error rather
 * than letting the agent silently hallucinate against absent docs.
 *
 * Phase 02 already narrowed `Integration` to just "linear" for V1,
 * so the `as Integration` cast in the registry keys is safe: adding
 * a new integration requires widening the type in `src/db/types.ts`
 * which statically forces a registry entry here.
 */
export function getIntegrationDocs(name: string): IntegrationDocs | null {
  return (REGISTRY as Record<string, IntegrationDocs>)[name] ?? null;
}

export { linearDocs };
export type { IntegrationDocs, WebhookEventDoc } from "./types";
```

---

## Task 5: Tests

**Files:**

- Create: `tests/integration-docs.test.ts`

- [ ] **Step 1: Create `tests/integration-docs.test.ts` with exactly this content:**

```ts
import { describe, it, expect } from "vitest";
import { getIntegrationDocs, linearDocs } from "../src/integrations";

describe("integration docs bundle", () => {
  describe("linearDocs", () => {
    it("has the required top-level fields", () => {
      expect(linearDocs.integration).toBe("linear");
      expect(linearDocs.display_name).toBe("Linear");
      expect(linearDocs.api_base_url).toMatch(/^https:\/\//);
      expect(linearDocs.auth_pattern).toBeTruthy();
      expect(linearDocs.webhook_registration).toBeTruthy();
      expect(linearDocs.webhook_events.length).toBeGreaterThan(0);
    });

    it("has a webhook_registration block with signature info", () => {
      expect(linearDocs.webhook_registration.method).toMatch(/^(GET|POST)$/);
      expect(linearDocs.webhook_registration.endpoint).toMatch(/^https:\/\//);
      expect(linearDocs.webhook_registration.signature_header).toBeTruthy();
      expect(linearDocs.webhook_registration.signature_algorithm).toMatch(/HMAC/i);
    });

    it("covers the Issue event with a realistic sample payload", () => {
      const issueEvent = linearDocs.webhook_events.find((e) => e.resource === "Issue");
      expect(issueEvent).toBeTruthy();
      expect(issueEvent!.actions).toContain("create");
      expect(issueEvent!.actions).toContain("update");
      expect(issueEvent!.actions).toContain("remove");
      expect(issueEvent!.field_notes.length).toBeGreaterThan(0);

      // The sample payload should be a plain object that survives a
      // JSON roundtrip — agent context-injection will stringify it.
      const payload = issueEvent!.sample_payload as Record<string, unknown>;
      expect(payload.action).toBeDefined();
      expect(payload.type).toBe("Issue");
      expect(payload.data).toBeDefined();

      const roundtripped = JSON.parse(JSON.stringify(payload));
      expect(roundtripped).toEqual(payload);
    });

    it("lists common gotchas", () => {
      expect(linearDocs.common_gotchas.length).toBeGreaterThan(0);
    });
  });

  describe("getIntegrationDocs", () => {
    it("returns docs for 'linear'", () => {
      const docs = getIntegrationDocs("linear");
      expect(docs).toBe(linearDocs);
    });

    it("returns null for an unknown integration", () => {
      expect(getIntegrationDocs("slack")).toBeNull();
      expect(getIntegrationDocs("github")).toBeNull();
      expect(getIntegrationDocs("")).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run tests**

```bash
pnpm test
```

Expected: **28 passing** across 5 test files (22 existing + 6 new from this file).

Breakdown of the 6 new:

- linearDocs (4): top-level fields, webhook_registration, Issue event sample, common gotchas
- getIntegrationDocs (2): valid lookup, null fallback

---

## Task 6: Full check

- [ ] **Step 1:**

```bash
pnpm run check
```

Expected: all four stages green. If oxfmt reformats the JSON-heavy `linear.ts`, that's fine — just commit the formatted version.

---

## Task 7: Commit and push

**Files:**

- All Phase 03 changes: `src/db/types.ts`, `src/integrations/types.ts`, `src/integrations/linear.ts`, `src/integrations/index.ts`, `tests/integration-docs.test.ts`

- [ ] **Step 1: Stage and verify**

```bash
git add -A
git status --short
git diff --cached --stat
```

Expected: five files (one modified — `src/db/types.ts`; four new). Cosmetic oxfmt reformat of unrelated files is fine.

- [ ] **Step 2: Commit**

```bash
git commit -m "$(cat <<'EOF'
Phase 03: Linear integration docs bundle

Adds the curated docs bundle the agent will consult (via Phase 04's
get_integration_docs tool) before drafting Linear webhook handler code.
V1 ships Linear only — GitHub curation is deferred because adding a
second hardcoded integration demonstrates no new architecture, and V2
Pipedream Connect moots the whole per-integration-JSON approach.

- src/integrations/types.ts — IntegrationDocs + WebhookEventDoc shapes
- src/integrations/linear.ts — full bundle: api_base_url, auth pattern,
  webhook_registration mechanics (endpoint + HMAC-SHA256 signing),
  Issue event doc with realistic sample payload + field notes, and
  common gotchas the LLM might otherwise hallucinate (action values
  are create/update/remove not created/updated/deleted; labels.nodes;
  no Bearer prefix on Authorization; etc.)
- src/integrations/index.ts — getIntegrationDocs(name) registry
  lookup, returns null for unknown integrations so Phase 04's tool
  can surface a clean error
- tests/integration-docs.test.ts — shape + lookup tests

Side effect (kept in scope): narrowed `Integration` type from
`"linear" | "github"` to `"linear"` to stop the type permitting a
value the runtime has no docs/auth/registration for. Adding a new
integration in future means widening the type, which statically
forces adding a registry entry + a docs bundle.

Test count: 22 → 28 across 5 files.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 3: Push**

```bash
git push
```

---

## Phase 03 done when…

- [ ] `pnpm test` shows 28 passing across 5 test files
- [ ] `pnpm run check` passes end-to-end
- [ ] Commit pushed to origin/main
- [ ] `Integration` type is `"linear"` (single-member union), no dead `"github"` branch

Next phase: **Phase 04 — Read tools** (the first LLM-facing piece). Wires `list_syncs`, `get_sync`, `get_sync_errors`, `query_sync`, `get_integration_docs`, and `web_search` (via Parallel AI) into the agent's `streamText` tools map. Also where Phase 02's "thin wrapper methods on ChatAgent" debt gets decided on — we'll expose the repo via callables or inline in the tools.
