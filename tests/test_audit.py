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


# --- insiders (SEC Form 4) --------------------------------------------------
#
# Form 4 arrives as structured XML, so its risk is coverage rather than
# parsing: a sync that stops working stores nothing and says nothing.


def _insider_filing(conn, accession, status="backfilled", ticker="ACME",
                    filing_date="2026-06-20", owners=(("0000000010", "Alice"),)):
    fid = db.insert_insider_filing(
        conn, accession=accession, form_type="4", issuer_cik="0000000001",
        issuer_name="Acme Inc.", ticker=ticker, filing_date=filing_date,
        source="feed", source_url=f"http://sec/{accession}-index.htm", status=status)
    for cik, name in owners:
        db.upsert_insider(conn, cik, name)
    if owners:
        db.replace_insider_owners(conn, fid, [{"cik": cik} for cik, _ in owners])
    return fid


def _itx(**over):
    row = {"transaction_code": "S", "action": "sale", "tx_date": "2026-06-18",
           "shares": 100.0, "price_per_share": 10.0, "amount_min_cents": 100_000,
           "amount_max_cents": 100_000, "amount_exact_cents": 100_000, "late": 0}
    row.update(over)
    return row


def test_stored_form4_with_no_transactions_is_an_error(conn):
    # A filing is only stored once its open-market rows clear the floor, so
    # zero rows means the store path dropped them.
    _insider_filing(conn, "0000000000-26-000001")
    conn.commit()
    found = audit.check_insider_empty_filings(conn)
    assert found and found[0].severity == audit.ERROR


def test_stored_form4_with_transactions_is_not_flagged(conn):
    fid = _insider_filing(conn, "0000000000-26-000002")
    db.replace_insider_transactions(conn, fid, [_itx()])
    conn.commit()
    assert audit.check_insider_empty_filings(conn) == []


def test_unreadable_form4_is_not_expected_to_have_transactions(conn):
    _insider_filing(conn, "0000000000-26-000003", status="failed")
    conn.commit()
    assert audit.check_insider_empty_filings(conn) == []
    assert "insider_unreadable_filings" in codes(audit.check_insider_coverage(conn))


def test_filing_without_a_primary_owner_is_an_error(conn):
    fid = _insider_filing(conn, "0000000000-26-000004", owners=())
    db.replace_insider_transactions(conn, fid, [_itx()])
    conn.commit()
    found = audit.check_insider_primary_owner(conn)
    assert found and found[0].severity == audit.ERROR


def test_joint_filing_has_one_primary_owner_and_is_not_flagged(conn):
    fid = _insider_filing(conn, "0000000000-26-000005",
                          owners=(("0000000010", "Founder"), ("0000000020", "Founder LLC")))
    db.replace_insider_transactions(conn, fid, [_itx()])
    conn.commit()
    assert audit.check_insider_primary_owner(conn) == []


def test_disagreeing_amount_columns_are_an_error(conn):
    # An insider value is exact: a min/max pair would render it as a range.
    fid = _insider_filing(conn, "0000000000-26-000006")
    db.replace_insider_transactions(conn, fid, [_itx(amount_min_cents=90_000)])
    conn.commit()
    assert "insider_amount_inconsistent" in codes(audit.check_insider_values(conn))


def test_value_that_is_not_shares_times_price_is_an_error(conn):
    fid = _insider_filing(conn, "0000000000-26-000007")
    db.replace_insider_transactions(conn, fid, [
        _itx(shares=100.0, price_per_share=10.0, amount_min_cents=999,
             amount_max_cents=999, amount_exact_cents=999)])
    conn.commit()
    assert "insider_value_mismatch" in codes(audit.check_insider_values(conn))


def test_fractional_share_rounding_is_not_a_mismatch(conn):
    # 12.345 × $67.89 = $838.098... → 83810 cents, rounded half up.
    fid = _insider_filing(conn, "0000000000-26-000008")
    db.replace_insider_transactions(conn, fid, [
        _itx(shares=12.345, price_per_share=67.89, amount_min_cents=83_810,
             amount_max_cents=83_810, amount_exact_cents=83_810)])
    conn.commit()
    assert audit.check_insider_values(conn) == []


def test_value_without_shares_or_price_is_an_error(conn):
    fid = _insider_filing(conn, "0000000000-26-000009")
    db.replace_insider_transactions(conn, fid, [_itx(price_per_share=None)])
    conn.commit()
    assert "insider_value_without_inputs" in codes(audit.check_insider_values(conn))


