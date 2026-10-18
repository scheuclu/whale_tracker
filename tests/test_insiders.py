"""The Form 4 sync step: cursor as watermark, filter, store, backfill.

Runs against a real EdgarClient over an httpx.MockTransport so the 404 and
throttling paths are the production ones. The feed pages here are short, so
a run always exhausts the feed; continuity is proven by an entry at or below
the cursor, exactly as in production.
"""

from datetime import date
from pathlib import Path

import httpx
import pytest

from whale import db, edgar, form4, insiders, stats
from whale.config import Config

from form4_samples import APPLE_ACCESSION, APPLE_VALUE_CENTS, APPLE_XML, feed, submission

FIXTURES = Path(__file__).parent / "fixtures"
HYPERSCALE = (FIXTURES / "form4_0001214659-26-011648.txt").read_text()
HYPERSCALE_ACC = "0001214659-26-011648"
TODAY = date(2026, 9, 13)

APPLE_ENTRIES = [
    (APPLE_ACCESSION, "4", "0001780525", "Newstead Jennifer", "Reporting", "2026-09-10", "2026-09-10T18:30:31-04:00"),
    (APPLE_ACCESSION, "4", "0000320193", "Apple Inc.", "Issuer", "2026-09-10", "2026-09-10T18:30:31-04:00"),
]
HYPERSCALE_ENTRIES = [
    (HYPERSCALE_ACC, "4", "0001212502", "AULT MILTON C III", "Reporting", "2026-09-11", "2026-09-11T21:59:18-04:00"),
    (HYPERSCALE_ACC, "4", "0000896493", "Hyperscale Data, Inc.", "Issuer", "2026-09-11", "2026-09-11T21:59:18-04:00"),
]
AMENDMENT_ENTRY = ("0001193125-26-388273", "4/A", "0001763701", "Stein Deborah", "Reporting",
                   "2026-09-10", "2026-09-10T19:53:38-04:00")


@pytest.fixture
def conn(tmp_path):
    c = db.connect(tmp_path / "t.sqlite3")
    yield c
    c.close()


def _config(**overrides) -> Config:
    config = Config(edgar_user_agent="whale-tracker test@example.com")
    for key, value in overrides.items():
        setattr(config.insiders, key, value)
    return config


class Edgar:
    """A scripted EDGAR: feed pages, submissions and index files by URL."""

    def __init__(self):
        self.routes: dict[str, object] = {}
        self.requests: list[str] = []
        self.client = edgar.EdgarClient("whale-tracker test@example.com",
                                        transport=httpx.MockTransport(self._handle),
                                        sleep=lambda s: None, clock=lambda: 0.0)

    def feed(self, *entries, start: int = 0):
        self.routes[edgar.FEED_URL.format(start=start)] = feed(*entries)
        return self

    def submission(self, accession: str, text: str):
        # Keyed by accession: the archive path may carry any participant's
        # CIK, and the handler resolves the accession from the URL.
        self.routes.setdefault(("sub", accession), text)
        return self

    def index(self, day: date, text: str):
        self.routes[edgar.daily_index_url(day)] = text
        return self

    def fail(self, accession: str, response):
        self.routes.setdefault(("sub", accession), response)
        return self

    def _handle(self, request):
        url = str(request.url)
        self.requests.append(url)
        if url in self.routes:
            body = self.routes[url]
            return httpx.Response(200, content=body if isinstance(body, bytes) else body.encode())
        if url.endswith(".txt"):
            acc = edgar.accession_from_path(url)
            route = self.routes.get(("sub", acc))
            if route is None:
                return httpx.Response(404, text="not found")
            if isinstance(route, Exception):
                raise route
            if isinstance(route, httpx.Response):
                return route
            return httpx.Response(200, text=route)
        return httpx.Response(404, text="not found")

    @property
    def submission_fetches(self) -> list[str]:
        return [u for u in self.requests if u.endswith(".txt")]


# --- live sync ---------------------------------------------------------------


