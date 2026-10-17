"""Two rows the first live Senate backfill put in front of the audit (#40).

An exchange row's ticker cell read "-- AMCR": eFD prints "--" for a leg with
no symbol, and the parser kept the whole cell. And "Over $50,000,000" was
stored with the printed figure as its floor while the audit's ladder said one
dollar more. Both are fixed at the source; the stored ticker is re-derived by
the idempotent Senate normalisation that already runs on every sync.
"""

from whale import audit, db, pipeline, senate_ptr
from whale.amounts import parse_amount


def test_placeholder_is_dropped_and_a_single_symbol_kept():
    assert senate_ptr.ticker_from_cell("-- AMCR") == ("AMCR", ["AMCR"])
    assert senate_ptr.ticker_from_cell("rnwk") == ("RNWK", ["RNWK"])


def test_no_symbol_is_null():
    assert senate_ptr.ticker_from_cell("--") == (None, [])
    assert senate_ptr.ticker_from_cell("") == (None, [])
    assert senate_ptr.ticker_from_cell(None) == (None, [])


def test_two_symbols_are_not_guessed_between():
    assert senate_ptr.ticker_from_cell("BERY AMCR") == (None, ["BERY", "AMCR"])


def _tx(ticker, **over):
    row = {"asset_name": "Amcor plc", "ticker": ticker, "asset_type": "ST",
           "action": "exchange", "tx_date": "2026-08-01", "notification_date": None,
           "amount_min_cents": 100_100, "amount_max_cents": 1_500_000}
    row.update(over)
    return row


def test_stored_two_line_ticker_is_normalised_once(tmp_path):
    conn = db.connect(tmp_path / "t.sqlite3")
    fid = db.insert_filing(
        conn, chamber="senate", doc_id="abc", politician_id=None, filer_name="Ron L Wyden",
        state_district="OR", filing_type="P", filing_date="2026-09-01", year=2026,
        pdf_url="https://efdsearch.senate.gov/search/view/ptr/abc/",
        status="backfilled", parse_method="efd_html")
    db.replace_transactions(conn, fid, None, [
        _tx("-- AMCR"), _tx("BERY AMCR"), _tx("KEYS", action="purchase")])
    conn.commit()

    assert pipeline._normalise_senate_rows(conn) == 2
    tickers = [r[0] for r in conn.execute("SELECT ticker FROM transactions ORDER BY id")]
    assert tickers == ["AMCR", None, "KEYS"]
    # Idempotent: a second pass finds nothing to change.
    assert pipeline._normalise_senate_rows(conn) == 0


def test_open_ended_top_bracket_is_on_the_audit_ladder():
    a = parse_amount("Over $50,000,000")
    assert (a.min_cents, a.max_cents) == (5_000_000_000, None)
    assert (a.min_cents, a.max_cents) in audit.VALID_BRACKETS


def test_top_bracket_row_does_not_trip_the_bracket_check(tmp_path):
    conn = db.connect(tmp_path / "t.sqlite3")
    fid = db.insert_filing(
        conn, chamber="senate", doc_id="justice", politician_id=None,
        filer_name="James Conley Justice, II", state_district="WV", filing_type="P",
        filing_date="2026-09-28", year=2026,
        pdf_url="https://efdsearch.senate.gov/search/view/ptr/justice/",
        status="backfilled", parse_method="efd_html")
    db.mark_notified(conn, fid)
    db.replace_transactions(conn, fid, None, [
        _tx(None, asset_name="Greenbrier Hotel Corporation and Affiliates", asset_type=None,
            action="purchase", amount_min_cents=5_000_000_000, amount_max_cents=None)])
    conn.commit()
    assert audit.check_nonstandard_amount_brackets(conn) == []
