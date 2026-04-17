# Self-Syncing Agent — Architecture Design

**Date:** 2026-04-17
**Status:** Draft for implementation
**Upstream context:** [`spec.md`](../../../spec.md) — the assignment as given plus our scope and decisions
**Target:** V1 build for a 4-day trial

---

## 1. Context and scope

This document is the concrete architectural design for the V1 build of a self-syncing agent: a deployed system where a visitor lands on a URL, talks to an agent in plain language, and the agent writes its own webhook handler code + schema into isolated per-sync SQLite databases. Third-party data stays locally mirrored via webhook-driven ingestion, and the agent queries its own local copy at question time.

Key constraints carried over from `spec.md`:

- **Cloudflare-native** — Workers, Durable Objects, DO Facets, Worker Loader
- **TypeScript end-to-end**
- **Claude Sonnet 4.6** for agent reasoning via `@ai-sdk/anthropic`
- **Isolation is the primary grading signal** — must be demonstrable, not aspirational
- **4-day V1** — scope discipline; Pipedream and autonomous background agents are V2 stretch

Non-goals recap: multi-tenant auth, user OAuth flows, teams, billing, multi-thread per user.

## 2. Stack summary

| Concern | Choice |
|---|---|
| Runtime | Cloudflare Workers + Durable Objects |
| Sync execution | DO Facets + Worker Loader (isolated SQLite per facet) |
| Agent framework | Cloudflare Agents SDK (`@cloudflare/ai-chat`) |
| LLM | Claude Sonnet 4.6 via `@ai-sdk/anthropic` |
| HTTP | Hono |
| UI | React (from starter), served by the Worker |
| Web search | Parallel AI agentic search |
| Package manager | pnpm |
| Node | 22.x (pinned `.nvmrc` + `package.json#engines`) |

## 3. Identity and addressing

- **No auth.** Every visitor gets a client-minted UUID on first landing, stored in `localStorage`.
- **URL pattern:** `/user/:userId` is that visitor's agent page. The URL is the capability — sharing the URL shares the agent.
- **DO naming:** `env.USER_AGENT.idFromName(userId)` — the DO is created on first access. No server-side user registry; the DO existing *is* the user record.

## 4. Topology

One Durable Object per user, extended from the starter's `ChatAgent`. That DO plays three roles:

1. **Chat agent** — manages conversation state (inherited from `AIChatAgent`)
2. **Supervisor** — owns the syncs registry, sync_errors log, and webhook signing secrets
3. **Facet orchestrator** — attaches, dispatches to, and manages N facets (one per sync) via `ctx.facets.get(syncName, loadCallback)`

```mermaid
flowchart TD
    Browser[Browser<br/>React SPA<br/>user_id in localStorage]
    Worker[Cloudflare Worker<br/>Hono router<br/>serves SPA, WS, webhooks, proxy]
    UserDO[Per-user Durable Object<br/>ChatAgent + Supervisor<br/>Supervisor SQLite: chat, syncs, sync_errors]
    Facet1[Facet sync_1<br/>own SQLite<br/>globalOutbound → PROXY]
    Facet2[Facet sync_2<br/>own SQLite<br/>globalOutbound → PROXY]
    FacetN[Facet sync_N]
    Proxy[Supervisor-owned Proxy<br/>CredentialSource.resolve]
    Linear[api.linear.app]
    GitHub[api.github.com]
    Anthropic[api.anthropic.com]
    Parallel[api.parallel.ai]

    Browser -- WebSocket + REST --> Worker
    Worker -- env.USER_AGENT.idFromName --> UserDO
    UserDO --> Facet1
    UserDO --> Facet2
    UserDO --> FacetN
    Facet1 -- fetch via globalOutbound --> Proxy
    Facet2 -- fetch via globalOutbound --> Proxy
    FacetN -- fetch via globalOutbound --> Proxy
    Proxy -- injects auth --> Linear
    Proxy -- injects auth --> GitHub
    UserDO -. direct, not via proxy .-> Anthropic
    UserDO -. direct, not via proxy .-> Parallel
    Linear -- webhook POST /webhook/:uid/:sid --> Worker
    GitHub -- webhook POST /webhook/:uid/:sid --> Worker
```

**Facet isolation semantics** (confirmed from Cloudflare docs):

