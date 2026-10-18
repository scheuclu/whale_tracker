"""The audit's industry-classification coverage check (#55).

INFO on a healthy database, whatever the coverage: unclassified rows are a
fact about EDGAR (ETF trusts have no SIC), not a fault. A warning only when
the step's own last run reported a throttle or an error.
"""

from datetime import date

import pytest

from whale import audit, db, issuers

TODAY = date(2026, 10, 18)
APPLE, SPDR = "0000320193", "0000884394"


@pytest.fixture
def conn(tmp_path):
    c = db.connect(tmp_path / "t.sqlite3")
    yield c
    c.close()


def _seed(conn, classified: bool = True) -> None:
    fid = db.insert_filing(conn, chamber="house", doc_id="d1", filer_name="Some Member",
                           filing_type="P", filing_date="2026-10-01", year=2026,
                           pdf_url="http://x/d1.pdf", status="backfilled")
    db.replace_transactions(conn, fid, None, [
        {"asset_name": "Apple", "ticker": "AAPL", "asset_type": "ST", "action": "purchase",
         "tx_date": "2026-09-20", "amount_min_cents": 100_100, "amount_max_cents": 1_500_000},
        {"asset_name": "Apple again", "ticker": "AAPL", "asset_type": "ST", "action": "sale",
         "tx_date": "2026-09-21", "amount_min_cents": 100_100, "amount_max_cents": 1_500_000},
        {"asset_name": "SPDR", "ticker": "SPY", "asset_type": "EF", "action": "purchase",
         "tx_date": "2026-09-22", "amount_min_cents": 100_100, "amount_max_cents": 1_500_000},
        {"asset_name": "T-bill", "ticker": None, "asset_type": "GS", "action": "purchase",
         "tx_date": "2026-09-22", "amount_min_cents": 100_100, "amount_max_cents": 1_500_000},
    ])
    db.insert_insider_filing(conn, accession="0001104659-26-107065", form_type="4",
                             issuer_cik=APPLE, issuer_name="Apple Inc.", ticker="AAPL",
                             filing_date="2026-09-11", source="feed", source_url="u",
                             status="backfilled")
    db.insert_insider_filing(conn, accession="0001104659-26-107066", form_type="4",
                             issuer_cik="0000999999", issuer_name="Ghost", ticker=None,
                             filing_date="2026-09-11", source="feed", source_url="u",
                             status="backfilled")
    if classified:
        db.upsert_issuer_ticker(conn, "AAPL", APPLE)
        db.upsert_issuer_ticker(conn, "SPY", SPDR)
        db.upsert_issuer(conn, APPLE, ticker="AAPL", name="Apple Inc.", sic="3571",
                         sic_description="Electronic Computers", industry_group="Technology")
        db.upsert_issuer(conn, SPDR, ticker="SPY", name="SPDR S&P 500 ETF TRUST")
        db.set_state(conn, issuers.STATE_STATUS, "ok: 2 fetched, 0 failed, 0 to go")
    conn.commit()


def test_unrun_classification_is_reported_once_as_info(conn):
    _seed(conn, classified=False)
    (finding,) = audit.check_issuer_classification(conn, TODAY)
    assert (finding.severity, finding.code) == (audit.INFO, "issuer_classification_not_run")


def test_coverage_is_measured_on_equity_rows_and_insider_issuers(conn):
    _seed(conn)
    (finding,) = audit.check_issuer_classification(conn, TODAY)
    assert (finding.severity, finding.code) == (audit.INFO, "issuer_classification")
    # Two of the three equity-like rows with a ticker carry a group (the ETF
    # has none); the T-bill has no ticker and is not in the denominator.
    assert finding.title.startswith("67% of congressional equity rows")
    assert "1 of 2 Form 4 issuers classified" in finding.title
    assert "congressional equity rows with a sector: 2 of 3 (67%)" in finding.evidence
    assert "tickers classified: 1 of 2" in finding.evidence


def test_a_degraded_last_run_is_a_warning(conn):
    _seed(conn)
    db.set_state(conn, issuers.STATE_STATUS, "throttled: HTTP 403; 40 issuer(s) still to fetch")
    conn.commit()
    (finding,) = audit.check_issuer_classification(conn, TODAY)
    assert finding.severity == audit.WARN
    assert "throttled" in finding.title


def test_a_skipped_run_is_not_a_warning(conn):
    _seed(conn)
    db.set_state(conn, issuers.STATE_STATUS, "skipped: EDGAR_USER_AGENT not set")
    conn.commit()
    (finding,) = audit.check_issuer_classification(conn, TODAY)
    assert finding.severity == audit.INFO


def test_check_runs_right_after_transaction_density():
    names = [c.__name__ for c in audit.CHECKS]
    assert names.index("check_issuer_classification") == names.index("check_transaction_density") + 1


def test_check_does_not_fail_on_an_empty_database(conn):
    findings = audit.run_checks(conn, TODAY)
    assert "check_failed" not in {f.code for f in findings}
    assert "issuer_classification_not_run" in {f.code for f in findings}
