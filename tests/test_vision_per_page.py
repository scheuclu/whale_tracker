"""The join per page (#51): a page whose counts disagree, or whose grid
could not be read, is set aside on its own and the filing is read from the
others; a row whose model type contradicts the grid keeps the grid's type
and is flagged; only a run of disputed rows refuses a page or the filing.

The model is never called. Grids are built by hand or read from the
committed fixture; the transcription is a stub carrying page numbers.
"""

from pathlib import Path

import pytest

from whale import paper_form, vision
from whale.paper_form import GridPage, GridReading, GridRow, Layout
from whale.vision import ScannedFiling, ScanUnreadable, join, parse_scanned, read_grid

FIXTURE = Path(__file__).parent / "fixtures" / "ptr_scanned_9116308.pdf"
CURRENT = Layout(4, 0, 11)


def page(index, *specs, error=None):
    """A grid page from (amount_marks, type_marks) tuples, or one the reader
    could not decompose."""
    if error:
        return GridPage(index, 0, [], error=error)
    rows = [GridRow(page=index, top=100 * i, bottom=100 * i + 60, layout=CURRENT,
                    amount_marks=list(a), type_marks=list(t), date_ink=0.2)
            for i, (a, t) in enumerate(specs)]
    return GridPage(index, 0, rows, CURRENT)


def model(*rows, **header):
    """A transcription from (page, asset, action, letter) tuples."""
    data = {"filer_name": "Member", "state_district": "WI08", "transactions": []}
    data.update(header)
    for page_no, asset, action, letter in rows:
        data["transactions"].append({
            "page": page_no, "asset_name": asset, "action": action, "amount_column": letter,
            "owner": "SP", "tx_date": "2026-07-22", "notification_date": "2026-08-18",
        })
    return data


P, S = ([1], [0]), ([1], [1])   # a B purchase, a B sale


def test_a_page_whose_counts_disagree_is_refused_alone():
    g = GridReading([page(0, P, S), page(1, P, P, S), page(2, S)])
    m = model((1, "A", "purchase", "B"), (1, "B", "sale", "B"),
              (2, "C", "purchase", "B"), (2, "D", "purchase", "B"),            # one short
              (3, "E", "sale", "B"))
    parsed = join(m, g)
    assert isinstance(parsed, ScannedFiling)
    assert [t.asset_name for t in parsed.transactions] == ["A", "B", "E"]
    assert [t.action for t in parsed.transactions] == ["purchase", "sale", "sale"]
    # Transactions point at the grid rows they came from, skipping page 2's.
    assert parsed.row_indexes == [0, 1, 5]
    assert [(p.page_no, p.grid_rows, p.model_rows, p.joined) for p in parsed.pages] == [
        (1, 2, 2, 2), (2, 3, 2, 0), (3, 1, 1, 1)]
    assert parsed.pages[1].error == (
        "the grid found 3 transaction row(s) on this page but the model placed 2 here")
    assert [p.page_no for p in parsed.unread_pages] == [2]
    assert parsed.lost_rows == 2
    assert parsed.note().startswith("partially read: 1 page(s) yielded no rows (2 transcribed row(s) dropped)")
    assert "page 2: the grid found 3" in parsed.note()


def test_a_page_the_grid_could_not_decompose_yields_nothing_and_the_rest_is_read():
    g = GridReading([page(0, P, S), page(1, error="page 2: 0°: no amount block"),
                     page(2, S, S)])
    m = model((1, "A", "purchase", "B"), (1, "B", "sale", "B"),
              (2, "X", "purchase", "A"), (2, "Y", "sale", "A"), (2, "Z", "sale", "A"),
              (3, "C", "sale", "B"), (3, "D", "sale", "B"))
    parsed = join(m, g)
    assert [t.asset_name for t in parsed.transactions] == ["A", "B", "C", "D"]
    assert parsed.row_indexes == [0, 1, 2, 3]       # the unread page has no grid rows
    assert parsed.pages[1].error == "0°: no amount block"   # the reader's own "page 2: " dropped
    assert parsed.note().endswith("— page 2: 0°: no amount block")
    assert parsed.pages[1].model_rows == 3 and parsed.lost_rows == 3


