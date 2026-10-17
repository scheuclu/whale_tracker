"""Senate eFD scraper — best-effort.

Unlike the House, the Senate publishes no bulk file. The only route is the
eFD search app: accept its "prohibition agreement" once per session, POST the
search, then fetch each report page. Electronic PTRs are HTML tables
(`senate_ptr.py` reads them); paper PTRs are scanned images.

eFD sits behind Akamai, and for a long time this module documented it as
blocking datacenter IPs outright. That was never observed: every earlier run
failed on an empty proxy string before reaching the site (#16), and the first
run after that fix got `ok: 100 filings seen` from a plain GitHub runner with
no proxy (#40). What Akamai does refuse is non-US addresses — an Austrian
residential IP gets a 403 `SERVE_403` page on the agreement URL itself. The
agreement is bound to the accepting IP, so if eFD ever starts refusing the
runner, `SENATE_PROXY_URL` must be a *sticky* US proxy; a rotating pool breaks
the session even when individual requests get through.

This module never raises into the pipeline: `sync` classifies every outcome
into the status vocabulary below, which `sync_state.senate_status` stores, so
House coverage continues whatever eFD does. The vocabulary keeps the site
refusing us apart from the request failing on our side, because the two need
different humans: a block wants a proxy, an error wants the config checked.
"""

from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass, field
from datetime import datetime

import httpx

log = logging.getLogger(__name__)

BASE = "https://efdsearch.senate.gov"
HOME = f"{BASE}/search/home/"
SEARCH = f"{BASE}/search/"
REPORT_DATA = f"{BASE}/search/report/data/"

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
)
CSRF_RE = re.compile(r'name="csrfmiddlewaretoken"\s+value="([^"]+)"')

# Periodic transaction reports only.
REPORT_TYPE_PTR = "11"

# Paper filings are served from this path as page images, never as a table.
PAPER_PATH = "/search/view/paper/"

# Politeness floor between requests on one session. eFD is a small government
# app; a backfill of a hundred report pages at one a second is two minutes.
MIN_REQUEST_INTERVAL = 1.0

# Vocabulary of `sync_state.senate_status`. The prefix is the contract: the
# dashboard only asks whether it starts with `ok`, and `audit.check_senate`
# must tell a block from a failure that needs a human.
#
#   ok: N filings seen      eFD answered and the search returned rows.
#   blocked: <why>          eFD refused the session: a 403, a bot challenge, or
#                           the prohibition agreement served where data should
#                           be. Seen from non-US addresses; not from the
#                           GitHub runner, so from there it is news.
#   error: <Type>: <why>    the request failed on our side or never left: a bad
#                           proxy URL, DNS, a timeout, an unexpected HTTP
#                           status. Not a block.
STATUS_OK = "ok"
STATUS_BLOCKED = "blocked"
STATUS_ERROR = "error"
STATUS_KINDS = (STATUS_OK, STATUS_BLOCKED, STATUS_ERROR)

# The agreement form; seeing it where JSON belongs means the session was lost.
AGREEMENT_RE = re.compile(r'name="prohibition_agreement"')


def status_kind(status: str | None) -> str | None:
    """The vocabulary word a stored status starts with; None if unrecognised."""
    if not status:
        return None
    head = status.split(":", 1)[0].strip()
    return head if head in STATUS_KINDS else None


class SenateBlocked(Exception):
    """eFD refused the session: a 403, a challenge page, or the agreement
    form served where data should be. Recorded as `blocked`."""


@dataclass
class SenateFiling:
    doc_id: str
    first: str
    last: str
    office: str
    report_type: str
    filed_date: str | None
    url: str


def _client(proxy_url: str | None) -> httpx.Client:
    return httpx.Client(
        base_url=BASE,
        timeout=45,
        follow_redirects=True,
        # A sticky proxy is required: the agreement below is bound to the IP
        # that accepted it, so rotating exits invalidate the session.
        proxy=proxy_url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
        },
    )


def _accept_agreement(client: httpx.Client) -> None:
    """Every eFD session must POST the prohibition agreement before searching."""
    resp = client.get(HOME)
    if resp.status_code == 403:
        raise SenateBlocked(f"403 on {HOME} (bot protection)")
    resp.raise_for_status()

    match = CSRF_RE.search(resp.text)
    if not match:
        raise SenateBlocked("no csrfmiddlewaretoken on the agreement page (bot challenge?)")

    post = client.post(
        HOME,
        data={"csrfmiddlewaretoken": match.group(1), "prohibition_agreement": "1"},
        headers={"Referer": HOME},
    )
    if post.status_code == 403:
        raise SenateBlocked("403 accepting the prohibition agreement")
    post.raise_for_status()


def is_paper_url(url: str | None) -> bool:
    """Whether a report URL points at a scanned paper filing."""
    return bool(url) and PAPER_PATH in url


