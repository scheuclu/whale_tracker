import { getDb } from "./db";
import { COUNTED } from "./queries";

/**
 * Corporate insiders as people: one row per primary reporting owner
 * (`owner_index = 0`, as everywhere "insiders" is counted — a joint filing is
 * one decision), across every issuer they filed for. Values are shares ×
 * price as filed; an implausible row is counted as a trade and in no value,
 * exactly as `insider-queries.ts` does. Never joined to the congressional
 * tables (CLAUDE.md, "SEC Form 4").
 */

const FROM = `FROM insider_transactions t
  JOIN insider_filings f ON f.id = t.filing_id
  JOIN insider_filing_owners o ON o.filing_id = f.id AND o.owner_index = 0
  JOIN insiders i ON i.cik = o.insider_cik`;

const VALUE = `CASE WHEN t.implausible IS NOT 1 THEN t.amount_exact_cents END`;

const AGGREGATE = `COUNT(DISTINCT f.id) AS filings,
       COUNT(*) AS trades,
       SUM(t.action = 'purchase') AS buys,
       SUM(t.action = 'sale') AS sells,
       COALESCE(SUM(CASE WHEN t.action = 'purchase' THEN ${VALUE} END), 0) AS bought,
       COALESCE(SUM(CASE WHEN t.action = 'sale' THEN ${VALUE} END), 0) AS sold,
       SUM(t.action = 'purchase' AND (${VALUE}) IS NULL) AS unpriced_buys,
       SUM(t.action = 'sale' AND (${VALUE}) IS NULL) AS unpriced_sells,
       MIN(t.tx_date) AS first_tx_date,
       MAX(t.tx_date) AS last_tx_date`;

export type InsiderPerson = {
  cik: string;
  name: string;
  filings: number;
  trades: number;
  buys: number;
  sells: number;
  /** Shares × reported price; a partial sum when `unpriced_*` > 0. */
  bought: number;
  sold: number;
  unpriced_buys: number;
  unpriced_sells: number;
  first_tx_date: string | null;
  last_tx_date: string | null;
  issuers: number;
  /** The role on their most recent filing. */
  is_director: number;
  is_officer: number;
  is_ten_percent_owner: number;
  officer_title: string | null;
  /** The issuer of their most recent filing. */
  latest_ticker: string | null;
  latest_issuer: string | null;
};

const LATEST = `(SELECT x.{col} FROM insider_filing_owners x JOIN insider_filings y ON y.id = x.filing_id
   WHERE x.insider_cik = i.cik AND x.owner_index = 0 AND y.status IN ${COUNTED}
   ORDER BY y.filing_date DESC, y.id DESC LIMIT 1)`;
const LATEST_FILING = `(SELECT y.{col} FROM insider_filing_owners x JOIN insider_filings y ON y.id = x.filing_id
   WHERE x.insider_cik = i.cik AND x.owner_index = 0 AND y.status IN ${COUNTED}
   ORDER BY y.filing_date DESC, y.id DESC LIMIT 1)`;

const PERSON_SELECT = `SELECT i.cik, i.name, ${AGGREGATE},
       COUNT(DISTINCT f.issuer_cik) AS issuers,
       ${LATEST.replace("{col}", "is_director")} AS is_director,
       ${LATEST.replace("{col}", "is_officer")} AS is_officer,
       ${LATEST.replace("{col}", "is_ten_percent_owner")} AS is_ten_percent_owner,
       ${LATEST.replace("{col}", "officer_title")} AS officer_title,
       ${LATEST_FILING.replace("{col}", "ticker")} AS latest_ticker,
       ${LATEST_FILING.replace("{col}", "issuer_name")} AS latest_issuer`;

/** One insider's whole record as a primary reporting owner; null when they have none. */
export async function getInsiderPerson(cik: string): Promise<InsiderPerson | null> {
  const db = await getDb();
  const row = db
    .prepare(
      `${PERSON_SELECT}
       ${FROM}
       WHERE f.status IN ${COUNTED} AND i.cik = ?
       GROUP BY i.cik`
    )
    .get(cik) as InsiderPerson | undefined;
  return row ?? null;
}

/** The name an insider last filed under, for the redirect from `/insiders?cik=`. */
export async function getInsiderName(cik: string): Promise<string | null> {
  const db = await getDb();
  const row = db.prepare("SELECT name FROM insiders WHERE cik = ?").get(cik) as { name: string } | undefined;
  return row?.name ?? null;
}

/**
 * Insiders by value traded (bought + sold, shares × reported price), every
 * primary owner over everything or a trade-date window.
 */
export async function getInsiderPeople(limit = 50, days?: number): Promise<InsiderPerson[]> {
  const db = await getDb();
  const since = days ? `AND t.tx_date >= date('now', '-${Math.floor(days)} days') AND t.tx_date <= date('now')` : "";
  return db
    .prepare(
      `${PERSON_SELECT}
       ${FROM}
       WHERE f.status IN ${COUNTED} ${since}
       GROUP BY i.cik
       ORDER BY bought + sold DESC, trades DESC
       LIMIT ?`
    )
    .all(limit) as InsiderPerson[];
}

export type InsiderCompanyRow = {
  issuer_cik: string;
  ticker: string | null;
  issuer_name: string | null;
  filings: number;
  trades: number;
  buys: number;
  sells: number;
  bought: number;
  sold: number;
  unpriced_buys: number;
  unpriced_sells: number;
  first_tx_date: string | null;
  last_tx_date: string | null;
  officer_title: string | null;
  is_director: number;
  is_officer: number;
  is_ten_percent_owner: number;
};

/** The companies one insider filed for, by value traded. */
export async function getInsiderCompanies(cik: string): Promise<InsiderCompanyRow[]> {
  const db = await getDb();
  return db
    .prepare(
      `SELECT f.issuer_cik, MIN(f.ticker) AS ticker, MIN(f.issuer_name) AS issuer_name, ${AGGREGATE},
              MAX(o.officer_title) AS officer_title, MAX(o.is_director) AS is_director,
              MAX(o.is_officer) AS is_officer, MAX(o.is_ten_percent_owner) AS is_ten_percent_owner
       ${FROM}
       WHERE f.status IN ${COUNTED} AND i.cik = ?
       GROUP BY f.issuer_cik
       ORDER BY bought + sold DESC, trades DESC`
    )
    .all(cik) as InsiderCompanyRow[];
}