def test_a_fully_read_filing_carries_no_note():
    g = GridReading([page(0, P, S), page(1, S)])
    parsed = join(model((1, "A", "purchase", "B"), (1, "B", "sale", "B"), (2, "C", "sale", "B")), g)
    assert parsed.note() is None and parsed.unread_pages == [] and parsed.lost_rows == 0
    assert parsed.row_indexes == [0, 1, 2]


def test_rows_the_model_puts_on_a_page_the_pdf_lacks_are_dropped_not_joined():
    g = GridReading([page(0, P, S)])
    m = model((1, "A", "purchase", "B"), (1, "B", "sale", "B"), (3, "GHOST", "sale", "B"))
    parsed = join(m, g)
    assert [t.asset_name for t in parsed.transactions] == ["A", "B"]
    assert parsed.pages[-1].page_no == 3
    assert "which the PDF does not have" in parsed.pages[-1].error
    assert parsed.lost_rows == 1


def test_a_page_with_no_table_but_transcribed_rows_is_refused_alone():
    g = GridReading([GridPage(0, 0, [], no_table=True), page(1, P)])
    m = model((1, "COVER", "purchase", "A"), (2, "A", "purchase", "B"))
    parsed = join(m, g)
    assert [t.asset_name for t in parsed.transactions] == ["A"]
    assert parsed.pages[0].error.startswith("the grid found 0 transaction row(s)")


def test_nothing_joined_is_unreadable_with_every_page_reason():
    g = GridReading([page(0, P, S), page(1, error="page 2: no rules")])
    m = model((1, "A", "purchase", "B"), (2, "B", "sale", "B"))
    with pytest.raises(ScanUnreadable) as exc:
        join(m, g)
    assert str(exc.value).startswith("no page could be joined: page 1: the grid found 2")
    assert str(exc.value).endswith("; page 2: no rules")


def test_an_empty_filing_with_nothing_to_join_is_not_an_error():
    parsed = join(model(), GridReading([page(0)]))
    assert parsed.transactions == [] and parsed.pages[0].error is None


def test_disputed_rows_keep_the_grid_type_and_are_flagged():
    g = GridReading([page(0, P, S, P, S), page(1, P, P)])
    m = model((1, "A", "purchase", "B"), (1, "B", "purchase", "B"),        # grid: sale
              (1, "C", "purchase", "B"), (1, "D", "purchase", "B"),        # grid: sale
              (2, "E", "purchase", "B"), (2, "F", "purchase", "B"))
    parsed = join(m, g)
    assert [t.action for t in parsed.transactions] == [
        "purchase", "sale", "purchase", "sale", "purchase", "purchase"]
    assert parsed.disputed_rows == [1, 3]
    assert [p.disputed for p in parsed.pages] == [2, 0]
    assert "type disputed, grid kept" in parsed.transactions[1].raw_text
    assert "type disputed" not in parsed.transactions[0].raw_text
    assert parsed.note() is None


def test_the_threshold_is_three_disputed_rows_and_more_than_a_quarter():
    # Two of three: flagged, kept — the first day's Harshbarger filings.
    two_of_three = join(model((1, "A", "purchase", "B"), (1, "B", "purchase", "A"),
                              (1, "C", "purchase", "A")),
                        GridReading([page(0, P, ([0], [3]), ([0], [3]))]))
    assert [t.action for t in two_of_three.transactions] == ["purchase", "exchange", "exchange"]
    assert two_of_three.disputed_rows == [1, 2]
    # Three of twelve: a quarter exactly, not more — kept.
    g = GridReading([page(0, *([S] * 12))])
    m = model(*[(1, f"R{i}", "purchase" if i < 3 else "sale", "B") for i in range(12)])
    assert len(join(m, g).disputed_rows) == 3
    # Three of eleven: over a quarter and three rows — the page is refused,
    # and with no other page the filing is unreadable.
    g = GridReading([page(0, *([S] * 11))])
    m = model(*[(1, f"R{i}", "purchase" if i < 3 else "sale", "B") for i in range(11)])
    with pytest.raises(ScanUnreadable, match="no page could be joined: page 1: the model's "
                                             "transaction type contradicts the grid on 3 of 11"):
        join(m, g)
    assert vision.MAX_DISPUTED_SHARE == 0.25 and vision.MIN_DISPUTED_ROWS == 3


