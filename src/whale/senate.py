"""Senate eFD scraper — best-effort.

Unlike the House, the Senate publishes no bulk file. The only route is the
eFD search app, which is behind Akamai bot protection: it returns 403 to
datacenter IPs regardless of headers, and it tracks the required
"prohibition agreement" per source IP, so a rotating proxy pool breaks the
session even when individual requests get through.

This module therefore never raises into the pipeline: `sync` classifies every
outcome into the status vocabulary below, which `sync_state.senate_status`
stores, so House coverage continues and the dashboard can state honestly that
Senate data is unavailable. The vocabulary keeps the site refusing us (the
expected outcome from a datacenter IP) apart from the request failing on our
side: an empty proxy URL was recorded as a Senate failure on every run, and
nothing could tell that from the block it was documented as (#16).

Set `SENATE_PROXY_URL` to a sticky residential proxy to make this path work.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field

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

# Vocabulary of `sync_state.senate_status`. The prefix is the contract: the
# dashboard only asks whether it starts with `ok`, and `audit.check_senate`
# must tell the known block from a failure that needs a human.
#
#   ok: N filings seen      eFD answered and the search returned rows.
#   blocked: <why>          eFD refused the session: a 403, a bot challenge, or
#                           the prohibition agreement served where data should
#                           be. Expected from a datacenter IP.
#   error: <Type>: <why>    the request failed on our side or never left: a bad
#                           proxy URL, DNS, a timeout, an unexpected HTTP
#                           status. Not the known block.
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


def fetch_ptrs(proxy_url: str | None = None, start_date: str | None = None,
               max_rows: int = 100) -> list[SenateFiling]:
    """Fetch recent Senate PTRs.

    Raises SenateBlocked when eFD refuses; anything else (proxy, DNS, timeout,
    an unexpected status) propagates. The pipeline goes through `sync`.
    """
    with _client(proxy_url) as client:
        _accept_agreement(client)

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
