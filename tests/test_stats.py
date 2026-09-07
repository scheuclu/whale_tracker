"""Aggregation and cluster detection — the tracker's actual output."""

from datetime import date

import pytest

from whale import db, stats
from whale.config import AlertSettings

TODAY = date(2026, 7, 1)


def _member(conn, bioguide, name, party="D", state="CA", district="1"):
    return db.upsert_politician(conn, bioguide_id=bioguide, full_name=name,
                                first=name.split()[0], last=name.split()[-1],
                                chamber="house", party=party, state=state,
                                district=district, active=1)


def _filing(conn, politician_id, name, status="backfilled", doc_id=None):
    return db.insert_filing(
        conn, chamber="house", doc_id=doc_id or f"d{politician_id}-{status}-{name}",
        politician_id=politician_id, filer_name=name, state_district="CA01",
        filing_type="P", filing_date="2026-06-20", year=2026,
        pdf_url="http://example/x.pdf", status=status)


def _tx(ticker, action, lo, hi, tx_date="2026-06-15", asset_type="ST", exact=None):
    return {"ticker": ticker, "action": action, "asset_name": f"{ticker} Inc.",
            "asset_type": asset_type, "tx_date": tx_date,
            "notification_date": "2026-06-20", "amount_min_cents": lo,
            "amount_max_cents": hi, "amount_exact_cents": exact}


@pytest.fixture
def conn(tmp_path):
    c = db.connect(tmp_path / "t.sqlite3")
    yield c
    c.close()


def _seed(conn, spec):
    """spec: list of (member_name, [transactions]) -> stored as parsed filings.

    Keyed by member name so a second _seed call in the same test adds members
    rather than colliding with the first call's doc ids.
    """
    for name, txs in spec:
        pid = _member(conn, f"X-{name}", name)
        fid = _filing(conn, pid, name, doc_id=f"doc-{name}")
        db.replace_transactions(conn, fid, pid, txs)
    conn.commit()


def test_counts_distinct_politicians_not_trades(conn):
    # One member trading NVDA five times is not five politicians.
    _seed(conn, [("Alice A", [_tx("NVDA", "purchase", 100_100, 1_500_000)] * 5)])
    s = stats.ticker_stats(conn, today=TODAY)["NVDA"]
    assert s.trade_count == 5
    assert s.politician_count == 1


def test_aggregates_volume_as_a_range_with_midpoint(conn):
    _seed(conn, [
        ("Alice A", [_tx("NVDA", "purchase", 100_100, 1_500_000)]),
        ("Bob B", [_tx("NVDA", "purchase", 1_500_100, 5_000_000)]),
    ])
    s = stats.ticker_stats(conn, today=TODAY)["NVDA"]
    assert s.volume.min_cents == 100_100 + 1_500_100
    assert s.volume.max_cents == 1_500_000 + 5_000_000
    assert s.volume.mid_cents == 800_050 + 3_250_050
    assert s.politician_count == 2


def test_open_ended_bracket_makes_total_open_ended(conn):
    # A total containing "Over $50,000,000" has no upper bound; reporting one
    # would invent money that was never disclosed.
    _seed(conn, [
        ("Alice A", [_tx("NVDA", "purchase", 100_100, 1_500_000)]),
        ("Bob B", [_tx("NVDA", "purchase", 5_000_000_000, None)]),
    ])
    s = stats.ticker_stats(conn, today=TODAY)["NVDA"]
    assert s.volume.open_ended is True
    assert s.volume.max_cents is None
    assert s.volume.min_cents == 100_100 + 5_000_000_000


def test_exact_amounts_contribute_precisely(conn):
    _seed(conn, [("Alice A", [_tx("ICHR", "sale", 272_250, 272_250, exact=272_250)])])
    s = stats.ticker_stats(conn, today=TODAY)["ICHR"]
    assert s.volume.mid_cents == 272_250


