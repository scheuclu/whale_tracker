import { getDb } from "./db";

/**
 * Statuses whose transactions are real, parsed data. Mirrors
 * `COUNTED_STATUSES` in src/whale/db.py — a filing that failed to parse must
 * never contribute to a volume total.
 */
export const COUNTED = `('parsed','notified','backfilled')`;

/** Asset types eligible for the "conviction" views; mirrors config.yaml. */
const CLUSTER_TYPES = `('ST','OP','EF','ET','CT','RS','SA')`;

export type Direction = "buy" | "sell" | "flat";

export type TickerRow = {
  ticker: string;
  asset_name: string | null;
  politicians: number;
  buy_politicians: number;
  sell_politicians: number;
  trades: number;
  buys: number;
  sells: number;
  volume_min: number;
  volume_max: number | null;
  volume_mid: number;
  /** Rows transcribed from scans: in `trades`, not in any volume. */
  transcribed: number;
  last_tx_date: string | null;
};

export type TransactionRow = {
  id: number;
  tx_date: string | null;
  notification_date: string | null;
  action: string;
  ticker: string | null;
  asset_name: string;
  asset_type: string | null;
  owner: string | null;
  amount_min_cents: number | null;
  amount_max_cents: number | null;
  amount_exact_cents: number | null;
  member_name: string;
  party: string | null;
  state: string | null;
  district: string | null;
  chamber: string | null;
  pdf_url: string;
  filing_date: string | null;
  delay_days: number | null;
  /** Days until the member was notified — not a compliance measure. */
  lag_days: number | null;
  /** 1 when the filing's own trade/notification dates contradict each other. */
  dates_inconsistent: number;
  /** 1 when the row was transcribed from a scanned paper filing: shown with
   *  its bracket as read, counted as a trade, excluded from every total. */
  transcribed: number;
};

export type PoliticianRow = {
  member_name: string;
  party: string | null;
  state: string | null;
  district: string | null;
  chamber: string | null;
  trades: number;
  tickers: number;
  buys: number;
  sells: number;
  volume_mid: number;
  /** Rows transcribed from scans: in `trades`, not in `volume_mid`. */
  transcribed: number;
  avg_delay: number | null;
  avg_lag: number | null;
  late_count: number;
};

/**
 * Rolling window on trade date. Bounded at both ends: a handful of filings
 * carry a mistyped future trade date, which would otherwise sit inside "the
 * last 30 days" forever.
 */
export function sinceClause(days?: number): string {
  return days
    ? `AND t.tx_date >= date('now', '-${Math.floor(days)} day') AND t.tx_date <= date('now')`
    : "";
}

/**
 * Days from trade to disclosure — the STOCK Act's 45-day clock. Measured to
 * the date the report reached the Clerk, NOT the report's "Notification Date"
 * column: a member trading their own account is notified the same day, so
 * that column reads zero however long the filing actually took.
 *
 * NULL when the dates contradict each other; reporting "-339 days" would
 * present a filer's typo as a fact. Mirrors `disclosure_delay_days` in
 * src/whale/stats.py — keep the two in agreement.
 */
export const DELAY = `CASE WHEN julianday(f.filing_date) >= julianday(t.tx_date)
     THEN CAST(julianday(f.filing_date) - julianday(t.tx_date) AS INTEGER) END`;

/** Days until the member learned of the trade. Not a compliance measure. */
const LAG = `CASE WHEN julianday(t.notification_date) >= julianday(t.tx_date)
     THEN CAST(julianday(t.notification_date) - julianday(t.tx_date) AS INTEGER) END`;

/**
 * Rows read by transcribing a scanned paper filing (`filings.parse_method`
 * is 'vision'). They count as trades and toward member and ticker lists, but
 * contribute nothing to any volume sum: the amount is a checkbox read off a
 * scan, not a bracket parsed from a filed text layer. Mirrors
 * `counts_toward_volume` in src/whale/stats.py — keep the two in agreement.
 * Every query here joins `filings f`, which is what makes this a row test.
 */
