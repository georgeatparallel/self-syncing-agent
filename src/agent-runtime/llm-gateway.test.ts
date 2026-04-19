import { describe, it, expect, vi, beforeEach } from "vitest";
import { runAgent } from "./llm-gateway";
import type { AgentRequest } from "./types";

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    generateText: vi.fn()
  };
});
vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: vi.fn(() => (id: string) => ({ id }))
}));
vi.mock("../proxy/http-gateway", () => ({
  handleGatewayRequest: vi.fn()
}));

import { generateText } from "ai";
import { handleGatewayRequest } from "../proxy/http-gateway";

const baseReq: AgentRequest = {
  model: "sonnet",
  system: "You are a test bot.",
  messages: [{ role: "user", content: "hello" }]
};

const fakeBridge = {
  sqlQuery: vi.fn(),
  sqlExec: vi.fn(),
  getUserId: vi.fn().mockResolvedValue("u-1"),
  getSyncId: vi.fn().mockResolvedValue("s-1")
};

// Shared stub mock for ChatAgent DO. Individual tests override the
// return value of listPipedreamAccounts when they care about its shape.
const listPipedreamAccountsMock = vi.fn().mockResolvedValue([]);
const chatAgentStub = { listPipedreamAccounts: listPipedreamAccountsMock };

const fakeEnv = {
  ANTHROPIC_API_KEY: "k",
  LOADER: {} as WorkerLoader,
  ChatAgent: {
    idFromName: (n: string) => n,
    get: () => chatAgentStub
  }
} as unknown as Env;

