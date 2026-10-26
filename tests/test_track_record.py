"""Track record: how the stock moved after each member's decisions.

A decision is (member, ticker, direction, filing); it is measured as the
ticker's close-to-close move minus SPY's at 30/90/180 trading days, signed by
direction, from the trade date (first session on or after it) and from the
disclosure (first session strictly after the filing date). No bracket enters
any of it. Scores are shrunk toward zero by an empirical-Bayes factor, given
a bootstrap interval and a luck percentile, derived once in Python and only
read by SQL. The step fetches series transiently, under a budget, resumably,
and never raises into the pipeline.
"""

import random
import sqlite3
from datetime import date, datetime, timedelta, timezone

import pytest

from whale import audit, db, pipeline, stats, track
from whale.config import Config, ConfigError, TrackRecordSettings, load_config
from whale.prices import Bar, PricesBlocked, PricesThrottled

# --- a synthetic market ---------------------------------------------------------

HOLIDAYS = {date(2026, 1, 1), date(2026, 1, 19), date(2026, 2, 16), date(2026, 4, 3),
            date(2026, 5, 25), date(2026, 6, 19), date(2026, 7, 3), date(2026, 9, 7),
            date(2026, 11, 26), date(2026, 12, 25)}


def sessions(start=date(2026, 1, 2), end=date(2026, 12, 31)):
    d, out = start, []
    while d <= end:
        if d.weekday() < 5 and d not in HOLIDAYS:
            out.append(d.isoformat())
        d += timedelta(days=1)
    return out


CAL = sessions()
SPY = {d: 100.0 * (1.001 ** i) for i, d in enumerate(CAL)}            # +0.1% a session
UP = {d: 50.0 * (1.003 ** i) for i, d in enumerate(CAL)}              # beats SPY
DOWN = {d: 80.0 * (0.999 ** i) for i, d in enumerate(CAL)}            # lags SPY


class FakeClient:
    """Serves series by ticker; counts requests; can be told to fail."""

    def __init__(self, series, fail=None):
        self.series = series
        self.fail = fail or {}
        self.calls = []

    def fetch(self, ticker, start, end):
        self.calls.append(ticker)
        if ticker in self.fail:
            raise self.fail[ticker]
        closes = self.series.get(ticker, {})
        return [Bar(d, c) for d, c in sorted(closes.items())
                if start.isoformat() <= d <= end.isoformat()]

    def close(self):
        pass


def _now(day: str) -> datetime:
    # 22:00 UTC is 18:00 in New York: that day's close is final.
    return datetime.fromisoformat(day + "T22:00:00+00:00")


@pytest.fixture
def conn(tmp_path):
    c = db.connect(tmp_path / "t.sqlite3")
    yield c
    c.close()


def _filing(conn, doc, filing_date, name="Jane Doe", parse_method="text", status="backfilled"):
    fid = db.insert_filing(conn, chamber="house", doc_id=doc, filer_name=name,
                           filing_type="P", filing_date=filing_date, year=2026,
                           pdf_url=f"https://x/{doc}.pdf", status=status,
                           parse_method=parse_method)
    return fid


def _rows(conn, fid, rows):
    db.replace_transactions(conn, fid, None, [
        {"asset_name": r.get("ticker") or "x", "asset_type": "ST", "action": "purchase", **r}
        for r in rows])
    conn.commit()


def _row(**kw):
    base = {"action": "purchase", "ticker": "AAA", "asset_type": "ST", "option_kind": None,
            "parse_method": "text", "tx_date": "2026-03-02", "notification_date": None,
            "filing_date": "2026-03-20", "filing_id": 1, "politician_id": None,
            "member_name": "Jane Doe"}
    base.update(kw)
    return base


# --- grouping and exclusions ------------------------------------------------------


def test_repeated_rows_for_one_ticker_in_one_filing_are_one_decision():
    rows = [_row(tx_date="2026-03-05"), _row(tx_date="2026-03-02"), _row(tx_date="2026-03-09"),
            _row(ticker="BBB"), _row(action="sale"), _row(action="sale_partial"),
            _row(filing_id=2)]
    out, tally = stats.group_track_decisions(rows, date(2026, 10, 1))
    keys = {(d.filing_id, d.ticker, d.direction): d for d in out}
    assert set(keys) == {(1, "AAA", "buy"), (1, "BBB", "buy"), (1, "AAA", "sell"), (2, "AAA", "buy")}
    aaa = keys[(1, "AAA", "buy")]
    assert aaa.rows == 3 and aaa.tx_date == "2026-03-02", "t0 is the group's earliest trade"
    assert keys[(1, "AAA", "sell")].rows == 2, "sale and partial sale are one direction"
    assert tally == {"included": 7}


