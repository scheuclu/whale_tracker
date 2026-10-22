/**
 * The price overlay's logic (app/price-overlay.tsx, app/price-overlay-chart.tsx):
 * daily closes on the same calendar axis as the trades of one symbol, with
 * congressional and Form 4 trades in separate lanes and the windows where
 * several of them converged shaded.
 *
 * Pure functions, no React, no database, no network — tested in
 * lib/price-overlay.test.ts. The rules it carries:
 *
 * - **Descriptive only.** Closes are drawn, never turned into a return, an
 *   excess move or anything that reads as a trade's outcome (those are
 *   derived once in Python: `stats.alert_outcomes`).
 * - **Two populations, never pooled.** Congressional and insider trades share
 *   the time axis and nothing else: separate lanes, separate cluster rules,
 *   separate counts (CLAUDE.md, "SEC Form 4").
 * - **Amounts stay what was filed.** A congressional mark is sized by its
 *   bracket floor (lib/timeline.ts `floorRadius`); an insider mark by shares ×
 *   reported price, and the smallest mark when there is no price.
 * - **Trade dates as filed, on the calendar.** The axis is calendar days, so
 *   a trade dated on a weekend or a market holiday sits between the sessions
 *   around it — it is NOT snapped to a session. The readout for that date says
 *   there was no session and gives the closes on either side (`alignToSessions`).
 */

import {
  dayNumber,
  dodge,
  earlySplit,
  floorRadius,
  isoFromDay,
  mergeBins,
  monthTicks,
  type Overflow,
  type Tick,
} from "./timeline";

export type Side = "buy" | "sell" | "other";

/** One trade as a lane plots it. Strings are display text, already formatted. */
export type LaneTrade = {
  id: number;
  /** ISO trade date as filed. */
  date: string;
  side: Side;
  /** Size basis: bracket floor (congress) or shares × reported price (insider); null = unknown. */
  sizeCents: number | null;
  /** Who: a member label, or an insider's name and role. */
  who: string;
  /** The amount as it should be read: a disclosed range, or a computed value. */
  amount: string;
  /** Transcribed from a scanned filing: drawn hollow, in no total. */
  hollow?: boolean;
};

export type Source = "congress" | "insider";

export type ClusterSpan = {
  source: Source;
  side: "buy" | "sell";
  /** ISO dates: the earliest counted trade in a qualifying window, and the latest window end. */
  start: string;
  end: string;
  /** Most counted participants in any one window of the span. */
  peak: number;
  /** Every counted participant across the span, sorted. */
  people: string[];
};

/* ------------------------------------------------------------- cluster rules */

/**
 * The congressional cluster rule, as `stats.find_clusters` applies it with
 * config.yaml `alerts`: a window of `window_days` on trade date; a member
 * counts only if their bracket floors there reach `min_member_floor_usd`;
 * at least `min_politicians` such members AND an estimated (midpoint) volume
 * of `min_volume_usd`; equity-like asset types only; a parsed option contract
 * counts toward no direction (`cluster_count_options: false`); a transcribed
 * row is a participant with no floor and no volume. lib/price-overlay.test.ts
 * reads config.yaml and fails if these drift.
 */
export const CONGRESS_RULE = {
  windowDays: 90,
  minPeople: 3,
  minPersonFloorCents: 15_001_00,
  minVolumeCents: 500_000_00,
  assetTypes: ["ST", "OP", "EF", "ET", "CT", "RS", "SA"],
  countOptions: false,
} as const;

/**
 * The insider cluster rule, as `stats.find_insider_clusters` with config.yaml
 * `insiders.cluster_window_days` / `insiders.min_insiders`: distinct primary
 * reporting owners trading the same way within 30 days. Form 4's two-business-day
 * deadline leaves no reporting lag to absorb, hence the shorter window.
 */
export const INSIDER_RULE = {
  windowDays: 30,
  minPeople: 3,
  minPersonFloorCents: 0,
  minVolumeCents: 0,
} as const;

export type ClusterRule = {
  windowDays: number;
  minPeople: number;
  minPersonFloorCents: number;
  minVolumeCents: number;
};

/** One trade as a cluster rule weighs it. `floor`/`mid` are 0 for a row in no total. */
export type ClusterEvent = { day: number; side: "buy" | "sell"; who: string; floor: number; mid: number };

/**
 * Spans where the rule held. The rule is evaluated for a window ending on
 * every trade date (the window is `[end − windowDays, end]`, inclusive, as
 * `stats._window_start` makes it), as if the alert had run that day with
 * every trade already disclosed — which it was not: members file up to 45
 * days later. A qualifying window contributes the stretch from its earliest
 * counted trade to its end; overlapping or touching stretches merge.
 */
