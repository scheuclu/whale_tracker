/**
 * Client watchlist & URL serialization helpers.
 *
 * A visitor can follow politicians (by `bioguide_id`, e.g. `P000197`) and
 * stock symbols (by `ticker`, e.g. `NVDA` or `BRK.B`) without creating an
 * account. The state lives in `localStorage` under `WATCHLIST_STORAGE_KEY`
 * and serializes into a compact, unambiguous `?watch=P000197,NVDA` URL
 * parameter so the server-rendered feed can filter by
 * it and readers can bookmark or share their watchlist across devices.
 */

export const WATCHLIST_STORAGE_KEY = "fatcat_watchlist_v1";
export const MAX_WATCH_ITEMS = 40;

const BIOGUIDE_RE = /^[A-Z]\d{6}$/;
const TICKER_RE = /^[A-Z]{1,6}(?:\.[A-Z]{1,2})?$/;

export type WatchlistState = {
  /** Uppercase bioguide IDs, e.g. ["P000197", "C001123"]. */
  members: string[];
  /** Uppercase ticker symbols, e.g. ["NVDA", "MSFT"]. */
  tickers: string[];
  /** Optional display labels remembered from the page where the user clicked Follow. */
  labels: Record<string, string>;
};

export const EMPTY_WATCHLIST: WatchlistState = {
  members: [],
  tickers: [],
  labels: {},
};

export function isBioguideId(token: string): boolean {
  return BIOGUIDE_RE.test(token.trim().toUpperCase());
}

export function isWatchTicker(token: string): boolean {
  const upper = token.trim().toUpperCase();
  return !BIOGUIDE_RE.test(upper) && TICKER_RE.test(upper);
}

/**
 * Parses a `?watch=P000197,NVDA,MSFT` query parameter into deduplicated
 * `members` (bioguide IDs) and `tickers` (stock symbols). Invalid tokens
 * are ignored so a hand-edited URL degrades gracefully.
 */
export function parseWatchParam(
  raw: string | string[] | undefined
): { members: string[]; tickers: string[] } | null {
  const str = Array.isArray(raw) ? raw[0] : raw;
  if (!str || typeof str !== "string") return null;

  const members: string[] = [];
  const tickers: string[] = [];
  const seen = new Set<string>();

  for (const part of str.split(",")) {
    const token = part.trim().toUpperCase();
    if (!token || seen.has(token)) continue;
    if (members.length + tickers.length >= MAX_WATCH_ITEMS) break;

    if (BIOGUIDE_RE.test(token)) {
      seen.add(token);
      members.push(token);
    } else if (TICKER_RE.test(token)) {
      seen.add(token);
      tickers.push(token);
    }
  }

  if (members.length === 0 && tickers.length === 0) return null;
  return { members, tickers };
}

/**
 * Serializes followed members and tickers into a canonical comma-separated
 * query parameter (`P000197,NVDA`), or `""` when empty.
 */
export function serializeWatchParam(w: { members: readonly string[]; tickers: readonly string[] }): string {
  const tokens: string[] = [];
  const seen = new Set<string>();

  for (const m of w.members) {
    const t = m.trim().toUpperCase();
    if (BIOGUIDE_RE.test(t) && !seen.has(t) && tokens.length < MAX_WATCH_ITEMS) {
      seen.add(t);
      tokens.push(t);
    }
  }
  for (const sym of w.tickers) {
    const t = sym.trim().toUpperCase();
    if ( isWatchTicker(t) && !seen.has(t) && tokens.length < MAX_WATCH_ITEMS) {
      seen.add(t);
      tokens.push(t);
    }
  }
  return tokens.join(",");
}

/** Builds the homepage feed URL filtered to the visitor's watchlist. */
export function watchlistFeedHref(w: { members: readonly string[]; tickers: readonly string[] }): string {
  const param = serializeWatchParam(w);
  return param ? `/?watch=${encodeURIComponent(param)}#trades` : "/";
}

/** Normalizes raw JSON read from localStorage into a valid `WatchlistState`. */
export function sanitizeWatchlistState(raw: unknown): WatchlistState {
  if (!raw || typeof raw !== "object") return EMPTY_WATCHLIST;
  const obj = raw as Record<string, unknown>;
  const rawMembers = Array.isArray(obj.members) ? obj.members.filter((x): x is string => typeof x === "string") : [];
  const rawTickers = Array.isArray(obj.tickers) ? obj.tickers.filter((x): x is string => typeof x === "string") : [];
  const parsed = parseWatchParam([...rawMembers, ...rawTickers].join(",")) ?? { members: [], tickers: [] };

  const labels: Record<string, string> = {};
  if (obj.labels && typeof obj.labels === "object") {
    for (const [k, v] of Object.entries(obj.labels as Record<string, unknown>)) {
      if (typeof v === "string" && v.trim()) {
        labels[k.toUpperCase()] = v.trim().slice(0, 80);
      }
    }
  }

  return {
    members: parsed.members,
    tickers: parsed.tickers,
    labels,
  };
}

/** Toggles a member or ticker in a `WatchlistState` and returns the next state + whether it is now followed. */
export function toggleWatchItem(
  state: WatchlistState,
  item: { kind: "member" | "ticker"; id: string; label?: string }
): { next: WatchlistState; followed: boolean } {
  const id = item.id.trim().toUpperCase();
  const list = item.kind === "member" ? state.members : state.tickers;
  const exists = list.includes(id);
  const nextList = exists ? list.filter((x) => x !== id) : [...list, id].slice(-MAX_WATCH_ITEMS);
  const nextLabels = { ...state.labels };
  if (!exists && item.label) {
    nextLabels[id] = item.label.trim().slice(0, 80);
  }
  return {
    followed: !exists,
    next: {
      members: item.kind === "member" ? nextList : state.members,
      tickers: item.kind === "ticker" ? nextList : state.tickers,
      labels: nextLabels,
    },
  };
}
