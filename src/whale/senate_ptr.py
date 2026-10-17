"""Senate eFD electronic PTR page → the House parser's vocabulary.

Electronically filed Senate PTRs are not PDFs. eFD renders them as an HTML
page whose single table has nine fixed columns:

    # | Transaction Date | Owner | Ticker | Asset Name | Asset Type | Type
      | Amount | Comment

The page is a Django template that has been stable for years (the fixtures
under tests/fixtures/efd_ptr_*.html are real captures from 2014–2020 and
share one markup), so the parser reads it structurally — the table whose
header is exactly those columns — and refuses anything else. A page with no
such table, or with the columns in another order, raises rather than parsing
to zero rows: a PTR always has at least one transaction, and "parsed, empty"
is the silent failure the audit exists to catch.

Everything is emitted in the shapes `ptr.py` produces for the House, so the
cluster finder, the asset-type filter, the statistics and the Telegram
formatters never learn which chamber a row came from:

* owner      Self → NULL (the House's blank owner), Spouse → SP, Joint → JT,
             Dependent Child → DC. Anything else is kept verbatim.
* type       Purchase → purchase, Sale (Full) → sale, Sale (Partial) →
             sale_partial, Exchange → exchange. Anything else is lower-cased
             so it is visibly not one of ours.
* asset type the Senate label is mapped onto the House two-letter code only
             where the meaning is the same (Stock → ST, Stock Option → OP,
             Corporate Bond → CS …). Otherwise `asset_type` is NULL and the
             label is kept in `description` — never a guessed code, because
             `cluster_asset_types` filters on it.
* ticker     "--" → NULL.
* amount     the bracket text as printed; `amounts.parse_amount` keeps it a
             range.
* description  the Comment column, then the asset's sub-detail (option type,
             strike and expiry; a bond's coupon and maturity), joined by " · ".
* raw_text   the row's nine cells joined by " | ".

Senate PTRs carry no notification date and no capital-gains box; both stay
NULL. The page prints no state either — the roster supplies it.

Paper filings live at /search/view/paper/<id>/ and are scanned images; they
never reach this module (see `pipeline._parse_senate_filings`).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from html.parser import HTMLParser

from .ptr import ParsedFiling, Transaction
from .senate import AGREEMENT_RE

EXPECTED_COLUMNS = ("#", "Transaction Date", "Owner", "Ticker", "Asset Name",
                    "Asset Type", "Type", "Amount", "Comment")

# eFD vocabulary → House codes. Keys are lower-cased labels as printed.
OWNERS: dict[str, str | None] = {
    "self": None,
    "spouse": "SP",
    "joint": "JT",
    "dependent child": "DC",
    "child": "DC",
}

ACTIONS = {
    "purchase": "purchase",
    "sale (full)": "sale",
    "sale (partial)": "sale_partial",
    "exchange": "exchange",
}

# Only where the House code means the same thing. "Other Securities" is
# deliberately absent: the House's OT is a catch-all for non-securities too,
# and a row that is "other" on both forms is still better described by the
# Senate label kept in `description` than by a code nothing filters on.
ASSET_TYPES = {
    "stock": "ST",
    "stock option": "OP",
    "corporate bond": "CS",
    "municipal security": "GS",
    "government security": "GS",
    "government securities": "GS",
    "mutual fund": "MF",
    "exchange traded fund": "EF",
    "etf": "EF",
    "cryptocurrency": "CT",
    "non-public stock": "PS",
    "variable annuity": "VA",
    "ira": "IR",
    "bank deposit": "BA",
}

DATE_RE = re.compile(r"^(\d{1,2})/(\d{1,2})/(\d{4})$")
FILED_RE = re.compile(r"Filed\s+(\d{1,2}/\d{1,2}/\d{4})")
# "The Honorable Thomas R Carper (Carper, Thomas R.)": the parenthetical is
# eFD's sort key, the prefix is whatever the filer chose.
HONORIFIC_RE = re.compile(r"^(the\s+honorable|hon\.?|mr\.?|mrs\.?|ms\.?|dr\.?|sen\.?|senator)\s+",
                          re.I)
SORT_KEY_RE = re.compile(r"\s*\([^)]*\)\s*$")


class SenateParseError(ValueError):
    """The page is not an electronic PTR this parser understands."""


@dataclass
class SenateReport(ParsedFiling):
    """A parsed eFD report. `status` holds the page title ("Periodic
    Transaction Report for 10/01/2019"), as the House parser uses it for the
    form's own status line."""

    filed_date: str | None = None


def map_owner(label: str | None) -> str | None:
    key = _collapse(label).lower()
    if not key:
        return None
    return OWNERS[key] if key in OWNERS else _collapse(label)


def map_action(label: str | None) -> str:
    key = _collapse(label).lower()
    return ACTIONS.get(key, key or "unknown")


def map_asset_type(label: str | None) -> str | None:
    return ASSET_TYPES.get(_collapse(label).lower())


def parse_report(page: str) -> SenateReport:
    """Parse an eFD electronic PTR page. Raises SenateParseError otherwise."""
    if not page or not page.strip():
        raise SenateParseError("empty page")
    if AGREEMENT_RE.search(page):
        raise SenateParseError("eFD served the prohibition agreement instead of "
                               "the report (session lost)")

    parser = _PageParser()
    parser.feed(page)
    parser.close()

    report = SenateReport(
        filer_name=_filer_name(parser.filer) or None,
        state_district=None,
        status=_collapse(" ".join(parser.title)) or None,
    )
    filed = FILED_RE.search(_collapse(" ".join(parser.text)))
    report.filed_date = _iso_date(filed.group(1)) if filed else None

    table = _transactions_table(parser.tables, report.status)
    rows = []
    for cells in table["rows"]:
        if len(cells) != len(EXPECTED_COLUMNS):
            raise SenateParseError(
                f"transaction row has {len(cells)} cells, expected {len(EXPECTED_COLUMNS)}")
        rows.append(_transaction(cells))
    if not rows:
        raise SenateParseError("transactions table has no rows")

    # The page lists the most recently entered row first; "#" is the filer's
    # own order. Sort on it when every row has one, else keep page order.
    numbers = [_int_or_none(c[0].text) for c in table["rows"]]
    if all(n is not None for n in numbers):
        rows = [tx for _, tx in sorted(zip(numbers, rows), key=lambda p: p[0])]
    report.transactions = rows
    return report


# --- page model ---------------------------------------------------------------


@dataclass
class _Cell:
    main: list[str]
    detail: list[list[str]]

    @property
    def text(self) -> str:
        return _collapse(" ".join(self.main))

    @property
    def details(self) -> list[str]:
        """Each sub-detail segment ("Strike price: $42.50"), in page order."""
        out = []
        for segment in self.detail:
            text = _collapse(" ".join(segment))
            if text:
                out.append(text)
        return out

    @property
    def full_text(self) -> str:
        return _collapse(" ".join([self.text] + self.details))


class _PageParser(HTMLParser):
    """Collects the title, the filer line, every table, and all text."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.title: list[str] = []
        self.filer: list[str] = []
        self.text: list[str] = []
        self.tables: list[dict] = []
        self._in_h1 = False
        self._in_filer = False
        self._table: dict | None = None
        self._row: list[_Cell] | None = None
        self._in_thead = False
        self._cell: _Cell | None = None
        self._header_cell: list[str] | None = None
        self._muted_depth = 0
        self._div_depth = 0

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        classes = (attrs.get("class") or "").split()
        if tag == "h1":
            self._in_h1 = True
        elif tag == "h2" and "filedReport" in classes:
            self._in_filer = True
        elif tag == "table":
            self._table = {"header": [], "rows": []}
            self.tables.append(self._table)
        elif tag == "thead":
            self._in_thead = True
        elif tag == "tr" and self._table is not None:
            if self._in_thead:
                self._table["header"] = []
            else:
                self._row = []
        elif tag == "th" and self._table is not None:
            self._header_cell = []
        elif tag == "td" and self._row is not None:
            self._cell = _Cell(main=[], detail=[])
        elif tag == "div" and self._cell is not None:
            if "text-muted" in classes and self._muted_depth == 0:
                self._cell.detail.append([])
                self._muted_depth = 1
                self._div_depth = 1
            elif self._muted_depth:
                self._div_depth += 1
        elif tag == "br" and self._cell is not None and self._muted_depth:
            self._cell.detail.append([])

    def handle_endtag(self, tag):
        if tag == "h1":
            self._in_h1 = False
        elif tag == "h2":
            self._in_filer = False
        elif tag == "table":
            self._table = None
            self._row = None
        elif tag == "thead":
            self._in_thead = False
        elif tag == "tr" and self._table is not None:
            if self._row is not None:
                self._table["rows"].append(self._row)
            self._row = None
        elif tag == "th" and self._header_cell is not None:
            if self._table is not None:
                self._table["header"].append(_collapse(" ".join(self._header_cell)))
            self._header_cell = None
        elif tag == "td" and self._cell is not None:
            if self._row is not None:
                self._row.append(self._cell)
            self._cell = None
            self._muted_depth = 0
            self._div_depth = 0
        elif tag == "div" and self._cell is not None and self._muted_depth:
            self._div_depth -= 1
            if self._div_depth <= 0:
                self._muted_depth = 0
                self._div_depth = 0

    def handle_data(self, data):
        self.text.append(data)
        if self._in_h1:
            self.title.append(data)
        if self._in_filer:
            self.filer.append(data)
        if self._header_cell is not None:
            self._header_cell.append(data)
        elif self._cell is not None:
            if self._muted_depth:
                self._cell.detail[-1].append(data)
            else:
                self._cell.main.append(data)


# --- rows ---------------------------------------------------------------------


def _transactions_table(tables: list[dict], title: str | None) -> dict:
    for table in tables:
        header = tuple(table["header"])
        if header == EXPECTED_COLUMNS:
            return table
        if header[:2] == EXPECTED_COLUMNS[:2]:
            raise SenateParseError(f"unexpected columns in the transactions table: {header}")
    raise SenateParseError(
        f"no transactions table on the page (title: {title or 'none'!r})")


def _transaction(cells: list[_Cell]) -> Transaction:
    (number, tx_date, owner, ticker, asset, asset_type, kind, amount, comment) = cells

    label = asset_type.text
    code = map_asset_type(label)
    parts: list[str] = []
    if _present(comment.text):
        parts.append(comment.text)
    if label and code is None:
        parts.append(f"Asset type: {label}")
    parts += asset.details
    symbol, symbols = ticker_from_cell(ticker.text)
    if symbol is None and symbols:
        parts.append("Tickers: " + ", ".join(symbols))

    return Transaction(
        asset_name=asset.text,
        action=map_action(kind.text),
        ticker=symbol,
        asset_type=code,
        owner=map_owner(owner.text),
        tx_date=_iso_date(tx_date.text),
        notification_date=None,
        amount_raw=amount.text or None,
        cap_gains_over_200=None,
        description=" · ".join(parts) or None,
        raw_text=" | ".join(c.full_text for c in cells),
    )


def _filer_name(chunks: list[str]) -> str:
    text = SORT_KEY_RE.sub("", _collapse(" ".join(chunks)))
    return HONORIFIC_RE.sub("", text).strip()


def _present(text: str) -> bool:
    return bool(text) and text != "--"


def ticker_from_cell(text: str | None) -> tuple[str | None, list[str]]:
    """The ticker cell with eFD's "--" placeholder dropped.

    An exchange row lists one symbol per leg and prints "--" for a leg that
    has none, so the cell can read "-- AMCR" (one real symbol) or "BERY AMCR"
    (two). One symbol is the ticker. Several come back for the description
    and the ticker stays NULL: choosing a leg would be a guess.
    """
    symbols = [t.upper() for t in _collapse(text).split() if t != "--"]
    return (symbols[0] if len(symbols) == 1 else None), symbols


def _collapse(text: str | None) -> str:
    return " ".join((text or "").replace("\xa0", " ").split())


def _iso_date(text: str | None) -> str | None:
    m = DATE_RE.match(_collapse(text))
    if not m:
        return None
    mm, dd, yyyy = m.groups()
    return f"{yyyy}-{int(mm):02d}-{int(dd):02d}"


def _int_or_none(text: str) -> int | None:
    try:
        return int(text)
    except ValueError:
        return None