- A single DO can host an arbitrary number of named facets (`ctx.facets.get("name", ...)`)
- Each facet gets **its own isolated SQLite database** — "the dynamic code cannot read the supervisor's database"
- Each facet runs in a separate V8 isolate
- `globalOutbound` is set per facet at load time; passing a fetcher binding routes all outbound fetch through that fetcher; passing `null` blocks egress entirely

## 5. Data model

### 5.1 Supervisor SQLite (per user)

Lives in the user DO. Accessed via `this.sql` (Agents SDK).

**`chat_messages`** — inherited from `AIChatAgent`. Messages persisted across reloads and dev restarts.

**`syncs`** — the registry:

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PRIMARY KEY | UUID generated at creation |
| `name` | TEXT NOT NULL UNIQUE | User-visible label; must be unique per user |
| `integration` | TEXT NOT NULL | `"linear"` \| `"github"` (V1) |
| `handler_code` | TEXT NOT NULL | Agent-authored JS; module source |
| `schema_ddl` | TEXT NOT NULL | Agent-authored SQL DDL; run in facet on init |
| `filter_description` | TEXT | Human-readable description of what this sync tracks |
| `webhook_secret` | TEXT NOT NULL | 32-byte random, used for HMAC verification |
| `upstream_webhook_id` | TEXT | Returned by upstream when webhook registered (e.g. Linear webhook ID) |
| `code_id` | TEXT NOT NULL | Cache key for `env.LOADER.get(codeId, ...)`; bumps on update |
| `version` | INTEGER NOT NULL DEFAULT 1 | Handler version; incremented on `update_sync` |
| `created_at` | INTEGER NOT NULL | Unix ms |
| `updated_at` | INTEGER NOT NULL | Unix ms |

**`sync_errors`** — runtime failure log:

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | |
| `sync_id` | TEXT NOT NULL | FK to `syncs.id` |
| `occurred_at` | INTEGER NOT NULL | Unix ms |
| `payload_preview` | TEXT | First ~2KB of the webhook body, for debugging |
| `error_message` | TEXT NOT NULL | `e.message` |
| `stack_trace` | TEXT | `e.stack` if available |
| `handler_version` | INTEGER NOT NULL | The version that failed; older errors preserved across updates |

**`connections`** — **V2 only.** Per-user Pipedream account bindings. Skipped for V1.

### 5.2 Facet SQLite (per sync)

The schema is **defined entirely by the agent** at sync creation time (via `schema_ddl`). The supervisor does not prescribe a shape. Typical example for a Linear issues sync:

```sql
CREATE TABLE issues (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  state TEXT,
  labels TEXT,           -- JSON-encoded array
  assignee TEXT,
  created_at INTEGER,
  updated_at INTEGER,
  raw_payload TEXT       -- the full webhook body, for debugging and backfill
);
```

The supervisor never reads these tables directly. All reads go through `query_sync(sync_id, sql)`, which executes inside the facet.

## 6. Outbound egress and credentials

### 6.1 Proxy design

- Every facet is loaded with `globalOutbound: env.PROXY` (a service binding that points back to our own Worker at the `/__proxy/*` route).
- When agent-authored handler code calls `fetch("https://api.linear.app/graphql", {...})`, the request is intercepted by Cloudflare's runtime and dispatched through the proxy fetcher instead.
- The fetcher is constructed by the supervisor DO and includes an `X-SSA-User-Id` header (or equivalent identifier) so the proxy knows which user's credentials to use.

### 6.2 `CredentialSource` interface — pluggable V1 / V2

```ts
interface ResolvedCredential {
  injectAuth(request: Request): Request;
}

interface CredentialSource {
  resolve(userId: string, host: string): Promise<ResolvedCredential | null>;
}
```

**V1 — `EnvCredentialSource`** (built):

- Static map of `{ host → env-secret-name }`
- Ignores `userId` (V1 uses shared demo-account keys)
- Returns `null` for unknown hosts → proxy responds `403`

```ts
// V1 map
{
  "api.linear.app":  env.LINEAR_API_KEY,
  "api.github.com":  env.GITHUB_TOKEN,
}
```

**V2 — `PipedreamCredentialSource`** (stretch):

- Reads per-user `connections` table from supervisor SQLite
- Calls Pipedream Connect to get a fresh access token for the matched integration
- Returns `ResolvedCredential` that injects the token

**Proxy behavior is identical across V1/V2** — it just calls `source.resolve(userId, host)`. The agent's handler code is identical too (`fetch(...)`). Swap is invisible to the facet layer.

