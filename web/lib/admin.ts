import { normalizeEmail } from "./subscription-token";
import { receivesDigest, type StoredSubscription } from "./subscription-store";

/**
 * The operator's view of reader accounts (`/admin`). Server-only, pure.
 *
 * Access is the reader sign-in plus an allowlist: `ADMIN_EMAILS`, addresses
 * separated by commas or whitespace. A session proves its address (Google or
 * an emailed link, `lib/auth.ts`), so no second sign-in exists. Unset or
 * blank means nobody — the page fails closed, as a blank secret must
 * (GitHub and Vercel both pass an undefined variable as "").
 */

type Env = Record<string, string | undefined>;

export function adminEmails(env: Env = process.env): Set<string> {
  const out = new Set<string>();
  for (const part of (env.ADMIN_EMAILS ?? "").split(/[\s,]+/)) {
    const email = normalizeEmail(part);
    if (email) out.add(email);
  }
  return out;
}

export function isAdminEmail(email: string | null | undefined, env: Env = process.env): boolean {
  const norm = normalizeEmail(email);
  return norm !== null && adminEmails(env).has(norm);
}

export type FollowCount = { id: string; followers: number };

export type SignupWeek = {
  /** Monday of the ISO week, YYYY-MM-DD (UTC). */
  week: string;
  signups: number;
};

export type AccountsSummary = {
  total: number;
  /** Signed in at least once, or confirmed the old double opt-in. */
  verified: number;
  /** Exactly the records the digest sender emails (`receivesDigest`). */
  receivingDigest: number;
  /** Turned emails off with the unsubscribe link or the dashboard toggle. */
  unsubscribed: number;
  followingSomething: number;
  clusters: number;
  weeklyDigest: number;
  newLast7Days: number;
  newLast30Days: number;
  /** Oldest → newest, `weeks` long, ending with the current week; empty weeks are 0. */
  signupsByWeek: SignupWeek[];
  members: FollowCount[];
  tickers: FollowCount[];
  insiders: FollowCount[];
};

const DAY_MS = 86_400_000;

/** Monday 00:00 UTC of the week containing `t`. */
function weekStart(t: number): number {
  const day = Math.floor(t / DAY_MS);
  // 1970-01-01 was a Thursday: day 0 is weekday 3 counting Monday as 0.
  return (day - ((day + 3) % 7)) * DAY_MS;
}

function countFollows(lists: string[][]): FollowCount[] {
  const counts = new Map<string, number>();
  for (const list of lists) for (const id of list) counts.set(id, (counts.get(id) ?? 0) + 1);
  return [...counts]
    .map(([id, followers]) => ({ id, followers }))
    .sort((a, b) => b.followers - a.followers || a.id.localeCompare(b.id));
}

/** Newest account first; ties by address so the order is stable. */
export function sortAccounts(accounts: StoredSubscription[]): StoredSubscription[] {
  return [...accounts].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.email.localeCompare(b.email));
}

export function summarizeAccounts(accounts: StoredSubscription[], now = new Date(), weeks = 12): AccountsSummary {
  const nowMs = now.getTime();
  const thisWeek = weekStart(nowMs);
  const firstWeek = thisWeek - (weeks - 1) * 7 * DAY_MS;
  const byWeek = new Map<number, number>();
  for (let w = firstWeek; w <= thisWeek; w += 7 * DAY_MS) byWeek.set(w, 0);

  let newLast7Days = 0;
  let newLast30Days = 0;
  for (const a of accounts) {
    const created = Date.parse(a.createdAt);
    if (!Number.isFinite(created)) continue;
    const age = nowMs - created;
    if (age >= 0 && age < 7 * DAY_MS) newLast7Days++;
    if (age >= 0 && age < 30 * DAY_MS) newLast30Days++;
    const w = weekStart(created);
    if (byWeek.has(w)) byWeek.set(w, byWeek.get(w)! + 1);
  }

  return {
    total: accounts.length,
    verified: accounts.filter((a) => a.verified).length,
    receivingDigest: accounts.filter(receivesDigest).length,
    unsubscribed: accounts.filter((a) => !a.emailAlerts).length,
    followingSomething: accounts.filter((a) => a.members.length + a.tickers.length + a.insiders.length > 0).length,
    clusters: accounts.filter((a) => a.clusters).length,
    weeklyDigest: accounts.filter((a) => a.weeklyDigest).length,
    newLast7Days,
    newLast30Days,
    signupsByWeek: [...byWeek].map(([w, signups]) => ({ week: new Date(w).toISOString().slice(0, 10), signups })),
    members: countFollows(accounts.map((a) => a.members)),
    tickers: countFollows(accounts.map((a) => a.tickers)),
    insiders: countFollows(accounts.map((a) => a.insiders)),
  };
}
