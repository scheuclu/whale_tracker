"""The per-page join through the database (#51): the join's account is
stored on the captured rows and pages, transactions are linked to the grid
rows they came from, a partial read is on the filing's record, refused
scans are re-queued once per join version, and the audit lists the week's
pages set aside and rows disputed.

Runs against the committed scanned fixture; the model is a stub.
"""

from datetime import date
from pathlib import Path

import pytest

from whale import audit, db, pipeline, scan_capture, vision
from whale.config import Config
from whale.scan_capture import STATUS_PAGE_REFUSED, STATUS_READ, STATUS_TYPE_DISPUTED, capture_filing

FIXTURES = Path(__file__).parent / "fixtures"
WIED = FIXTURES / "ptr_scanned_9116308.pdf"
NAMES = ["SCHWAB SHORT TERM U S TREASURY ETF", "ADOBE INC", "UPSTART HLDGS INC",
         "SALESFORCE INC", "HUBSPOT INC", "THE TRADE DESK INC CLASS A", "SERVICENOW INC"]
PAGES = [1, 1, 1, 1, 2, 2, 2]
# The grid's reading of the fixture (test_paper_form): the model's own
# reading below agrees on all but ADOBE, which it calls a purchase.
ACTIONS = ["purchase", "purchase", "purchase", "sale", "sale", "sale", "sale"]


@pytest.fixture
def conn(tmp_path):
    c = db.connect(tmp_path / "t.sqlite3")
    yield c
    c.close()


def _scan_filing(conn, doc_id, method=None, status="new", notified=False):
    pid = db.upsert_politician(conn, bioguide_id=f"W{doc_id[-6:]:0>6}", full_name=f"Member {doc_id}",
                               first="Member", last=doc_id, chamber="house", party="R",
                               state="WI", district="8", active=1)
    fid = db.insert_filing(
        conn, chamber="house", doc_id=doc_id, politician_id=pid, filer_name=f"Member {doc_id}",
        state_district="WI08", filing_type="P", filing_date="2026-08-18", year=2026,
        pdf_url=f"http://x/{doc_id}.pdf", status=status, parse_method=method)
    if notified:
        db.mark_notified(conn, fid)
    conn.commit()
    return fid


def _model(rows):
    return {"filer_name": "Tony Wied", "state_district": "WI08", "transactions": [
        {"page": p, "asset_name": n, "action": a, "amount_column": "B", "owner": "JT",
         "tx_date": "2026-07-22", "notification_date": "2026-08-18"} for p, n, a in rows]}


def _full():
    return _model(list(zip(PAGES, NAMES, ACTIONS)))


def _short_page_2():
    return _model(list(zip(PAGES, NAMES, ACTIONS))[:-1])


def _rows(conn, fid):
    return conn.execute(
        "SELECT page_no, row_index, status, transaction_id FROM scan_rows WHERE filing_id = ? "
        "ORDER BY row_index", (fid,)).fetchall()


# --- capture with the join's account --------------------------------------------


def test_capture_stores_the_joins_verdicts_and_links_rows_by_index(conn):
    pdf = WIED.read_bytes()
    scanned = vision.parse_scanned(pdf, "key", transcribe=lambda *a: _short_page_2())
    assert [t.asset_name for t in scanned.transactions] == NAMES[:4]
    fid = _scan_filing(conn, "9116308", method="vision", status="backfilled")
    pid = conn.execute("SELECT politician_id FROM filings WHERE id = ?", (fid,)).fetchone()[0]
    db.replace_transactions(conn, fid, pid, [pipeline._transaction_row(t) for t in scanned.transactions])
    conn.commit()

    pages, rows, unknown = capture_filing(conn, fid, pdf, scanned)
    assert (pages, rows) == (2, 7)
    stored = _rows(conn, fid)
    assert [r["status"] for r in stored] == [
        STATUS_READ, STATUS_TYPE_DISPUTED, STATUS_READ, STATUS_READ,
        STATUS_PAGE_REFUSED, STATUS_PAGE_REFUSED, STATUS_PAGE_REFUSED]
    assert unknown == 4
    # Page 1's four rows point at the four transactions; page 2's at none.
    linked = conn.execute(
        """SELECT r.row_index, t.asset_name FROM scan_rows r JOIN transactions t ON t.id = r.transaction_id
           WHERE r.filing_id = ? ORDER BY r.row_index""", (fid,)).fetchall()
    assert [(r["row_index"], r["asset_name"]) for r in linked] == list(enumerate(NAMES[:4]))
    assert all(r["transaction_id"] is None for r in stored[4:])
    page2 = conn.execute("SELECT error FROM scan_pages WHERE filing_id = ? AND page_no = 2", (fid,)).fetchone()
    assert page2["error"] == "the grid found 3 transaction row(s) on this page but the model placed 2 here"
    page1 = conn.execute("SELECT error FROM scan_pages WHERE filing_id = ? AND page_no = 1", (fid,)).fetchone()
    assert page1["error"] is None


