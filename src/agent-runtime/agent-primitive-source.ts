// src/agent-runtime/agent-primitive-source.ts

/**
 * Fixed source for agent.js — bundled into every facet alongside
 * handler.js and schema.js. Exports createAgent(deps) which returns
 * the user-facing agent() function. The facet wrapper constructs a
 * FacetAgentBridge, wires it up, and passes the resulting function
 * as ctx.agent to handleWebhook(request, sql, ctx).
 *
 * This module runs inside the facet isolate. It holds no keys and
 * does no I/O on its own — every call delegates to env.LLM (a
 * stamped LLMGateway WorkerEntrypoint) in the supervisor.
 */
export const AGENT_PRIMITIVE_SOURCE = `
export function createAgent({ llm, bridge }) {
  if (!llm || typeof llm.runAgent !== "function") {
    throw new Error("createAgent: env.LLM.runAgent is not available");
  }
  let callsInFlight = 0;
  return async function agent(request) {
    if (callsInFlight > 0) {
      throw new Error("agent(): nested calls are not permitted inside a single handler invocation");
    }
    callsInFlight++;
    try {
      const result = await llm.runAgent(request, bridge);
      if (!result.ok) {
        throw new Error("agent() failed: " + result.error + (result.detail ? ": " + result.detail : ""));
      }
      return result.text;
    } finally {
      callsInFlight--;
    }
  };
}
`;
