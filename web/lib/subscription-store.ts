import { emailSubscriberKey, normalizeEmail } from "./subscription-token";
import { cleanInsiderCiks, isBioguideId, isWatchTicker, MAX_WATCH_ITEMS } from "./watchlist";

/**
 * Email alert subscriptions stored in a private Vercel Blob store. Server-only.
 *
 * One JSON blob per subscriber at `subscriptions/<subscriberKey>.json`, where
 * `<subscriberKey>` is the 32-hex HMAC of the subscriber's lowercase email.
 *
 * The same record is the reader's account: signing in (Google or an emailed
 * link, `lib/auth.ts`) proves the address, so it creates or verifies the
 * record and its follows become the synced watchlist. There is no second
 * user table. Unsubscribing therefore turns `emailAlerts` off and keeps the
 * follows; only deleting the account removes the blob.
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
  /** Corporate insiders followed, by SEC CIK. Absent on records from before insider follows: []. */
  insiders: string[];
  clusters: boolean;
  weeklyDigest: boolean;
  /**
   * Whether any digest is emailed. False after an unsubscribe link, so the
   * account and its follows survive it. Records written before accounts
   * existed lack the field and read as true: they were double-opted-in.
   */
  emailAlerts: boolean;
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
    insiders: cleanInsiderCiks(r.insiders),
    clusters: Boolean(r.clusters),
    weeklyDigest: Boolean(r.weeklyDigest),
    emailAlerts: r.emailAlerts === undefined ? true : Boolean(r.emailAlerts),
    lastSentDate,
  };
}

export interface UpsertSubscriptionInput {
  email: string;
  members?: string[];
  tickers?: string[];
  clusters?: boolean;
  weeklyDigest?: boolean;
  emailAlerts?: boolean;
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
      insiders: existing ? existing.insiders : [],
      clusters,
      weeklyDigest,
      emailAlerts:
        input.emailAlerts !== undefined
          ? Boolean(input.emailAlerts)
          : existing
            ? existing.emailAlerts
            : true,
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

/** Deletes the record outright: the account, its follows and its settings. */
export async function deleteSubscription(
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

/**
 * Read-modify-write of one record under its ETag, retried on a concurrent
 * write. `change` returns the next record, or null to leave it alone.
 * Returns the stored record, or null when there is none (or no change).
 */
async function mutateSubscription(
  backend: SubscriptionBlobBackend,
  secret: string,
  email: string,
  change: (current: StoredSubscription | null, nowIso: string, id: string) => StoredSubscription | null,
  now = new Date()
): Promise<StoredSubscription | null> {
  const norm = normalizeEmail(email);
  if (!norm) return null;
  const id = emailSubscriberKey(norm, secret);
  const pathname = subscriptionPathname(id);
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await backend.readByPath(pathname);
    const stored = current ? parseStoredSubscription(current.body) : null;
    const next = change(stored, now.toISOString(), id);
    if (!next) return stored;
    if ((await backend.write(pathname, JSON.stringify(next), current?.etag)) === "ok") return next;
  }
  throw new Error("Subscription collided on update; please retry");
}

/**
 * A completed sign-in. The address is proven, so the record is created or
 * marked verified, and whatever the reader followed on this device before
 * signing in is merged into the account. A new account emails a daily digest
 * of its follows (the sign-in page says so); an existing one keeps its
 * settings, including a previous unsubscribe.
 */
export async function signInAccount(
  backend: SubscriptionBlobBackend,
  secret: string,
  email: string,
  local: { members?: string[]; tickers?: string[]; insiders?: string[] } = {},
  now = new Date()
): Promise<StoredSubscription> {
  const norm = normalizeEmail(email);
  if (!norm) throw new Error("Invalid email");
  const sub = await mutateSubscription(
    backend,
    secret,
    norm,
    (existing, nowIso, id) => ({
      v: 1,
      id,
      email: norm,
      verified: true,
      createdAt: existing?.createdAt ?? nowIso,
      updatedAt: nowIso,
      members: cleanMembers([...(existing?.members ?? []), ...(local.members ?? [])]),
      tickers: cleanTickers([...(existing?.tickers ?? []), ...(local.tickers ?? [])]),
      insiders: cleanInsiderCiks([...(existing?.insiders ?? []), ...(local.insiders ?? [])]),
      clusters: existing?.clusters ?? false,
      weeklyDigest: existing?.weeklyDigest ?? false,
      emailAlerts: existing?.emailAlerts ?? true,
      lastSentDate: existing?.lastSentDate ?? null,
    }),
    now
  );
  if (!sub) throw new Error("Invalid email");
  return sub;
}

export interface WatchChange {
  add?: { members?: string[]; tickers?: string[]; insiders?: string[] };
  remove?: { members?: string[]; tickers?: string[]; insiders?: string[] };
}

/**
 * Adds and removes follows on an existing account. Item-level rather than a
 * whole-list replace, so two tabs following different things do not
 * overwrite each other. Null when the account no longer exists.
 */
export async function updateAccountWatch(
  backend: SubscriptionBlobBackend,
  secret: string,
  email: string,
  change: WatchChange,
  now = new Date()
): Promise<StoredSubscription | null> {
  const dropMembers = new Set(cleanMembers(change.remove?.members ?? []));
  const dropTickers = new Set(cleanTickers(change.remove?.tickers ?? []));
  const dropInsiders = new Set(cleanInsiderCiks(change.remove?.insiders ?? []));
  return mutateSubscription(
    backend,
    secret,
    email,
    (existing, nowIso) =>
      existing && {
        ...existing,
        updatedAt: nowIso,
        members: cleanMembers([...existing.members, ...(change.add?.members ?? [])]).filter(
          (m) => !dropMembers.has(m)
        ),
        tickers: cleanTickers([...existing.tickers, ...(change.add?.tickers ?? [])]).filter(
          (t) => !dropTickers.has(t)
        ),
        insiders: cleanInsiderCiks([...existing.insiders, ...(change.add?.insiders ?? [])]).filter(
          (c) => !dropInsiders.has(c)
        ),
      },
    now
  );
}

export interface AccountSettings {
  emailAlerts?: boolean;
  clusters?: boolean;
  weeklyDigest?: boolean;
}

/** Changes the email settings of an existing record; null when there is none. */
export async function updateAccountSettings(
  backend: SubscriptionBlobBackend,
  secret: string,
  email: string,
  settings: AccountSettings,
  now = new Date()
): Promise<StoredSubscription | null> {
  return mutateSubscription(
    backend,
    secret,
    email,
    (existing, nowIso) =>
      existing && {
        ...existing,
        updatedAt: nowIso,
        emailAlerts: settings.emailAlerts ?? existing.emailAlerts,
        clusters: settings.clusters ?? existing.clusters,
        weeklyDigest: settings.weeklyDigest ?? existing.weeklyDigest,
      },
    now
  );
}

/** An unsubscribe link: stops every email, keeps the account and its follows. */
export async function stopEmails(
  backend: SubscriptionBlobBackend,
  secret: string,
  email: string,
  now = new Date()
): Promise<boolean> {
  return (await updateAccountSettings(backend, secret, email, { emailAlerts: false }, now)) !== null;
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
      sub.emailAlerts &&
      (sub.members.length > 0 ||
        sub.tickers.length > 0 ||
        sub.insiders.length > 0 ||
        sub.clusters ||
        sub.weeklyDigest)
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
