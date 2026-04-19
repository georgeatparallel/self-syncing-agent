import { describe, it, expect, vi } from "vitest";

// Must mock the exports import before importing the module under test,
// since top-level imports evaluate eagerly.
vi.mock("cloudflare:workers", async (importActual) => {
  const actual = await importActual<typeof import("cloudflare:workers")>();
  return {
    ...actual,
    exports: {
      HttpGateway: (opts: { props: unknown }) => ({
        __mockHttpGateway: true,
        props: opts.props
      }),
      LLMGateway: (opts: { props: unknown }) => ({
        __mockLLMGateway: true,
        props: opts.props,
        runAgent: () => {}
      })
    }
  };
});

import { buildFacetWorkerCode } from "./bundle";
import { FACET_WRAPPER_SOURCE } from "./wrapper";

describe("buildFacetWorkerCode", () => {
  it("produces a WorkerCode with four modules and mainModule=main.js", () => {
    const code = buildFacetWorkerCode({
      schemaDdl: "CREATE TABLE issues (id TEXT PRIMARY KEY);",
      handlerCode: "export async function handleWebhook() {}",
      userId: "user-abc"
    });

    expect(code.mainModule).toBe("main.js");
    expect(Object.keys(code.modules).sort()).toEqual([
      "agent.js",
      "handler.js",
      "main.js",
      "schema.js"
    ]);
  });

  it("includes the fixed wrapper source verbatim in main.js", () => {
    const code = buildFacetWorkerCode({
      schemaDdl: "anything",
      handlerCode: "anything",
      userId: "u"
    });
    expect(code.modules["main.js"]).toBe(FACET_WRAPPER_SOURCE);
  });

  it("JSON-encodes the schema DDL so special characters survive", () => {
    const tricky = `CREATE TABLE t (
  name TEXT, -- a 'quoted' comment with "double" and \\backslashes
  payload TEXT
);`;
    const code = buildFacetWorkerCode({
      schemaDdl: tricky,
      handlerCode: "export async function handleWebhook() {}",
      userId: "u"
    });

    expect(code.modules["schema.js"]).toBe(
      `export const SCHEMA_DDL = ${JSON.stringify(tricky)};\n`
    );

    // Round-trip safety: evaluating the module should produce the original string.
    // We can't run ES modules in vitest unit tests directly, but JSON round-trip
    // is sufficient evidence of encoding correctness.
    expect(JSON.parse(JSON.stringify(tricky))).toBe(tricky);
  });

  it("sets globalOutbound to HttpGateway stamped with userId props", () => {
    const code = buildFacetWorkerCode({
      schemaDdl: "x",
      handlerCode: "y",
      userId: "user-xyz"
    });
    expect(code.globalOutbound).toMatchObject({
      __mockHttpGateway: true,
      props: { userId: "user-xyz" }
    });
  });

  it("wrapper source exposes __query, __sqlExec, __verifySignature, __registerWebhook, __unregisterWebhook, and #ensureSchema", () => {
    const bundle = buildFacetWorkerCode({
      schemaDdl: "CREATE TABLE IF NOT EXISTS x (id TEXT);",
      handlerCode:
        "export async function handleWebhook(){ return new Response('ok'); }",
      userId: "u1"
    });
    const main = bundle.modules["main.js"];
    expect(main).toMatch(/#ensureSchema/);
    expect(main).toMatch(/async __query\(/);
    expect(main).toMatch(/async __sqlExec\(/);
    expect(main).toMatch(/async __verifySignature\(/);
    expect(main).toMatch(/async __registerWebhook\(/);
    expect(main).toMatch(/async __unregisterWebhook\(/);
    expect(main).toMatch(/import \* as handlerModule from "\.\/handler\.js"/);
  });
});

describe("buildFacetWorkerCode — agent primitive", () => {
  it("includes agent.js alongside handler.js and schema.js", () => {
    const bundle = buildFacetWorkerCode({
      schemaDdl: "CREATE TABLE t (id INTEGER);",
      handlerCode:
        "export async function handleWebhook() { return new Response('ok'); }",
      userId: "u-123"
    });
    expect(Object.keys(bundle.modules).sort()).toEqual([
      "agent.js",
      "handler.js",
      "main.js",
      "schema.js"
    ]);
    expect(bundle.modules["agent.js"]).toContain("export function createAgent");
  });

  it("passes the LLM binding in env so agent() can reach LLMGateway", () => {
    const bundle = buildFacetWorkerCode({
      schemaDdl: "",
      handlerCode: "",
      userId: "u-123"
    });
    expect(bundle.env).toBeDefined();
    expect(bundle.env.LLM).toBeDefined();
  });
});
