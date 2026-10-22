/**
 * Daily closes for the price overlay (app/price-overlay*.tsx), fetched on
 * demand by `/api/prices/<SYMBOL>` and never stored.
 *
 * Why not the `prices` table: the pipeline keeps closes only for tickers an
 * alert named, from ten days before the first alert (~51 symbols, ~2 months).
 * Years of closes for every symbol we hold would add tens of MB to a database
 * that is committed on every poll run and downloaded by every dashboard
 * instance. So the route asks the source the pipeline uses (`src/whale/prices.py`,
 * `prices.source: yahoo`) at request time, the CDN holds the answer for half
 * a day, and the stored rows are only a fallback when the source refuses.
 *
 * The series is unofficial and key-less, split-adjusted (Yahoo's `close`, the
 * same column the pipeline stores — not the dividend-adjusted `adjclose`). It
 * is descriptive: what the price did around trade dates. Nothing here, or in
 * the chart, computes a return.
 *
 * The parsing and symbol rules mirror prices.py and are kept pure so
 * lib/prices.test.ts can exercise them against the pipeline's own fixture
 * without touching the network.
 */

export type Close = { date: string; close: number };

export type PriceSeries = {
  symbol: string;
  /** "yahoo" when the source answered; "stored" when only the pipeline's rows were available. */
  source: "yahoo" | "stored" | null;
  /** "ok", or why there is no series: never a zero, never an error page. */
  status: "ok" | "no_data" | "unsupported" | "unavailable";
  closes: Close[];
};

/** Same descriptive agent as prices.py: Yahoo answers it and 429s a bare library one. */
export const USER_AGENT = "whale-tracker/0.1 (+https://github.com/scheuclu/whale_tracker)";

export const YAHOO_URL = "https://query1.finance.yahoo.com/v8/finance/chart/";

/**
 * The benchmark for the "vs SPY" view — `stats.BENCHMARK_TICKER` in Python.
 * Allowed through the route even though no member or insider trades it.
 */
export const BENCHMARK = "SPY";

/** Earliest year the route will fetch from: older trade dates are filing typos. */
export const MIN_FROM_YEAR = 2012;

/**
 * Symbols the source can price: letters, digits, one class separator. An
 * exchange-prefixed foreign symbol (`ASX:LNW`, carried by some Form 4s), a CIK
 * used as a key, or anything with spaces is refused before any request — it
 * would only come back empty, and a symbol is part of the cache key.
 */
const SYMBOL_SHAPE = /^[A-Z][A-Z0-9]{0,6}(?:[.-][A-Z0-9]{1,3})?$/;

export function normaliseSymbol(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s: string;
  try {
    s = decodeURIComponent(raw);
  } catch {
    return null;
  }
  s = s.trim().toUpperCase();
  return SYMBOL_SHAPE.test(s) ? s : null;
}

/** BRK.B -> BRK-B, as `prices.yahoo_symbol`. */
export function yahooSymbol(ticker: string): string {
  return ticker.trim().toUpperCase().replace(/\./g, "-");
}

/** A `from` year the route accepts, clamped; the default is three years back. */
export function fromYear(raw: string | null | undefined, now: Date = new Date()): number {
  const current = now.getUTCFullYear();
  const n = raw == null || raw === "" ? NaN : Number(raw);
  if (!Number.isInteger(n)) return current - 3;
  return Math.min(Math.max(n, MIN_FROM_YEAR), current);
}

const DAY_S = 86_400;

/**
 * Yahoo's `v8/finance/chart` JSON, as `prices.parse_yahoo_chart`: one close
 * per timestamp, dated in the exchange's local day via `gmtoffset`; a null
 * close is skipped; the last value for a day wins; sorted by date. "Not Found"
 * (unknown or delisted symbol) is an empty series, not an error. Anything
 * else malformed throws.
 */
