# Trial Project: Self-Syncing Agent

**Duration:** 4 days\
**Deliverables:** codebase, README, publicly hosted URL to play with

## The problem

People's work lives are scattered across dozens of services: Linear, GitHub, Slack, Notion, Gmail, Calendar, and so on. For an agent to be genuinely useful, that data needs to be _front and centre_ — queryable in milliseconds, filterable, cross-referenceable, and available without the agent having to re-fetch it from a slow third-party API every time it wants to think.

There are lots of ways to solve this. The one we want to experiment with, and the one this trial is about, is: **have the agent write the code that syncs the data itself.** This is the code-mode/bitter lesson pilled way to get things done. 

When a user says "keep my Linear issues in sync" or "track GitHub issues on repo X but only the ones tagged `bug`," the agent:

1. Registers a webhook against the upstream API.
2. Writes its own handler code, including the DB schema it wants to store things in.
3. Runs that code on every webhook delivery, writing into a database it owns with **no need** for the agent to run (this is infinitely more efficient than agents that run on heartbeats to do the same thing)

From then on, when the user asks questions about their Linear data, the agent queries its local copy — fast, filtered the way the user wanted, and fully under the agent's control. The user can also ask the agent to change the sync ("only keep issues from the Core team," "also pull in the last comment on each"), and the agent edits its own code and schema to match.

The fundamental primitive is: **anything with a webhook can become a local, agent-owned database.** Linear issues, GitHub issues, Slack messages, Stripe events, Calendly bookings — all the same pattern.

The bigger picture this is pointing at is a stateful-but-serverless agent runtime. A webhook comes in, the agent's code runs on it, and the result of that code can be any of: update the database, reshape the schema, emit another webhook, or spin up a fresh agent to do some higher-level work on what just arrived. The sync isn't a dumb pipe — it's a programmable surface the agent controls.

**Cloudflare Durable Object Facets** (new, interesting, barely documented) are a promising substrate for this. Each sync gets its own isolated SQLite database inside a facet, while a supervisor DO holds secrets and controls what the agent-authored code is allowed to do. That's the bit we most want to learn from this trial.

## What we want you to build

A deployed, general-purpose version of the above. A visitor lands on your URL, talks to the agent in plain language, and the agent sets up one or more live syncs against real third-party APIs. Each sync is an agent-authored handler running inside a Durable Object Facet with its own SQLite. The UI should make it obvious what's happening: show the generated schema, show the handler code, show the data landing as webhooks fire, and let the user ask the agent to change things.

Treat it as a general tool, not a Linear-specific demo. Linear is the first integration because it has clean webhooks and a decent API, but the architecture should read as "this works for anything webhookable" — pick a second integration (GitHub or Slack are good choices) to prove the point or even go as far as hooking up Pipedream and allowing *any* integration to run.

Fundamentally, you're going to be building a simple agent with a very small number of tools, and that main tool is going to be writing code. You'll need to use a Cloudflare Dynamic Worker or a Durable Object Facet to execute that code and then inject the credentials for any services where that's needed. The agent is also going to need to have some mechanism to persist instructions to itself once it's set up a sync it’ll need to know where to find that data and how to update the code.

## Core requirements

