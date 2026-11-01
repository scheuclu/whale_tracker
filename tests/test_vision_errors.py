"""A failed model call is not a verdict on the scan (`vision_error`).

The Gemini project's prepaid credits ran out on 2026-10-29 (HTTP 402) and
Google dropped connections mid-request on 2026-10-17/18. Every one of those
scans was stored as a plain parse error, which nothing re-queues, so eight
filings stayed unread after the service recovered. Now a failed call is
`vision_error`, retried every run; a key or billing failure stops the run's
other model calls; an unusable reply is a refusal, retried once per
JOIN_VERSION; and the stranded rows are relabelled so they get their retry.
"""

from types import SimpleNamespace

import httpx
import pytest
from google.genai import errors as genai_errors

from whale import audit, db, pipeline, vision
from whale.config import Config
from whale.ptr import ParsedFiling, Transaction
from whale.vision import ScanUnreadable, VisionServiceError

CREDITS = {"error": {"code": 402, "message": "Your prepayment credits are depleted.",
                     "status": "RESOURCE_EXHAUSTED"}}
PARSED = ParsedFiling(filer_name="X", state_district="WI08", transactions=[
    Transaction(asset_name="SCHWAB ETF", action="purchase", amount_raw="$1,001 - $15,000",
                tx_date="2026-10-01", raw_text="(scanned)")])


@pytest.fixture
def conn(tmp_path):
    c = db.connect(tmp_path / "t.sqlite3")
    yield c
    c.close()


def _config(**over):
    c = Config(vision_enabled=True, gemini_api_key="key", vision_budget_seconds=0)
    for k, v in over.items():
        setattr(c, k, v)
    return c


def _filing(conn, doc_id, status="new", method=None, error=None, notified=False):
    pid = db.upsert_politician(conn, bioguide_id=f"X{doc_id[-6:]:0>6}", full_name=f"Member {doc_id}",
                               first="Member", last=doc_id, chamber="house", party="R",
                               state="WI", district="8", active=1)
    fid = db.insert_filing(
        conn, chamber="house", doc_id=doc_id, politician_id=pid, filer_name=f"Member {doc_id}",
        state_district="WI08", filing_type="P", filing_date="2026-10-20", year=2026,
        pdf_url=f"http://x/{doc_id}.pdf", status=status, parse_method=method, last_error=error)
    if notified:
        db.mark_notified(conn, fid)
    conn.commit()
    return fid


def _row(conn, doc_id):
    return conn.execute("SELECT * FROM filings WHERE doc_id = ?", (doc_id,)).fetchone()


# --- classifying the failure ------------------------------------------------


@pytest.mark.parametrize("exc, kind, halts", [
    (genai_errors.ClientError(402, CREDITS), VisionServiceError, True),
    (genai_errors.ClientError(401, {"error": {"message": "API key not valid"}}), VisionServiceError, True),
    (genai_errors.ClientError(404, {"error": {"message": "model not found"}}), VisionServiceError, True),
    (genai_errors.ClientError(429, {"error": {"message": "quota"}}), VisionServiceError, False),
    (genai_errors.ServerError(503, {"error": {"message": "overloaded"}}), VisionServiceError, False),
    (httpx.RemoteProtocolError("Server disconnected without sending a response."), VisionServiceError, False),
    (httpx.ReadTimeout("timed out"), VisionServiceError, False),
    # The service judging this request: repeats on every attempt, so a refusal.
    (genai_errors.ClientError(400, {"error": {"message": "document has no pages"}}), ScanUnreadable, None),
])
def test_a_failed_call_is_classified_by_what_retrying_would_do(exc, kind, halts):
    out = vision.service_error(exc)
    assert isinstance(out, kind)
    if halts is not None:
        assert out.halts_run is halts


def test_a_bug_is_not_a_service_error():
    assert vision.service_error(KeyError("pages")) is None
    assert vision.service_error(ValueError("bad")) is None


def test_the_402_keeps_googles_words():
    out = vision.service_error(genai_errors.ClientError(402, CREDITS))
    assert out.code == 402 and "prepayment credits are depleted" in str(out)