export function clusterSpans(events: ClusterEvent[], rule: ClusterRule, source: Source): ClusterSpan[] {
  const out: ClusterSpan[] = [];
  for (const side of ["buy", "sell"] as const) {
    const ev = events.filter((e) => e.side === side).sort((a, b) => a.day - b.day);
    const raw: { start: number; end: number; count: number; people: string[] }[] = [];
    let lo = 0;
    for (let j = 0; j < ev.length; j++) {
      const end = ev[j].day;
      // Evaluate once per distinct end date, with every trade of that date in.
      if (j + 1 < ev.length && ev[j + 1].day === end) continue;
      while (ev[lo].day < end - rule.windowDays) lo++;
      const floors = new Map<string, number>();
      const first = new Map<string, number>();
      let volume = 0;
      for (let i = lo; i <= j; i++) {
        const e = ev[i];
        floors.set(e.who, (floors.get(e.who) ?? 0) + e.floor);
        if (!first.has(e.who)) first.set(e.who, e.day);
        volume += e.mid;
      }
      const counted = [...floors.entries()].filter(([, f]) => f >= rule.minPersonFloorCents).map(([w]) => w);
      if (counted.length < rule.minPeople || volume < rule.minVolumeCents) continue;
      const start = Math.min(...counted.map((w) => first.get(w)!));
      raw.push({ start, end, count: counted.length, people: counted });
    }
    let cur: (typeof raw)[number] | null = null;
    const flush = () => {
      if (!cur) return;
      out.push({
        source,
        side,
        start: isoFromDay(cur.start),
        end: isoFromDay(cur.end),
        peak: cur.count,
        people: [...new Set(cur.people)].sort(),
      });
    };
    for (const r of raw.sort((a, b) => a.start - b.start)) {
      if (cur && r.start <= cur.end + 1) {
        cur = {
          start: cur.start,
          end: Math.max(cur.end, r.end),
          count: Math.max(cur.count, r.count),
          people: [...cur.people, ...r.people],
        };
      } else {
        flush();
        cur = { ...r };
      }
    }
    flush();
  }
  return out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
}

/** A congressional row as the cluster rule needs it (a subset of `TimelineTrade`). */
export type CongressRow = {
  tx_date: string | null;
  action: string;
  asset_type: string | null;
  option_kind: string | null;
  member_name: string;
  amount_min_cents: number | null;
  amount_max_cents: number | null;
  amount_exact_cents: number | null;
  transcribed: number;
};

/** `stats.trade_direction` with the cluster finder's option setting. */
export function congressDirection(action: string, optionKind: string | null, countOptions: boolean): "buy" | "sell" | null {
  const base = action === "purchase" ? "buy" : action === "sale" || action === "sale_partial" ? "sell" : null;
  if (!base || optionKind == null) return base;
  if (!countOptions) return null;
  return optionKind === "put" ? (base === "buy" ? "sell" : "buy") : base;
}

/** `Volume.add`'s midpoint for one row: the exact figure, the floor of an open bracket, else the midpoint. */
export function midCents(min: number | null, max: number | null, exact: number | null): number {
  if (exact != null) return exact;
  if (max == null) return min ?? 0;
  return min == null ? 0 : Math.floor((min + max) / 2);
}

export function congressEvents(rows: CongressRow[], rule = CONGRESS_RULE): ClusterEvent[] {
  const types = new Set<string>(rule.assetTypes);
  const out: ClusterEvent[] = [];
  for (const r of rows) {
    const day = dayNumber(r.tx_date);
    if (day == null || !r.asset_type || !types.has(r.asset_type)) continue;
    const side = congressDirection(r.action, r.option_kind, rule.countOptions);
    if (!side) continue;
    const priced = !r.transcribed;
    out.push({
      day,
      side,
      who: r.member_name || "unknown",
      floor: priced ? (r.amount_exact_cents ?? r.amount_min_cents ?? 0) : 0,
      mid: priced ? midCents(r.amount_min_cents, r.amount_max_cents, r.amount_exact_cents) : 0,
    });
  }
  return out;
}

/** An insider row as the cluster rule needs it: the primary owner, open-market P/S only. */
export type InsiderRow = { tx_date: string | null; action: string; insider_cik: string | null };

export function insiderEvents(rows: InsiderRow[]): ClusterEvent[] {
  const out: ClusterEvent[] = [];
  for (const r of rows) {
    const day = dayNumber(r.tx_date);
    const side = r.action === "purchase" ? "buy" : r.action === "sale" ? "sell" : null;
    if (day == null || !side) continue;
    out.push({ day, side, who: r.insider_cik ?? "unknown", floor: 0, mid: 0 });
  }
  return out;
}

