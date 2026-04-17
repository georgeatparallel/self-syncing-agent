import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

describe("per-user DO scoping", () => {
  it("produces distinct DO instances for distinct userIds", () => {
    const idA = env.ChatAgent.idFromName("user-a");
    const idB = env.ChatAgent.idFromName("user-b");
    expect(idA.toString()).not.toBe(idB.toString());
  });

  it("produces the same DO instance for the same userId across calls", () => {
    const first = env.ChatAgent.idFromName("user-stable").toString();
    const second = env.ChatAgent.idFromName("user-stable").toString();
    expect(first).toBe(second);
  });
});
