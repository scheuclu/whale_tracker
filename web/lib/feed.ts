/**
 * Pure helpers behind the home feed's timeline (app/feed-list.tsx) and the
 * bracket glyph (app/bracket-glyph.tsx). No database, no React: everything
 * here is unit-tested in feed.test.ts.
 */

/* ------------------------------------------------------------- brackets */

/**
 * The STOCK Act's value brackets, in cents, as printed on the House PTR and
 * the Senate eFD form. The last is open-ended: "Over $50,000,000" has no
 * ceiling, and none is ever invented for it.
 *
 * Spouse/dependent assets may instead be reported as "Over $1,000,000",
 * which the parser stores as min = $1,000,000, max = NULL; that spans
 * brackets 7–10 and is drawn as such (see `bracketSpan`).
 */
export const BRACKETS: ReadonlyArray<{ min: number; max: number | null; label: string }> = [
  { min: 1_001_00, max: 15_000_00, label: "$1,001–$15,000" },
  { min: 15_001_00, max: 50_000_00, label: "$15,001–$50,000" },
  { min: 50_001_00, max: 100_000_00, label: "$50,001–$100,000" },
  { min: 100_001_00, max: 250_000_00, label: "$100,001–$250,000" },
  { min: 250_001_00, max: 500_000_00, label: "$250,001–$500,000" },
  { min: 500_001_00, max: 1_000_000_00, label: "$500,001–$1,000,000" },
  { min: 1_000_001_00, max: 5_000_000_00, label: "$1,000,001–$5,000,000" },
  { min: 5_000_001_00, max: 25_000_000_00, label: "$5,000,001–$25,000,000" },
  { min: 25_000_001_00, max: 50_000_000_00, label: "$25,000,001–$50,000,000" },
  { min: 50_000_001_00, max: null, label: "Over $50,000,000" },
];

/**
 * Where a row's disclosed amount sits on the bracket ladder.
 *
 * - `range`: the disclosed interval covers brackets `lo`..`hi` (equal for
 *   every standard bracket; wider only for a non-standard interval).
 * - `open`: no ceiling. `lo` is the floor's bracket; every bracket above it
 *   is possible, none is asserted.
 * - `exact`: the filing printed a precise figure. `lo = hi` is the bracket
 *   that figure falls in, or -1 when it is below the lowest bracket ($1,001).
 * - `unknown`: no amount was read.
 */
export type BracketSpan =
  | { kind: "range" | "open" | "exact"; lo: number; hi: number }
  | { kind: "unknown"; lo: -1; hi: -1 };

const DOLLAR = 100;

/** Index of the bracket a figure (cents) falls in; -1 below the first. */
function bracketOf(cents: number): number {
  let idx = -1;
  for (let i = 0; i < BRACKETS.length; i++) if (BRACKETS[i].min <= cents) idx = i;
  return idx;
}

export function bracketSpan(
  min: number | null | undefined,
  max: number | null | undefined,
  exact?: number | null
): BracketSpan {
  if (exact != null) {
    const i = bracketOf(exact);
    return { kind: "exact", lo: i, hi: i };
  }
  if (min == null) return { kind: "unknown", lo: -1, hi: -1 };
  // "Over $X" is stored with min = X exactly, one dollar below the next
  // bracket's printed floor ($X,001), so a floor is matched with that dollar
  // of slack. Standard floors already end in ,001 and are unaffected.
  const lo = Math.max(0, bracketOf(min + DOLLAR));
  if (max == null) return { kind: "open", lo, hi: BRACKETS.length - 1 };
  let hi = lo;
  while (hi < BRACKETS.length - 1 && (BRACKETS[hi].max ?? Infinity) < max) hi++;
  return { kind: "range", lo, hi };
}

/* ---------------------------------------------------------------- dates */

/** Today's calendar date (YYYY-MM-DD) where the filings are made. */
export function todayIso(now: Date = new Date(), timeZone = "America/New_York"): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function isIsoDate(s: string | null | undefined): s is string {
  return !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
}

