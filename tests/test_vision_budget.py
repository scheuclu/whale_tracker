"""Model time per poll run is metered (vision.budget_seconds).

The first run with vision on had 53 scans queued, spent the job's whole
20-minute timeout on Gemini calls and was killed before the commit step, so
nothing it read was kept — and every scheduled run after it would have done
the same. Scans past the budget now stay queued for the next run, and the
model's reply is read as JSON even when it arrives fenced.
"""

import itertools
from pathlib import Path

import pytest

from whale import db, pipeline, vision
from whale.config import DEFAULT_CONFIG_FILE, Config, ConfigError, load_config
from whale.ptr import ParsedFiling, Transaction

PARSED = ParsedFiling(filer_name="X", state_district="CA01", transactions=[
    Transaction(asset_name="A", action="purchase", amount_raw="$1,001 - $15,000",
                tx_date="2026-09-01")])


def _filing(conn, doc_id):
    return db.insert_filing(
        conn, chamber="house", doc_id=doc_id, politician_id=None, filer_name="X",
        state_district="CA01", filing_type="P", filing_date="2026-10-01", year=2026,
        pdf_url=f"http://x/{doc_id}.pdf", status="new")


def _fake_parse(pdf_bytes, config, allow_vision=True):
    if b"text" in pdf_bytes:
        return PARSED, "text"
    if not allow_vision:
        raise pipeline.VisionDeferred("spent")
    return PARSED, "vision"


@pytest.fixture
def queue(tmp_path, monkeypatch):
    conn = db.connect(tmp_path / "t.sqlite3")
    ids = {d: _filing(conn, d) for d in ("scan1", "scan2", "scan3", "text1")}
    conn.commit()
    monkeypatch.setattr(pipeline.house, "fetch_pdf", lambda url: url.encode())
    monkeypatch.setattr(pipeline, "_parse_bytes", _fake_parse)
    return conn, ids


def _statuses(conn, ids):
    return {d: conn.execute("SELECT status FROM filings WHERE id = ?", (i,)).fetchone()[0]
            for d, i in ids.items()}


def test_scans_past_the_budget_stay_queued_and_text_filings_still_parse(queue):
    conn, ids = queue
    # Every clock() call advances 250 s, so one parsed scan costs 250 s of budget.
    clock = itertools.count(0, 250)
    done = pipeline.parse_pending(
        conn, Config(vision_enabled=True, gemini_api_key="k", vision_budget_seconds=480),
        clock=lambda: next(clock))
    assert done == 3
    assert _statuses(conn, ids) == {"scan1": "parsed", "scan2": "parsed",
                                    "scan3": "new", "text1": "parsed"}


def test_the_next_run_picks_up_the_leftover(queue):
    conn, ids = queue
    clock = itertools.count(0, 250)
    cfg = Config(vision_enabled=True, gemini_api_key="k", vision_budget_seconds=480)
    pipeline.parse_pending(conn, cfg, clock=lambda: next(clock))
    pipeline.parse_pending(conn, cfg, clock=lambda: next(clock))
    assert _statuses(conn, ids)["scan3"] == "parsed"


def test_zero_budget_means_no_limit(queue):
    conn, ids = queue
    clock = itertools.count(0, 10_000)
    pipeline.parse_pending(
        conn, Config(vision_enabled=True, gemini_api_key="k", vision_budget_seconds=0),
        clock=lambda: next(clock))
    assert set(_statuses(conn, ids).values()) == {"parsed"}


SCAN = Path(__file__).parent / "fixtures" / "ptr_scanned_9116308.pdf"


def test_real_parse_path_answers_unavailable_before_deferred():
    # Vision off: the scan is "unavailable" whatever the budget says.
    with pytest.raises(pipeline.VisionUnavailable):
        pipeline._parse_bytes(SCAN.read_bytes(), Config(vision_enabled=False), allow_vision=False)
    # Vision on but no model time left: deferred, and no key is needed because
    # the model is never called.
    with pytest.raises(pipeline.VisionDeferred):
        pipeline._parse_bytes(SCAN.read_bytes(), Config(vision_enabled=True, gemini_api_key="k"),
                              allow_vision=False)


def test_budget_is_loaded_and_validated(tmp_path):
    assert load_config(tmp_path / "absent.yaml").vision_budget_seconds == 480
    assert load_config(DEFAULT_CONFIG_FILE).vision_budget_seconds == 480
    f = tmp_path / "c.yaml"
    f.write_text("vision:\n  enabled: true\n  budget_seconds: 90\n")
    assert load_config(f).vision_budget_seconds == 90
    f.write_text("vision:\n  budget_seconds: -1\n")
    with pytest.raises(ConfigError):
        load_config(f)
    f.write_text("vision:\n  budget_seconds: soon\n")
    with pytest.raises(ConfigError):
        load_config(f)


def test_fenced_or_wrapped_json_is_read():
    assert vision.json_object('```json\n{"a": 1}\n```') == {"a": 1}
    assert vision.json_object('Here you go: {"a": [1, 2]} hope that helps') == {"a": [1, 2]}
    assert vision.json_object('{"a": 1}') == {"a": 1}


def test_a_reply_with_no_object_is_an_error():
    with pytest.raises(ValueError):
        vision.json_object("I could not read this page.")
