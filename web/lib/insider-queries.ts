import { getDb } from "./db";
import { ISSUER_SORT, orderBy, type IssuerSortKey, type Sort } from "./table-sort";
import {
  COUNTED,
  DELAY,
  NO_SECTOR_COLS,
  SECTOR_COLS,
  hasIssuerTables,
  likePattern,
  sinceClause,
  type SectorFields,
} from "./queries";
import { dense, monthKeys, monthStart } from "./months";

/**
 * SEC Form 4 insider trades — separate tables, separate queries (see
 * CLAUDE.md). Two things differ from the congressional queries:
 *
 * - Values are exact: `shares × price as filed`, so `MID` collapses to the
 *   exact figure and is NULL (never 0) when the filing gave no price.
 * - "Insiders" always means *primary* reporting owners (`owner_index = 0`),
 *   so a founder filing jointly with their holding company counts once.
 *   `filings` is shown beside `insiders` because related parties filing
 *   separately still count twice.
 * - A row flagged `implausible` (derived once at ingest by
 *   `stats.form4_is_implausible` — a price cell holding the aggregate
 *   consideration) is shown as filed but worth nothing to any total, exactly
 *   as `stats.insider_issuer_stats` treats it: counted as a trade, excluded
 *   from every value. Keep the two in agreement.
 */

const FROM = `FROM insider_transactions t
  JOIN insider_filings f ON f.id = t.filing_id
  LEFT JOIN insider_filing_owners o ON o.filing_id = f.id AND o.owner_index = 0
  LEFT JOIN insiders i ON i.cik = o.insider_cik`;

/**
 * The value of one row. Insider values are exact (`shares × price as filed`),
 * so this is the exact figure, and the range form only because the columns
 * are shared with the congressional tables. It is deliberately NOT the
 * congressional `MID`: that helper excludes rows transcribed from a scanned
 * paper filing via `filings.parse_method`, a column Form 4 tables do not
 * have — importing it here took the Insiders tab down with
 * "no such column: f.parse_method" (2026-10-17).
 */
const INSIDER_MID = `COALESCE(t.amount_exact_cents,
  CASE WHEN t.amount_max_cents IS NULL THEN t.amount_min_cents
       ELSE (t.amount_min_cents + t.amount_max_cents) / 2 END)`;

/** Value of one row, or NULL when it has no price or its as-filed value is implausible. */
const VALUE = `CASE WHEN t.implausible IS NOT 1 THEN ${INSIDER_MID} END`;
const BUY_VALUE = `COALESCE(SUM(CASE WHEN t.action = 'purchase' THEN ${VALUE} END), 0)`;
const SELL_VALUE = `COALESCE(SUM(CASE WHEN t.action = 'sale' THEN ${VALUE} END), 0)`;

export type InsiderTotals = {
  filings: number;
  trades: number;
  buys: number;
  sells: number;
  issuers: number;
  insiders: number;
  buy_value: number;
  sell_value: number;
  late_trades: number;
  unpriced: number;
  /** Rows kept as filed but excluded from every value above. */
  implausible: number;
};

/** Whole-dataset headline figures — never a page slice. */
export async function getInsiderTotals(): Promise<InsiderTotals> {
  const db = await getDb();
  return db
    .prepare(
      `SELECT COUNT(DISTINCT f.id) AS filings,
              COUNT(*) AS trades,
              SUM(t.action = 'purchase') AS buys,
              SUM(t.action = 'sale') AS sells,
              COUNT(DISTINCT f.issuer_cik) AS issuers,
              COUNT(DISTINCT o.insider_cik) AS insiders,
              ${BUY_VALUE} AS buy_value,
              ${SELL_VALUE} AS sell_value,
              COALESCE(SUM(t.late), 0) AS late_trades,
              COALESCE(SUM(t.amount_exact_cents IS NULL), 0) AS unpriced,
              COALESCE(SUM(t.implausible = 1), 0) AS implausible
       ${FROM}
       WHERE f.status IN ${COUNTED}`
    )
    .get() as InsiderTotals;
}

