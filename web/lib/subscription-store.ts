import { emailSubscriberKey, normalizeEmail } from "./subscription-token";
import { isBioguideId, isWatchTicker, MAX_WATCH_ITEMS } from "./watchlist";

/**
 * Email alert subscriptions stored in a private Vercel Blob store. Server-only.
 *
 * One JSON blob per subscriber at `subscriptions/<subscriberKey>.json`, where
 * `<subscriberKey>` is the 32-hex HMAC of the subscriber's lowercase email.
 */

export interface StoredSubscription {
  v: 1;
  id: string;
  email: string;
  verified: boolean;
  createdAt: string;
  updatedAt: string;
  members: string[];
  tickers: string[];
  clusters: boolean;
  weeklyDigest: boolean;
  /** YYYY-MM-DD of the last daily digest sent to this subscriber. */
  lastSentDate: string | null;
}

export interface ListedSubscriptionBlob {
  pathname: string;
  url: string;
}

export interface SubscriptionBlobBackend {
  list(prefix: string): Promise<ListedSubscriptionBlob[]>;
  read(blob: ListedSubscriptionBlob): Promise<{ body: string; etag: string } | null>;
  readByPath(pathname: string): Promise<{ body: string; etag: string } | null>;
  write(pathname: string, body: string, ifMatch?: string): Promise<"ok" | "conflict">;
  del(pathname: string): Promise<void>;
}

export const SUBSCRIPTION_PREFIX = "subscriptions/";
const KEY_RE = /^[0-9a-f]{32}$/;
const PATH_RE = /^subscriptions\/([0-9a-f]{32})\.json$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function subscriptionPathname(id: string): string {
  if (!KEY_RE.test(id)) throw new Error("Invalid subscriber key");
  return `${SUBSCRIPTION_PREFIX}${id}.json`;
}

function cleanMembers(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const t = v.trim().toUpperCase();
    if (isBioguideId(t) && !seen.has(t)) {
      seen.add(t);
      out.push(t);
      if (out.length >= MAX_WATCH_ITEMS) break;
    }
  }
  return out;
}

function cleanTickers(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const t = v.trim().toUpperCase();
    if (isWatchTicker(t) && !seen.has(t)) {
      seen.add(t);
      out.push(t);
      if (out.length >= MAX_WATCH_ITEMS) break;
    }
  }
  return out;
}

export function parseStoredSubscription(body: string): StoredSubscription | null {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1 || typeof r.id !== "string" || !KEY_RE.test(r.id)) return null;
  const email = normalizeEmail(r.email);
  if (!email || typeof r.verified !== "boolean") return null;
  if (typeof r.createdAt !== "string" || typeof r.updatedAt !== "string") return null;
  const lastSentDate =
    r.lastSentDate === null
      ? null
      : typeof r.lastSentDate === "string" && DATE_RE.test(r.lastSentDate)
        ? r.lastSentDate
        : null;
  return {
    v: 1,
    id: r.id,
    email,
    verified: r.verified,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    members: cleanMembers(r.members),
    tickers: cleanTickers(r.tickers),
    clusters: Boolean(r.clusters),
    weeklyDigest: Boolean(r.weeklyDigest),
    lastSentDate,
  };
}

export interface UpsertSubscriptionInput {
  email: string;
  members?: string[];
  tickers?: string[];
  clusters?: boolean;
  weeklyDigest?: boolean;
  /** When true (default), merges new members/tickers into any existing subscription. */
  merge?: boolean;
}

export async function getSubscription(
  backend: SubscriptionBlobBackend,
  secret: string,
  email: string
): Promise<StoredSubscription | null> {
  const norm = normalizeEmail(email);
  if (!norm) return null;
  const id = emailSubscriberKey(norm, secret);
  const res = await backend.readByPath(subscriptionPathname(id));
  return res ? parseStoredSubscription(res.body) : null;
}

