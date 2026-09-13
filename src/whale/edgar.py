"""SEC EDGAR access: Form 4 discovery and download.

Two official, unauthenticated discovery paths:

* The "getcurrent" Atom feed lists filings as EDGAR disseminates them, newest
  first, **one entry per participant** — the issuer plus every reporting
  owner — so a filing with two owners appears three times. It pages 100 at a
  time and stops at 2000 entries, a little over two business days of Form 4s.
  That cap is why the pipeline polls every three hours and keeps a cursor.
* The daily form index (`form.YYYYMMDD.idx`) is the complete record of one
  day's filings, again one row per participant. It backfills history and
  repairs any outage longer than the feed remembers.

A filing is then a single request: its full-submission `.txt` carries the
SEC header and the ownership XML, so no directory listing is needed.

SEC's fair-access rules: at most 10 requests per second, and a User-Agent
naming the project and a contact e-mail. Undeclared clients get an HTML
"Undeclared Automated Tool" page instead of the filing, and clients over the
rate are cut off for ten minutes — longer than a pipeline run can wait.
"""

from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass
from datetime import date, datetime, timezone
from xml.etree import ElementTree

import httpx

log = logging.getLogger(__name__)

FEED_URL = ("https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4"
            "&owner=only&start={start}&count=100&output=atom")
FEED_PAGE = 100
# start=2000 returns "No recent filings" (verified 2026-09-13).
FEED_CAP = 2000
DAILY_INDEX_URL = ("https://www.sec.gov/Archives/edgar/daily-index/{year}/QTR{quarter}"
                   "/form.{yyyymmdd}.idx")
ARCHIVE_URL = "https://www.sec.gov/Archives/edgar/data/{cik}/{acc_nodash}/{acc}{suffix}"

# SEC's ceiling is 10 requests/second; stay comfortably under it.
MIN_INTERVAL_S = 1 / 7
USER_AGENT_ENV = "EDGAR_USER_AGENT"

ATOM = {"atom": "http://www.w3.org/2005/Atom"}
_ACCESSION_RE = re.compile(r"\d{10}-\d{2}-\d{6}")
# "4 - Ault & Company, Inc. (0001734770) (Reporting)"
_TITLE_RE = re.compile(
    r"^(?P<form>\S+)\s+-\s+(?P<name>.+?)\s+\((?P<cik>\d{10})\)(?:\s+\((?P<role>[A-Za-z]+)\))?\s*$"
)
_FILED_RE = re.compile(r"Filed:(?:</b>)?\s*(\d{4}-\d{2}-\d{2})")
_HREF_CIK_RE = re.compile(r"/data/(\d+)/")
# A daily-index row is fixed-width, but the header's column offsets do not
# match the data's, so anchor on the right: CIK, YYYYMMDD, archive path.
_INDEX_ROW_RE = re.compile(r"^(\S+(?: \S+)*)\s{2,}(.*?)\s+(\d+)\s+(\d{8})\s+(edgar/data/\S+)\s*$")
_BLOCK_MARKERS = ("Request Rate Threshold Exceeded", "Undeclared Automated Tool")


class EdgarThrottled(Exception):
    """SEC refused the request for rate or User-Agent reasons."""


@dataclass
class FeedEntry:
    accession: str
    form_type: str
    cik: str
    name: str
    role: str | None  # 'Reporting' | 'Issuer'
    filed_date: str | None
    updated_utc: str
    index_url: str


@dataclass
class FilingRef:
    """One filing to fetch, however it was discovered."""

    accession: str
    form_type: str
    cik: str  # any participant's CIK — the archive path accepts each of them
    filed_date: str | None
    updated_utc: str | None = None
    issuer_cik: str | None = None
    issuer_name: str | None = None

    @property
    def txt_url(self) -> str:
        return archive_url(self.cik, self.accession, ".txt")

    @property
    def index_url(self) -> str:
        return archive_url(self.cik, self.accession, "-index.htm")


