import type { SubscriptionBlobBackend } from "./subscription-store";

/**
 * The chat's daily counters, in the same private Blob store as the accounts
 * (no second vendor). Server-only.
 *
 * - `chat-usage/<subscriberKey>.json` — one per account, keyed by the same
 *   HMAC as its record (`subscriptions/<subscriberKey>.json`), so no address
 *   is stored here: `{ day, messages, tokens }` for the current UTC day,
 *   overwritten when the day turns. Deleting the account deletes it.
 * - `chat-usage/_total.json` — everyone together, for the global token
 *   budget and the admin page: messages, tokens and refusals today.
 *
 * Every change is a read-modify-write under the blob's ETag, retried on a
 * concurrent write, so two tabs cannot both spend the last message. The one
 * unguarded write is a counter's very first (no ETag exists yet); racing
 * that can lose one count, once per account. The token budget is checked
 * before a message and spent after it, so in-flight messages can overshoot
 * it by at most what they use (bounded per message in `chat-config.ts`).
 *
 * No message text is ever written here or anywhere else: the conversation
 * lives in the reader's browser tab only.
 */

export const CHAT_USAGE_PREFIX = "chat-usage/";
export const CHAT_TOTALS_PATH = `${CHAT_USAGE_PREFIX}_total.json`;

const KEY_RE = /^[0-9a-f]{32}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ATTEMPTS = 8;

export function chatUsagePathname(id: string): string {
  if (!KEY_RE.test(id)) throw new Error("Invalid subscriber key");
  return `${CHAT_USAGE_PREFIX}${id}.json`;
}

export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** The next UTC midnight: when every counter starts again. */
export function nextResetIso(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return d.toISOString();
}

type AccountUsage = { v: 1; day: string; messages: number; tokens: number };
export type ChatTotals = {
  day: string;
  messages: number;
  tokens: number;
  refusedLimit: number;
  refusedBudget: number;
};

function count(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

function parseAccountUsage(body: string | undefined, day: string): AccountUsage {
  const fresh: AccountUsage = { v: 1, day, messages: 0, tokens: 0 };
  if (!body) return fresh;
  try {
    const r = JSON.parse(body) as Record<string, unknown>;
    if (r.day !== day || typeof r.day !== "string" || !DAY_RE.test(r.day)) return fresh;
    return { v: 1, day, messages: count(r.messages), tokens: count(r.tokens) };
  } catch {
    return fresh;
  }
}

function parseTotals(body: string | undefined, day: string): ChatTotals {
  const fresh: ChatTotals = { day, messages: 0, tokens: 0, refusedLimit: 0, refusedBudget: 0 };
  if (!body) return fresh;
  try {
    const r = JSON.parse(body) as Record<string, unknown>;
    if (r.day !== day) return fresh;
    return {
      day,
      messages: count(r.messages),
      tokens: count(r.tokens),
      refusedLimit: count(r.refusedLimit),
      refusedBudget: count(r.refusedBudget),
    };
  } catch {
    return fresh;
  }
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Read-modify-write under the ETag. `change` returns the next value, or null
 * to leave the blob alone; the result is what is stored afterwards.
 */
async function mutate<T>(
  backend: SubscriptionBlobBackend,
  pathname: string,
  parse: (body: string | undefined) => T,
  change: (current: T) => T | null
): Promise<{ value: T; changed: boolean }> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const current = await backend.readByPath(pathname);
    const value = parse(current?.body);
    const next = change(value);
    if (next === null) return { value, changed: false };
    if ((await backend.write(pathname, JSON.stringify(next), current?.etag)) === "ok") return { value: next, changed: true };
    // Spread the retries out so colliding writers do not collide again.
    await pause(5 + Math.random() * 20 * (attempt + 1));
  }
  throw new Error("Chat usage collided on update; please retry");
}

export type ChatQuota = {
  used: number;
  limit: number;
  remaining: number;
  /** ISO time of the next UTC midnight. */
  resetsAt: string;
};

function quota(used: number, limit: number, now: Date): ChatQuota {
  return { used, limit, remaining: Math.max(0, limit - used), resetsAt: nextResetIso(now) };
}