def test_qualifying_filing_is_stored_with_owners_and_open_market_rows(conn):
    sec = Edgar().feed(*APPLE_ENTRIES).submission(APPLE_ACCESSION, submission(APPLE_ACCESSION, APPLE_XML))
    result = insiders.sync(conn, _config(), client=sec.client, today=TODAY)

    assert (result.stored, result.seen, result.aborted) == (1, 1, None)
    filing = conn.execute("SELECT * FROM insider_filings").fetchone()
    assert filing["accession"] == APPLE_ACCESSION
    assert (filing["status"], filing["source"]) == ("backfilled", "feed")
    assert (filing["ticker"], filing["ticker_as_filed"]) == ("AAPL", "AAPL")
    assert filing["issuer_cik"] == "0000320193"
    assert filing["filing_date"] == "2026-09-10"
    assert filing["accepted_at"] == "2026-09-10T22:30:31Z"
    assert filing["aff_10b5_one"] == 1
    assert filing["source_url"].endswith(f"/{APPLE_ACCESSION}-index.htm")
    assert filing["notified_at"] is None

    owner = conn.execute("SELECT * FROM insider_filing_owners").fetchone()
    assert (owner["insider_cik"], owner["owner_index"], owner["is_officer"]) == ("0001780525", 0, 1)
    assert owner["officer_title"] == "SVP, GC and Government Affairs"
    assert conn.execute("SELECT name FROM insiders WHERE cik = '0001780525'").fetchone()["name"] == "Newstead Jennifer"

    tx = conn.execute("SELECT * FROM insider_transactions").fetchone()
    assert (tx["transaction_code"], tx["action"]) == ("S", "sale")
    assert tx["amount_exact_cents"] == tx["amount_min_cents"] == tx["amount_max_cents"] == APPLE_VALUE_CENTS
    assert (tx["shares"], tx["price_per_share"]) == (1438.0, 317.23)
    assert tx["late"] == 0  # Tue 8th -> Thu 10th is two business days

    assert db.get_state(conn, insiders.STATE_CURSOR) == "2026-09-10T22:30:31Z"
    assert db.get_state(conn, insiders.STATE_STATUS) == "ok: 1 stored / 1 seen"


def test_filing_below_the_floor_is_not_stored_but_the_cursor_moves(conn):
    sec = Edgar().feed(*HYPERSCALE_ENTRIES).submission(HYPERSCALE_ACC, HYPERSCALE)
    result = insiders.sync(conn, _config(), client=sec.client, today=TODAY)

    assert result.stored == 0 and result.skipped["below_floor"] == 1
    assert conn.execute("SELECT COUNT(*) FROM insider_filings").fetchone()[0] == 0
    assert db.get_state(conn, insiders.STATE_CURSOR) == "2026-09-12T01:59:18Z"
    assert '"below_floor": 1' in db.get_state(conn, insiders.STATE_SKIPPED)


def test_a_lower_floor_keeps_it(conn):
    sec = Edgar().feed(*HYPERSCALE_ENTRIES).submission(HYPERSCALE_ACC, HYPERSCALE)
    insiders.sync(conn, _config(min_trade_usd=30_000), client=sec.client, today=TODAY)
    assert conn.execute("SELECT COUNT(*) FROM insider_transactions").fetchone()[0] == 3
    # Two reporting owners, in filing order; the holding company is second.
    owners = conn.execute("SELECT insider_cik, owner_index FROM insider_filing_owners ORDER BY owner_index").fetchall()
    assert [tuple(o) for o in owners] == [("0001212502", 0), ("0001734770", 1)]


def test_known_filings_are_not_fetched_again(conn):
    sec = Edgar().feed(*APPLE_ENTRIES).submission(APPLE_ACCESSION, submission(APPLE_ACCESSION, APPLE_XML))
    insiders.sync(conn, _config(), client=sec.client, today=TODAY)
    assert len(sec.submission_fetches) == 1

    result = insiders.sync(conn, _config(), client=sec.client, today=TODAY)
    assert len(sec.submission_fetches) == 1  # only the feed page was re-read
    assert result.stored == 0 and result.aborted is None
    assert db.get_state(conn, insiders.STATE_STATUS) == "ok: 0 stored / 1 seen"
    assert db.get_state(conn, insiders.STATE_GAP) is None


