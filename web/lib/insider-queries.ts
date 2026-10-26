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
  watch?: { tickers?: string[]; insiders?: string[] };
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
  if (opts.watch) {
    const tickers = (opts.watch.tickers ?? []).map((x) => x.toUpperCase());
    const insiders = opts.watch.insiders ?? [];
    if (tickers.length > 0 || insiders.length > 0) {
      const clauses: string[] = [];
      if (tickers.length > 0) {
        clauses.push(`f.ticker IN (${tickers.map(() => "?").join(",")})`);
        params.push(...tickers);
      }
      if (insiders.length > 0) {
        clauses.push(`o.insider_cik IN (${insiders.map(() => "?").join(",")})`);
        params.push(...insiders);
      }
      where.push(`(${clauses.join(" OR ")})`);
    } else {
      where.push("0");
    }
  }
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

/* ------------------------------------------- Insider filers & ratings --- */

export type InsiderFilerRow = {
  cik: string;
  name: string;
  is_director: number;
  is_officer: number;
  is_ten_percent_owner: number;
  officer_title: string | null;
  primary_ticker: string | null;
  primary_issuer_name: string | null;
  issuers: number;
  filings: number;
  trades: number;
  buys: number;
  sells: number;
  buy_value: number;
  sell_value: number;
  late_trades: number;
  plan_trades: number;
  first_tx_date: string | null;
  last_tx_date: string | null;
  avg_delay: number | null;
};

/**
 * Corporate insiders (`owner_index = 0`) ranked across stored Form 4 filings.
 * Values are exact (`shares × price as filed`, implausible rows excluded).
 */
export async function getInsiderFilers(
  opts: {
    days?: number;
    role?: "officer" | "director" | "ten_percent" | "all";
    direction?: "buy" | "sell" | "all";
    limit?: number;
  } = {}
): Promise<InsiderFilerRow[]> {
  const db = await getDb();
  const where: string[] = [`f.status IN ${COUNTED}`, "o.insider_cik IS NOT NULL"];
  if (opts.role === "officer") where.push("o.is_officer = 1");
  else if (opts.role === "director") where.push("o.is_director = 1");
  else if (opts.role === "ten_percent") where.push("o.is_ten_percent_owner = 1");

  const having =
    opts.direction === "buy"
      ? "HAVING buy_value > 0"
      : opts.direction === "sell"
        ? "HAVING sell_value > 0"
        : "";
  const order =
    opts.direction === "buy"
      ? "ORDER BY buy_value DESC, filings DESC, name"
      : opts.direction === "sell"
        ? "ORDER BY sell_value DESC, filings DESC, name"
        : "ORDER BY buy_value + sell_value DESC, filings DESC, name";

  return db
    .prepare(
      `SELECT o.insider_cik AS cik,
              COALESCE(MAX(i.name), o.insider_cik) AS name,
              MAX(o.is_director) AS is_director,
              MAX(o.is_officer) AS is_officer,
              MAX(o.is_ten_percent_owner) AS is_ten_percent_owner,
              MAX(o.officer_title) AS officer_title,
              MIN(f.ticker) AS primary_ticker,
              MIN(f.issuer_name) AS primary_issuer_name,
              COUNT(DISTINCT f.issuer_cik) AS issuers,
              COUNT(DISTINCT f.id) AS filings,
              COUNT(*) AS trades,
              SUM(t.action = 'purchase') AS buys,
              SUM(t.action = 'sale') AS sells,
              ${BUY_VALUE} AS buy_value,
              ${SELL_VALUE} AS sell_value,
              COALESCE(SUM(t.late), 0) AS late_trades,
              COALESCE(SUM(f.aff_10b5_one = 1), 0) AS plan_trades,
              MIN(t.tx_date) AS first_tx_date,
              MAX(t.tx_date) AS last_tx_date,
              AVG(${DELAY}) AS avg_delay
       ${FROM}
       WHERE ${where.join(" AND ")} ${sinceClause(opts.days)}
       GROUP BY o.insider_cik
       ${having}
       ${order}
       LIMIT ?`
    )
    .all(opts.limit ?? 60) as InsiderFilerRow[];
}