export type Reservation =
  | { ok: true; quota: ChatQuota }
  | { ok: false; reason: "limit" | "budget"; quota: ChatQuota };

/** Best effort: a refusal counter is for the admin page, never a reason to fail. */
async function bumpTotals(backend: SubscriptionBlobBackend, day: string, change: (t: ChatTotals) => ChatTotals) {
  try {
    await mutate(backend, CHAT_TOTALS_PATH, (b) => parseTotals(b, day), (t) => ({ ...change(t), day }));
  } catch {
    /* counted next time */
  }
}

/**
 * Spends one of the account's messages for today, or says why not: the
 * account's daily limit, or everyone's token budget. Call before asking the
 * model; `refundChatMessage` gives it back if no answer came.
 */
export async function reserveChatMessage(
  backend: SubscriptionBlobBackend,
  id: string,
  limits: { dailyLimit: number; dailyTokenBudget: number },
  now = new Date()
): Promise<Reservation> {
  const day = utcDay(now);
  const path = chatUsagePathname(id);
  const totals = parseTotals((await backend.readByPath(CHAT_TOTALS_PATH))?.body, day);
  if (totals.tokens >= limits.dailyTokenBudget) {
    const mine = parseAccountUsage((await backend.readByPath(path))?.body, day);
    await bumpTotals(backend, day, (t) => ({ ...t, refusedBudget: t.refusedBudget + 1 }));
    return { ok: false, reason: "budget", quota: quota(mine.messages, limits.dailyLimit, now) };
  }
  const result = await mutate(
    backend,
    path,
    (b) => parseAccountUsage(b, day),
    (u) => (u.messages >= limits.dailyLimit ? null : { ...u, messages: u.messages + 1 })
  );
  if (!result.changed) {
    await bumpTotals(backend, day, (t) => ({ ...t, refusedLimit: t.refusedLimit + 1 }));
    return { ok: false, reason: "limit", quota: quota(result.value.messages, limits.dailyLimit, now) };
  }
  await bumpTotals(backend, day, (t) => ({ ...t, messages: t.messages + 1 }));
  return { ok: true, quota: quota(result.value.messages, limits.dailyLimit, now) };
}

/** Adds what a message cost to the account's and everyone's counters. */
export async function recordChatTokens(
  backend: SubscriptionBlobBackend,
  id: string,
  tokens: number,
  now = new Date()
): Promise<void> {
  const spent = count(tokens);
  if (spent === 0) return;
  const day = utcDay(now);
  await Promise.all([
    mutate(backend, chatUsagePathname(id), (b) => parseAccountUsage(b, day), (u) => ({ ...u, tokens: u.tokens + spent })).catch(
      () => null
    ),
    bumpTotals(backend, day, (t) => ({ ...t, tokens: t.tokens + spent })),
  ]);
}

/** Gives back a reserved message when the model never answered (an outage, not the reader's doing). */
export async function refundChatMessage(backend: SubscriptionBlobBackend, id: string, now = new Date()): Promise<void> {
  const day = utcDay(now);
  await Promise.all([
    mutate(backend, chatUsagePathname(id), (b) => parseAccountUsage(b, day), (u) =>
      u.messages > 0 ? { ...u, messages: u.messages - 1 } : null
    ).catch(() => null),
    bumpTotals(backend, day, (t) => ({ ...t, messages: Math.max(0, t.messages - 1) })),
  ]);
}

export async function readChatQuota(
  backend: SubscriptionBlobBackend,
  id: string,
  dailyLimit: number,
  now = new Date()
): Promise<ChatQuota> {
  const mine = parseAccountUsage((await backend.readByPath(chatUsagePathname(id)))?.body, utcDay(now));
  return quota(mine.messages, dailyLimit, now);
}

/** Today's totals for everyone (zeros before the first message of the day). */
export async function readChatTotals(backend: SubscriptionBlobBackend, now = new Date()): Promise<ChatTotals> {
  return parseTotals((await backend.readByPath(CHAT_TOTALS_PATH))?.body, utcDay(now));
}

export async function deleteChatUsage(backend: SubscriptionBlobBackend, id: string): Promise<void> {
  await backend.del(chatUsagePathname(id));
}
