import { describe, it, expect, vi } from "vitest";

// Must mock the exports import before importing the module under test,
// since top-level imports evaluate eagerly. Same pattern as src/facet/bundle.test.ts.
vi.mock("cloudflare:workers", async (importActual) => {
  const actual = await importActual<typeof import("cloudflare:workers")>();
  return {
    ...actual,
    exports: {
      HttpGateway: (opts: { props: unknown }) => ({
        __mockHttpGateway: true,
        props: opts.props
      })
    }
  };
});

import { buildExecWorkerCode } from "./bundle";
import { EXEC_WRAPPER_SOURCE } from "./wrapper";

const SAMPLE_CODE = `
export async function runInSync(facet, fetch) {
  return { ok: true };
}
`;

describe("buildExecWorkerCode", () => {
  it("produces a WorkerCode with main.js + exec.js and mainModule=main.js", () => {
    const code = buildExecWorkerCode({
      code: SAMPLE_CODE,
      userId: "user-abc"
    });
    expect(code.mainModule).toBe("main.js");
    expect(Object.keys(code.modules).sort()).toEqual(["exec.js", "main.js"]);
  });

  it("embeds the agent-authored code verbatim as exec.js", () => {
    const code = buildExecWorkerCode({
      code: SAMPLE_CODE,
      userId: "u"
    });
    expect(code.modules["exec.js"]).toBe(SAMPLE_CODE);
  });

  it("includes the fixed wrapper source verbatim in main.js", () => {
    const code = buildExecWorkerCode({
      code: SAMPLE_CODE,
      userId: "u"
    });
    expect(code.modules["main.js"]).toBe(EXEC_WRAPPER_SOURCE);
  });

  it("pins a compatibilityDate matching the parent worker", () => {
    const code = buildExecWorkerCode({
      code: SAMPLE_CODE,
      userId: "u"
    });
    // Must match wrangler.jsonc's compatibility_date so facet and exec
    // isolates share the same runtime semantics.
    expect(code.compatibilityDate).toBe("2026-03-02");
  });

  it("sets globalOutbound to HttpGateway stamped with userId props", () => {
    const code = buildExecWorkerCode({
      code: SAMPLE_CODE,
      userId: "user-xyz"
    });
    expect(code.globalOutbound).toMatchObject({
      __mockHttpGateway: true,
      props: { userId: "user-xyz" }
    });
  });
});
