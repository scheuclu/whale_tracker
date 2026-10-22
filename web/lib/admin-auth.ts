/**
 * Who may open /admin. Pure, so the rule can be read in one place and tested.
 *
 * Sign-in is "Sign in with Vercel" (auth.ts). Signing in proves only that
 * someone has a Vercel account, so the account must also be on
 * ADMIN_VERCEL_USER_IDS. The allowlist holds Vercel **user IDs** (the ID
 * token's `sub`, shown as "Vercel ID" under Account Settings): an ID never
 * changes hands, whereas a username can be renamed and then claimed by
 * someone else, and Vercel's ID token carries no `email_verified` claim to
 * make an address trustworthy.
 *
 * Everything here fails closed: an unset or empty list admits nobody, and so
 * does a half-configured sign-in.
 */

type Env = Record<string, string | undefined>;

/** Vercel user IDs are opaque alphanumeric strings (e.g. `345e869043f1e55f8bdc837c`). */
const VERCEL_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** Comma-separated. Unset, blank or malformed entries admit nobody. */
export function parseAdminIds(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => VERCEL_ID.test(entry));
}

export function adminIds(env: Env = process.env): string[] {
  return parseAdminIds(env.ADMIN_VERCEL_USER_IDS);
}

/** Whether this Vercel user may administer the site. Exact, case-sensitive match on the ID. */
export function isAllowedAdmin(userId: string | null | undefined, allowlist: string[] = adminIds()): boolean {
  if (!userId || allowlist.length === 0) return false;
  return allowlist.includes(userId);
}

/** The variables sign-in needs, and which of them are missing. Blank reads as unset. */
export function missingAuthConfig(env: Env = process.env): string[] {
  const missing: string[] = [];
  if (!env.AUTH_SECRET?.trim()) missing.push("AUTH_SECRET");
  if (!env.AUTH_VERCEL_ID?.trim() || !env.AUTH_VERCEL_SECRET?.trim()) missing.push("AUTH_VERCEL_ID / AUTH_VERCEL_SECRET");
  if (adminIds(env).length === 0) missing.push("ADMIN_VERCEL_USER_IDS");
  return missing;
}

/** Sign-in is offered, and a session is ever read, only when all of it is set. */
export function authConfigured(env: Env = process.env): boolean {
  return missingAuthConfig(env).length === 0;
}
