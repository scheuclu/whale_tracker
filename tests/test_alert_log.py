"""The alert log: every message sent is a row in `alerts` (#52).

The table used to hold only the cluster dedupe rows. The dashboard's /alerts
page claims to be the whole history, so each delivery path now logs what it
sent — and only what it sent: a dry run or a failed send leaves no row, and
the row carries the message text as sent rather than a re-rendering.
"""

import sqlite3
from datetime import date, timedelta

import pytest

from whale import audit, db, pipeline, stats, telegram
from whale.config import (AlertSettings, Config, WatchedMember, WatchlistSettings,
                          _parse_rule)

TODAY = date.today()
RECENT = (TODAY - timedelta(days=5)).isoformat()


@pytest.fixture
def conn(tmp_path):
    c = db.connect(tmp_path / "t.sqlite3")
    yield c
    c.close()


@pytest.fixture
def sent(monkeypatch):
    messages = []
    monkeypatch.setattr(telegram, "send_message",
                        lambda token, chat, text, **kw: messages.append(text))
    return messages


def _config() -> Config:
    return Config(telegram_bot_token="t", telegram_chat_id="c")


def _member(conn, name="Nancy Pelosi", bioguide="P000197"):
    return db.upsert_politician(conn, bioguide_id=bioguide, full_name=name,
                                first=name.split()[0], last=name.split()[-1],
                                chamber="house", party="D", state="CA", district="11",
                                active=1)


def _tx(ticker, action="purchase", lo=100_100, hi=1_500_000, exact=None, tx_date=RECENT):
    return {"tx_date": tx_date, "notification_date": None, "owner": None,
            "asset_name": f"{ticker or 'US Treasury bill'}", "ticker": ticker,
            "asset_type": "ST" if ticker else "GS", "action": action,
            "amount_min_cents": lo, "amount_max_cents": hi, "amount_exact_cents": exact,
            "cap_gains_over_200": None, "description": None, "raw_text": ""}


def _filing(conn, pid, rows, doc_id="1", status="parsed", name="Nancy Pelosi", **fields):
    fid = db.insert_filing(
        conn, chamber="house", doc_id=doc_id, politician_id=pid, filer_name=name,
        state_district="CA11", filing_type="P", filing_date="2026-06-20", year=2026,
        pdf_url=f"http://clerk/{doc_id}.pdf", status=status, **fields)
    db.replace_transactions(conn, fid, pid, rows)
    conn.commit()
    return fid


def _alerts(conn):
    return [dict(r) for r in conn.execute("SELECT * FROM alerts ORDER BY id")]


# --- the schema-13 rebuild ---------------------------------------------------

# The table exactly as every database before schema 13 has it.
OLD_ALERTS_DDL = """
CREATE TABLE alerts (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  ticker TEXT NOT NULL,
  direction TEXT NOT NULL,
  window_days INTEGER NOT NULL,
  politician_count INTEGER NOT NULL,
  volume_mid_cents INTEGER,
  fired_at TEXT NOT NULL
);
CREATE INDEX idx_alerts_key ON alerts(ticker, direction);
"""


def test_the_cluster_only_table_is_rebuilt_with_its_rows_intact(tmp_path):
    path = tmp_path / "old.sqlite3"
    raw = sqlite3.connect(path)
    raw.executescript(OLD_ALERTS_DDL)
    raw.execute("INSERT INTO alerts VALUES (7, 'cluster', 'MSFT', 'buy', 90, 5, 123000450,"
                " '2026-10-13T20:26:00Z')")
    raw.execute("INSERT INTO alerts VALUES (9, 'insider_cluster', 'PAM', 'buy', 30, 3,"
                " 4266061669, '2026-10-16T23:08:16Z')")
    raw.commit()
    raw.close()

    conn = db.connect(path)
    rows = _alerts(conn)
    assert [(r["id"], r["kind"], r["ticker"], r["direction"], r["window_days"],
             r["politician_count"], r["volume_mid_cents"], r["fired_at"]) for r in rows] == [
        (7, "cluster", "MSFT", "buy", 90, 5, 123000450, "2026-10-13T20:26:00Z"),
        (9, "insider_cluster", "PAM", "buy", 30, 3, 4266061669, "2026-10-16T23:08:16Z"),
    ]
    # Nothing is invented for the old rows: no range, no text.
    assert all(r["message"] is None and r["volume_min_cents"] is None for r in rows)
    # The dedupe reads them exactly as before, and stays kind-scoped.
    assert db.last_alert(conn, "PAM", "buy", stats.INSIDER_CLUSTER_KIND)["politician_count"] == 3
    assert db.last_alert(conn, "PAM", "buy", stats.CLUSTER_KIND) is None
    # The new kinds need not be about one ticker in one direction.
    assert db.record_alert(conn, stats.FILING_KIND, None, None, 0, 1, message="x") == 10
    assert db.get_state(conn, db.ALERTS_RECORDED_SINCE)
    conn.commit()
    conn.close()

    again = db.connect(path)
    assert [r["id"] for r in _alerts(again)] == [7, 9, 10]
    assert again.execute("PRAGMA user_version").fetchone()[0] == db.SCHEMA_VERSION
    again.close()