/* ------------------------------------------------------------------- domain */

export type Domain = {
  /** ISO, inclusive. */
  lo: string;
  hi: string;
  /** Trades not drawn: far earlier than the rest (a typed year) or dated after today. */
  outside: number;
};

/**
 * The calendar span the chart shows: from shortly before the first trade to
 * today, so the price after the last trade is on the chart too. A date far
 * before the rest (`earlySplit`, the timeline's rule) or after today is a
 * filing typo; it is left off and counted rather than stretching the axis.
 */
export function chartDomain(dates: (string | null)[], today: string, minSpanDays = 120): Domain | null {
  const t = dayNumber(today);
  if (t == null) return null;
  const all = dates.map(dayNumber).filter((d): d is number => d != null);
  const past = all.filter((d) => d <= t).sort((a, b) => a - b);
  const k = earlySplit(past);
  const kept = past.slice(k);
  if (!kept.length) return null;
  const first = kept[0];
  let lo = first - Math.max(14, Math.round((t - first) * 0.04));
  if (t - lo < minSpanDays) lo = t - minSpanDays;
  return { lo: isoFromDay(lo), hi: isoFromDay(t), outside: all.length - kept.length };
}

/* ---------------------------------------------------------------- alignment */

export type Session = { day: number; close: number };

export function toSessions(closes: { date: string; close: number }[]): Session[] {
  const out: Session[] = [];
  for (const c of closes) {
    const day = dayNumber(c.date);
    if (day != null && Number.isFinite(c.close) && c.close > 0) out.push({ day, close: c.close });
  }
  return out.sort((a, b) => a.day - b.day);
}

/**
 * Where a calendar day falls among sessions: the index of the session that
 * day, or — for a weekend, a holiday, or a day past the last final close —
 * the sessions before and after it (either may be missing). Binary search;
 * `sessions` sorted by day.
 */
export function alignToSessions(day: number, sessions: Session[]): { at: number | null; prev: number | null; next: number | null } {
  let lo = 0;
  let hi = sessions.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sessions[mid].day < day) lo = mid + 1;
    else hi = mid;
  }
  if (lo < sessions.length && sessions[lo].day === day) return { at: lo, prev: null, next: null };
  return { at: null, prev: lo > 0 ? lo - 1 : null, next: lo < sessions.length ? lo : null };
}

/**
 * The positions the crosshair stops at: every session in the domain, plus
 * every trade date that is not a session (it gets its own stop, so its
 * trades are never filed under a neighbouring day). Sorted, unique.
 */
export function crosshairStops(sessions: Session[], tradeDays: number[], lo: number, hi: number): number[] {
  const set = new Set<number>();
  for (const s of sessions) if (s.day >= lo && s.day <= hi) set.add(s.day);
  for (const d of tradeDays) if (d >= lo && d <= hi) set.add(d);
  return [...set].sort((a, b) => a - b);
}

/** Nearest stop to a day (ties go to the earlier one). */
export function nearestStop(stops: number[], day: number): number | null {
  if (!stops.length) return null;
  let lo = 0;
  let hi = stops.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (stops[mid] < day) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && day - stops[lo - 1] <= stops[lo] - day) return lo - 1;
  return lo;
}

/**
 * Closes rebased to 100 at the first session on or after `from`, for the
 * "vs SPY" view: both lines on one axis, never a second scale. Sessions
 * before `from` are dropped.
 */
export function indexTo100(sessions: Session[], from: number): Session[] {
  const kept = sessions.filter((s) => s.day >= from);
  if (!kept.length) return [];
  const base = kept[0].close;
  return kept.map((s) => ({ day: s.day, close: (s.close / base) * 100 }));
}

/** 3–6 round ticks covering [min, max]. */
export function niceTicks(min: number, max: number, target = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (max <= min) {
    const pad = Math.abs(min) * 0.05 || 1;
    min -= pad;
    max += pad;
  }
  const raw = (max - min) / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => (max - min) / s <= target + 1) ?? 10 * mag;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

/* ------------------------------------------------------------------ layout */

export type PlacedLaneMark = { trade: LaneTrade; x: number; y: number; r: number };

export type LaneLayout = {
  source: Source;
  /** Lane centre line (y) — buys above, sells below, other on it. */
  mid: number;
  top: number;
  bottom: number;
  marks: PlacedLaneMark[];
  overflow: Overflow[];
};

