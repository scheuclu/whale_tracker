"""Daily closes for alerted tickers (#53): the fetch step.

Every ticker an alert names, plus the benchmark, is asked for once a day
under a time budget, at a polite rate, from an unofficial key-less series.
The step never raises into the pipeline: a throttle or a verification wall
stops the run and is recorded in `sync_state.prices_status`, a failing
ticker is recorded against itself, and the rest is left for the next run.
"""

import itertools
import json
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import httpx
import pytest

from whale import __main__ as cli
from whale import db, pipeline, prices, stats
from whale.config import DEFAULT_CONFIG_FILE, Config, ConfigError, load_config

FIXTURES = Path(__file__).parent / "fixtures"
# A Friday, 15:00 in New York: the session is still open.
NOW = datetime(2026, 10, 16, 19, 0, tzinfo=timezone.utc)
AFTER_CLOSE = datetime(2026, 10, 16, 20, 10, tzinfo=timezone.utc)


@pytest.fixture
def conn(tmp_path):
    c = db.connect(tmp_path / "t.sqlite3")
    yield c
    c.close()


def _alert(conn, kind, ticker, direction, fired_at="2026-09-07T14:20:12Z"):
    alert_id = db.record_alert(conn, kind, ticker, direction, 90 if "cluster" in kind else 0, 3)
    conn.execute("UPDATE alerts SET fired_at = ? WHERE id = ?", (fired_at, alert_id))
    conn.commit()
    return alert_id


# --- symbols and parsing ------------------------------------------------------


def test_symbols_map_class_shares_and_suffixes():
    assert prices.stooq_symbol("NVDA") == "nvda.us"
    assert prices.stooq_symbol("BRK.B") == "brk-b.us"
    assert prices.yahoo_symbol("BRK.B") == "BRK-B"
    assert prices.yahoo_symbol("nvda") == "NVDA"


def test_stooq_csv_parses_closes_over_the_labor_day_gap():
    bars = prices.parse_stooq_csv((FIXTURES / "stooq_spy.csv").read_text())
    assert len(bars) == 8
    assert bars[0] == prices.Bar("2026-09-01", 644.37)
    dates = [b.date for b in bars]
    # Friday the 4th, then Tuesday the 8th: the holiday is simply not a row.
    assert "2026-09-04" in dates and "2026-09-08" in dates and "2026-09-07" not in dates


def test_stooq_hits_limit_is_throttled():
    with pytest.raises(prices.PricesThrottled):
        prices.parse_stooq_csv("Exceeded the daily hits limit")


def test_stooq_browser_verification_page_is_blocked_not_solved():
    with pytest.raises(prices.PricesBlocked):
        prices.parse_stooq_csv((FIXTURES / "stooq_wall.html").read_text())


def test_stooq_no_data_is_an_empty_series():
    assert prices.parse_stooq_csv("No data") == []


def test_yahoo_chart_dates_each_session_at_the_exchange():
    payload = json.loads((FIXTURES / "yahoo_chart_spy.json").read_text())
    bars = prices.parse_yahoo_chart(payload)
    # 33 sessions from 2026-09-01 to 2026-10-16: timestamps are the 13:30Z
    # opens, dated by the exchange offset, so none slips to the next day.
    assert len(bars) == 33
    assert bars[0].date == "2026-09-01" and bars[-1].date == "2026-10-16"
    dates = {b.date for b in bars}
    assert "2026-09-07" not in dates, "Labor Day is not a session"
    assert "2026-10-12" in dates, "Columbus Day is a federal holiday but NYSE trades"
    assert bars[-1].close == pytest.approx(763.25, abs=0.01)


def test_yahoo_not_found_is_an_empty_series_and_other_errors_raise():
    not_found = {"chart": {"result": None, "error": {
        "code": "Not Found", "description": "No data found, symbol may be delisted"}}}
    assert prices.parse_yahoo_chart(not_found) == []
    with pytest.raises(ValueError, match="Bad Request"):
        prices.parse_yahoo_chart({"chart": {"result": None, "error": {
            "code": "Bad Request", "description": "x"}}})


