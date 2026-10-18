/**
 * Geometry for the "when did they trade" timeline (app/timeline.tsx).
 *
 * Pure functions, no React and no database, so the scale, the outlier rules
 * and the stacking are unit-tested in lib/timeline.test.ts.
 *
 * Three rules carry the project's data contract into the picture:
 *
 * - A mark is sized by its bracket **floor** — the least the disclosed range
 *   allows — never by a midpoint or a guessed figure. The open-ended top
 *   bracket has a floor and no ceiling, so it sizes like any other floor.
 * - Dates are plotted **as filed**. A trade date after its own filing date is
 *   flagged, not moved. A date far outside the rest of the record (a year typed
 *   as 2016 among 2026 trades) or after today is set off in a gutter beside the
 *   axis instead of stretching the scale until everything else is one column;
 *   its tooltip still carries the date the filing printed.
 * - Transcribed rows are plotted (they are trades) but marked hollow; nothing
 *   here sums an amount, so the quarantine from totals is untouched.
 */

export type TimelineInput = {
  id: number;
  tx_date: string | null;
  filing_date: string | null;
  action: string;
  amount_min_cents: number | null;
  amount_exact_cents: number | null;
};

export type Side = "buy" | "sell" | "other";
export type Zone = "early" | "main" | "late";

export type PlacedMark<T> = {
  trade: T;
  side: Side;
  zone: Zone;
  /** Centre x in px. */
  x: number;
  /** Distance of the centre from the axis in px (0 for "other", drawn on it). */
  y: number;
  r: number;
  /** The trade date is after the filing's own date — shown where filed. */
  afterFiling: boolean;
};

export type Overflow = { side: "buy" | "sell"; x: number; count: number };

export type Tick = { x: number; label: string; year: string | null };

export type TimelineLayout<T> = {
  width: number;
  marks: PlacedMark<T>[];
  overflow: Overflow[];
  ticks: Tick[];
  /** Plot extent of the to-scale part of the axis. */
  plotLeft: number;
  plotRight: number;
  /** Height used above (buys) and below (sells) the axis. */
  above: number;
  below: number;
  /** x of today, when today lies on the to-scale axis. */
  todayX: number | null;
  early: GutterInfo | null;
  late: GutterInfo | null;
  counts: { buy: number; sell: number; other: number; undated: number; afterFiling: number };
};

export type GutterInfo = { x: number; count: number; label: string; from: string; to: string };