export type IssuerRow = {
  issuer_cik: string;
  ticker: string | null;
  issuer_name: string | null;
  insiders: number;
  buy_insiders: number;
  sell_insiders: number;
  filings: number;
  trades: number;
  buys: number;
  sells: number;
  buy_value: number;
  sell_value: number;
  /** Rows in each direction with no usable value (no price, or implausible):
   *  absent from `buy_value` / `sell_value`, which are therefore a partial
   *  sum — and unknown, not zero, when every row in a direction is one. */
  unpriced_buys: number;
  unpriced_sells: number;
  last_tx_date: string | null;
  /** Issuers in the whole result before LIMIT — set by `getInsiderIssuers` only. */
  total_rows?: number;
  /** The largest bought or sold value in the whole result — `getInsiderIssuers` only. */
  max_value?: number;
};

const ISSUER_SELECT = `SELECT f.issuer_cik,
       MIN(f.ticker) AS ticker,
       MIN(f.issuer_name) AS issuer_name,
       COUNT(DISTINCT o.insider_cik) AS insiders,
       COUNT(DISTINCT CASE WHEN t.action = 'purchase' THEN o.insider_cik END) AS buy_insiders,
       COUNT(DISTINCT CASE WHEN t.action = 'sale' THEN o.insider_cik END) AS sell_insiders,
       COUNT(DISTINCT f.id) AS filings,
       COUNT(*) AS trades,
       SUM(t.action = 'purchase') AS buys,
       SUM(t.action = 'sale') AS sells,
       ${BUY_VALUE} AS buy_value,
       ${SELL_VALUE} AS sell_value,
       SUM(t.action = 'purchase' AND (${VALUE}) IS NULL) AS unpriced_buys,
       SUM(t.action = 'sale' AND (${VALUE}) IS NULL) AS unpriced_sells,
       MAX(t.tx_date) AS last_tx_date
  ${FROM}`;

/**
 * Issuers in the window by `sort` (default: value bought + sold), ordered
 * over the whole result before the LIMIT, with the result's size on every
 * row. The subquery makes `ticker` and `issuer_name` name the aggregates,
 * not the same-named `insider_filings` columns.
 */
export async function getInsiderIssuers(
  days?: number,
  limit = 40,
  sort?: Sort<IssuerSortKey>
): Promise<IssuerRow[]> {
  const db = await getDb();
  const order = orderBy(ISSUER_SORT, sort ?? { key: ISSUER_SORT.default, dir: "desc" });
  return db
    .prepare(
      `SELECT *, COUNT(*) OVER () AS total_rows,
              MAX(MAX(buy_value, sell_value)) OVER () AS max_value FROM (
       ${ISSUER_SELECT}
       WHERE f.status IN ${COUNTED} ${sinceClause(days)}
       GROUP BY f.issuer_cik)
       ${order}
       LIMIT ?`
    )
    .all(limit) as IssuerRow[];
}

/** One issuer by listed symbol, over everything or a trade-date window. */
export async function getInsiderIssuer(ticker: string, days?: number): Promise<IssuerRow | null> {
  const db = await getDb();
  const row = db
    .prepare(
      `${ISSUER_SELECT}
       WHERE f.status IN ${COUNTED} AND f.ticker = ? ${sinceClause(days)}
       GROUP BY f.issuer_cik
       ORDER BY trades DESC
       LIMIT 1`
    )
    .get(ticker.toUpperCase()) as IssuerRow | undefined;
  return row ?? null;
}

/**
 * Issuers where several distinct insiders traded the same way inside the
 * window. Mirrors `stats.find_insider_clusters` in src/whale/stats.py —
 * keep the two in agreement (window on trade date, primary owners, buys
 * and sells never pooled).
 */
