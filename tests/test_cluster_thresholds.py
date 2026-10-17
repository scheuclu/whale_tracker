"""Cluster alerts need both thresholds, and a member must clear a bracket floor.

The rule used to be `min_politicians OR min_volume_usd`, and 32 of the first
33 alerts it sent were noise: 29 were three or more members each trading
$1,001–$15,000 of a mega-cap (83% of equity-like rows are in that bracket),
and 3 were a single member's large trade described as "1 politicians bought".
These tests pin the replacement: both thresholds, a per-member floor summed
over bracket FLOORS (never midpoints), and no single-member cluster.
"""

from datetime import date
from pathlib import Path

import pytest

from whale import db, pipeline, stats, telegram
from whale.config import AlertSettings, Config, ConfigError, load_config
from whale.stats import Cluster, Volume

TODAY = date(2026, 7, 1)
SETTINGS = AlertSettings(window_days=90, min_politicians=3, min_volume_usd=500_000,
                         min_member_floor_usd=15_001)

# Brackets, in cents, as the House form offers them.
LOWEST = (100_100, 1_500_000)          # $1,001–$15,000
SECOND = (1_500_100, 5_000_000)        # $15,001–$50,000
MID = (10_000_100, 25_000_000)         # $100,001–$250,000
LARGE = (25_000_100, 50_000_000)       # $250,001–$500,000
WHALE = (50_000_100, 100_000_000)      # $500,001–$1,000,000


@pytest.fixture
def conn(tmp_path):
    c = db.connect(tmp_path / "t.sqlite3")
    yield c
    c.close()


def _tx(ticker, action, lo, hi, exact=None, tx_date="2026-06-15"):
    return {"ticker": ticker, "action": action, "asset_name": f"{ticker} Inc.",
            "asset_type": "ST", "tx_date": tx_date, "notification_date": tx_date,
            "amount_min_cents": lo, "amount_max_cents": hi, "amount_exact_cents": exact}


def _seed(conn, spec):
    """spec: list of (member_name, [transactions]) stored as backfilled filings."""
    for name, txs in spec:
        pid = db.upsert_politician(conn, bioguide_id=f"X-{name}", full_name=name,
                                   first=name.split()[0], last=name.split()[-1],
                                   chamber="house", party="D", state="CA",
                                   district="1", active=1)
        fid = db.insert_filing(conn, chamber="house", doc_id=f"doc-{name}",
                               politician_id=pid, filer_name=name, state_district="CA01",
                               filing_type="P", filing_date="2026-06-20", year=2026,
                               pdf_url="http://example/x.pdf", status="backfilled")
        db.replace_transactions(conn, fid, pid, txs)
    conn.commit()


def _clusters(conn, settings=SETTINGS):
    return stats.find_clusters(conn, settings, today=TODAY)


# --- both thresholds --------------------------------------------------------


def test_participation_alone_does_not_fire(conn):
    # Three members, each above the floor, but $97.5k of estimated volume
    # between them. This is the shape of 29 of the first 33 alerts.
    _seed(conn, [(f"M{i}", [_tx("MSFT", "purchase", *SECOND)]) for i in range(3)])
    assert _clusters(conn) == []


def test_volume_alone_does_not_fire(conn):
    # Two members well past the volume threshold are still two members.
    _seed(conn, [("A A", [_tx("DVN", "sale", *WHALE)]),
                 ("B B", [_tx("DVN", "sale", *WHALE)])])
    assert _clusters(conn) == []


def test_a_single_member_is_never_a_cluster(conn):
    # BE, INTC and DVN each fired as a "cluster" of one on volume alone.
    _seed(conn, [("Whale W", [_tx("BE", "purchase", 500_000_100, 2_500_000_000)])])
    assert _clusters(conn) == []


def test_both_thresholds_fire_and_the_reason_names_both(conn):
    _seed(conn, [(f"M{i}", [_tx("NVDA", "purchase", *MID)]) for i in range(3)])
    [c] = _clusters(conn)
    assert (c.ticker, c.direction, c.politician_count) == ("NVDA", "buy", 3)
    assert c.members == ["M0", "M1", "M2"] and c.below_floor == []
    assert "3 members at ≥$15k floor" in c.reason and "est. volume" in c.reason


# --- the per-member floor ---------------------------------------------------


def test_members_in_the_lowest_bracket_do_not_count(conn):
    # The 2026-10-13 MSFT alert: one member at $750k–$1.5M plus four small
    # trades. The volume threshold passes; the member count must not.
    _seed(conn, [("Big B", [_tx("MSFT", "purchase", *LARGE), _tx("MSFT", "purchase", *WHALE)])]
          + [(f"Small {i}", [_tx("MSFT", "purchase", *LOWEST)]) for i in range(4)])
    assert _clusters(conn) == []


