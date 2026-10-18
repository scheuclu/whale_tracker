"""Late-filing compliance: the "⚠️ late by N days" prefix, the `late_filing`
alert kind and its per-filing dedupe, the config knob, and the weekly audit
line.

The delay is always trade date → filing date. The report's own "Notification
Date" column is when the *member* learned of the trade and reads 0 for anyone
trading their own account, so a filing judged by it would never be late.
"""

from datetime import date

import pytest

from whale import audit, db, pipeline, stats, telegram
from whale.config import DEFAULT_CONFIG_FILE, AlertSettings, Config, ConfigError, load_config
from whale.stats import LATE_FILING_KIND, filing_late_by_days, is_new_late_filing
from whale.telegram import (FILING_ROW_BUDGET, TELEGRAM_LIMIT, format_filing,
                            format_filing_summary, late_prefix, member_page_url)

TODAY = date(2026, 7, 1)
LOWEST = (100_100, 1_500_000)


# --- the filing's own lateness ----------------------------------------------


def test_all_trades_past_the_deadline_is_days_past_the_first_due_date():
    # Due 45 days after the earliest trade (delay 100): 55 days late.
    assert filing_late_by_days([100, 60], 45) == 55
    assert filing_late_by_days([46], 45) == 1


def test_one_trade_inside_the_deadline_means_the_filing_is_not_all_late():
    # Exactly 45 days is on time: the statute allows 45.
    assert filing_late_by_days([100, 45], 45) is None
    assert filing_late_by_days([100, 10], 45) is None


def test_an_unknown_delay_disqualifies_rather_than_being_skipped():
    # A row whose dates contradict each other has no delay; a filing cannot
    # be called all-late on it.
    assert filing_late_by_days([100, None], 45) is None
    assert filing_late_by_days([], 45) is None


def test_zero_turns_the_feature_off():
    assert filing_late_by_days([100, 60], 0) is None


def test_the_default_deadline_is_the_statutory_one():
    assert AlertSettings().late_filing_days == stats.STOCK_ACT_DEADLINE_DAYS == 45


# --- the prefix ---------------------------------------------------------------


def _tx(i=0, delay=100, **kw):
    lo, hi = LOWEST
    base = {"ticker": f"TK{i:02d}", "action": "purchase", "asset_name": f"Company {i}",
            "amount_min_cents": lo, "amount_max_cents": hi, "amount_exact_cents": None,
            "tx_date": "2026-03-01", "notification_date": "2026-03-01", "owner": None,
            "delay_days": delay}
    base.update(kw)
    return base


def _filing_msg(transactions, **kw):
    args = {"member": "Kevin Hern", "party": "R", "state": "OK", "district": "1",
            "chamber": "house", "filing_date": "2026-06-20",
            "pdf_url": "https://disclosures-clerk.house.gov/x.pdf",
            "transactions": transactions}
    args.update(kw)
    return format_filing(**args)


def test_prefix_wording():
    assert late_prefix(55) == "⚠️ late by 55 days"
    assert late_prefix(1) == "⚠️ late by 1 day"


def test_filing_message_leads_with_how_late_it_was():
    msg = _filing_msg([_tx()], late_by_days=55)
    assert msg.startswith("⚠️ late by 55 days\n🏛 <b>New filing — Rep. Kevin Hern (R-OK1)</b>")
    # The per-trade clock is still there: the prefix is the filing's, not a
    # replacement for the row's.
    assert "(100d delay)" in msg


def test_no_prefix_unless_told_the_filing_is_late():
    assert "late by" not in _filing_msg([_tx()])


def test_prefix_survives_every_degradation_step():
    # 94 rows forces the compact form; the prefix is one short line and stays.
    msg = _filing_msg([_tx(i) for i in range(94)], late_by_days=12)
    assert len(msg) <= TELEGRAM_LIMIT
    assert msg.startswith("⚠️ late by 12 days\n")
    assert "TK93" in msg
    pathological = _filing_msg([_tx(i, ticker="X" * 10, asset_name="Y" * 200)
                                for i in range(400)], late_by_days=12)
    assert len(pathological) <= TELEGRAM_LIMIT
    assert pathological.startswith("⚠️ late by 12 days\n")


def test_summary_message_leads_with_how_late_it_was():
    rows = [_tx(i) for i in range(FILING_ROW_BUDGET + 5)]
    msg = format_filing_summary(
        member="Kevin Hern", party="R", state="OK", district="1", chamber="house",
        filing_date="2026-06-20", pdf_url="https://disclosures-clerk.house.gov/x.pdf",
        transactions=rows, member_url=member_page_url("Kevin Hern"), late_by_days=55)
    assert msg.startswith("⚠️ late by 55 days\n🏛 <b>New filing")
    assert len(msg) <= TELEGRAM_LIMIT


# --- the pipeline: prefix, alert kind, dedupe --------------------------------


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


def _config(late_filing_days=45) -> Config:
    config = Config(telegram_bot_token="t", telegram_chat_id="c")
    config.alerts = AlertSettings(late_filing_days=late_filing_days)
    return config