export async function getInsiderClusters(days = 30, minInsiders = 3, limit = 12): Promise<IssuerRow[]> {
  const db = await getDb();
  return db
    .prepare(
      `${ISSUER_SELECT}
       WHERE f.status IN ${COUNTED} ${sinceClause(days)}
       GROUP BY f.issuer_cik
       HAVING buy_insiders >= ? OR sell_insiders >= ?
       ORDER BY MAX(buy_insiders, sell_insiders) DESC, buy_value + sell_value DESC
       LIMIT ?`
    )
    .all(minInsiders, minInsiders, limit) as IssuerRow[];
}

export type InsiderTradeRow = {
  id: number;
  tx_date: string | null;
  /** The verbatim transactionDate when tx_date was parsed out of an offset-suffixed value. */
  tx_date_as_filed: string | null;
  action: string;
  transaction_code: string;
  shares: number | null;
  price_per_share: number | null;
  amount_min_cents: number | null;
  amount_max_cents: number | null;
  amount_exact_cents: number | null;
  security_title: string | null;
  direct_or_indirect: string | null;
  nature_of_ownership: string | null;
  /** 'E' early, 'L' late — the filer's own box, as filed. */
  timeliness: string | null;
  /** Derived once at ingest (two business days); NULL when the dates contradict. */
  late: number | null;
  /** 1 when the as-filed value is beyond belief; shown as filed, counted nowhere. */
  implausible: number | null;
  footnotes: string | null;
  accession: string;
  ticker: string | null;
  issuer_name: string | null;
  issuer_cik: string | null;
  filing_date: string;
  aff_10b5_one: number | null;
  source_url: string;
  insider_name: string | null;
  insider_cik: string | null;
  is_director: number | null;
  is_officer: number | null;
  is_ten_percent_owner: number | null;
  officer_title: string | null;
  owner_count: number;
  delay_days: number | null;
} & SectorFields;

/** A Form 4 issuer's classification, one-to-one: the filing names the
 *  issuer CIK, so no symbol lookup stands between the row and its group. */
const INSIDER_SECTOR_JOIN = `LEFT JOIN issuers s ON s.cik = f.issuer_cik`;

export async function getInsiderTrades(opts: {
  ticker?: string;
  cik?: string;
  action?: string;
  days?: number;
  limit?: number;
} = {}): Promise<InsiderTradeRow[]> {
  const db = await getDb();
  const where: string[] = [`f.status IN ${COUNTED}`];
  const params: unknown[] = [];
  if (opts.ticker) {
    where.push("f.ticker = ?");
    params.push(opts.ticker.toUpperCase());
  }
  if (opts.cik) {
    where.push("o.insider_cik = ?");
    params.push(opts.cik);
  }
  if (opts.action === "buy") where.push("t.action = 'purchase'");
  if (opts.action === "sell") where.push("t.action = 'sale'");
  params.push(opts.limit ?? 100);
  const sectors = hasIssuerTables(db);

  return db
    .prepare(
      `SELECT t.id, t.tx_date, t.tx_date_as_filed, t.action, t.transaction_code, t.shares, t.price_per_share,
              t.amount_min_cents, t.amount_max_cents, t.amount_exact_cents,
              t.security_title, t.direct_or_indirect, t.nature_of_ownership,
              t.timeliness, t.late, t.implausible, t.footnotes,
              f.accession, f.ticker, f.issuer_name, f.issuer_cik, f.filing_date,
              f.aff_10b5_one, f.source_url,
              i.name AS insider_name, o.insider_cik, o.is_director, o.is_officer,
              o.is_ten_percent_owner, o.officer_title,
              (SELECT COUNT(*) FROM insider_filing_owners x WHERE x.filing_id = f.id) AS owner_count,
              ${DELAY} AS delay_days,
              ${sectors ? SECTOR_COLS : NO_SECTOR_COLS}
       ${FROM}
       ${sectors ? INSIDER_SECTOR_JOIN : ""}
       WHERE ${where.join(" AND ")} ${sinceClause(opts.days)}
       ORDER BY t.tx_date DESC, t.id DESC
       LIMIT ?`
    )
    .all(...params) as InsiderTradeRow[];
}

export type IssuerInsiderRow = {
  cik: string;
  name: string;
  is_director: number;
  is_officer: number;
  is_ten_percent_owner: number;
  officer_title: string | null;
  filings: number;
  buys: number;
  sells: number;
  bought: number;
  sold: number;
};