def test_members_below_the_floor_are_kept_but_not_counted(conn):
    _seed(conn, [(f"M{i}", [_tx("NVDA", "purchase", *MID)]) for i in range(3)]
          + [("Small S", [_tx("NVDA", "purchase", *LOWEST)]),
             ("Tiny T", [_tx("NVDA", "purchase", *LOWEST)])])
    [c] = _clusters(conn)
    assert c.politician_count == 3
    assert c.members == ["M0", "M1", "M2"]
    assert c.below_floor == ["Small S", "Tiny T"]
    # Volume and trade count describe every trade in that direction.
    assert c.trade_count == 5
    assert c.member_floor_cents == 1_500_100


def test_the_floor_sums_a_members_bracket_floors_not_midpoints(conn):
    # Two $15,001–$50,000 trades prove $30,002; two $1,001–$15,000 trades prove
    # $2,002 even though their midpoints sum to $16,001 — over the floor.
    anchors = [("A A", [_tx("NVDA", "purchase", *LARGE)]),
               ("B B", [_tx("NVDA", "purchase", *LARGE)])]
    _seed(conn, anchors + [("Two Second", [_tx("NVDA", "purchase", *SECOND)] * 2)])
    assert [c.politician_count for c in _clusters(conn)] == [3]

    for table in ("transactions", "filings", "politicians"):
        conn.execute(f"DELETE FROM {table}")
    conn.commit()
    _seed(conn, anchors + [("Two Lowest", [_tx("NVDA", "purchase", *LOWEST)] * 2)])
    assert _clusters(conn) == []


def test_exact_figures_and_open_ended_brackets_count_at_their_floor(conn):
    _seed(conn, [
        ("A A", [_tx("NVDA", "purchase", *LARGE)]),
        ("Exact E", [_tx("NVDA", "purchase", 2_000_000, 2_000_000, exact=2_000_000)]),
        ("Over O", [_tx("NVDA", "purchase", 5_000_000_000, None)]),
    ])
    [c] = _clusters(conn)
    assert c.members == ["A A", "Exact E", "Over O"]
    assert c.volume.open_ended


def test_a_zero_floor_turns_the_control_off(conn):
    spec = [("Big B", [_tx("MSFT", "purchase", *WHALE)])] \
        + [(f"Small {i}", [_tx("MSFT", "purchase", *LOWEST)]) for i in range(3)]
    _seed(conn, spec)
    assert _clusters(conn) == []
    off = AlertSettings(window_days=90, min_politicians=3, min_volume_usd=500_000,
                        min_member_floor_usd=0)
    [c] = _clusters(conn, off)
    assert c.politician_count == 4 and c.below_floor == []
    assert c.member_floor_cents == 0


# --- dedupe against the alert history ----------------------------------------


def _record(conn, count, fired_at, window=90):
    conn.execute(
        "INSERT INTO alerts (kind, ticker, direction, window_days, politician_count,"
        " volume_mid_cents, fired_at) VALUES ('cluster','NVDA','buy',?,?,1,?)",
        (window, count, fired_at))
    conn.commit()


def test_an_alert_whose_window_has_rolled_past_no_longer_suppresses(conn):
    # The 33 historical alerts recorded every member, floor or not, so their
    # counts are inflated against the new rule: MSFT sell was recorded at 7.
    # Once that alert's own 90-day window is behind us, its count says nothing
    # about the window being looked at now.
    _seed(conn, [(f"M{i}", [_tx("NVDA", "purchase", *MID)]) for i in range(3)])
    [c] = _clusters(conn)
    _record(conn, 7, "2026-03-01T12:00:00Z")           # window [2025-12-01, 2026-03-01]
    assert stats.is_new_cluster(conn, c, today=TODAY) is True


def test_an_alert_whose_window_still_overlaps_keeps_the_growth_rule(conn):
    _seed(conn, [(f"M{i}", [_tx("NVDA", "purchase", *MID)]) for i in range(3)])
    [c] = _clusters(conn)
    _record(conn, 3, "2026-06-20T12:00:00Z")
    assert stats.is_new_cluster(conn, c, today=TODAY) is False
    _record(conn, 2, "2026-06-25T12:00:00Z")
    assert stats.is_new_cluster(conn, c, today=TODAY) is True
    # Exactly at the edge the windows still touch, so the rule still applies.
    conn.execute("DELETE FROM alerts")
    _record(conn, 3, "2026-04-02T12:00:00Z")           # + 90 days = 2026-07-01
    assert stats.is_new_cluster(conn, c, today=TODAY) is False


