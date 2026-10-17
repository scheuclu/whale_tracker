"""A recorded EDGAR feed gap is repaired by the poll run itself (#18).

`pipeline._sync_insiders` reads the live feed first and then, when
`sync_state.edgar_gap` is set, walks the daily index for that range inside
`insiders.gap_repair_budget_seconds`. The gap narrows to the days still
unwalked and clears only once its last day has been walked to the end; a
day EDGAR may still be writing waits for a later run.

Same scripted EDGAR as test_insiders: the live feed carries Apple's filing,
the daily index for Friday 2026-09-11 carries AFLAC's.
"""

from datetime import date, timedelta

import httpx
import pytest

from whale import db, edgar, insiders, pipeline
from whale.config import DEFAULT_CONFIG_FILE, Config, ConfigError, _parse_rule, load_config

from form4_samples import APPLE_ACCESSION, APPLE_XML, submission
from test_insiders import APPLE_ENTRIES, FIXTURES, HYPERSCALE, HYPERSCALE_ACC, Edgar, _config

INDEX_DAY = date(2026, 9, 11)
INDEX_TEXT = (FIXTURES / "form.20260911.idx").read_text()
AFLAC = "0001104659-26-107065"  # a Form 4 row in the fixture index
GAP = "2026-09-10..2026-09-11"
TODAY = date(2026, 9, 25)  # two weeks after the gap: everything in it is history
APPLE_CURSOR = "2026-09-10T22:30:31Z"  # where the live feed leaves the cursor


@pytest.fixture
def conn(tmp_path):
    c = db.connect(tmp_path / "t.sqlite3")
    yield c
    c.close()


class _Edgar(Edgar):
    """The scripted EDGAR, plus a daily index that can misbehave."""

    def __init__(self):
        super().__init__()
        self.index_faults: dict[str, object] = {}

    def index_fault(self, day: date, fault):
        """Serve `fault` for the day's index: an httpx.Response, or an exception to raise."""
        self.index_faults[edgar.daily_index_url(day)] = fault
        return self

    def _handle(self, request):
        fault = self.index_faults.get(str(request.url))
        if isinstance(fault, Exception):
            raise fault
        if fault is not None:
            return fault
        return super()._handle(request)


def _sec() -> _Edgar:
    return (_Edgar().feed(*APPLE_ENTRIES)
            .submission(APPLE_ACCESSION, submission(APPLE_ACCESSION, APPLE_XML))
            .index(INDEX_DAY, INDEX_TEXT)
            .submission(AFLAC, submission(AFLAC, APPLE_XML, filed="20260911",
                                          issuer=("0000004977", "AFLAC INC")))
            .submission(HYPERSCALE_ACC, HYPERSCALE))


def _with_rules(config: Config) -> Config:
    config.insiders.alerts = [_parse_rule({"name": "Any buy", "direction": "buy"}, 0)]
    return config


def _set_gap(conn, gap: str) -> None:
    db.set_state(conn, insiders.STATE_GAP, gap)
    conn.commit()


def _index_days(sec: Edgar) -> list[str]:
    return [u for u in sec.requests if "daily-index" in u]


def _filings(conn) -> list[tuple]:
    rows = conn.execute(
        "SELECT accession, source, status FROM insider_filings ORDER BY accession").fetchall()
    return [tuple(r) for r in rows]


# --- the poll run ------------------------------------------------------------


def test_poll_run_repairs_the_gap_after_the_live_feed_and_stores_history(conn):
    _set_gap(conn, GAP)
    sec = _sec()

    pipeline._sync_insiders(conn, _with_rules(_config()), client=sec.client, today=TODAY)

    assert db.get_state(conn, insiders.STATE_GAP) is None
    # Old enough to be history even with rules configured: no alert is owed.
    assert _filings(conn) == [(AFLAC, "index", "backfilled"), (APPLE_ACCESSION, "feed", "backfilled")]
    assert _index_days(sec) == [edgar.daily_index_url(date(2026, 9, 10)),
                                edgar.daily_index_url(INDEX_DAY)]
    # The live feed is read before the index is touched.
    assert sec.requests.index(edgar.FEED_URL.format(start=0)) < sec.requests.index(_index_days(sec)[0])
    assert db.get_state(conn, insiders.STATE_STATUS) == (
        "ok: feed 1 stored / 1 seen; gap 2026-09-10..2026-09-11 repaired "
        "(1 stored / 12 seen from the daily index)")
    assert db.get_state(conn, insiders.STATE_CURSOR) == APPLE_CURSOR  # the feed's, untouched by the walk