def test_capture_reuses_the_joins_grid_rather_than_reading_the_pdf_twice(conn, monkeypatch):
    pdf = WIED.read_bytes()
    scanned = vision.parse_scanned(pdf, "key", transcribe=lambda *a: _full())
    fid = _scan_filing(conn, "9116308", method="vision", status="backfilled")

    def no_second_read(*a, **k):
        raise AssertionError("the grid was read again")

    monkeypatch.setattr(scan_capture.paper_form, "try_read_page", no_second_read)
    monkeypatch.setattr(scan_capture.paper_form, "read_page", no_second_read)
    pages, rows, unknown = capture_filing(conn, fid, pdf, scanned)
    assert (pages, rows) == (2, 7)


def test_apply_join_does_nothing_when_the_rows_are_not_the_ones_joined(caplog):
    pdf = WIED.read_bytes()
    scanned = vision.parse_scanned(pdf, "key", transcribe=lambda *a: _full())
    pages, rows = scan_capture.capture_pdf(pdf, grid=scanned.grid)
    scanned.pages[0].grid_rows += 1       # a join that saw a different grid
    assert scan_capture.apply_join(pages, rows, scanned) is None
    assert all(r["status"] == STATUS_READ for r in rows)
    assert "rows left unlinked" in caplog.text


def test_link_by_row_index_refuses_a_count_or_index_it_cannot_honour(conn):
    fid = _scan_filing(conn, "9116308", method="vision", status="backfilled")
    pid = conn.execute("SELECT politician_id FROM filings WHERE id = ?", (fid,)).fetchone()[0]
    db.replace_transactions(conn, fid, pid, [{"asset_name": n, "action": "purchase"} for n in NAMES[:2]])
    pages, rows = scan_capture.capture_pdf(WIED.read_bytes())
    db.replace_scan_rows(conn, fid, rows)
    assert db.link_scan_rows(conn, fid, [0, 1, 2]) == 0        # three indexes, two transactions
    assert db.link_scan_rows(conn, fid, [0, 99]) == 0          # no such row
    assert db.link_scan_rows(conn, fid, [5, 1]) == 2           # any order
    linked = conn.execute(
        "SELECT row_index FROM scan_rows WHERE filing_id = ? AND transaction_id IS NOT NULL "
        "ORDER BY row_index", (fid,)).fetchall()
    assert [r["row_index"] for r in linked] == [1, 5]


# --- the pipeline ----------------------------------------------------------------


def test_pipeline_parses_a_partially_read_scan_and_says_so(conn, monkeypatch):
    fid = _scan_filing(conn, "9116308")
    monkeypatch.setattr(pipeline.house, "fetch_pdf", lambda url: WIED.read_bytes())
    monkeypatch.setattr(vision, "_transcribe", lambda pdf, key: _short_page_2())
    assert pipeline.parse_pending(conn, Config(vision_enabled=True, gemini_api_key="k")) == 1
    row = conn.execute("SELECT status, parse_method, last_error FROM filings WHERE id = ?", (fid,)).fetchone()
    assert (row["status"], row["parse_method"]) == ("parsed", "vision")
    assert row["last_error"].startswith("partially read: 1 page(s) yielded no rows (2 transcribed row(s) dropped)")
    assert "page 2: the grid found 3" in row["last_error"]
    assert conn.execute("SELECT COUNT(*) FROM transactions WHERE filing_id = ?", (fid,)).fetchone()[0] == 4
    stored = _rows(conn, fid)
    assert [r["status"] for r in stored[4:]] == [STATUS_PAGE_REFUSED] * 3
    assert stored[1]["status"] == STATUS_TYPE_DISPUTED
    assert sum(r["transaction_id"] is not None for r in stored) == 4


def test_pipeline_leaves_no_note_on_a_fully_read_scan(conn, monkeypatch):
    fid = _scan_filing(conn, "9116308")
    monkeypatch.setattr(pipeline.house, "fetch_pdf", lambda url: WIED.read_bytes())
    monkeypatch.setattr(vision, "_transcribe", lambda pdf, key: _full())
    assert pipeline.parse_pending(conn, Config(vision_enabled=True, gemini_api_key="k")) == 1
    row = conn.execute("SELECT status, last_error FROM filings WHERE id = ?", (fid,)).fetchone()
    assert (row["status"], row["last_error"]) == ("parsed", None)
    assert conn.execute(
        "SELECT COUNT(*) FROM scan_rows WHERE filing_id = ? AND transaction_id IS NOT NULL", (fid,)
    ).fetchone()[0] == 7


# --- the one-off retry ------------------------------------------------------------