describe("runAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakeBridge.getUserId.mockResolvedValue("u-1");
    fakeBridge.getSyncId.mockResolvedValue("s-1");
    listPipedreamAccountsMock.mockResolvedValue([]);
  });

  it("returns the model's final text on a tool-free response", async () => {
    vi.mocked(generateText).mockResolvedValue({
      text: "hello back",
      steps: [{}],
      usage: { inputTokens: 10, outputTokens: 5 }
    } as unknown as Awaited<ReturnType<typeof generateText>>);

    const result = await runAgent(baseReq, fakeBridge as never, fakeEnv);
    expect(result).toEqual({
      ok: true,
      text: "hello back",
      steps: 1,
      usage: { input_tokens: 10, output_tokens: 5 }
    });
  });

  it("defaults to sonnet when model is omitted", async () => {
    vi.mocked(generateText).mockResolvedValue({
      text: "ok",
      steps: [],
      usage: { inputTokens: 0, outputTokens: 0 }
    } as unknown as Awaited<ReturnType<typeof generateText>>);

    await runAgent(
      {
        system: "s",
        messages: [{ role: "user", content: "x" }]
      } as AgentRequest,
      fakeBridge as never,
      fakeEnv
    );
    const call = vi.mocked(generateText).mock.calls[0][0] as unknown as {
      model: { id: string };
    };
    expect(call.model.id).toBe("claude-sonnet-4-6");
  });

  it("caps maxSteps at 15 even when a higher number is requested", async () => {
    vi.mocked(generateText).mockResolvedValue({
      text: "ok",
      steps: [],
      usage: { inputTokens: 0, outputTokens: 0 }
    } as unknown as Awaited<ReturnType<typeof generateText>>);

    await runAgent(
      { ...baseReq, maxSteps: 9999 },
      fakeBridge as never,
      fakeEnv
    );
    const call = vi.mocked(generateText).mock.calls[0][0] as {
      stopWhen: (ctx: { steps: unknown[] }) => boolean | Promise<boolean>;
    };
    const at14 = await call.stopWhen({ steps: new Array(14) });
    const at15 = await call.stopWhen({ steps: new Array(15) });
    expect(at14).toBe(false);
    expect(at15).toBe(true);
  });

  it("defaults maxSteps to 8 when not specified", async () => {
    vi.mocked(generateText).mockResolvedValue({
      text: "ok",
      steps: [],
      usage: { inputTokens: 0, outputTokens: 0 }
    } as unknown as Awaited<ReturnType<typeof generateText>>);

    await runAgent(baseReq, fakeBridge as never, fakeEnv);
    const call = vi.mocked(generateText).mock.calls[0][0] as {
      stopWhen: (ctx: { steps: unknown[] }) => boolean | Promise<boolean>;
    };
    const at7 = await call.stopWhen({ steps: new Array(7) });
    const at8 = await call.stopWhen({ steps: new Array(8) });
    expect(at7).toBe(false);
    expect(at8).toBe(true);
  });

  it("returns { ok: false } when generateText throws", async () => {
    vi.mocked(generateText).mockRejectedValue(new Error("network blew up"));
    const result = await runAgent(baseReq, fakeBridge as never, fakeEnv);
    expect(result).toEqual({
      ok: false,
      error: "llm_failed",
      detail: "network blew up"
    });
  });

  it("wires sql tool to bridge.sqlExec", async () => {
    vi.mocked(generateText).mockImplementation((async (opts: unknown) => {
      const tools = (
        opts as {
          tools: Record<
            string,
            { execute: (input: unknown) => Promise<unknown> }
          >;
        }
      ).tools;
      await tools.sql.execute({ query: "SELECT 1" });
      return {
        text: "done",
        steps: [],
        usage: { inputTokens: 0, outputTokens: 0 }
      } as unknown as Awaited<ReturnType<typeof generateText>>;
    }) as unknown as typeof generateText);
    fakeBridge.sqlExec.mockResolvedValue({
      ok: true,
      rowsWritten: 0,
      rowsRead: 1
    });
    await runAgent(baseReq, fakeBridge as never, fakeEnv);
    expect(fakeBridge.sqlExec).toHaveBeenCalledWith("SELECT 1");
  });

  it("prepends a <connected_accounts> ambient-context message before the caller's messages", async () => {
    listPipedreamAccountsMock.mockResolvedValueOnce([
      {
        app_slug: "slack",
        account_id: "apn_1",
        user_id: "u-1",
        connected_at: 1700000000000
      }
    ]);
    vi.mocked(generateText).mockResolvedValue({
      text: "ok",
      steps: [],
      usage: { inputTokens: 0, outputTokens: 0 }
    } as unknown as Awaited<ReturnType<typeof generateText>>);

    await runAgent(baseReq, fakeBridge as never, fakeEnv);

    expect(listPipedreamAccountsMock).toHaveBeenCalledWith("u-1");
    const call = vi.mocked(generateText).mock.calls[0][0] as unknown as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(call.messages.length).toBe(baseReq.messages.length + 1);
    const first = call.messages[0];
    expect(first.role).toBe("user");
    expect(first.content).toContain("<connected_accounts>");
    expect(first.content).toContain("slack");
    // Caller's messages come after the ambient block in the same order.
    expect(call.messages[1]).toEqual(baseReq.messages[0]);
  });

  it("falls back to an empty <connected_accounts> block when the ChatAgent RPC throws", async () => {
    listPipedreamAccountsMock.mockRejectedValueOnce(
      new Error("DO unavailable")
    );
    vi.mocked(generateText).mockResolvedValue({
      text: "ok",
      steps: [],
      usage: { inputTokens: 0, outputTokens: 0 }
    } as unknown as Awaited<ReturnType<typeof generateText>>);

    const result = await runAgent(baseReq, fakeBridge as never, fakeEnv);
    expect(result.ok).toBe(true);
    const call = vi.mocked(generateText).mock.calls[0][0] as unknown as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(call.messages[0].content).toContain("<connected_accounts>");
    expect(call.messages[0].content).toContain(
      "No Pipedream integrations connected"
    );
  });

  it("wires fetch tool to handleGatewayRequest (supervisor-side, no facet bounce)", async () => {
    vi.mocked(generateText).mockImplementation((async (opts: unknown) => {
      const tools = (
        opts as {
          tools: Record<
            string,
            { execute: (input: unknown) => Promise<unknown> }
          >;
        }
      ).tools;
      const out = await tools.fetch.execute({
        url: "https://api.linear.app/graphql",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"query":"x"}'
      });
      expect(out).toEqual({ status: 201, body: "created" });
      return {
        text: "done",
        steps: [],
        usage: { inputTokens: 0, outputTokens: 0 }
      } as unknown as Awaited<ReturnType<typeof generateText>>;
    }) as unknown as typeof generateText);
    vi.mocked(handleGatewayRequest).mockResolvedValue(
      new Response("created", { status: 201 })
    );
    await runAgent(baseReq, fakeBridge as never, fakeEnv);
    expect(handleGatewayRequest).toHaveBeenCalledTimes(1);
    const [req, env, props] = vi.mocked(handleGatewayRequest).mock.calls[0];
    expect(req.url).toBe("https://api.linear.app/graphql");
    expect(req.method).toBe("POST");
    expect(env).toBe(fakeEnv);
    expect(props).toEqual({ userId: "u-1", syncId: "s-1" });
  });
});
