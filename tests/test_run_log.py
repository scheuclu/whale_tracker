"""The run log `pipeline.run` keeps in `sync_state.recent_runs` (#63).

Every run, including one that raised, leaves one entry — when it started,
how long it took, what it parsed, sent and stored, and how it ended —
newest first, twenty at most. The Pipeline page lists it and the audit
reads it. The steps are stubbed here: this is about the log, not about
syncing.
"""

import itertools
import json
import logging

import pytest

from whale import db, insiders, pipeline
from whale.config import Config
from whale.ptr import ParsedFiling, Transaction


@pytest.fixture
def config(tmp_path):
    return Config(db_path=tmp_path / "t.sqlite3")


@pytest.fixture
def steps(monkeypatch):
    """Stub every step of `run`; each records that it ran and returns a count."""
    calls = []

    def step(name, value=0):
        def f(conn, config, **kw):
            calls.append(name)
            return value
        return f

    monkeypatch.setattr(pipeline, "sync", step("sync", 2))
    monkeypatch.setattr(pipeline, "retry_scanned", step("retry", 0))
    monkeypatch.setattr(pipeline, "parse_pending", step("parse", 3))
    monkeypatch.setattr(pipeline, "notify_pending", step("notify", 1))
    monkeypatch.setattr(pipeline, "notify_clusters", step("clusters", 1))
    monkeypatch.setattr(pipeline, "_sync_insiders", step("insiders", 7))
    monkeypatch.setattr(pipeline, "notify_insiders", step("notify_insiders", 2))
    return calls


def _runs(config):
    conn = db.connect(config.db_path)
    try:
        return pipeline.recent_runs(conn)
    finally:
        conn.close()


def test_a_run_is_logged_with_what_it_did(config, steps):
    pipeline.run(config)
    (entry,) = _runs(config)
    assert entry["outcome"] == "ok" and entry["error"] is None
    assert entry["filings_parsed"] == 3
    assert entry["alerts_sent"] == 1 + 1 + 2  # filings, clusters, insiders
    assert entry["insiders_stored"] == 7
    assert entry["scans_transcribed"] == 0
    assert entry["started"].endswith("Z") and entry["finished"] >= entry["started"]
    assert isinstance(entry["duration_s"], float) and entry["duration_s"] >= 0


def test_a_failing_step_is_logged_and_still_raises(config, steps, monkeypatch):
    def boom(conn, config, **kw):
        raise RuntimeError("telegram down")
    monkeypatch.setattr(pipeline, "notify_clusters", boom)

    with pytest.raises(RuntimeError, match="telegram down"):
        pipeline.run(config)

    (entry,) = _runs(config)
    assert entry["outcome"] == "failed"
    assert entry["error"] == "RuntimeError: telegram down"
    # What it managed before it broke is kept; the steps after it did not run.
    assert entry["filings_parsed"] == 3 and entry["alerts_sent"] == 1
    assert "insiders" not in steps


def test_the_log_keeps_the_newest_twenty_newest_first(config, steps, monkeypatch):
    parsed = itertools.count(1)
    monkeypatch.setattr(pipeline, "parse_pending",
                        lambda conn, config, **kw: next(parsed))
    for _ in range(pipeline.RUN_LOG_SIZE + 2):
        pipeline.run(config)
    runs = _runs(config)
    assert len(runs) == pipeline.RUN_LOG_SIZE == 20
    assert [r["filings_parsed"] for r in runs] == list(range(22, 2, -1))


def test_a_dry_run_leaves_no_entry(config, steps):
    pipeline.run(config, dry_run=True)
    assert _runs(config) == []
    assert "notify_insiders" in steps  # the preview itself still ran


@pytest.mark.parametrize("stale", ["{not json", '{"a": 1}', "[1, 2]"])
def test_a_log_that_cannot_be_read_is_replaced_not_fatal(config, steps, stale, caplog):
    conn = db.connect(config.db_path)
    db.set_state(conn, pipeline.RUN_LOG_STATE, stale)
    conn.commit()
    conn.close()
    with caplog.at_level(logging.WARNING, logger="whale.pipeline"):
        pipeline.run(config)
    (entry,) = _runs(config)
    assert entry["outcome"] == "ok"


def test_a_failing_steps_uncommitted_work_is_not_committed_with_the_entry(
        config, steps, monkeypatch):
    def half_done(conn, config, **kw):
        db.insert_filing(conn, chamber="house", doc_id="D1", politician_id=None,
                         filer_name="X", state_district="CA01", filing_type="P",
                         filing_date="2026-10-01", year=2026, pdf_url="http://x/1.pdf")
        raise RuntimeError("mid-unit")  # no commit: the unit never finished
    monkeypatch.setattr(pipeline, "parse_pending", half_done)

    with pytest.raises(RuntimeError):
        pipeline.run(config)

    conn = db.connect(config.db_path)
    try:
        assert conn.execute("SELECT COUNT(*) FROM filings").fetchone()[0] == 0
        assert pipeline.recent_runs(conn)[0]["outcome"] == "failed"
    finally:
        conn.close()


