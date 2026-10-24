import type Database from "better-sqlite3";
import { getDb } from "./db";

/**
 * Track record — `track_decisions`, `track_scores`, `track_model` and
 * `track_coverage` in src/whale/db.py (schema 16).
 *
 * "Whose trades were followed by the biggest market-beating moves": for each
 * member decision (member, ticker, direction, filing) the ticker's
 * close-to-close move after it minus SPY's over the same trading days, read
 * the way the trade pointed, from the trade date and from the disclosure.
 * Every figure here — decision values, shrunk scores, intervals, hit rates,
 * luck percentiles, ranks, the minimum — is derived once in Python
 * (`stats.track_scores`, `track.sync`) and only read here. Nothing in this
 * module computes a score: a TS twin of the shrinkage or the bootstrap would
 * be a second definition that could drift.
 *
 * No dollar amount enters any of it (brackets are not amounts; every
 * decision weighs one). It is a stock's move, not anyone's profit.
 *
 * The committed database gains these tables only on the pipeline's first run
 * after the merge, so every query asks whether they exist and the pages say
 * "being computed" rather than fail.
 */

/** Horizons the dashboard switches between (trading days); 180 is API-only. */
export const TRACK_HORIZONS = [30, 90] as const;
export const ALL_TRACK_HORIZONS = [30, 90, 180] as const;
export type TrackHorizon = (typeof ALL_TRACK_HORIZONS)[number];
export const DEFAULT_TRACK_HORIZON: TrackHorizon = 90;
export const TRACK_BENCHMARK = "SPY";

const TABLES = ["track_decisions", "track_scores", "track_model", "track_coverage"];

