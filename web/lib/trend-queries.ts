import { getDb } from "./db";
import { CLUSTER_TYPES, COUNTED, DELAY, TRANSCRIBED } from "./queries";
import { MONTH_KEY, dense, monthKeys, monthStart, previousMonth } from "./months";

/**
 * Monthly series behind /trends.
 *
 * Every congressional series is bucketed on TRADE date, like every rolling
 * window on the site — so the newest buckets are incomplete by construction.
 * A member has 45 days to file, and in this corpus the median filing lands
 * about 17 days after the trade, the 90th percentile about 33: a month keeps
 * filling for roughly two months after it ends. The page says so in its
 * footnote; nothing here extrapolates or hides the short bars.
 *
 * Buckets are bounded at today, like `sinceClause`: a handful of filings
 * carry a mistyped future trade date, which would otherwise open a bucket of
 * its own. The window's lower bound keeps the decade-old trades that some
 * 2026 filings disclose (one batch is from 2016) from stretching the axis.
 *
 * Congressional amounts are never summed here. They are brackets, so a
 * monthly dollar series would be a column of estimates; these series count
 * rows and members instead. The insider series does sum, because Form 4
 * values are exact — see `getInsiderMonthly` in insider-queries.ts.
 */

/** How the member leaderboard identifies a member: the roster name, or the
 *  name printed on the PDF when the roster match failed. */
const MEMBER = `COALESCE(p.full_name, f.filer_name)`;

const MONTH = `substr(t.tx_date, 1, 7)`;

/** Both ends of the window: the first day of the oldest month, and today. */
const IN_WINDOW = `t.tx_date >= ? AND t.tx_date <= date('now')`;

export type MonthlyTrades = {
  month: string;
  /** Every counted row, including exchanges and rows transcribed from scans. */
  trades: number;
  buys: number;
  sells: number;
  buy_d: number;
  buy_r: number;
  /** Independents, third parties, and filings the roster could not match. */
  buy_other: number;
  sell_d: number;
  sell_r: number;
  sell_other: number;
  transcribed: number;
};

const ZERO_TRADES = (month: string): MonthlyTrades => ({
  month,
  trades: 0,
  buys: 0,
  sells: 0,
  buy_d: 0,
  buy_r: 0,
  buy_other: 0,
  sell_d: 0,
  sell_r: 0,
  sell_other: 0,
  transcribed: 0,
});

/** Trades per month by direction, each direction split by party. */
export async function getMonthlyTrades(months = 12): Promise<MonthlyTrades[]> {
  const keys = monthKeys(months);
  const db = await getDb();
  const buy = `t.action = 'purchase'`;
  const sell = `t.action IN ('sale','sale_partial')`;
  const other = `(p.party IS NULL OR p.party NOT IN ('D','R'))`;
  const rows = db
    .prepare(
      `SELECT ${MONTH} AS month,
              COUNT(*) AS trades,
              SUM(${buy}) AS buys,
              SUM(${sell}) AS sells,
              SUM(${buy} AND p.party = 'D') AS buy_d,
              SUM(${buy} AND p.party = 'R') AS buy_r,
              SUM(${buy} AND ${other}) AS buy_other,
              SUM(${sell} AND p.party = 'D') AS sell_d,
              SUM(${sell} AND p.party = 'R') AS sell_r,
              SUM(${sell} AND ${other}) AS sell_other,
              SUM(${TRANSCRIBED}) AS transcribed
       FROM transactions t
       JOIN filings f ON f.id = t.filing_id
       LEFT JOIN politicians p ON p.id = t.politician_id
       WHERE f.status IN ${COUNTED} AND ${IN_WINDOW}
       GROUP BY month
       ORDER BY month`
    )
    .all(monthStart(keys[0])) as MonthlyTrades[];
  return dense(keys, rows, ZERO_TRADES);
}

export type MonthlyDelay = {
  month: string;
  /** Trades whose delay could be measured: NULL delays (contradictory dates) are left out. */
  n: number;
  median: number | null;
  p90: number | null;
  /** Trades disclosed more than 45 days after the trade. */
  late: number;
};

export type DelaySeries = {
  months: MonthlyDelay[];
  /** The same quantiles over every trade in the window — the footnote's numbers. */
  overall: { n: number; median: number | null; p90: number | null };
};

/**
 * Median and 90th-percentile disclosure delay per month of trade date.
 *
 * `DELAY` is the shared definition (trade date → the report reaching the
 * Clerk, NULL when the dates contradict); this only adds the quantiles.
 * SQLite has no percentile function, so they are read off a per-month
 * ranking: the median is the mean of the two middle ranks (what Python's
 * `statistics.median` returns), and p90 is the nearest-rank percentile,
 * the value at rank ceil(0.9·n). Neither interpolates — an interpolated
 * p90 of a 7-trade month would be a number no filing actually took.
 */
