"""What an alerted ticker did next (#53): the measurement and its aggregate.

An outcome is the ticker's own close-to-close move at +5/+20/+60 trading days
after the alert, minus the benchmark over the same sessions. It is derived
once in Python, stored in `alert_outcomes`, and read — never re-derived — by
the CLI and the dashboard. It is a ticker's move, not a trade's return: no
bracket enters it.
"""

from datetime import date, timedelta

import pytest

from whale import audit, db, prices, query, stats

LABOR_DAY = date(2026, 9, 7)


def _sessions():
    d = date(2026, 9, 1)
    while d <= date(2026, 10, 16):
        if d.weekday() < 5 and d != LABOR_DAY:
            yield d.isoformat()
        d += timedelta(days=1)


# 33 sessions — the same count the real Yahoo fixture carries for the range.
CAL = list(_sessions())
SPY = [100.0 + i for i in range(len(CAL))]
AAA = [50.0 + 2 * i for i in range(len(CAL))]   # outruns the benchmark
BBB = [200.0 - i for i in range(len(CAL))]      # falls while the benchmark rises


@pytest.fixture
def conn(tmp_path):
    c = db.connect(tmp_path / "t.sqlite3")
    yield c
    c.close()


def _series(conn, ticker, closes, skip=()):
    db.upsert_prices(conn, ticker, "test",
                     [(d, c) for d, c in zip(CAL, closes) if d not in skip])
    conn.commit()


def _alert(conn, ticker, direction="buy", fired_at="2026-09-07T14:20:12Z",
           kind=stats.CLUSTER_KIND):
    alert_id = db.record_alert(conn, kind, ticker, direction, 90, 3)
    conn.execute("UPDATE alerts SET fired_at = ? WHERE id = ?", (fired_at, alert_id))
    conn.commit()
    return alert_id


def _by_id(outcomes):
    return {o.alert_id: o for o in outcomes}


# --- the measurement ------------------------------------------------------------


def test_the_alert_date_is_the_market_date_not_the_utc_one():
    assert stats.alert_date_eastern("2026-09-07T14:20:12Z") == LABOR_DAY
    # 01:00Z on the 10th is 21:00 on the 9th in New York: the alert went
    # out after the 9th's close, so the 9th is day 0.
    assert stats.alert_date_eastern("2026-09-10T01:00:00Z") == date(2026, 9, 9)
    assert stats.alert_date_eastern("2026-09-10 01:00:00") == date(2026, 9, 9)


def test_returns_are_close_to_close_from_the_first_session_on_or_after_the_alert(conn):
    _series(conn, "SPY", SPY)
    _series(conn, "AAA", AAA)
    holiday = _alert(conn, "AAA")                                      # Labor Day
    evening = _alert(conn, "AAA", fired_at="2026-09-10T01:00:00Z")      # Wed 21:00 ET
    weekend = _alert(conn, "AAA", fired_at="2026-09-12T15:00:00Z")      # Saturday
    out = _by_id(stats.alert_outcomes(conn))

    o = out[holiday]
    assert o.t0_date == "2026-09-08" and o.t0_close == AAA[4]
    i0 = CAL.index("2026-09-08")
    assert o.returns[5] == pytest.approx(AAA[i0 + 5] / AAA[i0] - 1)
    assert o.benchmark[5] == pytest.approx(SPY[i0 + 5] / SPY[i0] - 1)
    assert o.excess[5] == pytest.approx(o.returns[5] - o.benchmark[5])
    assert o.returns[20] == pytest.approx(AAA[i0 + 20] / AAA[i0] - 1)
    # 60 sessions after t0 do not exist yet: pending, not zero.
    assert o.returns[60] is None and o.benchmark[60] is None and o.excess[60] is None
    assert o.days_elapsed == len(CAL) - 1 - i0

    assert out[evening].t0_date == "2026-09-09", "the market date, not the UTC date"
    assert out[weekend].t0_date == "2026-09-14"


def test_what_cannot_be_measured_has_no_outcome(conn):
    _series(conn, "SPY", SPY)
    _series(conn, "AAA", AAA)
    # A series that ends before the alert, and one with a hole at a horizon.
    _series(conn, "CCC", AAA, skip=set(CAL[5:]))
    i0 = CAL.index("2026-09-08")
    _series(conn, "DDD", AAA, skip={CAL[i0 + 5]})
    measured = _alert(conn, "AAA")
    ended = _alert(conn, "CCC", fired_at="2026-09-10T14:00:00Z")
    hole = _alert(conn, "DDD")
    no_series = _alert(conn, "ZZZ")
    cik = _alert(conn, "0001742952", kind=stats.INSIDER_CLUSTER_KIND)
    none = _alert(conn, None, None, kind=stats.FILING_KIND)
    future = _alert(conn, "AAA", fired_at="2026-10-17T14:00:00Z")

    out = _by_id(stats.alert_outcomes(conn))
    assert set(out) == {measured, hole}
    for missing in (ended, no_series, cik, none, future):
        assert missing not in out
    # The hole: the benchmark has that session, the ticker does not. The
    # return is unknown there and known again at the next horizon.
    assert out[hole].returns[5] is None and out[hole].excess[5] is None
    assert out[hole].benchmark[5] is not None
    assert out[hole].returns[20] is not None


