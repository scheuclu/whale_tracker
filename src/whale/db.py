"""SQLite persistence: schema, migrations, repository helpers.

`data/trades.sqlite3` is both the pipeline state and the knowledge base, and is
committed back to the repo by the GitHub Actions workflow.

Filing status state machine:
    seen_skipped  recorded on first sync but too old to notify
    new           awaiting PDF fetch + parse, then Telegram
    backfill_queued  awaiting parse for history only — deliberately distinct
                  from 'new' so a backfill cannot swallow filings that are
                  still owed a notification
    parsed        transactions stored, awaiting Telegram
    notified      done
    backfilled    parsed deliberately without notifying (history for stats)
    failed        could not be read (scanned PDF with no vision key, or
                  malformed); retried if the pipeline gains the ability to
                  read it, so this is not a terminal state

Whether Telegram has seen a filing is tracked by `notified_at`, not by the
status, because a filing can be both reported and still unparsed.

SEC Form 4 filings (`insider_*` tables) reuse the same words with a smaller
machine: they are parsed before they are stored, so there is no 'new'. Kept
filings enter as `backfilled` (history, never announced) until insider alerts
exist; `failed` means the submission was fetched but its XML did not parse,
kept so it is visible and re-parseable. The tables are deliberately separate
from `filings`/`transactions`: every politician aggregate filters on status
alone, so shared tables would fold insider volume into member leaderboards.

`alerts` is the log of every Telegram message sent, one row per message, and
the dedupe store for the cluster kinds. `kind` says what fired and
`politician_count` holds whatever that kind counts:

    cluster          members converging on one ticker      count = members
    insider_cluster  insiders converging on one issuer     count = insiders
    filing           one member's new disclosure           count = 1
    watchlist        one transaction of a watched member   count = 1, a row per message
    insider_filing   one Form 4 a rule claimed             count = 1 (a joint filing is one decision)

`ticker` and `direction` are NULL when the alert is not about one ticker in
one direction — a filing spanning several, or a Treasury roll with none — so
the (ticker, direction, kind) key of the cluster dedupe is undisturbed.
Volume is the disclosed range (insider values: min = max = exact), and
`message` is the text exactly as sent; the dashboard never re-renders one.
Rows from before schema 13 carry only the dedupe fields.
"""

from __future__ import annotations

import sqlite3
from collections.abc import Iterable
from datetime import datetime, timezone
from pathlib import Path

SCHEMA_VERSION = 13

# The alerts table's columns, shared by the fresh-database DDL and the
# version-13 rebuild so the two cannot drift.
_ALERT_COLUMNS = """
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  ticker TEXT,                         -- NULL when the alert is not about one ticker
  direction TEXT,                      -- 'buy' | 'sell'; NULL when it spans both
  window_days INTEGER NOT NULL DEFAULT 0,  -- 0 for a per-filing alert
  politician_count INTEGER NOT NULL,   -- whatever the kind counts; see the module docstring
  volume_min_cents INTEGER,            -- the disclosed range; insider values min = max = exact
  volume_max_cents INTEGER,            -- NULL when a row is in the open-ended top bracket
  volume_mid_cents INTEGER,            -- bracket midpoints: an estimate, labelled as one
  fired_at TEXT NOT NULL,
  participants TEXT,                   -- the names the message carried, comma-joined
  rule_name TEXT,                      -- the config.yaml rule that claimed an insider alert
  filing_id INTEGER REFERENCES filings(id) ON DELETE SET NULL,
  transaction_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
  insider_filing_id INTEGER REFERENCES insider_filings(id) ON DELETE SET NULL,
  message TEXT                         -- the Telegram text exactly as sent
"""