class _FakeClient:
    """Stands in for genai.Client: `outcome` is raised or returned."""
    outcome = None

    def __init__(self, api_key):
        self.models = self

    def generate_content(self, **kwargs):
        _FakeClient.kwargs = kwargs
        if isinstance(self.outcome, BaseException):
            raise self.outcome
        return self.outcome


def _reply(text, finish="STOP"):
    return SimpleNamespace(text=text, candidates=[SimpleNamespace(finish_reason=SimpleNamespace(name=finish))])


def test_transcribe_raises_service_errors_and_refuses_unusable_replies(monkeypatch):
    monkeypatch.setattr("google.genai.Client", _FakeClient)
    _FakeClient.outcome = genai_errors.ClientError(402, CREDITS)
    with pytest.raises(VisionServiceError) as service:
        vision._transcribe(b"pdf", "key")
    assert service.value.halts_run

    # 9116142: the reply broke off mid-row at the output limit.
    _FakeClient.outcome = _reply('{"pages": [{"rows": [{"asset": "A"', finish="MAX_TOKENS")
    with pytest.raises(ScanUnreadable, match="not usable JSON.*MAX_TOKENS"):
        vision._transcribe(b"pdf", "key")
    _FakeClient.outcome = _reply("")
    with pytest.raises(ScanUnreadable, match="empty reply"):
        vision._transcribe(b"pdf", "key")
    _FakeClient.outcome = _reply('```json\n{"pages": []}\n```')
    assert vision._transcribe(b"pdf", "key") == {"pages": []}

    _FakeClient.outcome = RuntimeError("our bug")
    with pytest.raises(RuntimeError):
        vision._transcribe(b"pdf", "key")


def test_parse_bytes_lets_service_errors_through_and_names_bugs(monkeypatch):
    from whale import ptr

    def scanned(_):
        raise ptr.ScannedFilingError("no text layer")

    monkeypatch.setattr(pipeline, "parse_pdf", scanned)

    def down(pdf_bytes, key, timeout=None):
        raise VisionServiceError("402 RESOURCE_EXHAUSTED", 402)

    monkeypatch.setattr(pipeline, "parse_scanned", down)
    with pytest.raises(VisionServiceError):
        pipeline._parse_bytes(b"pdf", _config())

    def bug(pdf_bytes, key, timeout=None):
        raise KeyError("rows")

    monkeypatch.setattr(pipeline, "parse_scanned", bug)
    with pytest.raises(ValueError, match="vision step raised KeyError") as raised:
        pipeline._parse_bytes(b"pdf", _config())
    # Never the old wording: relabel_vision_errors keys on it.
    assert "vision parse failed" not in str(raised.value)


# --- the run ------------------------------------------------------------------


def _scan_queue(conn, monkeypatch, failure):
    """Three scans and a text filing queued; every model call fails with `failure`."""
    for d in ("scan1", "scan2", "scan3", "text1"):
        _filing(conn, d)
    calls = []
    captured = []
    monkeypatch.setattr(pipeline.house, "fetch_pdf", lambda url: url.encode())

    def parse(pdf_bytes, config, allow_vision=True, timeout=None):
        if b"text" in pdf_bytes:
            return PARSED, "text"
        if not allow_vision:
            raise pipeline.VisionDeferred("held")
        calls.append(pdf_bytes)
        raise failure

    monkeypatch.setattr(pipeline, "_parse_bytes", parse)
    monkeypatch.setattr(pipeline, "_capture_scan", lambda conn, f, b, s=None: captured.append(f["doc_id"]))
    return calls, captured


def test_a_billing_failure_stops_the_runs_model_calls_and_the_rest_wait(conn, monkeypatch):
    calls, captured = _scan_queue(conn, monkeypatch, VisionServiceError("402 RESOURCE_EXHAUSTED. credits", 402))
    assert pipeline.parse_pending(conn, _config()) == 1  # the text filing
    assert len(calls) == 1
    first = _row(conn, "scan1")
    assert (first["status"], first["parse_method"]) == ("failed", "vision_error")
    assert first["last_error"].startswith("vision call failed (402")
    assert [_row(conn, d)["status"] for d in ("scan2", "scan3", "text1")] == ["new", "new", "parsed"]
    # Captured for /scans once, since it had no pages.
    assert captured == ["scan1"]