export async function getMonthlyDelay(months = 12): Promise<DelaySeries> {
  const keys = monthKeys(months);
  const db = await getDb();
  const quantiles = (partition: string) => `
    WITH d AS (
      SELECT ${MONTH} AS month, ${DELAY} AS delay
      FROM transactions t
      JOIN filings f ON f.id = t.filing_id
      WHERE f.status IN ${COUNTED} AND ${IN_WINDOW}
    ), r AS (
      SELECT month, delay,
             ROW_NUMBER() OVER (PARTITION BY ${partition} ORDER BY delay) AS rn,
             COUNT(*) OVER (PARTITION BY ${partition}) AS n
      FROM d WHERE delay IS NOT NULL
    )
    SELECT ${partition} AS month,
           MAX(n) AS n,
           AVG(CASE WHEN rn IN ((n + 1) / 2, (n + 2) / 2) THEN delay END) AS median,
           MAX(CASE WHEN rn = (9 * n + 9) / 10 THEN delay END) AS p90,
           SUM(delay > 45) AS late
    FROM r
    GROUP BY ${partition}
    ORDER BY month`;
  const start = monthStart(keys[0]);
  const rows = db.prepare(quantiles("month")).all(start) as MonthlyDelay[];
  const overall = (db.prepare(quantiles("1")).get(start) as MonthlyDelay | undefined) ?? {
    n: 0,
    median: null,
    p90: null,
  };
  return {
    months: dense(keys, rows, (month) => ({ month, n: 0, median: null, p90: null, late: 0 })),
    overall: { n: overall.n, median: overall.median, p90: overall.p90 },
  };
}

export type RisingTicker = {
  ticker: string;
  asset_name: string | null;
  /** Distinct members trading the ticker in the month, and in the month before. */
  members: number;
  prev_members: number;
  buy_members: number;
  sell_members: number;
  trades: number;
  gain: number;
};

/**
 * Tickers that gained members month over month: distinct members trading
 * them in `month` against the month before, equity-like assets only (the
 * consensus view's filter — members roll Treasury bills constantly). A
 * ticker nobody traded last month and three members traded this month is a
 * gain of three.
 */
export async function getRisingTickers(month: string, limit = 10): Promise<RisingTicker[]> {
  if (!MONTH_KEY.test(month)) return [];
  const prev = previousMonth(month);
  const db = await getDb();
  const inMonth = `${MONTH} = ?`;
  return db
    .prepare(
      `WITH m AS (
         SELECT t.ticker,
                MIN(t.asset_name) AS asset_name,
                COUNT(DISTINCT CASE WHEN ${inMonth} THEN ${MEMBER} END) AS members,
                COUNT(DISTINCT CASE WHEN ${inMonth} THEN ${MEMBER} END) AS prev_members,
                COUNT(DISTINCT CASE WHEN ${inMonth} AND t.action = 'purchase' THEN ${MEMBER} END) AS buy_members,
                COUNT(DISTINCT CASE WHEN ${inMonth} AND t.action IN ('sale','sale_partial') THEN ${MEMBER} END) AS sell_members,
                SUM(${inMonth}) AS trades
         FROM transactions t
         JOIN filings f ON f.id = t.filing_id
         LEFT JOIN politicians p ON p.id = t.politician_id
         WHERE f.status IN ${COUNTED}
           AND t.ticker IS NOT NULL AND t.ticker != ''
           AND t.asset_type IN ${CLUSTER_TYPES}
           AND ${MONTH} IN (?, ?)
         GROUP BY t.ticker
       )
       SELECT *, members - prev_members AS gain
       FROM m
       WHERE members > prev_members
       ORDER BY gain DESC, members DESC, ticker
       LIMIT ?`
    )
    .all(month, prev, month, month, month, month, prev, limit) as RisingTicker[];
}

export type MonthlyScans = {
  month: string;
  /** Paper filings in either chamber: House scans and Senate paper reports. */
  scans: number;
  /** Read by a vision model; their rows are in the trade counts, in no total. */
  transcribed: number;
  /** The transcription path refused them (grid not found, readings disagree). */
  refused: number;
  /** Never sent to a model: `vision.enabled` is off, or the Senate paper path. */
  unread: number;
  rows_transcribed: number;
};

/**
 * Paper filings per month, by FILING date — a scan has no trade dates until
 * it has been transcribed, so the filing date is the only one every scan
 * carries. Same definition of "scan" as the Pipeline page, plus the Senate's
 * paper reports.
 */
export async function getMonthlyScans(months = 12): Promise<MonthlyScans[]> {
  const keys = monthKeys(months);
  const db = await getDb();
  const rows = db
    .prepare(
      `SELECT substr(f.filing_date, 1, 7) AS month,
              COUNT(*) AS scans,
              SUM(f.parse_method = 'vision') AS transcribed,
              SUM(f.parse_method = 'vision_failed') AS refused,
              SUM(f.parse_method IN ('scanned', 'efd_paper')) AS unread,
              COALESCE(SUM(CASE WHEN f.parse_method = 'vision'
                           THEN (SELECT COUNT(*) FROM transactions t WHERE t.filing_id = f.id) END), 0)
                AS rows_transcribed
       FROM filings f
       WHERE f.parse_method IN ('scanned', 'vision', 'vision_failed', 'efd_paper')
         AND f.filing_date >= ? AND f.filing_date <= date('now')
       GROUP BY month
       ORDER BY month`
    )
    .all(monthStart(keys[0])) as MonthlyScans[];
  return dense(keys, rows, (month) => ({
    month,
    scans: 0,
    transcribed: 0,
    refused: 0,
    unread: 0,
    rows_transcribed: 0,
  }));
}
