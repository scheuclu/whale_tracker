"""Senate eFD electronic PTR pages → the House parser's vocabulary (#40).

The fixtures are real eFD report pages (captured from efdsearch.senate.gov,
trimmed to the <main> block the parser reads). Each test pins one column or
one vocabulary mapping, because the whole point of the parser is that a
Senate row must be indistinguishable downstream from a House row: the cluster
finder, the asset-type filter and the Telegram formatters never learn which
chamber a transaction came from.
"""

import re
from pathlib import Path

import pytest

from whale import senate_ptr
from whale.amounts import parse_amount
from whale.senate_ptr import SenateParseError, parse_report

FIXTURES = Path(__file__).parent / "fixtures"


def _load(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def carper():
    return parse_report(_load("efd_ptr_carper_2019-10-01.html"))


@pytest.fixture(scope="module")
def cantwell():
    return parse_report(_load("efd_ptr_cantwell_2016-05-11.html"))


@pytest.fixture(scope="module")
def loeffler():
    return parse_report(_load("efd_ptr_loeffler_2020-02-07.html"))


@pytest.fixture(scope="module")
def roberts():
    return parse_report(_load("efd_ptr_roberts_2014-08-12.html"))


# --- header -----------------------------------------------------------------


def test_filer_name_drops_the_honorific_and_the_sort_key(carper, loeffler):
    assert carper.filer_name == "Thomas R Carper"
    # "Mrs." rather than "The Honorable": the page prints whatever the filer
    # chose, and neither is part of the name.
    assert loeffler.filer_name == "Kelly Loeffler"


def test_senate_filings_carry_no_state_district(carper):
    # eFD never prints a state on the report page; the roster supplies it.
    assert carper.state_district is None


def test_title_and_filed_date(carper, loeffler):
    assert carper.status == "Periodic Transaction Report for 10/01/2019"
    assert carper.filed_date == "2019-10-01"
    assert loeffler.filed_date == "2020-02-07"


# --- rows and order ---------------------------------------------------------


def test_rows_are_returned_in_filing_order(carper):
    # The page lists the newest-entered row first (6, 5, 2, 4, 3, 1); the
    # "#" column is the filer's order and the one worth keeping.
    assert len(carper.transactions) == 6
    assert [t.asset_name for t in carper.transactions] == [
        "JP Morgan Chase Step-up",
        "JP Morgan Chase Step-up",
        "JPM Contingent Autocall on NVDA",
        "JPM Contingent Autocall on NVDA",
        "CS Contingent Autocall on MSFT",
        "CS Contingent Autocall on MSFT",
    ]


def test_multi_row_filing_keeps_every_row(loeffler):
    assert len(loeffler.transactions) == 22


def test_transaction_date_is_iso(carper):
    assert [t.tx_date for t in carper.transactions] == [
        "2019-09-19", "2019-09-19", "2019-09-19", "2019-09-19",
        "2019-09-27", "2019-09-27",
    ]


def test_senate_rows_have_no_notification_date_or_cap_gains(carper):
    # Neither column exists on the Senate form. NULL, never a guess.
    assert all(t.notification_date is None for t in carper.transactions)
    assert all(t.cap_gains_over_200 is None for t in carper.transactions)


# --- every column of one row ------------------------------------------------


def test_every_column_of_a_partial_sale_with_a_comment(cantwell):
    [tx] = cantwell.transactions
    assert tx.tx_date == "2016-04-28"
    assert tx.owner is None            # "Self" is the House's blank owner
    assert tx.ticker == "RNWK"
    assert tx.asset_name == "RealNetworks Inc."
    assert tx.asset_type == "ST"
    assert tx.action == "sale_partial"
    assert tx.amount_raw == "$1,001 - $15,000"
    assert parse_amount(tx.amount_raw).min_cents == 100_100
    assert parse_amount(tx.amount_raw).max_cents == 1_500_000
    assert tx.description == "Sale of two blocks"
    assert tx.raw_text == (
        "1 | 04/28/2016 | Self | RNWK | RealNetworks Inc. | Stock | "
        "Sale (Partial) | $1,001 - $15,000 | Sale of two blocks"
    )


# --- owner ------------------------------------------------------------------


def test_owner_spouse_maps_to_sp(carper):
    assert {t.owner for t in carper.transactions} == {"SP"}


def test_owner_joint_maps_to_jt_and_self_to_null(loeffler):
    by_number = {t.raw_text.split(" | ")[0]: t for t in loeffler.transactions}
    assert by_number["15"].owner is None      # Self
    assert by_number["16"].owner == "SP"


def test_owner_vocabulary_is_complete():
    assert senate_ptr.map_owner("Self") is None
    assert senate_ptr.map_owner("Spouse") == "SP"
    assert senate_ptr.map_owner("Joint") == "JT"
    assert senate_ptr.map_owner("Dependent Child") == "DC"
    assert senate_ptr.map_owner("Child") == "DC"
    # An owner the form does not have today is kept verbatim, not dropped.
    assert senate_ptr.map_owner("Trust") == "Trust"


# --- type -------------------------------------------------------------------


def test_type_vocabulary_is_complete():
    assert senate_ptr.map_action("Purchase") == "purchase"
    assert senate_ptr.map_action("Sale (Full)") == "sale"
    assert senate_ptr.map_action("Sale (Partial)") == "sale_partial"
    assert senate_ptr.map_action("Exchange") == "exchange"
    # Unknown: lower-cased so it is visibly not one of ours, never "unknown".
    assert senate_ptr.map_action("Gift") == "gift"


def test_full_and_partial_sales_are_told_apart(carper, loeffler):
    assert [t.action for t in carper.transactions] == [
        "purchase", "purchase", "sale", "sale", "purchase", "purchase",
    ]
    actions = {t.action for t in loeffler.transactions}
    assert actions == {"purchase", "sale", "sale_partial"}


# --- ticker -----------------------------------------------------------------


def test_ticker_dashes_are_null_and_links_are_symbols(carper, loeffler):
    assert all(t.ticker is None for t in carper.transactions)
    tickers = {t.ticker for t in loeffler.transactions}
    assert {"CMCSA", "CSCO", "GS", "CVX", "UL", "PRU", "TJX", "ROST", "AZO",
            "KEYS", "REZI", "DFS"} <= tickers
    assert None in tickers


# --- asset type -------------------------------------------------------------


def test_asset_type_mapping_to_house_codes():
    assert senate_ptr.map_asset_type("Stock") == "ST"
    assert senate_ptr.map_asset_type("Stock Option") == "OP"
    assert senate_ptr.map_asset_type("Corporate Bond") == "CS"
    assert senate_ptr.map_asset_type("Municipal Security") == "GS"
    assert senate_ptr.map_asset_type("Mutual Fund") == "MF"
    assert senate_ptr.map_asset_type("Exchange Traded Fund") == "EF"
    assert senate_ptr.map_asset_type("Cryptocurrency") == "CT"
    assert senate_ptr.map_asset_type("Non-Public Stock") == "PS"
    # No House code says the same thing: NULL, and the label survives in the
    # description (tested on a real row below).
    assert senate_ptr.map_asset_type("Other Securities") is None
    assert senate_ptr.map_asset_type("") is None
    assert senate_ptr.map_asset_type("Something New") is None


def test_stock_option_rows_keep_the_option_detail(loeffler):
    by_number = {t.raw_text.split(" | ")[0]: t for t in loeffler.transactions}
    tx = by_number["22"]
    assert tx.asset_type == "OP"
    assert tx.asset_name == "Comcast Corporation"
    assert tx.ticker == "CMCSA"
    assert tx.description == "Option Type: Put · Strike price: $42.50 · Expires: 07/17/2020"


def test_non_ticker_bond_keeps_its_coupon_detail(carper):
    tx = carper.transactions[0]
    assert tx.asset_type == "CS"
    assert tx.ticker is None
    assert tx.asset_name == "JP Morgan Chase Step-up"
    assert tx.description == "Rate/Coupon: 2.5% · Matures: 09/23/2029"


def test_unmapped_asset_type_keeps_the_senate_label(loeffler):
    by_number = {t.raw_text.split(" | ")[0]: t for t in loeffler.transactions}
    tx = by_number["16"]
    assert tx.asset_type is None
    assert tx.asset_name == "Blackstone Real Estate Investment Trust"
    assert tx.description == (
        "Asset type: Other Securities · Company: The Blackstone Group Inc. "
        "(New York, NY) · Description: Real Estate Investment Trust"
    )


def test_blank_asset_type_cell_is_null(roberts):
    # Older filings leave the column empty. Not "Stock", not "" — NULL.
    assert all(t.asset_type is None for t in roberts.transactions)
    assert roberts.transactions[0].asset_name == "Facebook, Inc. (NASDAQ)"
    assert roberts.transactions[0].ticker == "FB"
    assert roberts.transactions[0].description == "sep"


# --- amount -----------------------------------------------------------------


def test_amounts_stay_brackets(loeffler):
    seen = {t.amount_raw for t in loeffler.transactions}
    assert "$250,001 - $500,000" in seen
    for raw in seen:
        amount = parse_amount(raw)
        assert amount is not None and amount.exact_cents is None
        assert amount.min_cents < amount.max_cents


# --- comment ----------------------------------------------------------------


def test_empty_comment_is_not_a_description(loeffler):
    by_number = {t.raw_text.split(" | ")[0]: t for t in loeffler.transactions}
    assert by_number["14"].description is None
    assert by_number["14"].raw_text.endswith("| $15,001 - $50,000 | --")


def test_comment_comes_before_the_asset_detail():
    html = re.sub(r"<td>--</td>(\s*</tr>)", r"<td>Called early</td>\1",
                  _load("efd_ptr_carper_2019-10-01.html"), count=1)
    parsed = parse_report(html)
    with_comment = [t for t in parsed.transactions if t.description.startswith("Called")]
    assert len(with_comment) == 1
    assert with_comment[0].description == "Called early · Rate/Coupon: 8.25% · Matures: 09/30/2022"


# --- failure is loud --------------------------------------------------------


def test_a_page_without_the_transactions_table_fails_rather_than_parsing_empty():
    # A real eFD page of the wrong kind (an annual report). Reporting zero
    # transactions would be the silent failure the audit exists to catch.
    with pytest.raises(SenateParseError, match="no transactions table"):
        parse_report(_load("efd_annual_leahy_2014.html"))


def test_an_empty_or_non_efd_page_fails():
    with pytest.raises(SenateParseError):
        parse_report("")
    with pytest.raises(SenateParseError):
        parse_report("<html><body><h1>Access Denied</h1></body></html>")


def test_the_agreement_form_is_recognised_as_a_lost_session():
    page = ('<html><body><form><input type="hidden" name="csrfmiddlewaretoken" value="x">'
            '<input type="checkbox" name="prohibition_agreement"></form></body></html>')
    with pytest.raises(SenateParseError, match="agreement"):
        parse_report(page)


def test_an_unexpected_column_order_fails_rather_than_misfiling():
    html = _load("efd_ptr_cantwell_2016-05-11.html").replace(
        '<th scope="col">Amount</th>', '<th scope="col">Value</th>')
    with pytest.raises(SenateParseError, match="columns"):
        parse_report(html)