- **Sync lifecycle**: the agent can create, update, inspect, and delete syncs. Updating should let it change handler logic or schema without losing existing data unless it explicitly chooses to.
- **Agent writes the code, runs in a facet**: the handler for each sync is LLM-generated JS loaded via the Cloudflare Worker Loader and executed as a Durable Object Facet with its own SQLite. The agent designs its own schema.
- **Isolation**: the facet's code cannot read the supervisor's storage and has no direct network access (`globalOutbound: null`). All outbound calls route through a proxy the supervisor controls.
- **Credentials the agent never sees**: third-party API calls go through a proxy via a supervisor-owned binding. The agent calls `env.PROXY.fetch(...)` and gets authenticated responses back without ever touching a token. This can be initally hardcoded with some API keys then extened to use any of the 3000+ integrations via the [**Pipedream Connect API Proxy**](https://pipedream.com/docs/connect/api-proxy)
- **Connections**: hard-code a handful of API keys to start (Linear + one more). Design the interface so arbitrary connections could be plugged in later, Pipedream handels most of the connection flow.
- **Background agents** (i.e. Webhook callbacks can spawn agents): at least one example where a running sync kicks off a further agent as part of processing (e.g. on some condition, summarise a batch of incoming items). This is where the "stateful serverless agent" vision starts to show up — we want to see you probe it, not build the full thing.
- **Public UI**: a page we can hit cold and play with. Show the agent, the generated code, the live schema, and the synced data. Present it however you like.
- **Deployed**: on Cloudflare. $5/month Workers Paid plan is the budget ceiling.

## Suggested stack

- [**Cloudflare Agents SDK**](https://developers.cloudflare.com/agents/) for the agent itself.
- [**Dynamic Workers + Durable Object Facets**](https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/) for running agent-authored code with isolated SQLite.
- [**Pipedream Connect API Proxy**](https://pipedream.com/docs/connect/api-proxy) for credential injection.
- Any LLM you like. Customise the prompts however you want.

You can run the agent anywhere, but keeping everything inside Cloudflare will probably save you time.

## What we're looking for

We want to see the difference between a vibe-coded prototype and something that looks finished.

- **Correctness under edge cases**: webhook retries, schema migrations that don't corrupt data, bad agent-generated code that fails loudly and recoverably.
- **Security model**: articulate in the README and in code exactly what the agent can and cannot do, and make the isolation real, not aspirational.
- **UI finish**: loading, error, and empty states actually exist. Someone hitting the URL cold should understand what they're looking at within 30 seconds.
- **README**: architecture, security model, how to deploy, what you'd do with another week. Include a diagram.

Use AI tools freely — we expect you to. In the README, tell us which parts you pair-programmed with an AI and where you overrode it. We're especially interested in what you did when the AI was wrong about the DO Facets API (it's new enough that its training data is thin).

## Out of scope

- Multi-tenant auth, teams, billing.
- Any fancy UI beyond what you genuinely need.

## Deliverables at end of day 4

1. Git repo with the full codebase.
2. README covering architecture, security model, deployment, and AI-tool notes.
3. Publicly accessible URL on your deployed Cloudflare account.
4. A short (≤3 min) Loom walking through a live demo.

Ask questions early if anything here is ambiguous. We'd rather re-scope on day 1 than find out on day 4.

---

# Our framing and decisions

_Everything above is the assignment as given. Everything below is our working notes — decisions we've made, scope we've phased, open questions, and the mental model we're building from. Fresh agent sessions should read the assignment above first, then this, to pick up where we left off._

## Stack

- **Language**: TypeScript end-to-end.
- **Runtime**: Cloudflare Workers + Durable Objects.
- **Sync execution**: DO Facets + Worker Loader (each sync = one Facet with its own isolated SQLite).
- **Agent framework**: Cloudflare Agents SDK.
- **LLM**: Claude Opus 4.7 via `@ai-sdk/anthropic` (model ID `claude-opus-4-7`, released 2026-04-16 — chosen for top-tier code generation and multi-step tool reasoning, which are the load-bearing skills for this agent).
- **HTTP**: Hono (CTO-confirmed — lightweight, Cloudflare-native).
- **UI**: React (from starter), served alongside the Worker.
- **Package manager**: pnpm; Node 22 pinned via `.nvmrc` and `package.json#engines`.

## Scope phasing

Two-phase build. **V1 is what gets graded.** V2 only after V1 is solid.

### V1 — core architecture (current focus)

This is the thing being judged. Everything here is non-negotiable:

- **Sync lifecycle**: agent can create / update / inspect / delete syncs.
- **Agent writes the handler + schema**: LLM-generated JS + SQL DDL deployed into a Facet via Worker Loader.
- **Isolation is real**:
  - Facet has its own SQLite (cannot read supervisor storage).
  - `globalOutbound: null` — no direct network access.
  - Only outbound path is `env.PROXY.fetch(...)` to a supervisor-owned proxy.
- **Credentials the agent never sees**: hardcoded tokens (Linear + one more — GitHub is the likely second) held in supervisor; proxy injects auth headers.
- **Agent self-memory**: registry of "which syncs exist for this user, where their data lives, what their current schema/code looks like" lives in supervisor DO storage, scoped per `user_id`.
- **Schema updates that preserve existing data by default** — treat migration correctness as the usability bar (see principles below).
- **UI**: chat + generated-code view + schema view + live data rows. Loading / empty / error states actually exist.
- **Two integrations**: Linear + GitHub (or Slack — TBD during design).
- **Deployed public URL** on Cloudflare, inside $5/month Workers Paid budget.

### V2 — stretch (after V1 is solid)

Both are nice-to-haves; the CTO explicitly said architecture is what's being judged, not these add-ons. Prioritize in roughly this order:

1. **Webhook-spawned sub-agent** (at least one compelling example). This is the most explicit ask in the assignment's stretch zone ("at least one example where a running sync kicks off a further agent"). "The more we deliver the better."
2. **Pipedream Connect** for credential injection beyond hardcoded services.

## User / identity model (CTO-confirmed)

- No real auth. No logins. No OAuth. Out of scope.
- Every visitor gets a server-issued `user_id` on first landing (stored in browser, e.g. localStorage).
- URL pattern: `/user/:userId` is that user's agent page. Sharable link is the identity.
- **Why this scoping matters**: if a user creates a sync, then comes back days later in a new chat thread, the agent must still know "these are your syncs, here's where your data is, here's the code running." That registry is keyed on `user_id` in the supervisor DO. Without it, the agent has no way to update existing syncs across sessions.
- Security posture: share-link model, not secure-login. Acceptable for a 4-day trial.

## The three phases of the system (mental model)

Reference this when designing. The agent only runs in phases 1 and 3 — phase 2 is code-only.

| Phase               | Agent runs? | LLM cost? | What happens                                                                                               |
| ------------------- | ----------- | --------- | ---------------------------------------------------------------------------------------------------------- |
| **1. Setup**        | Yes         | Yes       | User asks for a sync → agent designs schema, writes handler JS, deploys Facet, registers webhook upstream. |
| **2. Steady state** | **No**      | **No**    | Upstream fires webhook → Facet handler (agent-written code) runs → writes row to its own SQLite → sleeps.  |
| **3. Query**        | Yes         | Yes       | User asks a question → agent runs SQL against Facet SQLite → LLM reads rows → answers.                     |

## Principles we're optimizing for

- **Isolation must be real**, not aspirational. We should be able to demonstrate it, not just claim it. This is the primary grading signal.
- **LLM-generated code must fail loudly and recoverably**. A bad handler must not corrupt the DB or silently swallow webhook deliveries. Errors surface in the UI; retries are safe.
- **Update-without-data-loss is the usability bar**. When a user asks to reshape a sync ("also track last comment"), the agent migrates — it doesn't wipe. This is how humans build integrations; the agent should do the same.
- **UI finish**: loading / empty / error states must exist. Demo is cold-hit.
- **README must be concrete**: architecture diagram, explicit security model, deployment steps, AI-collab notes — especially where the AI was wrong about DO Facets. That last one is an explicit grading ask.

## Known risks (for fresh sessions to be aware of)

- **DO Facets + Worker Loader are very new. The official docs are thin.** AI tools (including whichever model is reading this) will have stale or wrong training data about the API. **Always verify Facet/Worker-Loader API shapes against live Cloudflare docs before trusting AI-generated code.** Expect to iterate and read carefully.
- **Schema migration correctness is non-trivial.** Don't hand-wave it. Think through additive vs. destructive changes, and how to preserve rows across code + DDL edits.

## Open questions (to revisit or confirm later)

- **Webhook signature verification**: not explicitly discussed with CTO. Standard practice says yes; Linear and GitHub both sign webhooks. Cheap to add at the supervisor layer — will do it.
- **Rate-limiting on the public URL**: LLM cost under abuse isn't discussed. Default plan: per-session message cap and a global budget guard.

## Current state of the repo (as of 2026-04-17)

- Scaffolded via `cloudflare/agents-starter` (React + Agents SDK + Vite + Tailwind).
- pnpm, Hono added, Node 22 pinned, rolldown arm64 binding explicitly pinned (pnpm optional-dep quirk with the rolldown RC).
- Workers AI removed; Anthropic Claude Opus 4.7 wired via `@ai-sdk/anthropic`.
- `.dev.vars` / `.dev.vars.example` pattern set up for `ANTHROPIC_API_KEY`.
- Chat works end-to-end locally (DO persists messages, WebSocket streams, Claude responds).
- **No sync architecture built yet.** Next step is architecture design on paper before any code touches the supervisor / Facet / proxy / webhook-router boundaries.
