# Phase 03 — Narrow `Integration` Type + Drop Docs-Bundle Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reverse the "curated per-integration docs bundle" decision, narrow the `Integration` type to `"linear"`, and update the design doc so downstream phases reflect the new architecture. No new code modules. No new tests.

**Architecture decision change:** The original plan was to ship a `src/integrations/linear.ts` JSON-like constant + a `get_integration_docs(integration)` tool so the agent would consult pre-vetted webhook shapes before drafting handler code. **We're dropping that.** Rationale:

1. **The bundle adds zero information the agent doesn't already have.** Opus 4.7 (the agent) has Linear's webhook docs in its training data and will have `web_search` (via Parallel AI) for live verification. A hardcoded bundle is the same LLM, writing docs it'll then re-read.
2. **It doesn't generalize to V2.** The V2 pitch is "works for any Pipedream-accessible integration" (3000+). Ship-and-deprecate is worse than skip-and-be-consistent.
3. **It's fragile.** Hand-curated docs drift silently from upstream reality. Live `web_search` is self-correcting per turn.
4. **The Layer-2 runtime-error recovery loop is the true failure-safety net.** It works identically in V1 and V2.

Instead: the system prompt (written in Phase 07) will instruct the agent to use `web_search` for integration shape verification when it's not confident from training, and Layer-2 captures any residual errors at runtime.

**Tech stack:** TypeScript (single-line type change).

**Reference:** [`docs/superpowers/specs/2026-04-17-self-syncing-agent-architecture-design.md`](../specs/2026-04-17-self-syncing-agent-architecture-design.md) §8, §11.1, §13.

---

## File Structure

**Modified:**

- `src/db/types.ts` — narrow `Integration = "linear" | "github"` → `Integration = "linear"`.
- `docs/superpowers/specs/2026-04-17-self-syncing-agent-architecture-design.md`:
  - §8 tool list — drop `get_integration_docs`; revised tool count: **10 → 9**.
  - §11.1 (Layer 1 prevention) — reframe around `web_search` + system-prompt discipline; drop references to a curated bundle.
  - §13 (V2 extensibility) — remove the "web search replacing JSON docs" item (nothing to replace).
  - Add a new §14.x "Architectural decisions explicitly rejected" — document this call so reviewers see the judgment.

