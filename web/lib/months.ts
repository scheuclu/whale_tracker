/**
 * Calendar-month helpers for the monthly series on /trends.
 *
 * UTC throughout, to agree with SQLite's `date('now')`: the queries bound
 * every series at today, and a month key computed in local time could name
 * a month the database considers not to have started yet.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LONG_MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export const MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/;

/** A window length from a query string: an integer in 1..60, else the fallback. */
export function clampMonths(months: unknown, fallback = 12): number {
  const n = Math.floor(Number(months));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 60) : fallback;
}

function key(year: number, monthIndex: number): string {
  return new Date(Date.UTC(year, monthIndex, 1)).toISOString().slice(0, 7);
}

/** 'YYYY-MM' for the `months` calendar months ending in the current one, oldest first. */
export function monthKeys(months: number, today = new Date()): string[] {
  const n = clampMonths(months);
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();
  const keys: string[] = [];
  for (let i = n - 1; i >= 0; i--) keys.push(key(y, m - i));
  return keys;
}

export function previousMonth(monthKey: string): string {
  const [y, m] = monthKey.split("-").map(Number);
  return key(y, m - 2);
}

/** The first day of the month — the lower bound the queries filter on. */
export function monthStart(monthKey: string): string {
  return `${monthKey}-01`;
}

/** "September 2026" (long) or "Sep 2026" (short). A malformed key is returned as is. */
export function monthLabel(monthKey: string, style: "long" | "short" = "long"): string {
  if (!MONTH_KEY.test(monthKey)) return monthKey;
  const [y, m] = monthKey.split("-").map(Number);
  return `${(style === "long" ? LONG_MONTHS : MONTHS)[m - 1]} ${y}`;
}

/** The x-axis form: "Sep", with the year attached on January and on the first slot. */
export function axisLabel(monthKey: string, first = false): string {
  if (!MONTH_KEY.test(monthKey)) return monthKey;
  const [y, m] = monthKey.split("-").map(Number);
  return m === 1 || first ? `${MONTHS[m - 1]} '${String(y).slice(2)}` : MONTHS[m - 1];
}

/**
 * One row per key, in key order, with a zero row for any month the query
 * returned nothing for. A series with a hole is a gap in a line and a
 * missing slot in a column chart — both read as "data absent" rather than
 * "nothing happened", which is the opposite of the truth for a quiet month.
 */
export function dense<T extends { month: string }>(
  keys: string[],
  rows: T[],
  empty: (month: string) => T
): T[] {
  const byMonth = new Map(rows.map((r) => [r.month, r]));
  return keys.map((k) => byMonth.get(k) ?? empty(k));
}
