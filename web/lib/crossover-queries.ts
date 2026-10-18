import { getDb } from "./db";
import { COUNTED, sinceClause } from "./queries";

/**
 * Where members of Congress and corporate insiders traded the same ticker.
 *
 * Two populations, two sets of books. Each side is aggregated on its own —
 * one CTE per table, grouped by ticker and direction — and only the finished
 * per-ticker counts are set beside each other. Nothing from one table enters
 * a figure that describes the other (CLAUDE.md: the insider tables are never
 * joined into politician aggregates; the issue that asked for this view asks
 * for them side by side). There is deliberately no shared total.
 *
 * The match is the listed symbol alone. `insider_filings.ticker` is NULL for
 * the NONE / N/A placeholders, so a filing without a symbol can never pair
 * with a member trade; a member row with no ticker (Treasuries, funds) is
 * excluded the same way.
 *
 * Both windows are on trade date, bounded at today like every other window
 * here. The two sides fill at different speeds: Form 4 is due in two business
 * days, the STOCK Act allows 45, so the member side of the most recent weeks
 * is still arriving.
 */

export type BothSidesRow = {
  ticker: string;
  direction: "buy" | "sell";
  asset_name: string | null;
  issuer_name: string | null;
  /** Distinct members who traded this way — the congressional books only. */
  members: number;
  member_trades: number;
  member_last: string | null;
  /** Distinct primary reporting owners (owner_index = 0) — the Form 4 books only. */
  insiders: number;
  insider_filings: number;
  insider_trades: number;
  insider_last: string | null;
};

const MEMBER_SIDE = (days: number) => `
  SELECT t.ticker,
         CASE WHEN t.action = 'purchase' THEN 'buy' ELSE 'sell' END AS direction,
         MIN(t.asset_name) AS asset_name,
         COUNT(DISTINCT t.politician_id) AS members,
         COUNT(*) AS trades,
         MAX(t.tx_date) AS last_tx
  FROM transactions t
  JOIN filings f ON f.id = t.filing_id
  WHERE f.status IN ${COUNTED}
    AND t.ticker IS NOT NULL AND t.ticker != ''
    AND t.action IN ('purchase', 'sale', 'sale_partial')
    ${sinceClause(days)}
  GROUP BY t.ticker, direction`;

const INSIDER_SIDE = (days: number) => `
  SELECT f.ticker,
         CASE WHEN t.action = 'purchase' THEN 'buy' ELSE 'sell' END AS direction,
         MIN(f.issuer_name) AS issuer_name,
         COUNT(DISTINCT o.insider_cik) AS insiders,
         COUNT(DISTINCT f.id) AS filings,
         COUNT(*) AS trades,
         MAX(t.tx_date) AS last_tx
  FROM insider_transactions t
  JOIN insider_filings f ON f.id = t.filing_id
  LEFT JOIN insider_filing_owners o ON o.filing_id = f.id AND o.owner_index = 0
  WHERE f.status IN ${COUNTED}
    AND f.ticker IS NOT NULL
    AND t.action IN ('purchase', 'sale')
    ${sinceClause(days)}
  GROUP BY f.ticker, direction`;

/**
 * Tickers where both sides traded the same direction inside the window.
 * Members are the scarce side — most issuers in the Form 4 tables have
 * insiders by construction — so the list ranks on members first.
 */
export async function getBothSides(days = 30, limit = 12): Promise<BothSidesRow[]> {
  const db = await getDb();
  return db
    .prepare(
      `WITH m AS (${MEMBER_SIDE(days)}), i AS (${INSIDER_SIDE(days)})
       SELECT m.ticker, m.direction, m.asset_name, i.issuer_name,
              m.members, m.trades AS member_trades, m.last_tx AS member_last,
              i.insiders, i.filings AS insider_filings, i.trades AS insider_trades,
              i.last_tx AS insider_last
       FROM m JOIN i ON i.ticker = m.ticker AND i.direction = m.direction
       ORDER BY m.members DESC, i.insiders DESC, m.ticker
       LIMIT ?`
    )
    .all(limit) as BothSidesRow[];
}

export type SharedTickers = {
  /** Listed symbols traded by at least one member and one insider in the window. */
  tickers: number;
  /** Of those, symbols where some member and some insider traded the same way. */
  same_direction: number;
};

/** The size of the overlap, counted over the whole window rather than the rows a card shows. */
export async function getSharedTickers(days = 30): Promise<SharedTickers> {
  const db = await getDb();
  return db
    .prepare(
      `WITH m AS (${MEMBER_SIDE(days)}), i AS (${INSIDER_SIDE(days)})
       SELECT (SELECT COUNT(*) FROM (SELECT DISTINCT m.ticker FROM m JOIN i ON i.ticker = m.ticker)) AS tickers,
              (SELECT COUNT(*) FROM (SELECT DISTINCT m.ticker FROM m
                 JOIN i ON i.ticker = m.ticker AND i.direction = m.direction)) AS same_direction`
    )
    .get() as SharedTickers;
}