export type OverlayLayout = {
  width: number;
  height: number;
  plotLeft: number;
  plotRight: number;
  priceTop: number;
  priceBottom: number;
  lanes: LaneLayout[];
  axisY: number;
  ticks: Tick[];
  lo: number;
  hi: number;
  x: (day: number) => number;
  dayAt: (x: number) => number;
};

export type LayoutOpts = {
  width: number;
  priceHeight: number;
  laneHalf: number;
  lo: string;
  hi: string;
  lanes: { source: Source; trades: LaneTrade[] }[];
};

export const LEFT = 52;
const RIGHT = 14;
const TOP = 10;
const LANE_HEAD = 22;
const LANE_GAP = 8;
const AXIS_BAND = 34;
/** Kept clear at the outer edge of each half-lane for the "+N" counters. */
export const OVERFLOW_BAND = 13;

/**
 * Geometry: a price panel on top, then one lane per population, then the
 * month axis — all on one x scale. Lane marks are placed beeswarm-style
 * (`dodge`) away from the lane's centre line; marks past `laneHalf` are
 * counted as "+N" rather than dropped silently.
 */
export function layoutOverlay(o: LayoutOpts): OverlayLayout {
  const lo = dayNumber(o.lo)!;
  const hi = dayNumber(o.hi)!;
  const plotLeft = LEFT;
  const plotRight = o.width - RIGHT;
  const span = Math.max(hi - lo, 1);
  const x = (day: number) => plotLeft + ((day - lo) / span) * (plotRight - plotLeft);
  const dayAt = (px: number) => lo + ((px - plotLeft) / (plotRight - plotLeft)) * span;
  const priceTop = TOP;
  const priceBottom = TOP + o.priceHeight;
  let y = priceBottom + LANE_GAP;
  const lanes: LaneLayout[] = [];
  // The largest mark still fits beside the centre line inside its half-lane.
  // Capped well below the half-lane so a busy date stacks two deep before it
  // spills into a "+N" count.
  const maxR = Math.max(4, Math.min(7, Math.floor((o.laneHalf - OVERFLOW_BAND - 1) / 2)));
  for (const lane of o.lanes) {
    const top = y + LANE_HEAD;
    const mid = top + o.laneHalf;
    const marks: PlacedLaneMark[] = [];
    const overflow: Overflow[] = [];
    const inRange = lane.trades
      .map((t) => ({ t, day: dayNumber(t.date) }))
      .filter((d): d is { t: LaneTrade; day: number } => d.day != null && d.day >= lo && d.day <= hi);
    for (const side of ["buy", "sell"] as const) {
      const group = inRange.filter((d) => d.t.side === side).map((d) => ({ ...d, x: x(d.day), r: Math.min(floorRadius(d.t.sizeCents), maxR) }));
      const ys = dodge(group, { maxExtent: o.laneHalf - OVERFLOW_BAND, base: 1 });
      const bins = new Map<number, Overflow>();
      group.forEach((g, i) => {
        const dy = ys[i];
        if (dy == null) {
          const key = Math.round(g.x / 14);
          const bin = bins.get(key) ?? { side, x: key * 14, count: 0 };
          bin.count += 1;
          bins.set(key, bin);
          return;
        }
        marks.push({ trade: g.t, x: g.x, y: side === "buy" ? mid - dy : mid + dy, r: g.r });
      });
      overflow.push(...mergeBins([...bins.values()]));
    }
    for (const d of inRange.filter((d) => d.t.side === "other")) {
      marks.push({ trade: d.t, x: x(d.day), y: mid, r: Math.min(floorRadius(d.t.sizeCents), maxR) });
    }
    marks.sort((a, b) => a.x - b.x || a.trade.id - b.trade.id);
    const bottom = mid + o.laneHalf;
    lanes.push({ source: lane.source, mid, top, bottom, marks, overflow });
    y = bottom + LANE_GAP;
  }
  const axisY = y;
  return {
    width: o.width,
    height: axisY + AXIS_BAND,
    plotLeft,
    plotRight,
    priceTop,
    priceBottom,
    lanes,
    axisY,
    ticks: monthTicks(lo, hi, x),
    lo,
    hi,
    x,
    dayAt,
  };
}

/** An SVG path through the sessions in [lo, hi]: one `M`, then `L`s. */
export function linePath(sessions: Session[], x: (d: number) => number, y: (v: number) => number, lo: number, hi: number): string {
  let d = "";
  for (const s of sessions) {
    if (s.day < lo || s.day > hi) continue;
    d += `${d ? "L" : "M"}${Math.round(x(s.day) * 10) / 10} ${Math.round(y(s.close) * 10) / 10}`;
  }
  return d;
}
