import type Database from "better-sqlite3";

import { getDb } from "./db";
import { POLITICIAN_SORT, TICKER_SORT, orderBy, type PoliticianSortKey, type Sort, type TickerSortKey } from "./table-sort";
import type { TransactionFilters } from "./feed-filters";

/**
 * Statuses whose transactions are real, parsed data. Mirrors
 * `COUNTED_STATUSES` in src/whale/db.py — a filing that failed to parse must
 * never contribute to a volume total.
 */
export const COUNTED = `('parsed','notified','backfilled')`;

/** Asset types eligible for the "conviction" views; mirrors config.yaml. */
export const CLUSTER_TYPES = `('ST','OP','EF','ET','CT','RS','SA')`;

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
  /** Tickers in the whole result before LIMIT — set by `getTickers` only. */
  total_rows?: number;
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
  /** The roster's id, for the member's portrait; NULL for an unmatched filer. */
  bioguide_id?: string | null;
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
  /** The Clerk's document id — the key of the /scans inspection page. */
  doc_id: string;
  /** The option contract as the filing's own text named it (src/whale/options.py):
   *  'call' | 'put', the strike, an ISO expiry. All NULL when the text does
   *  not say — a strike is never guessed from a premium. */
  option_kind: string | null;
  strike_cents: number | null;
  expiry: string | null;
} & SectorFields;

/**
 * The issuer's industry group, from its EDGAR SIC code
 * (src/whale/issuers.py, schema 9). All three NULL when the symbol is not
 * classified: EDGAR lists no SIC for it (ETF trusts, funds), does not list
 * the symbol, or the fill has not reached it yet. Unknown stays unknown.
 */
export type SectorFields = {
  industry_group: string | null;
  sic: string | null;
  sic_description: string | null;
};

/**
 * Whether the database carries the issuer tables. The dashboard reads
 * whatever the pipeline last committed, and a database from before the
 * schema-9 migration has none; every sector view then reports nothing
 * rather than take its page down with "no such table".
 */
