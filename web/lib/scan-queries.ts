import { getDb } from "./db";

/**
 * Scanned paper filings captured for inspection (`scan_pages`, `scan_rows`;
 * src/whale/scan_capture.py). The page image is a 1-bit PNG oriented the
 * way the grid reader turned the page, and every row's geometry is in that
 * image's pixels, so an overlay drawn from `scan_rows` lines up with it.
 * Nothing here feeds a statistic.
 *
 * A filing is served one page at a time: a 56-page filing has close to a
 * thousand rows, and rendering every overlay and table at once made one
 * 6.8 MB document. `getScanFiling` returns the whole page list (metadata
 * only, with per-page counts for the pager) and the rows of one page.
 */

export type ScanFilingRow = {
  id: number;
  doc_id: string;
  member_name: string;
  /** The roster's id, for the member's URL; NULL for an unmatched filer. */
  bioguide_id: string | null;
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
  linked: number;
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
  /** Rows the grid reader found on this page, and how many it left unknown / linked. */
  rows: number;
  unknown_rows: number;
  linked: number;
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
  /** From the linked transaction, when there is one. */
  asset_name: string | null;
  tx_date: string | null;
  owner: string | null;
  tx_action: string | null;
  amount_min_cents: number | null;
  amount_max_cents: number | null;
  /**
   * What the vision model itself read for the amount column and the type,
   * recovered from the transaction's `raw_text`. The grid's reading is the
   * one stored (`vision.join`); these are kept so a reviewer can see where
   * the two disagreed. A `?` in the filing is stored here as null.
   */
  model_amount_letter: string | null;
  model_action: string | null;
  /** The model's amount letter differs from the grid's. The pipeline only logs this; the grid is kept. */
  amount_disputed: boolean;
  /** The model's type contradicts the grid's direction — the case `vision.join` refuses a filing over. */
  type_disputed: boolean;
};

/**
 * A House filing is a scan when its parse method says so, or when it has
 * captured pages whatever its method became afterwards: a later vision
 * attempt that crashed leaves `parse_method = 'error'`, and the capture
 * must stay inspectable — it is the audit trail for that failure.
 */
const IS_SCAN = `f.chamber = 'house' AND (f.parse_method IN ('scanned', 'vision', 'vision_failed')
     OR EXISTS (SELECT 1 FROM scan_pages s WHERE s.filing_id = f.id))`;

const FILINGS = `
  SELECT f.id, f.doc_id, COALESCE(p.full_name, f.filer_name) AS member_name,
         p.party, p.state, p.district, p.bioguide_id, f.filing_date, f.status, f.parse_method,
         f.last_error, f.pdf_url,
         (SELECT COUNT(*) FROM scan_pages s WHERE s.filing_id = f.id) AS pages,
         (SELECT COUNT(*) FROM scan_pages s WHERE s.filing_id = f.id AND s.error IS NOT NULL) AS pages_failed,
         (SELECT COUNT(*) FROM scan_rows r WHERE r.filing_id = f.id) AS rows,
         (SELECT COUNT(*) FROM scan_rows r WHERE r.filing_id = f.id AND r.status != 'read') AS unknown_rows,
         (SELECT COUNT(*) FROM scan_rows r WHERE r.filing_id = f.id AND r.transaction_id IS NOT NULL) AS linked,
         (SELECT COUNT(*) FROM transactions t WHERE t.filing_id = f.id) AS transactions
  FROM filings f LEFT JOIN politicians p ON p.id = f.politician_id
  WHERE ${IS_SCAN}`;

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

/** `?page=` as typed: a positive integer, else page 1. Whether it exists is the page's to check. */
export function parsePageNo(raw: string | undefined): number {
  if (raw == null || raw === "") return 1;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

const MODEL_READ = /model read (\S+) \/ (\S+)\)$/;

/**
 * The model's own amount letter and type from a transcribed row's
 * `raw_text` — `vision.join` ends it with "model read B / sale)". A `?`
 * means the model gave none; a row vision did not transcribe has no such
 * note and yields nulls.
 */
export function modelReading(rawText: string | null): {
  amount_letter: string | null;
  action: string | null;
} {
  const m = rawText ? MODEL_READ.exec(rawText) : null;
  if (!m) return { amount_letter: null, action: null };
  return {
    amount_letter: m[1] === "?" ? null : m[1],
    action: m[2] === "?" ? null : m[2],
  };
}

