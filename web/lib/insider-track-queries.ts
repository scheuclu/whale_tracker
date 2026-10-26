import type Database from "better-sqlite3";
import { getDb } from "./db";
import { DEFAULT_TRACK_HORIZON, type ClockScore, type TrackHorizon, type TrackModel } from "./track-queries";

/**
 * Insider track record — `insider_track_decisions`, `insider_track_scores`,
 * `insider_track_model`, `insider_track_coverage` (src/whale/db.py, schema 17).
 *
 * The congressional measurement for Form 4 filers: for each decision
 * (primary reporting owner, ticker, direction, Form 4) the stock's move after
 * it minus SPY's over the same trading days, read the way the trade pointed,
 * from the trade date and from the filing. Derived once in Python
 * (`track.sync(population=INSIDERS)`), only read here, and never one ranking
 * with the members': two populations, two leaderboards (CLAUDE.md, "Track
 * record" → "Insiders later"). A stock's move, not anyone's profit — an
 * insider's own company, traded under the 10b5-1 plans and windows their
 * employer sets, so a "good" record is not evidence of anything.
 */

const TABLES = ["insider_track_decisions", "insider_track_scores", "insider_track_model", "insider_track_coverage"];

export function hasInsiderTrackTables(db: Database.Database): boolean {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN (${TABLES.map(() => "?").join(", ")})`
    )
    .get(...TABLES) as { n: number };
  return row.n === TABLES.length;
}

export type InsiderTrackScoreRow = {
  cik: string;
  name: string | null;
  horizon: TrackHorizon;
  n: number;
  filings: number;
  min_decisions: number;
  min_filings: number;
  qualifies: boolean;
  rank: number | null;
  trade: ClockScore;
  disclosure: ClockScore;
  /** The issuer of the insider's most recent filing, for context in a list. */
  latest_ticker: string | null;
  latest_issuer: string | null;
};

type Raw = Record<string, number | string | null> & { owner_cik: string; qualifies: number };

const SELECT = `
  SELECT s.*, i.name,
         (SELECT y.ticker FROM insider_filing_owners x JOIN insider_filings y ON y.id = x.filing_id
          WHERE x.insider_cik = s.owner_cik AND x.owner_index = 0 ORDER BY y.filing_date DESC LIMIT 1) AS latest_ticker,
         (SELECT y.issuer_name FROM insider_filing_owners x JOIN insider_filings y ON y.id = x.filing_id
          WHERE x.insider_cik = s.owner_cik AND x.owner_index = 0 ORDER BY y.filing_date DESC LIMIT 1) AS latest_issuer
  FROM insider_track_scores s
  LEFT JOIN insiders i ON i.cik = s.owner_cik`;

function toRow(r: Raw): InsiderTrackScoreRow {
  const clock = (c: "trade" | "disclosure"): ClockScore => ({
    mean: r[`${c}_mean`] as number,
    score: r[`${c}_score`] as number,
    lo: r[`${c}_lo`] as number | null,
    hi: r[`${c}_hi`] as number | null,
    hit_rate: r[`${c}_hit_rate`] as number,
    luck: r[`${c}_luck`] as number | null,
  });
  return {
    cik: r.owner_cik,
    name: (r.name as string | null) ?? null,
    horizon: r.horizon as TrackHorizon,
    n: r.n as number,
    filings: r.filings as number,
    min_decisions: r.min_decisions as number,
    min_filings: r.min_filings as number,
    qualifies: r.qualifies === 1,
    rank: (r.rank as number | null) ?? null,
    trade: clock("trade"),
    disclosure: clock("disclosure"),
    latest_ticker: (r.latest_ticker as string | null) ?? null,
    latest_issuer: (r.latest_issuer as string | null) ?? null,
  };
}

function models(db: Database.Database, horizon: TrackHorizon) {
  const rows = db
    .prepare(
      `SELECT clock, horizon, k, mean, decisions, members, ranked, min_decisions, min_filings, computed_at
       FROM insider_track_model WHERE horizon = ?`
    )
    .all(horizon) as TrackModel[];
  return {
    trade: rows.find((m) => m.clock === "trade") ?? null,
    disclosure: rows.find((m) => m.clock === "disclosure") ?? null,
  };
}

function status(db: Database.Database): string | null {
  const row = db.prepare("SELECT value FROM sync_state WHERE key = 'insider_track_record_status'").get() as
    | { value: string | null }
    | undefined;
  return row?.value ?? null;
}

export type InsiderTrackLeaderboard = {
  /** False until the committed database carries the tables. */
  available: boolean;
  status: string | null;
  horizon: TrackHorizon;
  computed_at: string | null;
  model: { trade: TrackModel | null; disclosure: TrackModel | null };
  ranked: InsiderTrackScoreRow[];
  /** Insiders measured but below the minimum: counted, never ranked. */
  unranked: number;
  min_decisions: number | null;
  min_filings: number | null;
  /** The oldest stored Form 4's filing date: how far back the history reaches. */
  history_from: string | null;
};

function historyFrom(db: Database.Database): string | null {
  const row = db.prepare("SELECT MIN(filing_date) AS d FROM insider_filings").get() as { d: string | null } | undefined;
  return row?.d ?? null;
}

export async function getInsiderTrackLeaderboard(
  horizon: TrackHorizon = DEFAULT_TRACK_HORIZON
): Promise<InsiderTrackLeaderboard> {
  const db = await getDb();
  if (!hasInsiderTrackTables(db)) {
    return {
      available: false,
      status: null,
      horizon,
      computed_at: null,
      model: { trade: null, disclosure: null },
      ranked: [],
      unranked: 0,
      min_decisions: null,
      min_filings: null,
      history_from: null,
    };
  }
  const rows = (db.prepare(`${SELECT} WHERE s.horizon = ?`).all(horizon) as Raw[]).map(toRow);
  const model = models(db, horizon);
  return {
    available: true,
    status: status(db),
    horizon,
    computed_at: model.trade?.computed_at ?? null,
    model,
    ranked: rows.filter((r) => r.qualifies).sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0)),
    unranked: rows.filter((r) => !r.qualifies).length,
    min_decisions: model.trade?.min_decisions ?? rows[0]?.min_decisions ?? null,
    min_filings: model.trade?.min_filings ?? rows[0]?.min_filings ?? null,
    history_from: historyFrom(db),
  };
}

export type InsiderTrack = {
  available: boolean;
  /** One row per horizon the insider has a measured decision at. */
  scores: InsiderTrackScoreRow[];
  /** Ranked insiders per horizon, for "#3 of 40". */
  ranked_count: Partial<Record<TrackHorizon, number>>;
  min_decisions: number | null;
  min_filings: number | null;
};

/** One insider's track record at every horizon. */
export async function getInsiderTrack(cik: string): Promise<InsiderTrack> {
  const db = await getDb();
  if (!hasInsiderTrackTables(db)) {
    return { available: false, scores: [], ranked_count: {}, min_decisions: null, min_filings: null };
  }
  const scores = (db.prepare(`${SELECT} WHERE s.owner_cik = ? ORDER BY s.horizon`).all(cik) as Raw[]).map(toRow);
  const ranked = db
    .prepare("SELECT horizon, ranked, min_decisions, min_filings FROM insider_track_model WHERE clock = 'trade'")
    .all() as { horizon: TrackHorizon; ranked: number; min_decisions: number; min_filings: number }[];
  return {
    available: true,
    scores,
    ranked_count: Object.fromEntries(ranked.map((r) => [r.horizon, r.ranked])),
    min_decisions: ranked[0]?.min_decisions ?? null,
    min_filings: ranked[0]?.min_filings ?? null,
  };
}