# --- congressional filings ----------------------------------------------------


def test_a_routine_filing_alert_is_logged_as_sent(conn, sent):
    pid = _member(conn)
    fid = _filing(conn, pid, [_tx("MSFT"), _tx("NVDA")])
    assert pipeline.notify_pending(conn, _config()) == 1

    (row,) = _alerts(conn)
    assert row["kind"] == stats.FILING_KIND
    # Two tickers: the alert is about neither. One side: that is kept.
    assert row["ticker"] is None and row["direction"] == "buy"
    assert (row["volume_min_cents"], row["volume_max_cents"], row["volume_mid_cents"]) == (
        200_200, 3_000_000, 1_600_100)
    assert row["politician_count"] == 1 and row["window_days"] == 0
    assert row["participants"] == "Nancy Pelosi" and row["filing_id"] == fid
    assert row["message"] == sent[0]


def test_one_ticker_both_ways_keeps_the_ticker_and_drops_the_side(conn, sent):
    pid = _member(conn)
    _filing(conn, pid, [_tx("MSFT", "purchase"),
                        _tx("MSFT", "sale", lo=100_000_000, hi=None)])
    pipeline.notify_pending(conn, _config())

    (row,) = _alerts(conn)
    assert row["ticker"] == "MSFT" and row["direction"] is None
    # The open-ended bracket: a floor, never an invented ceiling.
    assert row["volume_min_cents"] == 100_100_100 and row["volume_max_cents"] is None
    assert row["volume_mid_cents"] == 800_050 + 100_000_000


def test_a_transcribed_row_contributes_no_volume(conn, sent):
    pid = _member(conn)
    _filing(conn, pid, [_tx("MSFT")], parse_method="vision")
    pipeline.notify_pending(conn, _config())
    (row,) = _alerts(conn)
    assert row["ticker"] == "MSFT"
    assert (row["volume_min_cents"], row["volume_max_cents"], row["volume_mid_cents"]) == (
        None, None, None)


def test_an_unreadable_filing_is_logged_with_no_amount(conn, sent):
    pid = _member(conn)
    fid = db.insert_filing(
        conn, chamber="house", doc_id="scan", politician_id=pid, filer_name="Nancy Pelosi",
        state_district="CA11", filing_type="P", filing_date="2026-06-20", year=2026,
        pdf_url="http://clerk/scan.pdf", status="failed", parse_method="scanned",
        last_error="scanned paper filing")
    conn.commit()
    assert pipeline.notify_pending(conn, _config()) == 1

    (row,) = _alerts(conn)
    assert row["kind"] == stats.FILING_KIND and row["filing_id"] == fid
    assert row["ticker"] is None and row["direction"] is None
    assert row["volume_mid_cents"] is None
    assert "Could not parse" in row["message"]
    assert row["message"] == sent[0]