def test_amendments_are_counted_and_never_fetched(conn):
    sec = Edgar().feed(*APPLE_ENTRIES, AMENDMENT_ENTRY) \
        .submission(APPLE_ACCESSION, submission(APPLE_ACCESSION, APPLE_XML))
    result = insiders.sync(conn, _config(), client=sec.client, today=TODAY)
    assert result.skipped["amendments"] == 1
    assert all(APPLE_ACCESSION in u for u in sec.submission_fetches)


def test_filings_are_processed_oldest_first_and_a_network_error_keeps_the_watermark(conn):
    older = (HYPERSCALE_ACC, "4", "0001212502", "AULT MILTON C III", "Reporting", "2026-09-09", "2026-09-09T10:00:00-04:00")
    middle = APPLE_ENTRIES[0]
    newest = ("0000000000-26-000003", "4", "0000000003", "Someone Else", "Reporting", "2026-09-11", "2026-09-11T12:00:00-04:00")
    sec = (Edgar().feed(newest, middle, older)  # newest first, as EDGAR publishes it
           .submission(HYPERSCALE_ACC, HYPERSCALE)
           .fail(APPLE_ACCESSION, httpx.ConnectError("boom"))
           .submission(newest[0], submission(newest[0], APPLE_XML)))

    result = insiders.sync(conn, _config(min_trade_usd=30_000), client=sec.client, today=TODAY)

    assert result.stored == 1 and result.aborted.startswith("error:")
    fetched = [edgar.accession_from_path(u) for u in sec.submission_fetches]
    assert fetched == [HYPERSCALE_ACC, APPLE_ACCESSION]  # newest never attempted
    # The watermark sits on the last success; the next tick resumes above it.
    assert db.get_state(conn, insiders.STATE_CURSOR) == "2026-09-09T14:00:00Z"
    assert db.get_state(conn, insiders.STATE_STATUS).startswith("error:")


def test_throttling_stops_the_run_with_its_own_status(conn):
    blocked = httpx.Response(403, text="Request Rate Threshold Exceeded",
                             headers={"content-type": "text/html"})
    sec = Edgar().feed(*APPLE_ENTRIES).fail(APPLE_ACCESSION, blocked)
    result = insiders.sync(conn, _config(), client=sec.client, today=TODAY)
    assert result.aborted.startswith("throttled:")
    assert db.get_state(conn, insiders.STATE_STATUS).startswith("throttled:")
    assert db.get_state(conn, insiders.STATE_CURSOR) is None


def test_unparseable_xml_becomes_a_failed_row_and_the_run_continues(conn):
    broken = submission(APPLE_ACCESSION, "<ownershipDocument><issuer></ownershipDocument>")
    sec = Edgar().feed(*APPLE_ENTRIES).submission(APPLE_ACCESSION, broken)
    result = insiders.sync(conn, _config(), client=sec.client, today=TODAY)

    assert result.skipped["parse_failed"] == 1
    row = conn.execute("SELECT * FROM insider_filings").fetchone()
    assert row["status"] == "failed"
    assert row["last_error"].startswith("parse error:")
    assert (row["issuer_cik"], row["issuer_name"]) == ("0000320193", "Apple Inc.")  # from the SEC header
    assert conn.execute("SELECT COUNT(*) FROM insider_transactions").fetchone()[0] == 0
    assert stats.insider_issuer_stats(conn, today=TODAY) == {}
    assert db.get_state(conn, insiders.STATE_CURSOR) == "2026-09-10T22:30:31Z"


def test_missing_submission_is_counted_and_skipped(conn):
    sec = Edgar().feed(*APPLE_ENTRIES)  # no submission registered -> 404
    result = insiders.sync(conn, _config(), client=sec.client, today=TODAY)
    assert result.skipped["not_found"] == 1 and result.aborted is None


def test_gap_is_recorded_when_the_feed_no_longer_reaches_the_cursor(conn):
    db.set_state(conn, insiders.STATE_CURSOR, "2026-09-01T00:00:00Z")
    conn.commit()
    sec = Edgar().feed(*APPLE_ENTRIES).submission(APPLE_ACCESSION, submission(APPLE_ACCESSION, APPLE_XML))
    result = insiders.sync(conn, _config(), client=sec.client, today=TODAY)

    assert result.stored == 1
    assert db.get_state(conn, insiders.STATE_GAP) == "2026-09-01..2026-09-13"
    status = db.get_state(conn, insiders.STATE_STATUS)
    assert status.startswith("gap:") and "--from 2026-09-01 --to 2026-09-13" in status


