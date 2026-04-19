import type { ModelMessage } from "ai";

/**
 * Returns true iff any `tool-call` part in an assistant message in the
 * given history is not paired with a matching `tool-result` part in a
 * subsequent tool/assistant message.
 *
 * Why this exists: `@cloudflare/ai-chat` resumes the stream via
 * `addToolResult` on each individual tool-approval click. When the agent
 * emits N parallel tool_use blocks and the user approves them one by
 * one, each click re-invokes `onChatMessage`. During the intermediate
 * states the message history has N tool_use blocks with fewer than N
 * tool_result blocks — Anthropic's API rejects this as
 * `MissingToolResultsError`. This helper lets the server detect the
 * incomplete state and skip the LLM call until the last approval lands.
 *
 * Naming: we use the Vercel AI SDK's part type names (`"tool-call"` /
 * `"tool-result"`), not Anthropic's wire format (`"tool_use"` /
 * `"tool_result"`). `convertToModelMessages` emits the SDK shape.
 */
export function hasUnresolvedToolCalls(messages: ModelMessage[]): boolean {
  const open = new Set<string>();

  for (const msg of messages) {
    if (msg.role === "assistant") {
      // Assistant content can be a plain string (no tool calls) or an
      // array of parts. Only the array form may contain tool-call parts.
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === "tool-call") {
            open.add(part.toolCallId);
          } else if (part.type === "tool-result") {
            // Provider-executed tool results can appear inline in the
            // assistant message; they still satisfy pairing.
            open.delete(part.toolCallId);
          }
        }
      }
    } else if (msg.role === "tool") {
      // Tool messages always carry an array of tool-result /
      // tool-approval-response parts.
      for (const part of msg.content) {
        if (part.type === "tool-result") {
          open.delete(part.toolCallId);
        }
      }
    }
    // system and user messages never contain tool-call / tool-result
    // parts and can be ignored.
  }

  return open.size > 0;
}
