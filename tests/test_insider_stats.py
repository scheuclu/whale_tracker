"""Insider aggregation: exact values, primary-owner counting, the 2-day clock."""

from datetime import date

import pytest

from whale import db, stats
from whale.config import InsiderSettings

TODAY = date(2026, 9, 13)


@pytest.fixture
def conn(tmp_path):
    c = db.connect(tmp_path / "t.sqlite3")
    yield c
    c.close()


def _filing(conn, accession, issuer="0000000001", ticker="ACME", owners=(("0000000010", "Alice"),),
            filing_date="2026-09-10", status="backfilled"):
    fid = db.insert_insider_filing(
        conn, accession=accession, form_type="4", issuer_cik=issuer, issuer_name=f"{ticker} Corp",
        ticker=ticker, filing_date=filing_date, source="feed", source_url="u", status=status)
    for cik, name in owners:
        db.upsert_insider(conn, cik, name)
    db.replace_insider_owners(conn, fid, [{"cik": cik} for cik, _ in owners])
    return fid


def _tx(action, value_cents, tx_date="2026-09-08", late=0):
    return {"transaction_code": "P" if action == "purchase" else "S", "action": action,
            "tx_date": tx_date, "amount_min_cents": value_cents, "amount_max_cents": value_cents,
            "amount_exact_cents": value_cents, "late": late}


def _seed(conn, spec):
    """spec: list of (accession, owners, [transactions], ticker)."""
    for i, (accession, owners, txs, ticker) in enumerate(spec):
        fid = _filing(conn, accession, issuer=f"{hash(ticker) % 10**9:010d}", ticker=ticker, owners=owners)
        db.replace_insider_transactions(conn, fid, txs)
    conn.commit()


# --- the two-business-day clock ----------------------------------------------


def test_federal_holidays_are_observed_dates():
    holidays = stats.federal_holidays(2026)
    assert date(2026, 7, 3) in holidays      # July 4th falls on a Saturday
    assert date(2026, 7, 4) not in holidays
    assert date(2026, 9, 7) in holidays      # Labor Day
    assert date(2026, 11, 26) in holidays    # Thanksgiving
    assert date(2026, 1, 19) in holidays     # MLK Day
    assert len(holidays) == 11


def test_form4_is_late_counts_business_days():
    assert stats.form4_is_late("2026-09-11", "2026-09-15") is False  # Fri -> Tue
    assert stats.form4_is_late("2026-09-11", "2026-09-16") is True   # Fri -> Wed
    assert stats.form4_is_late("2026-09-08", "2026-09-10") is False  # Tue -> Thu
    assert stats.form4_is_late("2026-09-08", "2026-09-11") is True


def test_form4_is_late_skips_federal_holidays():
    # Labor Day 2026-09-07: Friday's trade is due Wednesday, not Tuesday.
    assert stats.form4_is_late("2026-09-04", "2026-09-09") is False
    assert stats.form4_is_late("2026-09-04", "2026-09-10") is True


def test_form4_is_late_is_unknown_for_bad_dates():
    assert stats.form4_is_late("2026-09-11", "2026-09-01") is None  # contradictory, as filed
    assert stats.form4_is_late(None, "2026-09-01") is None
    assert stats.form4_is_late("garbage", "2026-09-01") is None


# --- issuer rollups ----------------------------------------------------------


def test_values_are_exact_and_sum_per_direction(conn):
    _seed(conn, [
        ("a-1", (("0000000010", "Alice"),), [_tx("purchase", 100_000), _tx("purchase", 50_000)], "ACME"),
        ("a-2", (("0000000011", "Bob"),), [_tx("sale", 70_000)], "ACME"),
    ])
    (s,) = stats.insider_issuer_stats(conn, today=TODAY).values()
    assert s.ticker == "ACME" and s.filing_count == 2 and s.trade_count == 3
    assert (s.buy_count, s.sell_count) == (2, 1)
    assert s.buy_volume.mid_cents == 150_000 and s.buy_volume.max_cents == 150_000
    assert s.sell_volume.mid_cents == 70_000
    assert s.volume.open_ended is False  # exact figures never open a range
    assert s.insider_count == 2
    assert s.names(s.buy_insiders) == ["Alice"] and s.names(s.sell_insiders) == ["Bob"]


def test_a_joint_filing_is_one_insider(conn):
    _seed(conn, [("j-1", (("0000000010", "Founder"), ("0000000020", "Founder Holdings LLC")),
                  [_tx("purchase", 100_000)], "ACME")])
    (s,) = stats.insider_issuer_stats(conn, today=TODAY).values()
    assert s.insider_count == 1 and s.buy_insiders == {"0000000010"}


def test_a_row_without_a_price_counts_as_a_trade_but_adds_no_value(conn):
    _seed(conn, [("a-1", (("0000000010", "Alice"),), [_tx("sale", 70_000), _tx("sale", None)], "ACME")])
    (s,) = stats.insider_issuer_stats(conn, today=TODAY).values()
    assert s.sell_count == 2
    assert s.sell_volume.mid_cents == 70_000
    assert s.sell_volume.max_cents == 70_000 and s.sell_volume.open_ended is False


