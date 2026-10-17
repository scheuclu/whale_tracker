"""The grid reader, against real scanned filings and the four layouts seen.

Every expected value below was read off the rendered page by eye. The
fixtures are unmodified House Clerk PDFs chosen for what broke earlier
versions: a second page scanned sideways, a portrait sheet with the form
shrunk onto it, the older form with ten amount columns and three types, a
member's own dense spreadsheet with typed X marks, and (as a page image —
the PDF is a megabyte) a spreadsheet with unequal columns, two extra flag
columns and a black heading bar.
"""

import subprocess
import sys
from pathlib import Path

import pytest

from whale import paper_form
from whale.paper_form import GridNotFound, Layout, read_page, read_pdf

FIXTURES = Path(__file__).parent / "fixtures"
WIED = FIXTURES / "ptr_scanned_9116308.pdf"          # current form, page 2 scanned sideways
HARSHBARGER = FIXTURES / "ptr_scanned_9116256.pdf"   # current form, portrait sheets, shrunk
FLEISCHMANN = FIXTURES / "ptr_scanned_8221321.pdf"   # older form: A–J, three types, hand-drawn X
MCCAUL = FIXTURES / "ptr_scanned_8221326.pdf"        # member's spreadsheet, 25 rows a page, typed X
KHANNA_P2 = FIXTURES / "ptr_scanned_8221322_p2.png"  # spreadsheet with flag columns and a heading bar


def rows_of(reading):
    return [(r.amount, r.action) for r in reading.rows]


def test_numpy_is_not_imported_with_the_package():
    # The scheduled workflow installs the `vision` extra; everything else
    # (tests, the CLI, the dashboard build) must import without numpy.
    code = ("import sys; import whale.paper_form, whale.vision, whale.pipeline; "
            "assert 'numpy' not in sys.modules, 'numpy imported eagerly'")
    subprocess.run([sys.executable, "-c", code], check=True)


def test_current_form_reads_every_row_including_the_sideways_page():
    reading = read_pdf(WIED.read_bytes())
    assert [p.rotation for p in reading.pages] == [0, 90]
    assert reading.pages[0].layout == Layout(4, 0, 11)
    assert rows_of(reading) == [
        ("C", "purchase"), ("A", "sale_partial"), ("B", "purchase"), ("B", "sale_partial"),
        ("B", "sale_partial"), ("B", "sale_partial"), ("B", "sale_partial"),
    ]
    # The example row and the empty rows on page 2 are not transactions.
    assert len(reading.pages[1].rows) > 3


def test_portrait_sheet_with_the_form_shrunk_onto_it():
    reading = read_pdf(HARSHBARGER.read_bytes())
    assert rows_of(reading) == [
        ("B", "purchase"), ("B", "sale"), ("B", "purchase"), ("D", "sale"),
        ("D", "purchase"), ("B", "purchase"),
    ]


def test_older_form_has_ten_amount_columns_and_three_types():
    reading = read_pdf(FLEISCHMANN.read_bytes())
    assert reading.pages[0].layout == Layout(3, 0, 10)
    assert reading.pages[0].layout.letters == "ABCDEFGHIJ"
    assert rows_of(reading) == [
        ("A", "purchase"), ("A", "purchase"), ("A", "sale"), ("A", "purchase"), ("A", "purchase"),
        ("A", "sale"), ("A", "sale"), ("A", "purchase"), ("A", "sale"),
    ]
    # Bare cells (a hand-drawn X, no printed box).
    assert not reading.rows[0].boxed


def test_dense_spreadsheet_with_typed_marks_and_heading_lines():
    reading = read_pdf(MCCAUL.read_bytes())
    assert [p.layout for p in reading.pages] == [Layout(3, 0, 11)] * 3
    got = rows_of(reading)
    # 24 + 23 + 4 transactions; the account-heading lines ("LLM FAMILY
    # INVESTMENTS LP") carry no date and no mark and are not rows.
    assert len(got) == 51
    assert got[:4] == [("D", "purchase"), ("C", "purchase"), ("C", "purchase"), ("B", "purchase")]
    assert got[12:24] == [("A", "purchase")] * 12
    assert got[24:33] == [("A", "purchase")] + [("A", "sale")] * 8
    assert got[33:41] == [("B", "sale"), ("B", "sale"), ("C", "sale"), ("C", "sale"),
                          ("D", "sale"), ("D", "sale"), ("E", "sale"), ("E", "sale")]
    assert got[41:47] == [("D", "purchase"), ("C", "purchase"), ("B", "purchase"),
                          ("B", "sale"), ("B", "sale"), ("D", "sale")]
    assert got[47:] == [("A", "sale"), ("A", "sale"), ("A", "purchase"), ("A", "sale")]