/** One corporate insider's aggregate profile by 10-digit CIK. */
export async function getInsiderFiler(cik: string): Promise<InsiderFilerRow | null> {
  const db = await getDb();
  const row = db
    .prepare(
      `SELECT o.insider_cik AS cik,
              COALESCE(MAX(i.name), o.insider_cik) AS name,
              MAX(o.is_director) AS is_director,
              MAX(o.is_officer) AS is_officer,
              MAX(o.is_ten_percent_owner) AS is_ten_percent_owner,
              MAX(o.officer_title) AS officer_title,
              MIN(f.ticker) AS primary_ticker,
              MIN(f.issuer_name) AS primary_issuer_name,
              COUNT(DISTINCT f.issuer_cik) AS issuers,
              COUNT(DISTINCT f.id) AS filings,
              COUNT(*) AS trades,
              SUM(t.action = 'purchase') AS buys,
              SUM(t.action = 'sale') AS sells,
              ${BUY_VALUE} AS buy_value,
              ${SELL_VALUE} AS sell_value,
              COALESCE(SUM(t.late), 0) AS late_trades,
              COALESCE(SUM(f.aff_10b5_one = 1), 0) AS plan_trades,
              MIN(t.tx_date) AS first_tx_date,
              MAX(t.tx_date) AS last_tx_date,
              AVG(${DELAY}) AS avg_delay
       ${FROM}
       WHERE f.status IN ${COUNTED} AND o.insider_cik = ?
       GROUP BY o.insider_cik`
    )
    .get(cik.trim()) as InsiderFilerRow | undefined;
  return row ?? null;
}

export type InsiderFilerIssuerRow = {
  issuer_cik: string;
  ticker: string | null;
  issuer_name: string | null;
  is_director: number;
  is_officer: number;
  is_ten_percent_owner: number;
  officer_title: string | null;
  filings: number;
  trades: number;
  buys: number;
  sells: number;
  buy_value: number;
  sell_value: number;
  last_tx_date: string | null;
};

/** Issuers one corporate insider has traded on SEC Form 4. */
export async function getInsiderFilerIssuers(cik: string): Promise<InsiderFilerIssuerRow[]> {
  const db = await getDb();
  return db
    .prepare(
      `SELECT f.issuer_cik,
              MIN(f.ticker) AS ticker,
              MIN(f.issuer_name) AS issuer_name,
              MAX(o.is_director) AS is_director,
              MAX(o.is_officer) AS is_officer,
              MAX(o.is_ten_percent_owner) AS is_ten_percent_owner,
              MAX(o.officer_title) AS officer_title,
              COUNT(DISTINCT f.id) AS filings,
              COUNT(*) AS trades,
              SUM(t.action = 'purchase') AS buys,
              SUM(t.action = 'sale') AS sells,
              ${BUY_VALUE} AS buy_value,
              ${SELL_VALUE} AS sell_value,
              MAX(t.tx_date) AS last_tx_date
       ${FROM}
       WHERE f.status IN ${COUNTED} AND o.insider_cik = ?
       GROUP BY f.issuer_cik
       ORDER BY buy_value + sell_value DESC, filings DESC`
    )
    .all(cik.trim()) as InsiderFilerIssuerRow[];
}

export const INSIDER_TRACK_HORIZONS = [5, 20] as const;
export type InsiderTrackHorizon = (typeof INSIDER_TRACK_HORIZONS)[number];

export type InsiderDecisionOutcome = {
  filing_id: number;
  accession: string;
  cik: string;
  name: string;
  is_director: number;
  is_officer: number;
  is_ten_percent_owner: number;
  officer_title: string | null;
  ticker: string;
  issuer_name: string | null;
  direction: "buy" | "sell";
  tx_date: string;
  filing_date: string;
  value_cents: number;
  t0_trade: string | null;
  t0_disclosure: string | null;
  signed_trade_5: number | null;
  signed_disclosure_5: number | null;
  signed_trade_20: number | null;
  signed_disclosure_20: number | null;
};