export function hasIssuerTables(db: Database.Database): boolean {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM sqlite_master
       WHERE type = 'table' AND name IN ('issuers', 'issuer_tickers')`
    )
    .get() as { n: number };
  return row.n === 2;
}

/** A congressional row's issuer, one-to-one by symbol: `issuer_tickers`
 *  resolves the printed ticker to a CIK, `issuers` carries that CIK's group. */
export const SECTOR_JOIN = `LEFT JOIN issuer_tickers it ON it.ticker = t.ticker
       LEFT JOIN issuers s ON s.cik = it.cik`;
export const SECTOR_COLS = `s.industry_group, s.sic, s.sic_description`;
export const NO_SECTOR_COLS = `NULL AS industry_group, NULL AS sic, NULL AS sic_description`;

/**
 * The option-contract columns arrived with schema 11. The committed database
 * can predate them — the pipeline migrates it on its next run, not this code —
 * and a query naming a column the file lacks renders as an error page. So
 * they are selected only when the file has them and read as NULL otherwise;
 * the badges simply stay off until the next pipeline commit.
 */
const optionColumnsKnown = new WeakMap<Database.Database, boolean>();

export function hasOptionColumns(db: Database.Database): boolean {
  let has = optionColumnsKnown.get(db);
  if (has === undefined) {
    const cols = db.prepare("PRAGMA table_info(transactions)").all() as { name: string }[];
    has = cols.some((c) => c.name === "option_kind");
    optionColumnsKnown.set(db, has);
  }
  return has;
}

function optionColumns(db: Database.Database): string {
  return hasOptionColumns(db)
    ? "t.option_kind, t.strike_cents, t.expiry"
    : "NULL AS option_kind, NULL AS strike_cents, NULL AS expiry";
}

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
  /** Disclosed floors summed, and ceilings (NULL once any counted row is in
   *  the open-ended top bracket). Only where the query computes them. */
  volume_min?: number;
  volume_max?: number | null;
  volume_mid: number;
  /** Rows transcribed from scans: in `trades`, not in `volume_mid`. */
  transcribed: number;
  avg_delay: number | null;
  avg_lag: number | null;
  late_count: number;
  /** The roster's id, for the member's portrait; NULL for an unmatched filer. */
  bioguide_id?: string | null;
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

/**
 * The STOCK Act's deadline, in days from the trade: a trade disclosed more
 * than this many days after it was made is late. Mirrors
 * `STOCK_ACT_DEADLINE_DAYS` in src/whale/stats.py.
 */
export const STOCK_ACT_DEADLINE_DAYS = 45;

/**
 * A row disclosed past the deadline. A NULL delay — contradictory dates —
 * compares as NULL, so it is never late; the same rows the politicians
 * tiles count with their inline `> 45`.
 */
export const LATE = `(${DELAY}) > ${STOCK_ACT_DEADLINE_DAYS}`;

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

/**
 * Tickers in the window by `sort` (default: estimated volume), ordered over
 * the whole result before the LIMIT, with the result's size on every row.
 * The subquery makes every sort expression name the aggregate, never a
 * same-named table column.
 */
export async function getTickers(
  days?: number,
  limit = 40,
  sort?: Sort<TickerSortKey>
): Promise<TickerRow[]> {
  const db = await getDb();
  const order = orderBy(TICKER_SORT, sort ?? { key: TICKER_SORT.default, dir: "desc" });
  return db
    .prepare(
      `SELECT *, COUNT(*) OVER () AS total_rows FROM (
       SELECT t.ticker,
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
       GROUP BY t.ticker)
       ${order}
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

/**
 * WHERE clause for one filtered set of counted transactions. Shared by the
 * trade list, its whole-match totals and the CSV export, so the three can
 * never disagree about which rows a URL names.
 *
 * `chamber` is the filing's chamber, not the roster's: an unmatched filing
 * has no roster row but still came from one Clerk. `owner` "self" is a row
 * with no owner code — the member's own account.
 */
function transactionWhere(opts: TransactionFilters): { sql: string; params: unknown[] } {
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
  if (opts.chamber) {
    where.push("f.chamber = ?");
    params.push(opts.chamber);
  }
  if (opts.party) {
    where.push("p.party = ?");
    params.push(opts.party);
  }
  if (opts.assetType) {
    where.push("t.asset_type = ?");
    params.push(opts.assetType);
  }
  if (opts.owner === "self") where.push("(t.owner IS NULL OR t.owner = '')");
  else if (opts.owner) {
    where.push("t.owner = ?");
    params.push(opts.owner);
  }
  if (opts.from) {
    where.push("t.tx_date >= ?");
    params.push(opts.from);
  }
  if (opts.to) {
    where.push("t.tx_date <= ?");
    params.push(opts.to);
  }
  if (opts.transcribed === "only") where.push(TRANSCRIBED);
  if (opts.transcribed === "exclude") where.push(`NOT ${TRANSCRIBED}`);
  if (opts.watch && (opts.watch.members.length > 0 || opts.watch.tickers.length > 0)) {
    const clauses: string[] = [];
    if (opts.watch.members.length > 0) {
      clauses.push(`p.bioguide_id IN (${opts.watch.members.map(() => "?").join(",")})`);
      params.push(...opts.watch.members);
    }
    if (opts.watch.tickers.length > 0) {
      clauses.push(`t.ticker IN (${opts.watch.tickers.map(() => "?").join(",")})`);
      params.push(...opts.watch.tickers);
    }
    where.push(`(${clauses.join(" OR ")})`);
  }
  return { sql: where.join(" AND "), params };
}

export async function getTransactions(
  opts: TransactionFilters & {
    /** Only rows whose text named an option contract (the ticker page's Options section). */
    options?: boolean;
    /** "filed": newest disclosure first (the landing page). Default: newest trade date first. */
    order?: "trade" | "filed";
    limit?: number;
    offset?: number;
  } = {}
): Promise<TransactionRow[]> {
  const db = await getDb();
  const { sql, params } = transactionWhere(opts);
  const where = [sql];
  if (opts.options) {
    // Before the migration no row can qualify, and the column cannot be named.
    if (!hasOptionColumns(db)) return [];
    where.push("t.option_kind IS NOT NULL");
  }
  params.push(opts.limit ?? 100, opts.offset ?? 0);
  const sectors = hasIssuerTables(db);

  return db
    .prepare(
      `SELECT t.id, t.tx_date, t.notification_date, t.action, t.ticker, t.asset_name,
              t.asset_type, t.owner, t.amount_min_cents, t.amount_max_cents,
              t.amount_exact_cents,
              COALESCE(p.full_name, f.filer_name) AS member_name,
              p.party, p.state, p.district, p.chamber,
              p.bioguide_id,
              f.pdf_url, f.filing_date,
              ${DELAY} AS delay_days,
              ${LAG} AS lag_days,
              CASE WHEN julianday(t.notification_date) < julianday(t.tx_date)
                   THEN 1 ELSE 0 END AS dates_inconsistent,
              ${TRANSCRIBED} AS transcribed,
              f.doc_id,
              ${sectors ? SECTOR_COLS : NO_SECTOR_COLS},
              ${optionColumns(db)}
       FROM transactions t
       JOIN filings f ON f.id = t.filing_id
       LEFT JOIN politicians p ON p.id = t.politician_id
       ${sectors ? SECTOR_JOIN : ""}
       WHERE ${where.join(" AND ")}
       ORDER BY ${opts.order === "filed" ? "f.filing_date DESC, t.id DESC" : "t.tx_date DESC, t.id DESC"}
       LIMIT ? OFFSET ?`
    )
    .all(...params) as TransactionRow[];
}

export type TransactionTotals = {
  trades: number;
  /** Sum of the disclosed floors of every counted, non-transcribed row. */
  volume_min: number;
  /** Sum of the disclosed ceilings — NULL once any row is open-ended. */
  volume_max: number | null;
  /** Bracket midpoints — an estimate, never a reported figure. */
  volume_mid: number;
  /** Rows transcribed from scans: in `trades`, in no volume. */
  transcribed: number;
};

/**
 * What the whole filtered set adds up to, not the page of it being
 * rendered — the feed paginates, and a "total" summed over one page would
 * understate what it claims to report. The range is what the disclosures
 * permit; the midpoint is an estimate and is labelled as one wherever shown.
 */
export async function getTransactionTotals(opts: TransactionFilters = {}): Promise<TransactionTotals> {
  const db = await getDb();
  const { sql, params } = transactionWhere(opts);
  return db
    .prepare(
      `SELECT COUNT(*) AS trades,
              COALESCE(SUM(COALESCE(${VOL_MIN},0)),0) AS volume_min,
              ${VOLUME_MAX} AS volume_max,
              COALESCE(SUM(COALESCE(${MID},0)),0) AS volume_mid,
              COALESCE(SUM(${TRANSCRIBED}),0) AS transcribed
       FROM transactions t
       JOIN filings f ON f.id = t.filing_id
       LEFT JOIN politicians p ON p.id = t.politician_id
       WHERE ${sql}`
    )
    .get(...params) as TransactionTotals;
}

/* ------------------------------------------------------------------ search */

/** Case-insensitive substring match; `%`, `_` and `\` in the query are literal. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export type MemberSearchRow = {
  member_name: string;
  /** The roster's id, for the member's portrait; NULL for an unmatched filer. */
  bioguide_id?: string | null;
  party: string | null;
  state: string | null;
  district: string | null;
  chamber: string | null;
  trades: number;
  tickers: number;
  last_tx_date: string | null;
};

