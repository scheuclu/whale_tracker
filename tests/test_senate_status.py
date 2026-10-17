"""Senate status vocabulary (#16).

GitHub Actions passes an unset secret as "", so `SENATE_PROXY_URL=""` reached
httpx as a proxy URL and raised before any request was made. The audit then
filed that under the known Akamai block, and an unknown read as the expected
outcome. Three layers, tested separately: the loader, the status `senate.py`
records, and the audit's reading of it.
"""

import httpx
import pytest

from whale import audit, db, pipeline, senate
from whale.config import Config, load_config

# Verbatim from production `sync_state.senate_status`, as recorded before this
# fix on every scheduled run.
PRODUCTION_STATUS = "error: Unknown scheme for proxy URL URL('')"

SECRETS = {
    "SENATE_PROXY_URL": "senate_proxy_url",
    "GEMINI_API_KEY": "gemini_api_key",
    "EDGAR_USER_AGENT": "edgar_user_agent",
    "TELEGRAM_BOT_TOKEN": "telegram_bot_token",
    "TELEGRAM_CHAT_ID": "telegram_chat_id",
}

AGREEMENT_PAGE = (
    '<form method="post"><input type="hidden" name="csrfmiddlewaretoken" value="tok">'
    '<input type="checkbox" name="prohibition_agreement"></form>'
)


@pytest.fixture
def conn(tmp_path):
    c = db.connect(tmp_path / "t.sqlite3")
    yield c
    c.close()


def _load(tmp_path):
    return load_config(config_file=tmp_path / "absent.yaml", db_path=tmp_path / "t.sqlite3")


def _raising(exc):
    def fetch(*args, **kwargs):
        raise exc
    return fetch


def _transport(handler):
    """Replace `senate._client` with one that never leaves the process."""
    def client(proxy_url):
        return httpx.Client(base_url=senate.BASE, transport=httpx.MockTransport(handler))
    return client


# --- config: an empty environment value is unset ----------------------------


@pytest.mark.parametrize("name", sorted(SECRETS))
def test_empty_env_secret_is_unset(tmp_path, monkeypatch, name):
    monkeypatch.setenv(name, "")
    assert getattr(_load(tmp_path), SECRETS[name]) is None


@pytest.mark.parametrize("name", sorted(SECRETS))
def test_whitespace_env_secret_is_unset(tmp_path, monkeypatch, name):
    monkeypatch.setenv(name, "  \n")
    assert getattr(_load(tmp_path), SECRETS[name]) is None


@pytest.mark.parametrize("name", sorted(SECRETS))
def test_set_env_secret_is_kept(tmp_path, monkeypatch, name):
    monkeypatch.setenv(name, "value-1")
    assert getattr(_load(tmp_path), SECRETS[name]) == "value-1"


def test_absent_env_secret_is_unset(tmp_path, monkeypatch):
    monkeypatch.delenv("SENATE_PROXY_URL", raising=False)
    assert _load(tmp_path).senate_proxy_url is None


# --- senate.sync: the site refusing us is not the request failing -----------


def test_empty_proxy_url_is_a_client_error_not_a_block(monkeypatch):
    # Reproduces production: httpx rejects proxy="" before any request. The
    # guard makes sure that if a future httpx accepted it, this test would
    # fail loudly rather than reach the network.
    monkeypatch.setattr(senate, "_accept_agreement",
                        _raising(AssertionError("a request was attempted")))
    result = senate.sync(proxy_url="")
    assert result.kind == senate.STATUS_ERROR
    assert result.status == "error: ValueError: Unknown scheme for proxy URL URL('')"
    assert result.filings == []


def test_403_on_the_agreement_page_is_blocked(monkeypatch):
    monkeypatch.setattr(senate, "_client",
                        _transport(lambda req: httpx.Response(403, text="Access Denied")))
    result = senate.sync()
    assert result.kind == senate.STATUS_BLOCKED
    assert result.status.startswith("blocked: 403")


def test_challenge_page_without_the_form_is_blocked(monkeypatch):
    monkeypatch.setattr(senate, "_client", _transport(
        lambda req: httpx.Response(200, text="<html>Checking your browser</html>")))
    result = senate.sync()
    assert result.kind == senate.STATUS_BLOCKED
    assert "csrfmiddlewaretoken" in result.status


def test_agreement_page_where_json_belongs_is_blocked(monkeypatch):
    # The agreement is bound to the accepting IP; a rotating proxy exit gets
    # the form back from the data endpoint instead of rows.
    def handler(request):
        if request.url.path == "/search/home/" and request.method == "GET":
            return httpx.Response(200, text=AGREEMENT_PAGE,
                                  headers={"set-cookie": "csrftoken=abc; Path=/"})
        return httpx.Response(200, text=AGREEMENT_PAGE)
    monkeypatch.setattr(senate, "_client", _transport(handler))
    result = senate.sync()
    assert result.kind == senate.STATUS_BLOCKED
    assert "prohibition agreement" in result.status


def test_dns_failure_is_an_error(monkeypatch):
    monkeypatch.setattr(senate, "_client", _transport(_raising(
        httpx.ConnectError("[Errno 8] nodename nor servname provided, or not known"))))
    result = senate.sync()
    assert result.kind == senate.STATUS_ERROR
    assert result.status.startswith("error: ConnectError: [Errno 8]")


def test_timeout_is_an_error_that_names_its_type(monkeypatch):
    # str(httpx.ReadTimeout("")) is empty; the type is all that identifies it.
    monkeypatch.setattr(senate, "_client", _transport(_raising(httpx.ReadTimeout(""))))
    result = senate.sync()
    assert result.status == "error: ReadTimeout"