export const TRANSCRIBED = `COALESCE(f.parse_method, '') = 'vision'`;

/** The row's disclosed floor, ceiling and exact figure — NULL when the row
 *  is transcribed and may not enter a total. */
const VOL_MIN = `CASE WHEN ${TRANSCRIBED} THEN NULL ELSE t.amount_min_cents END`;
const VOL_MAX = `CASE WHEN ${TRANSCRIBED} THEN NULL ELSE t.amount_max_cents END`;
const VOL_EXACT = `CASE WHEN ${TRANSCRIBED} THEN NULL ELSE t.amount_exact_cents END`;

/** A counted row in the open-ended top bracket: it makes the total's upper
 *  bound unknowable. A transcribed row never does — it is not in the total. */
const OPEN_ENDED = `(NOT ${TRANSCRIBED} AND t.amount_max_cents IS NULL AND t.amount_exact_cents IS NULL)`;

/** SUM of the disclosed ceilings, or NULL once any row is open-ended. */
const VOLUME_MAX = `CASE WHEN SUM(${OPEN_ENDED}) > 0 THEN NULL
       ELSE SUM(COALESCE(${VOL_MAX}, ${VOL_EXACT}, 0)) END`;

/**
 * Amount contribution of a row, in cents.
 *
 * Disclosures give brackets, so `mid` is the bracket midpoint — an estimate,
 * never a reported figure. Rows in the open-ended top bracket
 * (max IS NULL) contribute their floor to `mid` and force the range's upper
 * bound to be reported as unbounded. A transcribed row contributes nothing.
 */
export const MID = `CASE WHEN ${TRANSCRIBED} THEN NULL ELSE COALESCE(t.amount_exact_cents,
  CASE WHEN t.amount_max_cents IS NULL THEN t.amount_min_cents
       ELSE (t.amount_min_cents + t.amount_max_cents) / 2 END) END`;

export async function getTickers(days?: number, limit = 40): Promise<TickerRow[]> {
  const db = await getDb();
  return db
    .prepare(
      `SELECT t.ticker,
              MIN(t.asset_name) AS asset_name,
              COUNT(DISTINCT t.politician_id) AS politicians,
              COUNT(DISTINCT CASE WHEN t.action='purchase' THEN t.politician_id END) AS buy_politicians,
              COUNT(DISTINCT CASE WHEN t.action IN ('sale','sale_partial') THEN t.politician_id END) AS sell_politicians,
              COUNT(*) AS trades,
              SUM(t.action='purchase') AS buys,
              SUM(t.action IN ('sale','sale_partial')) AS sells,
              SUM(COALESCE(${VOL_MIN},0)) AS volume_min,
              ${VOLUME_MAX} AS volume_max,
              SUM(COALESCE(${MID},0)) AS volume_mid,
              SUM(${TRANSCRIBED}) AS transcribed,
              MAX(t.tx_date) AS last_tx_date
       FROM transactions t
       JOIN filings f ON f.id = t.filing_id
       WHERE f.status IN ${COUNTED} AND t.ticker IS NOT NULL AND t.ticker != ''
       ${sinceClause(days)}
       GROUP BY t.ticker
       ORDER BY volume_mid DESC
       LIMIT ?`
    )
    .all(limit) as TickerRow[];
}