const ACTIONS = new Set(["purchase", "sale", "sale_partial", "exchange"]);

/**
 * The test `vision.join` applies: a type disagreement is one of direction,
 * so "sale" against "sale_partial" is not a dispute. Only a reading both
 * sides actually made can be disputed.
 */
export function isTypeDisputed(grid: string | null, model: string | null): boolean {
  if (!grid || !model || !ACTIONS.has(model)) return false;
  const dir = (a: string) => (a === "sale_partial" ? "sale" : a);
  return dir(grid) !== dir(model);
}

type RawScanRow = Omit<
  ScanRow,
  | "amount_cols"
  | "type_cols"
  | "amount_marks"
  | "type_marks"
  | "model_amount_letter"
  | "model_action"
  | "amount_disputed"
  | "type_disputed"
> & {
  amount_cols: string;
  type_cols: string;
  amount_marks: string;
  type_marks: string;
  raw_text: string | null;
};

export type ScanFiling = {
  filing: ScanFilingRow;
  /** Every captured page, in order, with its row counts. */
  pages: ScanPage[];
  /** The page whose rows were loaded. May name a page that does not exist; `rows` is then empty. */
  page: number;
  rows: ScanRow[];
};

export async function getScanFiling(docId: string, page = 1): Promise<ScanFiling | null> {
  const db = await getDb();
  const filing = db.prepare(`${FILINGS} AND f.doc_id = ?`).get(docId) as ScanFilingRow | undefined;
  if (!filing) return null;
  const pages = db
    .prepare(
      `SELECT s.page_no, s.width, s.height, s.dpi, s.rotation, s.error,
              COUNT(r.id) AS rows,
              COALESCE(SUM(r.status != 'read'), 0) AS unknown_rows,
              COALESCE(SUM(r.transaction_id IS NOT NULL), 0) AS linked
       FROM scan_pages s
       LEFT JOIN scan_rows r ON r.filing_id = s.filing_id AND r.page_no = s.page_no
       WHERE s.filing_id = ?
       GROUP BY s.page_no ORDER BY s.page_no`
    )
    .all(filing.id) as ScanPage[];
  const raw = db
    .prepare(
      `SELECT r.id, r.page_no, r.row_index, r.y0, r.y1, r.amount_cols, r.type_cols,
              r.amount_marks, r.type_marks, r.amount_letter, r.amount_margin, r.action,
              r.type_margin, r.status, r.transaction_id,
              t.asset_name, t.tx_date, t.owner, t.action AS tx_action,
              t.amount_min_cents, t.amount_max_cents, t.raw_text
       FROM scan_rows r LEFT JOIN transactions t ON t.id = r.transaction_id
       WHERE r.filing_id = ? AND r.page_no = ? ORDER BY r.row_index`
    )
    .all(filing.id, page) as RawScanRow[];
  const rows: ScanRow[] = raw.map(({ raw_text, ...r }) => {
    const model = r.transaction_id != null ? modelReading(raw_text) : { amount_letter: null, action: null };
    return {
      ...r,
      amount_cols: JSON.parse(r.amount_cols) as number[],
      type_cols: JSON.parse(r.type_cols) as number[],
      amount_marks: JSON.parse(r.amount_marks) as number[],
      type_marks: JSON.parse(r.type_marks) as number[],
      model_amount_letter: model.amount_letter,
      model_action: model.action,
      amount_disputed:
        model.amount_letter != null && r.amount_letter != null && model.amount_letter !== r.amount_letter,
      type_disputed: isTypeDisputed(r.action, model.action),
    };
  });
  return { filing, pages, page, rows };
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
      `SELECT (SELECT COUNT(*) FROM filings f WHERE ${IS_SCAN}) AS filings,
              (SELECT COUNT(DISTINCT filing_id) FROM scan_pages) AS captured,
              (SELECT COUNT(*) FROM scan_pages) AS pages,
              (SELECT COUNT(*) FROM scan_rows) AS rows,
              (SELECT COUNT(*) FROM scan_rows WHERE status != 'read') AS unknown_rows,
              (SELECT COALESCE(SUM(LENGTH(png)), 0) FROM scan_pages) AS png_bytes`
    )
    .get() as ScanTotals;
}
