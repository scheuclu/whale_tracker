import { getDb } from "./db";
import { COUNTED, DELAY, TRANSCRIBED, hasOptionColumns } from "./queries";

/**
 * One trade as the "when did they trade" timeline plots it (app/timeline.tsx):
 * every counted row of one ticker or one member, no page limit, and only the
 * columns a mark and its tooltip need. Amounts stay the disclosed bracket —
 * the chart sizes a mark by its floor and labels it so; nothing here is
 * summed, so transcribed rows are returned (flagged) rather than filtered:
 * they are trades, just not part of any total.
 */
export type TimelineTrade = {
  id: number;
  tx_date: string | null;
  filing_date: string | null;
  action: string;
  ticker: string | null;
  asset_name: string;
  asset_type: string | null;
  owner: string | null;
  amount_min_cents: number | null;
  amount_max_cents: number | null;
  amount_exact_cents: number | null;
  member_name: string;
  /** The roster's id, for the member's URL; NULL for an unmatched filer. */
  bioguide_id: string | null;
  party: string | null;
  state: string | null;
  district: string | null;
  chamber: string | null;
  pdf_url: string;
  /** Trade → filing, NULL when the dates contradict (see `DELAY`). */
  delay_days: number | null;
  transcribed: number;
  option_kind: string | null;
};

/** Hard ceiling on marks: the busiest member has ~940 rows. */
const TIMELINE_LIMIT = 3000;

export async function getTimelineTrades(opts: { ticker?: string; member?: string }): Promise<TimelineTrade[]> {
  if (!opts.ticker && !opts.member) return [];
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
  params.push(TIMELINE_LIMIT);
  return db
    .prepare(
      `SELECT t.id, t.tx_date, f.filing_date, t.action, t.ticker, t.asset_name,
              t.asset_type, t.owner, t.amount_min_cents, t.amount_max_cents,
              t.amount_exact_cents,
              COALESCE(p.full_name, f.filer_name) AS member_name,
              p.party, p.state, p.district, p.chamber, p.bioguide_id,
              f.pdf_url,
              ${DELAY} AS delay_days,
              ${TRANSCRIBED} AS transcribed,
              ${hasOptionColumns(db) ? "t.option_kind" : "NULL AS option_kind"}
       FROM transactions t
       JOIN filings f ON f.id = t.filing_id
       LEFT JOIN politicians p ON p.id = t.politician_id
       WHERE ${where.join(" AND ")}
       ORDER BY t.tx_date, t.id
       LIMIT ?`
    )
    .all(...params) as TimelineTrade[];
}