/** Tickers ranked by how many distinct members traded them — the consensus view. */
export async function getConsensusTickers(days = 90, limit = 12): Promise<TickerRow[]> {
  const db = await getDb();
  return db
    .prepare(
      `SELECT t.ticker,
              MIN(t.asset_name) AS asset_name,
              COUNT(DISTINCT t.politician_id) AS politicians,
              COUNT(DISTINCT CASE WHEN t.action='purchase' THEN t.politician_id END) AS buy_politicians,
              COUNT(DISTINCT CASE WHEN t.action IN ('sale','sale_partial') THEN t.politician_id END) AS sell_politicians,
              COUNT(*) AS trades,
              SUM(t.action='purchase') AS buys,
              SUM(t.action IN ('sale','sale_partial')) AS sells,
              SUM(COALESCE(${VOL_MIN},0)) AS volume_min,
              NULL AS volume_max,
              SUM(COALESCE(${MID},0)) AS volume_mid,
              SUM(${TRANSCRIBED}) AS transcribed,
              MAX(t.tx_date) AS last_tx_date
       FROM transactions t
       JOIN filings f ON f.id = t.filing_id
       WHERE f.status IN ${COUNTED} AND t.ticker IS NOT NULL AND t.ticker != ''
         AND t.asset_type IN ${CLUSTER_TYPES}
         ${sinceClause(days)}
       GROUP BY t.ticker
       ORDER BY politicians DESC, volume_mid DESC
       LIMIT ?`
    )
    .all(limit) as TickerRow[];
}

export async function getTransactions(opts: {
  ticker?: string;
  member?: string;
  action?: string;
  limit?: number;
} = {}): Promise<TransactionRow[]> {
  const db = await getDb();
  const where: string[] = [`f.status IN ${COUNTED}`];
  const params: unknown[] = [];
  if (opts.ticker) {
    where.push("t.ticker = ?");
    params.push(opts.ticker.toUpperCase());
  }
  if (opts.member) {
    where.push("COALESCE(p.full_name, f.filer_name) = ?");
    params.push(opts.member);
  }
  if (opts.action === "buy") where.push("t.action = 'purchase'");
  if (opts.action === "sell") where.push("t.action IN ('sale','sale_partial')");
  params.push(opts.limit ?? 100);

  return db
    .prepare(
      `SELECT t.id, t.tx_date, t.notification_date, t.action, t.ticker, t.asset_name,
              t.asset_type, t.owner, t.amount_min_cents, t.amount_max_cents,
              t.amount_exact_cents,
              COALESCE(p.full_name, f.filer_name) AS member_name,
              p.party, p.state, p.district, p.chamber,
              f.pdf_url, f.filing_date,
              ${DELAY} AS delay_days,
              ${LAG} AS lag_days,
              CASE WHEN julianday(t.notification_date) < julianday(t.tx_date)
                   THEN 1 ELSE 0 END AS dates_inconsistent,
              ${TRANSCRIBED} AS transcribed
       FROM transactions t
       JOIN filings f ON f.id = t.filing_id
       LEFT JOIN politicians p ON p.id = t.politician_id
       WHERE ${where.join(" AND ")}
       ORDER BY t.tx_date DESC, t.id DESC
       LIMIT ?`
    )
    .all(...params) as TransactionRow[];
}

export async function getPoliticians(days?: number, limit = 60): Promise<PoliticianRow[]> {
  const db = await getDb();
  return db
    .prepare(
      `SELECT COALESCE(p.full_name, f.filer_name) AS member_name,
              p.party, p.state, p.district, p.chamber,
              COUNT(*) AS trades,
              COUNT(DISTINCT t.ticker) AS tickers,
              SUM(t.action='purchase') AS buys,
              SUM(t.action IN ('sale','sale_partial')) AS sells,
              SUM(COALESCE(${MID},0)) AS volume_mid,
              SUM(${TRANSCRIBED}) AS transcribed,
              AVG(${DELAY}) AS avg_delay,
              AVG(${LAG}) AS avg_lag,
              SUM(CASE WHEN ${DELAY} > 45 THEN 1 ELSE 0 END) AS late_count
       FROM transactions t
       JOIN filings f ON f.id = t.filing_id
       LEFT JOIN politicians p ON p.id = t.politician_id
       WHERE f.status IN ${COUNTED} ${sinceClause(days)}
       GROUP BY member_name
       ORDER BY volume_mid DESC
       LIMIT ?`
    )
    .all(limit) as PoliticianRow[];
}