class Session:
    """One eFD session: the agreement accepted once, then reused for the
    search and for every report page, at most one request a second.

    Raises SenateBlocked when eFD refuses; anything else (proxy, DNS, timeout,
    an unexpected status) propagates. The pipeline's entry points — `sync`
    for the index, `pipeline._parse_senate_filings` for the pages — catch
    both and never let them out.
    """

    def __init__(self, proxy_url: str | None = None,
                 min_interval: float = MIN_REQUEST_INTERVAL):
        self._proxy_url = proxy_url
        self._min_interval = min_interval
        self._client: httpx.Client | None = None
        self._last_request = 0.0

    def __enter__(self) -> "Session":
        self.open()
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def open(self) -> None:
        if self._client is not None:
            return
        client = _client(self._proxy_url)
        try:
            _accept_agreement(client)
        except BaseException:
            client.close()
            raise
        self._client = client
        self._last_request = time.monotonic()

    def close(self) -> None:
        if self._client is not None:
            self._client.close()
            self._client = None

    def search_ptrs(self, start_date: str | None = None,
                    max_rows: int = 100) -> list[SenateFiling]:
        """The PTR rows of the search, newest first."""
        client = self._require_client()
        csrf = client.cookies.get("csrftoken")
        if not csrf:
            raise SenateBlocked("no csrftoken cookie after accepting the agreement")

        payload = {
            "start": "0",
            "length": str(max_rows),
            "report_types": f"[{REPORT_TYPE_PTR}]",
            "filer_types": "[]",
            "submitted_start_date": start_date or "",
            "submitted_end_date": "",
            "candidate_state": "",
            "senator_state": "",
            "office_id": "",
            "first_name": "",
            "last_name": "",
            "csrfmiddlewaretoken": csrf,
        }
        self._throttle()
        resp = client.post(REPORT_DATA, data=payload,
                           headers={"Referer": SEARCH, "X-CSRFToken": csrf})
        if resp.status_code == 403:
            raise SenateBlocked("403 on the report data endpoint")
        resp.raise_for_status()

        try:
            rows = resp.json().get("data") or []
        except ValueError as exc:
            # The agreement is bound to the IP that accepted it, so a rotating
            # proxy exit gets the agreement page back where the rows should be.
            if AGREEMENT_RE.search(resp.text):
                raise SenateBlocked("report data endpoint served the prohibition "
                                    "agreement instead of JSON (proxy not sticky?)") from exc
            raise SenateBlocked(f"non-JSON response from eFD (bot challenge?): {exc}") from exc

        return [f for f in (_row_to_filing(r) for r in rows) if f is not None]

    def get_report(self, url: str) -> str:
        """The HTML of one report page.

        A 403 or the agreement form in place of the page means the session
        was refused or lost — SenateBlocked, so the caller stops asking.
        """
        client = self._require_client()
        self._throttle()
        resp = client.get(url, headers={"Referer": SEARCH})
        if resp.status_code == 403:
            raise SenateBlocked(f"403 on {url}")
        resp.raise_for_status()
        if AGREEMENT_RE.search(resp.text):
            raise SenateBlocked(f"{url} served the prohibition agreement instead of "
                                "the report (session lost; proxy not sticky?)")
        return resp.text

    def _require_client(self) -> httpx.Client:
        if self._client is None:
            raise RuntimeError("Session is not open")
        return self._client

    def _throttle(self) -> None:
        wait = self._min_interval - (time.monotonic() - self._last_request)
        if wait > 0:
            time.sleep(wait)
        self._last_request = time.monotonic()


def fetch_ptrs(proxy_url: str | None = None, start_date: str | None = None,
               max_rows: int = 100) -> list[SenateFiling]:
    """Fetch recent Senate PTRs in a session of their own. See `Session`."""
    with Session(proxy_url) as session:
        return session.search_ptrs(start_date, max_rows)


@dataclass
class SenateSync:
    """One eFD attempt, already classified into the status vocabulary."""
    status: str
    filings: list[SenateFiling] = field(default_factory=list)

    @property
    def kind(self) -> str:
        return status_kind(self.status) or STATUS_ERROR


def sync(proxy_url: str | None = None, start_date: str | None = None,
         max_rows: int = 100) -> SenateSync:
    """Fetch recent PTRs and classify the outcome. Never raises.

    The pipeline's entry point: whatever eFD, the proxy or the network does,
    the caller gets a status it can store as-is and a possibly empty list.
    """
    try:
        filings = fetch_ptrs(proxy_url, start_date, max_rows)
    except SenateBlocked as exc:
        return SenateSync(f"{STATUS_BLOCKED}: {exc}")
    except Exception as exc:  # classification is the point of this function
        return SenateSync(f"{STATUS_ERROR}: {_describe(exc)}")
    return SenateSync(f"{STATUS_OK}: {len(filings)} filings seen", filings)


def _describe(exc: BaseException) -> str:
    """`Type: message`, on one line. httpx timeouts carry an empty message, so
    without the type a timeout and a DNS failure would be recorded identically;
    its status errors carry a newline, which the audit's headings cannot."""
    text = " ".join(str(exc).split())
    name = type(exc).__name__
    return f"{name}: {text}" if text else name


_HREF_RE = re.compile(r'href="([^"]+)"')
_TAG_RE = re.compile(r"<[^>]+>")


def _row_to_filing(row: list) -> SenateFiling | None:
    """eFD returns DataTables rows: [first, last, office, report link, date]."""
    if len(row) < 5:
        return None
    link_html = row[3] or ""
    href_match = _HREF_RE.search(link_html)
    if not href_match:
        return None
    href = href_match.group(1)
    return SenateFiling(
        doc_id=href.rstrip("/").split("/")[-1],
        first=_strip_tags(row[0]),
        last=_strip_tags(row[1]),
        office=_strip_tags(row[2]),
        report_type=_strip_tags(link_html),
        filed_date=_strip_tags(row[4]) or None,
        url=href if href.startswith("http") else f"{BASE}{href}",
    )


def _strip_tags(value) -> str:
    return _TAG_RE.sub("", str(value or "")).strip()


def iso_date(value: str | None) -> str | None:
    """eFD prints MM/DD/YYYY; the database stores ISO like the House's."""
    if not value:
        return None
    for fmt in ("%m/%d/%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(value.strip(), fmt).date().isoformat()
        except ValueError:
            continue
    return None