def test_a_close_is_final_only_after_the_session_ends():
    assert prices.final_through(NOW) == "2026-10-15"
    assert prices.final_through(AFTER_CLOSE) == "2026-10-16"
    # 02:00Z on Saturday is Friday evening in New York.
    assert prices.final_through(datetime(2026, 10, 17, 2, 0, tzinfo=timezone.utc)) == "2026-10-16"


# --- the client ---------------------------------------------------------------


def _client(handler, source="yahoo", slept=None):
    http = httpx.Client(transport=httpx.MockTransport(handler),
                        headers={"User-Agent": prices.USER_AGENT})
    return prices.PriceClient(source, http=http, clock=lambda: 100.0,
                              sleep=(slept.append if slept is not None else lambda s: None))


def test_the_client_names_the_project_and_paces_to_two_requests_a_second():
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200, json=json.loads((FIXTURES / "yahoo_chart_spy.json").read_text()))

    slept = []
    client = _client(handler, slept=slept)
    client.fetch("BRK.B", date(2026, 9, 1), date(2026, 10, 16))
    client.fetch("SPY", date(2026, 9, 1), date(2026, 10, 16))
    assert "whale-tracker" in seen[0].headers["user-agent"]
    assert seen[0].url.path.endswith("/chart/BRK-B")
    assert "period1=" in str(seen[0].url) and "interval=1d" in str(seen[0].url)
    # The clock stands still, so the second request owes the whole interval.
    assert slept == [pytest.approx(prices.MIN_INTERVAL_S)]


def test_yahoo_429_is_throttled_and_404_is_an_empty_series():
    def handler(request):
        if "ZZZZ" in request.url.path:
            return httpx.Response(404, json={"chart": {"result": None, "error": {
                "code": "Not Found", "description": "No data found, symbol may be delisted"}}})
        return httpx.Response(429, text="Edge: Too Many Requests")

    client = _client(handler)
    assert client.fetch("ZZZZ", date(2026, 9, 1), date(2026, 10, 16)) == []
    with pytest.raises(prices.PricesThrottled):
        client.fetch("SPY", date(2026, 9, 1), date(2026, 10, 16))


def test_stooq_client_maps_the_symbol_and_reads_a_404_as_a_wall():
    seen = []

    def handler(request):
        seen.append(str(request.url))
        if "brk-b.us" in str(request.url):
            return httpx.Response(200, text=(FIXTURES / "stooq_spy.csv").read_text())
        return httpx.Response(404, text="<meta charset=utf-8><title>Stooq</title>")

    client = _client(handler, source="stooq")
    assert len(client.fetch("BRK.B", date(2026, 9, 1), date(2026, 9, 11))) == 8
    assert "s=brk-b.us" in seen[0] and "d1=20260901" in seen[0] and "d2=20260911" in seen[0]
    with pytest.raises(prices.PricesBlocked):
        client.fetch("SPY", date(2026, 9, 1), date(2026, 9, 11))


# --- the sync -----------------------------------------------------------------


class FakeClient:
    """Answers from a dict of ticker -> bars, or raises what it is told to."""

    def __init__(self, series=None, raise_for=None):
        self.series = series or {}
        self.raise_for = raise_for or {}
        self.calls: list[tuple[str, date, date]] = []
        self.closed = False

    def fetch(self, ticker, start, end):
        self.calls.append((ticker, start, end))
        if ticker in self.raise_for:
            raise self.raise_for[ticker]
        return self.series.get(ticker, [])

    def close(self):
        self.closed = True


def _bars(*days, close=100.0):
    return [prices.Bar(d, close + i) for i, d in enumerate(days)]


@pytest.fixture
def alerted(conn):
    _alert(conn, stats.CLUSTER_KIND, "MSFT", "buy")
    _alert(conn, stats.WATCHLIST_KIND, "BRK.B", "sell", "2026-10-15T21:03:00Z")
    _alert(conn, stats.INSIDER_CLUSTER_KIND, "0001742952", "buy")   # keyed on a CIK
    _alert(conn, stats.FILING_KIND, None, "buy")                     # about no one ticker
    return conn


def _fetched(conn):
    return [(t, r["status"]) for t, r in sorted(db.price_fetches(conn).items())]


