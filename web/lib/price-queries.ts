import type Database from "better-sqlite3";
import { getDb } from "./db";
import { COUNTED } from "./queries";
import type { Close } from "./prices";
import { BENCHMARK } from "./prices";

/**
 * Database side of the price overlay: which symbols the price route will
 * fetch for, the pipeline's stored closes as a fallback, and the Form 4 rows
 * of one symbol for the insider lane. Nothing here sums anything across the
 * two populations.
 */

function hasTable(db: Database.Database, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

/**
 * A symbol the route may fetch for: one a counted congressional trade or a
 * counted Form 4 filing carries, or the benchmark. Anything else is refused
 * before any request goes out — the route is not a general price proxy, and
 * an arbitrary symbol would be an arbitrary cache key.
 */
export function isHeldSymbol(db: Database.Database, symbol: string): boolean {
  if (symbol === BENCHMARK) return true;
  const congress = db
    .prepare(
      `SELECT 1 FROM transactions t JOIN filings f ON f.id = t.filing_id
       WHERE t.ticker = ? AND f.status IN ${COUNTED} LIMIT 1`
    )
    .get(symbol);
  if (congress) return true;
  if (!hasTable(db, "insider_filings")) return false;
  return !!db.prepare(`SELECT 1 FROM insider_filings WHERE ticker = ? AND status IN ${COUNTED} LIMIT 1`).get(symbol);
}

/** The pipeline's stored closes (alerted tickers only, ~2 months), oldest first. */
export function storedCloses(db: Database.Database, symbol: string, from: string): Close[] {
  if (!hasTable(db, "prices")) return [];
  return db
    .prepare("SELECT date, close FROM prices WHERE ticker = ? AND date >= ? ORDER BY date")
    .all(symbol, from) as Close[];
}

/** One Form 4 open-market row of a symbol, with its primary reporting owner. */
export type OverlayInsiderRow = {
  id: number;
  tx_date: string | null;
  action: string;
  shares: number | null;
  price_per_share: number | null;
  amount_exact_cents: number | null;
  implausible: number | null;
  insider_cik: string | null;
  insider_name: string | null;
  is_director: number | null;
  is_officer: number | null;
  is_ten_percent_owner: number | null;
  officer_title: string | null;
};

/** Hard ceiling on insider marks: the busiest issuer has under 800 rows. */
const INSIDER_LIMIT = 3000;

export async function getOverlayInsiderTrades(ticker: string): Promise<OverlayInsiderRow[]> {
  const db = await getDb();
  if (!hasTable(db, "insider_transactions")) return [];
  return db
    .prepare(
      `SELECT t.id, t.tx_date, t.action, t.shares, t.price_per_share, t.amount_exact_cents,
              t.implausible, o.insider_cik, i.name AS insider_name,
              o.is_director, o.is_officer, o.is_ten_percent_owner, o.officer_title
       FROM insider_transactions t
       JOIN insider_filings f ON f.id = t.filing_id
       LEFT JOIN insider_filing_owners o ON o.filing_id = f.id AND o.owner_index = 0
       LEFT JOIN insiders i ON i.cik = o.insider_cik
       WHERE f.status IN ${COUNTED} AND f.ticker = ?
       ORDER BY t.tx_date, t.id
       LIMIT ?`
    )
    .all(ticker.toUpperCase(), INSIDER_LIMIT) as OverlayInsiderRow[];
}
