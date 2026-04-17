/**
 * Verify a Linear webhook signature. Linear computes HMAC-SHA256 over
 * the raw request body with the per-webhook secret returned from
 * `webhookCreate` and ships the result as lowercase hex in the
 * `Linear-Signature` header.
 *
 * Returns false (never throws) on: wrong signature, tampered body,
 * malformed hex, empty header. One code path for the caller — invalid
 * means 401.
 */
export async function verifyLinearSignature(
  bodyBytes: Uint8Array,
  signatureHex: string,
  secret: string
): Promise<boolean> {
  const signatureBytes = hexToBytes(signatureHex);
  if (!signatureBytes) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );

  // crypto.subtle.verify wants BufferSource = ArrayBufferView<ArrayBuffer>.
  // Some toolchains view TextEncoder.encode() / new Uint8Array(arrayBuffer)
  // as Uint8Array<ArrayBufferLike>, which doesn't match. Copy into a fresh
  // Uint8Array<ArrayBuffer> to normalize the variance at the crypto boundary.
  const normalizedBody = new Uint8Array(bodyBytes);

  try {
    return await crypto.subtle.verify(
      "HMAC",
      key,
      signatureBytes,
      normalizedBody
    );
  } catch {
    // subtle.verify only throws on programmer errors (wrong algorithm,
    // wrong key usage). Bucket those into "invalid" so the route still
    // returns a clean 401 instead of a 500.
    return false;
  }
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> | null {
  if (hex.length === 0 || hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) return null;
    out[i] = byte;
  }
  return out;
}
