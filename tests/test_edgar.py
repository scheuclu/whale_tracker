"""EDGAR discovery parsing and the throttled client.

Both discovery sources list one row per participant, so the same accession
appears several times and must collapse to one filing. The client must stay
under SEC's rate ceiling and must recognise SEC's refusal pages, which arrive
as HTML — sometimes with a 200 — rather than as an error code.
"""

from datetime import date
from pathlib import Path

import httpx
import pytest

from whale import edgar
from whale.edgar import EdgarThrottled, FilingRef, group_feed, group_index, parse_feed, parse_form_index

from form4_samples import feed

FIXTURES = Path(__file__).parent / "fixtures"

ACC = "0001214659-26-011648"
AMENDMENT = "0001193125-26-388273"
# The real page for the Hyperscale Data joint filing: two reporting owners
# plus the issuer, then an unrelated amendment.
FEED = feed(
    (ACC, "4", "0001734770", "Ault and Company, Inc.", "Reporting", "2026-09-11", "2026-09-11T21:59:18-04:00"),
    (ACC, "4", "0001212502", "AULT MILTON C III", "Reporting", "2026-09-11", "2026-09-11T21:59:18-04:00"),
    (ACC, "4", "0000896493", "Hyperscale Data, Inc.", "Issuer", "2026-09-11", "2026-09-11T21:59:18-04:00"),
    (AMENDMENT, "4/A", "0001763701", "Stein Deborah", "Reporting", "2026-09-10", "2026-09-10T19:53:38-04:00"),
)


# --- feed --------------------------------------------------------------------


def test_feed_lists_one_entry_per_participant():
    assert len(parse_feed(FEED)) == 4


def test_feed_entry_fields():
    e = parse_feed(FEED)[0]
    assert e.accession == ACC
    assert e.form_type == "4"
    assert e.cik == "0001734770"
    assert e.name == "Ault and Company, Inc."
    assert e.role == "Reporting"
    assert e.filed_date == "2026-09-11"
    assert e.updated_utc == "2026-09-12T01:59:18Z"  # 21:59 EDT
    assert e.index_url.endswith(f"/000121465926011648/{ACC}-index.htm")


def test_amendments_are_identified_by_category():
    assert [e.form_type for e in parse_feed(FEED)] == ["4", "4", "4", "4/A"]


def test_group_feed_collapses_participants_and_names_the_issuer():
    refs = group_feed(parse_feed(FEED))
    assert [r.accession for r in refs] == [ACC, AMENDMENT]
    joint = refs[0]
    assert (joint.issuer_cik, joint.issuer_name) == ("0000896493", "Hyperscale Data, Inc.")
    assert joint.txt_url == (
        f"https://www.sec.gov/Archives/edgar/data/1734770/000121465926011648/{ACC}.txt"
    )
    assert refs[1].issuer_cik is None  # no (Issuer) entry in the page


def test_entry_without_any_accession_is_skipped():
    broken = FEED.replace(f"accession-number={AMENDMENT}".encode(), b"accession-number=") \
                 .replace(f"AccNo:&lt;/b&gt; {AMENDMENT}".encode(), b"AccNo:&lt;/b&gt;")
    assert [e.accession for e in parse_feed(broken)] == [ACC, ACC, ACC]


def test_updated_timestamps_become_utc():
    assert edgar.to_utc_iso("2026-09-10T18:30:31-04:00") == "2026-09-10T22:30:31Z"
    assert edgar.to_utc_iso("2026-01-15T09:00:00-05:00") == "2026-01-15T14:00:00Z"


# --- daily index -------------------------------------------------------------


def test_daily_index_fixture_parses_every_row():
    rows = parse_form_index((FIXTURES / "form.20260911.idx").read_text())
    assert len(rows) == 24
    assert sorted({r.form_type for r in rows}) == ["10-K", "3", "4", "4/A", "8-K"]
    first = rows[0]
    assert first.form_type == "10-K"
    assert first.company == "1 800 FLOWERS COM INC"  # single spaces inside names survive
    assert first.cik == "0001084869"  # zero-padded like the XML
    assert first.date_filed == "2026-09-11"
    assert first.accession == "0001084869-26-000029"


def test_daily_index_header_lines_are_not_rows():
    text = (
        "Description:           Daily Index of EDGAR Dissemination Feed by Form Type\n"
        "Last Data Received:    Sep 11, 2026\n\n"
        "Form Type   Company Name                                                  CIK\n"
        "      Date Filed  File Name\n"
        "----------------------------------------------------------------------------\n"
        "1-A POS          McQueen Labs Series, LLC                                      2025795     20260911    edgar/data/2025795/0001493152-26-042361.txt\n"
    )
    rows = parse_form_index(text)
    assert len(rows) == 1
    # A form type with a space in it is still one column.
    assert rows[0].form_type == "1-A POS"
    assert rows[0].company == "McQueen Labs Series, LLC"


