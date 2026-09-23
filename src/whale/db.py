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
"""

from __future__ import annotations

import sqlite3
from collections.abc import Iterable
from datetime import datetime, timezone
from pathlib import Path

SCHEMA_VERSION = 3

_DDL = """
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

-- Cluster-alert dedupe: one row per (ticker, direction) actually sent.
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  ticker TEXT NOT NULL,
  direction TEXT NOT NULL,
  window_days INTEGER NOT NULL,
  politician_count INTEGER NOT NULL,
  volume_mid_cents INTEGER,
  fired_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alerts_key ON alerts(ticker, direction);

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
  ticker TEXT,                         -- normalised issuerTradingSymbol; NULL for NONE / N/A / blank
  ticker_as_filed TEXT,                -- verbatim
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
  tx_date TEXT,                        -- as filed
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
  late INTEGER
);
CREATE INDEX IF NOT EXISTS idx_insider_tx_filing ON insider_transactions(filing_id);
CREATE INDEX IF NOT EXISTS idx_insider_tx_date   ON insider_transactions(tx_date);
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
    if version < SCHEMA_VERSION:
        conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
        conn.commit()


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
    return conn.execute(
        "SELECT * FROM transactions WHERE filing_id = ? ORDER BY id", (filing_id,)
    ).fetchall()


# --- alerts -----------------------------------------------------------------


def last_alert(conn: sqlite3.Connection, ticker: str, direction: str,
               kind: str | None = None) -> sqlite3.Row | None:
    """The most recent alert for this key.

    `kind` scopes the lookup to one alert family. Two sources can converge on
    the same ticker, and a congressional cluster must not suppress an insider
    one; `politician_count` holds whichever participant count the kind counts.
    """
    sql = "SELECT * FROM alerts WHERE ticker = ? AND direction = ?"
    params: list = [ticker, direction]
    if kind is not None:
        sql += " AND kind = ?"
        params.append(kind)
    return conn.execute(sql + " ORDER BY fired_at DESC LIMIT 1", params).fetchone()


def record_alert(conn: sqlite3.Connection, kind: str, ticker: str, direction: str,
                 window_days: int, politician_count: int,
                 volume_mid_cents: int | None) -> None:
    conn.execute(
        "INSERT INTO alerts (kind, ticker, direction, window_days, politician_count,"
        " volume_mid_cents, fired_at) VALUES (?,?,?,?,?,?,?)",
        (kind, ticker, direction, window_days, politician_count, volume_mid_cents, now_iso()),
    )


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
               (filing_id, tx_date, deemed_execution_date, security_title,
                transaction_code, action, acquired_disposed, timeliness, shares,
                price_per_share, amount_min_cents, amount_max_cents,
                amount_exact_cents, shares_after, direct_or_indirect,
                nature_of_ownership, footnotes, late)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                filing_id, r.get("tx_date"), r.get("deemed_execution_date"),
                r.get("security_title"), r["transaction_code"], r["action"],
                r.get("acquired_disposed"), r.get("timeliness"), r.get("shares"),
                r.get("price_per_share"), r.get("amount_min_cents"),
                r.get("amount_max_cents"), r.get("amount_exact_cents"),
                r.get("shares_after"), r.get("direct_or_indirect"),
                r.get("nature_of_ownership"), r.get("footnotes"), r.get("late"),
            ),
        )
    return len(rows)
