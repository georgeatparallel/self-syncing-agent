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
            ANTHROPIC_API_KEY: "test-stub-key",
            PARALLEL_API_KEY: "test-stub-key",
            LINEAR_ACCESS_TOKEN: "test-stub-token"
          }
        }
      }
    }
  }
});
