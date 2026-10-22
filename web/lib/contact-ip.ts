import { createHmac } from "node:crypto";

/**
 * The sender's address, reduced to something that can be counted but not
 * read back. Server-only (node:crypto); kept apart from the database code so
 * the tests need no driver.
 */

/**
 * The key for the IP hash. Unkeyed, a SHA-256 of an IPv4 address is
 * reversible in seconds — the address space fits in a lookup table — so the
 * hash would be personal data in disguise. `AUTH_SECRET` is the fallback so
 * production needs no extra variable; set `CONTACT_IP_SALT` to keep the two
 * secrets separate (rotating either resets everyone's rate limit, nothing
 * more). Blank reads as unset.
 */
export function contactIpSalt(env: Record<string, string | undefined> = process.env): string | null {
  const salt = env.CONTACT_IP_SALT?.trim() || env.AUTH_SECRET?.trim();
  return salt ? salt : null;
}

/** A short keyed digest of the IP, or null when there is no IP or no key. */
export function hashIp(ip: string | null | undefined, salt: string | null = contactIpSalt()): string | null {
  if (!ip || !salt) return null;
  return createHmac("sha256", salt).update(ip).digest("hex").slice(0, 32);
}

/**
 * The client address as the proxy in front of us reports it. A server action
 * has no request object, so the forwarding headers are the only source.
 * Vercel overwrites `x-forwarded-for` with the real client, so it cannot be
 * spoofed there; elsewhere it can, which is why only a courtesy rate limit
 * hangs off it.
 */
export function clientIpFrom(get: (name: string) => string | null): string | null {
  const forwarded = get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return get("x-real-ip")?.trim() || null;
}