/** The primary reporting owners behind one issuer's stored filings, over
 *  everything or a trade-date window. */
export async function getIssuerInsiders(ticker: string, days?: number): Promise<IssuerInsiderRow[]> {
  const db = await getDb();
  return db
    .prepare(
      `SELECT i.cik, i.name,
              MAX(o.is_director) AS is_director,
              MAX(o.is_officer) AS is_officer,
              MAX(o.is_ten_percent_owner) AS is_ten_percent_owner,
              MAX(o.officer_title) AS officer_title,
              COUNT(DISTINCT f.id) AS filings,
              SUM(t.action = 'purchase') AS buys,
              SUM(t.action = 'sale') AS sells,
              ${BUY_VALUE} AS bought,
              ${SELL_VALUE} AS sold
       ${FROM}
       WHERE f.status IN ${COUNTED} AND f.ticker = ? AND o.insider_cik IS NOT NULL
       ${sinceClause(days)}
       GROUP BY i.cik
       ORDER BY bought + sold DESC`
    )
    .all(ticker.toUpperCase()) as IssuerInsiderRow[];
}

/**
 * Insider value bought and sold per industry group (#55). A NULL group is
 * the unclassified remainder (an issuer EDGAR lists no SIC for, or one the
 * fill has not reached), kept as its own row. Values follow the page's
 * rule: shares × reported price, implausible rows worth nothing.
 */
export type InsiderSectorRow = {
  industry_group: string | null;
  issuers: number;
  filings: number;
  insiders: number;
  trades: number;
  buys: number;
  sells: number;
  buy_value: number;
  sell_value: number;
};

/** Empty when the database predates the issuer tables. */
export async function getInsiderSectors(days?: number): Promise<InsiderSectorRow[]> {
  const db = await getDb();
  if (!hasIssuerTables(db)) return [];
  return db
    .prepare(
      `SELECT s.industry_group,
              COUNT(DISTINCT f.issuer_cik) AS issuers,
              COUNT(DISTINCT f.id) AS filings,
              COUNT(DISTINCT o.insider_cik) AS insiders,
              COUNT(*) AS trades,
              SUM(t.action = 'purchase') AS buys,
              SUM(t.action = 'sale') AS sells,
              ${BUY_VALUE} AS buy_value,
              ${SELL_VALUE} AS sell_value
       ${FROM}
       ${INSIDER_SECTOR_JOIN}
       WHERE f.status IN ${COUNTED} ${sinceClause(days)}
       GROUP BY s.industry_group
       ORDER BY s.industry_group IS NULL, buy_value + sell_value DESC`
    )
    .all() as InsiderSectorRow[];
}

export type IssuerSearchRow = {
  issuer_cik: string;
  ticker: string | null;
  issuer_name: string | null;
  insiders: number;
  filings: number;
  trades: number;
  last_tx_date: string | null;
};

/**
 * Issuers by ticker or name; an exact ticker match ranks first. Counts
 * primary reporting owners, like every insider figure. Kept apart from the
 * congressional search: the two sets of tables are never joined.
 */
export async function searchInsiderIssuers(q: string, limit = 20): Promise<IssuerSearchRow[]> {
  const db = await getDb();
  const pattern = likePattern(q);
  try {
    return db
      .prepare(
        `SELECT f.issuer_cik,
                MIN(f.ticker) AS ticker,
                MIN(f.issuer_name) AS issuer_name,
                COUNT(DISTINCT o.insider_cik) AS insiders,
                COUNT(DISTINCT f.id) AS filings,
                COUNT(*) AS trades,
                MAX(t.tx_date) AS last_tx_date
         ${FROM}
         WHERE f.status IN ${COUNTED}
           AND (f.ticker LIKE ? ESCAPE '\\' OR f.issuer_name LIKE ? ESCAPE '\\')
         GROUP BY f.issuer_cik
         ORDER BY (MIN(f.ticker) = ?) DESC, trades DESC, ticker
         LIMIT ?`
      )
      .all(pattern, pattern, q.toUpperCase(), limit) as IssuerSearchRow[];
  } catch {
    // A database from before the insider source has no such tables.
    return [];
  }
}

