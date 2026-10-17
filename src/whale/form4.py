"""SEC Form 4 parsing: the full-submission header and the ownership XML.

Form 4 is the one source in this project that states exact figures — share
counts and a price per share — rather than a bracket. The parser reproduces
what was filed: every non-derivative transaction with its code, the price as
written (often a volume-weighted average whose true range lives in a
footnote), and the filer's own checkboxes. Deciding which rows matter is the
caller's job (`open_market`, `keep_reason`).

Every element is optional in practice: a minimal filing carries no security
title, ownership nature or acquired/disposed code. Booleans arrive as
"true"/"false" from some filing software and "1"/"0" from others.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from xml.etree import ElementTree
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

# Codes P and S are the filer's own decisions to buy or sell — open market or
# private. Everything else (A award, F tax withholding, M exercise, G gift, …)
# is compensation plumbing.
OPEN_MARKET_CODES = frozenset({"P", "S"})
ACTION_BY_CODE = {"P": "purchase", "S": "sale"}

# What filers type into issuerTradingSymbol when there is no ticker.
TICKER_PLACEHOLDERS = frozenset({"", "NONE", "N/A", "NA", "-", "--", "NULL"})

# Some filers list every share class in issuerTradingSymbol ("HEI, HEI.A",
# "LEN, LEN.B", "GEF, GEF-B"). The first symbol is the ticker; the verbatim
# value lives in ticker_as_filed. Split on these, never on a colon: an
# exchange-prefixed "ASX:LNW" is one symbol. Only split, never validate — the
# field has deliberately no shape check (CLAUDE.md).
_TICKER_SEPARATORS = re.compile(r"[,/\s]+")

_ACCEPTED_RE = re.compile(r"<ACCEPTANCE-DATETIME>\s*(\d{14})|ACCEPTANCE-DATETIME:\s*(\d{14})")

# One filer's software writes transaction dates with a UTC offset:
# "2026-09-08-05:00". That is a date, unambiguously, so the date part is
# stored and the verbatim string kept beside it. Nothing else is touched — a
# value this does not match is stored exactly as filed.
_DATE_WITH_OFFSET_RE = re.compile(r"(\d{4}-\d{2}-\d{2})[+-]\d{2}:\d{2}")
_DOCUMENT_RE = re.compile(r"<DOCUMENT>(.*?)</DOCUMENT>", re.S)
_XML_RE = re.compile(r"<XML>(.*?)</XML>", re.S)


@dataclass
class SecHeader:
    accession: str | None
    form_type: str | None
    filed_date: str | None        # ISO
    accepted_at: str | None       # UTC ISO 'Z'; None if the timezone database is missing
    period_of_report: str | None
    issuer_cik: str | None
    issuer_name: str | None


@dataclass
class Owner:
    cik: str
    name: str
    is_director: bool = False
    is_officer: bool = False
    is_ten_percent_owner: bool = False
    is_other: bool = False
    officer_title: str | None = None
    other_text: str | None = None


@dataclass
class Transaction:
    security_title: str | None
    tx_date: str | None
    deemed_execution_date: str | None
    transaction_code: str
    timeliness: str | None          # 'E' early | 'L' late | None on time
    shares: Decimal | None
    price_per_share: Decimal | None
    acquired_disposed: str | None   # 'A' | 'D'
    shares_after: Decimal | None
    direct_or_indirect: str | None  # 'D' | 'I'
    nature_of_ownership: str | None
    footnote_ids: list[str] = field(default_factory=list)
    footnotes: list[str] = field(default_factory=list)
    # The verbatim transactionDate when `tx_date` was parsed out of it (an
    # offset-suffixed value); None when the two are identical.
    tx_date_as_filed: str | None = None

    @property
    def value_cents(self) -> int | None:
        """shares × price in cents; None when either is missing. Unknown is not zero."""
        if self.shares is None or self.price_per_share is None or self.price_per_share <= 0:
            return None
        cents = (self.shares * self.price_per_share * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP)
        return int(cents)

    @property
    def action(self) -> str | None:
        return ACTION_BY_CODE.get(self.transaction_code)


@dataclass
class Form4:
    document_type: str
    period_of_report: str | None
    issuer_cik: str
    issuer_name: str
    ticker_as_filed: str | None
    aff_10b5_one: bool | None
    not_subject_to_section16: bool | None
    owners: list[Owner]
    # Every non-derivative transaction, whatever its code: the parser stays
    # faithful and lets `open_market` do the filtering.
    transactions: list[Transaction]
    footnotes: dict[str, str]
    remarks: str | None

    @property
    def ticker(self) -> str | None:
        return normalize_ticker(self.ticker_as_filed)


# --- full submission ---------------------------------------------------------


def parse_submission(text: str) -> tuple[SecHeader, str | None]:
    """Header plus the ownership XML of the first document that carries one.

    A submission may append exhibits (an EX-24 power of attorney is common);
    those have no <XML> block and are skipped.
    """
    header = parse_sec_header(text)
    for doc in _DOCUMENT_RE.finditer(text):
        xm = _XML_RE.search(doc.group(1))
        if xm and "<ownershipDocument" in xm.group(1):
            return header, xm.group(1).strip()
    return header, None


def parse_sec_header(text: str) -> SecHeader:
    head = text.split("</SEC-HEADER>", 1)[0]
    accepted = None
    m = _ACCEPTED_RE.search(head)
    if m:
        accepted = eastern_to_utc(m.group(1) or m.group(2))

    issuer_cik = issuer_name = None
    im = re.search(r"^ISSUER:", head, re.M)
    if im:
        block = head[im.end():]
        issuer_name = _header_field(block, "COMPANY CONFORMED NAME")
        issuer_cik = _header_field(block, "CENTRAL INDEX KEY")

    return SecHeader(
        accession=_header_field(head, "ACCESSION NUMBER"),
        form_type=_header_field(head, "CONFORMED SUBMISSION TYPE"),
        filed_date=_ymd(_header_field(head, "FILED AS OF DATE")),
        accepted_at=accepted,
        period_of_report=_ymd(_header_field(head, "CONFORMED PERIOD OF REPORT")),
        issuer_cik=issuer_cik,
        issuer_name=issuer_name,
    )


def eastern_to_utc(stamp: str) -> str | None:
    """EDGAR acceptance stamps are US/Eastern 'YYYYMMDDhhmmss'."""
    try:
        tz = ZoneInfo("America/New_York")
    except ZoneInfoNotFoundError:
        return None
    try:
        dt = datetime.strptime(stamp, "%Y%m%d%H%M%S").replace(tzinfo=tz)
    except ValueError:
        return None
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _header_field(block: str, name: str) -> str | None:
    m = re.search(rf"^\s*{re.escape(name)}:[ \t]*(.*?)[ \t]*$", block, re.M)
    if not m or not m.group(1):
        return None
    return m.group(1)


def _ymd(value: str | None) -> str | None:
    if value and re.fullmatch(r"\d{8}", value):
        return f"{value[:4]}-{value[4:6]}-{value[6:]}"
    return value


# --- ownership XML -----------------------------------------------------------


def parse_form4(xml: str | bytes) -> Form4:
    if isinstance(xml, bytes):
        xml = xml.decode("utf-8", errors="replace")
    root = ElementTree.fromstring(xml.strip())
    if root.tag != "ownershipDocument":
        raise ValueError(f"not an ownershipDocument: <{root.tag}>")

    issuer = root.find("issuer")
    issuer_cik = _text(issuer, "issuerCik")
    if not issuer_cik:
        raise ValueError("ownershipDocument has no issuerCik")

    footnotes = {
        fn.get("id"): (fn.text or "").strip()
        for fn in root.findall("footnotes/footnote") if fn.get("id")
    }
    owners = [_owner(node) for node in root.findall("reportingOwner")]
    if not owners:
        raise ValueError("ownershipDocument has no reportingOwner")

    return Form4(
        document_type=_text(root, "documentType") or "",
        period_of_report=_text(root, "periodOfReport"),
        issuer_cik=issuer_cik.zfill(10),
        issuer_name=_text(issuer, "issuerName") or "",
        ticker_as_filed=_text(issuer, "issuerTradingSymbol"),
        aff_10b5_one=_bool(_text(root, "aff10b5One")),
        not_subject_to_section16=_bool(_text(root, "notSubjectToSection16")),
        owners=owners,
        transactions=[
            _transaction(node, footnotes)
            for node in root.findall("nonDerivativeTable/nonDerivativeTransaction")
        ],
        footnotes=footnotes,
        remarks=_text(root, "remarks"),
    )


def _owner(node) -> Owner:
    cik = _text(node, "reportingOwnerId/rptOwnerCik")
    if not cik:
        raise ValueError("reportingOwner has no rptOwnerCik")
    rel = node.find("reportingOwnerRelationship")
    return Owner(
        cik=cik.zfill(10),
        name=_text(node, "reportingOwnerId/rptOwnerName") or "",
        is_director=bool(_bool(_text(rel, "isDirector"))),
        is_officer=bool(_bool(_text(rel, "isOfficer"))),
        is_ten_percent_owner=bool(_bool(_text(rel, "isTenPercentOwner"))),
        is_other=bool(_bool(_text(rel, "isOther"))),
        officer_title=_text(rel, "officerTitle"),
        other_text=_text(rel, "otherText"),
    )


def _transaction(node, footnotes: dict[str, str]) -> Transaction:
    ids = [el.get("id") for el in node.iter("footnoteId") if el.get("id")]
    tx_date, tx_date_as_filed = parse_filed_date(_value(node, "transactionDate"))
    return Transaction(
        security_title=_value(node, "securityTitle"),
        tx_date=tx_date,
        tx_date_as_filed=tx_date_as_filed,
        deemed_execution_date=_value(node, "deemedExecutionDate"),
        transaction_code=_text(node, "transactionCoding/transactionCode") or "",
        timeliness=_value(node, "transactionTimeliness"),
        shares=_decimal(_value(node, "transactionAmounts/transactionShares")),
        price_per_share=_decimal(_value(node, "transactionAmounts/transactionPricePerShare")),
        acquired_disposed=_value(node, "transactionAmounts/transactionAcquiredDisposedCode"),
        shares_after=_decimal(_value(node, "postTransactionAmounts/sharesOwnedFollowingTransaction")),
        direct_or_indirect=_value(node, "ownershipNature/directOrIndirectOwnership"),
        nature_of_ownership=_value(node, "ownershipNature/natureOfOwnership"),
        footnote_ids=ids,
        footnotes=[footnotes[i] for i in ids if i in footnotes],
    )


def parse_filed_date(raw: str | None) -> tuple[str | None, str | None]:
    """(date to store, verbatim string or None when nothing was parsed away).

    Only the offset-suffixed shape is parsed: "2026-09-08-05:00" is the 8th
    with a UTC offset, and reading it as the 8th is not correcting the
    filing. Anything else — including a malformed date — comes back exactly
    as filed with no verbatim copy, so `late` stays unknown for it.
    """
    if raw is None:
        return None, None
    m = _DATE_WITH_OFFSET_RE.fullmatch(raw.strip())
    if m is None:
        return raw, None
    try:
        date.fromisoformat(m.group(1))
    except ValueError:
        return raw, None
    return m.group(1), raw


def _text(node, path: str) -> str | None:
    if node is None:
        return None
    el = node.find(path)
    if el is None or el.text is None:
        return None
    return el.text.strip() or None


def _value(node, path: str) -> str | None:
    # Most leaves are wrapped: <transactionDate><value>2026-09-08</value></transactionDate>
    return _text(node, f"{path}/value")


def _bool(text: str | None) -> bool | None:
    if text is None:
        return None
    t = text.strip().lower()
    if t in ("true", "1"):
        return True
    if t in ("false", "0"):
        return False
    return None


def _decimal(text: str | None) -> Decimal | None:
    if text is None:
        return None
    try:
        return Decimal(text.replace(",", "").strip())
    except InvalidOperation:
        return None


# --- what to keep ------------------------------------------------------------


def normalize_ticker(raw: str | None) -> str | None:
    """Case, whitespace, and the first symbol of a multi-symbol value.

    Class-share punctuation within a symbol (BRK.B, GEF-B) is left as filed.
    """
    sym = (raw or "").strip().upper()
    if sym in TICKER_PLACEHOLDERS:  # whole-string first: "N/A" must not split into "N"
        return None
    parts = [p for p in _TICKER_SEPARATORS.split(sym) if p]
    first = parts[0] if parts else ""
    return None if first in TICKER_PLACEHOLDERS else first


def open_market(txs: list[Transaction]) -> list[Transaction]:
    return [t for t in txs if t.transaction_code in OPEN_MARKET_CODES]


def direction_totals(txs: list[Transaction]) -> dict[str, int]:
    """Summed value per direction, in cents. Rows without a value add nothing."""
    totals = {"purchase": 0, "sale": 0}
    for t in open_market(txs):
        value = t.value_cents
        if value is not None and t.action:
            totals[t.action] += value
    return totals


def keep_reason(doc: Form4, min_trade_cents: int) -> str | None:
    """The direction whose open-market total clears the floor, else None."""
    totals = direction_totals(doc.transactions)
    passing = [(v, d) for d, v in totals.items() if v >= min_trade_cents]
    if not passing:
        return None
    return max(passing)[1]
