/**
 * The feed's filters, as query parameters.
 *
 * One parser serves the feed page and the CSV export so a URL copied from
 * the one reproduces the other exactly. An unrecognised value is never
 * silently dropped: the parser reports it in `ignored`, the page shows it
 * and the export refuses the request — a typo'd filter that quietly matches
 * everything is the kind of silent failure this project exists to avoid.
 */

import { parseWatchParam, serializeWatchParam } from "./watchlist";

export type Transcribed = "only" | "exclude";

export type TransactionFilters = {
  /** Exact ticker, upper-cased. */
  ticker?: string;
  /** Exact display name — how the leaderboard groups and the member page is keyed. */
  member?: string;
  /** "buy" or "sell"; anything else is every direction, as the query always read it. */
  action?: string;
  chamber?: "house" | "senate";
  party?: string;
  /** Two-letter asset type code (fd.house.gov reference). */
  assetType?: string;
  /** SP / DC / JT, or "self" for a row with no owner code. */
  owner?: string;
  /** Inclusive bounds on trade date, YYYY-MM-DD. */
  from?: string;
  to?: string;
  /** Rows transcribed from scanned paper filings: only them, or none of them. */
  transcribed?: Transcribed;
  /** Visitor's watchlist filter (`?watch=P000197,NVDA,0001767470`). */
  watch?: { members: string[]; tickers: string[]; insiders?: string[] };
};

export const CHAMBERS = ["house", "senate"] as const;
export const PARTIES = ["D", "R", "I", "L"] as const;
export const OWNERS = ["self", "SP", "DC", "JT"] as const;
export const TRANSCRIBED = ["only", "exclude"] as const;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ASSET_TYPE = /^[A-Z]{2}$/;
const PARAM_MAX = 120;

/** Query-string keys, in the order the export filename lists them. */
export const FILTER_KEYS = [
  "ticker",
  "member",
  "action",
  "chamber",
  "party",
  "type",
  "owner",
  "from",
  "to",
  "scans",
  "watch",
] as const;

type RawParams = Record<string, string | string[] | undefined>;

function one(raw: RawParams, key: string): string | undefined {
  const v = raw[key];
  const s = Array.isArray(v) ? v[0] : v;
  if (s == null) return undefined;
  const t = s.trim().slice(0, PARAM_MAX);
  return t === "" ? undefined : t;
}

export type ParsedFilters = {
  filters: TransactionFilters;
  /** `key=value` pairs that were present but not understood. */
  ignored: string[];
};

export function parseTransactionFilters(raw: RawParams): ParsedFilters {
  const filters: TransactionFilters = {};
  const ignored: string[] = [];
  const keep = <T extends string>(key: string, allowed: readonly T[]): T | undefined => {
    const v = one(raw, key);
    if (v === undefined) return undefined;
    if ((allowed as readonly string[]).includes(v)) return v as T;
    ignored.push(`${key}=${v}`);
    return undefined;
  };

  const ticker = one(raw, "ticker");
  if (ticker) filters.ticker = ticker.toUpperCase();
  const member = one(raw, "member");
  if (member) filters.member = member;
  filters.action = keep("action", ["buy", "sell"] as const);
  filters.chamber = keep("chamber", CHAMBERS);
  filters.party = keep("party", PARTIES);
  const type = one(raw, "type");
  if (type !== undefined) {
    const code = type.toUpperCase();
    if (ASSET_TYPE.test(code)) filters.assetType = code;
    else ignored.push(`type=${type}`);
  }
  filters.owner = keep("owner", OWNERS);
  for (const key of ["from", "to"] as const) {
    const v = one(raw, key);
    if (v === undefined) continue;
    if (DATE.test(v) && !Number.isNaN(Date.parse(v))) filters[key] = v;
    else ignored.push(`${key}=${v}`);
  }
  filters.transcribed = keep("scans", TRANSCRIBED);
  const rawWatch = one(raw, "watch");
  if (rawWatch !== undefined) {
    const parsedWatch = parseWatchParam(rawWatch);
    if (parsedWatch) filters.watch = parsedWatch;
    else ignored.push(`watch=${rawWatch}`);
  }

  for (const k of Object.keys(filters) as (keyof TransactionFilters)[]) {
    if (filters[k] === undefined) delete filters[k];
  }
  return { filters, ignored };
}

/** The filters as query parameters — the inverse of `parseTransactionFilters`. */
export function filtersToParams(filters: TransactionFilters): URLSearchParams {
  const q = new URLSearchParams();
  if (filters.ticker) q.set("ticker", filters.ticker);
  if (filters.member) q.set("member", filters.member);
  if (filters.action) q.set("action", filters.action);
  if (filters.chamber) q.set("chamber", filters.chamber);
  if (filters.party) q.set("party", filters.party);
  if (filters.assetType) q.set("type", filters.assetType);
  if (filters.owner) q.set("owner", filters.owner);
  if (filters.from) q.set("from", filters.from);
  if (filters.to) q.set("to", filters.to);
  if (filters.transcribed) q.set("scans", filters.transcribed);
  if (filters.watch) {
    const w = serializeWatchParam(filters.watch);
    if (w) q.set("watch", w);
  }
  return q;
}

/** A feed URL for these filters; `offset` is the pagination cursor. */
export function feedHref(filters: TransactionFilters, offset = 0): string {
  const q = filtersToParams(filters);
  if (offset > 0) q.set("offset", String(offset));
  const s = q.toString();
  return s ? `/?${s}#trades` : "/";
}

/** The CSV export of the same filtered set. */
export function exportHref(filters: TransactionFilters): string {
  const s = filtersToParams(filters).toString();
  return s ? `/api/export.csv?${s}` : "/api/export.csv";
}

/** A non-negative integer offset; anything else is page one. */
export function parseOffset(raw: string | string[] | undefined): number {
  const s = Array.isArray(raw) ? raw[0] : raw;
  if (!s || !/^\d{1,7}$/.test(s)) return 0;
  return Number(s);
}

/** A filename-safe summary of the active filters, for the download. */
export function exportFilename(filters: TransactionFilters): string {
  const q = filtersToParams(filters);
  const parts: string[] = ["trades"];
  for (const key of FILTER_KEYS) {
    const v = q.get(key);
    if (v) parts.push(v.replace(/[^A-Za-z0-9.-]+/g, "_").replace(/^_+|_+$/g, "") || key);
  }
  return `${parts.join("-").slice(0, 120)}.csv`;
}
