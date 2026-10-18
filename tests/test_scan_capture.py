"""Scan capture: pages and grid rows stored for inspection, idempotently,
linked to transactions when they exist, budgeted and resumable.

Runs against the committed scanned fixtures; no network, no API key.
"""

import io
import json
import sqlite3
from pathlib import Path

import pytest
from PIL import Image

from whale import db, pipeline, scan_capture
from whale.config import Config
from whale.scan_capture import (STATUS_READ, STATUS_UNKNOWN, STATUS_UNKNOWN_AMOUNT,
                                STATUS_UNKNOWN_TYPE, capture_filing, capture_scans, row_status)

FIXTURES = Path(__file__).parent / "fixtures"
WIED = FIXTURES / "ptr_scanned_9116308.pdf"
FLEISCHMANN = FIXTURES / "ptr_scanned_8221321.pdf"


@pytest.fixture
def conn(tmp_path):
    c = db.connect(tmp_path / "t.sqlite3")
    yield c
    c.close()


def _scan_filing(conn, doc_id, method="scanned", status="failed"):
    pid = db.upsert_politician(conn, bioguide_id=f"W{doc_id[-6:]:0>6}", full_name=f"Member {doc_id}",
                               first="Member", last=doc_id, chamber="house", party="R",
                               state="WI", district="8", active=1)
    fid = db.insert_filing(
        conn, chamber="house", doc_id=doc_id, politician_id=pid, filer_name=f"Member {doc_id}",
        state_district="WI08", filing_type="P", filing_date="2026-08-18", year=2026,
        pdf_url=f"http://x/{doc_id}.pdf", status=status, parse_method=method)
    conn.commit()
    return fid


# --- schema ------------------------------------------------------------------


def test_schema_version_8_has_the_scan_tables(conn):
    assert conn.execute("PRAGMA user_version").fetchone()[0] == db.SCHEMA_VERSION
    tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    assert {"scan_pages", "scan_rows"} <= tables


def test_a_version_7_database_gains_the_tables_on_connect(tmp_path):
    path = tmp_path / "old.sqlite3"
    c = db.connect(path)
    c.executescript("DROP TABLE scan_rows; DROP TABLE scan_pages; PRAGMA user_version = 7;")
    c.commit()
    c.close()
    c = db.connect(path)
    try:
        assert c.execute("PRAGMA user_version").fetchone()[0] == db.SCHEMA_VERSION
        assert c.execute("SELECT COUNT(*) FROM scan_pages").fetchone()[0] == 0
        assert c.execute("SELECT COUNT(*) FROM scan_rows").fetchone()[0] == 0
    finally:
        c.close()


# --- one filing ----------------------------------------------------------------


def test_capture_stores_every_page_oriented_and_every_row_read(conn):
    fid = _scan_filing(conn, "9116308")
    pages, rows, unknown = capture_filing(conn, fid, WIED.read_bytes())
    assert (pages, rows, unknown) == (2, 7, 0)

    stored = conn.execute(
        "SELECT page_no, width, height, dpi, rotation, error, LENGTH(png) n FROM scan_pages "
        "WHERE filing_id = ? ORDER BY page_no", (fid,)).fetchall()
    assert [p["page_no"] for p in stored] == [1, 2]
    assert [p["rotation"] for p in stored] == [0, 90]
    assert all(p["dpi"] == scan_capture.CAPTURE_DPI and p["error"] is None for p in stored)
    # Page 2 was scanned sideways; turned, it is landscape like page 1.
    assert all(p["width"] > p["height"] for p in stored)
    for p in stored:
        png = db.scan_page_png(conn, fid, p["page_no"])
        image = Image.open(io.BytesIO(png))
        assert image.format == "PNG" and image.mode == "1"
        assert (image.width, image.height) == (p["width"], p["height"])
        assert p["n"] < 150_000, "a page image must stay small; the DB is committed every run"

    rows = conn.execute("SELECT * FROM scan_rows WHERE filing_id = ? ORDER BY row_index", (fid,)).fetchall()
    assert [(r["amount_letter"], r["action"]) for r in rows] == [
        ("C", "purchase"), ("A", "sale_partial"), ("B", "purchase"), ("B", "sale_partial"),
        ("B", "sale_partial"), ("B", "sale_partial"), ("B", "sale_partial")]
    assert [r["page_no"] for r in rows] == [1, 1, 1, 1, 2, 2, 2]
    assert [r["row_index"] for r in rows] == list(range(7))
    assert all(r["status"] == STATUS_READ and r["transaction_id"] is None for r in rows)
    first = rows[0]
    cols = json.loads(first["amount_cols"])
    page1 = stored[0]
    # Geometry is in the image's pixels: inside the page, 12 edges for 11
    # columns, the ticked cell (C) the third, and the band a real row's height.
    assert len(cols) == 12 and 0 < cols[0] < cols[-1] <= page1["width"]
    assert len(json.loads(first["type_cols"])) == 5
    assert json.loads(first["amount_marks"]) == [2] and json.loads(first["type_marks"]) == [0]
    assert 0 < first["y0"] < first["y1"] <= page1["height"]
    assert 25 < first["y1"] - first["y0"] < 60
    assert first["amount_margin"] >= 0.15 and first["type_margin"] >= 0.15