@pytest.mark.parametrize("rules, status", [(True, "parsed"), (False, "backfilled")])
def test_recovered_filings_pass_through_the_feed_age_gate(conn, rules, status):
    # A gap repaired within max_filing_age_days still owes the alerts the lost
    # run would have sent; without rules nothing is ever owed.
    _set_gap(conn, GAP)
    config = _with_rules(_config()) if rules else _config()
    pipeline._sync_insiders(conn, config, client=_sec().client, today=date(2026, 9, 13))
    assert _filings(conn) == [(AFLAC, "index", status), (APPLE_ACCESSION, "feed", status)]
    assert db.get_state(conn, insiders.STATE_GAP) is None


def test_without_a_gap_the_daily_index_is_never_fetched(conn):
    sec = _sec()
    pipeline._sync_insiders(conn, _config(), client=sec.client, today=TODAY)
    assert _index_days(sec) == []
    assert db.get_state(conn, insiders.STATE_GAP) is None
    assert db.get_state(conn, insiders.STATE_STATUS) == "ok: 1 stored / 1 seen"


def test_a_repair_failure_is_recorded_and_never_raised(conn):
    _set_gap(conn, GAP)
    sec = _sec().index_fault(date(2026, 9, 10), RuntimeError("boom"))

    pipeline._sync_insiders(conn, _config(), client=sec.client, today=TODAY)

    assert db.get_state(conn, insiders.STATE_GAP) == GAP
    assert db.get_state(conn, insiders.STATE_STATUS) == (
        "error: gap 2026-09-10..2026-09-11 repair failed: boom; feed 1 stored / 1 seen")
    assert db.get_state(conn, insiders.STATE_CURSOR) == APPLE_CURSOR  # the feed's work stands
    assert _filings(conn) == [(APPLE_ACCESSION, "feed", "backfilled")]


def test_a_throttled_repair_keeps_the_gap_and_says_so(conn):
    _set_gap(conn, GAP)
    blocked = httpx.Response(403, text="Request Rate Threshold Exceeded",
                             headers={"content-type": "text/html"})
    sec = _sec().index_fault(date(2026, 9, 10), blocked)

    pipeline._sync_insiders(conn, _config(), client=sec.client, today=TODAY)

    assert db.get_state(conn, insiders.STATE_GAP) == GAP
    status = db.get_state(conn, insiders.STATE_STATUS)
    assert status.startswith("throttled: HTTP 403")
    assert status.endswith("gap 2026-09-10..2026-09-11 repair stopped (0 stored / 0 seen from "
                           "the daily index), 2026-09-10..2026-09-11 remains; feed 1 stored / 1 seen")


def test_no_repair_when_the_live_feed_was_cut_short(conn):
    # A throttled sync is no moment to ask EDGAR for the index as well.
    _set_gap(conn, GAP)
    blocked = httpx.Response(403, text="Request Rate Threshold Exceeded",
                             headers={"content-type": "text/html"})
    sec = _Edgar().feed(*APPLE_ENTRIES).fail(APPLE_ACCESSION, blocked).index(INDEX_DAY, INDEX_TEXT)

    pipeline._sync_insiders(conn, _config(), client=sec.client, today=TODAY)

    assert _index_days(sec) == []
    assert db.get_state(conn, insiders.STATE_GAP) == GAP
    assert db.get_state(conn, insiders.STATE_STATUS).startswith("throttled:")