@pytest.mark.parametrize("override, reason", [
    ({"parse_method": "vision"}, "transcribed"),
    ({"action": "exchange"}, "exchange"),
    ({"ticker": None}, "no_ticker"),
    ({"ticker": "  "}, "no_ticker"),
    ({"option_kind": "call"}, "option"),
    ({"asset_type": "OP"}, "option"),
    ({"asset_type": "GS"}, "non_equity"),
    ({"asset_type": "CS"}, "non_equity"),
    ({"asset_type": None}, "non_equity"),
    ({"tx_date": "2026-12-26"}, "date_as_filed"),                       # in the future
    ({"tx_date": "2026-03-25"}, "date_as_filed"),                       # after its filing
    ({"notification_date": "2026-02-01"}, "date_as_filed"),             # notified before trading
    ({"tx_date": None}, "date_as_filed"),
    ({"tx_date": "03/02/2026"}, "date_as_filed"),
    ({"asset_type": "EF"}, None),
    ({"asset_type": "ET"}, None),
])
def test_each_exclusion_reason(override, reason):
    assert stats.track_row_exclusion(_row(**override), date(2026, 10, 1)) == reason


def test_transcribed_beats_every_other_reason_and_excluded_groups_are_counted():
    rows = [_row(parse_method="vision", asset_type="OP"),   # transcribed first
            _row(ticker="CCC", asset_type="GS"),
            _row(ticker="CCC", asset_type="GS", option_kind="put"),   # option outranks non-equity
            _row(ticker=None, action="exchange")]                    # exchange outranks no ticker
    out, tally = stats.group_track_decisions(rows, date(2026, 10, 1))
    assert tally == {"transcribed": 1, "non_equity": 1, "option": 1, "exchange": 1}
    by = {d.ticker: d for d in out}
    assert by["AAA"].exclusion == "transcribed"
    assert by["CCC"].exclusion == "option" and by["CCC"].rows == 2
    assert len(out) == 2, "a row with no ticker or no direction forms no decision"


def test_an_eligible_row_wins_its_key_and_excluded_siblings_are_only_counted():
    rows = [_row(asset_type="OP"), _row(tx_date="2026-03-04")]
    out, tally = stats.group_track_decisions(rows, date(2026, 10, 1))
    assert [(d.exclusion, d.rows, d.tx_date) for d in out] == [(None, 1, "2026-03-04")]
    assert tally == {"option": 1, "included": 1}


# --- sessions, excess, maturity ------------------------------------------------


def test_trade_clock_starts_on_or_after_the_trade_date():
    assert CAL[stats.session_on_or_after(CAL, "2026-03-02")] == "2026-03-02"   # a Monday session
    assert CAL[stats.session_on_or_after(CAL, "2026-03-07")] == "2026-03-09"   # Saturday → Monday
    assert CAL[stats.session_on_or_after(CAL, "2026-01-19")] == "2026-01-20"   # MLK day → Tuesday
    assert stats.session_on_or_after(CAL, "2027-01-04") is None                # past the calendar


def test_disclosure_clock_starts_strictly_after_the_filing_date():
    assert CAL[stats.session_after(CAL, "2026-03-02")] == "2026-03-03"         # filed on a session
    assert CAL[stats.session_after(CAL, "2026-03-06")] == "2026-03-09"         # filed on a Friday
    assert CAL[stats.session_after(CAL, "2026-03-07")] == "2026-03-09"         # filed on a Saturday
    assert CAL[stats.session_after(CAL, "2026-04-02")] == "2026-04-06"         # Thursday before Good Friday
    assert stats.session_after(CAL, CAL[-1]) is None


