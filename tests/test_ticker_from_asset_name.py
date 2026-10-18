"""Tickers read from the asset name when the ticker column is empty (#50).

415 equity rows had no ticker while the name carried one in parentheses:
410 Senate rows whose eFD ticker cell read "--" — Alan Armstrong's ADR
ladder, "Nestle SA Sponsored ADR (NSRGY)" — and House rows where a comment
wrapping into the asset column pushed the form's own "(TEM) [ST]" slot off
the end of the cell, so `_resolve_asset` never saw it. The symbol is the one
the filer typed, in the wrong cell; the name stays verbatim and the row says
where its ticker came from. Every asset name below is a real one from the
production database unless marked synthetic.
"""

from pathlib import Path

import pytest

from whale import audit, db, house, pipeline, roster, senate_ptr
from whale.config import Config
from whale.ptr import (SLOT_SYMBOL_RE, TICKER_FROM_NAME_NOTE, Transaction, _resolve_asset,
                       parse_pdf, ticker_from_asset_name, with_ticker_note)

FIXTURES = Path(__file__).parent / "fixtures"

PELOSI_TEM = "Tempus AI, Inc. - Class A Common Stock (TEM) [ST] 1/16/26."
PELOSI_NOTE = ("Exercised 50 call options purchased 1/14/25 (5,000 shares) at a strike "
               "price of $20 with an expiration date of")
AVB_EXCHANGE = ("AvalonBay Communities, Inc. Common Stock (AVB) (Exchanged) VMRK - Vivmark "
                "Residential Common Shares of Beneficial Interest (Received)")


# --- the rule ----------------------------------------------------------------


@pytest.mark.parametrize("name, expected", [
    ("BHP Group Limited (BHP)", "BHP"),
    ("Nestle SA Sponsored ADR (NSRGY)", "NSRGY"),
    ("Citigroup New Inc (C)", "C"),
    ("Loews Corporation (L)", "L"),
    ("Sea Limited (SE)", "SE"),                       # short, but a real symbol
    ("Atlas Copco AB New Shares Representing Series A Common Stock (Sponsored) (ATLKY)", "ATLKY"),
    (AVB_EXCHANGE, "AVB"),                             # the received leg is not parenthesised
    ("Honeywell Aerospace Inc. - Common Stock (HONAV) [ST] Aerospace Inc. (HONAV) shares due to a",
     "HONAV"),                                         # the same symbol twice is one symbol
    ("Berkshire Hathaway Inc. New Common Stock (BRK.B) [ST] sold @ $493.42/share", "BRK.B"),
    ("Greif, Inc. Class B Common Stock (GEF-B)", "GEF-B"),   # synthetic: the dash class form
    ("ACN - Accenture plc Class A Ordinary Shares (Ireland)", None),   # a word, not a symbol
    ("Cadence Bank 5.50% Series A (CADE$A)", None),    # a broker's preferred-class notation
    ("Lord Abbett Short Duration High Yield I (LSYIXX)", None),       # synthetic: six letters
    ("GS Managed Structured Note Strategy S&P 500 Linked Note", None),  # nothing in parentheses
    ("Treasury Bill (912797GH8)", None),               # synthetic: a CUSIP
    ("Meta Platforms (FB) - Common Stock (META)", None),   # synthetic: two symbols, not a guess
    ("", None),
    (None, None),
])
def test_exactly_one_parenthesised_symbol_is_the_ticker(name, expected):
    assert ticker_from_asset_name(name) == expected


@pytest.mark.parametrize("name, expected", [
    (PELOSI_TEM, "TEM"),
    ("Vistra Corp. Common Stock (VST) [ST] 1/16/26.", "VST"),
    ("Litecoin (LTC) [CT] fluctuated to just over $1,000. Filer did not", "LTC"),
    ("Berkshire Hathaway Inc. New Common Stock (BRK.B) [ST] sold @ $493.42/share", "BRK.B"),
    ("Hologic, Inc. [PS] right (CVR) to be paid in 2026-27.", None),   # not in the slot
    ("Advanced Machine Intelligence (AMI) Labs", None),                # an abbreviation
    ("MOSAIC COMPANY (THE) CMN", None),
    ("TJX COMPANIES INC (NEW) CMN", None),
    ("Lord Abbett Short Duration High Yield I (LSYIX) bond fund", None),   # a real fund, no slot
])
def test_a_house_row_only_trusts_the_forms_own_slot(name, expected):
    assert ticker_from_asset_name(name, SLOT_SYMBOL_RE) == expected


def test_the_generic_rule_would_have_taken_the_house_abbreviations():
    # Why the House passes the slot pattern: these parse as symbols otherwise.
    assert ticker_from_asset_name("MOSAIC COMPANY (THE) CMN") == "THE"
    assert ticker_from_asset_name("Advanced Machine Intelligence (AMI) Labs") == "AMI"


def test_the_note_is_appended_once():
    assert with_ticker_note(None) == TICKER_FROM_NAME_NOTE
    assert with_ticker_note("") == TICKER_FROM_NAME_NOTE
    assert with_ticker_note("Sale due to corporate transaction") == (
        "Sale due to corporate transaction · " + TICKER_FROM_NAME_NOTE)
    noted = with_ticker_note("x")
    assert with_ticker_note(noted) == noted


