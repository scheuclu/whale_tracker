"""The age cutoff after the first run (issue #19).

`ingest.max_filing_age_days` stops a first run replaying a year of history
into Telegram. On every later run a filing that is already older than the
cutoff when first seen is one the Clerk published late: it is stored as
history and never announced. That must be logged and counted, so a Clerk
slowdown is visible in the audit instead of indistinguishable from first-run
history — and the watchlist must stay exempt, since a watched member's
filing is never history.
"""

import json
import logging
from datetime import date, timedelta

import pytest

from whale import audit, db, house, pipeline, roster
from whale.config import Config, WatchedMember, WatchlistSettings

TODAY = date(2026, 10, 17)
RECENT = "2026-10-15"   # 2 days: inside any sane cutoff
OLD = "2026-09-20"      # 27 days: outside the 14-day default
PELOSI = WatchedMember(name="Nancy Pelosi", bioguide_id="P000197")


@pytest.fixture
def conn(tmp_path):
    c = db.connect(tmp_path / "t.sqlite3")
    yield c
    c.close()


def _member(conn, bioguide="A000370", name="Mark Alford", last="Alford", district="MO04"):
    state, dist = district[:2], district[2:]
    return db.upsert_politician(conn, bioguide_id=bioguide, full_name=name,
                                first=name.split()[0], last=last, chamber="house",
                                party="R", state=state, district=dist, active=1)


def _entry(doc_id, filing_date, last="Alford", first="Mark", district="MO04", year=2026):
    return house.IndexEntry(doc_id=doc_id, last=last, first=first, suffix="",
                            prefix="", filing_type="P", state_district=district,
                            year=year, filing_date=filing_date)


def _run_sync(conn, config, entries, monkeypatch):
    """pipeline.sync against a canned index, with `today` pinned."""
    monkeypatch.setattr(roster, "sync", lambda c: None)
    monkeypatch.setattr(house, "fetch_index",
                        lambda year: [e for e in entries if e.year == year])
    real_is_recent = house.is_recent
    monkeypatch.setattr(house, "is_recent",
                        lambda d, age, today=None: real_is_recent(d, age, today=TODAY))
    config.senate_enabled = False
    return pipeline.sync(conn, config)


def _statuses(conn):
    return {r["doc_id"]: r["status"] for r in conn.execute(
        "SELECT doc_id, status FROM filings WHERE chamber = 'house'")}


def _counter(conn):
    raw = db.get_state(conn, pipeline.AGE_CUTOFF_STATE)
    return json.loads(raw) if raw else None


# --- counting in sync -------------------------------------------------------


def test_the_first_sight_of_a_year_counts_nothing(conn, monkeypatch, caplog):
    # The whole year is unseen: holding back the old filings is the cutoff
    # doing its job, not the Clerk being slow.
    _member(conn)
    conn.commit()
    with caplog.at_level(logging.WARNING, logger="whale.pipeline"):
        _run_sync(conn, Config(), [_entry("1", OLD), _entry("2", RECENT)], monkeypatch)
    assert _statuses(conn) == {"1": "seen_skipped", "2": "new"}
    assert _counter(conn) is None
    assert "older than" not in caplog.text


def test_a_later_run_counts_and_logs_a_cutoff_hit(conn, monkeypatch, caplog):
    _member(conn)
    conn.commit()
    _run_sync(conn, Config(), [_entry("1", RECENT)], monkeypatch)
    with caplog.at_level(logging.WARNING, logger="whale.pipeline"):
        _run_sync(conn, Config(), [_entry("1", RECENT), _entry("2", OLD)], monkeypatch)

    # Still history — the fix is visibility, not a change in what is sent.
    assert _statuses(conn)["2"] == "seen_skipped"
    state = _counter(conn)
    assert state["count"] == 1
    assert state["last_doc_id"] == "2"
    assert state["last_filing_date"] == OLD
    assert state["last_seen_at"]
    assert "filing 2 (Mark Alford, filed 2026-09-20) is older than 14 days" in caplog.text
    assert "not notified" in caplog.text