_DDL = f"""
CREATE TABLE IF NOT EXISTS politicians (
  id INTEGER PRIMARY KEY,
  bioguide_id TEXT UNIQUE,
  full_name TEXT NOT NULL,
  first TEXT,
  last TEXT,
  chamber TEXT,
  party TEXT,
  state TEXT,
  district TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_politicians_last ON politicians(last);

CREATE TABLE IF NOT EXISTS filings (
  id INTEGER PRIMARY KEY,
  chamber TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  politician_id INTEGER REFERENCES politicians(id),
  -- Name as printed on the filing; kept even when the roster match fails so
  -- an unmatched filing is still attributable.
  filer_name TEXT NOT NULL,
  state_district TEXT,
  filing_type TEXT NOT NULL,
  filing_date TEXT,
  year INTEGER NOT NULL,
  pdf_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  parse_method TEXT,
  -- When Telegram was told about this filing. Kept separate from `status` so
  -- an unreadable filing stays 'failed' (and re-parseable once a vision key
  -- exists) without being announced twice.
  notified_at TEXT,
  last_error TEXT,
  first_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (chamber, doc_id)
);
CREATE INDEX IF NOT EXISTS idx_filings_status ON filings(status);
CREATE INDEX IF NOT EXISTS idx_filings_date ON filings(filing_date);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY,
  filing_id INTEGER NOT NULL REFERENCES filings(id) ON DELETE CASCADE,
  politician_id INTEGER REFERENCES politicians(id),
  tx_date TEXT,
  notification_date TEXT,
  owner TEXT,
  asset_name TEXT NOT NULL,
  ticker TEXT,
  asset_type TEXT,
  action TEXT NOT NULL,
  amount_min_cents INTEGER,
  amount_max_cents INTEGER,
  amount_exact_cents INTEGER,
  cap_gains_over_200 INTEGER,
  description TEXT,
  raw_text TEXT
);
CREATE INDEX IF NOT EXISTS idx_tx_ticker ON transactions(ticker);
CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(tx_date);
CREATE INDEX IF NOT EXISTS idx_tx_filing ON transactions(filing_id);

-- Every alert sent, one row per message (see the module docstring), and the
-- (ticker, direction, kind) dedupe for the cluster kinds.
CREATE TABLE IF NOT EXISTS alerts ({_ALERT_COLUMNS});
CREATE INDEX IF NOT EXISTS idx_alerts_key ON alerts(ticker, direction);
CREATE INDEX IF NOT EXISTS idx_alerts_fired ON alerts(fired_at);

CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT NOT NULL
);
"""


# SEC Form 4 (corporate insiders). Values are shares × the price as filed —
# exact figures, unlike the House brackets — so min = max = exact, or all
# three NULL when the filing gives no price: an unknown value is never 0.
_INSIDER_DDL = """
CREATE TABLE IF NOT EXISTS insiders (
  cik TEXT PRIMARY KEY,                -- 10-digit zero-padded, as filed
  name TEXT NOT NULL,                  -- as on the most recently processed filing
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS insider_filings (
  id INTEGER PRIMARY KEY,
  accession TEXT NOT NULL UNIQUE,      -- dashed: 0001214659-26-011648
  form_type TEXT NOT NULL,             -- '4' only for now; kept for 4/A, 3, 5
  issuer_cik TEXT,                     -- NULL only on a 'failed' row with an unreadable header
  issuer_name TEXT,
  ticker TEXT,                         -- first symbol of issuerTradingSymbol, upper-cased; NULL for NONE / N/A / blank
  ticker_as_filed TEXT,                -- verbatim ("HEI, HEI.A" stays whole here)
  period_of_report TEXT,
  -- FILED AS OF DATE. Named filing_date so the disclosure-delay helpers apply.
  filing_date TEXT NOT NULL,
  accepted_at TEXT,                    -- ACCEPTANCE-DATETIME (US/Eastern) as UTC; NULL without tz data
  aff_10b5_one INTEGER,                -- Rule 10b5-1 box: 1 / 0 / NULL when the element is absent
  source TEXT NOT NULL,                -- 'feed' | 'index'
  source_url TEXT NOT NULL,            -- the …-index.htm page
  status TEXT NOT NULL,
  notified_at TEXT,
  last_error TEXT,
  remarks TEXT,
  first_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_insider_filings_issuer ON insider_filings(issuer_cik);
CREATE INDEX IF NOT EXISTS idx_insider_filings_ticker ON insider_filings(ticker);
CREATE INDEX IF NOT EXISTS idx_insider_filings_date   ON insider_filings(filing_date);
CREATE INDEX IF NOT EXISTS idx_insider_filings_status ON insider_filings(status);

-- Relationship is per filing, not per person: titles change. owner_index 0 is
-- the primary reporting owner; joint filers (a fund plus its GP and managing
-- member) are one economic decision, so "distinct insiders" counts index 0 only.
CREATE TABLE IF NOT EXISTS insider_filing_owners (
  filing_id INTEGER NOT NULL REFERENCES insider_filings(id) ON DELETE CASCADE,
  insider_cik TEXT NOT NULL REFERENCES insiders(cik),
  owner_index INTEGER NOT NULL,
  is_director INTEGER NOT NULL DEFAULT 0,
  is_officer INTEGER NOT NULL DEFAULT 0,
  is_ten_percent_owner INTEGER NOT NULL DEFAULT 0,
  is_other INTEGER NOT NULL DEFAULT 0,
  officer_title TEXT,
  other_text TEXT,
  PRIMARY KEY (filing_id, insider_cik)
);
CREATE INDEX IF NOT EXISTS idx_insider_owners_cik ON insider_filing_owners(insider_cik);

-- Open-market rows (codes P/S, non-derivative table) of kept filings only.
CREATE TABLE IF NOT EXISTS insider_transactions (
  id INTEGER PRIMARY KEY,
  filing_id INTEGER NOT NULL REFERENCES insider_filings(id) ON DELETE CASCADE,
  tx_date TEXT,                        -- as filed, except an offset-suffixed value is parsed to its date
  tx_date_as_filed TEXT,               -- the verbatim value when tx_date was parsed out of it; NULL when identical
  deemed_execution_date TEXT,          -- as filed; starts the 2-day clock when present
  security_title TEXT,
  transaction_code TEXT NOT NULL,      -- 'P' | 'S'
  action TEXT NOT NULL,                -- 'purchase' | 'sale' — same vocabulary as transactions.action
  acquired_disposed TEXT,              -- 'A' | 'D' as filed
  timeliness TEXT,                     -- 'E' | 'L' as filed (the filer's own late box) | NULL on time
  shares REAL,
  price_per_share REAL,                -- as filed; may be a VWAP whose range lives in a footnote
  amount_min_cents INTEGER,
  amount_max_cents INTEGER,
  amount_exact_cents INTEGER,
  shares_after REAL,
  direct_or_indirect TEXT,             -- 'D' | 'I'
  nature_of_ownership TEXT,
  footnotes TEXT,                      -- footnote texts referenced by this row, newline-joined
  -- Derived once at ingest by stats.form4_is_late (2 business days, federal
  -- holidays excluded). NULL when the dates contradict each other. Read, never
  -- re-derived, by SQL.
  late INTEGER,
  -- Derived once at ingest by stats.form4_is_implausible: 1 when the as-filed
  -- value is beyond belief (a price cell holding the aggregate consideration),
  -- 0 when judged plausible, NULL when there is no value to judge. The row
  -- stays as filed; a flagged value is excluded from every total.
  implausible INTEGER
);
CREATE INDEX IF NOT EXISTS idx_insider_tx_filing ON insider_transactions(filing_id);
CREATE INDEX IF NOT EXISTS idx_insider_tx_date   ON insider_transactions(tx_date);
"""