/** Whole days from `a` to `b` (both YYYY-MM-DD); positive when b is later. */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export type DayLabel = {
  /** "Today", "Yesterday", or "Thu, Oct 9" (with the year when it is not this year). */
  label: string;
  /** The calendar date when `label` is relative ("Sat, Oct 18"), else null. */
  date: string | null;
  /** The date lies after today: a mistyped trade date, reproduced as filed. */
  future: boolean;
};

export function dayLabel(iso: string | null, today: string): DayLabel {
  if (!isIsoDate(iso)) return { label: iso ? iso : "No trade date", date: null, future: false };
  const d = new Date(`${iso}T00:00:00Z`);
  const sameYear = iso.slice(0, 4) === today.slice(0, 4);
  const full = d.toLocaleDateString("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
  const diff = daysBetween(iso, today);
  if (diff === 0) return { label: "Today", date: full, future: false };
  if (diff === 1) return { label: "Yesterday", date: full, future: false };
  return { label: full, date: null, future: diff < 0 };
}

/** "Oct 12", or "Oct 12, 2025" outside the current year; the raw text if it is not a date. */
export function monthDay(iso: string | null, today: string): string {
  if (!isIsoDate(iso)) return iso ?? "—";
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    ...(iso.slice(0, 4) === today.slice(0, 4) ? {} : { year: "numeric" }),
  });
}

/**
 * The filing reached the Clerk before the trade it reports: a mistyped date.
 * The delay is then NULL (DELAY in lib/queries.ts) and the row is flagged
 * "date as filed" rather than shown a negative delay.
 */
export function filedBeforeTrade(txDate: string | null, filingDate: string | null): boolean {
  return isIsoDate(txDate) && isIsoDate(filingDate) && filingDate < txDate;
}

/* ------------------------------------------------------------- grouping */

/** The fields grouping needs; TransactionRow satisfies it. */
export type FeedRowLike = {
  id: number;
  tx_date: string | null;
  member_name: string;
  pdf_url: string;
  doc_id?: string | null;
};

/** Consecutive trades from one filing on one day: drawn as one block. */
export type FilingBlock<T> = { key: string; rows: T[] };

export type DayGroup<T> = DayLabel & {
  /** The trade date the group is keyed on (null for undated rows). */
  key: string | null;
  trades: number;
  filings: number;
  blocks: FilingBlock<T>[];
};

function filingKey(r: FeedRowLike): string {
  return `${r.doc_id ?? ""}|${r.pdf_url}|${r.member_name}`;
}

/**
 * Split an already-ordered feed into day groups and, within each day, runs
 * of consecutive trades from the same filing.
 *
 * The feed is ordered by **trade date** (`ORDER BY t.tx_date DESC, t.id
 * DESC` in getTransactions), so that is the date the groups are keyed on;
 * grouping on any other date would split one day across several headers.
 * The order of the input is never changed — only cut. A day that appears
 * twice non-adjacently (impossible for the feed's ORDER BY, but cheap to
 * guard) simply produces two groups rather than reordering rows.
 */
export function groupFeed<T extends FeedRowLike>(rows: readonly T[], today: string): DayGroup<T>[] {
  const days: DayGroup<T>[] = [];
  for (const r of rows) {
    const key = isIsoDate(r.tx_date) ? r.tx_date : r.tx_date ?? null;
    let day = days[days.length - 1];
    if (!day || day.key !== key) {
      day = { key, ...dayLabel(key, today), trades: 0, filings: 0, blocks: [] };
      days.push(day);
    }
    const fk = filingKey(r);
    const block = day.blocks[day.blocks.length - 1];
    if (block && block.key === fk) block.rows.push(r);
    else day.blocks.push({ key: fk, rows: [r] });
    day.trades++;
  }
  for (const day of days) day.filings = new Set(day.blocks.map((b) => b.key)).size;
  return days;
}