# --- House -------------------------------------------------------------------


def _house(name, description=None):
    tx = Transaction(asset_name=name, action="purchase", description=description)
    _resolve_asset(tx)
    return tx


def test_house_slot_pushed_off_the_end_of_the_cell_still_yields_the_ticker():
    tx = _house(PELOSI_TEM, description=PELOSI_NOTE)
    assert tx.ticker == "TEM"
    # What was filed, trailing text and all; the type is not guessed either.
    assert tx.asset_name == PELOSI_TEM
    assert tx.asset_type is None
    assert tx.description == PELOSI_NOTE + " · " + TICKER_FROM_NAME_NOTE


def test_house_row_with_the_slot_at_the_end_is_untouched():
    tx = _house("NVIDIA Corporation - Common Stock (NVDA) [ST]")
    assert (tx.ticker, tx.asset_type) == ("NVDA", "ST")
    assert tx.asset_name == "NVIDIA Corporation - Common Stock"
    assert tx.description is None


@pytest.mark.parametrize("name, asset_type", [
    ("Cadence Bank 5.50% Series A (CADE$A) [ST]", "ST"),
    ("Advanced Machine Intelligence (AMI) Labs [OI]", "OI"),
    ("Hologic, Inc. [PS] right (CVR) to be paid in 2026-27.", None),
    ("Treasury Bill (912797GH8) [GS]", "GS"),      # synthetic: a CUSIP in the slot
])
def test_house_symbols_outside_the_slot_are_not_tickers(name, asset_type):
    tx = _house(name)
    assert tx.ticker is None
    assert tx.asset_type == asset_type
    assert tx.description is None


@pytest.mark.parametrize("fixture", ["ptr_20034999.pdf", "ptr_20034984.pdf", "ptr_20034807.pdf"])
def test_real_text_filings_never_need_the_fallback(fixture):
    for tx in parse_pdf(FIXTURES / fixture).transactions:
        assert not (tx.description and TICKER_FROM_NAME_NOTE in tx.description)


# --- Senate ------------------------------------------------------------------


def _load(name: str) -> str:
    return (FIXTURES / name).read_text()


def test_senate_empty_cell_takes_the_symbol_from_the_name():
    html = _load("efd_ptr_carper_2019-10-01.html").replace(
        "CS Contingent Autocall on MSFT", "BHP Group Limited (BHP)", 1)
    report = senate_ptr.parse_report(html)
    rows = [t for t in report.transactions if t.asset_name == "BHP Group Limited (BHP)"]
    assert len(rows) == 1
    tx = rows[0]
    assert tx.ticker == "BHP"
    assert tx.raw_text.split(" | ")[3] == "--"
    assert tx.description == "Rate/Coupon: 8.25% · Matures: 09/30/2022 · " + TICKER_FROM_NAME_NOTE
    # Every other row still has nothing to read.
    assert all(t.ticker is None for t in report.transactions if t is not tx)


def test_senate_filled_cell_wins_and_the_name_is_not_consulted():
    report = senate_ptr.parse_report(_load("efd_ptr_loeffler_2020-02-07.html"))
    assert any(t.ticker for t in report.transactions)
    assert not any(t.description and TICKER_FROM_NAME_NOTE in t.description
                   for t in report.transactions)


def _cells(*texts):
    return [senate_ptr._Cell(main=[t], detail=[]) for t in texts]


def test_senate_two_legs_in_the_cell_leave_the_name_alone():
    tx = senate_ptr._transaction(_cells(
        "1", "08/14/2026", "Joint", "BERY AMCR", "Amcor plc (AMCR)", "Stock", "Exchange",
        "$15,001 - $50,000", "--"))
    assert tx.ticker is None
    assert tx.description == "Tickers: BERY, AMCR"


def test_senate_exchange_row_naming_one_leg_in_parentheses():
    tx = senate_ptr._transaction(_cells(
        "2", "08/14/2026", "Joint", "--", AVB_EXCHANGE, "Stock", "Exchange",
        "$15,001 - $50,000", "--"))
    assert (tx.ticker, tx.asset_name, tx.description) == ("AVB", AVB_EXCHANGE, TICKER_FROM_NAME_NOTE)


# --- stored rows -------------------------------------------------------------


def _filing(conn, chamber, doc_id, status="backfilled"):
    senate = chamber == "senate"
    return db.insert_filing(
        conn, chamber=chamber, doc_id=doc_id, politician_id=None,
        filer_name="Alan Armstrong" if senate else "Nancy Pelosi",
        state_district="OK" if senate else "CA11", filing_type="P",
        filing_date="2026-09-01", year=2026, pdf_url=f"https://x/{doc_id}",
        status=status, parse_method="efd_html" if senate else "text")


def _senate_raw(ticker_cell, name):
    return f"1 | 08/01/2026 | Self | {ticker_cell} | {name} | Stock | Purchase | $1,001 - $15,000 | --"