def test_without_a_benchmark_series_nothing_is_measured(conn):
    _series(conn, "AAA", AAA)
    _alert(conn, "AAA")
    assert stats.alert_outcomes(conn) == []


def test_outcomes_are_stored_once_and_rebuilt_from_scratch(conn):
    _series(conn, "SPY", SPY)
    _series(conn, "AAA", AAA)
    _series(conn, "BBB", BBB)
    a = _alert(conn, "AAA")
    b = _alert(conn, "BBB", "sell")
    assert prices.recompute_outcomes(conn) == 2
    rows = {r["alert_id"]: dict(r) for r in conn.execute("SELECT * FROM alert_outcomes")}
    expected = _by_id(stats.alert_outcomes(conn))
    for alert_id, row in rows.items():
        for col in db.OUTCOME_COLUMNS:
            assert row[col] == pytest.approx(expected[alert_id].row()[col]), col
    assert rows[b]["excess_5"] < 0 < rows[a]["excess_5"]
    assert rows[a]["ret_60"] is None and rows[a]["computed_at"]

    # Idempotent, and an alert that can no longer be measured loses its row.
    assert prices.recompute_outcomes(conn) == 2
    conn.execute("DELETE FROM prices WHERE ticker = 'BBB'")
    assert prices.recompute_outcomes(conn) == 1
    assert [r[0] for r in conn.execute("SELECT alert_id FROM alert_outcomes")] == [a]


# --- the aggregate ----------------------------------------------------------------
#
# Hand-made figures, shared with web/lib/outcome-queries.test.ts so the two
# aggregations are checked against the same expectations.

SUMMARY_ROWS = [
    # (kind, direction, excess_5, excess_20, excess_60)
    (stats.CLUSTER_KIND, "buy", 0.02, 0.05, None),
    (stats.CLUSTER_KIND, "buy", -0.01, 0.01, None),
    (stats.CLUSTER_KIND, "sell", -0.03, 0.02, None),   # a fall: the sell was right
    (stats.CLUSTER_KIND, "sell", 0.00, None, None),    # flat: not a hit
    (stats.CLUSTER_KIND, "buy", 0.04, None, None),
    (stats.CLUSTER_KIND, None, 0.10, 0.10, 0.10),      # both sides: no claim, excluded
    (stats.INSIDER_CLUSTER_KIND, "buy", 0.01, None, None),
]


def _seed_summary(conn):
    rows = []
    for kind, direction, e5, e20, e60 in SUMMARY_ROWS:
        alert_id = _alert(conn, "TKR", direction, kind=kind)
        rows.append({"alert_id": alert_id, "ticker": "TKR", "t0_date": "2026-09-08",
                     "t0_close": 100.0, "days_elapsed": 28,
                     "ret_5": e5, "bench_5": 0.0, "excess_5": e5,
                     "ret_20": e20, "bench_20": 0.0, "excess_20": e20,
                     "ret_60": e60, "bench_60": 0.0, "excess_60": e60})
    db.replace_alert_outcomes(conn, rows)
    conn.commit()


def test_signed_excess_reads_the_move_the_way_the_alert_pointed():
    assert stats.signed_excess(0.02, "buy") == 0.02
    assert stats.signed_excess(0.02, "sell") == -0.02
    assert stats.signed_excess(-0.03, "sell") == 0.03
    assert stats.signed_excess(0.02, None) is None
    assert stats.signed_excess(None, "buy") is None


def test_the_summary_is_per_kind_and_horizon_with_the_sample_next_to_every_figure(conn):
    _seed_summary(conn)
    rows = {(r.kind, r.horizon): r for r in stats.outcome_summary(conn)}
    assert [k for k in dict.fromkeys(k for k, _ in rows)] == [
        stats.CLUSTER_KIND, stats.INSIDER_CLUSTER_KIND]

    c5 = rows[(stats.CLUSTER_KIND, 5)]
    # Signed: 0.02, -0.01, +0.03, 0.00, 0.04 → median 0.02, three above zero.
    assert c5.n == 5 and c5.median_excess == pytest.approx(0.02)
    assert c5.hit_rate == pytest.approx(0.6) and c5.sufficient

    c20 = rows[(stats.CLUSTER_KIND, 20)]
    # Signed: 0.05, 0.01, -0.02 → three alerts: reported, but not sufficient.
    assert c20.n == 3 and c20.median_excess == pytest.approx(0.01)
    assert c20.hit_rate == pytest.approx(2 / 3) and not c20.sufficient

    c60 = rows[(stats.CLUSTER_KIND, 60)]
    assert (c60.n, c60.median_excess, c60.hit_rate) == (0, None, None)

    i5 = rows[(stats.INSIDER_CLUSTER_KIND, 5)]
    assert (i5.n, i5.median_excess, i5.hit_rate, i5.sufficient) == (1, 0.01, 1.0, False)