def test_sync_asks_for_the_benchmark_then_every_listed_ticker_once_a_day(alerted):
    series = {"SPY": _bars("2026-10-14", "2026-10-15"), "MSFT": _bars("2026-10-14", "2026-10-15"),
              "BRK.B": _bars("2026-10-15")}
    fake = FakeClient(series)
    result = prices.sync(alerted, Config(), client=fake, now=NOW)
    assert [c[0] for c in fake.calls] == ["SPY", "BRK.B", "MSFT"]
    assert result.status.startswith("ok") and result.refreshed == 3 and result.tracked == 3
    assert result.bars == 5
    assert _fetched(alerted) == [("BRK.B", "ok"), ("MSFT", "ok"), ("SPY", "ok")]
    assert db.get_state(alerted, prices.STATE_STATUS) == result.status
    assert alerted.execute("SELECT COUNT(*) FROM prices WHERE source = 'yahoo'").fetchone()[0] == 5
    assert not fake.closed, "a caller's client is the caller's to close"

    # Same day again: every ticker is fresh, nothing is asked for.
    again = prices.sync(alerted, Config(), client=fake, now=NOW + timedelta(hours=3))
    assert len(fake.calls) == 3 and again.fresh == 3 and again.refreshed == 0

    # The next UTC day, every ticker is due once more.
    prices.sync(alerted, Config(), client=fake, now=NOW + timedelta(days=1))
    assert len(fake.calls) == 6


def test_the_window_starts_before_the_first_alert_and_ends_today(alerted):
    fake = FakeClient()
    prices.sync(alerted, Config(), client=fake, now=NOW)
    first = stats.alert_date_eastern("2026-09-07T14:20:12Z")
    assert fake.calls[0][1] == first - timedelta(days=prices.LOOKBACK_DAYS)
    assert fake.calls[0][2] == NOW.date()


def test_a_session_still_open_is_not_stored_as_a_close(alerted):
    series = {"SPY": _bars("2026-10-15", "2026-10-16")}
    prices.sync(alerted, Config(), client=FakeClient(series), now=NOW)
    dates = [r[0] for r in alerted.execute("SELECT date FROM prices WHERE ticker = 'SPY'")]
    assert dates == ["2026-10-15"], "15:00 in New York: Friday's close does not exist yet"

    alerted.execute("DELETE FROM price_fetches")
    prices.sync(alerted, Config(), client=FakeClient(series), now=AFTER_CLOSE)
    dates = sorted(r[0] for r in alerted.execute("SELECT date FROM prices WHERE ticker = 'SPY'"))
    assert dates == ["2026-10-15", "2026-10-16"]


def test_a_throttle_stops_the_run_and_leaves_the_rest_for_next_time(alerted):
    fake = FakeClient({"SPY": _bars("2026-10-15")},
                      raise_for={"BRK.B": prices.PricesThrottled("Stooq: Exceeded the daily hits limit")})
    result = prices.sync(alerted, Config(), client=fake, now=NOW)
    assert result.status == "throttled: Stooq: Exceeded the daily hits limit"
    assert result.refreshed == 1 and result.left == 2
    assert [c[0] for c in fake.calls] == ["SPY", "BRK.B"], "stopped at the throttle"
    assert db.get_state(alerted, prices.STATE_STATUS).startswith("throttled:")
    # The benchmark was stored; the tickers not reached have no fetch row, so
    # they are due again on the very next run rather than tomorrow.
    assert _fetched(alerted) == [("SPY", "ok")]


def test_a_verification_wall_is_recorded_as_blocked(alerted):
    fake = FakeClient(raise_for={"SPY": prices.PricesBlocked("Stooq served a browser-verification page")})
    result = prices.sync(alerted, Config(), client=fake, now=NOW)
    assert result.status.startswith("blocked: Stooq served") and result.left == 3
    assert db.get_state(alerted, prices.STATE_STATUS) == result.status


def test_one_failing_ticker_is_recorded_and_the_run_goes_on(alerted):
    fake = FakeClient({"SPY": _bars("2026-10-15"), "BRK.B": _bars("2026-10-15")},
                      raise_for={"MSFT": httpx.ConnectError("boom")})
    result = prices.sync(alerted, Config(), client=fake, now=NOW)
    assert result.status.startswith("ok") and result.errors == 1 and result.refreshed == 2
    assert dict(_fetched(alerted))["MSFT"].startswith("error:")
    # An errored fetch is dated, so it is not retried until tomorrow either.
    assert len(fake.calls) == 3


