// src/agent-runtime/types.ts
import type { ModelTier } from "./models";

/** Request shape accepted by LLMGateway.runAgent and the agent() primitive. */
export interface AgentRequest {
  model?: ModelTier; // default "sonnet"
  system: string;
  messages: Array<
    { role: "user"; content: string } | { role: "assistant"; content: string }
  >;
  maxSteps?: number; // default 8, capped at 15
}

export type AgentResult =
  | {
      ok: true;
      text: string;
      steps: number;
      usage: { input_tokens: number; output_tokens: number };
    }
  | { ok: false; error: string; detail?: string };

/** Third argument passed to the agent-authored handleWebhook. */
export interface HandlerCtx {
  agent(request: AgentRequest): Promise<string>;
  waitUntil(promise: Promise<unknown>): void;
}

/** Input passed across RpcTarget for exec tool. */
export interface ExecToolInput {
  code: string;
}

export type ExecToolResult =
  | {
      ok: true;
      result: unknown;
      logs: Array<{ level: string; message: string; ts: number }>;
    }
  | {
      ok: false;
      error: string;
      detail?: string;
      stack?: string | null;
      logs: Array<{ level: string; message: string; ts: number }>;
    };