def test_an_entry_at_the_cursor_proves_continuity(conn):
    sec = Edgar().feed(*APPLE_ENTRIES).submission(APPLE_ACCESSION, submission(APPLE_ACCESSION, APPLE_XML))
    insiders.sync(conn, _config(), client=sec.client, today=TODAY)
    # Nothing new since; the same page comes back with the cursor's own entry on it.
    insiders.sync(conn, _config(), client=sec.client, today=TODAY)
    assert db.get_state(conn, insiders.STATE_GAP) is None
    assert db.get_state(conn, insiders.STATE_STATUS).startswith("ok:")


def test_without_a_user_agent_the_step_skips_itself(conn):
    sec = Edgar().feed(*APPLE_ENTRIES)
    config = Config(edgar_user_agent=None)
    result = insiders.sync(conn, config, client=sec.client, today=TODAY)
    assert result.seen == 0 and sec.requests == []
    assert db.get_state(conn, insiders.STATE_STATUS) == "skipped: EDGAR_USER_AGENT not set"


def test_disabled_writes_nothing(conn):
    sec = Edgar().feed(*APPLE_ENTRIES)
    # Compared against the state the schema migration left, not against an
    # empty table: connecting writes the alert-log marker before any sync.
    before = conn.execute("SELECT key, value FROM sync_state ORDER BY key").fetchall()
    insiders.sync(conn, _config(enabled=False), client=sec.client, today=TODAY)
    assert sec.requests == []
    assert conn.execute("SELECT key, value FROM sync_state ORDER BY key").fetchall() == before


def test_time_budget_stops_the_run_gently(conn):
    sec = Edgar().feed(*APPLE_ENTRIES, *HYPERSCALE_ENTRIES) \
        .submission(APPLE_ACCESSION, submission(APPLE_ACCESSION, APPLE_XML)) \
        .submission(HYPERSCALE_ACC, HYPERSCALE)
    ticks = iter([0.0, 0.0, 1000.0])  # started, first check ok, second check over budget
    result = insiders.sync(conn, _config(), client=sec.client, today=TODAY,
                           budget_seconds=500, clock=lambda: next(ticks))
    assert result.aborted == "budget" and result.stored == 1
    assert "out of time" in db.get_state(conn, insiders.STATE_STATUS)


# --- storing -----------------------------------------------------------------


def test_store_filing_twice_replaces_rather_than_duplicates(conn):
    header, xml = form4.parse_submission(submission(APPLE_ACCESSION, APPLE_XML))
    doc = form4.parse_form4(xml)
    ref = edgar.FilingRef(accession=APPLE_ACCESSION, form_type="4", cik="0000320193", filed_date="2026-09-10")
    first = insiders.store_filing(conn, header, doc, ref, "feed", "backfilled")
    second = insiders.store_filing(conn, header, doc, ref, "feed", "backfilled")
    assert first == second
    counts = [conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
              for t in ("insider_filings", "insider_filing_owners", "insider_transactions", "insiders")]
    assert counts == [1, 1, 1, 1]


def test_recompute_late_rebuilds_the_flag(conn):
    sec = Edgar().feed(*APPLE_ENTRIES).submission(APPLE_ACCESSION, submission(APPLE_ACCESSION, APPLE_XML))
    insiders.sync(conn, _config(), client=sec.client, today=TODAY)
    conn.execute("UPDATE insider_transactions SET late = NULL")
    conn.commit()
    assert insiders.recompute_late(conn) == 1
    assert conn.execute("SELECT late FROM insider_transactions").fetchone()[0] == 0


# --- backfill ----------------------------------------------------------------