def test_recapture_replaces_rather_than_duplicates(conn):
    fid = _scan_filing(conn, "8221321")
    capture_filing(conn, fid, FLEISCHMANN.read_bytes())
    capture_filing(conn, fid, FLEISCHMANN.read_bytes())
    assert conn.execute("SELECT COUNT(*) FROM scan_pages WHERE filing_id = ?", (fid,)).fetchone()[0] == 2
    assert conn.execute("SELECT COUNT(*) FROM scan_rows WHERE filing_id = ?", (fid,)).fetchone()[0] == 9
    assert conn.execute("SELECT COUNT(DISTINCT row_index) FROM scan_rows WHERE filing_id = ?",
                        (fid,)).fetchone()[0] == 9


def test_rows_link_to_transactions_by_order_when_the_filing_has_them(conn):
    fid = _scan_filing(conn, "9116308", method="vision", status="backfilled")
    pid = conn.execute("SELECT politician_id FROM filings WHERE id = ?", (fid,)).fetchone()[0]
    names = ["SCHWAB", "ADOBE", "UPSTART", "SALESFORCE", "HUBSPOT", "TRADE DESK", "SERVICENOW"]
    db.replace_transactions(conn, fid, pid, [
        {"asset_name": n, "action": "purchase", "tx_date": "2026-07-14"} for n in names])
    conn.commit()
    capture_filing(conn, fid, WIED.read_bytes())
    linked = conn.execute(
        """SELECT r.row_index, t.asset_name FROM scan_rows r JOIN transactions t ON t.id = r.transaction_id
           WHERE r.filing_id = ? ORDER BY r.row_index""", (fid,)).fetchall()
    assert [(r["row_index"], r["asset_name"]) for r in linked] == list(enumerate(names))

    # A re-parse replaces the transactions: the old links are cleared by the
    # foreign key and re-made by `link_scan_rows`; a count mismatch links none.
    db.replace_transactions(conn, fid, pid, [{"asset_name": "ONLY ONE", "action": "sale"}])
    conn.commit()
    assert conn.execute("SELECT COUNT(*) FROM scan_rows WHERE transaction_id IS NOT NULL").fetchone()[0] == 0
    assert db.link_scan_rows(conn, fid) == 0
    db.replace_transactions(conn, fid, pid, [
        {"asset_name": n, "action": "purchase", "tx_date": "2026-07-14"} for n in names])
    assert db.link_scan_rows(conn, fid) == 7


def test_row_status_vocabulary():
    assert row_status("C", "purchase") == STATUS_READ
    assert row_status(None, "purchase") == STATUS_UNKNOWN_AMOUNT
    assert row_status("C", None) == STATUS_UNKNOWN_TYPE
    assert row_status(None, None) == STATUS_UNKNOWN


def _pdf_of(image) -> bytes:
    buf = io.BytesIO()
    image.save(buf, format="PDF", resolution=200)
    return buf.getvalue()


