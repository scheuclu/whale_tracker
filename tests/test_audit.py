"""Audit checks.

Each test builds the smallest database that should trip exactly one check —
and, just as importantly, the near-miss that must NOT trip it. A check that
cries wolf every week gets ignored, which is worse than not having it.
"""

from datetime import date

import pytest

from whale import audit, db

TODAY = date(2026, 7, 1)


@pytest.fixture
def conn(tmp_path):
    c = db.connect(tmp_path / "t.sqlite3")
    yield c
    c.close()


def _filing(conn, doc_id, status="backfilled", filing_date="2026-06-20",
            politician_id=None, first_seen="2026-06-20T00:00:00Z", notified="x",
            parse_method="text"):
    fid = db.insert_filing(
        conn, chamber="house", doc_id=doc_id, politician_id=politician_id,
        filer_name="Test Filer", state_district="CA01", filing_type="P",
        filing_date=filing_date, year=2026, pdf_url="http://x/y.pdf",
        status=status, first_seen_at=first_seen, parse_method=parse_method)
    if notified:
        db.mark_notified(conn, fid)
    return fid


def _tx(**over):
    row = {"asset_name": "NVIDIA Corporation", "ticker": "NVDA", "asset_type": "ST",
           "action": "purchase", "tx_date": "2026-06-15",
           "notification_date": "2026-06-18",
           "amount_min_cents": 100_100, "amount_max_cents": 1_500_000}
    row.update(over)
    return row


def codes(findings):
    return {f.code for f in findings}


# --- the check that matters most --------------------------------------------


def test_parsed_filing_with_no_transactions_is_an_error(conn):
    # A PTR always contains at least one transaction. Zero means the parser
    # silently produced nothing and the filing will never be retried.
    _filing(conn, "empty1")
    conn.commit()
    found = audit.check_empty_parsed_filings(conn)
    assert found and found[0].severity == audit.ERROR


def test_filing_with_transactions_is_not_flagged(conn):
    fid = _filing(conn, "ok1")
    db.replace_transactions(conn, fid, None, [_tx()])
    conn.commit()
    assert audit.check_empty_parsed_filings(conn) == []


def test_unparsed_filing_is_not_expected_to_have_transactions(conn):
    _filing(conn, "scan1", status="failed")
    conn.commit()
    assert audit.check_empty_parsed_filings(conn) == []


# --- amounts ----------------------------------------------------------------


def test_amount_off_the_statutory_ladder_is_an_error(conn):
    fid = _filing(conn, "bad-amt")
    db.replace_transactions(conn, fid, None,
                            [_tx(amount_min_cents=12_345, amount_max_cents=67_890)])
    conn.commit()
    found = audit.check_nonstandard_amount_brackets(conn)
    assert found and found[0].severity == audit.ERROR


def test_spouse_dependent_over_one_million_is_a_valid_amount(conn):
    # The e-filed form reports "Spouse/DC Over $1,000,000" for a large trade in
    # a spouse's asset. It is not on the bracket ladder but it is legitimate.
    fid = _filing(conn, "spouse")
    db.replace_transactions(conn, fid, None,
                            [_tx(amount_min_cents=100_000_000, amount_max_cents=None)])
    conn.commit()
    assert audit.check_nonstandard_amount_brackets(conn) == []


def test_open_ended_top_bracket_is_valid(conn):
    fid = _filing(conn, "top")
    db.replace_transactions(conn, fid, None,
                            [_tx(amount_min_cents=5_000_000_100, amount_max_cents=None)])
    conn.commit()
    assert audit.check_nonstandard_amount_brackets(conn) == []


# --- tickers ----------------------------------------------------------------


def test_cusip_stored_as_ticker_is_flagged(conn):
    fid = _filing(conn, "cusip")
    db.replace_transactions(conn, fid, None,
                            [_tx(ticker="91282CGH8", asset_type="GS")])
    conn.commit()
    assert codes(audit.check_ticker_sanity(conn)) == {"suspicious_tickers"}


def test_real_tickers_colliding_with_asset_codes_are_not_flagged(conn):
    # Sensata trades as ST, AllianceBernstein as AB, Boeing as BA, Energy
    # Transfer as ET. Flagging these would make the check pure noise.
    fid = _filing(conn, "collide")
    db.replace_transactions(conn, fid, None, [
        _tx(ticker="ST", asset_type="ST", asset_name="Sensata Technologies"),
        _tx(ticker="AB", asset_type="AB", asset_name="AllianceBernstein"),
        _tx(ticker="BA", asset_type="ST", asset_name="Boeing Company"),
        _tx(ticker="ET", asset_type="ST", asset_name="Energy Transfer LP"),
    ])
    conn.commit()
    assert audit.check_ticker_sanity(conn) == []


# --- pipeline health --------------------------------------------------------


def test_filing_queued_for_days_is_flagged(conn):
    _filing(conn, "stuck", status="new", first_seen="2026-06-01T00:00:00Z", notified=None)
    conn.commit()
    found = audit.check_stuck_filings(conn, TODAY)
    assert found and found[0].severity == audit.ERROR


def test_recently_queued_filing_is_not_flagged(conn):
    _filing(conn, "fresh", status="new", first_seen="2026-07-01T00:00:00Z", notified=None)
    conn.commit()
    assert audit.check_stuck_filings(conn, TODAY) == []


def test_unmatched_filer_is_flagged(conn):
    _filing(conn, "nomatch", politician_id=None)
    conn.commit()
    assert codes(audit.check_unmatched_filers(conn)) == {"unmatched_filers"}


def test_missing_transaction_date_is_an_error(conn):
    fid = _filing(conn, "nodate")
    db.replace_transactions(conn, fid, None, [_tx(tx_date=None)])
    conn.commit()
    found = [f for f in audit.check_missing_transaction_fields(conn)
             if f.code == "missing_tx_date"]
    assert found and found[0].severity == audit.ERROR


def test_future_trade_date_is_flagged(conn):
    fid = _filing(conn, "future")
    db.replace_transactions(conn, fid, None, [_tx(tx_date="2026-12-26")])
    conn.commit()
    assert "future_trade_dates" in codes(audit.check_date_anomalies(conn, TODAY))


# --- report -----------------------------------------------------------------


def test_a_broken_check_is_reported_not_swallowed(conn, monkeypatch):
    def exploding(conn, today=None):
        raise RuntimeError("boom")

    monkeypatch.setattr(audit, "CHECKS", (exploding,))
    findings = audit.run_checks(conn)
    assert codes(findings) == {"check_failed"}
    # An unknown must never read as a pass.
    assert findings[0].severity == audit.WARN


def test_findings_are_ordered_worst_first(conn):
    _filing(conn, "empty1")               # error
    _filing(conn, "nomatch", "failed")    # info-ish coverage
    conn.commit()
    findings = audit.run_checks(conn, TODAY)
    severities = [f.severity for f in findings]
    assert severities == sorted(severities, key=lambda s: audit.SEVERITY_ORDER[s])


def test_report_renders_markdown_with_a_finding_count(tmp_path):
    c = db.connect(tmp_path / "r.sqlite3")
    _filing(c, "empty1")
    c.commit()
    c.close()
    text, findings = audit.report(tmp_path / "r.sqlite3", TODAY)
    assert "# Whale Tracker — data audit" in text
    assert "error" in text and "empty_parsed_filings" in text
    assert any(f.severity == audit.ERROR for f in findings)
