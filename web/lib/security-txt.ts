/**
 * `/.well-known/security.txt` (RFC 9116): where to report a vulnerability.
 *
 * Generated per request rather than committed as a file, because the RFC
 * requires an `Expires` field and a hard-coded date silently rots into an
 * expired file that scanners then flag. The expiry is always
 * `EXPIRES_IN_DAYS` ahead — inside the RFC's "less than a year" advice — and
 * a reader's cache holds the file for a day at most, so a copy is never
 * served past its own expiry.
 */

export const EXPIRES_IN_DAYS = 180;

export function securityTxt(origin: string, now: Date = new Date()): string {
  const base = origin.replace(/\/+$/, "");
  const expires = new Date(now.getTime() + EXPIRES_IN_DAYS * 86_400_000);
  expires.setUTCHours(0, 0, 0, 0);
  return [
    "# Security issues in this site or its public API: please report them",
    "# through the contact form, and say it is a security report. Please do",
    "# not test against the site at a rate that degrades it for other readers.",
    `Contact: ${base}/contact`,
    `Expires: ${expires.toISOString()}`,
    `Canonical: ${base}/.well-known/security.txt`,
    "Preferred-Languages: en",
    "",
  ].join("\n");
}
