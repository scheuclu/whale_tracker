"""The hybrid transcription: model text joined to grid ticks, row by row.

The model is never called here. `parse_scanned` takes the transcriber as a
parameter and the grid is read from the committed fixture, so every rule of
the join is exercised offline: the grid wins on amount and type, the model's
own reading is a check, and a mismatch refuses the filing with a reason.
"""

from pathlib import Path

import pytest

from whale import vision
from whale.paper_form import GridReading, GridRow, Layout, read_pdf
from whale.vision import ScanUnreadable, VisionUnavailable, join, parse_scanned

FIXTURE = Path(__file__).parent / "fixtures" / "ptr_scanned_9116308.pdf"

CURRENT = Layout(4, 0, 11)
SPREADSHEET = Layout(3, 2, 11)


def grid(*specs, layout=CURRENT):
    """A fake grid reading from (amount_marks, type_marks[, flag_marks]) tuples."""
    rows = []
    for i, spec in enumerate(specs):
        amount, types, *flags = spec
        rows.append(GridRow(page=0, top=100 * i, bottom=100 * i + 60, layout=layout,
                            amount_marks=list(amount), type_marks=list(types),
                            flag_marks=list(flags[0]) if flags else [], date_ink=0.2))
    page = type("P", (), {"rows": rows, "index": 0})()
    return GridReading([page])


def model(*rows, **header):
    data = {"filer_name": "Hon. Tony Wied", "state_district": "WI08", "transactions": []}
    data.update(header)
    for asset, action, letter in rows:
        data["transactions"].append({
            "asset_name": asset, "action": action, "amount_column": letter,
            "owner": "JT", "tx_date": "2026-07-22", "notification_date": "2026-08-18",
        })
    return data


def test_grid_supplies_amount_and_type_whatever_the_model_read():
    g = grid(([2], [0]), ([0], [2]))
    m = model(("SCHWAB", "purchase", "D"), ("ADOBE", "purchase", "A"))  # both model readings wrong
    parsed = join(m, g)
    assert [(t.asset_name, t.action, t.amount_raw) for t in parsed.transactions] == [
        ("SCHWAB", "purchase", "$50,001 - $100,000"),
        ("ADOBE", "sale_partial", "$1,001 - $15,000"),
    ]
    assert parsed.filer_name == "Hon. Tony Wied" and parsed.state_district == "WI08"
    assert all(t.ticker is None for t in parsed.transactions)
    assert "model read D" in parsed.transactions[0].raw_text


def test_unknown_boxes_are_stored_as_unknown_not_filled_from_the_model():
    g = grid(([], [0]), ([2, 4], [1, 2]))
    m = model(("A", "purchase", "C"), ("B", "sale", "E"))
    parsed = join(m, g)
    assert parsed.transactions[0].amount_raw is None
    assert parsed.transactions[1].amount_raw is None
    assert parsed.transactions[1].action == "unknown"


def test_row_count_mismatch_is_unreadable_with_the_counts():
    g = grid(([2], [0]), ([0], [2]), ([1], [0]))
    m = model(("SCHWAB", "purchase", "C"), ("ADOBE", "sale_partial", "A"))
    with pytest.raises(ScanUnreadable, match="grid has 3 transaction rows but the model transcribed 2"):
        join(m, g)


def test_one_type_disagreement_is_tolerated_two_are_not():
    g = grid(([2], [0]), ([0], [2]), ([1], [0]))
    one = model(("A", "sale", "C"), ("B", "sale_partial", "A"), ("C", "purchase", "B"))
    parsed = join(one, g)
    assert [t.action for t in parsed.transactions] == ["purchase", "sale_partial", "purchase"]
    two = model(("A", "sale", "C"), ("B", "purchase", "A"), ("C", "purchase", "B"))
    with pytest.raises(ScanUnreadable, match="contradicts the grid on 2 rows"):
        join(two, g)


def test_sale_versus_partial_sale_is_not_a_contradiction():
    g = grid(([2], [2]), ([0], [2]))
    m = model(("A", "sale", "C"), ("B", "sale", "A"))
    parsed = join(m, g)
    assert [t.action for t in parsed.transactions] == ["sale_partial", "sale_partial"]


