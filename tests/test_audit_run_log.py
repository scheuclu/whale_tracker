"""`check_pipeline_runs` reads the run log; the feed-gap remedy names the
automatic repair (#63).

Same discipline as test_audit: the smallest log that trips a finding, and
the near-miss that must not. A check that warns every week on a healthy
pipeline is a defect.
"""

import json
from datetime import date

import pytest

from whale import audit, db

TODAY = date(2026, 10, 18)


@pytest.fixture
def conn(tmp_path):
    c = db.connect(tmp_path / "t.sqlite3")
    yield c
    c.close()


def _run(started, outcome="ok", **over):
    entry = {"started": started, "finished": started, "duration_s": 61.5,
             "filings_parsed": 2, "alerts_sent": 1, "scans_transcribed": 0,
             "insiders_stored": 4, "outcome": outcome, "error": None}
    entry.update(over)
    return entry


def _log(conn, runs):
    db.set_state(conn, "recent_runs", json.dumps(runs))
    conn.commit()


def codes(findings):
    return [f.code for f in findings]


def test_silent_before_the_first_logged_run(conn):
    assert audit.check_pipeline_runs(conn, TODAY) == []
    _log(conn, [])
    assert audit.check_pipeline_runs(conn, TODAY) == []


def test_a_healthy_log_is_one_info_finding_with_a_line_per_run(conn):
    _log(conn, [_run("2026-10-18T07:31:10Z"), _run("2026-10-18T04:17:02Z")])
    (found,) = audit.check_pipeline_runs(conn, TODAY)
    assert found.severity == audit.INFO and found.code == "pipeline_runs"
    assert "2 pipeline run(s) logged, 0 failed" in found.title
    assert len(found.evidence) == 2
    assert found.evidence[0].startswith("2026-10-18T07:31:10Z  61.5s  parsed 2  alerts 1")
    assert found.evidence[0].endswith("ok")


def test_a_failed_run_warns_with_its_error(conn):
    _log(conn, [_run("2026-10-18T07:31:10Z"),
                _run("2026-10-18T04:17:02Z", outcome="failed",
                     error="RuntimeError: telegram down")])
    found = {f.code: f for f in audit.check_pipeline_runs(conn, TODAY)}
    warn = found["pipeline_run_failed"]
    assert warn.severity == audit.WARN
    assert "1 of the last 2" in warn.title
    assert warn.evidence == [
        "2026-10-18T04:17:02Z  61.5s  parsed 2  alerts 1  scans 0  insiders 4  "
        "failed  RuntimeError: telegram down"]
    assert "pipeline_runs_stale" not in found


def test_a_log_whose_newest_run_is_days_old_warns(conn):
    _log(conn, [_run("2026-10-15T07:31:10Z")])
    found = {f.code: f for f in audit.check_pipeline_runs(conn, TODAY)}
    assert found["pipeline_runs_stale"].severity == audit.WARN
    assert "3 days" in found["pipeline_runs_stale"].title


def test_yesterdays_run_is_not_stale(conn):
    # A Sunday-night audit of a Saturday-evening run is a day old: normal.
    _log(conn, [_run("2026-10-17T02:00:00Z")])
    assert codes(audit.check_pipeline_runs(conn, TODAY)) == ["pipeline_runs"]


def test_an_unreadable_log_is_check_failed_not_a_pass(conn):
    db.set_state(conn, "recent_runs", "{not json")
    conn.commit()
    with pytest.raises(ValueError):
        audit.check_pipeline_runs(conn, TODAY)
    assert "check_failed" in codes(audit.run_checks(conn, TODAY))


def test_entries_of_another_shape_are_listed_not_fatal(conn):
    _log(conn, [{"started": "2026-10-18T07:31:10Z"}, "junk"])
    found = {f.code: f for f in audit.check_pipeline_runs(conn, TODAY)}
    assert found["pipeline_runs"].evidence == [
        "2026-10-18T07:31:10Z  ?s  parsed ?  alerts ?  scans ?  insiders ?  ?"]
    # An entry that does not say it succeeded did not: unknown never reads as a pass.
    assert "pipeline_run_failed" in found


def test_the_check_runs_right_after_senate_parse_coverage():
    i = audit.CHECKS.index(audit.check_senate_parse_coverage)
    assert audit.CHECKS[i + 1] is audit.check_pipeline_runs


def test_feed_gap_remedy_names_the_automatic_repair(conn):
    db.set_state(conn, "edgar_status", "ok: feed 0 stored / 3 seen; gap 2026-06-20..2026-07-01 "
                                       "repair out of time (12 stored / 40 seen from the daily "
                                       "index), 2026-06-24..2026-07-01 remains; continuing next run")
    db.set_state(conn, "edgar_gap", "2026-06-24..2026-07-01")
    conn.commit()
    found = {f.code: f for f in audit.check_insider_feed_health(conn, date(2026, 7, 1))}
    gap = found["insider_feed_gap"]
    assert gap.severity == audit.ERROR
    assert "repairs this itself" in gap.detail
    assert "insiders.gap_repair_budget_seconds" in gap.detail
    assert "daily index" in gap.detail
    # The by-hand command stays, for a repair that has stopped narrowing.
    assert gap.evidence == ["python -m whale backfill-insiders --from 2026-06-24 --to 2026-07-01"]