## 7. Inbound routing (webhooks)

- **URL shape:** `/webhook/:userId/:syncId`
- Both components are UUIDs. Server-to-server only; not user-visible.
- Worker parses URL → gets user DO by name → calls `userDO.handleWebhook(syncId, request)`
- No global webhook index needed. The user DO knows its own syncs.
- See section 10.2 for the detailed flow including signature verification.

## 8. Agent tool surface (10 tools)

### 8.1 Read tools (no approval)

| Tool | Input | Output | Notes |
|---|---|---|---|
| `list_syncs()` | — | `[{sync_id, name, integration, row_count, version, last_activity}]` | Rich detail for the sync list UI |
| `get_sync(sync_id)` | `sync_id: string` | `{handler_code, schema_ddl, version, recent_activity, row_count, recent_errors}` | Full sync detail |
| `get_sync_errors(sync_id, limit=20)` | `sync_id`, `limit` | `[sync_error rows]` | Full stack traces + payload previews for debugging |
| `query_sync(sync_id, sql)` | `sync_id`, `sql: string` | `rows[]` | **SELECT-only**; enforced in the facet |
| `get_integration_docs(integration)` | `"linear"` \| `"github"` | `{webhook_events: [...], api_base_url, auth_pattern, common_gotchas}` | Curated JSON bundles in the worker |
| `web_search(objective, search_queries?)` | `objective: string`, `queries?: string[]` | `[{url, title, excerpt, ...}]` | Parallel AI agentic mode; 10 results; 4KB excerpts |

### 8.2 Write tools (always approval via Agents SDK `needsApproval`)

| Tool | Input | Output | Side effects |
|---|---|---|---|
| `create_sync` | `{name, integration, schema_ddl, handler_code, filter_description}` | `{sync_id}` | Registers upstream webhook, loads facet, initializes its SQLite, persists sync record. Transactional rollback on any step's failure. |
| `update_sync` | `{sync_id, schema_ddl?, handler_code?, migration_sql?}` | `{version: number}` | Bumps version + codeId. `migration_sql` runs inside the facet in a transaction before new code loads. |
| `delete_sync` | `sync_id: string` | `{ok: true}` | Unregisters upstream webhook, drops facet, deletes sync record + related errors. |
| `run_in_sync` | `sync_id: string, code: string` | `{result, logs, error?}` | Loads the code into the target sync's facet at a one-shot `/exec` entrypoint. Same isolation as the handler. Enables backfill, diagnostics, data fixes. |

**Approval rationale:** every write tool always requires approval (no heuristic classification). The approval moment *is* the "show generated code" UI moment, so this matches the assignment's UX ask naturally.

## 9. LLM context injection (caching-aware)

Claude's prompt cache only rewards stable prefixes. The design respects this:

**Message structure on every turn:**

```
[ system prompt  — stable, marked cache_control: ephemeral  ]  ← cache breakpoint
[ context messages — freshly built each turn, NOT cached   ]
[ conversation history — from this.messages                 ]
[ current user message                                       ]
```

**Context messages** are user-role messages with XML-delimited tags (Claude is trained to read these as ambient state, not user intent):

```
<active_syncs>
| sync_id | name | integration |
| abc-123 | linear_bugs | linear |
</active_syncs>

<sync_errors>
| sync_id | count_last_hour | last_error |
| abc-123 | 7 | TypeError: Cannot read property 'team' of undefined |
</sync_errors>
```

Empty state handled explicitly (`<active_syncs>No syncs registered yet...</active_syncs>`).

**Implementation sketch:**

```ts
async onChatMessage(_onFinish, options) {
  const syncs = this.sql`SELECT id, name, integration FROM syncs`.all();
  const errors = this.sql`SELECT sync_id, COUNT(*) as n, ... FROM sync_errors WHERE occurred_at > ? GROUP BY sync_id`.all(Date.now() - 3600_000);

  const contextMessages: ModelMessage[] = [
    { role: "user", content: formatActiveSyncs(syncs) },
    { role: "user", content: formatSyncErrors(errors) },
  ];

  const messages: ModelMessage[] = [
    ...contextMessages,
    ...await convertToModelMessages(this.messages),
  ];

  const result = streamText({
    model: anthropic("claude-sonnet-4-6"),
    system: [{
      type: "text",
      text: SELF_SYNCING_AGENT_SYSTEM_PROMPT,
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    }],
    messages,
    tools: syncTools(this),
    stopWhen: stepCountIs(5),
    abortSignal: options?.abortSignal,
  });

  return result.toUIMessageStreamResponse();
}
```