def test_a_watched_filing_logs_one_row_per_message(conn, sent):
    pid = _member(conn)
    fid = _filing(conn, pid, [_tx("MSFT"), _tx(None, "sale", 1_500_100, 5_000_000)])
    config = _config()
    config.watchlist = WatchlistSettings(
        members=[WatchedMember(name="Nancy Pelosi", bioguide_id="P000197")])
    assert pipeline.notify_pending(conn, config) == 2

    rows = _alerts(conn)
    assert [r["kind"] for r in rows] == [stats.WATCHLIST_KIND] * 2
    assert [(r["ticker"], r["direction"]) for r in rows] == [("MSFT", "buy"), (None, "sell")]
    tx_ids = [r["id"] for r in conn.execute(
        "SELECT id FROM transactions WHERE filing_id = ? ORDER BY id", (fid,))]
    assert [r["transaction_id"] for r in rows] == tx_ids
    assert [r["filing_id"] for r in rows] == [fid, fid]
    assert [r["message"] for r in rows] == sent
    assert [r["volume_mid_cents"] for r in rows] == [800_050, 3_250_050]


def test_a_dry_run_or_a_failed_send_logs_nothing(conn, monkeypatch, capsys):
    pid = _member(conn)
    _filing(conn, pid, [_tx("MSFT")])
    pipeline.notify_pending(conn, _config(), dry_run=True)
    assert _alerts(conn) == []

    monkeypatch.setattr(telegram, "send_message",
                        lambda *a, **kw: (_ for _ in ()).throw(RuntimeError("down")))
    assert pipeline.notify_pending(conn, _config()) == 0
    assert _alerts(conn) == []


# --- clusters -----------------------------------------------------------------


def test_a_cluster_alert_carries_its_members_range_and_message(conn, sent):
    for i in range(3):
        pid = _member(conn, name=f"Member {i}", bioguide=f"M00000{i}")
        _filing(conn, pid, [_tx("MSFT", lo=10_000_100, hi=25_000_000)],
                doc_id=f"c{i}", status="backfilled", name=f"Member {i}")
    config = _config()
    config.alerts = AlertSettings(window_days=90, min_politicians=3,
                                  min_volume_usd=500_000, min_member_floor_usd=15_001)
    assert pipeline.notify_clusters(conn, config) == 1

    (row,) = _alerts(conn)
    assert row["kind"] == stats.CLUSTER_KIND
    assert (row["ticker"], row["direction"]) == ("MSFT", "buy")
    assert row["politician_count"] == 3 and row["window_days"] == 90
    assert row["participants"] == "Member 0, Member 1, Member 2"
    assert (row["volume_min_cents"], row["volume_max_cents"], row["volume_mid_cents"]) == (
        30_000_300, 75_000_000, 52_500_150)
    assert row["message"] == sent[0]
    # The dedupe reads the same row it always did.
    cluster = stats.find_clusters(conn, config.alerts)[0]
    assert stats.is_new_cluster(conn, cluster) is False


# --- insiders -----------------------------------------------------------------

ISSUER = "0001889539"


def _insider_filing(conn, n, owner="0000900000", value=600_000_000):
    filed = (TODAY - timedelta(days=1)).isoformat()
    fid = db.insert_insider_filing(
        conn, accession=f"0000000000-26-{n:06d}", form_type="4", issuer_cik=ISSUER,
        issuer_name="Corebridge Financial, Inc.", ticker="CRBG", filing_date=filed,
        source="feed", status="parsed", source_url=f"http://sec/{n}-index.htm")
    db.upsert_insider(conn, owner, f"Insider {owner[-1]}")
    db.replace_insider_owners(conn, fid, [{"cik": owner, "is_director": True}])
    db.replace_insider_transactions(conn, fid, [{
        "transaction_code": "P", "action": "purchase", "tx_date": filed,
        "shares": 1000.0, "price_per_share": None if value is None else value / 100 / 1000,
        "amount_min_cents": value, "amount_max_cents": value,
        "amount_exact_cents": value, "late": 0}])
    conn.commit()
    return fid


def _insider_config(*rules) -> Config:
    config = Config(telegram_bot_token="t", telegram_chat_id="c",
                    edgar_user_agent="whale-tracker test@example.com")
    config.insiders.alerts = [_parse_rule(r, i) for i, r in enumerate(rules)]
    return config