const DAY_MS = 86_400_000;
const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Whole days since 1970-01-01 for a valid ISO date, else null. */
export function dayNumber(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const m = ISO.exec(iso);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  // Reject 2026-02-31 and the like rather than letting Date roll it over.
  if (back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return Math.round(t / DAY_MS);
}

export function isoFromDay(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

export function sideOf(action: string): Side {
  if (action === "purchase") return "buy";
  if (action === "sale" || action === "sale_partial") return "sell";
  return "other";
}

/** The smallest mark: 8px across, the marker floor in the data-viz spec. */
export const MIN_R = 4;
const R_PER_DECADE = 1.5;
const LOWEST_FLOOR_CENTS = 1_001_00;

/**
 * Radius from the bracket floor (or the exact figure, when the filing stated
 * one), on a log scale: floors run from $1,001 to $50,000,001, and an
 * area-true scale would make the lowest bracket — 83% of rows — invisible
 * next to one large trade. An unknown amount gets the smallest mark, never
 * a guessed size.
 */
export function floorRadius(cents: number | null | undefined): number {
  if (cents == null || !(cents > 0)) return MIN_R;
  const ratio = Math.max(cents, LOWEST_FLOOR_CENTS) / LOWEST_FLOOR_CENTS;
  return MIN_R + R_PER_DECADE * Math.log10(ratio);
}

export function floorCents(t: Pick<TimelineInput, "amount_min_cents" | "amount_exact_cents">): number | null {
  return t.amount_exact_cents ?? t.amount_min_cents;
}

/**
 * Splits off leading dates that sit far before the rest: the gap to the next
 * date must be over a year AND longer than the whole span after it, so the
 * outliers would otherwise squeeze the record into under half the axis. At
 * most half the points may be set aside — a minority is the outlier, never
 * the majority. Returns how many sorted days belong to the early gutter.
 */
export function earlySplit(sortedDays: number[]): number {
  const n = sortedDays.length;
  if (n < 2) return 0;
  const hi = sortedDays[n - 1];
  let best = 0;
  let bestGap = 0;
  for (let k = 1; k <= Math.floor(n / 2); k++) {
    const gap = sortedDays[k] - sortedDays[k - 1];
    const rest = hi - sortedDays[k];
    if (gap > 365 && gap > rest && gap > bestGap) {
      best = k;
      bestGap = gap;
    }
  }
  return best;
}

/**
 * Lays marks out away from the axis, beeswarm style: each in date order takes
 * the position nearest the axis that does not touch a mark already placed.
 * Marks whose centre-to-edge would pass `maxExtent` are not placed; they are
 * counted per `binPx` bucket so the chart can say "+N" instead of silently
 * dropping them. Returns, per input, the distance from the axis or null.
 */
export function dodge(
  items: { x: number; r: number }[],
  opts: { gap?: number; base?: number; maxExtent?: number } = {}
): (number | null)[] {
  const gap = opts.gap ?? 1;
  const base = opts.base ?? 2;
  const maxExtent = opts.maxExtent ?? Infinity;
  const placed: { x: number; y: number; r: number }[] = [];
  const out: (number | null)[] = new Array(items.length).fill(null);
  const order = items
    .map((it, i) => i)
    .sort((a, b) => items[a].x - items[b].x || items[b].r - items[a].r || a - b);

  for (const i of order) {
    const { x, r } = items[i];
    const floor = r + base;
    const near: { y: number; reach: number }[] = [];
    for (const p of placed) {
      const need = p.r + r + gap;
      const dx = Math.abs(p.x - x);
      if (dx < need) near.push({ y: p.y, reach: Math.sqrt(need * need - dx * dx) });
    }
    const candidates = [floor, ...near.map((p) => p.y + p.reach)].filter((c) => c >= floor).sort((a, b) => a - b);
    let y: number | null = null;
    for (const c of candidates) {
      if (near.every((p) => Math.abs(c - p.y) >= p.reach - 1e-6)) {
        y = c;
        break;
      }
    }
    if (y == null || y + r > maxExtent) continue;
    placed.push({ x, y, r });
    out[i] = y;
  }
  return out;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Month ticks between two day numbers. The step (1, 2, 3, 6 or 12 months) is
 * the smallest that keeps labels `minGapPx` apart; the year is printed under
 * the first tick and every January. At a 12-month step the label is the year.
 */
export function monthTicks(lo: number, hi: number, x: (day: number) => number, minGapPx = 46): Tick[] {
  const pxPerMonth = Math.abs(x(lo + 30.44) - x(lo));
  const step = [1, 2, 3, 6, 12].find((s) => s * pxPerMonth >= minGapPx) ?? 12 * Math.ceil(minGapPx / (12 * pxPerMonth));
  const start = new Date(lo * DAY_MS);
  let idx = start.getUTCFullYear() * 12 + start.getUTCMonth();
  // First month boundary at or after lo, aligned to the step (a 12-month
  // step lands on Januaries).
  if (Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1) / DAY_MS < lo) idx += 1;
  idx = Math.ceil(idx / step) * step;
  const ticks: Tick[] = [];
  for (; ; idx += step) {
    const y = Math.floor(idx / 12);
    const m = idx % 12;
    const day = Date.UTC(y, m, 1) / DAY_MS;
    if (day > hi) break;
    if (step >= 12) ticks.push({ x: x(day), label: String(y), year: null });
    else ticks.push({ x: x(day), label: MONTHS[m], year: ticks.length === 0 || m === 0 ? String(y) : null });
  }
  return ticks;
}

export type LayoutOptions = {
  width: number;
  /** ISO date treated as today (passed in so tests and renders agree). */
  today: string;
  /** Farthest a mark may reach from the axis, px. */
  maxExtent?: number;
  /** Shortest span the axis shows, in days, so one trade is not a full-width blur. */
  minSpanDays?: number;
};

const EDGE = 10;
/** Left column kept clear for the rotated "buys" / "sells" side labels. */
export const LABEL_COL = 18;
const GUTTER = 44;
const BREAK = 14;
const BIN_PX = 14;
const MIN_SIDE = 36;
const MERGE_PX = 24;

/**
 * Folds "+N" counters closer than `MERGE_PX` into one, placed at their
 * count-weighted centre, so two labels never print on top of each other.
 */
export function mergeBins(bins: Overflow[]): Overflow[] {
  const sorted = [...bins].sort((a, b) => a.x - b.x);
  const out: Overflow[] = [];
  for (const b of sorted) {
    const prev = out[out.length - 1];
    if (prev && b.x - prev.x < MERGE_PX) {
      const count = prev.count + b.count;
      prev.x = (prev.x * prev.count + b.x * b.count) / count;
      prev.count = count;
    } else out.push({ ...b });
  }
  return out;
}

/** A year range label for a gutter: "2016" or "2016–2021". */
function yearSpan(from: number, to: number): string {
  const a = isoFromDay(from).slice(0, 4);
  const b = isoFromDay(to).slice(0, 4);
  return a === b ? a : `${a}–${b}`;
}

export function layoutTimeline<T extends TimelineInput>(trades: T[], opts: LayoutOptions): TimelineLayout<T> {
  const { width } = opts;
  const maxExtent = opts.maxExtent ?? 120;
  const minSpan = opts.minSpanDays ?? 60;
  const today = dayNumber(opts.today) ?? Math.floor(Date.now() / DAY_MS);

  const dated: { t: T; day: number; filed: number | null }[] = [];
  let undated = 0;
  for (const t of trades) {
    const day = dayNumber(t.tx_date);
    if (day == null) undated += 1;
    else dated.push({ t, day, filed: dayNumber(t.filing_date) });
  }

  // Future-dated trades (after today) can only be typos; they go right.
  const late = dated.filter((d) => d.day > today);
  let current = dated.filter((d) => d.day <= today).sort((a, b) => a.day - b.day);
  const k = earlySplit(current.map((d) => d.day));
  const early = current.slice(0, k);
  current = current.slice(k);
  if (!current.length && late.length) {
    // Every dated row is future-dated: nothing to set apart from, plot as is.
    current = late.splice(0).sort((a, b) => a.day - b.day);
  }

  let lo = current.length ? current[0].day : today - minSpan;
  let hi = current.length ? current[current.length - 1].day : today;
  // Show the run-up to today when the record ends close to it.
  if (today > hi && today - hi <= Math.max((hi - lo) * 0.25, 14)) hi = today;
  if (hi - lo < minSpan) {
    const grow = (minSpan - (hi - lo)) / 2;
    lo -= grow;
    hi += grow;
    if (hi > today && current.every((d) => d.day <= today)) {
      lo -= hi - today;
      hi = today;
    }
  }
  const pad = Math.max((hi - lo) * 0.025, 3);
  lo -= pad;
  hi += pad;

  const plotLeft = LABEL_COL + EDGE + (early.length ? GUTTER + BREAK : 0);
  const plotRight = width - EDGE - (late.length ? GUTTER + BREAK : 0);
  const x = (day: number) => plotLeft + ((day - lo) / (hi - lo)) * (plotRight - plotLeft);
  const earlyX = LABEL_COL + EDGE + GUTTER / 2;
  const lateX = width - EDGE - GUTTER / 2;

  type Pre = { t: T; zone: Zone; x: number; r: number; side: Side; afterFiling: boolean };
  const pre: Pre[] = [];
  const add = (list: typeof dated, zone: Zone) => {
    for (const d of list) {
      pre.push({
        t: d.t,
        zone,
        x: zone === "early" ? earlyX : zone === "late" ? lateX : x(d.day),
        r: floorRadius(floorCents(d.t)),
        side: sideOf(d.t.action),
        afterFiling: d.filed != null && d.day > d.filed,
      });
    }
  };
  add(early, "early");
  add(current, "main");
  add(late, "late");

  const marks: PlacedMark<T>[] = [];
  const overflow: Overflow[] = [];
  const extent = { buy: 0, sell: 0 };
  for (const side of ["buy", "sell"] as const) {
    const group = pre.filter((p) => p.side === side);
    const ys = dodge(group, { maxExtent });
    const bins = new Map<number, Overflow>();
    group.forEach((p, i) => {
      const y = ys[i];
      if (y == null) {
        const key = Math.round(p.x / BIN_PX);
        const bin = bins.get(key) ?? { side, x: key * BIN_PX, count: 0 };
        bin.count += 1;
        bins.set(key, bin);
        return;
      }
      extent[side] = Math.max(extent[side], y + p.r + 2);
      marks.push({ trade: p.t, side, zone: p.zone, x: p.x, y, r: p.r, afterFiling: p.afterFiling });
    });
    overflow.push(...mergeBins([...bins.values()]));
  }
  for (const p of pre.filter((q) => q.side === "other")) {
    marks.push({ trade: p.t, side: "other", zone: p.zone, x: p.x, y: 0, r: p.r, afterFiling: p.afterFiling });
  }
  // Chronological DOM order: keyboard focus walks the timeline left to right.
  const dayOf = (m: PlacedMark<T>) => dayNumber(m.trade.tx_date) ?? 0;
  marks.sort((a, b) => dayOf(a) - dayOf(b) || a.trade.id - b.trade.id);

  const hasOver = (side: "buy" | "sell") => overflow.some((o) => o.side === side);
  const above = Math.max(MIN_SIDE, extent.buy) + (hasOver("buy") ? 16 : 0);
  const below = Math.max(MIN_SIDE, extent.sell) + (hasOver("sell") ? 16 : 0);

  const gutter = (list: typeof dated, gx: number): GutterInfo | null => {
    if (!list.length) return null;
    const days = list.map((d) => d.day).sort((a, b) => a - b);
    return {
      x: gx,
      count: list.length,
      label: yearSpan(days[0], days[days.length - 1]),
      from: isoFromDay(days[0]),
      to: isoFromDay(days[days.length - 1]),
    };
  };

  return {
    width,
    marks,
    overflow,
    ticks: monthTicks(lo, hi, x),
    plotLeft,
    plotRight,
    above,
    below,
    todayX: today >= lo && today <= hi ? x(today) : null,
    early: gutter(early, earlyX),
    late: gutter(late, lateX),
    counts: {
      buy: pre.filter((p) => p.side === "buy").length,
      sell: pre.filter((p) => p.side === "sell").length,
      other: pre.filter((p) => p.side === "other").length,
      undated,
      afterFiling: pre.filter((p) => p.afterFiling).length,
    },
  };
}
