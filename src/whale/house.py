"""House Clerk bulk disclosure index.

The Clerk republishes one ZIP per year containing an index of every financial
disclosure filed that year. It is the only official machine-readable entry
point — there is no per-filing API — so the pipeline downloads the ZIP each
run and diffs its DocIDs against the filings already in the database.

The ZIP is small (~57 KB for a full year) and unauthenticated, so re-fetching
it every run costs nothing.
"""

from __future__ import annotations

import io
import logging
import zipfile
from dataclasses import dataclass
from datetime import date, datetime
from xml.etree import ElementTree

import httpx

log = logging.getLogger(__name__)

INDEX_URL = "https://disclosures-clerk.house.gov/public_disc/financial-pdfs/{year}FD.zip"
PDF_URL = "https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/{year}/{doc_id}.pdf"

# Periodic Transaction Report — the STOCK Act trade filing. The same index
# also carries annual reports (A), candidate reports (C), amendments (X),
# extensions (W), termination reports (T) and blind-trust filings (D), none of
# which contain transactions.
PTR_FILING_TYPE = "P"

USER_AGENT = "whale-tracker/0.1 (congressional disclosure tracker)"


@dataclass
class IndexEntry:
    doc_id: str
    last: str
    first: str
    suffix: str
    prefix: str
    filing_type: str
    state_district: str
    year: int
    filing_date: str | None  # ISO

    @property
    def filer_name(self) -> str:
        parts = [self.first, self.last, self.suffix]
        return " ".join(p for p in parts if p).strip()

    @property
    def pdf_url(self) -> str:
        return PDF_URL.format(year=self.year, doc_id=self.doc_id)


def fetch_index(year: int, timeout: float = 60) -> list[IndexEntry]:
    """Download and parse the year's disclosure index."""
    url = INDEX_URL.format(year=year)
    resp = httpx.get(url, timeout=timeout, follow_redirects=True,
                     headers={"User-Agent": USER_AGENT})
    resp.raise_for_status()

    with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
        names = [n for n in zf.namelist() if n.lower().endswith(".xml")]
        if not names:
            raise ValueError(f"no XML in {url} (contains {zf.namelist()})")
        xml_bytes = zf.read(names[0])

    return parse_index(xml_bytes, year)


def parse_index(xml_bytes: bytes, year: int) -> list[IndexEntry]:
    root = ElementTree.fromstring(xml_bytes)
    entries = []
    for member in root.findall("Member"):
        doc_id = _text(member, "DocID")
        if not doc_id:
            continue
        entries.append(
            IndexEntry(
                doc_id=doc_id,
                last=_text(member, "Last"),
                first=_text(member, "First"),
                suffix=_text(member, "Suffix"),
                prefix=_text(member, "Prefix"),
                filing_type=_text(member, "FilingType"),
                state_district=_text(member, "StateDst"),
                year=int(_text(member, "Year") or year),
                filing_date=_iso_date(_text(member, "FilingDate")),
            )
        )
    return entries


def ptr_entries(entries: list[IndexEntry]) -> list[IndexEntry]:
    return [e for e in entries if e.filing_type == PTR_FILING_TYPE]


def fetch_pdf(url: str, timeout: float = 60) -> bytes:
    resp = httpx.get(url, timeout=timeout, follow_redirects=True,
                     headers={"User-Agent": USER_AGENT})
    resp.raise_for_status()
    return resp.content


def _text(node, tag: str) -> str:
    # The Clerk's fields carry stray whitespace and CRLF; always strip.
    el = node.find(tag)
    return (el.text or "").strip() if el is not None else ""


def _iso_date(value: str) -> str | None:
    """Clerk dates are M/D/YYYY."""
    if not value:
        return None
    for fmt in ("%m/%d/%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(value.strip(), fmt).date().isoformat()
        except ValueError:
            continue
    return None


def is_recent(filing_date: str | None, max_age_days: int, today: date | None = None) -> bool:
    """Whether a filing is new enough to notify about on first sight."""
    if not filing_date:
        return False
    today = today or date.today()
    try:
        filed = date.fromisoformat(filing_date)
    except ValueError:
        return False
    return (today - filed).days <= max_age_days