def test_buy_and_sell_are_tracked_separately(conn):
    _seed(conn, [
        ("Alice A", [_tx("NVDA", "purchase", 100_100, 1_500_000)]),
        ("Bob B", [_tx("NVDA", "sale", 100_100, 1_500_000)]),
        ("Cara C", [_tx("NVDA", "sale_partial", 100_100, 1_500_000)]),
    ])
    s = stats.ticker_stats(conn, today=TODAY)["NVDA"]
    assert s.buy_count == 1 and s.sell_count == 2
    assert s.buy_politicians == {"Alice A"}
    assert s.sell_politicians == {"Bob B", "Cara C"}
    assert s.net_direction == "sell"


def test_window_excludes_older_trades(conn):
    _seed(conn, [
        ("Alice A", [_tx("NVDA", "purchase", 100_100, 1_500_000, tx_date="2026-06-25")]),
        ("Bob B", [_tx("NVDA", "purchase", 100_100, 1_500_000, tx_date="2026-01-05")]),
    ])
    assert stats.ticker_stats(conn, 30, today=TODAY)["NVDA"].politician_count == 1
    assert stats.ticker_stats(conn, today=TODAY)["NVDA"].politician_count == 2


def test_unparsed_filings_are_excluded_from_stats(conn):
    pid = _member(conn, "X1", "Alice A")
    good = _filing(conn, pid, "Alice A", status="notified", doc_id="g")
    bad = _filing(conn, pid, "Alice A", status="failed", doc_id="b")
    db.replace_transactions(conn, good, pid, [_tx("NVDA", "purchase", 100_100, 1_500_000)])
    db.replace_transactions(conn, bad, pid, [_tx("NVDA", "purchase", 100_100, 1_500_000)])
    conn.commit()
    assert stats.ticker_stats(conn, today=TODAY)["NVDA"].trade_count == 1


def test_reparsing_a_filing_does_not_double_count(conn):
    pid = _member(conn, "X1", "Alice A")
    fid = _filing(conn, pid, "Alice A")
    txs = [_tx("NVDA", "purchase", 100_100, 1_500_000)]
    db.replace_transactions(conn, fid, pid, txs)
    db.replace_transactions(conn, fid, pid, txs)   # e.g. after a parser fix
    conn.commit()
    assert stats.ticker_stats(conn, today=TODAY)["NVDA"].trade_count == 1


# --- clusters ---------------------------------------------------------------

SETTINGS = AlertSettings(window_days=30, min_politicians=3, min_volume_usd=500_000)


def test_cluster_fires_on_participation(conn):
    _seed(conn, [(f"M{i}", [_tx("NVDA", "purchase", 100_100, 1_500_000)]) for i in range(3)])
    clusters = stats.find_clusters(conn, SETTINGS, today=TODAY)
    assert len(clusters) == 1
    assert clusters[0].ticker == "NVDA"
    assert clusters[0].direction == "buy"
    assert clusters[0].politician_count == 3


def test_no_cluster_below_threshold(conn):
    _seed(conn, [(f"M{i}", [_tx("NVDA", "purchase", 100_100, 1_500_000)]) for i in range(2)])
    assert stats.find_clusters(conn, SETTINGS, today=TODAY) == []


def test_cluster_fires_on_volume_alone(conn):
    # One member, but well past the volume threshold.
    _seed(conn, [("Whale W", [_tx("NVDA", "purchase", 100_000_000, 200_000_000)])])
    clusters = stats.find_clusters(conn, SETTINGS, today=TODAY)
    assert len(clusters) == 1 and "volume" in clusters[0].reason


def test_buys_and_sells_do_not_pool_into_one_cluster(conn):
    _seed(conn, [
        ("A", [_tx("NVDA", "purchase", 100_100, 1_500_000)]),
        ("B", [_tx("NVDA", "purchase", 100_100, 1_500_000)]),
        ("C", [_tx("NVDA", "sale", 100_100, 1_500_000)]),
    ])
    # 3 members touched NVDA, but only 2 bought and 1 sold: no consensus.
    assert stats.find_clusters(conn, SETTINGS, today=TODAY) == []