/**
 * Members whose disclosed trades the dashboard can show, by name. Grouped
 * exactly as the leaderboard is (`getPoliticians`), so every hit links to a
 * member page that exists.
 */
export async function searchMembers(q: string, limit = 20): Promise<MemberSearchRow[]> {
  const db = await getDb();
  return db
    .prepare(
      `SELECT COALESCE(p.full_name, f.filer_name) AS member_name,
              p.party, p.state, p.district, p.chamber,
              MAX(p.bioguide_id) AS bioguide_id,
              COUNT(*) AS trades,
              COUNT(DISTINCT t.ticker) AS tickers,
              MAX(t.tx_date) AS last_tx_date
       FROM transactions t
       JOIN filings f ON f.id = t.filing_id
       LEFT JOIN politicians p ON p.id = t.politician_id
       WHERE f.status IN ${COUNTED}
         AND COALESCE(p.full_name, f.filer_name) LIKE ? ESCAPE '\\'
       GROUP BY member_name
       ORDER BY trades DESC, member_name
       LIMIT ?`
    )
    .all(likePattern(q), limit) as MemberSearchRow[];
}

export type RosterRow = {
  full_name: string;
  /** The roster's id, for the member's portrait. */
  bioguide_id?: string | null;
  party: string | null;
  state: string | null;
  district: string | null;
  chamber: string | null;
};

/**
 * Roster members matching the query who have no counted trade in this
 * database. Listed so a search for a sitting member with nothing to show
 * reads "no disclosed trades", not "no such person".
 */
export async function searchRoster(q: string, limit = 10): Promise<RosterRow[]> {
  const db = await getDb();
  return db
    .prepare(
      `SELECT p.full_name, p.party, p.state, p.district, p.chamber,
              p.bioguide_id
       FROM politicians p
       WHERE p.full_name LIKE ? ESCAPE '\\'
         AND NOT EXISTS (
           SELECT 1 FROM transactions t
           JOIN filings f ON f.id = t.filing_id
           WHERE t.politician_id = p.id AND f.status IN ${COUNTED}
         )
       ORDER BY p.active DESC, p.full_name
       LIMIT ?`
    )
    .all(likePattern(q), limit) as RosterRow[];
}

export type TickerSearchRow = {
  ticker: string;
  asset_name: string | null;
  politicians: number;
  trades: number;
  last_tx_date: string | null;
};

/** Tickers by symbol or asset name; an exact symbol match ranks first. */
export async function searchTickers(q: string, limit = 20): Promise<TickerSearchRow[]> {
  const db = await getDb();
  const pattern = likePattern(q);
  return db
    .prepare(
      `SELECT t.ticker,
              MIN(t.asset_name) AS asset_name,
              COUNT(DISTINCT t.politician_id) AS politicians,
              COUNT(*) AS trades,
              MAX(t.tx_date) AS last_tx_date
       FROM transactions t
       JOIN filings f ON f.id = t.filing_id
       WHERE f.status IN ${COUNTED} AND t.ticker IS NOT NULL AND t.ticker != ''
         AND (t.ticker LIKE ? ESCAPE '\\' OR t.asset_name LIKE ? ESCAPE '\\')
       GROUP BY t.ticker
       ORDER BY (t.ticker = ?) DESC, trades DESC, t.ticker
       LIMIT ?`
    )
    .all(pattern, pattern, q.toUpperCase(), limit) as TickerSearchRow[];
}

/**
 * Members by `sort` (default: estimated volume), ordered over every member
 * before the LIMIT. The subquery makes every sort expression name the
 * aggregate, never a same-named table column.
 */
