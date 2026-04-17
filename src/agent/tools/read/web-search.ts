import { tool } from "ai";
import { z } from "zod";
import Parallel, {
  APIError,
  AuthenticationError,
  RateLimitError
} from "parallel-web";
import type { ChatAgent } from "../../../server";

const DEFAULT_MODE = "agentic" as const;
const DEFAULT_EXCERPT_CHARS = 4000;

export function webSearchTool(agent: ChatAgent) {
  return tool({
    description:
      "Search the web for current information via Parallel AI's agentic search. Use for: verifying an integration's API/webhook shape, looking up error-code meanings, researching recent API changes, fact-checking. Returns up to 10 excerpts of ~4KB each ranked by relevance.",
    inputSchema: z.object({
      objective: z
        .string()
        .describe(
          "Natural-language description of what you're trying to find. Keep it focused on ONE concrete question — this drives quality more than keyword queries."
        ),
      search_queries: z
        .array(z.string().max(200))
        .max(5)
        .optional()
        .describe(
          "(optional) Up to 5 keyword queries (≤200 chars each) to seed the search. Leave unset for agentic-mode default behavior."
        )
    }),
    execute: async ({ objective, search_queries }) => {
      const client = new Parallel({ apiKey: agent.env.PARALLEL_API_KEY });
      try {
        const result = await client.beta.search({
          objective,
          search_queries: search_queries ?? null,
          mode: DEFAULT_MODE,
          excerpts: { max_chars_per_result: DEFAULT_EXCERPT_CHARS }
        });
        return {
          objective,
          search_id: result.search_id,
          result_count: result.results.length,
          results: result.results.map((r) => ({
            url: r.url,
            title: r.title ?? null,
            excerpts: r.excerpts ?? [],
            publish_date: r.publish_date ?? null
          }))
        };
      } catch (e) {
        // Narrow error surface so the agent can decide how to respond:
        // back off on rate-limit vs. surface "key is bad" to the user vs.
        // treat a generic 5xx as retryable. All three branches extend
        // APIError, so order matters — check specific types first.
        if (e instanceof RateLimitError) {
          return { error: "parallel_ai_rate_limit", detail: e.message };
        }
        if (e instanceof AuthenticationError) {
          return { error: "parallel_ai_auth_failed", detail: e.message };
        }
        if (e instanceof APIError) {
          return {
            error: "parallel_ai_request_failed",
            status: e.status,
            detail: e.message
          };
        }
        throw e;
      }
    }
  });
}