export type InsiderPipeline = {
  byStatus: { status: string; source: string; n: number }[];
  totals: { filings: number; trades: number; issuers: number };
  state: Record<string, string | null>;
  failures: { accession: string; issuer_name: string | null; last_error: string | null; source_url: string }[];
};

const STATE_KEYS = ["edgar_status", "edgar_cursor", "edgar_skipped", "edgar_gap", "edgar_backfill_through"];

/** Null when the insider tables do not exist yet (a database from before the source was added). */
export async function getInsiderPipeline(): Promise<InsiderPipeline | null> {
  const db = await getDb();
  try {
    const byStatus = db
      .prepare(
        "SELECT status, source, COUNT(*) AS n FROM insider_filings GROUP BY status, source ORDER BY n DESC"
      )
      .all() as InsiderPipeline["byStatus"];
    const totals = db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM insider_filings) AS filings,
                (SELECT COUNT(*) FROM insider_transactions) AS trades,
                (SELECT COUNT(DISTINCT issuer_cik) FROM insider_filings) AS issuers`
      )
      .get() as InsiderPipeline["totals"];
    const rows = db
      .prepare("SELECT key, value FROM sync_state WHERE key LIKE 'edgar_%'")
      .all() as { key: string; value: string | null }[];
    const state: Record<string, string | null> = Object.fromEntries(STATE_KEYS.map((k) => [k, null]));
    for (const r of rows) state[r.key] = r.value;
    const failures = db
      .prepare(
        `SELECT accession, issuer_name, last_error, source_url FROM insider_filings
         WHERE status = 'failed' ORDER BY filing_date DESC LIMIT 10`
      )
      .all() as InsiderPipeline["failures"];
    return { byStatus, totals, state, failures };
  } catch {
    return null;
  }
}

export type InsiderMonthly = {
  month: string;
  filings: number;
  trades: number;
  buys: number;
  sells: number;
  buy_value: number;
  sell_value: number;
  /** Rows with no price: counted in `trades`, worth nothing to either value. */
  unpriced: number;
  /** Rows shown as filed and kept out of every value. */
  implausible: number;
};

/**
 * Buy and sell value per calendar month of TRADE date, for /trends. This is
 * the one monthly series on the site that sums dollars: Form 4 values are
 * exact (shares × price as filed), where congressional amounts are
 * brackets. Form 4's two-business-day deadline means a month is complete
 * within days of ending, so the series has no reporting lag to caveat —
 * its coverage edge is where the daily-index backfill starts.
 */
export async function getInsiderMonthly(months = 12): Promise<InsiderMonthly[]> {
  const keys = monthKeys(months);
  const db = await getDb();
  const rows = db
    .prepare(
      `SELECT substr(t.tx_date, 1, 7) AS month,
              COUNT(DISTINCT f.id) AS filings,
              COUNT(*) AS trades,
              SUM(t.action = 'purchase') AS buys,
              SUM(t.action = 'sale') AS sells,
              ${BUY_VALUE} AS buy_value,
              ${SELL_VALUE} AS sell_value,
              COALESCE(SUM(t.amount_exact_cents IS NULL), 0) AS unpriced,
              COALESCE(SUM(t.implausible = 1), 0) AS implausible
       FROM insider_transactions t
       JOIN insider_filings f ON f.id = t.filing_id
       WHERE f.status IN ${COUNTED} AND t.tx_date >= ? AND t.tx_date <= date('now')
       GROUP BY month
       ORDER BY month`
    )
    .all(monthStart(keys[0])) as InsiderMonthly[];
  return dense(keys, rows, (month) => ({
    month,
    filings: 0,
    trades: 0,
    buys: 0,
    sells: 0,
    buy_value: 0,
    sell_value: 0,
    unpriced: 0,
    implausible: 0,
  }));
}