@dataclass
class IndexRow:
    form_type: str
    company: str
    cik: str
    date_filed: str  # ISO
    path: str

    @property
    def accession(self) -> str:
        return accession_from_path(self.path)


# --- URLs and identifiers ----------------------------------------------------


def acc_nodash(acc: str) -> str:
    return acc.replace("-", "")


def accession_from_path(path: str) -> str:
    m = _ACCESSION_RE.search(path)
    if not m:
        raise ValueError(f"no accession number in {path!r}")
    return m.group(0)


def archive_url(cik: str, acc: str, suffix: str) -> str:
    # Archive paths use the CIK without leading zeros.
    return ARCHIVE_URL.format(cik=str(int(cik)), acc_nodash=acc_nodash(acc), acc=acc, suffix=suffix)


def quarter_of(day: date) -> int:
    return (day.month - 1) // 3 + 1


def daily_index_url(day: date) -> str:
    return DAILY_INDEX_URL.format(year=day.year, quarter=quarter_of(day),
                                  yyyymmdd=day.strftime("%Y%m%d"))


def to_utc_iso(ts: str) -> str:
    """'2026-09-10T18:30:31-04:00' -> '2026-09-10T22:30:31Z'."""
    dt = datetime.fromisoformat(ts.strip())
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# --- parsing (pure) ----------------------------------------------------------


def parse_feed(xml_bytes: bytes) -> list[FeedEntry]:
    """One FeedEntry per Atom entry — i.e. per participant, not per filing."""
    root = ElementTree.fromstring(xml_bytes)
    entries = []
    for entry in root.findall("atom:entry", ATOM):
        summary = _itertext(entry.find("atom:summary", ATOM))
        m = _ACCESSION_RE.search(_text(entry, "atom:id") or "") or _ACCESSION_RE.search(summary)
        if not m:
            log.warning("feed entry without accession number: %r", _text(entry, "atom:title"))
            continue
        title = _text(entry, "atom:title") or ""
        tm = _TITLE_RE.match(title)
        cat = entry.find("atom:category", ATOM)
        link = entry.find("atom:link", ATOM)
        href = link.get("href", "") if link is not None else ""
        form_type = (cat.get("term") if cat is not None else None) or (tm.group("form") if tm else "")
        cik = tm.group("cik") if tm else _cik_from_href(href)
        filed = _FILED_RE.search(summary)
        entries.append(FeedEntry(
            accession=m.group(0),
            form_type=form_type,
            cik=cik,
            name=tm.group("name") if tm else title,
            role=tm.group("role") if tm else None,
            filed_date=filed.group(1) if filed else None,
            updated_utc=to_utc_iso(_text(entry, "atom:updated") or "1970-01-01T00:00:00Z"),
            index_url=href,
        ))
    return entries


def group_feed(entries: list[FeedEntry]) -> list[FilingRef]:
    """Collapse per-participant entries into one ref per accession."""
    refs: dict[str, FilingRef] = {}
    for e in entries:
        ref = refs.get(e.accession)
        if ref is None:
            ref = refs[e.accession] = FilingRef(
                accession=e.accession, form_type=e.form_type, cik=e.cik,
                filed_date=e.filed_date, updated_utc=e.updated_utc,
            )
        else:
            if e.updated_utc > (ref.updated_utc or ""):
                ref.updated_utc = e.updated_utc
            ref.filed_date = ref.filed_date or e.filed_date
        if e.role == "Issuer":
            ref.issuer_cik, ref.issuer_name = e.cik, e.name
    return list(refs.values())


def parse_form_index(text: str) -> list[IndexRow]:
    rows = []
    for line in text.splitlines():
        m = _INDEX_ROW_RE.match(line.rstrip())
        if not m:
            continue
        form_type, company, cik, ymd, path = m.groups()
        rows.append(IndexRow(
            form_type=form_type, company=company.strip(), cik=cik.zfill(10),
            date_filed=f"{ymd[:4]}-{ymd[4:6]}-{ymd[6:]}", path=path,
        ))
    return rows


