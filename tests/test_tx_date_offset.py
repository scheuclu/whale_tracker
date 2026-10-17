"""Offset-suffixed trade dates (#20).

One NEGG filer writes every transaction date as "2026-09-08-05:00" — a date
with a UTC offset. Stored verbatim, the 26 rows could not be compared to the
filing date, `late` stayed unknown, the dashboard showed "date as filed", and
the audit listed them every week on benign data. The value is unambiguous:
the date part is stored, the verbatim string kept beside it, and `late` is
derived normally. A genuinely unparseable value stays exactly as filed.
"""

import re
import sqlite3

import pytest

from whale import audit, db, edgar, form4, insiders

from form4_samples import APPLE_XML


@pytest.mark.parametrize("raw, expected", [
    ("2026-09-08-05:00", ("2026-09-08", "2026-09-08-05:00")),
    ("2026-09-08+01:00", ("2026-09-08", "2026-09-08+01:00")),
    (" 2026-09-08-05:00 ", ("2026-09-08", " 2026-09-08-05:00 ")),
    ("2026-09-08", ("2026-09-08", None)),            # plain: nothing parsed away
    ("2026-13-45-05:00", ("2026-13-45-05:00", None)),  # offset shape, impossible date: as filed
    ("09/08/2026", ("09/08/2026", None)),             # unparseable: as filed
    ("2026-09-08T10:00:00", ("2026-09-08T10:00:00", None)),  # not the shape this parses
    ("garbage", ("garbage", None)),
    (None, (None, None)),
])
def test_only_the_offset_shape_is_parsed(raw, expected):
    assert form4.parse_filed_date(raw) == expected


def _xml_with_date(value: str) -> str:
    return APPLE_XML.replace("<transactionDate><value>2026-09-08</value></transactionDate>",
                             f"<transactionDate><value>{value}</value></transactionDate>")


def test_parsed_transaction_keeps_the_verbatim_date():
    (tx,) = form4.parse_form4(_xml_with_date("2026-09-08-05:00")).transactions
    assert (tx.tx_date, tx.tx_date_as_filed) == ("2026-09-08", "2026-09-08-05:00")
    (plain,) = form4.parse_form4(APPLE_XML).transactions
    assert (plain.tx_date, plain.tx_date_as_filed) == ("2026-09-08", None)


@pytest.fixture
def conn(tmp_path):
    c = db.connect(tmp_path / "t.sqlite3")
    yield c
    c.close()


def _store(conn, accession, date_value, filed="2026-09-10"):
    doc = form4.parse_form4(_xml_with_date(date_value))
    header = form4.SecHeader(accession=accession, form_type="4", filed_date=filed, accepted_at=None,
                             period_of_report=None, issuer_cik=None, issuer_name=None)
    ref = edgar.FilingRef(accession=accession, form_type="4", cik="0000320193", filed_date=filed)
    fid = insiders.store_filing(conn, header, doc, ref, "feed", "backfilled")
    conn.commit()
    return conn.execute("SELECT * FROM insider_transactions WHERE filing_id = ?", (fid,)).fetchone()


def test_ingest_stores_the_date_and_derives_late(conn):
    row = _store(conn, "0000000000-26-000001", "2026-09-08-05:00")
    assert (row["tx_date"], row["tx_date_as_filed"]) == ("2026-09-08", "2026-09-08-05:00")
    assert row["late"] == 0   # Tue 8th -> Thu 10th: two business days
    late = _store(conn, "0000000000-26-000002", "2026-09-04-05:00", filed="2026-09-10")
    assert late["late"] == 1  # Fri 4th -> Thu 10th, Labor Day excluded: three


def test_a_genuinely_unparseable_date_stays_uncomparable(conn):
    row = _store(conn, "0000000000-26-000003", "09/08/2026")
    assert (row["tx_date"], row["tx_date_as_filed"], row["late"]) == ("09/08/2026", None, None)
    assert audit.check_insider_dates(conn)[0].evidence == [
        "0000000000-26-000003  AAPL  traded '09/08/2026'  filed 2026-09-10"]


def test_audit_no_longer_lists_offset_dates(conn):
    _store(conn, "0000000000-26-000004", "2026-09-08-05:00")
    assert audit.check_insider_dates(conn) == []


# --- migration ---------------------------------------------------------------


def _v5_database(path):
    """A database as the pipeline left it at version 5: offset-suffixed dates
    stored verbatim with `late` unknown, no tx_date_as_filed column."""
    v5_insider_ddl = re.sub(r"\n\s*tx_date_as_filed TEXT,[^\n]*", "", db._INSIDER_DDL)
    assert "tx_date_as_filed" not in v5_insider_ddl
    conn = sqlite3.connect(path)
    conn.executescript(db._DDL + v5_insider_ddl)
    conn.execute("""INSERT INTO insider_filings (id, accession, form_type, issuer_cik, issuer_name, ticker,
                    filing_date, source, source_url, status, first_seen_at, updated_at)
                    VALUES (1, 'a-1', '4', '0000000001', 'Newegg', 'NEGG', '2026-09-10', 'feed', 'u',
                            'backfilled', 't', 't')""")
    for tx_date, deemed in (
        ("2026-09-08-05:00", None),          # the NEGG shape
        ("2026-09-04-05:00", None),          # the NEGG shape, three business days before filing
        ("2026-09-08-05:00", "2026-09-09"),  # deemed execution date still starts the clock
        ("09/08/2026", None),                # genuinely unparseable
        ("2026-09-09", None),                # plain, already comparable
    ):
        conn.execute(
            """INSERT INTO insider_transactions (filing_id, tx_date, deemed_execution_date,
               transaction_code, action, late) VALUES (1, ?, ?, 'S', 'sale', ?)""",
            (tx_date, deemed, None if "-05:00" in tx_date or "/" in tx_date else 0))
    conn.execute("PRAGMA user_version = 5")
    conn.commit()
    conn.close()


def test_version_5_database_has_its_offset_dates_reparsed(tmp_path):
    path = tmp_path / "v5.sqlite3"
    _v5_database(path)
    conn = db.connect(path)
    assert conn.execute("PRAGMA user_version").fetchone()[0] >= 6
    rows = conn.execute(
        "SELECT tx_date, tx_date_as_filed, late FROM insider_transactions ORDER BY id").fetchall()
    assert [tuple(r) for r in rows] == [
        ("2026-09-08", "2026-09-08-05:00", 0),
        ("2026-09-04", "2026-09-04-05:00", 1),
        ("2026-09-08", "2026-09-08-05:00", 0),   # 9th -> 10th via the deemed date
        ("09/08/2026", None, None),
        ("2026-09-09", None, 0),
    ]
    # The audit now lists only the genuinely unparseable row.
    (finding,) = audit.check_insider_dates(conn)
    assert finding.evidence == ["a-1  NEGG  traded '09/08/2026'  filed 2026-09-10"]
    conn.close()
    # Reconnecting is a no-op.
    again = db.connect(path)
    assert again.execute("SELECT COUNT(*) FROM insider_transactions WHERE tx_date_as_filed IS NOT NULL").fetchone()[0] == 3
    again.close()


def test_reparse_is_idempotent(tmp_path):
    path = tmp_path / "v5.sqlite3"
    _v5_database(path)
    db.connect(path).close()
    conn = db.connect(path)
    assert insiders.reparse_trade_dates(conn) == 0
    conn.close()