def test_a_dropped_connection_fails_only_that_scan(conn, monkeypatch):
    calls, _ = _scan_queue(conn, monkeypatch, VisionServiceError("connection failed: Server disconnected"))
    pipeline.parse_pending(conn, _config())
    assert len(calls) == 3
    assert {_row(conn, d)["parse_method"] for d in ("scan1", "scan2", "scan3")} == {"vision_error"}


def test_a_scan_already_captured_is_not_captured_again(conn, monkeypatch):
    _, captured = _scan_queue(conn, monkeypatch, VisionServiceError("402", 402))
    monkeypatch.setattr(pipeline.db, "has_scan_pages", lambda conn, fid: True)
    pipeline.parse_pending(conn, _config())
    assert captured == []


def test_a_vision_error_is_retried_every_run_reported_once_and_lands_as_history(conn, monkeypatch):
    fid = _filing(conn, "9116389")
    monkeypatch.setattr(pipeline.house, "fetch_pdf", lambda url: b"pdf")
    monkeypatch.setattr(pipeline, "_capture_scan", lambda *a, **k: None)
    sent = []
    monkeypatch.setattr(pipeline, "_deliver", lambda cfg, text, dry: sent.append(text) or True)
    config = _config(telegram_bot_token="t", telegram_chat_id="c")

    def down(b, c, *a, **k):
        raise VisionServiceError("402 RESOURCE_EXHAUSTED", 402)

    monkeypatch.setattr(pipeline, "_parse_bytes", down)
    pipeline.parse_pending(conn, config)
    pipeline.notify_pending(conn, config)
    assert len(sent) == 1 and "Could not parse" in sent[0]

    # Still down: re-queued on each run (the JOIN_VERSION stamp does not
    # apply), failed again, never announced twice.
    for _ in range(2):
        assert pipeline.retry_scanned(conn, config) == 1
        pipeline.parse_pending(conn, config)
        pipeline.notify_pending(conn, config)
    assert len(sent) == 1
    assert _row(conn, "9116389")["parse_method"] == "vision_error"

    # Credits topped up: read, and history rather than a second message.
    monkeypatch.setattr(pipeline, "_parse_bytes", lambda b, c, *a, **k: (PARSED, "vision"))
    assert pipeline.retry_scanned(conn, config) == 1
    assert pipeline.parse_pending(conn, config) == 1
    row = _row(conn, "9116389")
    assert (row["status"], row["parse_method"]) == ("backfilled", "vision")
    assert len(db.transactions_for_filing(conn, fid)) == 1
    pipeline.notify_pending(conn, config)
    assert len(sent) == 1


def test_vision_errors_wait_while_vision_is_off(conn):
    _filing(conn, "9116389", status="failed", method="vision_error", error="vision call failed (402)")
    assert pipeline.retry_scanned(conn, _config(vision_enabled=False)) == 0
    assert pipeline.retry_scanned(conn, _config(gemini_api_key=None)) == 0
    assert _row(conn, "9116389")["status"] == "failed"


# --- the eight stranded filings -------------------------------------------------