def test_proxy_refusal_is_an_error_not_a_block(monkeypatch):
    # A 403 from the proxy's CONNECT is the proxy's, not eFD's.
    monkeypatch.setattr(senate, "_client", _transport(_raising(httpx.ProxyError("403 Forbidden"))))
    result = senate.sync()
    assert result.kind == senate.STATUS_ERROR
    assert result.status == "error: ProxyError: 403 Forbidden"


def test_unexpected_http_status_is_an_error(monkeypatch):
    monkeypatch.setattr(senate, "_client",
                        _transport(lambda req: httpx.Response(503, text="maintenance")))
    result = senate.sync()
    assert result.kind == senate.STATUS_ERROR
    assert result.status.startswith("error: HTTPStatusError: Server error '503")


def test_rows_are_returned_when_efd_answers(monkeypatch):
    def handler(request):
        if request.url.path == "/search/home/" and request.method == "GET":
            return httpx.Response(200, text=AGREEMENT_PAGE,
                                  headers={"set-cookie": "csrftoken=abc; Path=/"})
        if request.url.path == "/search/home/":
            return httpx.Response(200, text="ok")
        assert request.url.path == "/search/report/data/"
        return httpx.Response(200, json={"data": [[
            "Jane", "Doe", "Senator",
            '<a href="/search/view/ptr/abc-123/">Periodic Transaction Report</a>',
            "10/01/2026"]]})
    monkeypatch.setattr(senate, "_client", _transport(handler))
    result = senate.sync()
    assert result.kind == senate.STATUS_OK
    assert result.status == "ok: 1 filings seen"
    assert [f.doc_id for f in result.filings] == ["abc-123"]


@pytest.mark.parametrize("status, kind", [
    ("ok: 3 filings seen", "ok"),
    ("blocked: 403 on https://efdsearch.senate.gov/search/home/ (bot protection)", "blocked"),
    (PRODUCTION_STATUS, "error"),
    ("something else entirely", None),
    ("", None),
    (None, None),
])
def test_status_kind(status, kind):
    assert senate.status_kind(status) == kind


# --- audit.check_senate: only the site-side block is "expected" --------------


def _with_status(conn, status):
    if status is not None:
        db.set_state(conn, "senate_status", status)
    conn.commit()


def test_production_status_is_an_error_not_the_known_block(conn):
    _with_status(conn, PRODUCTION_STATUS)
    [found] = audit.check_senate(conn)
    assert (found.severity, found.code) == (audit.WARN, "senate_error")
    assert PRODUCTION_STATUS in found.title
    assert "not eFD refusing us" in found.detail
    assert "SENATE_PROXY_URL" in found.detail


def test_site_side_block_is_a_warning_that_names_the_fix(conn):
    # No longer "expected": eFD answers the runner (#40), so a block means
    # the Senate side went dark and the proxy fallback is the remedy.
    _with_status(conn, "blocked: 403 on https://efdsearch.senate.gov/search/home/ (bot protection)")
    [found] = audit.check_senate(conn)
    assert (found.severity, found.code) == (audit.WARN, "senate_blocked")
    assert found.detail.startswith("eFD refused")
    assert "SENATE_PROXY_URL" in found.detail


def test_reachable_efd_is_reported(conn):
    _with_status(conn, "ok: 3 filings seen")
    [found] = audit.check_senate(conn)
    assert (found.severity, found.code) == (audit.INFO, "senate_available")


def test_no_recorded_run_is_named_as_such(conn):
    # `senate.enabled: false`, or a fresh database: neither a block nor an
    # error, and not something to warn about every week.
    _with_status(conn, None)
    [found] = audit.check_senate(conn)
    assert (found.severity, found.code) == (audit.INFO, "senate_not_attempted")


def test_unknown_prefix_is_not_a_pass(conn):
    _with_status(conn, "something else entirely")
    [found] = audit.check_senate(conn)
    assert (found.severity, found.code) == (audit.WARN, "senate_error")


def test_run_checks_surfaces_senate_error(conn):
    _with_status(conn, PRODUCTION_STATUS)
    found = {f.code: f for f in audit.run_checks(conn)}
    assert "senate_error" in found and "senate_blocked" not in found
    assert "check_failed" not in found


# --- pipeline: nothing raises, the status is stored verbatim ----------------


def test_pipeline_records_a_client_error_without_raising(conn, monkeypatch):
    monkeypatch.setattr(senate, "fetch_ptrs",
                        _raising(ValueError("Unknown scheme for proxy URL URL('')")))
    pipeline._sync_senate(conn, Config())
    assert db.get_state(conn, "senate_status") == \
        "error: ValueError: Unknown scheme for proxy URL URL('')"


def test_pipeline_records_a_block(conn, monkeypatch):
    monkeypatch.setattr(senate, "fetch_ptrs", _raising(senate.SenateBlocked("403 on home")))
    pipeline._sync_senate(conn, Config())
    assert db.get_state(conn, "senate_status") == "blocked: 403 on home"


def test_pipeline_queues_filings_when_efd_answers(conn, monkeypatch):
    filing = senate.SenateFiling(doc_id="abc-123", first="Jane", last="Doe", office="Senator",
                                 report_type="Periodic Transaction Report",
                                 filed_date="10/01/2026",
                                 url="https://efdsearch.senate.gov/search/view/ptr/abc-123/")
    monkeypatch.setattr(senate, "fetch_ptrs", lambda *a, **k: [filing])
    pipeline._sync_senate(conn, Config())
    assert db.get_state(conn, "senate_status") == "ok: 1 filings seen"
    assert db.filing_exists(conn, "senate", "abc-123")
