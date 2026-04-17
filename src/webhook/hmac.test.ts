import { describe, it, expect } from "vitest";
import { verifyLinearSignature } from "./hmac";

const SECRET = "test-secret";
const BODY = new TextEncoder().encode('{"hello":"world"}');

async function sign(
  bodyBytes: Uint8Array<ArrayBuffer>,
  secret: string
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, bodyBytes);
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

describe("verifyLinearSignature", () => {
  it("returns true for a correctly-signed body", async () => {
    const sig = await sign(BODY, SECRET);
    expect(await verifyLinearSignature(BODY, sig, SECRET)).toBe(true);
  });

  it("returns false when the signature was produced with a different secret", async () => {
    const sig = await sign(BODY, "different-secret");
    expect(await verifyLinearSignature(BODY, sig, SECRET)).toBe(false);
  });

  it("returns false when the body has been tampered with", async () => {
    const sig = await sign(BODY, SECRET);
    const tampered = new TextEncoder().encode('{"hello":"world!"}');
    expect(await verifyLinearSignature(tampered, sig, SECRET)).toBe(false);
  });

  it("returns false for malformed hex (odd length)", async () => {
    expect(await verifyLinearSignature(BODY, "abc", SECRET)).toBe(false);
  });

  it("returns false for hex with non-hex characters", async () => {
    expect(
      await verifyLinearSignature(BODY, "zz" + "00".repeat(31), SECRET)
    ).toBe(false);
  });

  it("returns false for an empty signature string", async () => {
    expect(await verifyLinearSignature(BODY, "", SECRET)).toBe(false);
  });
});