def test_scans_stranded_as_parse_errors_are_relabelled_once_and_retried(conn):
    legacy = {
        "8221322": "parse error: vision parse failed: Server disconnected without sending a response.",
        "9116142": "parse error: vision parse failed: Expecting ',' delimiter: line 3732 column 6 (char 93344)",
        "9116389": "parse error: vision parse failed: 402 RESOURCE_EXHAUSTED. {'error': {'code': 402}}",
    }
    for doc, err in legacy.items():
        _filing(conn, doc, status="failed", method="error", error=err, notified=True)
    # Real parser errors, old and new wording, stay errors.
    _filing(conn, "9000001", status="failed", method="error", error="parse error: no transactions table", notified=True)
    _filing(conn, "9000002", status="failed", method="error",
            error="parse error: vision step raised KeyError: 'rows'", notified=True)

    # Relabelled even while vision is off, so the audit names them.
    assert pipeline.retry_scanned(conn, _config(vision_enabled=False)) == 0
    methods = dict(conn.execute("SELECT doc_id, parse_method FROM filings").fetchall())
    assert {d: methods[d] for d in legacy} == {d: "vision_error" for d in legacy}
    assert methods["9000001"] == methods["9000002"] == "error"
    assert pipeline.relabel_vision_errors(conn) == 0  # idempotent

    assert pipeline.retry_scanned(conn, _config()) == 3
    statuses = dict(conn.execute("SELECT doc_id, status FROM filings").fetchall())
    assert {d: statuses[d] for d in legacy} == {d: "new" for d in legacy}
    assert statuses["9000001"] == statuses["9000002"] == "failed"
    # Already announced as unreadable: whatever happens next is not a second message.
    assert all(_row(conn, d)["notified_at"] for d in legacy)


# --- the audit ----------------------------------------------------------------------


def test_the_audit_warns_while_scans_wait_on_a_failed_call(conn):
    assert audit.check_vision_errors(conn) == []
    _filing(conn, "9116389", status="failed", method="vision_error",
            error="vision call failed (402 RESOURCE_EXHAUSTED. Your prepayment credits are depleted.)")
    _filing(conn, "9116390", status="new", method="vision_error")  # re-queued, held this run
    (finding,) = audit.check_vision_errors(conn)
    assert finding.severity == audit.WARN and finding.code == "vision_errors"
    assert finding.title.startswith("2 scan(s) waiting on a failed vision call")
    assert "prepayment credits are depleted" in finding.title
    assert any("9116390" in e and "re-queued" in e for e in finding.evidence)
    assert audit.check_vision_errors in audit.CHECKS


# --- slow failures and queue order ---------------------------------------------


def test_a_slow_failure_is_marked_slow_but_a_billing_one_never_is():
    slow = vision.service_error(httpx.RemoteProtocolError("Server disconnected"), elapsed=400)
    assert isinstance(slow, VisionServiceError) and slow.slow
    assert not vision.service_error(httpx.RemoteProtocolError("Server disconnected"), elapsed=5).slow
    billing = vision.service_error(genai_errors.ClientError(402, CREDITS), elapsed=400)
    assert billing.halts_run and not billing.slow


def test_a_slow_failure_is_retried_a_day_later_not_every_run(conn, monkeypatch):
    _filing(conn, "8221358")
    monkeypatch.setattr(pipeline.house, "fetch_pdf", lambda url: b"pdf")
    monkeypatch.setattr(pipeline, "_capture_scan", lambda *a, **k: None)

    def dropped(b, c, *a, **k):
        raise VisionServiceError("connection failed: Server disconnected", None, elapsed=412)

    monkeypatch.setattr(pipeline, "_parse_bytes", dropped)
    pipeline.parse_pending(conn, _config())
    row = _row(conn, "8221358")
    assert (row["status"], row["parse_method"]) == ("failed", "vision_error")
    assert row["last_error"].startswith(pipeline.SLOW_VISION_ERROR + "412 s")
    # Not on the next run...
    assert pipeline.retry_scanned(conn, _config()) == 0
    # ...but once the attempt is a day old.
    conn.execute("UPDATE filings SET updated_at = '2026-01-01T00:00:00Z' WHERE doc_id = '8221358'")
    assert pipeline.retry_scanned(conn, _config()) == 1


def test_new_scans_are_read_before_retries_of_failed_calls(conn, monkeypatch):
    _filing(conn, "retry1", status="new", method="vision_error")  # older id, re-queued
    _filing(conn, "fresh1")
    order = []
    monkeypatch.setattr(pipeline.house, "fetch_pdf", lambda url: url.encode())

    def parse(pdf_bytes, config, allow_vision=True, timeout=None):
        if not allow_vision:
            raise pipeline.VisionDeferred("spent")
        order.append(pdf_bytes.decode().rsplit("/", 1)[-1])
        return PARSED, "vision"

    monkeypatch.setattr(pipeline, "_parse_bytes", parse)
    monkeypatch.setattr(pipeline, "_capture_scan", lambda *a, **k: None)
    # Budget for one scan only: the fresh one gets it.
    clock = iter(range(0, 10_000, 500))
    pipeline.parse_pending(conn, _config(vision_budget_seconds=480), clock=lambda: next(clock))
    assert order == ["fresh1.pdf"]
    assert _row(conn, "retry1")["status"] == "new"


