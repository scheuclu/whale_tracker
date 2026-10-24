"""Multi-symbol issuerTradingSymbol values (#21).

HEICO, Lennar and Greif list every share class in the field ("HEI, HEI.A",
"LEN, LEN.B", "GEF, GEF-B"). Stored whole, the compound string never lined
up with the congressional HEI/LEN pages and went out as the headline of a
cluster alert. The first symbol is the ticker; the verbatim value stays in
`ticker_as_filed`. Split only — the field has no shape check, so an
exchange-prefixed ASX:LNW passes through untouched.
"""

import sqlite3

import pytest

from whale import db, edgar, form4, insiders

from form4_samples import APPLE_XML


@pytest.mark.parametrize("raw, expected", [
    ("HEI, HEI.A", "HEI"),
    ("LEN, LEN.B", "LEN"),
    ("GEF, GEF-B", "GEF"),
    ("GEF/GEF-B", "GEF"),
    ("hei hei.a", "HEI"),
    (" , HEI", "HEI"),           # a stray leading separator
    ("ASX:LNW", "ASX:LNW"),      # exchange prefix: one symbol, untouched
    ("BRK.B", "BRK.B"),
    ("AAPL", "AAPL"),
    ("NONE, N/A", None),         # placeholder first: still no ticker
    ("n/a", None),
    ("[NONE]", None),            # bracketed placeholder
    ("(N/A)", None),
    ("[none], [n/a]", None),
    (None, None),
])
def test_first_symbol_is_the_ticker(raw, expected):
    assert form4.normalize_ticker(raw) == expected


def _xml_with_symbol(symbol: str) -> str:
    return APPLE_XML.replace("<issuerTradingSymbol>AAPL</issuerTradingSymbol>",
                             f"<issuerTradingSymbol>{symbol}</issuerTradingSymbol>")


@pytest.mark.parametrize("symbol, ticker", [
    ("HEI, HEI.A", "HEI"),
    ("LEN, LEN.B", "LEN"),
    ("GEF, GEF-B", "GEF"),
    ("ASX:LNW", "ASX:LNW"),
])
def test_parsed_filing_keeps_the_verbatim_value_beside_the_ticker(symbol, ticker):
    doc = form4.parse_form4(_xml_with_symbol(symbol))
    assert (doc.ticker, doc.ticker_as_filed) == (ticker, symbol)


@pytest.fixture
def conn(tmp_path):
    c = db.connect(tmp_path / "t.sqlite3")
    yield c
    c.close()


def test_stored_filing_carries_both_columns(conn):
    doc = form4.parse_form4(_xml_with_symbol("HEI, HEI.A"))
    header = form4.SecHeader(accession="0000000000-26-000001", form_type="4", filed_date="2026-09-10",
                             accepted_at=None, period_of_report=None, issuer_cik=None, issuer_name=None)
    ref = edgar.FilingRef(accession="0000000000-26-000001", form_type="4", cik="0000320193",
                          filed_date="2026-09-10")
    insiders.store_filing(conn, header, doc, ref, "feed", "backfilled")
    row = conn.execute("SELECT ticker, ticker_as_filed FROM insider_filings").fetchone()
    assert (row["ticker"], row["ticker_as_filed"]) == ("HEI", "HEI, HEI.A")


# --- migration ---------------------------------------------------------------


def _filing(conn, accession, ticker, as_filed):
    return db.insert_insider_filing(
        conn, accession=accession, form_type="4", issuer_cik=accession[-3:].zfill(10),
        issuer_name="X", ticker=ticker, ticker_as_filed=as_filed, filing_date="2026-10-01",
        source="feed", source_url="u", status="backfilled")


def _v4_database(path):
    """A database as the pipeline left it at version 4: compound tickers
    stored whole, and a cluster alert keyed on one of them."""
    conn = db.connect(path)
    _filing(conn, "0000000000-26-000001", "HEI, HEI.A", "HEI, HEI.A")
    _filing(conn, "0000000000-26-000002", "HEI, HEI.A", "HEI, HEI.A")
    _filing(conn, "0000000000-26-000003", "LEN, LEN.B", "LEN, LEN.B")
    _filing(conn, "0000000000-26-000004", "GEF, GEF-B", "GEF, GEF-B")
    _filing(conn, "0000000000-26-000005", "ASX:LNW", "ASX:LNW")
    _filing(conn, "0000000000-26-000006", "AAPL", "AAPL")
    _filing(conn, "0000000000-26-000007", None, "NONE")
    _filing(conn, "0000000000-26-000008", None, None)   # a failed row with no header symbol
    db.record_alert(conn, "insider_cluster", "HEI, HEI.A", "buy", 30, 8, 140_059_455)
    db.record_alert(conn, "cluster", "HEI, HEI.A", "buy", 90, 3, 1)   # congressional: not ours to touch
    conn.execute("PRAGMA user_version = 4")
    conn.commit()
    conn.close()


def test_version_4_database_has_its_tickers_rederived(tmp_path):
    path = tmp_path / "v4.sqlite3"
    _v4_database(path)
    conn = db.connect(path)
    assert conn.execute("PRAGMA user_version").fetchone()[0] >= 5
    tickers = dict(conn.execute("SELECT accession, ticker FROM insider_filings").fetchall())
    assert tickers == {
        "0000000000-26-000001": "HEI", "0000000000-26-000002": "HEI",
        "0000000000-26-000003": "LEN", "0000000000-26-000004": "GEF",
        "0000000000-26-000005": "ASX:LNW", "0000000000-26-000006": "AAPL",
        "0000000000-26-000007": None, "0000000000-26-000008": None,
    }
    # Verbatim values are untouched.
    as_filed = {r[0] for r in conn.execute("SELECT ticker_as_filed FROM insider_filings")}
    assert {"HEI, HEI.A", "LEN, LEN.B", "GEF, GEF-B", "ASX:LNW", "NONE"} <= as_filed
    assert conn.execute("SELECT COUNT(*) FROM insider_filings WHERE ticker LIKE '%,%'").fetchone()[0] == 0
    conn.close()


def test_cluster_dedupe_row_follows_the_ticker(tmp_path):
    # Without this the HEI cluster — already reported at 8 insiders under the
    # compound key — would be "new" under HEI and re-sent.
    path = tmp_path / "v4.sqlite3"
    _v4_database(path)
    conn = db.connect(path)
    previous = db.last_alert(conn, "HEI", "buy", "insider_cluster")
    assert previous is not None and previous["politician_count"] == 8
    assert db.last_alert(conn, "HEI, HEI.A", "buy", "insider_cluster") is None
    # The congressional cluster row shares the string but is a different fact.
    assert db.last_alert(conn, "HEI, HEI.A", "buy", "cluster") is not None
    conn.close()


def test_migration_is_idempotent(tmp_path):
    path = tmp_path / "v4.sqlite3"
    _v4_database(path)
    db.connect(path).close()
    conn = db.connect(path)
    assert db._rederive_insider_tickers(conn) == 0
    conn.close()