## 10. Control flows

### 10.1 Sync creation

```mermaid
sequenceDiagram
    participant User
    participant Agent as Agent (Claude)
    participant UI as Approval UI
    participant Sup as Supervisor DO
    participant Linear
    participant Loader as Worker Loader
    participant Facet

    User->>Agent: "Keep Linear bugs in sync"
    Agent->>Agent: get_integration_docs("linear")
    Agent->>Agent: web_search (if needed)
    Agent->>User: Drafts schema + handler in chat, asks approval
    User->>UI: Click Approve
    UI->>Sup: create_sync(...)
    Sup->>Sup: Generate sync_id, webhook_secret, code_id
    Sup->>Linear: webhookCreate mutation
    Linear-->>Sup: {webhook_id}
    Sup->>Loader: env.LOADER.get(code_id, {modules, globalOutbound: PROXY})
    Sup->>Facet: ctx.facets.get(name, load)
    Sup->>Facet: fetch("/__init__") — runs schema_ddl
    Facet-->>Sup: ok
    Sup->>Sup: INSERT INTO syncs
    Sup-->>Agent: {sync_id}
    Agent-->>User: "Sync linear_bugs is live"
```

**Rollback rules** — if any step after webhook registration fails (facet load, init, registry write), the supervisor unregisters the Linear webhook and drops the facet, returning an error message that the agent surfaces to the user.

### 10.2 Webhook delivery (steady state)

Zero LLM cost. Agent does not run.

```mermaid
sequenceDiagram
    participant Linear
    participant Worker
    participant Sup as Supervisor DO
    participant Facet

    Linear->>Worker: POST /webhook/:userId/:syncId + HMAC signature
    Worker->>Sup: userDO.handleWebhook(syncId, request)
    Sup->>Sup: SELECT webhook_secret, name FROM syncs
    alt sync not found
        Sup-->>Linear: 404
    end
    Sup->>Sup: Verify HMAC(body, webhook_secret) == signature
    alt invalid signature
        Sup-->>Linear: 401
    end
    Sup->>Facet: ctx.facets.get(syncName).fetch(request) — try/catch
    alt handler succeeds
        Facet->>Facet: parse payload, INSERT/UPDATE own SQLite
        Facet-->>Sup: 200
        Sup-->>Linear: 200
    else handler throws
        Sup->>Sup: INSERT INTO sync_errors
        Sup-->>Linear: 5xx (upstream retries)
    end
```

**Signature verification stays in the supervisor** — facet code never sees `webhook_secret`. Facets receive the fully validated request with raw body.

### 10.3 Query

Trivial; covered in prose:

1. User asks: "How many open bugs are in the Core team?"
2. Agent reads `<active_syncs>` ambient context, sees `linear_bugs` exists
3. Agent calls `query_sync("sync_abc", "SELECT COUNT(*) FROM issues WHERE state='open' AND json_extract(labels, '$') LIKE '%bug%' AND team='Core'")`
4. Query runs against the facet's SQLite; rows returned in milliseconds
5. Claude reads the result, answers in natural language

`query_sync` enforces SELECT-only (tool validates the SQL starts with SELECT or WITH after stripping comments; anything destructive requires `update_sync` or `run_in_sync`).

## 11. Error handling and recovery — two layers

### 11.1 Layer 1 — prevention (at code-generation time)

- **`get_integration_docs(integration)`** — V1 ships curated JSON bundles for Linear and GitHub. Includes webhook event types, payload schemas, sample payloads, auth patterns, and common gotchas. Small enough to read every session.
- **`web_search` (Parallel)** — fallback for unknown integrations, recent API changes, error-code lookup, general research.
- **System prompt discipline** — "Before writing a handler, call `get_integration_docs` to get the webhook payload schema. Write code against the documented shape. Do not guess at field names."

### 11.2 Layer 2 — recovery (at runtime)

1. Every facet dispatch wrapped in try/catch in the supervisor (section 10.2)
2. On failure: row inserted into `sync_errors`, 5xx returned so upstream retries
3. On next chat turn: ambient context includes `<sync_errors>` summarizing recent failures
4. Agent can call `get_sync_errors(sync_id)` to see full stack traces and payload previews
5. Agent proposes `update_sync` with corrected handler; user approves; pending upstream retries succeed
6. `run_in_sync` enables backfill once the schema is right — ad-hoc code in the facet can re-fetch historical data via proxy and populate previously-empty rows

