"""Capture scanned paper filings for inspection: page images plus the grid
reader's rows, stored in the database (`scan_pages`, `scan_rows`).

The reader decides amounts and types from ink geometry, and nothing about
that is visible from a transaction row. This stores what it saw — each page
as a 1-bit PNG, oriented the way the reader turned it, and each row it
found with the column edges and the cells it read as ticked — so the
dashboard's /scans view can draw the decision on the page. It needs no API
key: the reader runs on its own, and rows are linked to transactions only
if the hybrid path has produced them (by order; `db.link_scan_rows`).

`capture_scans` is the catch-up over every scan in the database, budgeted
and resumable like the insider backfill: it skips filings already captured,
downloads at the Clerk's pace, and stops when its time is up, saying so.
The pipeline captures each scan it meets, so new ones are inspectable on
arrival.
"""

from __future__ import annotations

import io
import json
import logging
import sqlite3
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import pdfplumber

from . import db, house, paper_form

log = logging.getLogger(__name__)

# 1-bit at 110 dpi keeps the 2026 corpus (53 filings, 405 pages) under 6 MB in
# a database committed on every run; the budget in CLAUDE.md is 15.
CAPTURE_DPI = 110

# Seconds between downloads: the Clerk's pace, as in `sync`.
DOWNLOAD_PAUSE = 1.1

STATUS_READ = "read"
STATUS_UNKNOWN_AMOUNT = "unknown_amount"
STATUS_UNKNOWN_TYPE = "unknown_type"
STATUS_UNKNOWN = "unknown"


@dataclass
class CaptureResult:
    captured: int = 0
    pages: int = 0
    rows: int = 0
    unknown_rows: int = 0
    png_bytes: int = 0
    skipped: int = 0            # download or capture failures, left for the next run
    aborted: str | None = None  # "budget" | "limit"

    def summary(self) -> str:
        text = (f"{self.captured} filing(s) captured: {self.pages} page(s), {self.rows} row(s) "
                f"({self.unknown_rows} with an unknown amount or type), "
                f"{self.png_bytes / 1e6:.2f} MB of images")
        if self.skipped:
            text += f"; {self.skipped} failure(s) left for next time"
        if self.aborted:
            text += f"; stopped early ({self.aborted})"
        return text


def row_status(amount: str | None, action: str | None) -> str:
    if amount and action:
        return STATUS_READ
    if action:
        return STATUS_UNKNOWN_AMOUNT
    if amount:
        return STATUS_UNKNOWN_TYPE
    return STATUS_UNKNOWN


def capture_pdf(pdf_bytes: bytes) -> tuple[list[dict], list[dict]]:
    """Render and read every page. Returns (pages, rows) ready for `db`.

    A page the reader cannot decompose is still stored, with the reason, so
    the view can show what it could not read; its rows are simply absent.
    Geometry is scaled from the reader's resolution to the capture's so the
    overlay is in image pixels.
    """
    scale = CAPTURE_DPI / paper_form.RENDER_DPI
    pages: list[dict] = []
    rows: list[dict] = []
    row_index = 0
    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        for index, page in enumerate(pdf.pages):
            image = page.to_image(resolution=paper_form.RENDER_DPI).original
            error = None
            try:
                grid = paper_form.read_page(image, index)
            except paper_form.GridNotFound as exc:
                grid, error = None, str(exc)
            rotation = grid.rotation if grid else 0
            if grid is not None and grid.no_table:
                error = "no table on this page"

            small = page.to_image(resolution=CAPTURE_DPI).original.convert("L")
            if rotation:
                small = small.rotate(rotation, expand=True)
            pages.append({
                "page_no": index + 1, "width": small.width, "height": small.height,
                "dpi": CAPTURE_DPI, "rotation": rotation, "png": _png_1bit(small),
                "error": error,
            })
            if grid is None:
                continue
            for r in grid.rows:
                if not r.populated:
                    continue
                rows.append({
                    "page_no": index + 1, "row_index": row_index,
                    "y0": int(round(r.top * scale)), "y1": int(round(r.bottom * scale)),
                    "amount_cols": json.dumps([int(round(x * scale)) for x in grid.amount_cols]),
                    "type_cols": json.dumps([int(round(x * scale)) for x in grid.type_cols]),
                    "amount_marks": json.dumps(r.amount_marks),
                    "type_marks": json.dumps(r.type_marks),
                    "amount_letter": r.amount, "amount_margin": r.amount_margin,
                    "action": r.action, "type_margin": r.type_margin,
                    "status": row_status(r.amount, r.action),
                })
                row_index += 1
    return pages, rows