def _row(asset_name, ticker=None, **over):
    row = {"asset_name": asset_name, "ticker": ticker, "asset_type": "ST",
           "action": "purchase", "tx_date": "2026-08-01", "notification_date": None,
           "amount_min_cents": 100_100, "amount_max_cents": 1_500_000,
           "raw_text": _senate_raw("--", asset_name)}
    row.update(over)
    return row


def _tickers(conn):
    return [r["ticker"] for r in conn.execute("SELECT ticker FROM transactions ORDER BY id")]


def _seed(conn):
    senate = _filing(conn, "senate", "s1")
    house_ = _filing(conn, "house", "h1")
    db.replace_transactions(conn, senate, None, [
        _row("Nestle SA Sponsored ADR (NSRGY)"),
        _row("BHP Group Limited (BHP)", description="Sale due to corporate transaction"),
        _row("ACN - Accenture plc Class A Ordinary Shares (Ireland)"),
        # The cell held two legs, which #40's normalisation left as NULL
        # without the "Tickers:" note: the name must not be consulted.
        _row("Amcor plc (AMCR)", action="exchange",
             raw_text=_senate_raw("BERY AMCR", "Amcor plc (AMCR)")),
        _row("Unilever PLC (UL)", ticker="UL"),
        _row("GS Managed Structured Note Strategy S&P 500 Linked Note"),
    ])
    db.replace_transactions(conn, house_, None, [
        _row(PELOSI_TEM, asset_type=None, description=PELOSI_NOTE, raw_text=""),
        _row("Advanced Machine Intelligence (AMI) Labs", asset_type="OI", raw_text=""),
        _row("Cadence Bank 5.50% Series A (CADE$A)", raw_text=""),
    ])
    conn.commit()


def test_stored_rows_are_rederived_once(tmp_path):
    conn = db.connect(tmp_path / "t.sqlite3")
    _seed(conn)
    assert _tickers(conn) == [None, None, None, None, "UL", None, None, None, None]

    assert pipeline._derive_tickers_from_names(conn) == 3
    assert _tickers(conn) == ["NSRGY", "BHP", None, None, "UL", None, "TEM", None, None]
    rows = conn.execute("SELECT asset_name, description FROM transactions ORDER BY id").fetchall()
    assert rows[0]["description"] == TICKER_FROM_NAME_NOTE
    assert rows[1]["description"] == "Sale due to corporate transaction · " + TICKER_FROM_NAME_NOTE
    assert rows[4]["description"] is None                      # had a ticker: untouched
    assert rows[6]["description"] == PELOSI_NOTE + " · " + TICKER_FROM_NAME_NOTE
    assert rows[6]["asset_name"] == PELOSI_TEM                 # verbatim
    # Idempotent: a second pass finds nothing to change.
    assert pipeline._derive_tickers_from_names(conn) == 0
    conn.close()


def test_sync_rederives_stored_rows_before_fetching(tmp_path, monkeypatch):
    conn = db.connect(tmp_path / "t.sqlite3")
    _seed(conn)
    monkeypatch.setattr(roster, "sync", lambda c: None)
    monkeypatch.setattr(house, "fetch_index", lambda year: [])
    config = Config()
    config.senate_enabled = False
    pipeline.sync(conn, config)
    assert _tickers(conn) == ["NSRGY", "BHP", None, None, "UL", None, "TEM", None, None]
    conn.close()


# --- audit -------------------------------------------------------------------


def test_audit_counts_rows_whose_ticker_came_from_the_name(tmp_path):
    conn = db.connect(tmp_path / "t.sqlite3")
    _seed(conn)
    pipeline._derive_tickers_from_names(conn)
    found = audit.check_tickers_from_asset_names(conn)
    assert len(found) == 1 and found[0].severity == audit.INFO
    assert found[0].code == "tickers_from_asset_names"
    assert found[0].title.startswith("3 transaction(s)")
    assert "(3 distinct symbol(s))" in found[0].title
    symbols = [line.split()[0] for line in found[0].evidence]
    assert sorted(symbols) == ["BHP", "NSRGY", "TEM"]
    assert "UL" not in symbols
    # Derived tickers are ordinary symbols: the sanity check stays quiet.
    assert audit.check_ticker_sanity(conn) == []
    conn.close()


def test_audit_is_silent_when_no_ticker_came_from_a_name(tmp_path):
    conn = db.connect(tmp_path / "t.sqlite3")
    fid = _filing(conn, "house", "h1")
    db.replace_transactions(conn, fid, None, [
        _row("NVIDIA Corporation", ticker="NVDA", raw_text=""),
        _row("Cadence Bank 5.50% Series A (CADE$A)", raw_text=""),
    ])
    conn.commit()
    assert audit.check_tickers_from_asset_names(conn) == []
    assert "tickers_from_asset_names" not in {f.code for f in audit.run_checks(conn)}
    conn.close()


def test_the_check_runs_right_after_ticker_sanity():
    checks = list(audit.CHECKS)
    assert checks.index(audit.check_tickers_from_asset_names) == (
        checks.index(audit.check_ticker_sanity) + 1)
