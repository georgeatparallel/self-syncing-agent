import { describe, it, expect } from "vitest";
import { resolveAppSlug, HOST_TO_APP_SLUG } from "./host-mapping";

describe("resolveAppSlug", () => {
  it("maps api.github.com to github", () => {
    expect(resolveAppSlug("api.github.com")).toBe("github");
  });
  it("maps slack.com to slack", () => {
    expect(resolveAppSlug("slack.com")).toBe("slack");
  });
  it("maps api.notion.com to notion", () => {
    expect(resolveAppSlug("api.notion.com")).toBe("notion");
  });
  it("is case-insensitive on hostname", () => {
    expect(resolveAppSlug("API.GITHUB.COM")).toBe("github");
  });
  it("maps api.linear.app to linear", () => {
    expect(resolveAppSlug("api.linear.app")).toBe("linear");
  });
  it("returns null for unknown hosts", () => {
    expect(resolveAppSlug("example.com")).toBeNull();
  });
  it("HOST_TO_APP_SLUG keys are all lowercase", () => {
    for (const key of Object.keys(HOST_TO_APP_SLUG)) {
      expect(key).toBe(key.toLowerCase());
    }
  });
});
