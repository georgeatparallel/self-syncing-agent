import { describe, it, expect } from "vitest";
import { isDeniedHost } from "./app-hosts";

describe("isDeniedHost (SSRF)", () => {
  it("blocks IPv4 loopback", () => {
    expect(isDeniedHost("127.0.0.1")).toBe(true);
    expect(isDeniedHost("127.255.255.255")).toBe(true);
  });
  it("blocks private IPv4", () => {
    ["10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1"].forEach((h) =>
      expect(isDeniedHost(h)).toBe(true)
    );
  });
  it("blocks cloud metadata", () => {
    expect(isDeniedHost("169.254.169.254")).toBe(true);
  });
  it("blocks localhost + *.internal/.local", () => {
    ["localhost", "foo.internal", "bar.local"].forEach((h) =>
      expect(isDeniedHost(h)).toBe(true)
    );
  });
  it("blocks IPv6 loopback + ULA", () => {
    ["::1", "fc00::1", "fd12:3456::1"].forEach((h) =>
      expect(isDeniedHost(h)).toBe(true)
    );
  });
  it("blocks IPv4-mapped IPv6 (::ffff:a.b.c.d)", () => {
    expect(isDeniedHost("::ffff:127.0.0.1")).toBe(true);
    expect(isDeniedHost("::ffff:169.254.169.254")).toBe(true);
    expect(isDeniedHost("::ffff:10.0.0.1")).toBe(true);
  });
  it("allows IPv4-mapped IPv6 to public hosts", () => {
    expect(isDeniedHost("::ffff:8.8.8.8")).toBe(false);
  });
  it("allows public hosts", () => {
    ["api.github.com", "8.8.8.8"].forEach((h) =>
      expect(isDeniedHost(h)).toBe(false)
    );
  });
});