export type InsiderTrackScoreRow = {
  rank: number;
  cik: string;
  name: string;
  is_director: number;
  is_officer: number;
  is_ten_percent_owner: number;
  officer_title: string | null;
  primary_ticker: string;
  primary_issuer_name: string | null;
  horizon: InsiderTrackHorizon;
  n: number;
  filings: number;
  buys: number;
  sells: number;
  value_cents: number;
  trade_mean: number;
  trade_score: number;
  hit_rate: number;
  disclosure_mean: number | null;
  disclosure_score: number | null;
};

export type InsiderTrackLeaderboard = {
  available: boolean;
  horizon: InsiderTrackHorizon;
  decisions_measured: number;
  insiders_scored: number;
  mean_trade: number | null;
  mean_disclosure: number | null;
  rows: InsiderTrackScoreRow[];
};

const INSIDER_SHRINKAGE_K = 2;

function hasPricesTable(db: Awaited<ReturnType<typeof getDb>>): boolean {
  const r = db
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'prices'")
    .get() as { n: number };
  return r.n === 1;
}

function loadPriceSeries(db: Awaited<ReturnType<typeof getDb>>) {
  if (!hasPricesTable(db)) return { calendar: [] as string[], spy: new Map<string, number>(), byTicker: new Map<string, Map<string, number>>() };
  const raw = db
    .prepare("SELECT ticker, date, close FROM prices ORDER BY ticker, date")
    .all() as { ticker: string; date: string; close: number }[];
  const spy = new Map<string, number>();
  const byTicker = new Map<string, Map<string, number>>();
  for (const r of raw) {
    if (r.ticker === "SPY") {
      spy.set(r.date, r.close);
    } else {
      let m = byTicker.get(r.ticker);
      if (!m) {
        m = new Map<string, number>();
        byTicker.set(r.ticker, m);
      }
      m.set(r.date, r.close);
    }
  }
  const calendar = [...spy.keys()].sort();
  return { calendar, spy, byTicker };
}

function firstSessionOnOrAfter(calendar: string[], dateStr: string | null): number | null {
  if (!dateStr) return null;
  for (let i = 0; i < calendar.length; i++) {
    if (calendar[i] >= dateStr) return i;
  }
  return null;
}

function firstSessionStrictlyAfter(calendar: string[], dateStr: string | null): number | null {
  if (!dateStr) return null;
  for (let i = 0; i < calendar.length; i++) {
    if (calendar[i] > dateStr) return i;
  }
  return null;
}

function computeSignedExcess(
  calendar: string[],
  spy: Map<string, number>,
  series: Map<string, number> | undefined,
  i0: number | null,
  h: number,
  direction: "buy" | "sell"
): number | null {
  if (!series || i0 == null || i0 + h >= calendar.length) return null;
  const d0 = calendar[i0];
  const d1 = calendar[i0 + h];
  const c0 = series.get(d0);
  const c1 = series.get(d1);
  const s0 = spy.get(d0);
  const s1 = spy.get(d1);
  if (!c0 || !c1 || !s0 || !s1) return null;
  const raw = c1 / c0 - 1 - (s1 / s0 - 1);
  return direction === "buy" ? raw : -raw;
}

type RawInsiderDecision = {
  filing_id: number;
  accession: string;
  cik: string;
  name: string;
  is_director: number;
  is_officer: number;
  is_ten_percent_owner: number;
  officer_title: string | null;
  ticker: string;
  issuer_name: string | null;
  action: string;
  tx_date: string;
  filing_date: string;
  value_cents: number;
};

