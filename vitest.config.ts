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
            PUBLIC_BASE_URL: "https://test.invalid",
            // Override .dev.vars so the real dev value doesn't leak into
            // Worker runs — individual tests mock `jose` to short-circuit
            // JWT verification and then inject the Access header with the
            // per-test userId (see tests/pipedream-routes.test.ts,
            // tests/ops-panel-api.test.ts). An empty fallback keeps the
            // middleware strict: any test that forgets to wire auth will
            // fail with 401 rather than silently authenticating as the
            // dev user.
            DEV_FALLBACK_USER: ""
          }
        }
      }
    }
  }
});