def test_a_log_write_that_fails_does_not_fail_the_run(config, steps, monkeypatch, caplog):
    def refuse(conn, key, value):
        raise RuntimeError("disk full")
    monkeypatch.setattr(db, "set_state", refuse)
    with caplog.at_level(logging.ERROR, logger="whale.pipeline"):
        pipeline.run(config)  # must not raise
    assert "could not record the run" in caplog.text
    assert _runs(config) == []


def test_the_entry_measures_duration_on_the_clock_it_is_given():
    clock = itertools.count(100, 7)
    tally = pipeline.RunTally(clock=lambda: next(clock))
    entry = tally.entry()
    assert entry["duration_s"] == 7.0
    assert entry["outcome"] == "failed"  # until `run` says otherwise
    assert json.dumps(entry)  # serialisable as written


# --- what the steps feed the tally ----------------------------------------

PARSED = ParsedFiling(filer_name="X", state_district="CA01", transactions=[
    Transaction(asset_name="A", action="purchase", amount_raw="$1,001 - $15,000",
                tx_date="2026-09-01")])


def _filing(conn, doc_id):
    return db.insert_filing(
        conn, chamber="house", doc_id=doc_id, politician_id=None, filer_name="X",
        state_district="CA01", filing_type="P", filing_date="2026-10-01", year=2026,
        pdf_url=f"http://x/{doc_id}.pdf", status="new")


def test_parse_pending_counts_the_scans_it_transcribed(tmp_path, monkeypatch):
    conn = db.connect(tmp_path / "t.sqlite3")
    for doc in ("scan1", "scan2", "text1"):
        _filing(conn, doc)
    conn.commit()
    monkeypatch.setattr(pipeline.house, "fetch_pdf", lambda url: url.encode())
    monkeypatch.setattr(
        pipeline, "_parse_bytes",
        lambda pdf, config, allow_vision=True: (PARSED, "text" if b"text" in pdf else "vision"))

    tally = pipeline.RunTally()
    done = pipeline.parse_pending(
        conn, Config(vision_enabled=True, gemini_api_key="k"), tally=tally)
    assert done == 3  # every filing parsed...
    assert tally.scans_transcribed == 2  # ...two of them by the model
    # Without a tally (backfill, tests) nothing changes.
    for doc in ("scan3",):
        _filing(conn, doc)
    conn.commit()
    assert pipeline.parse_pending(conn, Config(vision_enabled=True, gemini_api_key="k")) == 1


def _insider_config():
    config = Config(edgar_user_agent="whale test@example.com")
    config.insiders.enabled = True
    return config


def test_sync_insiders_reports_feed_and_repair_together(tmp_path, monkeypatch):
    conn = db.connect(tmp_path / "t.sqlite3")
    monkeypatch.setattr(insiders, "sync",
                        lambda conn, config, **kw: insiders.SyncResult(seen=9, stored=3))
    monkeypatch.setattr(insiders, "repair_gap",
                        lambda conn, config, feed, **kw: insiders.SyncResult(seen=4, stored=2))
    assert pipeline._sync_insiders(conn, _insider_config()) == 5

    monkeypatch.setattr(insiders, "repair_gap", lambda conn, config, feed, **kw: None)
    assert pipeline._sync_insiders(conn, _insider_config()) == 3


def test_sync_insiders_reports_what_an_aborted_feed_stored(tmp_path, monkeypatch):
    conn = db.connect(tmp_path / "t.sqlite3")
    monkeypatch.setattr(
        insiders, "sync",
        lambda conn, config, **kw: insiders.SyncResult(seen=9, stored=1, aborted="throttled"))
    repaired = []
    monkeypatch.setattr(insiders, "repair_gap",
                        lambda *a, **kw: repaired.append(1))
    assert pipeline._sync_insiders(conn, _insider_config()) == 1
    assert not repaired  # a throttled feed is no moment to ask EDGAR for more


def test_sync_insiders_reports_zero_when_off_or_broken(tmp_path, monkeypatch):
    conn = db.connect(tmp_path / "t.sqlite3")
    off = _insider_config()
    off.insiders.enabled = False
    assert pipeline._sync_insiders(conn, off) == 0

    def boom(conn, config, **kw):
        raise RuntimeError("unexpected")
    monkeypatch.setattr(insiders, "sync", boom)
    assert pipeline._sync_insiders(conn, _insider_config()) == 0
    assert db.get_state(conn, insiders.STATE_STATUS).startswith("error:")