def test_window_is_bounded_at_both_ends(conn):
    _seed(conn, [
        ("a-1", (("0000000010", "Alice"),), [_tx("purchase", 100_000, tx_date="2026-09-08")], "ACME"),
        ("a-2", (("0000000011", "Bob"),), [_tx("purchase", 100_000, tx_date="2026-06-01")], "ACME"),
        ("a-3", (("0000000012", "Cat"),), [_tx("purchase", 100_000, tx_date="2027-09-08")], "ACME"),  # typo'd year
    ])
    (s,) = stats.insider_issuer_stats(conn, 30, today=TODAY).values()
    assert s.buy_insiders == {"0000000010"}
    everything = stats.insider_issuer_stats(conn, today=TODAY)
    assert next(iter(everything.values())).trade_count == 3


def test_failed_filings_contribute_nothing(conn):
    fid = _filing(conn, "f-1", status="failed")
    db.replace_insider_transactions(conn, fid, [_tx("purchase", 100_000)])
    conn.commit()
    assert stats.insider_issuer_stats(conn, today=TODAY) == {}


def test_leaderboard_orders_by_value_or_insiders(conn):
    _seed(conn, [
        ("a-1", (("0000000010", "A"),), [_tx("purchase", 900_000)], "BIG"),
        ("b-1", (("0000000011", "B"),), [_tx("purchase", 10_000)], "MANY"),
        ("b-2", (("0000000012", "C"),), [_tx("purchase", 10_000)], "MANY"),
        ("b-3", (("0000000013", "D"),), [_tx("sale", 10_000)], "MANY"),
    ])
    assert [s.ticker for s in stats.top_insider_issuers(conn, by="value", today=TODAY)] == ["BIG", "MANY"]
    assert [s.ticker for s in stats.top_insider_issuers(conn, by="insiders", today=TODAY)] == ["MANY", "BIG"]
    sells = stats.top_insider_issuers(conn, direction="sell", today=TODAY)
    assert [s.ticker for s in sells] == ["MANY"]


# --- clusters ----------------------------------------------------------------


def _settings(**kw):
    return InsiderSettings(**{"cluster_window_days": 30, "min_insiders": 3, **kw})


def test_cluster_needs_three_primary_owners_in_one_direction(conn):
    _seed(conn, [
        ("c-1", (("0000000010", "A"),), [_tx("purchase", 10_000)], "ACME"),
        ("c-2", (("0000000011", "B"),), [_tx("purchase", 10_000)], "ACME"),
        ("c-3", (("0000000012", "C"),), [_tx("purchase", 10_000)], "ACME"),
    ])
    (c,) = stats.find_insider_clusters(conn, _settings(), today=TODAY)
    assert (c.ticker, c.direction, c.insider_count, c.filing_count) == ("ACME", "buy", 3, 3)
    assert c.insiders == ["A", "B", "C"]
    assert c.volume.mid_cents == 30_000


def test_two_insiders_are_not_a_cluster(conn):
    _seed(conn, [
        ("c-1", (("0000000010", "A"),), [_tx("purchase", 10_000)] * 5, "ACME"),
        ("c-2", (("0000000011", "B"),), [_tx("purchase", 10_000)], "ACME"),
    ])
    assert stats.find_insider_clusters(conn, _settings(), today=TODAY) == []


def test_a_joint_filer_does_not_supply_the_third_insider(conn):
    _seed(conn, [
        ("c-1", (("0000000010", "A"), ("0000000099", "A's LLC")), [_tx("purchase", 10_000)], "ACME"),
        ("c-2", (("0000000011", "B"),), [_tx("purchase", 10_000)], "ACME"),
    ])
    assert stats.find_insider_clusters(conn, _settings(), today=TODAY) == []


def test_buys_and_sells_never_pool(conn):
    _seed(conn, [
        ("c-1", (("0000000010", "A"),), [_tx("purchase", 10_000)], "ACME"),
        ("c-2", (("0000000011", "B"),), [_tx("purchase", 10_000)], "ACME"),
        ("c-3", (("0000000012", "C"),), [_tx("sale", 10_000)], "ACME"),
    ])
    assert stats.find_insider_clusters(conn, _settings(), today=TODAY) == []
    assert len(stats.find_insider_clusters(conn, _settings(min_insiders=2), today=TODAY)) == 1


def test_cluster_window_is_on_trade_date(conn):
    _seed(conn, [
        ("c-1", (("0000000010", "A"),), [_tx("purchase", 10_000, tx_date="2026-07-01")], "ACME"),
        ("c-2", (("0000000011", "B"),), [_tx("purchase", 10_000)], "ACME"),
        ("c-3", (("0000000012", "C"),), [_tx("purchase", 10_000)], "ACME"),
    ])
    assert stats.find_insider_clusters(conn, _settings(), today=TODAY) == []
    assert len(stats.find_insider_clusters(conn, _settings(cluster_window_days=90), today=TODAY)) == 1