def test_treasury_rollovers_do_not_cluster(conn):
    # [GS] is excluded: members roll T-bills constantly and it is not a signal.
    _seed(conn, [
        (f"M{i}", [_tx("TBILL", "purchase", 1_500_100, 5_000_000, asset_type="GS")])
        for i in range(5)
    ])
    assert stats.find_clusters(conn, SETTINGS, today=TODAY) == []


def test_cluster_dedupe_suppresses_repeat_and_allows_growth(conn):
    _seed(conn, [(f"M{i}", [_tx("NVDA", "purchase", 100_100, 1_500_000)]) for i in range(3)])
    cluster = stats.find_clusters(conn, SETTINGS, today=TODAY)[0]
    assert stats.is_new_cluster(conn, cluster) is True

    db.record_alert(conn, "cluster", "NVDA", "buy", 30, 3, cluster.volume.mid_cents)
    conn.commit()
    # Same three members on the next run: already reported.
    assert stats.is_new_cluster(conn, cluster) is False

    # A fourth member joins: worth re-alerting.
    _seed(conn, [("M9", [_tx("NVDA", "purchase", 100_100, 1_500_000)])])
    grown = stats.find_clusters(conn, SETTINGS, today=TODAY)[0]
    assert grown.politician_count == 4
    assert stats.is_new_cluster(conn, grown) is True


# --- politician rollups -----------------------------------------------------


def test_disclosure_delay_and_late_flagging(conn):
    pid = _member(conn, "X1", "Slow S")
    fid = _filing(conn, pid, "Slow S")
    db.replace_transactions(conn, fid, pid, [
        {**_tx("NVDA", "purchase", 100_100, 1_500_000, tx_date="2026-01-01"),
         "notification_date": "2026-03-15"},   # 73 days — past the 45-day limit
        {**_tx("AAPL", "purchase", 100_100, 1_500_000, tx_date="2026-06-01"),
         "notification_date": "2026-06-11"},   # 10 days — compliant
    ])
    conn.commit()
    row = stats.politician_stats(conn)[0]
    assert row["late_count"] == 1
    assert row["avg_delay_days"] == pytest.approx(41.5)
    assert row["ticker_count"] == 2


def test_disclosure_delay_handles_missing_dates():
    assert stats.disclosure_delay_days(None, "2026-01-01") is None
    assert stats.disclosure_delay_days("2026-01-01", None) is None
    assert stats.disclosure_delay_days("2026-01-01", "2026-02-15") == 45


def test_contradictory_filed_dates_report_no_delay():
    # A real 2026 filing reports a trade on 12/26/2026 disclosed on 01/21/2026 —
    # the filer mistyped the year. Reproducing that as "-339 days" would present
    # a typo as a finding, so the delay is unknown instead.
    assert stats.disclosure_delay_days("2026-12-26", "2026-01-21") is None
    assert stats.dates_inconsistent("2026-12-26", "2026-01-21") is True
    assert stats.dates_inconsistent("2026-01-21", "2026-12-26") is False
    assert stats.dates_inconsistent(None, "2026-01-21") is False


def test_future_dated_trade_is_excluded_from_rolling_windows(conn):
    # A mistyped future trade date would otherwise sit inside every rolling
    # window forever, permanently inflating "the last 30 days".
    _seed(conn, [
        ("Typo T", [_tx("NVDA", "purchase", 100_100, 1_500_000, tx_date="2026-12-26")]),
        ("Real R", [_tx("NVDA", "purchase", 100_100, 1_500_000, tx_date="2026-06-25")]),
    ])
    windowed = stats.ticker_stats(conn, 30, today=TODAY)["NVDA"]
    assert windowed.trade_count == 1
    assert windowed.buy_politicians == {"Real R"}
    # Unwindowed totals still report everything that was filed.
    assert stats.ticker_stats(conn, today=TODAY)["NVDA"].trade_count == 2