def test_row_with_no_price_at_all_is_only_informational(conn):
    # An unknown value is not zero and not a defect — some filers put the
    # price in a footnote.
    fid = _insider_filing(conn, "0000000000-26-000010")
    db.replace_insider_transactions(conn, fid, [
        _itx(price_per_share=None, amount_min_cents=None, amount_max_cents=None,
             amount_exact_cents=None)])
    conn.commit()
    found = audit.check_insider_values(conn)
    assert codes(found) == {"insider_unpriced_rows"}
    assert found[0].severity == audit.INFO


def test_uncomparable_trade_date_is_informational(conn):
    # Seen live: a filer wrote "2026-09-08-05:00" as a transaction date.
    fid = _insider_filing(conn, "0000000000-26-000011")
    db.replace_insider_transactions(conn, fid, [_itx(tx_date="2026-06-18-05:00", late=None)])
    conn.commit()
    found = audit.check_insider_dates(conn)
    assert found and found[0].severity == audit.INFO


def test_comparable_dates_are_not_flagged(conn):
    fid = _insider_filing(conn, "0000000000-26-000012")
    db.replace_insider_transactions(conn, fid, [_itx(late=1)])
    conn.commit()
    assert audit.check_insider_dates(conn) == []


def test_healthy_sync_produces_no_feed_finding(conn):
    db.set_state(conn, "edgar_status", "ok: 12 stored / 87 seen")
    db.set_state(conn, "edgar_cursor", "2026-07-01T02:00:00Z")
    conn.commit()
    assert audit.check_insider_feed_health(conn, TODAY) == []


def test_throttled_sync_is_an_error(conn):
    db.set_state(conn, "edgar_status", "throttled: HTTP 403 for https://www.sec.gov/x")
    conn.commit()
    found = audit.check_insider_feed_health(conn, TODAY)
    assert found[0].code == "insider_sync_degraded" and found[0].severity == audit.ERROR


def test_missing_user_agent_is_not_an_error(conn):
    # The step skipping itself without a secret is a configuration state, not
    # a defect — flagging it weekly would be noise.
    db.set_state(conn, "edgar_status", "skipped: EDGAR_USER_AGENT not set")
    conn.commit()
    found = audit.check_insider_feed_health(conn, TODAY)
    assert found[0].code == "insider_sync_skipped" and found[0].severity == audit.INFO


def test_never_attempted_sync_is_informational(conn):
    assert audit.check_insider_feed_health(conn, TODAY)[0].code == "insider_sync_not_attempted"


def test_feed_gap_is_an_error_with_the_repair_command(conn):
    db.set_state(conn, "edgar_status", "gap: feed ran out before reaching the cursor")
    db.set_state(conn, "edgar_gap", "2026-06-20..2026-07-01")
    conn.commit()
    found = {f.code: f for f in audit.check_insider_feed_health(conn, TODAY)}
    gap = found["insider_feed_gap"]
    assert gap.severity == audit.ERROR
    assert "backfill-insiders --from 2026-06-20 --to 2026-07-01" in gap.evidence[0]


def test_stale_cursor_is_flagged_even_when_the_run_reports_success(conn):
    db.set_state(conn, "edgar_status", "ok: 0 stored / 0 seen")
    db.set_state(conn, "edgar_cursor", "2026-06-01T00:00:00Z")
    conn.commit()
    assert "insider_cursor_stale" in codes(audit.check_insider_feed_health(conn, TODAY))


def test_yesterdays_cursor_is_not_stale(conn):
    # The feed publishes nothing overnight; a one-day-old cursor is normal.
    db.set_state(conn, "edgar_status", "ok: 3 stored / 40 seen")
    db.set_state(conn, "edgar_cursor", "2026-06-30T23:00:00Z")
    conn.commit()
    assert audit.check_insider_feed_health(conn, TODAY) == []


def test_audit_runs_against_a_database_with_both_sources(conn):
    fid = _filing(conn, "both1")
    db.replace_transactions(conn, fid, None, [_tx()])
    ifid = _insider_filing(conn, "0000000000-26-000013")
    db.replace_insider_transactions(conn, ifid, [_itx()])
    db.set_state(conn, "edgar_status", "ok: 1 stored / 1 seen")
    conn.commit()
    findings = audit.run_checks(conn, TODAY)
    assert "check_failed" not in codes(findings)
    assert not [f for f in findings if f.severity == audit.ERROR]
    s = audit.summary(conn)
    assert s["insider_filings"] == 1 and s["insider_txs"] == 1 and s["insiders"] == 1