def test_a_page_out_of_step_is_refused_alone_and_the_filing_kept():
    # Page 2's model rows are shifted against its grid: four disputes of
    # five. Page 1 and 3 join; page 2's rows are the lost ones.
    g = GridReading([page(0, P, P), page(1, P, S, P, S, P), page(2, S)])
    m = model((1, "A", "purchase", "B"), (1, "B", "purchase", "B"),
              (2, "C", "sale", "B"), (2, "D", "purchase", "B"), (2, "E", "sale", "B"),
              (2, "F", "purchase", "B"), (2, "G", "purchase", "B"),
              (3, "H", "sale", "B"))
    parsed = join(m, g)
    assert [t.asset_name for t in parsed.transactions] == ["A", "B", "H"]
    assert parsed.row_indexes == [0, 1, 7]
    assert parsed.disputed_rows == []
    assert parsed.pages[1].error.startswith(
        "the model's transaction type contradicts the grid on 4 of 5 rows on this page")
    assert "row 3: model sale, grid purchase" in parsed.pages[1].error
    assert parsed.lost_rows == 5


def test_disputes_spread_thinly_across_pages_still_refuse_the_filing():
    # Three pages of two rows, one disputed on each: no page trips the
    # rule, but half the filing is disputed.
    g = GridReading([page(0, P, S), page(1, P, S), page(2, P, S)])
    m = model(*[(p, f"R{p}{i}", "purchase", "B") for p in (1, 2, 3) for i in range(2)])
    with pytest.raises(ScanUnreadable, match="contradicts the grid on 3 of 6 rows"):
        join(m, g)


def test_without_page_numbers_the_rows_are_one_sequence_as_before():
    g = GridReading([page(0, P, S), page(1, S)])
    data = model((1, "A", "purchase", "B"), (1, "B", "sale", "B"), (1, "C", "sale", "B"))
    for t in data["transactions"]:
        del t["page"]
    parsed = join(data, g)
    assert [t.asset_name for t in parsed.transactions] == ["A", "B", "C"]
    assert parsed.row_indexes == [0, 1, 2]
    assert [(p.grid_rows, p.model_rows) for p in parsed.pages] == [(2, 2), (1, 1)]
    # A count mismatch then cannot be localised, so it refuses the filing.
    data["transactions"].pop()
    with pytest.raises(ScanUnreadable, match="grid has 3 transaction rows but the model transcribed 2"):
        join(data, g)
    # One row without a page number means none can be trusted: the same.
    data = model((1, "A", "purchase", "B"), (1, "B", "sale", "B"), (2, "C", "sale", "B"))
    data["transactions"][2]["page"] = None
    assert join(data, g).row_indexes == [0, 1, 2]


def test_page_numbers_may_arrive_as_strings():
    g = GridReading([page(0, P), page(1, S)])
    data = model(("1", "A", "purchase", "B"), ("2", "B", "sale", "B"))
    assert join(data, g).row_indexes == [0, 1]


def test_headers_are_checked_against_the_first_page_with_a_grid():
    g = GridReading([page(0, error="page 1: no rules"), page(1, P)])
    m = model((2, "A", "purchase", "B"), amount_letters="A-J")
    with pytest.raises(ScanUnreadable, match="amount columns A-K but the model read"):
        join(m, g)


# --- the grid reader and read_grid ---------------------------------------------


def _table_pdf() -> bytes:
    import io

    from PIL import Image, ImageDraw

    # A ruled table that is not the PTR form: the reader cannot decompose it.
    table = Image.new("L", (2200, 1700), 255)
    draw = ImageDraw.Draw(table)
    for y in range(200, 1500, 60):
        draw.line([(100, y), (2100, y)], fill=0, width=3)
    for x in range(100, 2101, 125):
        draw.line([(x, 200), (x, 1440)], fill=0, width=3)
    buf = io.BytesIO()
    table.save(buf, format="PDF", resolution=200)
    return buf.getvalue()