def test_the_cli_table_labels_small_samples_as_insufficient(conn, capsys):
    _seed_summary(conn)
    _series(conn, "SPY", SPY)
    query.print_outcome_summary(conn)
    out = capsys.readouterr().out
    assert "7 of 7 alert(s) have a close at t0" in out
    assert "SPY closes through 2026-10-16" in out
    assert "+2.0% · 60% hit · n=5" in out
    assert "insufficient data (n=3)" in out and "insufficient data (n=1)" in out


# --- the audit ------------------------------------------------------------------

TODAY = date(2026, 10, 16)


def test_the_audit_is_silent_without_alerts(conn):
    assert audit.check_price_coverage(conn, TODAY) == []


def test_the_audit_reports_coverage_and_does_not_warn_on_fresh_series(conn):
    _series(conn, "SPY", SPY)
    _series(conn, "AAA", AAA)
    _alert(conn, "AAA")
    _alert(conn, "ZZZ")
    _alert(conn, None, None, kind=stats.FILING_KIND)
    prices.recompute_outcomes(conn)
    db.set_state(conn, prices.STATE_STATUS, "ok: 2 ticker(s) refreshed, 1 outcome(s)")
    (finding,) = audit.check_price_coverage(conn, TODAY)
    assert finding.severity == audit.INFO and finding.code == "price_coverage"
    assert finding.title.startswith("1 of 3 alert(s) have a close at t0 (2 name a listed ticker)")
    assert "source status: ok: 2 ticker(s) refreshed" in finding.evidence[0]
    assert "SPY closes through 2026-10-16" in finding.evidence[1]
    assert "no price series: ZZZ" in finding.evidence[2]


def test_a_series_the_step_stopped_refreshing_warns(conn):
    # SPY ends on 2026-10-01: eleven sessions ago on the 16th, and nothing
    # has asked for it since the 2nd — the step is not running or is walled.
    _series(conn, "SPY", SPY, skip=set(CAL[CAL.index("2026-10-02"):]))
    _alert(conn, "AAA")
    db.record_price_fetch(conn, "SPY", "ok", 22, "2026-10-01")
    conn.execute("UPDATE price_fetches SET fetched_at = '2026-10-02T00:05:00Z'")
    db.set_state(conn, prices.STATE_STATUS, "blocked: Stooq served a browser-verification page")
    conn.commit()
    info, warn = audit.check_price_coverage(conn, TODAY)
    assert warn.code == "prices_stale" and warn.severity == audit.WARN
    assert warn.evidence == ["SPY  newest close 2026-10-01 (10 trading days ago)  last fetch 2026-10-02 ok"]
    assert "blocked:" in info.evidence[0]

    # Never asked at all is the same fault.
    conn.execute("DELETE FROM price_fetches")
    conn.commit()
    _, warn = audit.check_price_coverage(conn, TODAY)
    assert warn.evidence[0].endswith("last fetch never")


def test_a_series_the_source_has_stopped_serving_is_evidence_not_a_warning(conn):
    _series(conn, "SPY", SPY)
    _series(conn, "AAA", AAA, skip=set(CAL[CAL.index("2026-10-02"):]))   # acquired, say
    _alert(conn, "AAA")
    db.record_price_fetch(conn, "SPY", "ok", 33, "2026-10-16")
    db.record_price_fetch(conn, "AAA", "no_data", 0, None)
    conn.execute("UPDATE price_fetches SET fetched_at = '2026-10-16T00:05:00Z'")
    conn.commit()
    (info,) = audit.check_price_coverage(conn, TODAY)
    assert any(e.startswith("series ended at the source (1): AAA newest close 2026-10-01")
               for e in info.evidence)


def test_a_fresh_series_that_merely_spans_a_holiday_weekend_is_not_stale(conn):
    # Newest close Friday 2026-10-09, checked on Tuesday the 13th: Columbus
    # Day on the 12th is a federal holiday, so that is one business day.
    _series(conn, "SPY", SPY, skip=set(CAL[CAL.index("2026-10-12"):]))
    _alert(conn, "AAA")
    assert [f.code for f in audit.check_price_coverage(conn, date(2026, 10, 13))] == ["price_coverage"]


def test_the_check_sits_right_after_alert_recording():
    assert audit.CHECKS.index(audit.check_price_coverage) \
        == audit.CHECKS.index(audit.check_alert_recording) + 1