def test_the_counter_accumulates_across_runs(conn, monkeypatch):
    _member(conn)
    conn.commit()
    _run_sync(conn, Config(), [_entry("1", RECENT)], monkeypatch)
    _run_sync(conn, Config(), [_entry("1", RECENT), _entry("2", OLD)], monkeypatch)
    _run_sync(conn, Config(),
              [_entry("1", RECENT), _entry("2", OLD), _entry("3", "2026-09-25")],
              monkeypatch)
    state = _counter(conn)
    assert state["count"] == 2
    assert state["last_doc_id"] == "3"
    assert state["last_filing_date"] == "2026-09-25"


def test_a_recent_filing_on_a_later_run_is_not_a_hit(conn, monkeypatch):
    _member(conn)
    conn.commit()
    _run_sync(conn, Config(), [_entry("1", RECENT)], monkeypatch)
    _run_sync(conn, Config(), [_entry("1", RECENT), _entry("2", "2026-10-10")], monkeypatch)
    assert _statuses(conn)["2"] == "new"
    assert _counter(conn) is None


def test_an_already_seen_filing_is_not_counted_again(conn, monkeypatch):
    # Every run re-reads the whole index; a hit must be counted once, on the
    # run that first saw it, not on every run that sees it again.
    _member(conn)
    conn.commit()
    _run_sync(conn, Config(), [_entry("1", RECENT)], monkeypatch)
    _run_sync(conn, Config(), [_entry("1", RECENT), _entry("2", OLD)], monkeypatch)
    _run_sync(conn, Config(), [_entry("1", RECENT), _entry("2", OLD)], monkeypatch)
    assert _counter(conn)["count"] == 1


def test_an_unreadable_counter_does_not_stall_the_ingest(conn, monkeypatch, caplog):
    # The counter describes the ingest; it must never block it. The bad value
    # is left for the audit to report as check_failed rather than overwritten.
    _member(conn)
    conn.commit()
    _run_sync(conn, Config(), [_entry("1", RECENT)], monkeypatch)
    db.set_state(conn, pipeline.AGE_CUTOFF_STATE, "not json")
    conn.commit()
    with caplog.at_level(logging.ERROR, logger="whale.pipeline"):
        _run_sync(conn, Config(), [_entry("1", RECENT), _entry("2", OLD)], monkeypatch)
    assert _statuses(conn)["2"] == "seen_skipped"
    assert db.get_state(conn, pipeline.AGE_CUTOFF_STATE) == "not json"
    assert "could not update sync_state" in caplog.text


def test_a_watched_members_old_filing_is_queued_not_counted(conn, monkeypatch):
    _member(conn)
    _member(conn, bioguide="P000197", name="Nancy Pelosi", last="Pelosi", district="CA11")
    conn.commit()
    config = Config()
    config.watchlist = WatchlistSettings(members=[PELOSI])
    _run_sync(conn, config, [_entry("1", RECENT)], monkeypatch)
    _run_sync(conn, config, [
        _entry("1", RECENT),
        _entry("2", OLD, last="Pelosi", first="Nancy", district="CA11"),
        _entry("3", OLD),
    ], monkeypatch)

    statuses = _statuses(conn)
    # The bypass is the feature: a watched member's filing is never history.
    assert statuses["2"] == "new"
    assert statuses["3"] == "seen_skipped"
    state = _counter(conn)
    assert state["count"] == 1
    assert state["last_doc_id"] == "3"


def test_a_year_newly_added_to_ingest_is_its_own_first_sight(conn, monkeypatch):
    # "First run" is per index year: adding 2025 to ingest.years brings a year
    # of history that is expected to be skipped, and must not read as a week
    # of late Clerk publication.
    _member(conn)
    conn.commit()
    _run_sync(conn, Config(), [_entry("1", RECENT)], monkeypatch)
    config = Config()
    config.ingest.years = [2026, 2025]
    _run_sync(conn, config,
              [_entry("1", RECENT), _entry("2", OLD), _entry("3", "2025-06-01", year=2025)],
              monkeypatch)
    assert _statuses(conn) == {"1": "new", "2": "seen_skipped", "3": "seen_skipped"}
    state = _counter(conn)
    assert state["count"] == 1 and state["last_doc_id"] == "2"