def test_group_index_collapses_participant_rows():
    rows = parse_form_index((FIXTURES / "form.20260911.idx").read_text())
    form4 = [r for r in rows if r.form_type == "4"]
    refs = group_index(form4)
    assert len(form4) == 12 and len(refs) == 12  # this excerpt has one row per filing
    duplicated = group_index(form4 + form4)
    assert len(duplicated) == 12
    assert all(r.form_type == "4" for r in duplicated)


# --- identifiers -------------------------------------------------------------


def test_archive_url_drops_leading_cik_zeros():
    assert edgar.archive_url("0000320193", "0001140361-26-036226", ".txt") == (
        "https://www.sec.gov/Archives/edgar/data/320193/000114036126036226/0001140361-26-036226.txt"
    )


def test_daily_index_url_quarter():
    assert edgar.daily_index_url(date(2026, 9, 11)).endswith("/2026/QTR3/form.20260911.idx")
    assert edgar.daily_index_url(date(2026, 1, 2)).endswith("/2026/QTR1/form.20260102.idx")
    assert edgar.daily_index_url(date(2026, 12, 31)).endswith("/2026/QTR4/form.20261231.idx")


def test_accession_from_path_rejects_garbage():
    with pytest.raises(ValueError):
        edgar.accession_from_path("edgar/data/1/nothing-here.txt")


# --- client ------------------------------------------------------------------


class _Clock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now


def _client(handler):
    clock = _Clock()
    sleeps: list[float] = []

    def sleep(seconds):
        sleeps.append(seconds)
        clock.now += seconds

    client = edgar.EdgarClient("whale-tracker test@example.com",
                               transport=httpx.MockTransport(handler), sleep=sleep, clock=clock)
    return client, sleeps


def test_client_declares_itself_to_sec():
    seen = {}

    def handler(request):
        seen.update(request.headers)
        return httpx.Response(200, text="ok")

    client, _ = _client(handler)
    client.get("https://www.sec.gov/x")
    assert seen["user-agent"] == "whale-tracker test@example.com"
    assert seen["accept-encoding"] == "gzip, deflate"


def test_client_spaces_requests_out():
    client, sleeps = _client(lambda request: httpx.Response(200, text="ok"))
    for _ in range(3):
        client.get("https://www.sec.gov/x")
    # No wait before the first request, then the minimum interval each time.
    assert sleeps == [pytest.approx(edgar.MIN_INTERVAL_S)] * 2
    assert client.requests == 3


def test_rate_threshold_page_is_retried_once_then_raised():
    client, sleeps = _client(lambda request: httpx.Response(
        403, text="<html>Request Rate Threshold Exceeded</html>",
        headers={"content-type": "text/html"}))
    with pytest.raises(EdgarThrottled):
        client.get("https://www.sec.gov/x")
    assert client.requests == 2
    assert sleeps[0] == 15  # default when SEC sends no Retry-After


def test_429_honours_retry_after_and_recovers():
    calls = []

    def handler(request):
        calls.append(1)
        if len(calls) == 1:
            return httpx.Response(429, text="slow down", headers={"retry-after": "3"})
        return httpx.Response(200, text="fine")

    client, sleeps = _client(handler)
    assert client.get("https://www.sec.gov/x").text == "fine"
    assert 3 in sleeps


def test_undeclared_tool_page_with_200_counts_as_throttled():
    client, _ = _client(lambda request: httpx.Response(
        200, text="<html><title>Your Request Originates from an Undeclared Automated Tool</title></html>",
        headers={"content-type": "text/html; charset=UTF-8"}))
    with pytest.raises(EdgarThrottled):
        client.get("https://www.sec.gov/x")


def test_404_means_no_such_filing_or_day():
    client, _ = _client(lambda request: httpx.Response(404, text="nope"))
    ref = FilingRef(accession=ACC, form_type="4", cik="0001734770", filed_date="2026-09-11")
    assert edgar.fetch_submission(client, ref) is None
    assert edgar.fetch_daily_index(client, date(2026, 9, 12)) is None


def test_server_errors_propagate():
    client, _ = _client(lambda request: httpx.Response(500, text="boom"))
    with pytest.raises(httpx.HTTPStatusError):
        client.get("https://www.sec.gov/x")
