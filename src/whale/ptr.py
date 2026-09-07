"""House Periodic Transaction Report (PTR) PDF → transactions.

The Clerk generates these from a fixed template, so parsing is done on word
*coordinates* rather than on reflowed text: `pdftotext`-style extraction runs
adjacent columns together ("07/13/202607/13/2026$15,001 -"), while the column
x-ranges below are stable across every e-filed PTR.

Two details of the template make this tractable:

* Form labels are drawn with hidden padding glyphs, so "Filing Status:" comes
  out as 'F\\x00\\x00\\x00\\x00\\x00' 'S\\x00\\x00\\x00\\x00\\x00:'. A NUL in a
  word therefore marks a sub-field line, never asset text.
* Long asset names and amounts wrap onto following lines within their own
  column, so continuation is detected by x-range rather than by guessing.

Paper filings are scanned images with no text layer at all; they are detected
here and handed to `vision.py`.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field

import pdfplumber

log = logging.getLogger(__name__)

# Column boundaries in PDF points, from the template's header row:
# ID[25] Owner[65] Asset[104] Transaction Type[262] Date[327]
# Notification Date[382] Amount[446] Cap. Gains[525]
COL_OWNER = (58, 100)
COL_ASSET = (100, 255)
COL_TYPE = (255, 320)
COL_TX_DATE = (320, 378)
COL_NOTIF_DATE = (378, 440)
COL_AMOUNT = (440, 518)
COL_CAPGAINS = (518, 612)

DATE_RE = re.compile(r"^\d{2}/\d{2}/\d{4}$")
# Trailing "(NVDA) [ST]" — ticker is optional, the bracketed asset code is not.
TICKER_TYPE_RE = re.compile(r"\(([A-Z0-9.\-]{1,10})\)\s*\[([A-Z0-9]{2})\]\s*$")
# Treasury and agency debt put a CUSIP in that slot, not a ticker: exactly nine
# alphanumerics with at least one digit ("91282CGH8"). Storing it as a ticker
# pollutes the ticker namespace with identifiers no equity will ever match.
CUSIP_RE = re.compile(r"^(?=.*\d)[A-Z0-9]{9}$")
TYPE_ONLY_RE = re.compile(r"\[([A-Z0-9]{2})\]\s*$")

ACTIONS = {
    "P": "purchase",
    "S": "sale",
    "S (partial)": "sale_partial",
    "E": "exchange",
}

# Below this many extracted characters a PDF is a scan, not a text filing.
# Real scans yield 2-5 characters; the shortest text PTR yields >1000.
TEXT_LAYER_MIN_CHARS = 200

FOOTER_MARKER = "For the complete list of asset type abbreviations"


class ScannedFilingError(Exception):
    """The PDF has no text layer — it is a scanned paper filing."""


@dataclass
class Transaction:
    asset_name: str
    action: str
    ticker: str | None = None
    asset_type: str | None = None
    owner: str | None = None
    tx_date: str | None = None
    notification_date: str | None = None
    amount_raw: str | None = None
    cap_gains_over_200: bool | None = None
    description: str | None = None
    raw_text: str = ""


@dataclass
class ParsedFiling:
    filer_name: str | None = None
    state_district: str | None = None
    status: str | None = None
    transactions: list[Transaction] = field(default_factory=list)


@dataclass
class _Line:
    top: float
    words: list[dict]

    def col(self, bounds: tuple[float, float]) -> list[dict]:
        lo, hi = bounds
        return [w for w in self.words if lo <= w["x0"] < hi]

    def text(self, bounds: tuple[float, float]) -> str:
        return " ".join(w["text"] for w in self.col(bounds)).strip()

    @property
    def has_nul(self) -> bool:
        """A form-label line (hidden padding glyphs), not filer-entered text."""
        return any("\x00" in w["text"] for w in self.words)

    @property
    def all_text(self) -> str:
        return " ".join(w["text"] for w in self.words).replace("\x00", "")


def _lines(page) -> list[_Line]:
    """Group words into visual lines, tolerating sub-point baseline jitter."""
    words = page.extract_words(use_text_flow=False, keep_blank_chars=False)
    buckets: dict[int, list[dict]] = {}
    for w in words:
        buckets.setdefault(round(w["top"] / 3), []).append(w)
    return [
        _Line(top=min(w["top"] for w in ws), words=sorted(ws, key=lambda w: w["x0"]))
        for _, ws in sorted(buckets.items())
    ]


def _is_transaction_start(line: _Line) -> bool:
    """A transaction row is the only line carrying both a type code and a date."""
    if line.has_nul:
        return False
    type_cell = line.text(COL_TYPE)
    date_cell = line.text(COL_TX_DATE)
    return bool(type_cell) and bool(DATE_RE.match(date_cell.split(" ")[0]))


def _is_header(line: _Line) -> bool:
    t = line.all_text
    return t.startswith("ID Owner Asset") or t.startswith("Type Date") or t == "$200?"


def parse_pdf(path_or_bytes) -> ParsedFiling:
    """Parse a House PTR PDF. Raises ScannedFilingError for image-only scans."""
    with pdfplumber.open(path_or_bytes) as pdf:
        pages = [_lines(p) for p in pdf.pages]
        char_count = sum(len(p.extract_text() or "") for p in pdf.pages)

    if char_count < TEXT_LAYER_MIN_CHARS:
        raise ScannedFilingError(f"no text layer ({char_count} chars extracted)")

    result = ParsedFiling()
    all_lines = [ln for page in pages for ln in page]
    _parse_header(all_lines, result)
    result.transactions = _parse_transactions(all_lines)
    return result


def _parse_header(lines: list[_Line], result: ParsedFiling) -> None:
    for line in lines:
        text = line.all_text
        if text.startswith("Name:"):
            name = text[len("Name:"):].strip()
            result.filer_name = re.sub(r"^(Hon\.|Mr\.|Mrs\.|Ms\.|Dr\.)\s+", "", name).strip()
        elif text.startswith("Status:"):
            result.status = text[len("Status:"):].strip()
        elif text.startswith("State/District:"):
            result.state_district = text[len("State/District:"):].strip()
        if result.filer_name and result.state_district:
            return


def _parse_transactions(lines: list[_Line]) -> list[Transaction]:
    transactions: list[Transaction] = []
    current: Transaction | None = None
    # Asset text and amount text can each wrap onto following lines.
    asset_parts: list[str] = []
    amount_parts: list[str] = []
    raw_parts: list[str] = []

    def flush() -> None:
        nonlocal current
        if current is None:
            return
        current.asset_name = " ".join(" ".join(asset_parts).split())
        current.amount_raw = " ".join(" ".join(amount_parts).split())
        current.raw_text = "\n".join(raw_parts)
        _resolve_asset(current)
        transactions.append(current)
        current = None

    for line in lines:
        if _is_header(line):
            continue
        if FOOTER_MARKER in line.all_text:
            flush()
            # Everything after the transaction table is filer/certification
            # boilerplate; on multi-page filings the table resumes at the next
            # page header, which the header check above skips back into.
            continue

        if _is_transaction_start(line):
            flush()
            type_cell = line.text(COL_TYPE)
            current = Transaction(
                asset_name="",
                action=ACTIONS.get(type_cell, type_cell.lower() or "unknown"),
                owner=line.text(COL_OWNER) or None,
                tx_date=_iso_date(line.text(COL_TX_DATE)),
                notification_date=_iso_date(line.text(COL_NOTIF_DATE)),
                cap_gains_over_200=_cap_gains(line.text(COL_CAPGAINS)),
            )
            asset_parts = [line.text(COL_ASSET)]
            amount_parts = [line.text(COL_AMOUNT)]
            raw_parts = [line.all_text]
            continue

        if current is None:
            continue

        raw_parts.append(line.all_text)

        if line.has_nul:
            # Sub-field line: "Filing Status: New", "Subholding Of: ...",
            # "Description: Sale from Individual Retirement Account".
            label, _, value = line.all_text.partition(":")
            value = value.strip()
            if value and label.strip().startswith("D"):
                current.description = value
            continue

        # Continuation: asset name and/or amount wrapping within their columns.
        if asset_text := line.text(COL_ASSET):
            asset_parts.append(asset_text)
        if amount_text := line.text(COL_AMOUNT):
            amount_parts.append(amount_text)

    flush()
    return transactions


def _resolve_asset(tx: Transaction) -> None:
    """Split the trailing "(TICKER) [XX]" marker off the asset name."""
    name = tx.asset_name
    if m := TICKER_TYPE_RE.search(name):
        candidate = m.group(1)
        tx.ticker = None if CUSIP_RE.match(candidate) else candidate
        tx.asset_type = m.group(2)
        tx.asset_name = name[: m.start()].strip(" -")
    elif m := TYPE_ONLY_RE.search(name):
        tx.asset_type = m.group(1)
        tx.asset_name = name[: m.start()].strip(" -")


def _iso_date(cell: str) -> str | None:
    token = cell.split(" ")[0] if cell else ""
    if not DATE_RE.match(token):
        return None
    mm, dd, yyyy = token.split("/")
    return f"{yyyy}-{mm}-{dd}"


def _cap_gains(cell: str) -> bool | None:
    text = cell.strip().lower()
    if text.startswith("yes"):
        return True
    if text.startswith("no"):
        return False
    return None