export function hasTrackTables(db: Database.Database): boolean {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM sqlite_master
       WHERE type = 'table' AND name IN (${TABLES.map(() => "?").join(", ")})`
    )
    .get(...TABLES) as { n: number };
  return row.n === TABLES.length;
}

/** `?h=30` → 30; anything else → the default (90). */
export function parseTrackHorizon(raw: string | string[] | undefined, allowed: readonly number[] = TRACK_HORIZONS): TrackHorizon {
  const v = Number(Array.isArray(raw) ? raw[0] : raw);
  return (allowed.includes(v) ? v : DEFAULT_TRACK_HORIZON) as TrackHorizon;
}

export type ClockScore = {
  /** Unshrunk mean signed excess move (fraction: 0.042 = 4.2 points). */
  mean: number;
  /** The shrunk mean the ranking orders by. */
  score: number;
  /** 90% bootstrap interval of `score`; null below the minimum. */
  lo: number | null;
  hi: number | null;
  hit_rate: number;
  /** Share of same-date random portfolios the member's mean beats; null below the minimum. */
  luck: number | null;
};

export type TrackScoreRow = {
  member_name: string;
  bioguide_id: string | null;
  party: string | null;
  state: string | null;
  district: string | null;
  chamber: string | null;
  horizon: TrackHorizon;
  /** Decisions measured on both clocks at this horizon. */
  n: number;
  filings: number;
  min_decisions: number;
  /** Filings the decisions must be spread over to be ranked. */
  min_filings: number;
  qualifies: boolean;
  rank: number | null;
  trade: ClockScore;
  disclosure: ClockScore;
};

type RawScore = {
  member_name: string;
  bioguide_id: string | null;
  party: string | null;
  state: string | null;
  district: string | null;
  chamber: string | null;
  horizon: TrackHorizon;
  n: number;
  filings: number;
  min_decisions: number;
  min_filings: number;
  qualifies: number;
  rank: number | null;
  trade_mean: number;
  trade_score: number;
  trade_lo: number | null;
  trade_hi: number | null;
  trade_hit_rate: number;
  trade_luck: number | null;
  disclosure_mean: number;
  disclosure_score: number;
  disclosure_lo: number | null;
  disclosure_hi: number | null;
  disclosure_hit_rate: number;
  disclosure_luck: number | null;
};

const SCORE_SELECT = `
  SELECT s.member_name, p.bioguide_id, p.party, p.state, p.district, p.chamber,
         s.horizon, s.n, s.filings, s.min_decisions, s.min_filings, s.qualifies, s.rank,
         s.trade_mean, s.trade_score, s.trade_lo, s.trade_hi, s.trade_hit_rate, s.trade_luck,
         s.disclosure_mean, s.disclosure_score, s.disclosure_lo, s.disclosure_hi,
         s.disclosure_hit_rate, s.disclosure_luck
  FROM track_scores s
  LEFT JOIN politicians p ON p.id = s.politician_id`;

function toRow(r: RawScore): TrackScoreRow {
  const clock = (c: "trade" | "disclosure"): ClockScore => ({
    mean: r[`${c}_mean`],
    score: r[`${c}_score`],
    lo: r[`${c}_lo`],
    hi: r[`${c}_hi`],
    hit_rate: r[`${c}_hit_rate`],
    luck: r[`${c}_luck`],
  });
  return {
    member_name: r.member_name,
    bioguide_id: r.bioguide_id,
    party: r.party,
    state: r.state,
    district: r.district,
    chamber: r.chamber,
    horizon: r.horizon,
    n: r.n,
    filings: r.filings,
    min_decisions: r.min_decisions,
    min_filings: r.min_filings,
    qualifies: r.qualifies === 1,
    rank: r.rank,
    trade: clock("trade"),
    disclosure: clock("disclosure"),
  };
}

export type TrackModel = {
  clock: "trade" | "disclosure";
  horizon: TrackHorizon;
  /** Shrinkage strength: a member with k decisions is pulled halfway to zero. Null: no spread detected. */
  k: number | null;
  /** Unshrunk mean over every scored decision: the base rate. */
  mean: number | null;
  decisions: number;
  members: number;
  ranked: number;
  min_decisions: number;
  min_filings: number;
  computed_at: string;
};

export type TrackCoverageRow = { outcome: string; rows: number; decisions: number };

/** Plain-language names for the coverage outcomes (stats.TRACK_EXCLUSIONS). */
export const OUTCOME_LABEL: Record<string, string> = {
  included: "Measured or waiting for its horizon",
  series_ended: "… of which the price series ended before every horizon passed (delisted, acquired)",
  transcribed: "Transcribed from a scanned filing (kept out of every statistic)",
  exchange: "Exchanges (no buy or sell direction)",
  no_ticker: "No ticker (Treasuries, funds, private holdings …)",
  option: "Options (the payoff is not the stock's move)",
  non_equity: "Not a stock or ETF (bonds, funds, crypto, unlabelled)",
  date_as_filed: "Dates as filed are missing, contradictory or in the future",
  no_price_series: "No price series at the source (delisted, renamed, unlisted)",
};

export type TrackLeaderboard = {
  /** False until the committed database carries the track tables. */
  available: boolean;
  /** `sync_state.track_record_status`, in the audit's vocabulary. */
  status: string | null;
  horizon: TrackHorizon;
  computed_at: string | null;
  /** Trade-clock and disclosure-clock fits at this horizon. */
  model: { trade: TrackModel | null; disclosure: TrackModel | null };
  /** Members with at least the minimum, by rank. */
  ranked: TrackScoreRow[];
  /** Members below the minimum, most decisions first: never ranked. */
  unranked: TrackScoreRow[];
  min_decisions: number | null;
  min_filings: number | null;
  coverage: TrackCoverageRow[];
};

function status(db: Database.Database): string | null {
  const row = db.prepare("SELECT value FROM sync_state WHERE key = 'track_record_status'").get() as
    | { value: string | null }
    | undefined;
  return row?.value ?? null;
}

function models(db: Database.Database, horizon: TrackHorizon) {
  const rows = db
    .prepare(
      `SELECT clock, horizon, k, mean, decisions, members, ranked, min_decisions, min_filings, computed_at
       FROM track_model WHERE horizon = ?`
    )
    .all(horizon) as TrackModel[];
  return {
    trade: rows.find((m) => m.clock === "trade") ?? null,
    disclosure: rows.find((m) => m.clock === "disclosure") ?? null,
  };
}

export function readCoverage(db: Database.Database): TrackCoverageRow[] {
  const order = Object.keys(OUTCOME_LABEL);
  const rows = db.prepare("SELECT outcome, rows, decisions FROM track_coverage").all() as TrackCoverageRow[];
  return rows.sort((a, b) => order.indexOf(a.outcome) - order.indexOf(b.outcome));
}

/** The whole leaderboard at one horizon: every member, never a page slice. */
export async function getTrackLeaderboard(horizon: TrackHorizon = DEFAULT_TRACK_HORIZON): Promise<TrackLeaderboard> {
  const db = await getDb();
  if (!hasTrackTables(db)) {
    return {
      available: false,
      status: null,
      horizon,
      computed_at: null,
      model: { trade: null, disclosure: null },
      ranked: [],
      unranked: [],
      min_decisions: null,
      min_filings: null,
      coverage: [],
    };
  }
  const rows = (db.prepare(`${SCORE_SELECT} WHERE s.horizon = ?`).all(horizon) as RawScore[]).map(toRow);
  const model = models(db, horizon);
  return {
    available: true,
    status: status(db),
    horizon,
    computed_at: model.trade?.computed_at ?? null,
    model,
    ranked: rows.filter((r) => r.qualifies).sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0)),
    unranked: rows
      .filter((r) => !r.qualifies)
      .sort((a, b) => b.n - a.n || a.member_name.localeCompare(b.member_name)),
    min_decisions: model.trade?.min_decisions ?? rows[0]?.min_decisions ?? null,
    min_filings: model.trade?.min_filings ?? rows[0]?.min_filings ?? null,
    coverage: readCoverage(db),
  };
}

/** Coverage outcomes that are a subset of another row, not a separate share. */
export const COVERAGE_SUBSETS = new Set(["series_ended"]);

export type TrackDecisionRow = {
  /** `track_decisions.id`: unique per decision, the list key. */
  id: number;
  ticker: string;
  direction: "buy" | "sell";
  tx_date: string;
  filing_date: string | null;
  t0_trade: string;
  t0_disclosure: string;
  /** Signed excess move at the horizon on each clock (fraction). */
  trade: number;
  disclosure: number;
};

export type MemberTrack = {
  available: boolean;
  status: string | null;
  /** One row per horizon the member has any measured decision at. */
  scores: TrackScoreRow[];
  /** Ranked members per horizon, for "#3 of 36". */
  ranked_count: Partial<Record<TrackHorizon, number>>;
  min_decisions: number | null;
  /** The member's measured decisions at the default horizon, best first. */
  decisions: TrackDecisionRow[];
  /** Eligible decisions still waiting for the default horizon to pass. */
  pending: number;
  /** Eligible decisions whose price series ended before that horizon (delisted, acquired). */
  ended: number;
  /** The member's decisions that are excluded, by reason. */
  excluded: { outcome: string; decisions: number }[];
};

/** One member's track record: scores at every horizon and their decisions. */
export async function getMemberTrack(member: string, horizon: TrackHorizon = DEFAULT_TRACK_HORIZON): Promise<MemberTrack> {
  const db = await getDb();
  if (!hasTrackTables(db)) {
    return {
      available: false,
      status: null,
      scores: [],
      ranked_count: {},
      min_decisions: null,
      decisions: [],
      pending: 0,
      ended: 0,
      excluded: [],
    };
  }
  const scores = (db.prepare(`${SCORE_SELECT} WHERE s.member_name = ? ORDER BY s.horizon`).all(member) as RawScore[]).map(toRow);
  const ranked = db
    .prepare("SELECT horizon, ranked, min_decisions FROM track_model WHERE clock = 'trade'")
    .all() as { horizon: TrackHorizon; ranked: number; min_decisions: number }[];
  const decisions = db
    .prepare(
      `SELECT d.id, d.ticker, d.direction, d.tx_date, f.filing_date, d.t0_trade, d.t0_disclosure,
              d.signed_trade_${horizon} AS trade, d.signed_disclosure_${horizon} AS disclosure
       FROM track_decisions d JOIN filings f ON f.id = d.filing_id
       WHERE d.member_name = ? AND d.exclusion IS NULL
         AND d.signed_trade_${horizon} IS NOT NULL AND d.signed_disclosure_${horizon} IS NOT NULL
       ORDER BY trade DESC, d.tx_date, d.ticker, d.id`
    )
    .all(member) as TrackDecisionRow[];
  // Not measured at this horizon: still waiting, or never (the series ended).
  const unmeasured = db
    .prepare(
      `SELECT COUNT(*) FILTER (WHERE series_ended IS NULL) AS pending,
              COUNT(*) FILTER (WHERE series_ended IS NOT NULL) AS ended
       FROM track_decisions
       WHERE member_name = ? AND exclusion IS NULL
         AND (signed_trade_${horizon} IS NULL OR signed_disclosure_${horizon} IS NULL)`
    )
    .get(member) as { pending: number; ended: number };
  const excluded = db
    .prepare(
      `SELECT exclusion AS outcome, COUNT(*) AS decisions FROM track_decisions
       WHERE member_name = ? AND exclusion IS NOT NULL GROUP BY exclusion ORDER BY decisions DESC`
    )
    .all(member) as { outcome: string; decisions: number }[];
  return {
    available: true,
    status: status(db),
    scores,
    ranked_count: Object.fromEntries(ranked.map((r) => [r.horizon, r.ranked])),
    min_decisions: ranked[0]?.min_decisions ?? scores[0]?.min_decisions ?? null,
    decisions,
    pending: unmeasured.pending,
    ended: unmeasured.ended,
    excluded,
  };
}

/** Short names for a member's excluded decisions ("options (8)"). */
export const OUTCOME_SHORT: Record<string, string> = {
  transcribed: "transcribed from scans",
  option: "options",
  non_equity: "not a stock or ETF",
  date_as_filed: "contradictory dates",
  no_price_series: "no price series",
};

/** Why a member is not ranked yet, in words: "6 of 8 decisions · 1 of 3 filings". */
export function shortfall(r: Pick<TrackScoreRow, "n" | "filings" | "min_decisions" | "min_filings">): string {
  const parts = [];
  if (r.n < r.min_decisions) parts.push(`${r.n} of ${r.min_decisions} decisions`);
  if (r.filings < r.min_filings) parts.push(`${r.filings} of ${r.min_filings} filings`);
  return parts.join(" · ") || `${r.n} decisions`;
}

/**
 * Which state a member's track-record section is in. "computing" covers both
 * a database without the tables and a migrated one the pipeline has not
 * scored yet (no `track_model` rows, so no minimum): neither may read as
 * "0 of 0 decisions".
 */
export function memberTrackState(t: Pick<MemberTrack, "available" | "min_decisions" | "scores">): "computing" | "below" | "ranked" {
  if (!t.available || t.min_decisions == null) return "computing";
  const main = t.scores.find((s) => s.horizon === DEFAULT_TRACK_HORIZON);
  return main?.qualifies ? "ranked" : "below";
}

/**
 * The best- and worst-timed lists: best are the top `n` decisions that beat
 * SPY in the trade's direction, worst the bottom `n` that lagged it. Split by
 * sign, so no decision is in both and "worst-timed" never lists a decision
 * that came out ahead. `decisions` arrive sorted best first.
 */
export function bestAndWorst(decisions: TrackDecisionRow[], n = 5): { best: TrackDecisionRow[]; worst: TrackDecisionRow[] } {
  return {
    best: decisions.filter((d) => d.trade > 0).slice(0, n),
    worst: decisions
      .filter((d) => d.trade < 0)
      .slice(-n)
      .reverse(),
  };
}

/** A fraction as signed percentage points: +4.2, −1.0, 0.0. */
export function points(v: number | null | undefined, digits = 1): string {
  if (v == null) return "—";
  const p = v * 100;
  const rounded = Number(p.toFixed(digits));
  const sign = rounded > 0 ? "+" : rounded < 0 ? "−" : "";
  return `${sign}${Math.abs(rounded).toFixed(digits)}`;
}

/** A 0–1 share as a whole percentage. */
export function percent(v: number | null | undefined): string {
  return v == null ? "—" : `${Math.round(v * 100)}%`;
}
