import { isContactTopic, type ContactTopic } from "./contact";

/**
 * Contact messages, one private JSON blob each. Server-only.
 *
 * The dashboard's knowledge base (`data/trades.sqlite3`) is the pipeline's
 * state, fetched read-only; nothing a visitor sends may be written there. So
 * messages live in a private Vercel Blob store (lib/contact-blob.ts) behind
 * the small `BlobBackend` interface below, which the tests fake in memory.
 *
 * Layout: `contact/<sender>/<stamp>_<id>.json`, where `<sender>` is the keyed
 * IP hash (or `anon` when there is no IP) and `<stamp>` the UTC creation time
 * (`20261022T131352123Z`). Grouping by sender makes the rate limit one
 * prefix list of that sender's own messages; the stamp makes age readable
 * without opening a blob. Nothing depends on the order `list` returns.
 *
 * The volume is a contact form's — a few messages a week — so /admin reads
 * every message on each view (capped at SCAN_LIMIT, newest first) rather
 * than keeping an index that could drift from the blobs.
 */

/** What one blob holds. `v` versions the shape. */
export interface StoredMessage {
  v: 1;
  id: string;
  createdAt: string;
  topic: ContactTopic;
  name: string | null;
  email: string;
  message: string;
  /** Keyed hash of the sender's IP (lib/contact-ip.ts); never shown in /admin. */
  ipHash: string | null;
  /** Triage: null is open. */
  handledAt: string | null;
}

/** What /admin shows of a message: no IP hash, no blob URL. */
export interface AdminMessage {
  id: string;
  topic: ContactTopic;
  name: string | null;
  email: string;
  message: string;
  createdAt: Date;
  handledAt: Date | null;
}

export interface ListedBlob {
  pathname: string;
  /** The blob's private URL. Server-side only: never rendered or returned to a browser. */
  url: string;
}

/** The four operations the store needs. lib/contact-blob.ts implements them on @vercel/blob. */
export interface BlobBackend {
  /** Every blob under `prefix`, in no particular order. */
  list(prefix: string): Promise<ListedBlob[]>;
  /** The current body and ETag, bypassing any cache; null if gone. */
  read(blob: ListedBlob): Promise<{ body: string; etag: string } | null>;
  /** Write a new blob; fails if the pathname exists. */
  create(pathname: string, body: string): Promise<void>;
  /** Overwrite only if the ETag still matches; "conflict" if someone wrote in between. */
  replace(pathname: string, body: string, ifMatch: string): Promise<"ok" | "conflict">;
}

export const PREFIX = "contact/";
/** Most messages /admin reads per view. Past this the oldest are left out and the page says so. */
export const SCAN_LIMIT = 1000;
export const ADMIN_PAGE_SIZE = 100;
const READ_CONCURRENCY = 8;

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SENDER_RE = /^(?:[0-9a-f]{32}|anon)$/;
const NAME_RE = /^contact\/([0-9a-f]{32}|anon)\/(\d{8}T\d{9}Z)_([0-9a-f-]{36})\.json$/;

/** `2026-10-22T13:13:52.123Z` → `20261022T131352123Z`: sortable, no characters a pathname dislikes. */
export function stampOf(date: Date): string {
  return date.toISOString().replace(/[-:.]/g, "");
}

function dateOfStamp(stamp: string): Date {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z$/.exec(stamp);
  if (!m) return new Date(NaN);
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]));
  // Date.UTC rolls month 13 into next year; a stamp that does not round-trip is not a stamp.
  return stampOf(d) === stamp ? d : new Date(NaN);
}

export function senderPrefix(ipHash: string | null): string {
  const sender = ipHash ?? "anon";
  if (!SENDER_RE.test(sender)) throw new Error("Bad sender hash");
  return `${PREFIX}${sender}/`;
}

export function messagePathname(m: Pick<StoredMessage, "ipHash" | "createdAt" | "id">): string {
  if (!UUID_RE.test(m.id)) throw new Error("Bad message id");
  return `${senderPrefix(m.ipHash)}${stampOf(new Date(m.createdAt))}_${m.id}.json`;
}

/** The parts of a message pathname, or null for anything that is not one. */
export function parsePathname(pathname: string): { sender: string; createdAt: Date; id: string } | null {
  const m = NAME_RE.exec(pathname);
  if (!m) return null;
  const createdAt = dateOfStamp(m[2]);
  return Number.isNaN(createdAt.getTime()) ? null : { sender: m[1], createdAt, id: m[3] };
}