def test_an_insider_filing_alert_is_logged_as_an_exact_value(conn, sent):
    fid = _insider_filing(conn, 1)
    config = _insider_config({"name": "Large buy", "direction": "buy",
                              "min_value_usd": 1_000_000})
    assert pipeline.notify_insiders(conn, config, today=TODAY) == 1

    (row,) = _alerts(conn)
    assert row["kind"] == stats.INSIDER_FILING_KIND
    assert (row["ticker"], row["direction"], row["politician_count"]) == ("CRBG", "buy", 1)
    assert row["rule_name"] == "Large buy" and row["insider_filing_id"] == fid
    assert row["participants"] == "Insider 0"
    # shares × reported price: exact, so min = max = mid.
    assert (row["volume_min_cents"], row["volume_max_cents"], row["volume_mid_cents"]) == (
        600_000_000, 600_000_000, 600_000_000)
    assert row["message"] == sent[0]


def test_an_unpriced_insider_filing_logs_no_value(conn, sent):
    _insider_filing(conn, 2, value=None)
    config = _insider_config({"name": "Any buy", "direction": "buy"})
    assert pipeline.notify_insiders(conn, config, today=TODAY) == 1
    (row,) = _alerts(conn)
    assert (row["volume_min_cents"], row["volume_max_cents"], row["volume_mid_cents"]) == (
        None, None, None)


def test_an_insider_cluster_alert_is_logged_with_its_rule_and_insiders(conn, sent):
    for i in range(3):
        _insider_filing(conn, 10 + i, owner=f"000090000{i}")
    config = _insider_config({"name": "Cluster buying", "kind": "cluster",
                              "direction": "buy", "min_insiders": 3})
    assert pipeline.notify_insiders(conn, config, today=TODAY) == 1

    # The member filings fold into the cluster: one convergence, one row.
    (row,) = _alerts(conn)
    assert row["kind"] == stats.INSIDER_CLUSTER_KIND and row["rule_name"] == "Cluster buying"
    assert (row["ticker"], row["direction"], row["window_days"]) == ("CRBG", "buy", 30)
    assert row["politician_count"] == 3
    assert row["participants"] == "Insider 0, Insider 1, Insider 2"
    assert row["volume_min_cents"] == row["volume_max_cents"] == row["volume_mid_cents"] \
        == 3 * 600_000_000
    assert row["message"] == sent[0]


# --- the audit ----------------------------------------------------------------


def test_the_audit_flags_a_delivered_alert_that_was_not_logged(conn):
    pid = _member(conn)
    fid = _filing(conn, pid, [_tx("MSFT")], status="notified")
    db.mark_notified(conn, fid)
    conn.commit()
    (finding,) = audit.check_alert_recording(conn)
    assert finding.code == "alert_unrecorded" and finding.severity == audit.WARN
    assert "1" in finding.evidence[0]


def test_the_audit_is_silent_on_silent_backfills_and_logged_alerts(conn, sent):
    pid = _member(conn)
    # A backfill sets notified_at without sending anything, so that it is
    # never announced; it must not read as an unlogged alert.
    quiet = _filing(conn, pid, [_tx("MSFT")], doc_id="q", status="backfilled")
    db.mark_notified(conn, quiet)
    _filing(conn, pid, [_tx("NVDA")], doc_id="n")
    assert pipeline.notify_pending(conn, _config()) == 1
    assert audit.check_alert_recording(conn) == []


def test_the_audit_reports_unknown_when_the_marker_is_missing(conn):
    conn.execute("DELETE FROM sync_state WHERE key = ?", (db.ALERTS_RECORDED_SINCE,))
    (finding,) = audit.check_alert_recording(conn)
    assert finding.code == "alert_recording_unknown" and finding.severity == audit.WARN


def test_alert_health_counts_by_kind(conn):
    assert audit.check_alert_health(conn)[0].code == "no_alerts"
    db.record_alert(conn, stats.CLUSTER_KIND, "MSFT", "buy", 90, 3, 1)
    db.record_alert(conn, stats.FILING_KIND, None, None, 0, 1, message="m")
    (finding,) = audit.check_alert_health(conn)
    assert finding.code == "alerts_recorded" and "2 alert(s)" in finding.title
    assert [e.split()[0] for e in finding.evidence] == ["cluster", "filing"]
    assert audit.check_alert_recording in audit.CHECKS
    assert audit.CHECKS.index(audit.check_alert_recording) \
        == audit.CHECKS.index(audit.check_alert_health) + 1
