"""Audit: the Senate side after the parser exists (#40).

`check_senate` must stop saying the filings "need a parser", and the new
`check_senate_parse_coverage` must make a Senate parse failure visible —
while staying silent on a database that only indexed Senate filings, so it
does not fire every week on benign data.
"""

import pytest

from whale import audit, db

PTR_URL = "https://efdsearch.senate.gov/search/view/ptr/{}/"
PAPER_URL = "https://efdsearch.senate.gov/search/view/paper/{}/"


@pytest.fixture
def conn(tmp_path):
    c = db.connect(tmp_path / "t.sqlite3")
    yield c
    c.close()


def _filing(conn, doc_id, status, parse_method=None, paper=False, error=None):
    fid = db.insert_filing(
        conn, chamber="senate", doc_id=doc_id, politician_id=None,
        filer_name="Some Senator", state_district=None, filing_type="P",
        filing_date="2026-10-07", year=2026,
        pdf_url=(PAPER_URL if paper else PTR_URL).format(doc_id), status=status)
    if parse_method or error:
        db.set_status(conn, fid, status, error, parse_method)
    conn.commit()
    return fid


def _by_code(findings):
    return {f.code: f for f in findings}


# --- check_senate wording ---------------------------------------------------


def test_reachable_efd_no_longer_says_a_parser_is_missing(conn):
    db.set_state(conn, "senate_status", "ok: 100 filings seen")
    conn.commit()
    [found] = audit.check_senate(conn)
    assert (found.severity, found.code) == (audit.INFO, "senate_available")
    assert "need a parser" not in found.detail
    assert "parsed" in found.detail


def test_nothing_says_house_only_any_more(conn):
    for status in (None, "ok: 3 filings seen", "blocked: 403", "error: ReadTimeout"):
        conn.execute("DELETE FROM sync_state")
        if status is not None:
            db.set_state(conn, "senate_status", status)
        conn.commit()
        for found in audit.check_senate(conn):
            assert "House-only" not in found.title + found.detail


# --- check_senate_parse_coverage -------------------------------------------


def test_silent_with_no_senate_filings(conn):
    assert audit.check_senate_parse_coverage(conn) == []


def test_silent_while_senate_filings_are_only_indexed(conn):
    _filing(conn, "a", "seen_skipped")
    _filing(conn, "b", "new")
    assert audit.check_senate_parse_coverage(conn) == []


def test_parsed_and_paper_filings_are_counted_not_flagged(conn):
    _filing(conn, "a", "backfilled", parse_method="efd_html")
    _filing(conn, "b", "notified", parse_method="efd_html")
    _filing(conn, "c", "failed", parse_method="efd_paper", paper=True,
            error="paper filing (scanned images on eFD; not transcribed)")
    _filing(conn, "d", "seen_skipped")
    [found] = audit.check_senate_parse_coverage(conn)
    assert (found.severity, found.code) == (audit.INFO, "senate_parse_coverage")
    assert found.title == "2 of 3 Senate filing(s) parsed; 1 paper, 0 parse error(s)"
    assert "indexed, not yet backfilled: 1" in found.evidence


def test_a_parse_error_warns_with_the_page_to_open(conn):
    _filing(conn, "a", "backfilled", parse_method="efd_html")
    _filing(conn, "b", "failed", parse_method="error",
            error="parse error: no transactions table on the page (title: 'Annual Report')")
    findings = _by_code(audit.check_senate_parse_coverage(conn))
    assert findings["senate_parse_coverage"].title == \
        "1 of 2 Senate filing(s) parsed; 0 paper, 1 parse error(s)"
    warn = findings["senate_parse_errors"]
    assert warn.severity == audit.WARN
    assert warn.title == "1 Senate filing(s) failed to parse"
    [line] = warn.evidence
    assert "b" in line and "no transactions table" in line and PTR_URL.format("b") in line


def test_a_failed_filing_without_a_method_counts_as_an_error(conn):
    # NULL parse_method on a failed row is not paper; an unknown must not pass.
    _filing(conn, "b", "failed", error="something")
    findings = _by_code(audit.check_senate_parse_coverage(conn))
    assert "senate_parse_errors" in findings


def test_house_filings_do_not_count(conn):
    db.insert_filing(conn, chamber="house", doc_id="h", politician_id=None,
                     filer_name="Some Rep", state_district="CA01", filing_type="P",
                     filing_date="2026-10-07", year=2026, pdf_url="http://clerk/h.pdf",
                     status="failed", parse_method="scanned")
    conn.commit()
    assert audit.check_senate_parse_coverage(conn) == []


# --- wiring -----------------------------------------------------------------


def test_the_coverage_check_runs_right_after_check_senate():
    checks = list(audit.CHECKS)
    assert checks.index(audit.check_senate_parse_coverage) == checks.index(audit.check_senate) + 1


def test_run_checks_includes_senate_coverage_without_failing(conn):
    db.set_state(conn, "senate_status", "ok: 100 filings seen")
    _filing(conn, "b", "failed", parse_method="error", error="parse error: x")
    found = _by_code(audit.run_checks(conn))
    assert "senate_parse_errors" in found
    assert "check_failed" not in found


def test_report_counts_both_chambers(tmp_path):
    path = tmp_path / "r.sqlite3"
    conn = db.connect(path)
    _filing(conn, "s", "backfilled", parse_method="efd_html")
    db.insert_filing(conn, chamber="house", doc_id="h", politician_id=None,
                     filer_name="Some Rep", state_district="CA01", filing_type="P",
                     filing_date="2026-10-07", year=2026, pdf_url="http://clerk/h.pdf",
                     status="backfilled", parse_method="text")
    conn.commit()
    conn.close()
    text, _ = audit.report(path)
    assert "congressional filings indexed: **2** (House 1, Senate 1)" in text
    assert "House filings indexed" not in text
