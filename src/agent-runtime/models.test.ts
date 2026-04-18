import { describe, it, expect } from "vitest";
import { resolveModelId, MODEL_TIERS } from "./models";

describe("resolveModelId", () => {
  it("maps haiku to the latest Haiku model id", () => {
    expect(resolveModelId("haiku")).toBe("claude-haiku-4-5");
  });
  it("maps sonnet to the latest Sonnet model id", () => {
    expect(resolveModelId("sonnet")).toBe("claude-sonnet-4-6");
  });
  it("maps opus to the latest Opus model id", () => {
    expect(resolveModelId("opus")).toBe("claude-opus-4-7");
  });
  it("exposes the tier names as a tuple for validation", () => {
    expect(MODEL_TIERS).toEqual(["haiku", "sonnet", "opus"]);
  });
});
