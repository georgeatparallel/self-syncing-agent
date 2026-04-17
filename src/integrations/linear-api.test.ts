import { describe, it, expect, vi } from "vitest";
import { registerLinearWebhook, unregisterLinearWebhook } from "./linear-api";

function mockResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

describe("registerLinearWebhook", () => {
  it("returns { id, secret, enabled } on success", async () => {
    const fetcher = vi.fn(async () =>
      mockResponse({
        data: {
          webhookCreate: {
            success: true,
            webhook: { id: "wh_abc", secret: "sec_xyz", enabled: true }
          }
        }
      })
    );

    const result = await registerLinearWebhook(
      "lin_oauth_test",
      "https://example.com/webhook",
      ["Issue"],
      "self-syncing-agent:test",
      fetcher
    );

    expect(result).toEqual({ id: "wh_abc", secret: "sec_xyz", enabled: true });

    // Verify the call shape
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [
      string,
      RequestInit
    ];
    expect(url).toBe("https://api.linear.app/graphql");
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer lin_oauth_test"
    );
    const parsed = JSON.parse(init.body as string);
    expect(parsed.variables).toEqual({
      url: "https://example.com/webhook",
      resourceTypes: ["Issue"],
      label: "self-syncing-agent:test"
    });
  });

  it("sends personal API keys without the Bearer prefix", async () => {
    const fetcher = vi.fn(async () =>
      mockResponse({
        data: {
          webhookCreate: {
            success: true,
            webhook: { id: "wh_abc", secret: "sec_xyz", enabled: true }
          }
        }
      })
    );

    await registerLinearWebhook(
      "lin_api_plain",
      "https://example.com/webhook",
      ["Issue"],
      "label",
      fetcher
    );

    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    // Linear rejects personal API keys wrapped in `Bearer ` with 401.
    expect((init.headers as Record<string, string>).authorization).toBe(
      "lin_api_plain"
    );
  });

  it("throws LinearApiError with auth_failed code on 401", async () => {
    const fetcher = vi.fn(async () => mockResponse({}, 401));
    await expect(
      registerLinearWebhook("bad", "url", ["Issue"], "label", fetcher)
    ).rejects.toMatchObject({
      code: "linear_api_auth_failed",
      name: "LinearApiError"
    });
  });

  it("throws LinearApiError with error messages on GraphQL errors", async () => {
    const fetcher = vi.fn(async () =>
      mockResponse({
        errors: [{ message: "not authorized" }, { message: "invalid input" }]
      })
    );
    await expect(
      registerLinearWebhook("tok", "url", ["Issue"], "label", fetcher)
    ).rejects.toMatchObject({
      code: "linear_api_error",
      message: expect.stringMatching(/not authorized.*invalid input/)
    });
  });

  it("throws when webhookCreate returns success=false without errors", async () => {
    const fetcher = vi.fn(async () =>
      mockResponse({
        data: {
          webhookCreate: {
            success: false,
            webhook: { id: "", secret: "", enabled: false }
          }
        }
      })
    );
    await expect(
      registerLinearWebhook("tok", "url", ["Issue"], "label", fetcher)
    ).rejects.toThrow(/success=false/);
  });
});

describe("unregisterLinearWebhook", () => {
  it("resolves void on success", async () => {
    const fetcher = vi.fn(async () =>
      mockResponse({ data: { webhookDelete: { success: true } } })
    );
    await expect(
      unregisterLinearWebhook("tok", "wh_abc", fetcher)
    ).resolves.toBeUndefined();
  });

  it("throws on GraphQL errors", async () => {
    const fetcher = vi.fn(async () =>
      mockResponse({ errors: [{ message: "webhook not found" }] })
    );
    await expect(
      unregisterLinearWebhook("tok", "wh_missing", fetcher)
    ).rejects.toThrow(/webhook not found/);
  });
});