def _png_1bit(image) -> bytes:
    buf = io.BytesIO()
    image.point(lambda v: 255 if v >= paper_form.INK_THRESHOLD else 0).convert("1").save(
        buf, format="PNG", optimize=True)
    return buf.getvalue()


def capture_filing(conn: sqlite3.Connection, filing_id: int,
                   pdf_bytes: bytes) -> tuple[int, int, int]:
    """Store one filing's pages and rows, replacing an earlier capture, and
    link the rows to its transactions if it has them. Returns (pages, rows,
    unknown rows). Commits."""
    pages, rows = capture_pdf(pdf_bytes)
    db.replace_scan_pages(conn, filing_id, pages)
    db.replace_scan_rows(conn, filing_id, rows)
    db.link_scan_rows(conn, filing_id)
    conn.commit()
    unknown = sum(1 for r in rows if r["status"] != STATUS_READ)
    return len(pages), len(rows), unknown


def capture_scans(conn: sqlite3.Connection, limit: int | None = None,
                  budget_seconds: float = 600, pdf_dir: Path | None = None,
                  fetch: Callable[[str], bytes] = house.fetch_pdf,
                  clock: Callable[[], float] = time.monotonic,
                  pause: Callable[[float], None] = time.sleep) -> CaptureResult:
    """Capture every House scan that has no pages stored yet.

    `pdf_dir`, if given, is read before the network and written after it, so
    a re-run (or an evaluation over the same filings) does not download
    twice. Resumable by construction: a captured filing is skipped, so a run
    that stops on its budget continues where it left off next time.
    """
    result = CaptureResult()
    started = clock()
    for filing in db.uncaptured_scans(conn):
        if limit is not None and result.captured >= limit:
            result.aborted = "limit"
            break
        if clock() - started > budget_seconds:
            result.aborted = "budget"
            break
        cached = pdf_dir / f"{filing['doc_id']}.pdf" if pdf_dir else None
        if cached is not None and cached.exists():
            pdf_bytes = cached.read_bytes()
        else:
            try:
                pdf_bytes = fetch(filing["pdf_url"])
            except Exception as exc:
                log.warning("PDF download failed for %s: %s", filing["doc_id"], exc)
                result.skipped += 1
                continue
            finally:
                pause(DOWNLOAD_PAUSE)
            if cached is not None:
                cached.parent.mkdir(parents=True, exist_ok=True)
                cached.write_bytes(pdf_bytes)
        try:
            pages, rows, unknown = capture_filing(conn, filing["id"], pdf_bytes)
        except Exception:
            # One malformed PDF must not end the catch-up; it is logged and
            # tried again next run, like a download failure.
            log.exception("capture failed for %s", filing["doc_id"])
            conn.rollback()
            result.skipped += 1
            continue
        result.captured += 1
        result.pages += pages
        result.rows += rows
        result.unknown_rows += unknown
        result.png_bytes += conn.execute(
            "SELECT COALESCE(SUM(LENGTH(png)), 0) FROM scan_pages WHERE filing_id = ?",
            (filing["id"],)).fetchone()[0]
        log.info("captured %s: %d page(s), %d row(s), %d unknown",
                 filing["doc_id"], pages, rows, unknown)
    if result.aborted:
        left = len(db.uncaptured_scans(conn))
        log.info("capture stopped early (%s); %d filing(s) left — run capture-scans again",
                 result.aborted, left)
    return result
