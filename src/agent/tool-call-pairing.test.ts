import { describe, it, expect } from "vitest";
import type { ModelMessage } from "ai";
import { hasUnresolvedToolCalls } from "./tool-call-pairing";

function toolCall(
  id: string,
  name = "t"
): {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  input: unknown;
} {
  return { type: "tool-call", toolCallId: id, toolName: name, input: {} };
}

function toolResult(
  id: string,
  name = "t"
): {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  output: { type: "text"; value: string };
} {
  return {
    type: "tool-result",
    toolCallId: id,
    toolName: name,
    output: { type: "text", value: "ok" }
  };
}

describe("hasUnresolvedToolCalls", () => {
  it("returns false for an empty history", () => {
    expect(hasUnresolvedToolCalls([])).toBe(false);
  });

  it("returns false when a tool_call is paired in the next tool message", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [toolCall("c1")] },
      { role: "tool", content: [toolResult("c1")] }
    ];
    expect(hasUnresolvedToolCalls(messages)).toBe(false);
  });

  it("returns true when an assistant emits two tool_calls but only one tool_result follows", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [toolCall("c1"), toolCall("c2")]
      },
      { role: "tool", content: [toolResult("c1")] }
    ];
    expect(hasUnresolvedToolCalls(messages)).toBe(true);
  });

  it("returns false when multiple interleaved assistant/tool messages are all paired", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: [toolCall("c1")] },
      { role: "tool", content: [toolResult("c1")] },
      { role: "assistant", content: [toolCall("c2"), toolCall("c3")] },
      {
        role: "tool",
        content: [toolResult("c2"), toolResult("c3")]
      },
      { role: "assistant", content: "all done" }
    ];
    expect(hasUnresolvedToolCalls(messages)).toBe(false);
  });

  it("accepts a tool_result that arrives several turns after the tool_call", () => {
    const messages: ModelMessage[] = [
      { role: "assistant", content: [toolCall("c1")] },
      { role: "assistant", content: "thinking aloud" },
      { role: "tool", content: [toolResult("c1")] }
    ];
    expect(hasUnresolvedToolCalls(messages)).toBe(false);
  });

  it("treats a tool_use paired in a LATER turn as resolved even though mid-history looks unpaired", () => {
    const messages: ModelMessage[] = [
      { role: "assistant", content: [toolCall("c1")] },
      { role: "user", content: "nudge" },
      { role: "assistant", content: [toolCall("c2")] },
      {
        role: "tool",
        content: [toolResult("c1"), toolResult("c2")]
      }
    ];
    expect(hasUnresolvedToolCalls(messages)).toBe(false);
  });

  it("ignores system and plain user messages", () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "you are a helpful agent" },
      { role: "user", content: "hello" }
    ];
    expect(hasUnresolvedToolCalls(messages)).toBe(false);
  });

  it("accepts assistant messages with a plain-string content (no tool parts)", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello back" }
    ];
    expect(hasUnresolvedToolCalls(messages)).toBe(false);
  });
});