export type PoliticianTotals = {
  members: number;
  volume_mid: number;
  late_trades: number;
  members_late: number;
  /** Rows transcribed from scans across every member: not in `volume_mid`. */
  transcribed: number;
};

/**
 * Headline figures across every member, not just the page's top rows —
 * summing a truncated list would understate the totals it claims to report.
 */
export async function getPoliticianTotals(): Promise<PoliticianTotals> {
  const db = await getDb();
  return db
    .prepare(
      `WITH per_member AS (
         SELECT COALESCE(p.full_name, f.filer_name) AS member_name,
                SUM(COALESCE(${MID},0)) AS volume_mid,
                SUM(${TRANSCRIBED}) AS transcribed,
                SUM(CASE WHEN ${DELAY} > 45 THEN 1 ELSE 0 END) AS late_count
         FROM transactions t
         JOIN filings f ON f.id = t.filing_id
         LEFT JOIN politicians p ON p.id = t.politician_id
         WHERE f.status IN ${COUNTED}
         GROUP BY member_name
       )
       SELECT COUNT(*) AS members,
              COALESCE(SUM(volume_mid),0) AS volume_mid,
              COALESCE(SUM(late_count),0) AS late_trades,
              SUM(CASE WHEN late_count > 0 THEN 1 ELSE 0 END) AS members_late,
              COALESCE(SUM(transcribed),0) AS transcribed
       FROM per_member`
    )
    .get() as PoliticianTotals;
}

export type PoliticianDetail = PoliticianRow & {
  bioguide_id: string | null;
  filings: number;
  volume_min: number;
  /** NULL when any trade sits in the open-ended top bracket. */
  volume_max: number | null;
  first_tx_date: string | null;
  last_tx_date: string | null;
};

/**
 * One member's whole record, aggregated over every counted trade — never
 * the slice a page renders. Keyed on the display name because that is how
 * `getPoliticians` groups: an unmatched filing has no roster row, only the
 * name printed on the PDF.
 */
export async function getPoliticianDetail(member: string): Promise<PoliticianDetail | null> {
  const db = await getDb();
  const row = db
    .prepare(
      `SELECT COALESCE(p.full_name, f.filer_name) AS member_name,
              p.bioguide_id, p.party, p.state, p.district, p.chamber,
              COUNT(*) AS trades,
              COUNT(DISTINCT f.id) AS filings,
              COUNT(DISTINCT t.ticker) AS tickers,
              SUM(t.action='purchase') AS buys,
              SUM(t.action IN ('sale','sale_partial')) AS sells,
              SUM(COALESCE(${VOL_MIN},0)) AS volume_min,
              ${VOLUME_MAX} AS volume_max,
              SUM(COALESCE(${MID},0)) AS volume_mid,
              SUM(${TRANSCRIBED}) AS transcribed,
              AVG(${DELAY}) AS avg_delay,
              AVG(${LAG}) AS avg_lag,
              SUM(CASE WHEN ${DELAY} > 45 THEN 1 ELSE 0 END) AS late_count,
              MIN(t.tx_date) AS first_tx_date,
              MAX(t.tx_date) AS last_tx_date
       FROM transactions t
       JOIN filings f ON f.id = t.filing_id
       LEFT JOIN politicians p ON p.id = t.politician_id
       WHERE f.status IN ${COUNTED} AND COALESCE(p.full_name, f.filer_name) = ?
       GROUP BY member_name`
    )
    .get(member) as PoliticianDetail | undefined;
  return row ?? null;
}

export type PoliticianTickerRow = {
  ticker: string;
  asset_name: string | null;
  trades: number;
  buys: number;
  sells: number;
  volume_mid: number;
  transcribed: number;
  last_tx_date: string | null;
};

/** The tickers one member traded, by estimated volume. Assets with no ticker
 *  (Treasuries, funds) are left to the trade list, where the type is shown. */