No source code modules deleted (none were created for the old Phase 03 — we're catching this before the implementer runs). No tests modified (no `get_integration_docs` tests exist yet).

---

## Task 1: Narrow the `Integration` type

- [ ] **Step 1: Edit `src/db/types.ts`**

Replace:

```ts
export type Integration = "linear" | "github";
```

with:

```ts
/**
 * Supported integrations for V1. Narrow single-member union so tools and
 * runtime code are kept honest — adding a new integration requires
 * widening here AND supplying webhook-registration + credential logic to
 * match. V2 (Pipedream Connect) replaces this with a dynamic registry.
 */
export type Integration = "linear";
```

- [ ] **Step 2: Verify no callers broke**

```bash
pnpm exec tsc --noEmit
```

Expected: zero errors. The repo functions and tests use `integration: Integration` as-is — narrowing tightens without breaking.

---

## Task 2: Update the design doc — §8 tool surface

- [ ] **Step 1: Drop `get_integration_docs` from the read-tool table**

Open `docs/superpowers/specs/2026-04-17-self-syncing-agent-architecture-design.md` and find §8.1 (the read tools table). Remove the row that reads:

```
| `get_integration_docs(integration)` | `"linear"` \| `"github"` | `{webhook_events: [...], api_base_url, auth_pattern, common_gotchas}` | Curated JSON bundles in the worker |
```

Update the surrounding prose that says "10 tools" to "9 tools" wherever it appears in the doc.

---

## Task 3: Update the design doc — §11.1 Layer 1 prevention

- [ ] **Step 1: Reframe the section**

Find §11.1 ("Layer 1 — prevention (at code-generation time)"). Replace its current contents (the curated-docs + system-prompt-discipline bullets) with:

```markdown
### 11.1 Layer 1 — prevention (at code-generation time)

- **`web_search` (Parallel AI agentic mode)** — the single docs-verification tool. The agent uses it to look up webhook payload shapes, API conventions, error-code meanings, and anything else where confidence from training is insufficient. Returns up to 10 excerpts of ≤4KB each, ranked by relevance.
- **System prompt discipline** (written in Phase 07) — "Before drafting a handler for any integration, verify the webhook payload shape. If your training data is confident and recent, proceed; otherwise call `web_search` first. Never guess field names — capture the whole payload into a `raw_payload` JSONB column if you're unsure, and refine later via `run_in_sync`."
- **Conservative-first pattern for unknown integrations (V2)** — in the V2 Pipedream world, the agent defaults to a "capture raw payload into a blob column" handler when docs are thin; subsequent webhook deliveries + Layer-2 error recovery iteratively refine the handler.

Note: we **explicitly rejected** hand-curating a per-integration docs bundle in the Worker. See §14 ("Architectural decisions explicitly rejected").
```

---

## Task 4: Update the design doc — §13 extensibility

- [ ] **Step 1: Drop the "web search replacing JSON docs" item**

Find §13.2 ("Web search replacing JSON docs"). Delete it entirely — we never ship the JSON docs, so there's nothing to replace. Renumber subsequent sections (13.3 Background agents → 13.2; 13.4 Rate limiting → 13.3).

---

## Task 5: Add §14 — Architectural decisions explicitly rejected

- [ ] **Step 1: Add a new section between §13 (extensibility) and §14 (Out of scope for V1)**

The existing §14 becomes §15 (and §15/§16 shift down one). Insert:

```markdown
## 14. Architectural decisions explicitly rejected

Listed here so reviewers can see what we considered and decided against, and why. These decisions shape the V1 code surface and are worth defending:

### 14.1 Per-integration curated docs bundle

Proposed: ship `src/integrations/linear.ts` (etc.) containing webhook payload schemas, auth patterns, and gotchas; agent consults via a `get_integration_docs` tool before drafting handler code.

**Rejected because:**

- The agent (Opus 4.7) is the same LLM that would curate the bundle. The bundle adds no information the agent doesn't have from training.
- It doesn't scale to V2 (Pipedream Connect covers 3000+ integrations — we can't hand-curate).
- Curated docs drift silently from upstream reality; `web_search` is self-correcting per turn.
- Shipping it then deprecating it in V2 signals weak architectural conviction. Skipping it signals trust in the bitter-lesson architecture end-to-end.

**Instead:** `web_search` (Parallel AI) is the single docs-verification primitive, and Layer-2 runtime-error recovery (§11.2) catches any bad first drafts. Same mechanism works identically for V1's one integration and V2's thousands.
```

And renumber the subsequent two sections accordingly (Out of scope → §15; Worker env secrets → §16; DO Facets caveats → §17).

---

## Task 6: Verify nothing else broke

- [ ] **Step 1: Full check pipeline**

```bash
pnpm run check
```

Expected: all four stages green. Existing tests still pass (22/22). No new tests were added or expected.

---

## Task 7: Commit and push

- [ ] **Step 1: Stage and verify**

```bash
git add -A
git status --short
git diff --cached --stat
```

Expected files changed: `src/db/types.ts`, `docs/superpowers/specs/2026-04-17-self-syncing-agent-architecture-design.md`, `docs/superpowers/plans/2026-04-17-phase-03-narrow-integration.md` (this plan), and the deletion of `docs/superpowers/plans/2026-04-17-phase-03-integration-docs.md` (the old plan).

- [ ] **Step 2: Commit**

```bash
git commit -m "$(cat <<'EOF'
Phase 03: narrow Integration type; drop curated-docs-bundle plan

Reversed the original Phase 03 plan. The idea was to ship a curated
per-integration docs bundle (Linear webhook schemas + auth + gotchas)
so the agent could consult it before drafting handler code. Rejected:

1. Zero-information-add: the agent is Opus 4.7, which already has
   Linear's docs in its training data and will have web_search (via
   Parallel AI) for live verification. A hardcoded bundle is the same
   LLM reading what the same LLM wrote.

2. Doesn't generalize to V2: the whole V2 pitch is "works for any
   Pipedream-accessible integration" (3000+). Ship-and-deprecate is
   worse architectural signaling than skip-and-stay-consistent.

3. Fragile: hand-curated docs drift silently from upstream reality.
   Live web_search is self-correcting per turn.

4. Layer-2 runtime-error recovery is the real failure-safety net and
   works identically in V1 and V2.

Concrete changes:
- src/db/types.ts — narrow Integration from "linear" | "github" to
  just "linear". V1 runtime only supports one integration, so the
  type should reflect that.
- Design doc §8 — drop get_integration_docs from the tool table;
  tool count 10 → 9.
- Design doc §11.1 — reframe Layer 1 prevention around web_search +
  system-prompt discipline instead of a curated bundle.
- Design doc §13 — drop the "web search replacing JSON docs"
  extensibility item (nothing to replace).
- Design doc — add new §14 "Architectural decisions explicitly
  rejected" documenting this call, so reviewers can see the judgment.
- Replace the old Phase 03 plan file with this trimmed plan.

Tests unchanged; 22/22 still passing.

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

- [ ] `Integration` type is `"linear"` in `src/db/types.ts`
- [ ] Design doc §8 shows 9 tools, no `get_integration_docs`
- [ ] Design doc §11.1 reframed around `web_search`
- [ ] Design doc has new §14 explaining the rejection
- [ ] `pnpm run check` green, 22/22 tests passing
- [ ] Commit pushed to origin/main

Next phase: **Phase 04 — Read tools** (9 tools, not 10). The agent's first LLM-facing surface: `list_syncs`, `get_sync`, `get_sync_errors`, `query_sync` (SELECT-only), `web_search` (Parallel). Tool-calling loop wired into `streamText`. Context injection (`<active_syncs>` + `<sync_errors>` as user messages before history, system prompt with `cache_control: ephemeral`). System prompt is written in Phase 07 — for Phase 04 the prompt is a minimal placeholder.