function scoreAllInsiderDecisions(
  db: Awaited<ReturnType<typeof getDb>>,
  onlyCik?: string
): InsiderDecisionOutcome[] {
  const { calendar, spy, byTicker } = loadPriceSeries(db);
  if (calendar.length === 0) return [];

  const whereCik = onlyCik ? "AND o.insider_cik = ?" : "";
  const raw = db
    .prepare(
      `SELECT f.id AS filing_id,
              f.accession,
              o.insider_cik AS cik,
              COALESCE(MAX(i.name), o.insider_cik) AS name,
              MAX(o.is_director) AS is_director,
              MAX(o.is_officer) AS is_officer,
              MAX(o.is_ten_percent_owner) AS is_ten_percent_owner,
              MAX(o.officer_title) AS officer_title,
              f.ticker,
              f.issuer_name,
              t.action,
              t.tx_date,
              f.filing_date,
              COALESCE(SUM(${VALUE}), 0) AS value_cents
       ${FROM}
       WHERE f.status IN ${COUNTED}
         AND f.ticker IS NOT NULL
         AND o.insider_cik IS NOT NULL
         AND t.tx_date IS NOT NULL
         AND t.action IN ('purchase', 'sale')
         ${whereCik}
       GROUP BY f.id, t.tx_date, t.action
       ORDER BY tx_date DESC, f.id DESC`
    )
    .all(...(onlyCik ? [onlyCik] : [])) as RawInsiderDecision[];

  const out: InsiderDecisionOutcome[] = [];
  for (const r of raw) {
    const series = byTicker.get(r.ticker);
    if (!series) continue;
    const direction: "buy" | "sell" = r.action === "purchase" ? "buy" : "sell";
    const iTrade = firstSessionOnOrAfter(calendar, r.tx_date);
    const iDisc = firstSessionStrictlyAfter(calendar, r.filing_date);
    const sTrade5 = computeSignedExcess(calendar, spy, series, iTrade, 5, direction);
    const sDisc5 = computeSignedExcess(calendar, spy, series, iDisc, 5, direction);
    const sTrade20 = computeSignedExcess(calendar, spy, series, iTrade, 20, direction);
    const sDisc20 = computeSignedExcess(calendar, spy, series, iDisc, 20, direction);
    if (sTrade5 == null && sTrade20 == null) continue;
    out.push({
      filing_id: r.filing_id,
      accession: r.accession,
      cik: r.cik,
      name: r.name,
      is_director: r.is_director,
      is_officer: r.is_officer,
      is_ten_percent_owner: r.is_ten_percent_owner,
      officer_title: r.officer_title,
      ticker: r.ticker,
      issuer_name: r.issuer_name,
      direction,
      tx_date: r.tx_date,
      filing_date: r.filing_date,
      value_cents: r.value_cents,
      t0_trade: iTrade != null ? calendar[iTrade] : null,
      t0_disclosure: iDisc != null ? calendar[iDisc] : null,
      signed_trade_5: sTrade5,
      signed_disclosure_5: sDisc5,
      signed_trade_20: sTrade20,
      signed_disclosure_20: sDisc20,
    });
  }
  return out;
}

export function parseInsiderTrackHorizon(raw: string | string[] | undefined): InsiderTrackHorizon {
  const v = Number(Array.isArray(raw) ? raw[0] : raw);
  return v === 5 ? 5 : 20;
}

/**
 * Post-trade stock moves against the S&P 500 (SPY) after corporate insiders'
 * SEC Form 4 decisions, over 5 or 20 trading days.
 */