# Filing-rule cooldown: one row per (primary owner, issuer, direction), read
# before a filing-rule alert is sent and rewritten after every rule-matched
# filing, sent or folded. Its own table rather than a column on `alerts`:
# that table has no owner and its (ticker, direction, kind) key must stay
# the cluster dedupe. A "run" is one owner's programme of filings in one
# issuer and direction, each inside `insiders.filing_refire_days` of the
# last one that was sent.
_COOLDOWN_DDL = """
CREATE TABLE IF NOT EXISTS insider_alert_cooldowns (
  insider_cik TEXT NOT NULL,
  issuer_cik TEXT NOT NULL,
  direction TEXT NOT NULL,               -- 'purchase' | 'sale'
  first_filing_date TEXT NOT NULL,       -- the filing that opened the run
  last_alert_filing_date TEXT NOT NULL,  -- the filing most recently sent; the window runs from here
  last_alert_filing_id INTEGER,
  filing_count INTEGER NOT NULL,         -- filings in the run, sent or folded
  cumulative_cents INTEGER,              -- their summed value (shares × reported price); NULL when none was priced
  reported_cents INTEGER,                -- the value the last message carried
  updated_at TEXT NOT NULL,
  PRIMARY KEY (insider_cik, issuer_cik, direction)
);
"""

# Scanned paper filings, captured for inspection (`scan_capture.py`): every
# page as a small 1-bit PNG, oriented the way the grid reader turned it, and
# every row the reader found with enough geometry to draw its decision on
# the page. In this database rather than beside it because the dashboard
# fetches exactly one file and the workflow commits exactly one; the whole
# 2026 corpus of scans is under 6 MB at 110 dpi, budgeted at 15.
_SCAN_DDL = """
CREATE TABLE IF NOT EXISTS scan_pages (
  filing_id INTEGER NOT NULL REFERENCES filings(id) ON DELETE CASCADE,
  page_no INTEGER NOT NULL,            -- 1-based
  width INTEGER NOT NULL,              -- of the PNG, after rotation
  height INTEGER NOT NULL,
  dpi INTEGER NOT NULL,
  rotation INTEGER NOT NULL,           -- degrees the reader turned the page: 0, 90, 180, 270
  png BLOB NOT NULL,
  error TEXT,                          -- why the reader could not decompose the page, if it could not
  PRIMARY KEY (filing_id, page_no)
);

CREATE TABLE IF NOT EXISTS scan_rows (
  id INTEGER PRIMARY KEY,
  filing_id INTEGER NOT NULL REFERENCES filings(id) ON DELETE CASCADE,
  page_no INTEGER NOT NULL,
  row_index INTEGER NOT NULL,          -- across the filing, page order; the join order of vision.join
  y0 INTEGER NOT NULL,                 -- row band, in PNG pixels
  y1 INTEGER NOT NULL,
  amount_cols TEXT NOT NULL,           -- JSON: x-edges of the amount columns, PNG pixels (n + 1)
  type_cols TEXT NOT NULL,             -- JSON: x-edges of the type columns
  amount_marks TEXT NOT NULL,          -- JSON: indexes of the amount cells read as ticked
  type_marks TEXT NOT NULL,            -- JSON: indexes of the type cells read as ticked
  amount_letter TEXT,                  -- the single ticked column, or NULL
  amount_margin REAL,                  -- strongest cell's lead over the row median
  action TEXT,
  type_margin REAL,
  status TEXT NOT NULL,                -- read | unknown_amount | unknown_type | unknown
  transaction_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_scan_rows_filing ON scan_rows(filing_id, page_no, row_index);
"""