**Safeguards against fix-loops** (implementation note): if a new handler version fails within X minutes of shipping, flag to user in chat context rather than proposing another automatic fix. Hard cap of 3 auto-fix attempts per sync per day for V1.

## 12. Security and isolation invariants

All of these must be true and demonstrable:

1. **Cross-user isolation** — each user is one DO. No DO has read access to another DO's storage. DO names are UUIDs.
2. **Facet ↔ Supervisor isolation** — facet code cannot read supervisor SQLite. Each facet has its own isolated SQLite. (Confirmed from Cloudflare docs.)
3. **Facet ↔ Network isolation** — `globalOutbound: env.PROXY` on every facet. No raw network egress. Proxy rejects unknown hosts with 403.
4. **Credential isolation** — V1 integration secrets live only in Worker env. They are read by the proxy when injecting auth. They are never passed into facet environments.
5. **Ad-hoc code isolation** — `run_in_sync` reuses the target sync's facet; same sandbox, same proxy, same SQLite scope. It cannot reach other syncs or supervisor state.
6. **Supervisor-only services** — `api.anthropic.com` and `api.parallel.ai` are called by the supervisor DO directly, using env secrets. They are unreachable from facet code.

## 13. Extensibility (V2 paths)

Enumerated here so the V1 build is shaped to accept them without rework.

### 13.1 Pipedream Connect

- Add `connections` table to supervisor SQLite (user_id implicit, integration, base_url, pipedream_account_id).
- Add `connect_integration(integration)` tool that returns a Pipedream Connect auth URL for the user.
- Swap `EnvCredentialSource` → `PipedreamCredentialSource` in the proxy.
- **No changes required to facet code or Worker Loader wiring.** The proxy's interface is stable.

### 13.2 Web search replacing JSON docs

Delete `get_integration_docs` once `web_search` coverage is good enough. Add a `docs_cache` table in supervisor SQLite to avoid re-searching for well-known integrations.

### 13.3 Background agents (webhook-spawned)

After N consecutive sync failures, auto-spawn an agent run that reads errors, proposes a fix, and calls `update_sync` (still with user approval). Same tool surface, different trigger.

### 13.4 Rate limiting

Per-session message cap on the public URL to prevent LLM-cost abuse. Not V1.

## 14. Out of scope for V1 (explicit)

- Multi-tenant authentication (cookies, sessions, real login)
- Third-party OAuth flows (user connecting their own Linear/GitHub/etc.)
- Pipedream Connect integration
- Autonomous agent loops (recovery is user-initiated in V1)
- Multi-thread per user (one implicit thread per user DO)
- Admin views, user enumeration, analytics
- Rich artifact editing beyond what the starter provides

## 15. Worker env secrets

| Secret | Purpose | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | Claude LLM calls | Read directly by supervisor |
| `PARALLEL_API_KEY` | `web_search` tool | Read directly by supervisor |
| `LINEAR_API_KEY` | Linear API auth (webhook registration + proxy injection) | V1 uses one shared demo-workspace token |
| `GITHUB_TOKEN` | GitHub API auth | V1 uses one shared demo-account token |
| `PIPEDREAM_CLIENT_ID` / `PIPEDREAM_CLIENT_SECRET` | Pipedream Connect | V2 only |

All provisioned via `wrangler secret put <NAME>` for deployed environments. Local dev reads from `.dev.vars` (gitignored).

## 16. Known DO Facets caveats (docs are thin)

Called out so that future sessions know what to verify on implementation:

- The exact shape of `globalOutbound` configuration — whether it takes a `Fetcher` object, a `{ service }` binding, or something else — needs verification against live CF docs before wiring the proxy.
- Quota limits on facets-per-DO are **not documented**. For V1, assume arbitrary — design is tolerant of whatever limit exists.
- Facet cold-start latency is **not documented**. If measured latency is high enough to cause webhook delivery timeouts, consider pre-warming or reshaping the facet lifecycle.
- Worker Loader cache semantics (invalidation, eviction, cross-region propagation) are thin. Use `code_id` bumps on every update to avoid stale cache hits.

---

**End of design.** Implementation plan lives in a separate document once this is approved.