# --- the call's timeout -------------------------------------------------------
# 2026-11-01: the first run after the retry landed re-queued the eight, began
# with 8221322 (56 pages), and that call never returned. The budget is checked
# before a call, so the job ran into its 20-minute limit and committed
# nothing, and every later run would have begun with the same call.


def test_transcribe_gives_the_call_its_timeout_and_marks_a_cut_off(monkeypatch):
    monkeypatch.setattr("google.genai.Client", _FakeClient)
    _FakeClient.outcome = _reply('{"pages": []}')
    vision._transcribe(b"pdf", "key", timeout=300)
    assert _FakeClient.kwargs["config"]["http_options"] == {"timeout": 300_000}  # milliseconds
    vision._transcribe(b"pdf", "key")
    assert "http_options" not in _FakeClient.kwargs["config"]

    def clock(*steps):
        ticks = iter(steps)
        monkeypatch.setattr(vision, "time", SimpleNamespace(monotonic=lambda: next(ticks)))

    _FakeClient.outcome = httpx.ReadTimeout("timed out")
    clock(0, 300)
    with pytest.raises(VisionServiceError) as cut:
        vision._transcribe(b"pdf", "key", timeout=300)
    assert cut.value.timed_out and cut.value.slow
    # The server giving up at the deadline we sent it counts the same.
    _FakeClient.outcome = genai_errors.ServerError(504, {"error": {"message": "Deadline expired"}})
    clock(0, 299)
    with pytest.raises(VisionServiceError) as deadline:
        vision._transcribe(b"pdf", "key", timeout=300)
    assert deadline.value.timed_out
    # A connection dropped long before the timeout is a failure of its own.
    _FakeClient.outcome = httpx.RemoteProtocolError("Server disconnected")
    clock(0, 100)
    with pytest.raises(VisionServiceError) as dropped:
        vision._transcribe(b"pdf", "key", timeout=300)
    assert not dropped.value.timed_out and dropped.value.slow


def test_parse_bytes_hands_the_timeout_to_the_model_call(monkeypatch):
    from whale import ptr

    def scanned(_):
        raise ptr.ScannedFilingError("no text layer")

    seen = []
    monkeypatch.setattr(pipeline, "parse_pdf", scanned)
    monkeypatch.setattr(pipeline, "parse_scanned",
                        lambda pdf_bytes, key, timeout=None: seen.append(timeout) or (PARSED, None))
    pipeline._parse_bytes(b"pdf", _config(), timeout=123.0)
    assert seen == [123.0]


def _timed_queue(conn, monkeypatch, durations, failures=()):
    """Scans whose model calls take `durations` seconds of a fake clock, each
    given what the run had left; a doc id in `failures` runs into it."""
    now = [0.0]
    timeouts = {}
    monkeypatch.setattr(pipeline.house, "fetch_pdf", lambda url: url.encode())
    monkeypatch.setattr(pipeline, "_capture_scan", lambda *a, **k: None)

    def parse(pdf_bytes, config, allow_vision=True, timeout=None):
        if not allow_vision:
            raise pipeline.VisionDeferred("spent")
        doc = pdf_bytes.decode().rsplit("/", 1)[-1].removesuffix(".pdf")
        timeouts[doc] = timeout
        wanted = durations[doc]
        if timeout is not None and (doc in failures or wanted > timeout):
            now[0] += timeout
            raise VisionServiceError("connection failed: timed out", None, elapsed=timeout, timed_out=True)
        now[0] += wanted
        return PARSED, "vision"

    monkeypatch.setattr(pipeline, "_parse_bytes", parse)
    return (lambda: now[0]), timeouts