# Statuses whose transactions count toward statistics. A filing that failed to
# parse contributes nothing, and one that is merely 'new' has no rows yet.
COUNTED_STATUSES = ("parsed", "notified", "backfilled")


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def connect(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    _migrate(conn)
    return conn


def _migrate(conn: sqlite3.Connection) -> None:
    version = conn.execute("PRAGMA user_version").fetchone()[0]
    if version < 1:
        conn.executescript(_DDL)
    if version == 1:
        conn.execute("ALTER TABLE filings ADD COLUMN notified_at TEXT")
    if version < 3:
        # A fresh DB is version 0 and takes this step too, so the insider DDL
        # is not repeated in _DDL.
        conn.executescript(_INSIDER_DDL)
    if version < 4:
        # Implausible-value quarantine (#15). A fresh DB already has the
        # column from the DDL; a version-3 DB gains it here and has it
        # populated, so production needs no manual recompute.
        if _add_column(conn, "insider_transactions", "implausible INTEGER"):
            from . import insiders

            insiders.recompute_implausible(conn)
    if version < 5:
        # Multi-symbol tickers (#21): re-derive `ticker` from the verbatim
        # value so "HEI, HEI.A" keys as HEI. The cluster-dedupe rows keyed on
        # the old string follow it, or the next run would re-send a
        # convergence it has already reported.
        _rederive_insider_tickers(conn)
    if version < 6:
        # Offset-suffixed trade dates (#20): "2026-09-08-05:00" is the 8th.
        # Parse the stored rows the same way ingest now does and derive
        # `late` for them, so the audit stops listing them every week.
        if _add_column(conn, "insider_transactions", "tx_date_as_filed TEXT"):
            from . import insiders

            insiders.reparse_trade_dates(conn)
    if version < 7:
        # Numbered past a concurrent version-4 migration so the two can be
        # reconciled at merge; idempotent, so running it on either side is safe.
        conn.executescript(_COOLDOWN_DDL)
    if version < 8:
        # Scan capture tables. Empty until `whale capture-scans` runs or the
        # pipeline meets a scan; nothing to backfill at migration time.
        conn.executescript(_SCAN_DDL)
    if version < 13:
        # Alerts page (#52): the table now logs every message sent, not only
        # the cluster dedupe rows, so an alert is no longer always one ticker
        # in one direction and the NOT NULL keys have to go. SQLite cannot
        # relax a constraint in place, so the table is rebuilt; the existing
        # rows keep their ids and dedupe fields. Numbered past the concurrent
        # 9–12 migrations.
        _widen_alerts(conn)
        if get_state(conn, ALERTS_RECORDED_SINCE) is None:
            set_state(conn, ALERTS_RECORDED_SINCE, now_iso())
    if version < SCHEMA_VERSION:
        conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
        conn.commit()


def _add_column(conn: sqlite3.Connection, table: str, definition: str) -> bool:
    """ALTER TABLE ... ADD COLUMN unless the DDL already created it.

    Returns whether the column was added — i.e. whether existing rows need a
    backfill. A fresh database gets every column from the DDL and has no
    rows to populate.
    """
    name = definition.split()[0]
    present = {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}
    if name in present:
        return False
    conn.execute(f"ALTER TABLE {table} ADD COLUMN {definition}")
    return True


# sync_state key: when this database began logging every alert sent. Rows
# fired before it carry only the dedupe fields, and the audit's recording
# check looks only at filings notified after it.
ALERTS_RECORDED_SINCE = "alerts_recorded_since"


def _widen_alerts(conn: sqlite3.Connection) -> bool:
    """Rebuild `alerts` from its cluster-only shape; returns whether it did.

    A fresh database already has every column from the DDL and is left alone.
    The rebuild copies the rows by id so nothing the cluster dedupe compares
    against — kind, ticker, direction, window, count, time — moves.
    """
    present = {r[1] for r in conn.execute("PRAGMA table_info(alerts)")}
    if "message" in present:
        return False
    conn.executescript(f"""
        CREATE TABLE alerts_v13 ({_ALERT_COLUMNS});
        INSERT INTO alerts_v13 (id, kind, ticker, direction, window_days,
                                politician_count, volume_mid_cents, fired_at)
          SELECT id, kind, ticker, direction, window_days,
                 politician_count, volume_mid_cents, fired_at
          FROM alerts ORDER BY id;
        DROP TABLE alerts;
        ALTER TABLE alerts_v13 RENAME TO alerts;
        CREATE INDEX IF NOT EXISTS idx_alerts_key ON alerts(ticker, direction);
        CREATE INDEX IF NOT EXISTS idx_alerts_fired ON alerts(fired_at);
    """)
    return True


def _rederive_insider_tickers(conn: sqlite3.Connection) -> int:
    """Recompute `insider_filings.ticker` from `ticker_as_filed`; returns how
    many filings changed. Insider-cluster alert rows keyed on a changed
    ticker are re-keyed too."""
    from .form4 import normalize_ticker
    from .stats import INSIDER_CLUSTER_KIND

    rows = conn.execute(
        "SELECT id, ticker, ticker_as_filed FROM insider_filings WHERE ticker_as_filed IS NOT NULL"
    ).fetchall()
    changed = 0
    for filing_id, old, as_filed in rows:
        new = normalize_ticker(as_filed)
        if new == old:
            continue
        conn.execute("UPDATE insider_filings SET ticker = ? WHERE id = ?", (new, filing_id))
        if old and new:
            conn.execute("UPDATE alerts SET ticker = ? WHERE kind = ? AND ticker = ?",
                         (new, INSIDER_CLUSTER_KIND, old))
        changed += 1
    return changed


# --- politicians ------------------------------------------------------------


def upsert_politician(conn: sqlite3.Connection, **fields) -> int:
    """Insert or update by bioguide_id, returning the row id."""
    fields["updated_at"] = now_iso()
    cols = ", ".join(fields)
    placeholders = ", ".join("?" for _ in fields)
    updates = ", ".join(f"{c}=excluded.{c}" for c in fields if c != "bioguide_id")
    conn.execute(
        f"INSERT INTO politicians ({cols}) VALUES ({placeholders}) "
        f"ON CONFLICT(bioguide_id) DO UPDATE SET {updates}",
        list(fields.values()),
    )
    row = conn.execute(
        "SELECT id FROM politicians WHERE bioguide_id = ?", (fields["bioguide_id"],)
    ).fetchone()
    return row["id"]


def all_politicians(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    return conn.execute("SELECT * FROM politicians").fetchall()


# --- filings ----------------------------------------------------------------


def filing_exists(conn: sqlite3.Connection, chamber: str, doc_id: str) -> bool:
    return conn.execute(
        "SELECT 1 FROM filings WHERE chamber = ? AND doc_id = ?", (chamber, doc_id)
    ).fetchone() is not None


def insert_filing(conn: sqlite3.Connection, **fields) -> int | None:
    """Insert a newly sighted filing. Returns None if already known."""
    ts = now_iso()
    fields.setdefault("first_seen_at", ts)
    fields.setdefault("updated_at", ts)
    cols = ", ".join(fields)
    placeholders = ", ".join("?" for _ in fields)
    cur = conn.execute(
        f"INSERT OR IGNORE INTO filings ({cols}) VALUES ({placeholders})",
        list(fields.values()),
    )
    return cur.lastrowid if cur.rowcount else None


def filings_by_status(conn: sqlite3.Connection, *statuses: str,
                      unnotified_only: bool = False) -> list[sqlite3.Row]:
    marks = ", ".join("?" for _ in statuses)
    sql = f"""SELECT f.*, p.full_name AS member_name, p.party, p.bioguide_id,
                     p.chamber AS member_chamber
              FROM filings f LEFT JOIN politicians p ON p.id = f.politician_id
              WHERE f.status IN ({marks})"""
    if unnotified_only:
        sql += " AND f.notified_at IS NULL"
    sql += " ORDER BY f.filing_date, f.id"
    return conn.execute(sql, statuses).fetchall()


def mark_notified(conn: sqlite3.Connection, filing_id: int) -> None:
    conn.execute("UPDATE filings SET notified_at = ?, updated_at = ? WHERE id = ?",
                 (now_iso(), now_iso(), filing_id))


def set_status(conn: sqlite3.Connection, filing_id: int, status: str,
               error: str | None = None, parse_method: str | None = None) -> None:
    conn.execute(
        "UPDATE filings SET status = ?, last_error = ?, updated_at = ?"
        + (", parse_method = ?" if parse_method else "")
        + " WHERE id = ?",
        ([status, error, now_iso()] + ([parse_method] if parse_method else []) + [filing_id]),
    )


# --- transactions -----------------------------------------------------------


def replace_transactions(conn: sqlite3.Connection, filing_id: int,
                         politician_id: int | None, rows: list[dict]) -> int:
    """Store a filing's transactions, replacing any previous parse of it.

    Re-parsing is idempotent: a filing re-processed after a parser fix does not
    double-count into the volume statistics.
    """
    conn.execute("DELETE FROM transactions WHERE filing_id = ?", (filing_id,))
    for r in rows:
        conn.execute(
            """INSERT INTO transactions
               (filing_id, politician_id, tx_date, notification_date, owner,
                asset_name, ticker, asset_type, action, amount_min_cents,
                amount_max_cents, amount_exact_cents, cap_gains_over_200,
                description, raw_text)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                filing_id, politician_id, r.get("tx_date"), r.get("notification_date"),
                r.get("owner"), r["asset_name"], r.get("ticker"), r.get("asset_type"),
                r["action"], r.get("amount_min_cents"), r.get("amount_max_cents"),
                r.get("amount_exact_cents"), r.get("cap_gains_over_200"),
                r.get("description"), r.get("raw_text"),
            ),
        )
    return len(rows)


def transactions_for_filing(conn: sqlite3.Connection, filing_id: int) -> list[sqlite3.Row]:
    """A filing's rows, each carrying `transcribed`: 1 when the filing was
    read by transcribing a scan, so every message and page can label the
    row and nothing has to re-derive it from the filing."""
    return conn.execute(
        """SELECT t.*, f.parse_method = 'vision' AS transcribed
           FROM transactions t JOIN filings f ON f.id = t.filing_id
           WHERE t.filing_id = ? ORDER BY t.id""", (filing_id,)
    ).fetchall()


# --- scan capture -----------------------------------------------------------

# Parse methods a House filing has when it is a scan: never attempted,
# transcribed, or refused.
SCAN_METHODS = ("scanned", "vision", "vision_failed")


def uncaptured_scans(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    """House scans with no pages stored yet, oldest filing first."""
    marks = ", ".join("?" for _ in SCAN_METHODS)
    return conn.execute(
        f"""SELECT f.* FROM filings f
            WHERE f.chamber = 'house' AND f.parse_method IN ({marks})
              AND NOT EXISTS (SELECT 1 FROM scan_pages s WHERE s.filing_id = f.id)
            ORDER BY f.filing_date, f.id""", SCAN_METHODS
    ).fetchall()


def replace_scan_pages(conn: sqlite3.Connection, filing_id: int, pages: list[dict]) -> int:
    """Store a filing's page images, replacing any earlier capture."""
    conn.execute("DELETE FROM scan_pages WHERE filing_id = ?", (filing_id,))
    for p in pages:
        conn.execute(
            """INSERT INTO scan_pages
               (filing_id, page_no, width, height, dpi, rotation, png, error)
               VALUES (?,?,?,?,?,?,?,?)""",
            (filing_id, p["page_no"], p["width"], p["height"], p["dpi"], p["rotation"],
             p["png"], p.get("error")),
        )
    return len(pages)


def replace_scan_rows(conn: sqlite3.Connection, filing_id: int, rows: list[dict]) -> int:
    """Store the grid reader's rows for a filing, replacing any earlier ones."""
    conn.execute("DELETE FROM scan_rows WHERE filing_id = ?", (filing_id,))
    for r in rows:
        conn.execute(
            """INSERT INTO scan_rows
               (filing_id, page_no, row_index, y0, y1, amount_cols, type_cols,
                amount_marks, type_marks, amount_letter, amount_margin, action,
                type_margin, status, transaction_id)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (filing_id, r["page_no"], r["row_index"], r["y0"], r["y1"], r["amount_cols"],
             r["type_cols"], r["amount_marks"], r["type_marks"], r.get("amount_letter"),
             r.get("amount_margin"), r.get("action"), r.get("type_margin"), r["status"],
             r.get("transaction_id")),
        )
    return len(rows)


def link_scan_rows(conn: sqlite3.Connection, filing_id: int) -> int:
    """Point a filing's scan rows at its transactions, by order.

    `vision.join` builds transactions from the reader's rows in page order,
    and `replace_transactions` inserts them in that order, so the n-th scan
    row is the n-th transaction. Returns how many were linked; none when the
    counts differ (a filing re-read since capture) or there are no
    transactions (a scan vision never read).
    """
    rows = conn.execute(
        "SELECT id FROM scan_rows WHERE filing_id = ? ORDER BY row_index", (filing_id,)
    ).fetchall()
    txs = conn.execute(
        "SELECT id FROM transactions WHERE filing_id = ? ORDER BY id", (filing_id,)
    ).fetchall()
    if not rows or len(rows) != len(txs):
        return 0
    for r, t in zip(rows, txs):
        conn.execute("UPDATE scan_rows SET transaction_id = ? WHERE id = ?", (t["id"], r["id"]))
    return len(rows)


def scan_page_png(conn: sqlite3.Connection, filing_id: int, page_no: int) -> bytes | None:
    row = conn.execute(
        "SELECT png FROM scan_pages WHERE filing_id = ? AND page_no = ?", (filing_id, page_no)
    ).fetchone()
    return bytes(row["png"]) if row else None


# --- alerts -----------------------------------------------------------------


def last_alert(conn: sqlite3.Connection, ticker: str, direction: str,
               kind: str | None = None) -> sqlite3.Row | None:
    """The most recent alert for this key.

    `kind` scopes the lookup to one alert family. Two sources can converge on
    the same ticker, and a congressional cluster must not suppress an insider
    one; `politician_count` holds whichever participant count the kind counts.

    Ordered by id as well as time: `fired_at` has one-second resolution, so
    two alerts on the same key in the same second tie, and the dedupe would
    then compare against an arbitrary one of them — re-sending a cluster
    because it read the smaller count. `id` breaks the tie by insertion order.
    """
    sql = "SELECT * FROM alerts WHERE ticker = ? AND direction = ?"
    params: list = [ticker, direction]
    if kind is not None:
        sql += " AND kind = ?"
        params.append(kind)
    return conn.execute(sql + " ORDER BY fired_at DESC, id DESC LIMIT 1", params).fetchone()


def record_alert(conn: sqlite3.Connection, kind: str, ticker: str | None,
                 direction: str | None, window_days: int, politician_count: int,
                 volume_mid_cents: int | None = None, *,
                 volume_min_cents: int | None = None, volume_max_cents: int | None = None,
                 participants: str | None = None, rule_name: str | None = None,
                 filing_id: int | None = None, transaction_id: int | None = None,
                 insider_filing_id: int | None = None, message: str | None = None) -> int:
    """Log one message that was actually sent; returns the row id.

    Called after delivery and never on a dry run: the log is the history of
    what the user was told, so a row for a message that failed, or was only
    previewed, would be a lie the dashboard then repeats. The volume is the
    disclosed range — `volume_max_cents` NULL when a row sits in the
    open-ended top bracket — and `volume_mid_cents` the bracket-midpoint
    estimate the cluster thresholds compare against.
    """
    cur = conn.execute(
        "INSERT INTO alerts (kind, ticker, direction, window_days, politician_count,"
        " volume_min_cents, volume_max_cents, volume_mid_cents, fired_at, participants,"
        " rule_name, filing_id, transaction_id, insider_filing_id, message)"
        " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (kind, ticker, direction, window_days, politician_count, volume_min_cents,
         volume_max_cents, volume_mid_cents, now_iso(), participants, rule_name,
         filing_id, transaction_id, insider_filing_id, message),
    )
    return cur.lastrowid


# --- sync state -------------------------------------------------------------


def get_state(conn: sqlite3.Connection, key: str) -> str | None:
    row = conn.execute("SELECT value FROM sync_state WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else None


def set_state(conn: sqlite3.Connection, key: str, value: str | None) -> None:
    conn.execute(
        "INSERT INTO sync_state (key, value, updated_at) VALUES (?,?,?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
        (key, value, now_iso()),
    )


# --- insiders (SEC Form 4) ---------------------------------------------------


def known_accessions(conn: sqlite3.Connection, accessions: Iterable[str]) -> set[str]:
    """Which of these accession numbers are already stored."""
    known: set[str] = set()
    items = list(accessions)
    for i in range(0, len(items), 500):
        chunk = items[i:i + 500]
        marks = ", ".join("?" for _ in chunk)
        known.update(
            r["accession"] for r in conn.execute(
                f"SELECT accession FROM insider_filings WHERE accession IN ({marks})", chunk
            )
        )
    return known


def upsert_insider(conn: sqlite3.Connection, cik: str, name: str) -> None:
    conn.execute(
        "INSERT INTO insiders (cik, name, updated_at) VALUES (?,?,?) "
        "ON CONFLICT(cik) DO UPDATE SET name=excluded.name, updated_at=excluded.updated_at",
        (cik, name, now_iso()),
    )


def insert_insider_filing(conn: sqlite3.Connection, **fields) -> int | None:
    """Insert a Form 4 filing. Returns None if the accession is already known."""
    ts = now_iso()
    fields.setdefault("first_seen_at", ts)
    fields.setdefault("updated_at", ts)
    cols = ", ".join(fields)
    placeholders = ", ".join("?" for _ in fields)
    cur = conn.execute(
        f"INSERT OR IGNORE INTO insider_filings ({cols}) VALUES ({placeholders})",
        list(fields.values()),
    )
    return cur.lastrowid if cur.rowcount else None


def insider_filing_id(conn: sqlite3.Connection, accession: str) -> int | None:
    row = conn.execute(
        "SELECT id FROM insider_filings WHERE accession = ?", (accession,)
    ).fetchone()
    return row["id"] if row else None


def mark_insider_notified(conn: sqlite3.Connection, filing_id: int) -> None:
    conn.execute(
        "UPDATE insider_filings SET notified_at = ?, updated_at = ? WHERE id = ?",
        (now_iso(), now_iso(), filing_id),
    )


def set_insider_status(conn: sqlite3.Connection, filing_id: int, status: str,
                       error: str | None = None) -> None:
    conn.execute(
        "UPDATE insider_filings SET status = ?, last_error = ?, updated_at = ? WHERE id = ?",
        (status, error, now_iso(), filing_id),
    )


def insider_cooldown(conn: sqlite3.Connection, insider_cik: str, issuer_cik: str,
                     direction: str) -> sqlite3.Row | None:
    """The filing-rule cooldown row for this owner, issuer and direction."""
    return conn.execute(
        """SELECT * FROM insider_alert_cooldowns
           WHERE insider_cik = ? AND issuer_cik = ? AND direction = ?""",
        (insider_cik, issuer_cik, direction),
    ).fetchone()


COOLDOWN_FIELDS = (
    "insider_cik", "issuer_cik", "direction", "first_filing_date",
    "last_alert_filing_date", "last_alert_filing_id", "filing_count",
    "cumulative_cents", "reported_cents",
)


def save_insider_cooldown(conn: sqlite3.Connection, state: dict) -> None:
    """Insert or replace the cooldown row described by `state`."""
    values = [state[f] for f in COOLDOWN_FIELDS] + [now_iso()]
    updates = ", ".join(f"{f}=excluded.{f}" for f in COOLDOWN_FIELDS[3:])
    conn.execute(
        f"INSERT INTO insider_alert_cooldowns ({', '.join(COOLDOWN_FIELDS)}, updated_at) "
        f"VALUES ({', '.join('?' for _ in values)}) "
        f"ON CONFLICT(insider_cik, issuer_cik, direction) DO UPDATE SET {updates}, "
        "updated_at=excluded.updated_at",
        values,
    )


def insider_filings_by_status(conn: sqlite3.Connection, *statuses: str,
                              unnotified_only: bool = False) -> list[sqlite3.Row]:
    marks = ", ".join("?" for _ in statuses)
    sql = f"SELECT * FROM insider_filings WHERE status IN ({marks})"
    if unnotified_only:
        sql += " AND notified_at IS NULL"
    sql += " ORDER BY filing_date, id"
    return conn.execute(sql, statuses).fetchall()


def replace_insider_owners(conn: sqlite3.Connection, filing_id: int,
                           owners: list[dict]) -> None:
    """Store a filing's reporting owners in filing order (index 0 = primary)."""
    conn.execute("DELETE FROM insider_filing_owners WHERE filing_id = ?", (filing_id,))
    for index, o in enumerate(owners):
        conn.execute(
            """INSERT INTO insider_filing_owners
               (filing_id, insider_cik, owner_index, is_director, is_officer,
                is_ten_percent_owner, is_other, officer_title, other_text)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (
                filing_id, o["cik"], index, int(bool(o.get("is_director"))),
                int(bool(o.get("is_officer"))), int(bool(o.get("is_ten_percent_owner"))),
                int(bool(o.get("is_other"))), o.get("officer_title"), o.get("other_text"),
            ),
        )


def replace_insider_transactions(conn: sqlite3.Connection, filing_id: int,
                                 rows: list[dict]) -> int:
    """Store a filing's open-market rows, replacing any previous parse of it."""
    conn.execute("DELETE FROM insider_transactions WHERE filing_id = ?", (filing_id,))
    for r in rows:
        conn.execute(
            """INSERT INTO insider_transactions
               (filing_id, tx_date, tx_date_as_filed, deemed_execution_date, security_title,
                transaction_code, action, acquired_disposed, timeliness, shares,
                price_per_share, amount_min_cents, amount_max_cents,
                amount_exact_cents, shares_after, direct_or_indirect,
                nature_of_ownership, footnotes, late, implausible)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                filing_id, r.get("tx_date"), r.get("tx_date_as_filed"), r.get("deemed_execution_date"),
                r.get("security_title"), r["transaction_code"], r["action"],
                r.get("acquired_disposed"), r.get("timeliness"), r.get("shares"),
                r.get("price_per_share"), r.get("amount_min_cents"),
                r.get("amount_max_cents"), r.get("amount_exact_cents"),
                r.get("shares_after"), r.get("direct_or_indirect"),
                r.get("nature_of_ownership"), r.get("footnotes"), r.get("late"),
                r.get("implausible"),
            ),
        )
    return len(rows)