export async function upsertSubscription(
  backend: SubscriptionBlobBackend,
  secret: string,
  input: UpsertSubscriptionInput,
  now = new Date()
): Promise<StoredSubscription> {
  const email = normalizeEmail(input.email);
  if (!email) throw new Error("Invalid email");
  const id = emailSubscriberKey(email, secret);
  const pathname = subscriptionPathname(id);
  const merge = input.merge ?? true;
  const inMembers = cleanMembers(input.members ?? []);
  const inTickers = cleanTickers(input.tickers ?? []);

  for (let attempt = 0; attempt < 3; attempt++) {
    const existingRes = await backend.readByPath(pathname);
    const existing = existingRes ? parseStoredSubscription(existingRes.body) : null;
    const nowIso = now.toISOString();

    const members = merge && existing
      ? cleanMembers([...existing.members, ...inMembers])
      : inMembers;
    const tickers = merge && existing
      ? cleanTickers([...existing.tickers, ...inTickers])
      : inTickers;
    const clusters =
      input.clusters !== undefined
        ? Boolean(input.clusters)
        : existing
          ? existing.clusters
          : false;
    const weeklyDigest =
      input.weeklyDigest !== undefined
        ? Boolean(input.weeklyDigest)
        : existing
          ? existing.weeklyDigest
          : false;

    const next: StoredSubscription = {
      v: 1,
      id,
      email,
      verified: existing ? existing.verified : false,
      createdAt: existing ? existing.createdAt : nowIso,
      updatedAt: nowIso,
      members,
      tickers,
      clusters,
      weeklyDigest,
      lastSentDate: existing ? existing.lastSentDate : null,
    };

    const status = await backend.write(pathname, JSON.stringify(next), existingRes?.etag);
    if (status === "ok") return next;
  }
  throw new Error("Subscription collided on update; please retry");
}

export async function verifySubscriber(
  backend: SubscriptionBlobBackend,
  secret: string,
  email: string,
  now = new Date()
): Promise<StoredSubscription | null> {
  const norm = normalizeEmail(email);
  if (!norm) return null;
  const id = emailSubscriberKey(norm, secret);
  const pathname = subscriptionPathname(id);

  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await backend.readByPath(pathname);
    const stored = current ? parseStoredSubscription(current.body) : null;
    if (!current || !stored) return null;
    if (stored.verified) return stored;
    const next: StoredSubscription = {
      ...stored,
      verified: true,
      updatedAt: now.toISOString(),
    };
    if ((await backend.write(pathname, JSON.stringify(next), current.etag)) === "ok") {
      return next;
    }
  }
  return null;
}

export async function unsubscribeAll(
  backend: SubscriptionBlobBackend,
  secret: string,
  email: string
): Promise<boolean> {
  const norm = normalizeEmail(email);
  if (!norm) return false;
  const id = emailSubscriberKey(norm, secret);
  await backend.del(subscriptionPathname(id));
  return true;
}

export async function markDigestSent(
  backend: SubscriptionBlobBackend,
  secret: string,
  email: string,
  dateIso: string,
  now = new Date()
): Promise<void> {
  if (!DATE_RE.test(dateIso)) throw new Error("Invalid YYYY-MM-DD date");
  const norm = normalizeEmail(email);
  if (!norm) return;
  const id = emailSubscriberKey(norm, secret);
  const pathname = subscriptionPathname(id);

  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await backend.readByPath(pathname);
    const stored = current ? parseStoredSubscription(current.body) : null;
    if (!current || !stored) return;
    const next: StoredSubscription = {
      ...stored,
      lastSentDate: dateIso,
      updatedAt: now.toISOString(),
    };
    if ((await backend.write(pathname, JSON.stringify(next), current.etag)) === "ok") return;
  }
}

export async function listVerifiedSubscriptions(
  backend: SubscriptionBlobBackend
): Promise<StoredSubscription[]> {
  const blobs = (await backend.list(SUBSCRIPTION_PREFIX)).filter((b) => PATH_RE.test(b.pathname));
  const out: StoredSubscription[] = [];
  for (const b of blobs) {
    const res = await backend.read(b);
    const sub = res ? parseStoredSubscription(res.body) : null;
    if (
      sub &&
      sub.verified &&
      (sub.members.length > 0 || sub.tickers.length > 0 || sub.clusters || sub.weeklyDigest)
    ) {
      out.push(sub);
    }
  }
  return out;
}

/** In-memory fake backend for unit tests. */
export function createMemorySubscriptionBackend(): SubscriptionBlobBackend {
  const map = new Map<string, { body: string; rev: number }>();
  return {
    async list(prefix) {
      return [...map.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((pathname) => ({ pathname, url: `memory://${pathname}` }));
    },
    async read(blob) {
      const entry = map.get(blob.pathname);
      return entry ? { body: entry.body, etag: `v${entry.rev}` } : null;
    },
    async readByPath(pathname) {
      const entry = map.get(pathname);
      return entry ? { body: entry.body, etag: `v${entry.rev}` } : null;
    },
    async write(pathname, body, ifMatch) {
      const current = map.get(pathname);
      if (ifMatch !== undefined) {
        if (!current || `v${current.rev}` !== ifMatch) return "conflict";
      }
      const rev = (current?.rev ?? 0) + 1;
      map.set(pathname, { body, rev });
      return "ok";
    },
    async del(pathname) {
      map.delete(pathname);
    },
  };
}