export function parseYahooChart(payload: unknown): Close[] {
  const chart = (payload as { chart?: Record<string, unknown> } | null)?.chart ?? {};
  const result = chart.result as unknown[] | null | undefined;
  if (!result || !result.length) {
    const error = (chart.error ?? {}) as { code?: string; description?: string };
    if ((error.code ?? "").toLowerCase() === "not found") return [];
    throw new Error(`yahoo: ${error.code ?? "no result"}${error.description ? `: ${error.description}` : ""}`);
  }
  const first = (result[0] ?? {}) as {
    meta?: { gmtoffset?: number };
    timestamp?: number[];
    indicators?: { quote?: { close?: (number | null)[] }[] };
  };
  const offset = Math.trunc(Number(first.meta?.gmtoffset ?? 0)) || 0;
  const stamps = first.timestamp ?? [];
  const closes = first.indicators?.quote?.[0]?.close ?? [];
  const byDay = new Map<string, number>();
  const n = Math.min(stamps.length, closes.length);
  for (let i = 0; i < n; i++) {
    const c = closes[i];
    if (c == null || !Number.isFinite(c) || c <= 0) continue;
    const day = new Date((Math.trunc(stamps[i]) + offset) * 1000).toISOString().slice(0, 10);
    byDay.set(day, c);
  }
  return [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, close]) => ({ date, close }));
}

const CLOSE_MINUTES_ET = 16 * 60 + 5;

/**
 * The last New York session date whose close is final at `now` — today once
 * 16:05 ET has passed, else yesterday (`prices.final_through`). A row for a
 * session still trading is a mid-session price, not a close.
 */
export function finalThrough(now: Date): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value])
  );
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  if (minutes >= CLOSE_MINUTES_ET) return today;
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Yahoo URL for one symbol from Jan 1 of `year` to the end of today (UTC). */
export function yahooUrl(symbol: string, year: number, now: Date): string {
  const p1 = Date.UTC(year, 0, 1) / 1000;
  const p2 = Math.floor(now.getTime() / 1000 / DAY_S + 1) * DAY_S;
  return `${YAHOO_URL}${encodeURIComponent(yahooSymbol(symbol))}?period1=${p1}&period2=${p2}&interval=1d`;
}

/**
 * The CDN policy for a series. Closes change once a session, so a found
 * series is held 12 h and then served stale for up to two days while one
 * request refreshes it; an unknown symbol is as stable. A source failure is
 * held for five minutes only, so a 429 does not stick for a day. Browsers
 * keep any answer an hour.
 */
export const SERIES_CDN_SECONDS = 43_200;
export const SERIES_SWR_SECONDS = 172_800;
export const FAILURE_CDN_SECONDS = 300;

export function seriesHeaders(status: PriceSeries["status"]): Record<string, string> {
  const failed = status === "unavailable";
  const cdn = failed
    ? `public, s-maxage=${FAILURE_CDN_SECONDS}`
    : `public, s-maxage=${SERIES_CDN_SECONDS}, stale-while-revalidate=${SERIES_SWR_SECONDS}`;
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": failed ? "public, max-age=60" : "public, max-age=3600",
    "CDN-Cache-Control": cdn,
  };
}

/**
 * One request to the source, cached in Next's data cache for as long as the
 * CDN holds the answer (only a 200 is cached there, so a refusal is asked
 * again). Throws on a refusal or a malformed body; returns [] for an unknown
 * symbol.
 */
export async function fetchYahooCloses(symbol: string, year: number, now: Date = new Date()): Promise<Close[]> {
  const res = await fetch(yahooUrl(symbol, year, now), {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    next: { revalidate: SERIES_CDN_SECONDS },
    signal: AbortSignal.timeout(8000),
  });
  if (res.status === 429) throw new Error("yahoo answered 429 Too Many Requests");
  if (!res.ok && res.status !== 404) throw new Error(`yahoo answered ${res.status}`);
  const final = finalThrough(now);
  return parseYahooChart(await res.json()).filter((c) => c.date <= final);
}