def test_a_zero_budget_switches_the_automatic_repair_off(conn):
    _set_gap(conn, GAP)
    sec = _sec()
    pipeline._sync_insiders(conn, _config(gap_repair_budget_seconds=0), client=sec.client, today=TODAY)
    assert _index_days(sec) == []
    assert db.get_state(conn, insiders.STATE_GAP) == GAP
    assert db.get_state(conn, insiders.STATE_STATUS) == "ok: 1 stored / 1 seen"


def test_without_a_user_agent_nothing_is_attempted(conn):
    _set_gap(conn, GAP)
    sec = _sec()
    pipeline._sync_insiders(conn, Config(edgar_user_agent=None), client=sec.client, today=TODAY)
    assert sec.requests == []
    assert db.get_state(conn, insiders.STATE_GAP) == GAP
    assert db.get_state(conn, insiders.STATE_STATUS) == "skipped: EDGAR_USER_AGENT not set"


# --- budget: narrow, never clear early --------------------------------------


def test_out_of_budget_narrows_the_gap_to_the_days_still_unwalked(conn):
    _set_gap(conn, "2026-09-09..2026-09-11")
    sec = _sec()
    feed = insiders.SyncResult(stored=1, seen=1)
    # started; the 9th, 10th (no index: holidays) and 11th begin in time; the
    # 11th's first filing finds the budget gone.
    ticks = iter([0.0, 0.0, 0.0, 0.0, 1000.0])

    result = insiders.repair_gap(conn, _config(), feed, client=sec.client, today=TODAY,
                                 budget_seconds=500, clock=lambda: next(ticks))

    assert result.aborted == "budget"
    assert db.get_state(conn, insiders.STATE_GAP) == "2026-09-11..2026-09-11"
    assert db.get_state(conn, insiders.STATE_STATUS) == (
        "ok: feed 1 stored / 1 seen; gap 2026-09-09..2026-09-11 repair out of time "
        "(0 stored / 0 seen from the daily index), 2026-09-11..2026-09-11 remains; "
        "continuing next run")
    assert _filings(conn) == []

    # The next poll run picks up exactly where this one stopped.
    sec = _sec()
    pipeline._sync_insiders(conn, _config(), client=sec.client, today=TODAY)
    assert _index_days(sec) == [edgar.daily_index_url(INDEX_DAY)]
    assert db.get_state(conn, insiders.STATE_GAP) is None
    assert (AFLAC, "index", "backfilled") in _filings(conn)


def test_a_gap_is_kept_whole_when_no_day_was_walked_to_the_end(conn):
    _set_gap(conn, "2026-09-09..2026-09-11")
    ticks = iter([0.0, 1000.0])  # over budget before the first day begins
    result = insiders.repair_gap(conn, _config(), insiders.SyncResult(), client=_sec().client,
                                 today=TODAY, budget_seconds=500, clock=lambda: next(ticks))
    assert result.aborted == "budget"
    assert db.get_state(conn, insiders.STATE_GAP) == "2026-09-09..2026-09-11"
    assert "2026-09-09..2026-09-11 remains; continuing next run" in db.get_state(conn, insiders.STATE_STATUS)


# --- a day EDGAR may still be writing waits --------------------------------