def test_each_call_is_given_only_what_is_left_of_the_budget(conn, monkeypatch):
    for doc in ("scan1", "scan2", "scan3"):
        _filing(conn, doc)
    clock, timeouts = _timed_queue(conn, monkeypatch, {"scan1": 100, "scan2": 330, "scan3": 10})
    pipeline.parse_pending(conn, _config(vision_budget_seconds=480), clock=clock)
    # scan3 would have had 50 s, under the minute a call needs: never started.
    assert timeouts == {"scan1": 480, "scan2": 380}
    assert [_row(conn, d)["status"] for d in ("scan1", "scan2", "scan3")] == ["parsed", "parsed", "new"]
    assert clock() <= 480


def test_a_budget_under_a_minute_still_allows_its_first_call(conn, monkeypatch):
    _filing(conn, "scan1")
    clock, timeouts = _timed_queue(conn, monkeypatch, {"scan1": 10})
    pipeline.parse_pending(conn, _config(vision_budget_seconds=30), clock=clock)
    assert timeouts == {"scan1": 30} and _row(conn, "scan1")["status"] == "parsed"


def test_the_stuck_call_of_2026_11_01_no_longer_takes_the_run_with_it(conn, monkeypatch):
    # The eight as that run found them: re-queued retries, 8221322 first.
    for doc in ("8221322", "8221358"):
        _filing(conn, doc, status="new", method="vision_error", error="vision call failed (…)", notified=True)
    clock, timeouts = _timed_queue(conn, monkeypatch, {"8221322": 1_200, "8221358": 200})
    pipeline.parse_pending(conn, _config(vision_budget_seconds=480), clock=clock)
    assert clock() == 480  # the budget, not the job's limit
    stuck = _row(conn, "8221322")
    # It ran out a whole budget: a slow failure, tried again in a day.
    assert (stuck["status"], stuck["parse_method"]) == ("failed", "vision_error")
    assert stuck["last_error"].startswith(pipeline.SLOW_VISION_ERROR + "480 s")
    assert pipeline.retry_scanned(conn, _config()) == 0
    # The other waits for the next run, which gives it the whole budget.
    assert _row(conn, "8221358")["status"] == "new"
    pipeline.parse_pending(conn, _config(vision_budget_seconds=480), clock=clock)
    assert timeouts["8221358"] == 480
    assert _row(conn, "8221358")["status"] == "backfilled"  # announced as unread before: history now


def test_a_call_cut_off_by_a_part_spent_budget_waits_unreported(conn, monkeypatch):
    for doc in ("scan1", "scan2"):
        _filing(conn, doc)
    clock, timeouts = _timed_queue(conn, monkeypatch, {"scan1": 200, "scan2": 400})
    pipeline.parse_pending(conn, _config(vision_budget_seconds=480), clock=clock)
    assert timeouts["scan2"] == 280
    cut = _row(conn, "scan2")
    # Nothing is known about the scan: still `new`, no label, no message owed
    # for a failure that was only this run running out of time.
    assert (cut["status"], cut["parse_method"], cut["last_error"], cut["notified_at"]) == ("new", None, None, None)
    pipeline.parse_pending(conn, _config(vision_budget_seconds=480), clock=clock)
    assert timeouts["scan2"] == 480
    assert _row(conn, "scan2")["status"] == "parsed"


def test_parse_scanned_reads_the_grid_then_hands_the_timeout_to_the_call(monkeypatch):
    from pathlib import Path

    seen = []

    def stuck(pdf_bytes, key, timeout=None):
        seen.append(timeout)
        raise VisionServiceError("504 DEADLINE_EXCEEDED", 504, elapsed=timeout, timed_out=True)

    monkeypatch.setattr(vision, "_transcribe", stuck)
    pdf = (Path(__file__).parent / "fixtures" / "ptr_scanned_9116308.pdf").read_bytes()
    with pytest.raises(VisionServiceError):
        vision.parse_scanned(pdf, "key", timeout=77.0)
    assert seen == [77.0]