export async function getInsiderTrackLeaderboard(
  horizon: InsiderTrackHorizon = 20
): Promise<InsiderTrackLeaderboard> {
  const db = await getDb();
  const decisions = scoreAllInsiderDecisions(db);
  if (decisions.length === 0) {
    return {
      available: false,
      horizon,
      decisions_measured: 0,
      insiders_scored: 0,
      mean_trade: null,
      mean_disclosure: null,
      rows: [],
    };
  }

  const tradeKey = horizon === 5 ? "signed_trade_5" : "signed_trade_20";
  const discKey = horizon === 5 ? "signed_disclosure_5" : "signed_disclosure_20";
  const eligible = decisions.filter((d) => d[tradeKey] != null);

  const byCik = new Map<string, InsiderDecisionOutcome[]>();
  for (const d of eligible) {
    const arr = byCik.get(d.cik);
    if (arr) arr.push(d);
    else byCik.set(d.cik, [d]);
  }

  const rows: InsiderTrackScoreRow[] = [];
  for (const [cik, ds] of byCik.entries()) {
    const n = ds.length;
    const filings = new Set(ds.map((d) => d.filing_id)).size;
    const tradeVals = ds.map((d) => d[tradeKey] as number);
    const discVals = ds.map((d) => d[discKey]).filter((v): v is number => v != null);
    const tradeMean = tradeVals.reduce((a, b) => a + b, 0) / n;
    const tradeScore = tradeMean * (n / (n + INSIDER_SHRINKAGE_K));
    const hitRate = tradeVals.filter((v) => v > 0).length / n;
    const discMean = discVals.length > 0 ? discVals.reduce((a, b) => a + b, 0) / discVals.length : null;
    const discScore = discMean != null ? discMean * (discVals.length / (discVals.length + INSIDER_SHRINKAGE_K)) : null;

    rows.push({
      rank: 0,
      cik,
      name: ds[0].name,
      is_director: ds[0].is_director,
      is_officer: ds[0].is_officer,
      is_ten_percent_owner: ds[0].is_ten_percent_owner,
      officer_title: ds[0].officer_title,
      primary_ticker: ds[0].ticker,
      primary_issuer_name: ds[0].issuer_name,
      horizon,
      n,
      filings,
      buys: ds.filter((d) => d.direction === "buy").length,
      sells: ds.filter((d) => d.direction === "sell").length,
      value_cents: ds.reduce((s, d) => s + d.value_cents, 0),
      trade_mean: tradeMean,
      trade_score: tradeScore,
      hit_rate: hitRate,
      disclosure_mean: discMean,
      disclosure_score: discScore,
    });
  }

  rows.sort((a, b) => b.trade_score - a.trade_score || b.n - a.n || a.name.localeCompare(b.name));
  rows.forEach((r, idx) => {
    r.rank = idx + 1;
  });

  const allTrade = eligible.map((d) => d[tradeKey] as number);
  const allDisc = eligible.map((d) => d[discKey]).filter((v): v is number => v != null);

  return {
    available: true,
    horizon,
    decisions_measured: eligible.length,
    insiders_scored: rows.length,
    mean_trade: allTrade.length ? allTrade.reduce((a, b) => a + b, 0) / allTrade.length : null,
    mean_disclosure: allDisc.length ? allDisc.reduce((a, b) => a + b, 0) / allDisc.length : null,
    rows,
  };
}

export type InsiderFilerTrack = {
  available: boolean;
  decisions: InsiderDecisionOutcome[];
  score5: { n: number; trade_mean: number; trade_score: number; hit_rate: number; disclosure_mean: number | null } | null;
  score20: { n: number; trade_mean: number; trade_score: number; hit_rate: number; disclosure_mean: number | null } | null;
};

/** One corporate insider's post-trade stock moves against SPY at 5 and 20 trading days. */
export async function getInsiderFilerTrack(cik: string): Promise<InsiderFilerTrack> {
  const db = await getDb();
  const decisions = scoreAllInsiderDecisions(db, cik.trim());
  if (decisions.length === 0) {
    return { available: false, decisions: [], score5: null, score20: null };
  }

  const summarize = (tradeKey: "signed_trade_5" | "signed_trade_20", discKey: "signed_disclosure_5" | "signed_disclosure_20") => {
    const tVals = decisions.map((d) => d[tradeKey]).filter((v): v is number => v != null);
    if (tVals.length === 0) return null;
    const dVals = decisions.map((d) => d[discKey]).filter((v): v is number => v != null);
    const n = tVals.length;
    const trade_mean = tVals.reduce((a, b) => a + b, 0) / n;
    const trade_score = trade_mean * (n / (n + INSIDER_SHRINKAGE_K));
    const hit_rate = tVals.filter((v) => v > 0).length / n;
    const disclosure_mean = dVals.length ? dVals.reduce((a, b) => a + b, 0) / dVals.length : null;
    return { n, trade_mean, trade_score, hit_rate, disclosure_mean };
  };

  return {
    available: true,
    decisions,
    score5: summarize("signed_trade_5", "signed_disclosure_5"),
    score20: summarize("signed_trade_20", "signed_disclosure_20"),
  };
}