def test_the_newest_two_days_of_a_gap_wait_for_their_index_to_close(conn):
    today = date(2026, 9, 13)
    db.set_state(conn, insiders.STATE_CURSOR, "2026-09-09T00:00:00Z")
    conn.commit()
    sec = _sec()  # Apple's entry is newer than the cursor and the feed ends there: a gap

    pipeline._sync_insiders(conn, _config(), client=sec.client, today=today)

    # Recorded as cursor-day..today, walked through today - 2.
    assert _index_days(sec) == [edgar.daily_index_url(date(2026, 9, 9)),
                                edgar.daily_index_url(date(2026, 9, 10)),
                                edgar.daily_index_url(INDEX_DAY)]
    assert db.get_state(conn, insiders.STATE_GAP) == "2026-09-12..2026-09-13"
    assert db.get_state(conn, insiders.STATE_STATUS) == (
        "ok: feed 1 stored / 1 seen; gap 2026-09-09..2026-09-13 repaired through 2026-09-11 "
        "(1 stored / 12 seen from the daily index); 2026-09-12..2026-09-13 waits for EDGAR "
        "to close its daily index")

    # The day after, the 12th is final (a Saturday: skipped without a request), the 13th not yet.
    sec = _sec()
    pipeline._sync_insiders(conn, _config(), client=sec.client, today=today + timedelta(days=1))
    assert _index_days(sec) == []
    assert db.get_state(conn, insiders.STATE_GAP) == "2026-09-13..2026-09-13"
    assert db.get_state(conn, insiders.STATE_STATUS) == (
        "ok: feed 0 stored / 1 seen; gap 2026-09-12..2026-09-13 repaired through 2026-09-12 "
        "(0 stored / 0 seen from the daily index); 2026-09-13..2026-09-13 waits for EDGAR "
        "to close its daily index")

    # A second run that same day finds nothing final: no index is asked for, nothing changes.
    sec = _sec()
    pipeline._sync_insiders(conn, _config(), client=sec.client, today=today + timedelta(days=1))
    assert _index_days(sec) == []
    assert db.get_state(conn, insiders.STATE_GAP) == "2026-09-13..2026-09-13"
    assert db.get_state(conn, insiders.STATE_STATUS) == (
        "ok: feed 0 stored / 1 seen; gap 2026-09-13..2026-09-13 waits for EDGAR to close its "
        "daily index; repair resumes 2026-09-15")

    pipeline._sync_insiders(conn, _config(), client=_sec().client, today=today + timedelta(days=2))
    assert db.get_state(conn, insiders.STATE_GAP) is None
    assert db.get_state(conn, insiders.STATE_STATUS) == (
        "ok: feed 0 stored / 1 seen; gap 2026-09-13..2026-09-13 repaired "
        "(0 stored / 0 seen from the daily index)")


# --- the manual command shares the narrowing ---------------------------------


def test_backfill_narrows_a_gap_it_only_partly_covers(conn):
    _set_gap(conn, "2026-09-09..2026-09-11")
    insiders.backfill_range(conn, _config(), date(2026, 9, 9), date(2026, 9, 10), client=_sec().client)
    assert db.get_state(conn, insiders.STATE_GAP) == "2026-09-11..2026-09-11"


def test_backfill_that_skips_the_gap_start_leaves_it_alone(conn):
    _set_gap(conn, "2026-09-09..2026-09-11")
    insiders.backfill_range(conn, _config(), date(2026, 9, 10), date(2026, 9, 11), client=_sec().client)
    assert db.get_state(conn, insiders.STATE_GAP) == "2026-09-09..2026-09-11"


def test_the_manual_backfill_still_stores_history_whatever_the_age(conn):
    insiders.backfill_range(conn, _with_rules(_config()), INDEX_DAY, INDEX_DAY,
                            client=_sec().client, today=date(2026, 9, 13))
    assert _filings(conn) == [(AFLAC, "index", "backfilled")]


# --- config ------------------------------------------------------------------


def test_gap_repair_budget_is_loaded_and_validated(tmp_path):
    assert load_config(tmp_path / "absent.yaml").insiders.gap_repair_budget_seconds == 480
    assert load_config(DEFAULT_CONFIG_FILE).insiders.gap_repair_budget_seconds == 480

    f = tmp_path / "c.yaml"
    f.write_text("insiders:\n  gap_repair_budget_seconds: 120\n")
    assert load_config(f).insiders.gap_repair_budget_seconds == 120
    f.write_text("insiders:\n  gap_repair_budget_seconds: 0\n")
    assert load_config(f).insiders.gap_repair_budget_seconds == 0

    for bad in ("-1", "lots"):
        f.write_text(f"insiders:\n  gap_repair_budget_seconds: {bad}\n")
        with pytest.raises(ConfigError, match="gap_repair_budget_seconds"):
            load_config(f)