def test_the_budget_leaves_the_rest_for_the_next_run(alerted):
    fake = FakeClient()
    # Every clock() call advances 40 s: the deadline is read at 0, the first
    # ticker is checked at 40 (inside 60) and the second at 80 (past it).
    clock = itertools.count(0, 40)
    result = prices.sync(alerted, Config(), client=fake, now=NOW, clock=lambda: next(clock))
    assert [c[0] for c in fake.calls] == ["SPY"] and result.left == 2
    assert result.status.startswith("ok")

    clock = itertools.count(0, 40)
    prices.sync(alerted, Config(), client=fake, now=NOW, budget_seconds=0,
                clock=lambda: next(clock))
    assert len(fake.calls) == 3, "0 is no limit"


def test_an_empty_answer_retracts_nothing_and_a_source_change_replaces_the_series(alerted):
    db.upsert_prices(alerted, "MSFT", "stooq", [("2026-10-14", 400.0)])
    alerted.commit()
    fake = FakeClient({"SPY": _bars("2026-10-15")})
    prices.sync(alerted, Config(), client=fake, now=NOW)
    assert dict(_fetched(alerted))["MSFT"] == "no_data"
    assert [tuple(r) for r in alerted.execute(
        "SELECT date, source FROM prices WHERE ticker = 'MSFT'")] == [("2026-10-14", "stooq")]

    alerted.execute("DELETE FROM price_fetches")
    fake = FakeClient({"MSFT": _bars("2026-10-15")})
    prices.sync(alerted, Config(), client=fake, now=NOW)
    assert [tuple(r) for r in alerted.execute(
        "SELECT date, source FROM prices WHERE ticker = 'MSFT'")] == [("2026-10-15", "yahoo")]


def test_disabled_or_nothing_to_price_is_recorded_without_a_request(conn):
    fake = FakeClient()
    config = Config()
    config.prices.enabled = False
    assert prices.sync(conn, config, client=fake, now=NOW).status == "skipped: prices.enabled is false"
    assert db.get_state(conn, prices.STATE_STATUS).startswith("skipped")
    assert prices.sync(conn, Config(), client=fake, now=NOW).status == "ok: no alert names a ticker yet"
    assert fake.calls == []


def test_the_pipeline_step_never_raises_and_a_dry_run_fetches_nothing(conn, monkeypatch):
    def explode(*a, **kw):
        raise RuntimeError("source on fire")

    monkeypatch.setattr(prices, "sync", explode)
    pipeline._sync_prices(conn, Config())
    assert db.get_state(conn, prices.STATE_STATUS) == "error: source on fire"

    called = []
    monkeypatch.setattr(prices, "sync", lambda *a, **kw: called.append(1))
    pipeline._sync_prices(conn, Config(), dry_run=True)
    assert called == []


# --- config and CLI -------------------------------------------------------------


def test_prices_config_defaults_and_refusals(tmp_path):
    absent = load_config(tmp_path / "absent.yaml").prices
    assert (absent.enabled, absent.source, absent.budget_seconds) == (True, "yahoo", 60)
    shipped = load_config(DEFAULT_CONFIG_FILE).prices
    assert shipped.enabled and shipped.source == "yahoo" and shipped.budget_seconds == 60

    f = tmp_path / "c.yaml"
    f.write_text("prices:\n  source: bloomberg\n")
    with pytest.raises(ConfigError, match="prices.source"):
        load_config(f)
    f.write_text("prices:\n  budget_seconds: -1\n")
    with pytest.raises(ConfigError, match="prices.budget_seconds"):
        load_config(f)
    f.write_text("prices:\n  enabled: false\n  source: STOOQ\n  budget_seconds: 0\n")
    settings = load_config(f).prices
    assert (settings.enabled, settings.source, settings.budget_seconds) == (False, "stooq", 0)


def test_fetch_prices_command_runs_and_prints_the_summary(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(cli, "load_config", lambda: Config(db_path=tmp_path / "t.sqlite3"))
    assert cli.main(["fetch-prices"]) == 0
    out = capsys.readouterr().out
    assert "prices: ok: no alert names a ticker yet" in out
    assert "No alert outcome yet." in out