def test_a_page_the_reader_cannot_decompose_is_stored_with_the_reason(conn):
    from PIL import ImageDraw

    # A ruled table that is not the form: stored, flagged, no rows.
    table = Image.new("L", (2200, 1700), 255)
    draw = ImageDraw.Draw(table)
    for y in range(200, 1500, 60):
        draw.line([(100, y), (2100, y)], fill=0, width=3)
    for x in range(100, 2101, 125):
        draw.line([(x, 200), (x, 1440)], fill=0, width=3)
    fid = _scan_filing(conn, "9000001")
    pages, rows, unknown = capture_filing(conn, fid, _pdf_of(table))
    assert (pages, rows, unknown) == (1, 0, 0)
    page = conn.execute("SELECT error, width, height FROM scan_pages WHERE filing_id = ?", (fid,)).fetchone()
    assert page["error"] and "page 1" in page["error"]
    assert page["width"] > 0 and page["height"] > 0

    # A blank side: stored too, as "no table", so the page count is honest.
    fid2 = _scan_filing(conn, "9000002")
    capture_filing(conn, fid2, _pdf_of(Image.new("L", (2200, 1700), 255)))
    assert conn.execute("SELECT error FROM scan_pages WHERE filing_id = ?", (fid2,)).fetchone()[0] \
        == "no table on this page"


# --- the catch-up --------------------------------------------------------------


def test_capture_scans_covers_every_scan_once_and_resumes_on_budget(conn, tmp_path):
    pdf_dir = tmp_path / "pdfs"
    pdf_dir.mkdir()
    (pdf_dir / "9116308.pdf").write_bytes(WIED.read_bytes())
    (pdf_dir / "8221321.pdf").write_bytes(FLEISCHMANN.read_bytes())
    _scan_filing(conn, "8221321", method="scanned")
    _scan_filing(conn, "9116308", method="vision_failed")
    _scan_filing(conn, "9999999", method="text", status="backfilled")   # not a scan
    fetched: list[str] = []
    paused: list[float] = []

    def fetch(url):
        fetched.append(url)
        raise AssertionError("cached PDFs must be used before the network")

    ticks = iter([0, 0, 1000, 1000, 1000])   # the second filing sees the budget spent
    first = capture_scans(conn, budget_seconds=10, pdf_dir=pdf_dir, fetch=fetch,
                          clock=lambda: next(ticks), pause=paused.append)
    assert (first.captured, first.aborted) == (1, "budget")
    assert first.pages == 2 and first.rows == 9 and first.png_bytes > 0
    assert fetched == [] and paused == []

    second = capture_scans(conn, budget_seconds=10, pdf_dir=pdf_dir, fetch=fetch,
                           clock=lambda: 0.0, pause=paused.append)
    assert (second.captured, second.aborted) == (1, None)
    assert "stopped early" not in second.summary()
    third = capture_scans(conn, pdf_dir=pdf_dir, fetch=fetch, clock=lambda: 0.0, pause=paused.append)
    assert third.captured == 0
    assert conn.execute("SELECT COUNT(DISTINCT filing_id) FROM scan_pages").fetchone()[0] == 2
    assert db.uncaptured_scans(conn) == []


def test_capture_scans_downloads_politely_and_keeps_going_past_a_failure(conn, tmp_path):
    _scan_filing(conn, "8221321")
    _scan_filing(conn, "9116308")
    calls: list[str] = []
    paused: list[float] = []

    def fetch(url):
        calls.append(url)
        if "8221321" in url:
            raise OSError("503")
        return WIED.read_bytes()

    pdf_dir = tmp_path / "pdfs"
    result = capture_scans(conn, pdf_dir=pdf_dir, fetch=fetch, clock=lambda: 0.0, pause=paused.append)
    assert (result.captured, result.skipped) == (1, 1)
    assert len(calls) == 2
    assert paused == [scan_capture.DOWNLOAD_PAUSE] * 2     # after every fetch, failed or not
    assert (pdf_dir / "9116308.pdf").exists()               # saved for next time
    assert not (pdf_dir / "8221321.pdf").exists()
    assert [f["doc_id"] for f in db.uncaptured_scans(conn)] == ["8221321"]
    assert "1 failure(s) left" in result.summary()