def test_headings_the_model_read_must_match_the_grid_layout():
    g = grid(([2], [0]))
    ok = model(("A", "purchase", "C"), amount_letters="A-K",
               type_columns=["Purchase", "Sale", "Partial Sale", "Exchange"])
    assert len(join(ok, g).transactions) == 1
    with pytest.raises(ScanUnreadable, match="amount columns A-K but the model read"):
        join(model(("A", "purchase", "C"), amount_letters="A to J"), g)
    with pytest.raises(ScanUnreadable, match="4 tick columns before the dates but the model read 3"):
        join(model(("A", "purchase", "C"), type_columns=["Purchase", "Sale", "Exchange"]), g)
    # Absent headings are not a mismatch: the model may leave them out.
    assert len(join(model(("A", "purchase", "C"), amount_letters=None, type_columns=[]), g).transactions) == 1


def test_flag_columns_feed_partial_sale_and_cap_gains():
    g = grid(([1], [1], [0, 1]), ([0], [0], []), layout=SPREADSHEET)
    m = model(("AIG", "sale", "B"), ("KMB", "purchase", "A"),
              type_columns=["Purchase", "Sale", "Exchange", "Capital Gains > $200", "Partial Transaction"])
    parsed = join(m, g)
    assert parsed.transactions[0].action == "sale_partial"
    assert parsed.transactions[0].cap_gains_over_200 is True
    assert parsed.transactions[1].cap_gains_over_200 is False


def test_parse_scanned_runs_the_grid_before_spending_a_model_call():
    calls = []

    def transcribe(pdf_bytes, api_key):
        calls.append(api_key)
        return model(("SCHWAB SHORT TERM U S TREASURY ETF", "purchase", "D"),
                     ("ADOBE INC", "purchase", "A"), ("UPSTART HLDGS INC", "purchase", "B"),
                     ("SALESFORCE INC", "sale_partial", "B"), ("HUBSPOT INC", "sale_partial", "B"),
                     ("THE TRADE DESK INC CLASS A", "sale_partial", "B"),
                     ("SERVICENOW INC", "sale_partial", "B"))

    parsed = parse_scanned(FIXTURE.read_bytes(), "key", transcribe=transcribe)
    assert calls == ["key"]
    assert [(t.action, t.amount_raw) for t in parsed.transactions] == [
        ("purchase", "$50,001 - $100,000"), ("sale_partial", "$1,001 - $15,000"),
        ("purchase", "$15,001 - $50,000"), ("sale_partial", "$15,001 - $50,000"),
        ("sale_partial", "$15,001 - $50,000"), ("sale_partial", "$15,001 - $50,000"),
        ("sale_partial", "$15,001 - $50,000"),
    ]
    assert all("transcribed by" in t.raw_text for t in parsed.transactions)


def test_no_key_is_unavailable_before_anything_is_read():
    with pytest.raises(VisionUnavailable):
        parse_scanned(b"%PDF-1.4 not really", None, transcribe=lambda *a: model())


def test_an_unreadable_grid_costs_no_model_call(monkeypatch):
    from whale import paper_form

    def no_grid(pdf_bytes):
        raise paper_form.GridNotFound("page 1: no table")

    monkeypatch.setattr(paper_form, "read_pdf", no_grid)
    called = []
    with pytest.raises(ScanUnreadable, match="grid: page 1"):
        parse_scanned(b"pdf", "key", transcribe=lambda *a: called.append(1))
    assert not called


def test_missing_numpy_reads_as_unavailable_not_as_a_parse_error(monkeypatch):
    from whale import paper_form

    def no_numpy(pdf_bytes):
        raise ImportError("No module named 'numpy'")

    monkeypatch.setattr(paper_form, "read_pdf", no_numpy)
    with pytest.raises(VisionUnavailable, match="numpy"):
        vision.read_grid(b"pdf")


def test_prompt_asks_for_text_and_row_order_not_for_box_reading():
    assert "in the order printed" in vision.PROMPT
    assert "heading, not a transaction" in vision.PROMPT
    assert "ticker" in vision.PROMPT and "null" in vision.PROMPT


def test_fixture_grid_matches_the_issue_ground_truth():
    # Issue #1's measurement: SCHWAB is C (models returned D), ADOBE is a
    # partial sale (models returned purchase). The grid reads both.
    rows = read_pdf(FIXTURE.read_bytes()).rows
    assert (rows[0].amount, rows[0].action) == ("C", "purchase")
    assert (rows[1].amount, rows[1].action) == ("A", "sale_partial")
