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

import { generateText } from "ai";

const baseReq: AgentRequest = {
  model: "sonnet",
  system: "You are a test bot.",
  messages: [{ role: "user", content: "hello" }]
};

const fakeBridge = {
  sqlQuery: vi.fn(),
  sqlExec: vi.fn(),
  gatewayFetch: vi.fn(),
  getUserId: vi.fn().mockResolvedValue("u-1")
};

const fakeEnv = {
  ANTHROPIC_API_KEY: "k",
  LOADER: {} as WorkerLoader
};

describe("runAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakeBridge.getUserId.mockResolvedValue("u-1");
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
      { system: "s", messages: [{ role: "user", content: "x" }] } as AgentRequest,
      fakeBridge as never,
      fakeEnv
    );
    const call = vi.mocked(generateText).mock.calls[0][0] as unknown as { model: { id: string } };
    expect(call.model.id).toBe("claude-sonnet-4-6");
  });

  it("caps maxSteps at 15", async () => {
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
    const call = vi.mocked(generateText).mock.calls[0][0] as unknown as { stopWhen: unknown };
    expect(call.stopWhen).toBeDefined();
  });

  it("returns { ok: false } when generateText throws", async () => {
    vi.mocked(generateText).mockRejectedValue(new Error("network blew up"));
    const result = await runAgent(baseReq, fakeBridge as never, fakeEnv);
    expect(result).toEqual({ ok: false, error: "llm_failed", detail: "network blew up" });
  });

  it("wires sql tool to bridge.sqlExec", async () => {
    vi.mocked(generateText).mockImplementation((async (opts: unknown) => {
      const tools = (opts as { tools: Record<string, { execute: (input: unknown) => Promise<unknown> }> }).tools;
      await tools.sql.execute({ query: "SELECT 1" });
      return {
        text: "done",
        steps: [],
        usage: { inputTokens: 0, outputTokens: 0 }
      } as unknown as Awaited<ReturnType<typeof generateText>>;
    }) as unknown as typeof generateText);
    fakeBridge.sqlExec.mockResolvedValue({ ok: true, rowsWritten: 0, rowsRead: 1 });
    await runAgent(baseReq, fakeBridge as never, fakeEnv);
    expect(fakeBridge.sqlExec).toHaveBeenCalledWith("SELECT 1");
  });
});