def test_capture_scans_limit_stops_and_says_so(conn, tmp_path):
    pdf_dir = tmp_path / "pdfs"
    pdf_dir.mkdir()
    (pdf_dir / "8221321.pdf").write_bytes(FLEISCHMANN.read_bytes())
    (pdf_dir / "9116308.pdf").write_bytes(WIED.read_bytes())
    _scan_filing(conn, "8221321")
    _scan_filing(conn, "9116308")
    result = capture_scans(conn, limit=1, pdf_dir=pdf_dir, clock=lambda: 0.0, pause=lambda s: None)
    assert (result.captured, result.aborted) == (1, "limit")


# --- the pipeline ----------------------------------------------------------------


def test_pipeline_captures_a_scan_it_cannot_transcribe_on_arrival(conn, monkeypatch):
    fid = _scan_filing(conn, "9116308", method=None, status="new")
    monkeypatch.setattr(pipeline.house, "fetch_pdf", lambda url: WIED.read_bytes())
    config = Config(vision_enabled=False)
    assert pipeline.parse_pending(conn, config) == 0
    row = conn.execute("SELECT status, parse_method FROM filings WHERE id = ?", (fid,)).fetchone()
    assert (row["status"], row["parse_method"]) == ("failed", "scanned")
    assert conn.execute("SELECT COUNT(*) FROM scan_pages WHERE filing_id = ?", (fid,)).fetchone()[0] == 2
    assert conn.execute("SELECT COUNT(*) FROM scan_rows WHERE filing_id = ?", (fid,)).fetchone()[0] == 7


def test_pipeline_capture_failure_never_costs_the_parse(conn, monkeypatch):
    fid = _scan_filing(conn, "9116308", method=None, status="new")
    monkeypatch.setattr(pipeline.house, "fetch_pdf", lambda url: WIED.read_bytes())

    def boom(conn, filing_id, pdf_bytes):
        raise RuntimeError("renderer exploded")

    monkeypatch.setattr(scan_capture, "capture_filing", boom)
    pipeline.parse_pending(conn, Config(vision_enabled=False))
    row = conn.execute("SELECT status, parse_method FROM filings WHERE id = ?", (fid,)).fetchone()
    assert (row["status"], row["parse_method"]) == ("failed", "scanned")
    assert conn.execute("SELECT COUNT(*) FROM scan_pages").fetchone()[0] == 0


def test_pipeline_links_rows_after_a_transcription(conn, monkeypatch):
    from whale.ptr import ParsedFiling, Transaction

    fid = _scan_filing(conn, "9116308", method=None, status="new")
    monkeypatch.setattr(pipeline.house, "fetch_pdf", lambda url: WIED.read_bytes())
    parsed = ParsedFiling(filer_name="Tony Wied", state_district="WI08", transactions=[
        Transaction(asset_name=f"ASSET {i}", action="purchase", amount_raw="$1,001 - $15,000",
                    tx_date="2026-07-14") for i in range(7)])
    monkeypatch.setattr(pipeline, "_parse_bytes", lambda b, c, *a, **k: (parsed, "vision"))
    assert pipeline.parse_pending(conn, Config(vision_enabled=True, gemini_api_key="k")) == 1
    linked = conn.execute(
        "SELECT COUNT(*) FROM scan_rows WHERE filing_id = ? AND transaction_id IS NOT NULL", (fid,)
    ).fetchone()[0]
    assert linked == 7


def test_cli_capture_scans_runs_against_the_configured_database(tmp_path, monkeypatch, capsys):
    from whale import __main__ as cli

    path = tmp_path / "cli.sqlite3"
    c = db.connect(path)
    _scan_filing(c, "8221321")
    c.close()
    pdf_dir = tmp_path / "pdfs"
    pdf_dir.mkdir()
    (pdf_dir / "8221321.pdf").write_bytes(FLEISCHMANN.read_bytes())
    monkeypatch.setattr(cli, "load_config", lambda: Config(db_path=path))
    assert cli.main(["capture-scans", "--pdf-dir", str(pdf_dir), "--budget-seconds", "60"]) == 0
    out = capsys.readouterr().out
    assert "1 filing(s) captured: 2 page(s), 9 row(s)" in out
    c = sqlite3.connect(path)
    assert c.execute("SELECT COUNT(*) FROM scan_pages").fetchone()[0] == 2
    c.close()