def test_excess_is_the_tickers_move_minus_spys_and_pending_past_the_calendar():
    i0 = CAL.index("2026-03-02")
    got = stats.track_excess(CAL, SPY, UP, i0, 30)
    expected = (1.003 ** 30 - 1) - (1.001 ** 30 - 1)
    assert got == pytest.approx(expected)
    assert stats.track_excess(CAL, SPY, DOWN, i0, 30) < 0
    assert stats.track_excess(CAL, SPY, UP, len(CAL) - 10, 30) is None, "not matured yet"
    gappy = dict(UP)
    del gappy[CAL[i0 + 30]]
    assert stats.track_excess(CAL, SPY, gappy, i0, 30) is None, "no close that day: not 0"
    assert stats.track_excess(CAL, SPY, SPY, i0, 90) == pytest.approx(0.0)


# --- shrinkage, bootstrap, luck ---------------------------------------------------


def test_shrinkage_goes_to_zero_with_no_decisions_and_to_the_mean_with_many():
    assert stats.shrink(0.10, 0, 20.0) == 0.0
    assert stats.shrink(0.10, 20, 20.0) == pytest.approx(0.05)
    assert stats.shrink(0.10, 100_000, 20.0) == pytest.approx(0.10, rel=1e-3)
    assert stats.shrink(0.10, 50, None) == 0.0, "no detectable spread: everything shrinks to 0"


def test_k_is_within_variance_over_between_variance():
    rng = random.Random(1)
    tau, sigma = 0.05, 0.20
    groups = []
    for _ in range(400):
        theta = rng.gauss(0, tau)
        groups.append([theta + rng.gauss(0, sigma) for _ in range(30)])
    fit = stats.shrinkage_k(groups)
    assert fit["sigma2"] == pytest.approx(sigma ** 2, rel=0.05)
    assert fit["tau2"] == pytest.approx(tau ** 2, rel=0.35)
    assert fit["k"] == pytest.approx(sigma ** 2 / tau ** 2, rel=0.4)


def test_no_spread_between_members_means_no_k():
    rng = random.Random(2)
    groups = [[rng.gauss(0, 0.2) for _ in range(10)] for _ in range(200)]
    fit = stats.shrinkage_k(groups)
    assert fit is not None and (fit["k"] is None or fit["k"] > 50)
    assert stats.shrinkage_k([[0.1, 0.2], [0.3, 0.1]]) is None, "fewer than three members"


def test_bootstrap_is_deterministic_for_a_seed_and_never_zero_width_for_one_filing():
    clusters = [[0.10, -0.02, 0.05], [0.20], [-0.05, 0.01]]
    a = stats.bootstrap_interval(clusters, 5.0, random.Random("s"), draws=500)
    b = stats.bootstrap_interval(clusters, 5.0, random.Random("s"), draws=500)
    assert a == b
    assert a[0] < stats.shrink(sum(sum(c) for c in clusters) / 6, 6, 5.0) < a[1]
    lo, hi = stats.bootstrap_interval([[0.1, -0.1, 0.3, 0.0]], 5.0, random.Random(0), draws=300)
    assert hi - lo > 0.01, "decisions inside a lone filing are re-drawn too"


def test_luck_percentile_on_a_constructed_universe():
    # Every day: nine other members' tickers move 0..8 points; ours moved 10.
    pool = []
    for day in range(1, 29):
        d = f"2026-02-{day:02d}"
        pool += [(d, f"other{i}", i / 100) for i in range(9)]
    best = [(f"2026-02-{day:02d}", "buy", 0.10) for day in range(1, 11)]
    worst = [(f"2026-02-{day:02d}", "buy", -0.01) for day in range(1, 11)]
    assert stats.luck_percentile(best, pool, "me", random.Random(0), draws=500) == 1.0
    assert stats.luck_percentile(worst, pool, "me", random.Random(0), draws=500) == 0.0
    # The member's own decisions never enter their null.
    mine = pool + [(d, "me", 5.0) for d, _, _ in best]
    assert stats.luck_percentile(best, mine, "me", random.Random(0), draws=500) == 1.0
    # A sale flips the drawn move, as it flips the member's own.
    sells = [(f"2026-02-{day:02d}", "sell", -0.0) for day in range(1, 11)]
    assert stats.luck_percentile(sells, pool, "me", random.Random(0), draws=500) == 1.0
    median = [(f"2026-02-{day:02d}", "buy", 0.04) for day in range(1, 11)]
    assert 0.3 < stats.luck_percentile(median, pool, "me", random.Random(0), draws=2000) < 0.7