export async function getPoliticians(
  days?: number,
  limit = 60,
  sort?: Sort<PoliticianSortKey>
): Promise<PoliticianRow[]> {
  const db = await getDb();
  const order = orderBy(POLITICIAN_SORT, sort ?? { key: POLITICIAN_SORT.default, dir: "desc" });
  return db
    .prepare(
      `SELECT * FROM (
       SELECT COALESCE(p.full_name, f.filer_name) AS member_name,
              p.party, p.state, p.district, p.chamber,
              MAX(p.bioguide_id) AS bioguide_id,
              COUNT(*) AS trades,
              COUNT(DISTINCT t.ticker) AS tickers,
              SUM(t.action='purchase') AS buys,
              SUM(t.action IN ('sale','sale_partial')) AS sells,
              SUM(COALESCE(${VOL_MIN},0)) AS volume_min,
              ${VOLUME_MAX} AS volume_max,
              SUM(COALESCE(${MID},0)) AS volume_mid,
              SUM(${TRANSCRIBED}) AS transcribed,
              AVG(${DELAY}) AS avg_delay,
              AVG(${LAG}) AS avg_lag,
              SUM(CASE WHEN ${DELAY} > 45 THEN 1 ELSE 0 END) AS late_count
       FROM transactions t
       JOIN filings f ON f.id = t.filing_id
       LEFT JOIN politicians p ON p.id = t.politician_id
       WHERE f.status IN ${COUNTED} ${sinceClause(days)}
       GROUP BY member_name)
       ${order}
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
  volume_min: number;
  /** NULL when any counted row is in the open-ended top bracket. */
  volume_max: number | null;
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
              SUM(COALESCE(${VOL_MIN},0)) AS volume_min,
              ${VOLUME_MAX} AS volume_max,
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

/** One ticker's congressional aggregate, over everything or a trade-date window. */
export async function getTickerDetail(ticker: string, days?: number) {
  const rows = await getTickers(days, 5000);
  return rows.find((r) => r.ticker === ticker.toUpperCase()) ?? null;
}

/**
 * One industry group's slice of the congressional trades (#55). A NULL
 * `industry_group` is the unclassified remainder — assets with no ticker
 * (Treasuries, funds), symbols EDGAR lists no SIC for (ETF trusts), and
 * issuers the fill has not reached — reported as a row of its own so the
 * groups never sum to more than they describe. Volume is the usual bracket
 * arithmetic: a floor, a ceiling that is NULL once any row is open-ended,
 * and a midpoint estimate.
 */
export type SectorRow = {
  industry_group: string | null;
  politicians: number;
  trades: number;
  tickers: number;
  buys: number;
  sells: number;
  volume_min: number;
  volume_max: number | null;
  volume_mid: number;
  /** Rows transcribed from scans: in `trades`, not in any volume. */
  transcribed: number;
};

const SECTOR_SELECT = `SELECT s.industry_group,
              COUNT(DISTINCT t.politician_id) AS politicians,
              COUNT(*) AS trades,
              COUNT(DISTINCT t.ticker) AS tickers,
              SUM(t.action='purchase') AS buys,
              SUM(t.action IN ('sale','sale_partial')) AS sells,
              SUM(COALESCE(${VOL_MIN},0)) AS volume_min,
              ${VOLUME_MAX} AS volume_max,
              SUM(COALESCE(${MID},0)) AS volume_mid,
              SUM(${TRANSCRIBED}) AS transcribed
       FROM transactions t
       JOIN filings f ON f.id = t.filing_id
       LEFT JOIN politicians p ON p.id = t.politician_id
       ${SECTOR_JOIN}`;

/** Every trade of one member, by industry group — the whole record, never a
 *  page slice. Empty when the database predates the issuer tables. */
export async function getPoliticianSectors(member: string): Promise<SectorRow[]> {
  const db = await getDb();
  if (!hasIssuerTables(db)) return [];
  return db
    .prepare(
      `${SECTOR_SELECT}
       WHERE f.status IN ${COUNTED} AND COALESCE(p.full_name, f.filer_name) = ?
       GROUP BY s.industry_group
       ORDER BY s.industry_group IS NULL, trades DESC, volume_mid DESC`
    )
    .all(member) as SectorRow[];
}

/** Members and trades per industry group inside the window, over rows that
 *  carry a ticker — the same population as `getTickers`. */
export async function getSectorLeaderboard(days?: number): Promise<SectorRow[]> {
  const db = await getDb();
  if (!hasIssuerTables(db)) return [];
  return db
    .prepare(
      `${SECTOR_SELECT}
       WHERE f.status IN ${COUNTED} AND t.ticker IS NOT NULL AND t.ticker != ''
       ${sinceClause(days)}
       GROUP BY s.industry_group
       ORDER BY s.industry_group IS NULL, politicians DESC, trades DESC`
    )
    .all() as SectorRow[];
}

export type TickerMemberRow = {
  member_name: string;
  /** The roster's id, for the member's portrait; NULL for an unmatched filer. */
  bioguide_id?: string | null;
  party: string | null;
  state: string | null;
  district: string | null;
  chamber: string | null;
  trades: number;
  buys: number;
  sells: number;
  volume_min: number;
  /** NULL when any trade sits in the open-ended top bracket. */
  volume_max: number | null;
  volume_mid: number;
  transcribed: number;
  last_tx_date: string | null;
};

/**
 * The members behind one ticker's trades, each with their own disclosed
 * range. Grouped on the display name like `getPoliticians`, so an unmatched
 * filing still appears under the name printed on the PDF. This is the
 * congressional side of the issuer page's cross-link and must stay a view of
 * these tables alone — the Form 4 books are shown beside it, never in it.
 */
export async function getTickerMembers(ticker: string, days?: number, limit = 40): Promise<TickerMemberRow[]> {
  const db = await getDb();
  return db
    .prepare(
      `SELECT COALESCE(p.full_name, f.filer_name) AS member_name,
              p.party, p.state, p.district, p.chamber,
              MAX(p.bioguide_id) AS bioguide_id,
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
       LEFT JOIN politicians p ON p.id = t.politician_id
       WHERE f.status IN ${COUNTED} AND t.ticker = ?
       ${sinceClause(days)}
       GROUP BY member_name
       ORDER BY volume_mid DESC, trades DESC
       LIMIT ?`
    )
    .all(ticker.toUpperCase(), limit) as TickerMemberRow[];
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
  /** The last pipeline runs, newest first — at most RUNS_SHOWN of the
   *  twenty `pipeline.record_run` keeps in `sync_state.recent_runs`. */
  runs: PipelineRun[];
};

/** One entry of the run log `pipeline.run` writes; mirrors `RunTally.entry`. */
export type PipelineRun = {
  started: string;
  finished: string | null;
  duration_s: number | null;
  filings_parsed: number;
  alerts_sent: number;
  scans_transcribed: number;
  insiders_stored: number;
  outcome: "ok" | "failed";
  error: string | null;
};

export const RUNS_SHOWN = 10;

/**
 * The run log, newest first. A value that is not a JSON list, or an entry
 * without a start time, is dropped rather than rendered: the page must not
 * fail on a log a newer pipeline wrote in a shape this build does not know.
 */
export function parseRecentRuns(raw: string | null): PipelineRun[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const runs: PipelineRun[] = [];
  for (const r of parsed) {
    if (!r || typeof r !== "object" || typeof (r as { started?: unknown }).started !== "string") continue;
    const e = r as Record<string, unknown>;
    runs.push({
      started: e.started as string,
      finished: typeof e.finished === "string" ? e.finished : null,
      duration_s: typeof e.duration_s === "number" ? e.duration_s : null,
      filings_parsed: count(e.filings_parsed),
      alerts_sent: count(e.alerts_sent),
      scans_transcribed: count(e.scans_transcribed),
      insiders_stored: count(e.insiders_stored),
      outcome: e.outcome === "ok" ? "ok" : "failed",
      error: typeof e.error === "string" ? e.error : null,
    });
  }
  return runs;
}

function count(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Median hours between consecutive logged runs, or null with fewer than two.
 * The cron asks for a run every 90 minutes; this is what GitHub delivered.
 */
export function medianGapHours(runs: PipelineRun[]): number | null {
  const times = runs
    .map((r) => Date.parse(r.started))
    .filter((t) => !Number.isNaN(t))
    .sort((a, b) => a - b);
  if (times.length < 2) return null;
  const gaps = times.slice(1).map((t, i) => (t - times[i]) / 3_600_000).sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  return gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
}

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
  // When the pipeline last ran, not when a filing last changed: a run that
  // finds nothing new still writes sync_state, so a quiet night is not
  // "stale". Same source as /api/health (lib/health.ts). Filings are the
  // fallback for a database written before sync_state existed.
  const last = db
    .prepare(
      `SELECT COALESCE((SELECT MAX(updated_at) FROM sync_state),
                       (SELECT MAX(updated_at) FROM filings)) AS t`
    )
    .get() as { t: string | null };
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
  const runLog = db.prepare("SELECT value FROM sync_state WHERE key = 'recent_runs'").get() as
    | { value: string | null }
    | undefined;

  return {
    byStatus,
    byMethod,
    totals,
    senateStatus: senate?.value ?? null,
    lastUpdated: last?.t ?? null,
    failures,
    coverage,
    transcribed,
    runs: parseRecentRuns(runLog?.value ?? null).slice(0, RUNS_SHOWN),
  };
}

/* --------------------------------------------------------- late disclosures */
//
// `/rankings?view=late`. Everything here is a re-cut of the measure the
// politicians tiles already report — trade date → filing date, more than 45
// days — so each query must reconcile with `getPoliticianTotals` (see
// late.test.ts). The report's "Notification Date" column is never used: it
// reads 0 for a member trading their own account.

export type LateMemberRow = {
  member_name: string;
  party: string | null;
  state: string | null;
  district: string | null;
  chamber: string | null;
  /** Every counted trade by the member, late or not. */
  trades: number;
  late_count: number;
  /** Distinct filings that carried at least one late trade. */
  late_filings: number;
  /** Longest trade → filing delay among the late trades, in days. */
  worst_delay: number;
  /** Mean delay of the late trades only. */
  avg_late_delay: number;
  last_late_filing: string | null;
  /** The roster's id, for the member's portrait; NULL for an unmatched filer. */
  bioguide_id?: string | null;
};

/**
 * Members ranked by trades disclosed past the deadline, worst delay as the
 * tie-break. Grouped on the display name like `getPoliticians`, so the sum
 * of `late_count` over every row is exactly the tiles' `late_trades` and the
 * row count their `members_late`: the ranking and the tiles are one measure.
 */
export async function getLateMembers(limit = 60): Promise<LateMemberRow[]> {
  const db = await getDb();
  return db
    .prepare(
      `SELECT COALESCE(p.full_name, f.filer_name) AS member_name,
              p.party, p.state, p.district, p.chamber,
              MAX(p.bioguide_id) AS bioguide_id,
              COUNT(*) AS trades,
              SUM(CASE WHEN ${LATE} THEN 1 ELSE 0 END) AS late_count,
              COUNT(DISTINCT CASE WHEN ${LATE} THEN f.id END) AS late_filings,
              MAX(CASE WHEN ${LATE} THEN ${DELAY} END) AS worst_delay,
              AVG(CASE WHEN ${LATE} THEN ${DELAY} END) AS avg_late_delay,
              MAX(CASE WHEN ${LATE} THEN f.filing_date END) AS last_late_filing
       FROM transactions t
       JOIN filings f ON f.id = t.filing_id
       LEFT JOIN politicians p ON p.id = t.politician_id
       WHERE f.status IN ${COUNTED}
       GROUP BY member_name
       HAVING late_count > 0
       ORDER BY late_count DESC, worst_delay DESC, member_name
       LIMIT ?`
    )
    .all(limit) as LateMemberRow[];
}

export type LateMonthRow = {
  /** YYYY-MM of the filing date. */
  month: string;
  filings: number;
  trades: number;
  late_trades: number;
  late_filings: number;
  members_late: number;
};

/**
 * Late share by month of *filing*, not of trade. A trade made last month
 * cannot be late yet, and the ones that will be are not in the database
 * until they are filed, so a series on trade month would always show the
 * recent months as cleaner than they are. A month's filings are complete
 * once the month is over. Sums to the same `late_trades` as the tiles.
 */
export async function getLateMonthly(): Promise<LateMonthRow[]> {
  const db = await getDb();
  return db
    .prepare(
      `SELECT substr(f.filing_date, 1, 7) AS month,
              COUNT(DISTINCT f.id) AS filings,
              COUNT(*) AS trades,
              SUM(CASE WHEN ${LATE} THEN 1 ELSE 0 END) AS late_trades,
              COUNT(DISTINCT CASE WHEN ${LATE} THEN f.id END) AS late_filings,
              COUNT(DISTINCT CASE WHEN ${LATE} THEN COALESCE(p.full_name, f.filer_name) END)
                AS members_late
       FROM transactions t
       JOIN filings f ON f.id = t.filing_id
       LEFT JOIN politicians p ON p.id = t.politician_id
       WHERE f.status IN ${COUNTED} AND f.filing_date IS NOT NULL
       GROUP BY month
       ORDER BY month`
    )
    .all() as LateMonthRow[];
}

export type LateTotals = {
  trades: number;
  filings: number;
  late_trades: number;
  /** Filings with at least one late trade. */
  late_filings: number;
  /** Filings whose every trade was late — the ones the Telegram message
   *  leads with "late by N days" for. */
  all_late_filings: number;
  worst_delay: number | null;
};

/** Headline figures for the late view, over the whole dataset. */
export async function getLateTotals(): Promise<LateTotals> {
  const db = await getDb();
  return db
    .prepare(
      `WITH per_filing AS (
         SELECT f.id,
                COUNT(*) AS trades,
                SUM(CASE WHEN ${LATE} THEN 1 ELSE 0 END) AS late,
                MAX(${DELAY}) AS worst
         FROM transactions t
         JOIN filings f ON f.id = t.filing_id
         WHERE f.status IN ${COUNTED}
         GROUP BY f.id
       )
       SELECT COALESCE(SUM(trades), 0) AS trades,
              COUNT(*) AS filings,
              COALESCE(SUM(late), 0) AS late_trades,
              COALESCE(SUM(late > 0), 0) AS late_filings,
              COALESCE(SUM(late = trades), 0) AS all_late_filings,
              MAX(worst) AS worst_delay
       FROM per_filing`
    )
    .get() as LateTotals;
}

export type LateTradeRow = TransactionRow & {
  filing_id: number;
  /** Never NULL here: a row is only selected when its delay is past the deadline. */
  delay_days: number;
};

export type LateFiling = {
  filing_id: number;
  doc_id: string;
  chamber: string | null;
  member_name: string;
  /** The roster's id, for the member's URL; NULL for an unmatched filer. */
  bioguide_id: string | null;
  party: string | null;
  state: string | null;
  district: string | null;
  filing_date: string | null;
  pdf_url: string;
  /** Every row in the filing, late or not. */
  trades: number;
  /** The rows past the deadline, longest delay first. */
  late: LateTradeRow[];
};

/**
 * The newest filings that disclose a trade past the deadline, each with its
 * late rows and each row's own delay — the evidence behind the counts.
 * `limit` counts filings, not rows: a filing's late rows are never cut.
 */
export async function getLateFilings(limit = 25): Promise<LateFiling[]> {
  const db = await getDb();
  const rows = db
    .prepare(
      `WITH late_filings AS (
         SELECT f.id
         FROM transactions t
         JOIN filings f ON f.id = t.filing_id
         WHERE f.status IN ${COUNTED} AND ${LATE}
         GROUP BY f.id
         ORDER BY f.filing_date DESC, f.id DESC
         LIMIT ?
       )
       SELECT t.id, t.tx_date, t.notification_date, t.action, t.ticker, t.asset_name,
              t.asset_type, t.owner, t.amount_min_cents, t.amount_max_cents,
              t.amount_exact_cents,
              COALESCE(p.full_name, f.filer_name) AS member_name,
              p.party, p.state, p.district, p.bioguide_id,
              COALESCE(p.chamber, f.chamber) AS chamber,
              f.pdf_url, f.filing_date,
              ${DELAY} AS delay_days,
              ${LAG} AS lag_days,
              CASE WHEN julianday(t.notification_date) < julianday(t.tx_date)
                   THEN 1 ELSE 0 END AS dates_inconsistent,
              ${TRANSCRIBED} AS transcribed,
              f.doc_id,
              f.id AS filing_id,
              (SELECT COUNT(*) FROM transactions x WHERE x.filing_id = f.id) AS filing_trades
       FROM transactions t
       JOIN filings f ON f.id = t.filing_id
       LEFT JOIN politicians p ON p.id = t.politician_id
       WHERE f.id IN (SELECT id FROM late_filings) AND ${LATE}
       ORDER BY f.filing_date DESC, f.id DESC, delay_days DESC, t.id`
    )
    .all(limit) as (LateTradeRow & { filing_trades: number })[];

  const out: LateFiling[] = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    if (last && last.filing_id === r.filing_id) {
      last.late.push(r);
      continue;
    }
    out.push({
      filing_id: r.filing_id,
      doc_id: r.doc_id,
      chamber: r.chamber,
      member_name: r.member_name,
      bioguide_id: r.bioguide_id ?? null,
      party: r.party,
      state: r.state,
      district: r.district,
      filing_date: r.filing_date,
      pdf_url: r.pdf_url,
      trades: r.filing_trades,
      late: [r],
    });
  }
  return out;
}

/* ------------------------------------------------------------- committees */

/**
 * Whether a table exists. The committee tables (#56) arrive with schema
 * version 10, which the pipeline applies on its next run; until then the
 * committed database the dashboard fetches has no such table, and a member
 * page must render without committees rather than as an error.
 */
export function hasTable(db: import("better-sqlite3").Database, name: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    undefined
  );
}

export type CommitteeRow = {
  thomas_id: string;
  /** Set on a subcommittee; the full committee's id. */
  parent_id: string | null;
  parent_name: string | null;
  chamber: "house" | "senate" | "joint";
  name: string;
  house_committee_id: string | null;
  senate_committee_id: string | null;
  url: string | null;
  jurisdiction: string | null;
  jurisdiction_source: string | null;
};

/** One member's seat on one committee or subcommittee. */
export type CommitteeSeatRow = {
  thomas_id: string;
  name: string;
  chamber: "house" | "senate" | "joint";
  parent_id: string | null;
  parent_name: string | null;
  /** Seniority within the member's side; 1 is the chair or ranking member. */
  rank: number | null;
  /** 'majority' | 'minority' — the side, not D/R. */
  side: string | null;
  title: string | null;
  /** Only joint committees say which chamber a seat is held for. */
  seat_chamber: string | null;
};

/**
 * The committees a member sits on, in the current Congress. Keyed on the
 * display name like every other member query. Full committees come first,
 * each followed by the subcommittees under it that the member also sits on.
 */
export async function getPoliticianCommittees(member: string): Promise<CommitteeSeatRow[]> {
  const db = await getDb();
  if (!hasTable(db, "committee_members")) return [];
  return db
    .prepare(
      `SELECT c.thomas_id, c.name, c.chamber, c.parent_id, pc.name AS parent_name,
              cm.rank, cm.party AS side, cm.title, cm.chamber AS seat_chamber
       FROM committee_members cm
       JOIN committees c ON c.thomas_id = cm.committee_id
       LEFT JOIN committees pc ON pc.thomas_id = c.parent_id
       JOIN politicians p ON p.id = cm.politician_id
       WHERE p.full_name = ?
       ORDER BY COALESCE(c.parent_id, c.thomas_id), c.parent_id IS NOT NULL, c.name`
    )
    .all(member) as CommitteeSeatRow[];
}

export async function getCommittee(id: string): Promise<CommitteeRow | null> {
  const db = await getDb();
  if (!hasTable(db, "committees")) return null;
  const row = db
    .prepare(
      `SELECT c.thomas_id, c.parent_id, pc.name AS parent_name, c.chamber, c.name,
              c.house_committee_id, c.senate_committee_id, c.url, c.jurisdiction,
              c.jurisdiction_source
       FROM committees c
       LEFT JOIN committees pc ON pc.thomas_id = c.parent_id
       WHERE c.thomas_id = ?`
    )
    .get(id.toUpperCase()) as CommitteeRow | undefined;
  return row ?? null;
}

export type SubcommitteeRow = { thomas_id: string; name: string; members: number };

export async function getSubcommittees(id: string): Promise<SubcommitteeRow[]> {
  const db = await getDb();
  if (!hasTable(db, "committees")) return [];
  return db
    .prepare(
      `SELECT c.thomas_id, c.name, COUNT(cm.politician_id) AS members
       FROM committees c
       LEFT JOIN committee_members cm ON cm.committee_id = c.thomas_id
       WHERE c.parent_id = ?
       GROUP BY c.thomas_id
       ORDER BY c.name`
    )
    .all(id.toUpperCase()) as SubcommitteeRow[];
}

export type CommitteeMemberRow = PoliticianRow & {
  bioguide_id: string | null;
  rank: number | null;
  side: string | null;
  title: string | null;
  seat_chamber: string | null;
};

/**
 * Every seat on one committee with the holder's trading totals — the whole
 * record of each member, aggregated the way `getPoliticianDetail` does (by
 * display name), so a member's figures agree between the two pages. Members
 * with no disclosed trades are listed too, with zeros: an empty row is a
 * fact about the committee, not something to hide. Traders first, then the
 * rest in roster order (majority side, then rank).
 */
export async function getCommitteeMembers(id: string): Promise<CommitteeMemberRow[]> {
  const db = await getDb();
  if (!hasTable(db, "committee_members")) return [];
  return db
    .prepare(
      `WITH seats AS (
         SELECT cm.politician_id, cm.rank, cm.party AS side, cm.title, cm.chamber AS seat_chamber,
                p.full_name AS member_name, p.bioguide_id, p.party, p.state, p.district, p.chamber
         FROM committee_members cm
         JOIN politicians p ON p.id = cm.politician_id
         WHERE cm.committee_id = ?
       ),
       totals AS (
         SELECT COALESCE(p.full_name, f.filer_name) AS member_name,
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
         WHERE f.status IN ${COUNTED}
           AND COALESCE(p.full_name, f.filer_name) IN (SELECT member_name FROM seats)
         GROUP BY member_name
       )
       SELECT s.member_name, s.bioguide_id, s.party, s.state, s.district, s.chamber,
              s.rank, s.side, s.title, s.seat_chamber,
              COALESCE(x.trades, 0) AS trades,
              COALESCE(x.tickers, 0) AS tickers,
              COALESCE(x.buys, 0) AS buys,
              COALESCE(x.sells, 0) AS sells,
              COALESCE(x.volume_mid, 0) AS volume_mid,
              COALESCE(x.transcribed, 0) AS transcribed,
              x.avg_delay, x.avg_lag,
              COALESCE(x.late_count, 0) AS late_count
       FROM seats s
       LEFT JOIN totals x ON x.member_name = s.member_name
       ORDER BY volume_mid DESC, trades DESC, s.side, s.rank, s.member_name`
    )
    .all(id.toUpperCase()) as CommitteeMemberRow[];
}

/* --------------------------------------------------------- weekly activity */
//
// The feed's stat tiles: what arrived per week, bucketed on FILING date in
// rolling 7-day steps back from now (the same buckets as the alert tiles).
// Filing date, not trade date, because the 45-day disclosure window leaves
// the latest trade-date weeks only part-filled — a trade-date trend would
// always appear to be falling off. Counts only: no volume is summed here.

export type WeeklyActivity = {
  weeks: number;
  /** Oldest → newest; the last entry is the most recent 7 days. */
  trades: number[];
  filings: number[];
  /** Over the whole window — distinct across it, never summed per week. */
  window: { trades: number; filings: number; members: number; tickers: number };
  /** Trades disclosed in the equal window before it, or null when the corpus
   *  does not reach back that far: a part-covered period is no baseline. */
  priorTrades: number | null;
};

export async function getWeeklyActivity(weeks = 12): Promise<WeeklyActivity> {
  const db = await getDb();
  const days = Math.floor(weeks) * 7;
  const bucket = `CAST((julianday('now') - julianday(f.filing_date)) / 7 AS INTEGER)`;
  const inRange = `julianday(f.filing_date) <= julianday('now')
       AND julianday(f.filing_date) > julianday('now') - ?`;
  type Bucket = { weeks_ago: number; n: number };
  const tradeRows = db
    .prepare(
      `SELECT ${bucket} AS weeks_ago, COUNT(*) AS n
       FROM transactions t JOIN filings f ON f.id = t.filing_id
       WHERE f.status IN ${COUNTED} AND ${inRange}
       GROUP BY weeks_ago`
    )
    .all(days * 2) as Bucket[];
  const filingRows = db
    .prepare(
      `SELECT ${bucket} AS weeks_ago, COUNT(*) AS n
       FROM filings f
       WHERE f.status IN ${COUNTED} AND ${inRange}
       GROUP BY weeks_ago`
    )
    .all(days) as Bucket[];
  const distinct = db
    .prepare(
      `SELECT COUNT(DISTINCT t.politician_id) AS members,
              COUNT(DISTINCT CASE WHEN t.ticker != '' THEN t.ticker END) AS tickers
       FROM transactions t JOIN filings f ON f.id = t.filing_id
       WHERE f.status IN ${COUNTED} AND ${inRange}`
    )
    .get(days) as { members: number; tickers: number };
  const covered = db
    .prepare(
      `SELECT MIN(f.filing_date) <= date('now', '-${days * 2} day') AS ok
       FROM filings f WHERE f.status IN ${COUNTED}`
    )
    .get() as { ok: number | null };

  const series = (rows: Bucket[]) => {
    const out = new Array<number>(weeks).fill(0);
    for (const r of rows) if (r.weeks_ago >= 0 && r.weeks_ago < weeks) out[weeks - 1 - r.weeks_ago] = r.n;
    return out;
  };
  const trades = series(tradeRows);
  const filings = series(filingRows);
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const prior = sum(tradeRows.filter((r) => r.weeks_ago >= weeks && r.weeks_ago < weeks * 2).map((r) => r.n));

  return {
    weeks,
    trades,
    filings,
    window: { trades: sum(trades), filings: sum(filings), ...distinct },
    priorTrades: covered?.ok ? prior : null,
  };
}