def group_index(rows: list[IndexRow]) -> list[FilingRef]:
    refs: dict[str, FilingRef] = {}
    for r in rows:
        acc = r.accession
        if acc not in refs:
            refs[acc] = FilingRef(accession=acc, form_type=r.form_type, cik=r.cik,
                                  filed_date=r.date_filed)
    return sorted(refs.values(), key=lambda r: (r.filed_date or "", r.accession))


def _text(node, path: str) -> str | None:
    el = node.find(path, ATOM) if node is not None else None
    if el is None or el.text is None:
        return None
    return el.text.strip() or None


def _itertext(node) -> str:
    return "".join(node.itertext()) if node is not None else ""


def _cik_from_href(href: str) -> str:
    m = _HREF_CIK_RE.search(href)
    return m.group(1).zfill(10) if m else ""


# --- HTTP --------------------------------------------------------------------


class EdgarClient:
    """One connection, SEC-compliant headers, a minimum interval between requests.

    `sleep` and `clock` are injectable so the throttle is testable without
    waiting; `transport` accepts an httpx.MockTransport.
    """

    def __init__(self, user_agent: str, min_interval: float = MIN_INTERVAL_S,
                 timeout: float = 30.0, transport: httpx.BaseTransport | None = None,
                 sleep=time.sleep, clock=time.monotonic) -> None:
        self._client = httpx.Client(
            headers={"User-Agent": user_agent, "Accept-Encoding": "gzip, deflate"},
            timeout=timeout, follow_redirects=True, transport=transport,
        )
        self._min_interval = min_interval
        self._sleep = sleep
        self._clock = clock
        self._last: float | None = None
        self.requests = 0

    def get(self, url: str) -> httpx.Response:
        resp = self._request(url)
        if _is_throttled(resp):
            wait = _retry_after(resp)
            log.warning("EDGAR throttled (%s); retrying once after %ds", resp.status_code, wait)
            self._sleep(wait)
            resp = self._request(url)
            if _is_throttled(resp):
                raise EdgarThrottled(f"HTTP {resp.status_code} for {url}")
        resp.raise_for_status()
        return resp

    def _request(self, url: str) -> httpx.Response:
        if self._last is not None:
            wait = self._last + self._min_interval - self._clock()
            if wait > 0:
                self._sleep(wait)
        self._last = self._clock()
        self.requests += 1
        return self._client.get(url)

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "EdgarClient":
        return self

    def __exit__(self, *exc) -> None:
        self.close()


def _is_throttled(resp: httpx.Response) -> bool:
    if resp.status_code in (429, 403):
        return True
    # The "undeclared tool" page has been seen with a 200 as well.
    ctype = resp.headers.get("content-type", "")
    if "html" in ctype:
        head = resp.text[:4000]
        return any(marker in head for marker in _BLOCK_MARKERS)
    return False


def _retry_after(resp: httpx.Response) -> int:
    try:
        return max(1, int(resp.headers.get("retry-after", "15")))
    except ValueError:
        return 15


def fetch_feed_page(client: EdgarClient, start: int) -> list[FeedEntry]:
    return parse_feed(client.get(FEED_URL.format(start=start)).content)


def fetch_daily_index(client: EdgarClient, day: date) -> list[IndexRow] | None:
    """None when there is no index for the day (weekend, holiday)."""
    try:
        resp = client.get(daily_index_url(day))
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code == 404:
            return None
        raise
    return parse_form_index(resp.text)


def fetch_submission(client: EdgarClient, ref: FilingRef) -> str | None:
    """The full-submission text, or None if EDGAR has no such filing."""
    try:
        resp = client.get(ref.txt_url)
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code == 404:
            return None
        raise
    return resp.text