export async function getPoliticianTickers(member: string, limit = 40): Promise<PoliticianTickerRow[]> {
  const db = await getDb();
  return db
    .prepare(
      `SELECT t.ticker,
              MIN(t.asset_name) AS asset_name,
              COUNT(*) AS trades,
              SUM(t.action='purchase') AS buys,
              SUM(t.action IN ('sale','sale_partial')) AS sells,
              SUM(COALESCE(${MID},0)) AS volume_mid,
              SUM(${TRANSCRIBED}) AS transcribed,
              MAX(t.tx_date) AS last_tx_date
       FROM transactions t
       JOIN filings f ON f.id = t.filing_id
       LEFT JOIN politicians p ON p.id = t.politician_id
       WHERE f.status IN ${COUNTED} AND COALESCE(p.full_name, f.filer_name) = ?
         AND t.ticker IS NOT NULL AND t.ticker != ''
       GROUP BY t.ticker
       ORDER BY volume_mid DESC, trades DESC
       LIMIT ?`
    )
    .all(member, limit) as PoliticianTickerRow[];
}

export async function getTickerDetail(ticker: string) {
  const rows = await getTickers(undefined, 5000);
  return rows.find((r) => r.ticker === ticker.toUpperCase()) ?? null;
}

export type Pipeline = {
  byStatus: { chamber: string; status: string; n: number }[];
  byMethod: { parse_method: string; n: number }[];
  totals: { transactions: number; tickers: number; members: number; filings: number };
  senateStatus: string | null;
  lastUpdated: string | null;
  failures: { doc_id: string; filer_name: string; last_error: string | null; pdf_url: string }[];
  coverage: { parsed: number; unreadable: number };
  /** Filings and rows read by transcribing a scan: counted as trades, in no
   *  total. Zero of each while `vision.enabled` is off. */
  transcribed: { filings: number; rows: number };
};

export async function getPipeline(): Promise<Pipeline> {
  const db = await getDb();
  const byStatus = db
    .prepare("SELECT chamber, status, COUNT(*) AS n FROM filings GROUP BY chamber, status ORDER BY n DESC")
    .all() as Pipeline["byStatus"];
  const byMethod = db
    .prepare(
      "SELECT parse_method, COUNT(*) AS n FROM filings WHERE parse_method IS NOT NULL GROUP BY parse_method ORDER BY n DESC"
    )
    .all() as Pipeline["byMethod"];
  const totals = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM transactions) AS transactions,
              (SELECT COUNT(DISTINCT ticker) FROM transactions WHERE ticker IS NOT NULL) AS tickers,
              (SELECT COUNT(DISTINCT politician_id) FROM transactions) AS members,
              (SELECT COUNT(*) FROM filings) AS filings`
    )
    .get() as Pipeline["totals"];
  const senate = db.prepare("SELECT value FROM sync_state WHERE key = 'senate_status'").get() as
    | { value: string }
    | undefined;
  const last = db.prepare("SELECT MAX(updated_at) AS t FROM filings").get() as { t: string | null };
  const failures = db
    .prepare(
      "SELECT doc_id, filer_name, last_error, pdf_url FROM filings WHERE status = 'failed' ORDER BY filing_date DESC LIMIT 10"
    )
    .all() as Pipeline["failures"];
  const coverage = db
    .prepare(
      `SELECT SUM(status IN ${COUNTED}) AS parsed, SUM(status = 'failed') AS unreadable FROM filings`
    )
    .get() as Pipeline["coverage"];
  const transcribed = db
    .prepare(
      `SELECT COUNT(DISTINCT f.id) AS filings, COUNT(t.id) AS rows
       FROM filings f LEFT JOIN transactions t ON t.filing_id = f.id
       WHERE f.status IN ${COUNTED} AND ${TRANSCRIBED}`
    )
    .get() as Pipeline["transcribed"];

  return {
    byStatus,
    byMethod,
    totals,
    senateStatus: senate?.value ?? null,
    lastUpdated: last?.t ?? null,
    failures,
    coverage,
    transcribed,
  };
}
