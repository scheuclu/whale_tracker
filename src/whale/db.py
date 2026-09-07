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
"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from pathlib import Path

SCHEMA_VERSION = 2

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
    sql = f"""SELECT f.*, p.full_name AS member_name, p.party, p.chamber AS member_chamber
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


def last_alert(conn: sqlite3.Connection, ticker: str, direction: str) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM alerts WHERE ticker = ? AND direction = ? "
        "ORDER BY fired_at DESC LIMIT 1",
        (ticker, direction),
    ).fetchone()


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