# --- the audit check --------------------------------------------------------


def _counter_state(conn, count=1, seen=TODAY, doc_id="9001", filed=OLD):
    db.set_state(conn, "house_age_cutoff", json.dumps({
        "count": count, "last_doc_id": doc_id, "last_filing_date": filed,
        "last_seen_at": f"{seen.isoformat()}T09:00:00Z",
    }))
    conn.commit()


def test_a_database_that_never_hit_the_cutoff_has_no_finding(conn):
    # The production database has no counter yet; a check that reports on a
    # healthy pipeline every week is itself a defect.
    assert audit.check_house_age_cutoff(conn, TODAY) == []
    assert "house_age_cutoff_hits" not in {f.code for f in audit.run_checks(conn, TODAY)}


def test_a_hit_in_the_last_week_is_a_warning(conn):
    _counter_state(conn, count=2, seen=TODAY - timedelta(days=2))
    found = audit.check_house_age_cutoff(conn, TODAY)
    assert [(f.severity, f.code) for f in found] == [(audit.WARN, "house_age_cutoff_hits")]
    assert found[0].title.startswith("2 House filing(s)")
    assert "2026-10-15" in found[0].title


def test_a_hit_seven_days_ago_still_warns_but_eight_does_not(conn):
    _counter_state(conn, seen=TODAY - timedelta(days=7))
    assert audit.check_house_age_cutoff(conn, TODAY)[0].severity == audit.WARN
    _counter_state(conn, seen=TODAY - timedelta(days=8))
    assert audit.check_house_age_cutoff(conn, TODAY)[0].severity == audit.INFO


def test_an_old_hit_is_informational_and_still_reports_the_counter(conn):
    _counter_state(conn, count=3, seen=TODAY - timedelta(days=40))
    found = audit.check_house_age_cutoff(conn, TODAY)
    assert [(f.severity, f.code) for f in found] == [(audit.INFO, "house_age_cutoff_hits")]
    assert found[0].title.startswith("3 House filing(s)")


def test_the_evidence_names_the_last_filing(conn):
    db.insert_filing(conn, chamber="house", doc_id="9001", politician_id=None,
                     filer_name="Mark Alford", state_district="MO04", filing_type="P",
                     filing_date=OLD, year=2026, pdf_url="http://clerk/9001.pdf",
                     status="seen_skipped")
    _counter_state(conn, doc_id="9001")
    found = audit.check_house_age_cutoff(conn, TODAY)
    assert found[0].evidence == [
        f"last hit: 9001  Mark Alford  filed {OLD}  first seen {TODAY.isoformat()}T09:00:00Z"
        "  http://clerk/9001.pdf"]


def test_a_malformed_counter_is_reported_not_swallowed(conn):
    db.set_state(conn, "house_age_cutoff", "not json")
    conn.commit()
    codes = {f.code for f in audit.run_checks(conn, TODAY)}
    assert "check_failed" in codes and "house_age_cutoff_hits" not in codes


def test_the_check_is_wired_into_the_audit():
    assert audit.check_house_age_cutoff in audit.CHECKS


def test_a_sync_hit_shows_up_in_the_audit_as_a_warning(conn, monkeypatch):
    # End to end: the counter sync writes is the one the audit reads, and a
    # hit stamped with the real clock is "within the last 7 days" of today.
    _member(conn)
    conn.commit()
    _run_sync(conn, Config(), [_entry("1", RECENT)], monkeypatch)
    _run_sync(conn, Config(), [_entry("1", RECENT), _entry("2", OLD)], monkeypatch)
    found = [f for f in audit.run_checks(conn) if f.code == "house_age_cutoff_hits"]
    assert len(found) == 1 and found[0].severity == audit.WARN
    assert "Mark Alford" in found[0].evidence[0]