def _decision(member, filing_id, t0, direction="buy", trade=0.01, disclosure=0.005, h=(30, 90, 180)):
    d = {"member_name": member, "politician_id": None, "filing_id": filing_id,
         "direction": direction, "t0_trade": t0, "t0_disclosure": t0}
    for hh in stats.TRACK_HORIZONS:
        d[f"signed_trade_{hh}"] = trade if hh in h else None
        d[f"signed_disclosure_{hh}"] = disclosure if hh in h else None
    return d


def test_scores_pair_the_clocks_rank_qualifiers_and_are_deterministic():
    rng = random.Random(3)
    decisions = []
    for m, skill in (("Ann", 0.06), ("Bob", 0.0), ("Cy", -0.04), ("Di", 0.02)):
        for j in range(12):
            t0 = CAL[10 + j * 3]
            decisions.append(_decision(m, hash((m, j // 3)) % 10_000, t0,
                                       trade=skill + rng.gauss(0, 0.03),
                                       disclosure=skill / 2 + rng.gauss(0, 0.03)))
    # Too few to rank, and one decision with only the trade clock matured.
    decisions += [_decision("Ed", 9001 + j, CAL[20], trade=0.5) for j in range(3)]
    # Plenty of decisions, but all in one filing: one moment in the market.
    decisions += [_decision("Fay", 9300, CAL[25], trade=0.3) for _ in range(10)]
    decisions.append(_decision("Ann", 9100, CAL[30], trade=9.9, h=()))
    half = _decision("Ann", 9200, CAL[31], trade=9.9)
    half["signed_disclosure_90"] = None
    decisions.append(half)

    scores, models = stats.track_scores(decisions, horizons=(90,), min_decisions=8,
                                        draws=200, luck_draws=200)
    by = {s.member_name: s for s in scores}
    assert by["Ann"].n == 12, "a decision counts only when both clocks have matured"
    assert [s.member_name for s in sorted((s for s in scores if s.rank), key=lambda s: s.rank)] \
        == ["Ann", "Di", "Bob", "Cy"]
    fay = by["Fay"]
    assert fay.n == 10 and fay.filings == 1 and not fay.qualifies and fay.rank is None
    ed = by["Ed"]
    assert not ed.qualifies and ed.rank is None and ed.trade.lo is None and ed.trade.luck is None
    ann = by["Ann"]
    assert ann.trade.lo <= ann.trade.score <= ann.trade.hi
    assert abs(ann.trade.score) <= abs(ann.trade.mean), "shrinkage pulls toward zero"
    assert 0 <= ann.trade.hit_rate <= 1 and ann.trade.luck is not None
    assert {m["clock"] for m in models} == {"trade", "disclosure"}
    assert all(m["ranked"] == 4 and m["decisions"] == 61 for m in models)
    again, _ = stats.track_scores(decisions, horizons=(90,), min_decisions=8,
                                  draws=200, luck_draws=200)
    assert [(s.trade.lo, s.trade.luck) for s in again] == [(s.trade.lo, s.trade.luck) for s in scores]


# --- the pipeline step -----------------------------------------------------------


def _config(**kw):
    return Config(track_record=TrackRecordSettings(**kw))


def _seed(conn):
    """Three filings, two tickers that have series and one that has none."""
    f1 = _filing(conn, "1", "2026-03-20")
    _rows(conn, f1, [{"ticker": "UP", "tx_date": "2026-03-02"},
                     {"ticker": "UP", "tx_date": "2026-03-04"},
                     {"ticker": "DOWN", "tx_date": "2026-03-03", "action": "sale"},
                     {"ticker": "GONE", "tx_date": "2026-03-03"},
                     {"ticker": "TBILL", "asset_type": "GS", "tx_date": "2026-03-03"}])
    f2 = _filing(conn, "2", "2026-06-12", name="John Roe")
    _rows(conn, f2, [{"ticker": "DOWN", "tx_date": "2026-06-01"}])
    f3 = _filing(conn, "3", "2026-05-01", parse_method="vision")
    _rows(conn, f3, [{"ticker": "UP", "tx_date": "2026-04-20"}])
    return f1, f2, f3


def test_sync_measures_signs_and_counts_coverage(conn):
    _seed(conn)
    client = FakeClient({"SPY": SPY, "UP": UP, "DOWN": DOWN})
    result = track.sync(conn, _config(), client=client, now=_now("2026-10-23"))
    assert result.status.startswith("ok"), result.status
    rows = {(r["ticker"], r["direction"], r["member_name"]): r
            for r in conn.execute("SELECT * FROM track_decisions WHERE exclusion IS NOT 'transcribed'")}
    up = rows[("UP", "buy", "Jane Doe")]
    i0 = CAL.index("2026-03-02")
    assert up["t0_trade"] == "2026-03-02" and up["rows"] == 2
    assert up["t0_disclosure"] == "2026-03-23", "filed Friday the 20th: next session is Monday"
    assert up["signed_trade_30"] == pytest.approx((UP[CAL[i0 + 30]] / UP[CAL[i0]] - 1)
                                                  - (SPY[CAL[i0 + 30]] / SPY[CAL[i0]] - 1))
    assert up["signed_trade_90"] is not None
    assert up["signed_trade_180"] is None, "180 sessions from March 2 is past October 23: pending"
    sold = rows[("DOWN", "sell", "Jane Doe")]
    assert sold["signed_trade_90"] > 0, "a sale followed by underperformance scores positive"
    bought = rows[("DOWN", "buy", "John Roe")]
    assert bought["signed_trade_90"] < 0 and bought["signed_trade_180"] is None, "180 not matured"
    assert rows[("GONE", "buy", "Jane Doe")]["exclusion"] == "no_price_series"
    assert rows[("UP", "buy", "Jane Doe")]["exclusion"] is None
    assert conn.execute("SELECT COUNT(*) FROM track_decisions WHERE ticker = 'UP' "
                        "AND exclusion = 'transcribed'").fetchone()[0] == 1
    coverage = {r["outcome"]: (r["rows"], r["decisions"])
                for r in conn.execute("SELECT * FROM track_coverage")}
    assert coverage == {"included": (4, 3), "transcribed": (1, 1), "non_equity": (1, 1),
                        "no_price_series": (1, 1)}
    assert conn.execute("SELECT COUNT(*) FROM track_scores").fetchone()[0] > 0
    assert conn.execute("SELECT COUNT(*) FROM track_model").fetchone()[0] == 6
    assert db.get_state(conn, track.STATE_STATUS).startswith("ok")


def test_sync_is_budgeted_resumable_and_then_idle(conn):
    _seed(conn)
    client = FakeClient({"SPY": SPY, "UP": UP, "DOWN": DOWN})
    ticks = iter(range(0, 10_000))
    clock = lambda: float(next(ticks))  # noqa: E731 — each call is one second later
    first = track.sync(conn, _config(budget_seconds=3), client=client,
                       now=_now("2026-10-23"), clock=clock)
    assert first.left > 0 and first.fetched < 3
    assert db.get_state(conn, track.STATE_COMPLETE) is None
    second = track.sync(conn, _config(budget_seconds=0), client=client, now=_now("2026-10-23"))
    assert second.left == 0 and second.fetched >= 1
    assert db.get_state(conn, track.STATE_COMPLETE) == "2026-10-23"
    fetched_before = set(client.calls)
    client.calls.clear()
    idle = track.sync(conn, _config(), client=client, now=_now("2026-10-23"))
    assert idle.status == "ok: up to date" and client.calls == [], "nothing new: no request at all"
    assert fetched_before >= {"SPY", "UP", "DOWN", "GONE"}


def test_only_tickers_with_a_newly_matured_horizon_are_fetched_again(conn):
    f = _filing(conn, "1", "2026-03-20")
    _rows(conn, f, [{"ticker": "UP", "tx_date": "2026-03-02"}])
    f2 = _filing(conn, "2", "2026-01-23")
    _rows(conn, f2, [{"ticker": "DOWN", "tx_date": "2026-01-05"}])
    client = FakeClient({"SPY": SPY, "UP": UP, "DOWN": DOWN})
    first = "2026-07-01"
    track.sync(conn, _config(), client=client, now=_now(first))

    def targets(trade, filed):
        i_t = stats.session_on_or_after(CAL, trade)
        i_d = stats.session_after(CAL, filed)
        return {CAL[i + h] for i in (i_t, i_d) for h in stats.TRACK_HORIZONS}

    due = {"UP": targets("2026-03-02", "2026-03-20"), "DOWN": targets("2026-01-05", "2026-01-23")}
    nxt = min(t for ts in due.values() for t in ts if t > first)
    expected = sorted(k for k, ts in due.items() if nxt in ts)
    assert len(expected) == 1
    client.calls.clear()
    # The session before the next horizon: nothing matured, no ticker asked.
    track.sync(conn, _config(), client=client, now=_now(CAL[CAL.index(nxt) - 1]))
    assert client.calls == ["SPY"]
    client.calls.clear()
    track.sync(conn, _config(), client=client, now=_now(nxt))
    assert client.calls == ["SPY"] + expected
    client.calls.clear()
    track.sync(conn, _config(), client=client, now=_now(nxt))
    assert client.calls == [], "same final session: up to date"


def test_a_new_filing_is_measured_on_the_next_run(conn):
    f = _filing(conn, "1", "2026-03-20")
    _rows(conn, f, [{"ticker": "UP", "tx_date": "2026-03-02"}])
    client = FakeClient({"SPY": SPY, "UP": UP, "DOWN": DOWN})
    track.sync(conn, _config(), client=client, now=_now("2026-10-23"))
    f2 = _filing(conn, "2", "2026-04-20")
    _rows(conn, f2, [{"ticker": "DOWN", "tx_date": "2026-04-01"}])
    client.calls.clear()
    result = track.sync(conn, _config(), client=client, now=_now("2026-10-23"))
    assert result.changed == 1 and client.calls == ["SPY", "DOWN"]


def test_a_reparsed_filing_drops_its_stale_decisions(conn):
    f = _filing(conn, "1", "2026-03-20")
    _rows(conn, f, [{"ticker": "UP", "tx_date": "2026-03-02"}])
    client = FakeClient({"SPY": SPY, "UP": UP, "DOWN": DOWN})
    track.sync(conn, _config(), client=client, now=_now("2026-10-23"))
    _rows(conn, f, [{"ticker": "DOWN", "tx_date": "2026-03-02"}])
    track.sync(conn, _config(), client=client, now=_now("2026-10-23"))
    assert [r["ticker"] for r in conn.execute("SELECT ticker FROM track_decisions")] == ["DOWN"]


@pytest.mark.parametrize("exc, prefix", [
    (PricesThrottled("429"), "throttled"),
    (PricesBlocked("wall"), "blocked"),
    (RuntimeError("dns"), "error"),
])
def test_a_refused_benchmark_is_recorded_not_raised(conn, exc, prefix):
    _seed(conn)
    client = FakeClient({"SPY": SPY}, fail={"SPY": exc})
    result = track.sync(conn, _config(), client=client, now=_now("2026-10-23"))
    assert result.status.startswith(prefix + ":")
    assert db.get_state(conn, track.STATE_STATUS).startswith(prefix + ":")
    assert db.get_state(conn, track.STATE_COMPLETE) is None


def test_a_throttle_mid_run_stops_and_a_failing_ticker_is_retried(conn):
    _seed(conn)
    client = FakeClient({"SPY": SPY, "UP": UP, "DOWN": DOWN},
                        fail={"DOWN": RuntimeError("timeout"), "GONE": PricesThrottled("429")})
    result = track.sync(conn, _config(), client=client, now=_now("2026-10-23"))
    assert result.status.startswith("throttled") or result.errors == 1
    fetch = {r["ticker"]: r["status"] for r in conn.execute("SELECT * FROM track_price_fetches")}
    assert fetch.get("DOWN", "").startswith("error")
    client.fail = {}
    client.calls.clear()
    track.sync(conn, _config(), client=client, now=_now("2026-10-23"))
    assert "DOWN" in client.calls


def test_disabled_step_does_nothing(conn):
    _seed(conn)
    client = FakeClient({"SPY": SPY})
    result = track.sync(conn, _config(enabled=False), client=client, now=_now("2026-10-23"))
    assert result.status.startswith("skipped") and client.calls == []


def test_the_pipeline_guard_never_lets_the_step_raise(conn, monkeypatch):
    def boom(*a, **k):
        raise sqlite3.OperationalError("disk I/O error")

    monkeypatch.setattr(track, "sync", boom)
    pipeline._sync_track_record(conn, _config())
    assert db.get_state(conn, track.STATE_STATUS) == "error: disk I/O error"
    # A dry run does not touch it at all.
    db.set_state(conn, track.STATE_STATUS, "untouched")
    pipeline._sync_track_record(conn, _config(), dry_run=True)
    assert db.get_state(conn, track.STATE_STATUS) == "untouched"


def test_the_pipeline_runs_the_track_step_last_with_a_run_deadline(monkeypatch, tmp_path):
    order = []
    for name in ("sync", "retry_scanned", "parse_pending", "notify_pending", "notify_clusters",
                 "_sync_insiders", "notify_insiders", "_sync_prices", "_classify_issuers"):
        monkeypatch.setattr(pipeline, name, lambda *a, _n=name, **k: order.append(_n) or 0)
    seen = {}

    def fake_track(conn, config, **kw):
        order.append("track")
        seen.update(kw)

    monkeypatch.setattr(pipeline, "_sync_track_record", fake_track)
    pipeline.run(Config(db_path=tmp_path / "t.sqlite3"))
    assert order[-2:] == ["_classify_issuers", "track"]
    assert seen["deadline"] is not None


def test_the_run_deadline_caps_the_budget(conn):
    _seed(conn)
    client = FakeClient({"SPY": SPY, "UP": UP, "DOWN": DOWN})
    result = track.sync(conn, _config(budget_seconds=0), client=client, now=_now("2026-10-23"),
                        deadline=0.0, clock=lambda: 1.0)
    assert result.left > 0 and result.fetched == 0


# --- schema, config, audit -------------------------------------------------------


def test_a_version_15_database_gains_the_track_tables(tmp_path):
    path = tmp_path / "v15.sqlite3"
    conn = db.connect(path)
    for t in ("track_decisions", "track_scores", "track_model", "track_coverage",
              "track_price_fetches"):
        conn.execute(f"DROP TABLE {t}")
    conn.execute("PRAGMA user_version = 15")
    conn.commit()
    conn.close()
    again = db.connect(path)
    assert again.execute("PRAGMA user_version").fetchone()[0] == db.SCHEMA_VERSION
    names = {r[0] for r in again.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert {"track_decisions", "track_scores", "track_model", "track_coverage",
            "track_price_fetches"} <= names
    again.close()


def test_config_rejects_unknown_track_record_keys(tmp_path):
    cfg = tmp_path / "c.yaml"
    cfg.write_text("track_record:\n  budget_secs: 10\n")
    with pytest.raises(ConfigError, match="unknown key"):
        load_config(cfg, tmp_path / "db.sqlite3")
    cfg.write_text("track_record:\n  min_decisions: 1\n")
    with pytest.raises(ConfigError, match="at least 2"):
        load_config(cfg, tmp_path / "db.sqlite3")
    cfg.write_text("track_record:\n  min_filings: 0\n")
    with pytest.raises(ConfigError, match="at least 1"):
        load_config(cfg, tmp_path / "db.sqlite3")
    cfg.write_text("track_record:\n  budget_seconds: 120\n  min_decisions: 10\n")
    loaded = load_config(cfg, tmp_path / "db.sqlite3").track_record
    assert (loaded.budget_seconds, loaded.min_decisions, loaded.enabled) == (120, 10, True)


def test_the_shipped_config_sets_a_budget_inside_the_poll_timeout():
    settings = load_config().track_record
    assert 0 < settings.budget_seconds <= 300
    assert pipeline.TRACK_RUN_SOFT_LIMIT_S <= 900


def _audit(conn, today):
    return [f for f in audit.check_track_record(conn, today)]


def test_audit_reports_coverage_and_stays_quiet_when_current(conn):
    _seed(conn)
    track.sync(conn, _config(), client=FakeClient({"SPY": SPY, "UP": UP, "DOWN": DOWN}),
               now=_now("2026-10-23"))
    findings = _audit(conn, date(2026, 10, 26))
    assert [f.code for f in findings] == ["track_record_coverage"]
    assert findings[0].severity == audit.INFO


def test_audit_warns_when_matured_decisions_go_unmeasured(conn):
    _seed(conn)
    track.sync(conn, _config(), client=FakeClient({"SPY": SPY}, fail={"SPY": PricesBlocked("wall")}),
               now=_now("2026-10-23"))
    findings = {f.code: f for f in _audit(conn, date(2026, 10, 26))}
    assert findings["track_record_stale"].severity == audit.WARN
    assert any("blocked" in e for e in findings["track_record_coverage"].evidence)


def test_audit_is_silent_before_the_step_has_anything_to_measure(conn):
    assert _audit(conn, date(2026, 10, 26)) == []


def test_a_raising_audit_check_reports_check_failed(conn, monkeypatch):
    monkeypatch.setattr(audit, "_rows", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("x")))
    findings = audit.run_checks(conn, date(2026, 10, 26))
    assert any(f.code == "check_failed" and "check_track_record" in f.title for f in findings)


def test_luck_needs_a_comparable_universe_on_the_same_dates():
    # Plenty of other members' trades — but in 2026, while ours are from 2024.
    pool = [(f"2026-02-{day:02d}", f"other{i}", i / 100) for day in range(1, 29) for i in range(9)]
    old = [(f"2024-05-{day:02d}", "sell", 0.03) for day in range(1, 11)]
    assert stats.luck_percentile(old, pool, "me", random.Random(0), draws=100) is None
    # One other member alone on those dates is not a universe either.
    lonely = pool + [(f"2024-05-{day:02d}", "solo", 0.01) for day in range(1, 29)]
    assert stats.luck_percentile(old, lonely, "me", random.Random(0), draws=100) is None
    # A single stray old decision among recent ones is dropped, not fatal.
    recent = [(f"2026-02-{day:02d}", "buy", 0.10) for day in range(1, 11)]
    assert stats.luck_percentile(recent + old[:1], pool, "me", random.Random(0), draws=100) == 1.0


# --- review follow-ups: ended series, audit evidence ----------------------------


def test_a_series_that_stopped_before_the_calendar_is_ended_not_lagging():
    closes = {d: 10.0 for d in CAL[:100]}
    assert stats.series_ended(CAL, closes) == CAL[99]
    assert stats.series_ended(CAL, {d: 10.0 for d in CAL[:-3]}) is None, "a few sessions behind is a lag"
    assert stats.series_ended(CAL, dict(UP)) is None
    assert stats.series_ended(CAL, {}) is None


def test_a_delisted_ticker_leaves_the_pending_count_and_never_warns(conn):
    f = _filing(conn, "1", "2026-03-20")
    _rows(conn, f, [{"ticker": "GONE", "tx_date": "2026-03-02"}])
    i0 = CAL.index("2026-03-02")
    # Trades for 45 sessions after the buy, then stops (an acquisition).
    gone = {d: 20.0 + i for i, d in enumerate(CAL[: i0 + 45])}
    client = FakeClient({"SPY": SPY, "GONE": gone})
    track.sync(conn, _config(), client=client, now=_now("2026-10-23"))
    row = conn.execute("SELECT * FROM track_decisions WHERE ticker = 'GONE'").fetchone()
    assert row["exclusion"] is None and row["series_ended"] == CAL[i0 + 44]
    assert row["signed_trade_30"] is not None and row["signed_trade_90"] is None
    coverage = {r["outcome"]: (r["rows"], r["decisions"])
                for r in conn.execute("SELECT * FROM track_coverage")}
    assert coverage["series_ended"] == (1, 1) and coverage["included"] == (1, 1)
    assert [f.code for f in audit.check_track_record(conn, date(2026, 10, 26))] == \
        ["track_record_coverage"]


def test_the_stale_warning_names_the_ticker_and_the_member(conn):
    _seed(conn)
    track.sync(conn, _config(), client=FakeClient({"SPY": SPY}, fail={"SPY": PricesBlocked("w")}),
               now=_now("2026-10-23"))
    found = {f.code: f for f in audit.check_track_record(conn, date(2026, 10, 26))}
    stale = found["track_record_stale"]
    assert any(e.startswith("UP (Jane Doe): traded 2026-03-02") for e in stale.evidence)
    assert any(e.startswith("DOWN (John Roe): traded 2026-06-01") for e in stale.evidence)
