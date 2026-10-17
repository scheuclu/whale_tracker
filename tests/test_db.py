"""Schema migration: the committed database is at version 2 and must gain the
insider tables in place, without touching a politician row."""

import sqlite3

from whale import db


def _v2_database(path):
    """A database exactly as the pipeline left it before the insider tables."""
    raw = sqlite3.connect(path)
    raw.executescript(db._DDL)
    raw.execute("INSERT INTO politicians (bioguide_id, full_name, updated_at) VALUES ('X1', 'Some Member', 't')")
    raw.execute("PRAGMA user_version = 2")
    raw.commit()
    raw.close()


def _tables(conn):
    return {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}


def test_fresh_database_is_current(tmp_path):
    conn = db.connect(tmp_path / "fresh.sqlite3")
    assert conn.execute("PRAGMA user_version").fetchone()[0] == db.SCHEMA_VERSION == 7
    assert {"insiders", "insider_filings", "insider_filing_owners", "insider_transactions"} <= _tables(conn)
    conn.close()


def test_version_2_database_gains_insider_tables_in_place(tmp_path):
    path = tmp_path / "v2.sqlite3"
    _v2_database(path)
    conn = db.connect(path)
    assert conn.execute("PRAGMA user_version").fetchone()[0] == db.SCHEMA_VERSION
    assert {"insiders", "insider_filings", "insider_filing_owners", "insider_transactions"} <= _tables(conn)
    assert conn.execute("SELECT full_name FROM politicians").fetchone()[0] == "Some Member"
    conn.close()
    # Reconnecting is a no-op.
    again = db.connect(path)
    assert again.execute("PRAGMA user_version").fetchone()[0] == db.SCHEMA_VERSION
    again.close()


def test_deleting_a_filing_cascades_to_owners_and_rows(tmp_path):
    conn = db.connect(tmp_path / "t.sqlite3")
    fid = db.insert_insider_filing(conn, accession="0000000000-26-000001", form_type="4",
                                   issuer_cik="0000000001", issuer_name="X", filing_date="2026-09-11",
                                   source="feed", source_url="u", status="backfilled")
    db.upsert_insider(conn, "0000000002", "Someone")
    db.replace_insider_owners(conn, fid, [{"cik": "0000000002", "is_officer": True}])
    db.replace_insider_transactions(conn, fid, [{"transaction_code": "P", "action": "purchase",
                                                 "amount_exact_cents": 100}])
    conn.execute("DELETE FROM insider_filings WHERE id = ?", (fid,))
    assert conn.execute("SELECT COUNT(*) FROM insider_filing_owners").fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM insider_transactions").fetchone()[0] == 0
    conn.close()


def test_accession_is_unique_and_lookups_work(tmp_path):
    conn = db.connect(tmp_path / "t.sqlite3")
    fields = dict(form_type="4", issuer_cik="0000000001", issuer_name="X", filing_date="2026-09-11",
                  source="feed", source_url="u", status="backfilled")
    first = db.insert_insider_filing(conn, accession="0000000000-26-000001", **fields)
    assert db.insert_insider_filing(conn, accession="0000000000-26-000001", **fields) is None
    assert db.insider_filing_id(conn, "0000000000-26-000001") == first
    assert db.known_accessions(conn, ["0000000000-26-000001", "0000000000-26-000002"]) == {"0000000000-26-000001"}
    assert db.known_accessions(conn, []) == set()
    db.set_insider_status(conn, first, "failed", "broken")
    (row,) = db.insider_filings_by_status(conn, "failed")
    assert row["last_error"] == "broken"
    assert db.insider_filings_by_status(conn, "backfilled") == []
    conn.close()
