import { getDb } from "./db";

/**
 * Scanned paper filings captured for inspection (`scan_pages`, `scan_rows`;
 * src/whale/scan_capture.py). The page image is a 1-bit PNG oriented the
 * way the grid reader turned the page, and every row's geometry is in that
 * image's pixels, so an overlay drawn from `scan_rows` lines up with it.
 * Nothing here feeds a statistic.
 */

export type ScanFilingRow = {
  id: number;
  doc_id: string;
  member_name: string;
  party: string | null;
  state: string | null;
  district: string | null;
  filing_date: string | null;
  status: string;
  parse_method: string | null;
  last_error: string | null;
  pdf_url: string;
  pages: number;
  pages_failed: number;
  rows: number;
  unknown_rows: number;
  transactions: number;
};

export type ScanPage = {
  page_no: number;
  width: number;
  height: number;
  dpi: number;
  rotation: number;
  /** Why the page yielded no transactions: the reader could not decompose
   *  it, there is no table on it, or the join refused it (row counts or
   *  disputed types; its rows are then `page_refused`). */
  error: string | null;
};

export type ScanRow = {
  id: number;
  page_no: number;
  row_index: number;
  y0: number;
  y1: number;
  amount_cols: number[];
  type_cols: number[];
  amount_marks: number[];
  type_marks: number[];
  amount_letter: string | null;
  amount_margin: number | null;
  action: string | null;
  type_margin: number | null;
  /**
   * The reader's verdict on the row — `read`, `unknown_amount`,
   * `unknown_type`, `unknown` — or, once the hybrid path has joined the
   * filing (src/whale/scan_capture.py), the join's: `type_disputed` (joined;
   * the model's type reading contradicted the grid's, and the grid's is the
   * one on the transaction) or `page_refused` (read by the grid but not
   * joined: the page's row count disagreed with the model's, so the page
   * was set aside alone and has no transactions — `ScanPage.error` says so).
   */
  status: string;
  transaction_id: number | null;
  asset_name: string | null;
  tx_date: string | null;
  amount_min_cents: number | null;
  amount_max_cents: number | null;
};

const FILINGS = `
  SELECT f.id, f.doc_id, COALESCE(p.full_name, f.filer_name) AS member_name,
         p.party, p.state, p.district, f.filing_date, f.status, f.parse_method,
         f.last_error, f.pdf_url,
         (SELECT COUNT(*) FROM scan_pages s WHERE s.filing_id = f.id) AS pages,
         (SELECT COUNT(*) FROM scan_pages s WHERE s.filing_id = f.id AND s.error IS NOT NULL) AS pages_failed,
         (SELECT COUNT(*) FROM scan_rows r WHERE r.filing_id = f.id) AS rows,
         (SELECT COUNT(*) FROM scan_rows r WHERE r.filing_id = f.id AND r.status != 'read') AS unknown_rows,
         (SELECT COUNT(*) FROM transactions t WHERE t.filing_id = f.id) AS transactions
  FROM filings f LEFT JOIN politicians p ON p.id = f.politician_id
  WHERE f.chamber = 'house' AND f.parse_method IN ('scanned', 'vision', 'vision_failed')`;

/** Every House scan, captured or not, newest filing first. */
export async function getScanFilings(opts: { member?: string } = {}): Promise<ScanFilingRow[]> {
  const db = await getDb();
  const params: unknown[] = [];
  let sql = FILINGS;
  if (opts.member) {
    sql += " AND COALESCE(p.full_name, f.filer_name) = ?";
    params.push(opts.member);
  }
  sql += " ORDER BY f.filing_date DESC, f.id DESC";
  return db.prepare(sql).all(...params) as ScanFilingRow[];
}

type RawScanRow = Omit<ScanRow, "amount_cols" | "type_cols" | "amount_marks" | "type_marks"> & {
  amount_cols: string;
  type_cols: string;
  amount_marks: string;
  type_marks: string;
};

export async function getScanFiling(
  docId: string
): Promise<{ filing: ScanFilingRow; pages: ScanPage[]; rows: ScanRow[] } | null> {
  const db = await getDb();
  const filing = db.prepare(`${FILINGS} AND f.doc_id = ?`).get(docId) as ScanFilingRow | undefined;
  if (!filing) return null;
  const pages = db
    .prepare(
      `SELECT page_no, width, height, dpi, rotation, error FROM scan_pages
       WHERE filing_id = ? ORDER BY page_no`
    )
    .all(filing.id) as ScanPage[];
  const raw = db
    .prepare(
      `SELECT r.id, r.page_no, r.row_index, r.y0, r.y1, r.amount_cols, r.type_cols,
              r.amount_marks, r.type_marks, r.amount_letter, r.amount_margin, r.action,
              r.type_margin, r.status, r.transaction_id,
              t.asset_name, t.tx_date, t.amount_min_cents, t.amount_max_cents
       FROM scan_rows r LEFT JOIN transactions t ON t.id = r.transaction_id
       WHERE r.filing_id = ? ORDER BY r.row_index`
    )
    .all(filing.id) as RawScanRow[];
  const rows: ScanRow[] = raw.map((r) => ({
    ...r,
    amount_cols: JSON.parse(r.amount_cols) as number[],
    type_cols: JSON.parse(r.type_cols) as number[],
    amount_marks: JSON.parse(r.amount_marks) as number[],
    type_marks: JSON.parse(r.type_marks) as number[],
  }));
  return { filing, pages, rows };
}

export async function getScanPagePng(filingId: number, pageNo: number): Promise<Buffer | null> {
  const db = await getDb();
  const row = db
    .prepare("SELECT png FROM scan_pages WHERE filing_id = ? AND page_no = ?")
    .get(filingId, pageNo) as { png: Buffer } | undefined;
  return row?.png ?? null;
}

export type ScanTotals = {
  filings: number;
  captured: number;
  pages: number;
  rows: number;
  unknown_rows: number;
  png_bytes: number;
};

export async function getScanTotals(): Promise<ScanTotals> {
  const db = await getDb();
  return db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM filings WHERE chamber = 'house'
                 AND parse_method IN ('scanned', 'vision', 'vision_failed')) AS filings,
              (SELECT COUNT(DISTINCT filing_id) FROM scan_pages) AS captured,
              (SELECT COUNT(*) FROM scan_pages) AS pages,
              (SELECT COUNT(*) FROM scan_rows) AS rows,
              (SELECT COUNT(*) FROM scan_rows WHERE status != 'read') AS unknown_rows,
              (SELECT COALESCE(SUM(LENGTH(png)), 0) FROM scan_pages) AS png_bytes`
    )
    .get() as ScanTotals;
}
