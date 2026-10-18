/**
 * The few lookups the public API needs that the pages do not: resolving a
 * Bioguide ID to the display name every member query is keyed on, and the
 * live coverage figures for llms-full.txt and /methodology. No amount
 * arithmetic lives here — totals come from `queries.ts`.
 */

import { getDb } from "./db";
import { COUNTED, TRANSCRIBED } from "./queries";
import type { Coverage } from "./methodology";

export type MemberIdentity = {
  member_name: string;
  bioguide_id: string;
};

/**
 * The display name a Bioguide ID trades under — `COALESCE(p.full_name,
 * f.filer_name)` for a matched filing is the roster's `full_name`, which is
 * what `getPoliticianDetail` and the feed's `member` filter compare against.
 */
export async function getMemberByBioguide(id: string): Promise<MemberIdentity | null> {
  const db = await getDb();
  const row = db
    .prepare("SELECT full_name AS member_name, bioguide_id FROM politicians WHERE bioguide_id = ?")
    .get(id) as MemberIdentity | undefined;
  return row ?? null;
}

/** Time of the last pipeline write, ISO 8601 — `meta.data_as_of`. */
export async function getDataAsOf(): Promise<string | null> {
  const db = await getDb();
  const row = db.prepare("SELECT MAX(updated_at) AS t FROM filings").get() as { t: string | null };
  return row.t;
}

/** Coverage over counted filings only — what the API and the pages report on. */
export async function getCoverage(): Promise<Coverage> {
  const db = await getDb();
  const filings = db
    .prepare(
      `SELECT COUNT(*) AS filings,
              COALESCE(SUM(chamber = 'house'), 0) AS filings_house,
              COALESCE(SUM(chamber = 'senate'), 0) AS filings_senate,
              MIN(filing_date) AS first_filing_date,
              MAX(filing_date) AS last_filing_date
       FROM filings WHERE status IN ${COUNTED}`
    )
    .get() as Pick<
    Coverage["congress"],
    "filings" | "filings_house" | "filings_senate" | "first_filing_date" | "last_filing_date"
  >;
  const trades = db
    .prepare(
      `SELECT COUNT(*) AS trades,
              COUNT(DISTINCT COALESCE(p.full_name, f.filer_name)) AS members,
              COUNT(DISTINCT CASE WHEN t.ticker != '' THEN t.ticker END) AS tickers,
              COALESCE(SUM(${TRANSCRIBED}), 0) AS transcribed_trades,
              MIN(t.tx_date) AS first_trade_date,
              MAX(t.tx_date) AS last_trade_date
       FROM transactions t
       JOIN filings f ON f.id = t.filing_id
       LEFT JOIN politicians p ON p.id = t.politician_id
       WHERE f.status IN ${COUNTED}`
    )
    .get() as Pick<
    Coverage["congress"],
    "trades" | "members" | "tickers" | "transcribed_trades" | "first_trade_date" | "last_trade_date"
  >;
  const unreadable = db.prepare("SELECT COUNT(*) AS n FROM filings WHERE status = 'failed'").get() as { n: number };
  const asOf = db.prepare("SELECT MAX(updated_at) AS t FROM filings").get() as { t: string | null };

  let insiders: Coverage["insiders"] = null;
  try {
    // "Insiders" are primary reporting owners, as on every insider view.
    insiders = db
      .prepare(
        `SELECT COUNT(DISTINCT f.id) AS filings,
                COUNT(*) AS trades,
                COUNT(DISTINCT f.issuer_cik) AS issuers,
                COUNT(DISTINCT o.insider_cik) AS insiders,
                MIN(t.tx_date) AS first_trade_date,
                MAX(t.tx_date) AS last_trade_date
         FROM insider_transactions t
         JOIN insider_filings f ON f.id = t.filing_id
         LEFT JOIN insider_filing_owners o ON o.filing_id = f.id AND o.owner_index = 0
         WHERE f.status IN ${COUNTED}`
      )
      .get() as NonNullable<Coverage["insiders"]>;
  } catch {
    /* a database from before the insider source */
  }

  return {
    generated_at: new Date().toISOString(),
    data_as_of: asOf.t,
    congress: { ...filings, ...trades, unreadable_filings: unreadable.n },
    insiders,
  };
}