def test_spreadsheet_with_unequal_columns_flag_columns_and_a_heading_bar():
    from PIL import Image

    page = read_page(Image.open(KHANNA_P2), index=1)
    assert page.layout == Layout(3, 2, 11)
    rows = [r for r in page.rows if r.populated]
    assert len(rows) == 19
    assert [(r.amount, r.action) for r in rows] == (
        [("E", "purchase")] + [("A", "purchase")] * 5
        + [("B", "sale"), ("B", "sale"), ("B", "sale_partial")] + [("B", "sale")] * 10
    )
    # "Capital Gains > $200" is its own column on this form; the reader
    # carries it where the form has it, and not otherwise.
    assert [r.cap_gains for r in rows[6:9]] == [True, False, True]
    assert all(r.cap_gains is not None for r in rows)
    wied = read_pdf(WIED.read_bytes())
    assert all(r.cap_gains is None for r in wied.rows)
    # The black heading bar above the first row is a bar, not a row.
    assert not any(r.filled for r in rows)


def test_same_reading_whichever_way_the_page_was_fed():
    import pdfplumber

    with pdfplumber.open(WIED) as pdf:
        image = pdf.pages[0].to_image(resolution=paper_form.RENDER_DPI).original
    expected = [(r.amount, r.action) for r in read_page(image).rows if r.populated]
    for angle in (90, 180, 270):
        page = read_page(image.rotate(angle, expand=True))
        assert page.rotation == (360 - angle) % 360 or page.rotation in (90, 270, 180)
        assert [(r.amount, r.action) for r in page.rows if r.populated] == expected


def test_two_ticks_or_none_is_unknown_never_a_pick():
    import pdfplumber
    from PIL import ImageDraw

    with pdfplumber.open(WIED) as pdf:
        image = pdf.pages[0].to_image(resolution=paper_form.RENDER_DPI).original.convert("L")
    page = read_page(image)
    first = page.rows[0]
    assert (first.amount, first.action) == ("C", "purchase")

    # Locate the row's cells the way the reader does, then tamper with them.
    import numpy as np

    ink = np.asarray(image.convert("L")) < paper_form.INK_THRESHOLD
    H, W = ink.shape
    table = paper_form._decompose(
        paper_form._rules(ink, axis=0, min_run=paper_form.VERTICAL_MIN_RUN * H),
        paper_form._rules(ink, axis=1, min_run=paper_form.HORIZONTAL_MIN_RUN * W), H, W)
    cols = table.amount
    cy = (first.top + first.bottom) // 2

    # A second tick, in column E: the row's amount is now ambiguous.
    doubled = image.copy()
    draw = ImageDraw.Draw(doubled)
    x0, x1 = cols[4], cols[5]
    draw.line([(x0 + 12, cy - 12), (x1 - 12, cy + 12)], fill=0, width=5)
    draw.line([(x0 + 12, cy + 12), (x1 - 12, cy - 12)], fill=0, width=5)
    row = read_page(doubled).rows[0]
    assert row.amount is None
    assert sorted(row.amount_marks) == [2, 4]
    assert row.action == "purchase"          # the type grid was not touched

    # The real tick painted out: no amount at all, and still a row (it has a date).
    cleared = image.copy()
    draw = ImageDraw.Draw(cleared)
    x0, x1 = cols[2], cols[3]
    draw.rectangle([x0 + 10, first.top + 8, x1 - 10, first.bottom - 8], fill=255)
    row = read_page(cleared).rows[0]
    assert row.amount is None and row.amount_marks == []
    assert row.populated


def test_pages_without_a_table_are_skipped_and_tables_without_the_form_refused():
    from PIL import Image, ImageDraw

    blank = Image.new("L", (2200, 1700), 255)
    assert read_page(blank).no_table

    # A scanner separator sheet: thick bars, no grid.
    sheet = Image.new("L", (1700, 2200), 255)
    draw = ImageDraw.Draw(sheet)
    for y in (100, 140, 180, 220):
        draw.rectangle([100, y, 1600, y + 15], fill=0)
    for x in (100, 140, 180, 220):
        draw.rectangle([x, 400, x + 15, 2100], fill=0)
    assert read_page(sheet).no_table

    # A ruled table that is not the PTR form (no merged-header blocks): a
    # table the reader cannot decompose makes the filing unreadable.
    table = Image.new("L", (2200, 1700), 255)
    draw = ImageDraw.Draw(table)
    for y in range(200, 1500, 60):
        draw.line([(100, y), (2100, y)], fill=0, width=3)
    for x in range(100, 2101, 125):
        draw.line([(x, 200), (x, 1440)], fill=0, width=3)
    with pytest.raises(GridNotFound):
        read_page(table)