def _filing(conn, tx_dates, filing_date="2026-06-20", doc_id="20035491",
            chamber="house", name="Kevin Hern"):
    pid = db.upsert_politician(conn, bioguide_id="H001082", full_name=name,
                               first="Kevin", last="Hern", chamber="house", party="R",
                               state="OK", district="1", active=1)
    fid = db.insert_filing(conn, chamber=chamber, doc_id=doc_id, politician_id=pid,
                           filer_name=name, state_district="OK01", filing_type="P",
                           filing_date=filing_date, year=2026,
                           pdf_url=f"http://clerk/{doc_id}.pdf", status="parsed")
    rows = [{"tx_date": d, "notification_date": d, "owner": None,
             "asset_name": f"Company {i}", "ticker": f"TK{i}", "asset_type": "ST",
             "action": "purchase", "amount_min_cents": LOWEST[0],
             "amount_max_cents": LOWEST[1], "amount_exact_cents": None}
            for i, d in enumerate(tx_dates)]
    db.replace_transactions(conn, fid, pid, rows)
    conn.commit()
    return fid


def _alerts(conn):
    return conn.execute("SELECT * FROM alerts ORDER BY id").fetchall()


def test_late_filing_is_prefixed_and_recorded_once(conn, sent):
    # Traded 03/01 and 04/01, filed 06/20: delays 111 and 80, both past 45.
    # Due 45 days after 03/01, so the filing itself is 66 days late.
    _filing(conn, ["2026-03-01", "2026-04-01"])
    assert pipeline.notify_pending(conn, _config()) == 1
    assert len(sent) == 1
    assert sent[0].startswith("⚠️ late by 66 days\n🏛 <b>New filing — Rep. Kevin Hern")
    assert "(111d delay)" in sent[0] and "(80d delay)" in sent[0]

    rows = _alerts(conn)
    assert len(rows) == 1
    row = rows[0]
    assert row["kind"] == LATE_FILING_KIND == "late_filing"
    # Keyed on the filing: document id and chamber, what `filings` is unique on.
    assert row["ticker"] == "20035491" and row["direction"] == "house"
    assert row["window_days"] == 45          # the deadline it was judged by
    assert row["politician_count"] == 2      # late trades in the filing
    assert row["volume_mid_cents"] is None   # nothing here is a volume
    # The filing is consumed exactly as before: the alert row is extra, not
    # a change to the state machine.
    status = conn.execute("SELECT status, notified_at FROM filings").fetchone()
    assert status["status"] == "notified" and status["notified_at"]


def test_a_filing_with_one_timely_trade_is_neither_prefixed_nor_recorded(conn, sent):
    # One trade 111 days old, one 8 days old: the per-trade lines carry the
    # delays; the filing as a whole is not called late.
    _filing(conn, ["2026-03-01", "2026-06-12"])
    assert pipeline.notify_pending(conn, _config()) == 1
    assert "late by" not in sent[0]
    assert "(111d delay)" in sent[0]
    assert _alerts(conn) == []


def test_recorded_once_per_filing(conn, sent):
    # The row already exists (a previous delivery): the message still carries
    # the prefix — it is the filing's fact — but no second row is written.
    _filing(conn, ["2026-03-01"])
    db.record_alert(conn, LATE_FILING_KIND, "20035491", "house", 45, 1, None)
    conn.commit()
    assert not is_new_late_filing(conn, "house", "20035491")
    assert pipeline.notify_pending(conn, _config()) == 1
    assert sent[0].startswith("⚠️ late by 66 days")
    assert len(_alerts(conn)) == 1


def test_dedupe_is_kind_scoped_and_chamber_scoped(conn):
    # A cluster row on the same key is a different fact; so is the other
    # chamber's filing with the same document id.
    db.record_alert(conn, stats.CLUSTER_KIND, "20035491", "house", 90, 3, None)
    db.record_alert(conn, LATE_FILING_KIND, "20035491", "senate", 45, 1, None)
    conn.commit()
    assert is_new_late_filing(conn, "house", "20035491")
    assert not is_new_late_filing(conn, "senate", "20035491")


def test_zero_turns_prefix_and_alert_off(conn, sent):
    _filing(conn, ["2026-03-01", "2026-04-01"])
    assert pipeline.notify_pending(conn, _config(late_filing_days=0)) == 1
    assert "late by" not in sent[0]
    assert _alerts(conn) == []


def test_the_threshold_is_the_configured_one(conn, sent):
    # Delays 111 and 80; with a 90-day threshold the 80-day trade is inside it.
    _filing(conn, ["2026-03-01", "2026-04-01"])
    assert pipeline.notify_pending(conn, _config(late_filing_days=90)) == 1
    assert "late by" not in sent[0]
    assert _alerts(conn) == []


def test_dry_run_records_nothing(conn, capsys):
    _filing(conn, ["2026-03-01"])
    assert pipeline.notify_pending(conn, _config(), dry_run=True) == 0
    assert "⚠️ late by 66 days" in capsys.readouterr().out
    assert _alerts(conn) == []
    assert conn.execute("SELECT status FROM filings").fetchone()["status"] == "parsed"


