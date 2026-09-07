"""Parser tests against real filings committed as fixtures.

The fixtures are unmodified PDFs from disclosures-clerk.house.gov, chosen to
cover the shapes that broke naive parsing: a single transaction with an exact
amount, an amount that wraps across two lines, a filing that spans pages, and
a scanned paper filing with no text layer at all.
"""

from pathlib import Path

import pytest

from whale.amounts import parse_amount
from whale.ptr import ScannedFilingError, parse_pdf

FIXTURES = Path(__file__).parent / "fixtures"

SINGLE = FIXTURES / "ptr_20034999.pdf"       # 1 tx, exact amount, IRA description
TREASURY = FIXTURES / "ptr_20034984.pdf"     # [GS] asset, amount wraps two lines
MULTIPAGE = FIXTURES / "ptr_20034807.pdf"    # 13 tx across 3 pages
SCANNED = FIXTURES / "ptr_scanned_9116308.pdf"


def test_single_transaction_filing():
    r = parse_pdf(SINGLE)
    assert r.filer_name == "Debbie Wasserman Schultz"
    assert r.state_district == "FL25"
    assert r.status == "Member"
    assert len(r.transactions) == 1

    tx = r.transactions[0]
    assert tx.ticker == "ICHR"
    assert tx.asset_type == "ST"
    assert tx.action == "sale"
    assert tx.asset_name == "Ichor Holdings - Ordinary Shares"
    assert tx.tx_date == "2026-06-17"
    assert tx.notification_date == "2026-07-14"
    assert parse_amount(tx.amount_raw).exact_cents == 272_250
    assert "Individual Retirement Account" in tx.description


def test_amount_wrapping_across_lines_is_rejoined():
    # The amount cell renders as "$15,001 -" then "$50,000" on the next line.
    r = parse_pdf(TREASURY)
    tx = r.transactions[0]
    assert tx.amount_raw == "$15,001 - $50,000"
    amount = parse_amount(tx.amount_raw)
    assert (amount.min_cents, amount.max_cents) == (1_500_100, 5_000_000)


def test_asset_without_ticker_keeps_type_code():
    r = parse_pdf(TREASURY)
    tx = r.transactions[0]
    assert tx.ticker is None
    assert tx.asset_type == "GS"
    assert tx.asset_name.startswith("Treasury Bill")
    assert "[GS]" not in tx.asset_name


def test_multipage_filing_reads_every_row():
    r = parse_pdf(MULTIPAGE)
    assert r.filer_name == "Matthew Robert Van Epps"
    assert len(r.transactions) == 13

    tickers = [t.ticker for t in r.transactions]
    assert tickers == ["GOOGL", "AMZN", "AAPL", "XOM", "GE", "GEV", "INTC",
                       "IBM", "META", "MSFT", "NVDA", "LUV", "TPR"]
    # Every row parsed completely — a dropped column is the failure mode that
    # silently corrupts statistics.
    assert all(t.tx_date == "2026-06-16" for t in r.transactions)
    assert all(t.action == "sale" for t in r.transactions)
    assert all(parse_amount(t.amount_raw) is not None for t in r.transactions)


def test_asset_name_wrapping_across_lines():
    r = parse_pdf(MULTIPAGE)
    ibm = next(t for t in r.transactions if t.ticker == "IBM")
    # Name spans three lines in the PDF before the "(IBM) [ST]" marker.
    assert ibm.asset_name == "International Business Machines Corporation Common Stock"


def test_scanned_filing_is_detected_not_silently_empty():
    with pytest.raises(ScannedFilingError):
        parse_pdf(SCANNED)
