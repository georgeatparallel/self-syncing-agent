import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("worker harness smoke test", () => {
  it("responds with 404 to an unknown route", async () => {
    const response = await SELF.fetch(
      "https://example.com/this-path-does-not-exist"
    );

    expect(response.status).toBe(404);
    const body = await response.text();
    expect(body).toBe("Not found");
  });
});