def test_backfill_walks_the_daily_index_and_skips_weekends(conn):
    index_text = (FIXTURES / "form.20260911.idx").read_text()
    aflac = "0001104659-26-107065"  # a Form 4 row in the fixture
    sec = (Edgar().index(date(2026, 9, 11), index_text)
           .submission(aflac, submission(aflac, APPLE_XML, filed="20260911", issuer=("0000004977", "AFLAC INC")))
           .submission(HYPERSCALE_ACC, HYPERSCALE))

    result = insiders.backfill_range(conn, _config(), date(2026, 9, 10), date(2026, 9, 13), client=sec.client)

    assert result.aborted is None
    assert result.stored == 1 and result.skipped["below_floor"] == 1
    assert result.skipped["not_found"] == 10  # fixture rows with no submission scripted
    # Three 4/A rows in the fixture, but one filing is listed twice (per participant).
    assert result.skipped["amendments"] == 2
    index_days = [u for u in sec.requests if "daily-index" in u]
    assert index_days == [edgar.daily_index_url(date(2026, 9, 10)), edgar.daily_index_url(date(2026, 9, 11))]
    row = conn.execute("SELECT accession, source, status FROM insider_filings").fetchone()
    assert tuple(row) == (aflac, "index", "backfilled")
    assert db.get_state(conn, insiders.STATE_BACKFILL_THROUGH) == "2026-09-11"
    assert db.get_state(conn, insiders.STATE_CURSOR) is None  # independent of the feed


def test_backfill_clears_a_gap_it_covers(conn):
    db.set_state(conn, insiders.STATE_GAP, "2026-09-10..2026-09-11")
    conn.commit()
    sec = Edgar()  # every index 404s: holidays as far as the walker knows
    insiders.backfill_range(conn, _config(), date(2026, 9, 9), date(2026, 9, 12), client=sec.client)
    assert db.get_state(conn, insiders.STATE_GAP) is None


def test_backfill_honours_its_budget_and_says_where_to_resume(conn, caplog):
    index_text = (FIXTURES / "form.20260911.idx").read_text()
    sec = Edgar().index(date(2026, 9, 11), index_text)
    ticks = iter([0.0, 0.0, 0.0, 1000.0])
    result = insiders.backfill_range(conn, _config(), date(2026, 9, 11), date(2026, 9, 11),
                                     client=sec.client, budget_seconds=500, clock=lambda: next(ticks))
    assert result.aborted == "budget"
    assert db.get_state(conn, insiders.STATE_BACKFILL_THROUGH) is None
    assert "resume with --from 2026-09-11" in caplog.text


# --- is a stored filing owed a notification? --------------------------------


def _alert_config(*, rules=True, max_age=7) -> Config:
    from whale.config import _parse_rule

    config = _config(max_filing_age_days=max_age)
    if rules:
        config.insiders.alerts = [_parse_rule({"name": "Any buy", "direction": "buy"}, 0)]
    return config


def test_recent_filing_is_queued_for_notification():
    assert insiders.ingest_status(_alert_config(), "2026-09-11", TODAY) == "parsed"


def test_older_filing_is_stored_as_history():
    # The age gate is what stops a first run replaying days into Telegram.
    assert insiders.ingest_status(_alert_config(), "2026-08-01", TODAY) == "backfilled"


def test_without_rules_nothing_is_queued():
    # Nothing would ever read 'parsed', so queueing would strand the filing.
    assert insiders.ingest_status(_alert_config(rules=False), "2026-09-11", TODAY) == "backfilled"


def test_a_filing_with_no_date_is_history():
    assert insiders.ingest_status(_alert_config(), None, TODAY) == "backfilled"


def test_sync_queues_a_recent_filing_when_rules_exist(conn):
    sec = Edgar().feed(*APPLE_ENTRIES).submission(APPLE_ACCESSION, submission(APPLE_ACCESSION, APPLE_XML))
    config = _alert_config(max_age=7)
    insiders.sync(conn, config, client=sec.client, today=TODAY)
    assert conn.execute("SELECT status FROM insider_filings").fetchone()["status"] == "parsed"


def test_backfill_never_queues_a_notification(conn):
    # A daily-index run may cover today, but history must stay silent.
    index_text = (FIXTURES / "form.20260911.idx").read_text()
    aflac = "0001104659-26-107065"
    sec = (Edgar().index(date(2026, 9, 11), index_text)
           .submission(aflac, submission(aflac, APPLE_XML, filed="20260911",
                                         issuer=("0000004977", "AFLAC INC"))))
    insiders.backfill_range(conn, _alert_config(), date(2026, 9, 11), date(2026, 9, 11),
                            client=sec.client)
    assert conn.execute("SELECT status FROM insider_filings").fetchone()["status"] == "backfilled"