/** A stored body, checked field by field: a blob that is not a message reads as null, not as data. */
export function parseStored(body: string): StoredMessage | null {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown) => typeof v === "string";
  const strOrNull = (v: unknown) => v === null || typeof v === "string";
  if (r.v !== 1 || !str(r.id) || !UUID_RE.test(r.id as string) || !str(r.createdAt) || !isContactTopic(r.topic)) return null;
  if (!strOrNull(r.name) || !str(r.email) || !str(r.message) || !strOrNull(r.ipHash) || !strOrNull(r.handledAt)) return null;
  return raw as StoredMessage;
}

export interface NewContactMessage {
  topic: ContactTopic;
  name: string | null;
  email: string;
  message: string;
  ipHash: string | null;
}

export async function saveContactMessage(backend: BlobBackend, input: NewContactMessage, now = new Date()): Promise<StoredMessage> {
  const stored: StoredMessage = { v: 1, id: crypto.randomUUID(), createdAt: now.toISOString(), ...input, handledAt: null };
  await backend.create(messagePathname(stored), JSON.stringify(stored));
  return stored;
}

/** How many messages this sender stored since `since`: one list of their own prefix, no reads. */
export async function countRecentMessagesFrom(backend: BlobBackend, ipHash: string, since: Date): Promise<number> {
  const blobs = await backend.list(senderPrefix(ipHash));
  return blobs.filter((b) => {
    const p = parsePathname(b.pathname);
    return p !== null && p.createdAt >= since;
  }).length;
}

export type MessageFilter = "open" | "handled" | "all";

export function parseMessageFilter(value: unknown): MessageFilter {
  return value === "handled" || value === "all" ? value : "open";
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function toAdmin(m: StoredMessage): AdminMessage {
  return {
    id: m.id,
    topic: m.topic,
    name: m.name,
    email: m.email,
    message: m.message,
    createdAt: new Date(m.createdAt),
    handledAt: m.handledAt ? new Date(m.handledAt) : null,
  };
}

/**
 * Newest first, filtered by triage state and an email substring
 * (case-insensitive). Counts cover every message read, not the page shown.
 */
export async function listMessages(backend: BlobBackend, { filter, query }: { filter: MessageFilter; query: string }) {
  const named = (await backend.list(PREFIX))
    .map((b) => ({ b, p: parsePathname(b.pathname) }))
    .filter((x): x is { b: ListedBlob; p: NonNullable<ReturnType<typeof parsePathname>> } => x.p !== null)
    .sort((a, z) => z.p.createdAt.getTime() - a.p.createdAt.getTime() || z.p.id.localeCompare(a.p.id));
  const truncated = Math.max(0, named.length - SCAN_LIMIT);
  const bodies = await mapLimit(named.slice(0, SCAN_LIMIT), READ_CONCURRENCY, async ({ b }) => backend.read(b));
  const messages = bodies.flatMap((r) => {
    const m = r ? parseStored(r.body) : null;
    return m ? [toAdmin(m)] : [];
  });
  messages.sort((a, z) => z.createdAt.getTime() - a.createdAt.getTime() || z.id.localeCompare(a.id));

  const q = query.trim().toLowerCase();
  const matched = messages.filter(
    (m) =>
      (filter === "all" || (filter === "open" ? m.handledAt === null : m.handledAt !== null)) &&
      (!q || m.email.toLowerCase().includes(q))
  );
  return {
    rows: matched.slice(0, ADMIN_PAGE_SIZE),
    matched: matched.length,
    open: messages.filter((m) => m.handledAt === null).length,
    handled: messages.filter((m) => m.handledAt !== null).length,
    /** Blobs that were listed but did not read back as a message. */
    unreadable: named.length - truncated - messages.length,
    truncated,
  };
}

/**
 * Set a message's triage state. A conditional write on the blob's ETag, so
 * two admins (or two tabs) never silently clobber each other; since the edit
 * is "set handled = X", not "toggle", a conflict is resolved by re-reading
 * and applying it again.
 */
export async function setMessageHandled(backend: BlobBackend, id: string, handled: boolean, now = new Date()): Promise<void> {
  if (!UUID_RE.test(id)) throw new Error("Bad message id");
  const blob = (await backend.list(PREFIX)).find((b) => parsePathname(b.pathname)?.id === id);
  if (!blob) throw new Error("No such message");
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await backend.read(blob);
    const stored = current ? parseStored(current.body) : null;
    if (!current || !stored) throw new Error("Message could not be read");
    if ((stored.handledAt !== null) === handled) return;
    const next: StoredMessage = { ...stored, handledAt: handled ? now.toISOString() : null };
    if ((await backend.replace(blob.pathname, JSON.stringify(next), current.etag)) === "ok") return;
  }
  throw new Error("The message kept changing while it was being updated; try again.");
}