def test_refused_scans_are_requeued_once_per_join_version(conn, monkeypatch):
    fid = _scan_filing(conn, "9000001", method="vision_failed", status="failed", notified=True)
    config = Config(vision_enabled=True, gemini_api_key="k")
    # Without vision nothing moves and no stamp is written.
    assert pipeline.retry_scanned(conn, Config(vision_enabled=False)) == 0
    assert db.get_state(conn, pipeline.REFUSED_RETRY_STATE) is None
    # First run under this version: re-queued, stamped.
    assert pipeline.retry_scanned(conn, config) == 1
    assert conn.execute("SELECT status FROM filings WHERE id = ?", (fid,)).fetchone()[0] == "new"
    assert db.get_state(conn, pipeline.REFUSED_RETRY_STATE) == str(vision.JOIN_VERSION)
    # Refused again: left alone on every later run.
    db.set_status(conn, fid, "failed", "scan not readable (x)", "vision_failed")
    conn.commit()
    assert pipeline.retry_scanned(conn, config) == 0
    assert pipeline.retry_scanned(conn, config) == 0
    assert conn.execute("SELECT status FROM filings WHERE id = ?", (fid,)).fetchone()[0] == "failed"
    # A new join version earns one more try.
    monkeypatch.setattr(pipeline, "JOIN_VERSION", vision.JOIN_VERSION + 1)
    assert pipeline.retry_scanned(conn, config) == 1
    assert pipeline.retry_scanned(conn, config) == 0


def test_a_retried_refusal_announced_before_lands_as_history(conn, monkeypatch):
    fid = _scan_filing(conn, "9116308", method="vision_failed", status="failed", notified=True)
    monkeypatch.setattr(pipeline.house, "fetch_pdf", lambda url: WIED.read_bytes())
    monkeypatch.setattr(vision, "_transcribe", lambda pdf, key: _short_page_2())
    config = Config(vision_enabled=True, gemini_api_key="k")
    assert pipeline.retry_scanned(conn, config) == 1
    assert pipeline.parse_pending(conn, config) == 1
    row = conn.execute("SELECT status, parse_method, notified_at FROM filings WHERE id = ?", (fid,)).fetchone()
    assert (row["status"], row["parse_method"]) == ("backfilled", "vision")
    assert row["notified_at"] is not None


# --- the audit ---------------------------------------------------------------------


def _transcribe_into(conn, monkeypatch, doc_id, transcription):
    fid = _scan_filing(conn, doc_id)
    monkeypatch.setattr(pipeline.house, "fetch_pdf", lambda url: WIED.read_bytes())
    monkeypatch.setattr(vision, "_transcribe", lambda pdf, key: transcription)
    assert pipeline.parse_pending(conn, Config(vision_enabled=True, gemini_api_key="k")) == 1
    return fid


def test_audit_lists_the_weeks_pages_set_aside_and_rows_disputed(conn, monkeypatch):
    _transcribe_into(conn, monkeypatch, "9116308", _short_page_2())
    found = audit.check_vision_join(conn, today=date.today())
    assert len(found) == 1 and found[0].code == "vision_join"
    assert found[0].severity == audit.INFO
    assert "1 page(s) yielded no rows" in found[0].title
    assert "1 of 4 row(s) type-disputed" in found[0].title
    assert len(found[0].evidence) == 1
    assert found[0].evidence[0].startswith(
        "9116308  Member 9116308  4 rows, 1 disputed, 1 page(s) unread (3 grid rows unjoined)"
        "  partially read: 1 page(s) yielded no rows (2 transcribed row(s) dropped) — page 2: the")
    # The check runs in the suite and follows check_vision_rows.
    names = [c.__name__ for c in audit.CHECKS]
    assert names.index("check_vision_join") == names.index("check_vision_rows") + 1


def test_audit_is_quiet_on_a_fully_read_week_and_outside_the_window(conn, monkeypatch):
    _transcribe_into(conn, monkeypatch, "9116308", _full())
    # One dispute (ADOBE) out of seven: listed, as INFO.
    found = audit.check_vision_join(conn, today=date.today())
    assert len(found) == 1 and found[0].severity == audit.INFO
    assert "0 page(s) yielded no rows, 1 of 7 row(s) type-disputed" in found[0].title
    # A week later it is no longer this week's news.
    assert audit.check_vision_join(conn, today=date(2030, 1, 1)) == []
    # With no disputes at all there is nothing to say.
    conn.execute("UPDATE scan_rows SET status = 'read'")
    conn.commit()
    assert audit.check_vision_join(conn, today=date.today()) == []


def test_audit_warns_when_more_than_a_quarter_of_the_weeks_rows_are_disputed(conn, monkeypatch):
    _transcribe_into(conn, monkeypatch, "9116308", _full())
    conn.execute("UPDATE scan_rows SET status = 'type_disputed' WHERE row_index < 2")
    conn.commit()
    found = audit.check_vision_join(conn, today=date.today())
    assert found[0].severity == audit.WARN