def test_failed_delivery_records_nothing(conn, monkeypatch):
    def boom(*a, **kw):
        raise RuntimeError("telegram down")
    monkeypatch.setattr(telegram, "send_message", boom)
    _filing(conn, ["2026-03-01"])
    assert pipeline.notify_pending(conn, _config()) == 0
    assert _alerts(conn) == []
    assert conn.execute("SELECT status FROM filings").fetchone()["status"] == "parsed"


def test_contradictory_dates_never_make_a_filing_late(conn, sent):
    # A trade "after" its own filing has no delay; the filing is not all-late.
    _filing(conn, ["2026-03-01", "2027-06-20"])
    assert pipeline.notify_pending(conn, _config()) == 1
    assert "late by" not in sent[0]
    assert _alerts(conn) == []


# --- config -------------------------------------------------------------------


def test_default_is_the_statutory_deadline(tmp_path):
    f = tmp_path / "config.yaml"
    f.write_text("alerts: {}\n")
    assert load_config(f, tmp_path / "db").alerts.late_filing_days == 45


def test_zero_is_off_and_nonsense_is_refused(tmp_path):
    f = tmp_path / "config.yaml"
    f.write_text("alerts:\n  late_filing_days: 0\n")
    assert load_config(f, tmp_path / "db").alerts.late_filing_days == 0
    f.write_text("alerts:\n  late_filing_days: 60\n")
    assert load_config(f, tmp_path / "db").alerts.late_filing_days == 60
    f.write_text("alerts:\n  late_filing_days: -1\n")
    with pytest.raises(ConfigError, match="late_filing_days is -1"):
        load_config(f, tmp_path / "db")
    f.write_text("alerts:\n  late_filing_days: soon\n")
    with pytest.raises(ConfigError, match="whole number of days"):
        load_config(f, tmp_path / "db")


def test_shipped_config_uses_the_statutory_deadline():
    assert load_config(DEFAULT_CONFIG_FILE).alerts.late_filing_days == 45


# --- the weekly audit -----------------------------------------------------------


def _audit_filing(conn, doc_id, filing_date, tx_dates, status="notified"):
    fid = db.insert_filing(
        conn, chamber="house", doc_id=doc_id, politician_id=None,
        filer_name="Test Filer", state_district="CA01", filing_type="P",
        filing_date=filing_date, year=2026, pdf_url="http://x/y.pdf", status=status)
    db.replace_transactions(conn, fid, None, [
        {"asset_name": f"Asset {i}", "ticker": f"TK{i}", "asset_type": "ST",
         "action": "purchase", "tx_date": d, "notification_date": d,
         "amount_min_cents": LOWEST[0], "amount_max_cents": LOWEST[1]}
        for i, d in enumerate(tx_dates)])
    conn.commit()
    return fid


def test_late_filing_in_the_last_week_is_reported_as_information(conn):
    # Filed 06/28 (3 days before TODAY): one trade 88 days old, one 8 days.
    _audit_filing(conn, "late1", "2026-06-28", ["2026-04-01", "2026-06-20"])
    found = audit.check_late_filings(conn, TODAY)
    assert len(found) == 1
    f = found[0]
    assert f.severity == audit.INFO and f.code == "late_filings"
    assert f.title == "1 filing(s) in the last 7 days disclose 1 trade(s) past the 45-day deadline"
    assert f.evidence == ["2026-06-28  filing late1  Test Filer  1/2 trades late · worst 88d"]
    assert "never the report's notification column" in f.detail


def test_a_filing_whose_every_trade_is_late_is_marked_all(conn):
    _audit_filing(conn, "late2", "2026-06-28", ["2026-04-01", "2026-04-15"])
    [f] = audit.check_late_filings(conn, TODAY)
    assert f.evidence == ["2026-06-28  filing late2  Test Filer  2/2 trades late · worst 88d  · all"]


def test_a_late_filing_older_than_the_week_is_not_this_weeks_news(conn):
    _audit_filing(conn, "old", "2026-06-01", ["2026-02-01"])
    assert audit.check_late_filings(conn, TODAY) == []


def test_timely_filings_produce_no_finding(conn):
    _audit_filing(conn, "ok", "2026-06-28", ["2026-06-20", "2026-05-14"])  # 8d and 45d
    assert audit.check_late_filings(conn, TODAY) == []


def test_unparsed_filings_and_contradictory_dates_are_not_late(conn):
    _audit_filing(conn, "failed", "2026-06-28", ["2026-02-01"], status="failed")
    _audit_filing(conn, "typo", "2026-06-28", ["2027-02-01"])
    assert audit.check_late_filings(conn, TODAY) == []


def test_the_check_runs_right_after_the_date_anomalies_check():
    checks = list(audit.CHECKS)
    assert checks.index(audit.check_late_filings) == checks.index(audit.check_date_anomalies) + 1


def test_the_check_is_part_of_the_full_run(conn):
    _audit_filing(conn, "late3", "2026-06-28", ["2026-04-01"])
    assert "late_filings" in {f.code for f in audit.run_checks(conn, TODAY)}
