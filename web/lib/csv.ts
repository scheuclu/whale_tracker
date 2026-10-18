import type { TransactionRow } from "./queries";

/**
 * CSV export of congressional trades.
 *
 * Amounts are disclosure brackets, so every row carries the floor and the
 * ceiling as two columns and the ceiling is blank for the open-ended top
 * bracket. The one collapsed figure, `amount_midpoint_estimate_usd`, says
 * so in its name and mirrors `MID` in lib/queries.ts: the floor for an
 * open-ended bracket, blank for a row transcribed from a scan. There is no
 * other single-number amount column, and there must not be.
 */

export const TRANSACTION_CSV_COLUMNS = [
  "id",
  "tx_date",
  "filing_date",
  "notification_date",
  "disclosure_delay_days",
  "notification_lag_days",
  "dates_inconsistent",
  "action",
  "ticker",
  "asset_name",
  "asset_type",
  "owner",
  "amount_min_usd",
  "amount_max_usd",
  "amount_exact_usd",
  "amount_open_ended",
  "amount_midpoint_estimate_usd",
  "transcribed_from_scan",
  "member_name",
  "party",
  "state",
  "district",
  "chamber",
  "pdf_url",
  "doc_id",
] as const;

export type TransactionCsvColumn = (typeof TRANSACTION_CSV_COLUMNS)[number];

/** Cents to whole or two-decimal dollars; blank for NULL. */
export function dollars(cents: number | null | undefined): string {
  if (cents == null) return "";
  const d = cents / 100;
  return Number.isInteger(d) ? String(d) : d.toFixed(2);
}

/**
 * One CSV cell (RFC 4180). Quoted when it has to be, and a leading
 * `= + - @` or tab is neutralised with an apostrophe so a spreadsheet never
 * runs an asset name as a formula.
 */
export function csvCell(value: string | number | null | undefined): string {
  if (value == null) return "";
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvLine(cells: (string | number | null | undefined)[]): string {
  return cells.map(csvCell).join(",");
}

/** The row's midpoint estimate — `MID` in lib/queries.ts, in dollars. */
function midpointEstimate(r: TransactionRow): string {
  if (r.transcribed) return "";
  if (r.amount_exact_cents != null) return dollars(r.amount_exact_cents);
  if (r.amount_min_cents == null) return "";
  if (r.amount_max_cents == null) return dollars(r.amount_min_cents);
  return dollars(Math.floor((r.amount_min_cents + r.amount_max_cents) / 2));
}

export function transactionCsvRow(r: TransactionRow): Record<TransactionCsvColumn, string | number | null> {
  const openEnded = !r.transcribed && r.amount_max_cents == null && r.amount_exact_cents == null;
  return {
    id: r.id,
    tx_date: r.tx_date,
    filing_date: r.filing_date,
    notification_date: r.notification_date,
    disclosure_delay_days: r.delay_days,
    notification_lag_days: r.lag_days,
    dates_inconsistent: r.dates_inconsistent ? 1 : 0,
    action: r.action,
    ticker: r.ticker,
    asset_name: r.asset_name,
    asset_type: r.asset_type,
    owner: r.owner,
    amount_min_usd: dollars(r.amount_min_cents),
    amount_max_usd: dollars(r.amount_max_cents),
    amount_exact_usd: dollars(r.amount_exact_cents),
    amount_open_ended: openEnded ? 1 : 0,
    amount_midpoint_estimate_usd: midpointEstimate(r),
    transcribed_from_scan: r.transcribed ? 1 : 0,
    member_name: r.member_name,
    party: r.party,
    state: r.state,
    district: r.district,
    chamber: r.chamber,
    pdf_url: r.pdf_url,
    doc_id: r.doc_id,
  };
}

/** The whole file: header row, then one line per trade, CRLF-terminated. */
export function transactionsCsv(rows: TransactionRow[]): string {
  const lines = [csvLine([...TRANSACTION_CSV_COLUMNS])];
  for (const r of rows) {
    const cells = transactionCsvRow(r);
    lines.push(csvLine(TRANSACTION_CSV_COLUMNS.map((c) => cells[c])));
  }
  return lines.join("\r\n") + "\r\n";
}