# --- config -----------------------------------------------------------------


def _load(tmp_path, text):
    f = tmp_path / "config.yaml"
    f.write_text(text)
    return load_config(f, tmp_path / "db.sqlite3")


def test_floor_defaults_to_more_than_one_lowest_bracket_trade(tmp_path):
    assert _load(tmp_path, "alerts:\n  min_politicians: 3\n").alerts.min_member_floor_usd == 15_001
    assert AlertSettings().min_member_floor_cents == 1_500_100


def test_floor_is_read_from_config(tmp_path):
    cfg = _load(tmp_path, "alerts:\n  min_member_floor_usd: 50001\n")
    assert cfg.alerts.min_member_floor_usd == 50_001


@pytest.mark.parametrize("value", ["-1", "'lots'"])
def test_a_floor_that_cannot_be_honoured_is_refused_at_load(tmp_path, value):
    with pytest.raises(ConfigError, match="min_member_floor_usd"):
        _load(tmp_path, f"alerts:\n  min_member_floor_usd: {value}\n")


def test_the_committed_config_loads_with_the_floor():
    cfg = load_config(Path(__file__).resolve().parents[1] / "config.yaml")
    assert cfg.alerts.min_member_floor_usd == 15_001


# --- the message ------------------------------------------------------------


def _cluster(**over):
    base = dict(ticker="NVDA", direction="buy", politician_count=3, trade_count=5,
                members=["Green", "Khanna", "McCaul"],
                volume=Volume(min_cents=30_000_300, max_cents=75_000_000,
                              mid_cents=52_500_150),
                reason="3 members at ≥$15k floor + est. volume $525k",
                member_floor_cents=1_500_100, below_floor=["Fields", "Taylor"])
    base.update(over)
    return Cluster(**base)


def test_message_counts_only_members_above_the_floor_and_says_so():
    msg = telegram.format_cluster(_cluster(), 90)
    assert "3 politicians bought in the last 90 days, each ≥$15k by bracket floor" in msg
    assert "Green, Khanna, McCaul" in msg
    assert "+2 more bought below that floor: Fields, Taylor" in msg
    assert "$300k–$750k (mid $525k)" in msg and "5 buys" in msg


def test_message_omits_the_floor_line_when_nobody_is_below_it():
    msg = telegram.format_cluster(_cluster(below_floor=[]), 90)
    assert "below that floor" not in msg


def test_message_without_a_floor_reads_as_before():
    msg = telegram.format_cluster(_cluster(member_floor_cents=0, below_floor=[]), 90)
    assert "3 politicians bought in the last 90 days\n" in msg
    assert "floor" not in msg


def test_message_with_many_names_on_both_lines_stays_under_the_limit():
    many = [f"Representative Longname Number {i}" for i in range(200)]
    msg = telegram.format_cluster(_cluster(members=many, below_floor=many), 90)
    assert len(msg) <= telegram.TELEGRAM_LIMIT
    assert msg.count("…+190 more") == 2


# --- end to end -------------------------------------------------------------


@pytest.fixture
def sent(monkeypatch):
    messages = []
    monkeypatch.setattr(telegram, "send_message",
                        lambda token, chat, text, **kw: messages.append(text))
    return messages


def test_the_msft_shape_sends_nothing_and_a_real_cluster_records_the_counted_size(conn, sent):
    config = Config(telegram_bot_token="t", telegram_chat_id="c", alerts=SETTINGS)
    _seed(conn, [("Big B", [_tx("MSFT", "purchase", *WHALE)])]
          + [(f"Small {i}", [_tx("MSFT", "purchase", *LOWEST)]) for i in range(4)]
          + [(f"M{i}", [_tx("NVDA", "sale", *MID)]) for i in range(3)]
          + [("Tiny T", [_tx("NVDA", "sale", *LOWEST)])])
    # The pipeline evaluates the window against today's date; the seeded
    # trades sit on 2026-06-15, so widen it enough to include them.
    config.alerts.window_days = (date.today() - date(2026, 6, 1)).days
    assert pipeline.notify_clusters(conn, config) == 1
    assert len(sent) == 1 and "CLUSTER ALERT — NVDA" in sent[0]
    assert "3 politicians sold" in sent[0] and "+1 more sold below that floor: Tiny T" in sent[0]
    row = conn.execute("SELECT ticker, direction, politician_count FROM alerts").fetchone()
    assert tuple(row) == ("NVDA", "sell", 3)
