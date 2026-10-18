import { ALERT_KINDS } from "./alert-queries";
import { getDb } from "./db";

/**
 * What each alerted ticker did next — `alert_outcomes` in src/whale/db.py.
 *
 * The rows are derived once in Python (`stats.alert_outcomes`) and rebuilt
 * after every price refresh: the ticker's close-to-close move at +5/+20/+60
 * trading days from the first session on or after the alert's US-Eastern
 * date, minus SPY over the same sessions. This module only reads them. The
 * aggregate — median signed excess, hit rate and n per kind and horizon — is
 * computed here from the stored rows and in `stats.outcome_summary` the same
 * way, and both are tested against the same hand-made fixture.
 *
 * These are a ticker's moves, never a trade's return. Congressional amounts
 * are brackets and nothing here touches one; the figures say whether the
 * rule that fired pointed the right way, not what anyone earned. The price
 * series is an unofficial external one and is never shown as advice.
 *
 * The committed database migrates to the schema with these tables only when
 * the pipeline next runs, so every query here asks whether they exist and
 * answers "nothing yet" rather than throwing.
 */

export const HORIZONS = [5, 20, 60] as const;
export type Horizon = (typeof HORIZONS)[number];
/** Below this many alerts a median or hit rate is an anecdote; mirrors stats.MIN_OUTCOME_SAMPLE. */
export const MIN_SAMPLE = 5;
export const BENCHMARK = "SPY";

/** A key a price series could exist for: not NULL, not a bare CIK. Mirrors stats.is_listed_ticker. */
export function isListedTicker(ticker: string | null | undefined): ticker is string {
  return !!ticker && !/^\d{10}$/.test(ticker);
}

export type AlertOutcome = {
  alert_id: number;
  ticker: string;
  /** First trading day on/after the alert's US-Eastern date. */
  t0_date: string;
  t0_close: number;
  /** Trading days after t0 the benchmark series covers; a horizon past it is pending. */
  days_elapsed: number;
  ret_5: number | null;
  bench_5: number | null;
  excess_5: number | null;
  ret_20: number | null;
  bench_20: number | null;
  excess_20: number | null;
  ret_60: number | null;
  bench_60: number | null;
  excess_60: number | null;
};

type Db = Awaited<ReturnType<typeof getDb>>;

function hasTable(db: Db, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

/** Every stored outcome, keyed by alert id. Empty until the pipeline has priced anything. */
export async function getAlertOutcomes(): Promise<Map<number, AlertOutcome>> {
  const db = await getDb();
  if (!hasTable(db, "alert_outcomes")) return new Map();
  const rows = db
    .prepare(
      `SELECT alert_id, ticker, t0_date, t0_close, days_elapsed,
              ret_5, bench_5, excess_5, ret_20, bench_20, excess_20, ret_60, bench_60, excess_60
       FROM alert_outcomes`
    )
    .all() as AlertOutcome[];
  return new Map(rows.map((r) => [r.alert_id, r]));
}

/** The excess return read the way the alert pointed: a sell alert's hit is a fall.
 *  An alert with no one direction made no claim and is excluded (null). Mirrors stats.signed_excess. */
export function signedExcess(excess: number | null, direction: string | null): number | null {
  if (excess == null || (direction !== "buy" && direction !== "sell")) return null;
  return direction === "sell" ? -excess : excess;
}

/** Standard median: the middle value, or the mean of the two middle values. */
export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export type OutcomeInput = {
  kind: string;
  direction: string | null;
  excess_5: number | null;
  excess_20: number | null;
  excess_60: number | null;
};

export type HorizonStat = {
  horizon: Horizon;
  /** Alerts with a direction whose series reaches this horizon. */
  n: number;
  /** Median of the direction-signed excess returns; null when n is 0. */
  median_excess: number | null;
  /** Share of those alerts whose signed excess was above zero; null when n is 0. */
  hit_rate: number | null;
  sufficient: boolean;
};

export type KindOutcomeStat = { kind: string; horizons: HorizonStat[] };

/**
 * Per kind and horizon, from the stored rows. Kinds in `ALERT_KINDS` order,
 * only those with at least one outcome; a kind none of whose alerts reach a
 * horizon is listed there with n = 0. Mirrors stats.outcome_summary.
 */
export function summarize(rows: OutcomeInput[], minSample = MIN_SAMPLE): KindOutcomeStat[] {
  const present = new Set(rows.map((r) => r.kind));
  const kinds = [
    ...ALERT_KINDS.filter((k) => present.has(k)),
    ...[...present].filter((k) => !(ALERT_KINDS as readonly string[]).includes(k)).sort(),
  ];
  return kinds.map((kind) => ({
    kind,
    horizons: HORIZONS.map((horizon) => {
      const signed = rows
        .filter((r) => r.kind === kind)
        .map((r) => signedExcess(r[`excess_${horizon}`], r.direction))
        .filter((s): s is number => s != null);
      const n = signed.length;
      return {
        horizon,
        n,
        median_excess: n ? median(signed) : null,
        hit_rate: n ? signed.filter((s) => s > 0).length / n : null,
        sufficient: n >= minSample,
      };
    }),
  }));
}

export type OutcomeSummary = {
  /** Whether the price tables exist in the database being read. */
  available: boolean;
  /** `sync_state.prices_status`: the last price run's outcome, in the audit's vocabulary. */
  status: string | null;
  /** The benchmark's newest close. */
  newest_close: string | null;
  /** Whole-log counts, never the page slice. */
  alerts_total: number;
  alerts_listed: number;
  alerts_priced: number;
  /** Listed tickers the source has no series for at all. */
  no_series: string[];
  byKind: KindOutcomeStat[];
};

/** Coverage and the per-kind table over every alert, not the rendered slice. */
export async function getOutcomeSummary(): Promise<OutcomeSummary> {
  const db = await getDb();
  const tickers = db.prepare("SELECT ticker FROM alerts").all() as { ticker: string | null }[];
  const base = {
    alerts_total: tickers.length,
    alerts_listed: tickers.filter((t) => isListedTicker(t.ticker)).length,
  };
  if (!hasTable(db, "alert_outcomes") || !hasTable(db, "prices")) {
    return { ...base, available: false, status: null, newest_close: null, alerts_priced: 0, no_series: [], byKind: [] };
  }
  const rows = db
    .prepare(
      `SELECT a.kind, a.direction, o.excess_5, o.excess_20, o.excess_60
       FROM alert_outcomes o JOIN alerts a ON a.id = o.alert_id`
    )
    .all() as OutcomeInput[];
  const status = db.prepare("SELECT value FROM sync_state WHERE key = 'prices_status'").get() as
    | { value: string | null }
    | undefined;
  const newest = db.prepare("SELECT MAX(date) AS d FROM prices WHERE ticker = ?").get(BENCHMARK) as {
    d: string | null;
  };
  const unpriced = db
    .prepare(
      `SELECT DISTINCT a.ticker FROM alerts a
       WHERE a.ticker IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM prices p WHERE p.ticker = a.ticker)
       ORDER BY a.ticker`
    )
    .all() as { ticker: string }[];
  return {
    ...base,
    available: true,
    status: status?.value ?? null,
    newest_close: newest?.d ?? null,
    alerts_priced: rows.length,
    no_series: unpriced.map((r) => r.ticker).filter(isListedTicker),
    byKind: summarize(rows),
  };
}
