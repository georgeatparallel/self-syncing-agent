/**
 * SSRF denylist. Enforced as the first gateway check; nothing the agent or
 * user can declare overrides it. Covers private IPv4 ranges (incl. 169.254/16
 * for AWS/GCP/Azure IMDS), IPv6 loopback + unique-local addresses, localhost,
 * and common cloud-internal suffixes (.internal/.local).
 */

const PRIVATE_IPV4_CIDRS: Array<[number, number]> = [
  [0x7f000000, 0xff000000], // 127/8   loopback
  [0x0a000000, 0xff000000], // 10/8    private
  [0xac100000, 0xfff00000], // 172.16/12 private
  [0xc0a80000, 0xffff0000], // 192.168/16 private
  [0xa9fe0000, 0xffff0000] // 169.254/16 link-local incl. cloud metadata
];

function ipv4ToUint32(hostname: string): number | null {
  const parts = hostname.split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    // unsigned coerce; JS `&`/`<<` return signed int32 and 169.254.x.x would
    // otherwise compare negative and silently bypass the CIDR match.
    out = ((out << 8) | n) >>> 0;
  }
  return out;
}

export function isDeniedHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) — unwrap and re-check against IPv4 rules.
  // Must run BEFORE the other checks so e.g. ::ffff:127.0.0.1 hits the IPv4
  // loopback CIDR rather than slipping through the IPv6 branch.
  if (h.startsWith("::ffff:")) return isDeniedHost(h.slice(7));
  if (h === "localhost" || h === "ip6-localhost") return true;
  if (h.endsWith(".internal") || h.endsWith(".local")) return true;
  if (h === "::1") return true;
  if (/^(fc|fd)[0-9a-f]{2}:/.test(h)) return true; // IPv6 ULA
  const v4 = ipv4ToUint32(h);
  if (v4 !== null) {
    for (const [base, mask] of PRIVATE_IPV4_CIDRS) {
      // unsigned coerce — see note on ipv4ToUint32.
      if ((v4 & mask) >>> 0 === base) return true;
    }
  }
  return false;
}
