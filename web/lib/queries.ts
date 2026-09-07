import { getDb } from "./db";

/**
 * Statuses whose transactions are real, parsed data. Mirrors
 * `COUNTED_STATUSES` in src/whale/db.py — a filing that failed to parse must
 * never contribute to a volume total.
 */
const COUNTED = `('parsed','notified','backfilled')`;

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
  /** 1 when the filing's own trade/notification dates contradict each other. */
  dates_inconsistent: number;
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
  avg_delay: number | null;
  late_count: number;
};

/**
 * Rolling window on trade date. Bounded at both ends: a handful of filings
 * carry a mistyped future trade date, which would otherwise sit inside "the
 * last 30 days" forever.
 */
function sinceClause(days?: number): string {
  return days
    ? `AND t.tx_date >= date('now', '-${Math.floor(days)} day') AND t.tx_date <= date('now')`
    : "";
}

/**
 * Days from trade to disclosure, NULL when the filed dates contradict each
 * other. Reporting "-339 days" would present a filer's typo as a fact.
 */
const DELAY = `CASE WHEN julianday(t.notification_date) >= julianday(t.tx_date)
     THEN CAST(julianday(t.notification_date) - julianday(t.tx_date) AS INTEGER) END`;

/**
 * Amount contribution of a row, in cents.
 *
 * Disclosures give brackets, so `mid` is the bracket midpoint — an estimate,
 * never a reported figure. Rows in the open-ended top bracket
 * (max IS NULL) contribute their floor to `mid` and force the range's upper
 * bound to be reported as unbounded.
 */
const MID = `COALESCE(t.amount_exact_cents,
  CASE WHEN t.amount_max_cents IS NULL THEN t.amount_min_cents
       ELSE (t.amount_min_cents + t.amount_max_cents) / 2 END)`;

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
              SUM(COALESCE(t.amount_min_cents,0)) AS volume_min,
              CASE WHEN SUM(t.amount_max_cents IS NULL AND t.amount_exact_cents IS NULL) > 0
                   THEN NULL ELSE SUM(COALESCE(t.amount_max_cents, t.amount_exact_cents, 0)) END AS volume_max,
              SUM(COALESCE(${MID},0)) AS volume_mid,
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
              SUM(COALESCE(t.amount_min_cents,0)) AS volume_min,
              NULL AS volume_max,
              SUM(COALESCE(${MID},0)) AS volume_mid,
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
              CASE WHEN julianday(t.notification_date) < julianday(t.tx_date)
                   THEN 1 ELSE 0 END AS dates_inconsistent
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
              AVG(${DELAY}) AS avg_delay,
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
              SUM(CASE WHEN late_count > 0 THEN 1 ELSE 0 END) AS members_late
       FROM per_member`
    )
    .get() as PoliticianTotals;
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

  return {
    byStatus,
    byMethod,
    totals,
    senateStatus: senate?.value ?? null,
    lastUpdated: last?.t ?? null,
    failures,
    coverage,
  };
}