def test_read_pdf_records_an_undecomposable_page_instead_of_raising():
    reading = paper_form.read_pdf(_table_pdf())
    assert len(reading.pages) == 1
    assert reading.pages[0].error and reading.pages[0].error.startswith("page 1: ")
    assert reading.pages[0].rows == [] and reading.pages[0].layout is None
    assert reading.pages[0].width > 0 and reading.pages[0].height > 0
    assert [p.index for p in reading.unread] == [0]
    assert reading.readable is False
    assert reading.rows == []


def test_read_grid_refuses_before_the_model_only_when_no_page_reads(monkeypatch):
    with pytest.raises(ScanUnreadable, match="grid: page 1: "):
        read_grid(_table_pdf())
    # One readable page beside an unreadable one: the grid is returned, the
    # bad page carried along for the join to set aside.
    mixed = GridReading([page(0, P), page(1, error="page 2: no rules")])
    monkeypatch.setattr(paper_form, "read_pdf", lambda b: mixed)
    assert read_grid(b"pdf") is mixed
    called = []
    with pytest.raises(ScanUnreadable):
        monkeypatch.setattr(paper_form, "read_pdf",
                            lambda b: GridReading([page(0, error="page 1: x")]))
        parse_scanned(b"pdf", "key", transcribe=lambda *a: called.append(1))
    assert not called


def test_parse_scanned_against_the_fixture_page_by_page():
    # The Wied filing: four rows on page 1, three on page 2 (sideways).
    names = ["SCHWAB SHORT TERM U S TREASURY ETF", "ADOBE INC", "UPSTART HLDGS INC",
             "SALESFORCE INC", "HUBSPOT INC", "THE TRADE DESK INC CLASS A", "SERVICENOW INC"]
    pages = [1, 1, 1, 1, 2, 2, 2]
    # The model's reading of the types: right on all but ADOBE, a partial
    # sale it calls a purchase (issue #1's measurement).
    actions = ["purchase", "purchase", "purchase", "sale", "sale", "sale", "sale"]

    def transcribe(pdf_bytes, api_key):
        return model(*[(p, n, a, "B") for p, n, a in zip(pages, names, actions)])

    parsed = parse_scanned(FIXTURE.read_bytes(), "key", transcribe=transcribe)
    assert [t.asset_name for t in parsed.transactions] == names
    assert [t.action for t in parsed.transactions] == [
        "purchase", "sale_partial", "purchase", "sale_partial", "sale_partial", "sale_partial",
        "sale_partial"]
    assert parsed.row_indexes == list(range(7))
    assert [(p.grid_rows, p.model_rows, p.error) for p in parsed.pages] == [
        (4, 4, None), (3, 3, None)]
    assert parsed.grid is not None and len(parsed.grid.pages) == 2
    assert parsed.disputed_rows == [1]

    # Every type read as a purchase: page 2 (three partial sales) is three
    # of three disputed and set aside alone; page 1 is two of four, kept.
    def careless(pdf_bytes, api_key):
        return model(*[(p, n, "purchase", "B") for p, n in zip(pages, names)])

    parsed = parse_scanned(FIXTURE.read_bytes(), "key", transcribe=careless)
    assert [t.asset_name for t in parsed.transactions] == names[:4]
    assert parsed.disputed_rows == [1, 3]
    assert parsed.pages[1].error.startswith(
        "the model's transaction type contradicts the grid on 3 of 3 rows on this page")

    # The model loses a row on page 2: that page alone is set aside.
    def short(pdf_bytes, api_key):
        rows = [(p, n, None, None) for p, n in zip(pages, names)]
        return model(*rows[:-1])

    parsed = parse_scanned(FIXTURE.read_bytes(), "key", transcribe=short)
    assert [t.asset_name for t in parsed.transactions] == names[:4]
    assert parsed.row_indexes == [0, 1, 2, 3]
    assert parsed.pages[1].error == (
        "the grid found 3 transaction row(s) on this page but the model placed 2 here")
    assert parsed.lost_rows == 2


def test_prompt_asks_for_the_page_of_every_row():
    assert '"page": 1' in vision.PROMPT
    assert "page by page" in vision.PROMPT
