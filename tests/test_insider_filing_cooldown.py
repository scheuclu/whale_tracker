"""The filing-rule cooldown: one owner's programme is one alert, not one per filing.

Nippon Life bought Corebridge on 24 of the 33 business days to 2026-10-16 and
every filing cleared the floor on its own, so every one was its own alert; 67
of the first 291 insider alerts were repeats of that shape. The cooldown keys
on (primary owner, issuer, direction) and mirrors the cluster rule: a repeat
inside the window folds into history, and the run speaks again only once its
cumulative value has grown `cluster_refire_growth`× past what was reported.
"""

import sqlite3
from datetime import date

import pytest

from whale import db, insider_alerts, pipeline, telegram
from whale.config import Config, ConfigError, _parse_rule, _refire_days, load_config

TODAY = date(2026, 7, 1)
NIPPON = "0000900000"
CRBG_CIK = "0001889539"


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


_seq = iter(range(1, 10_000))


def _filing(conn, filing_date, value=6_000_000_00, owner=NIPPON, issuer=CRBG_CIK,
            ticker="CRBG", action="purchase", price=30.0, status="parsed",
            joint=()):
    """One Form 4 by `owner` on `issuer`, dated `filing_date`."""
    n = next(_seq)
    fid = db.insert_insider_filing(
        conn, accession=f"0000000000-26-{n:06d}", form_type="4", issuer_cik=issuer,
        issuer_name="Corebridge Financial, Inc.", ticker=ticker,
        filing_date=filing_date, source="feed", status=status,
        source_url=f"http://sec/{n}-index.htm")
    db.upsert_insider(conn, owner, "NIPPON LIFE INSURANCE CO")
    owners = [{"cik": owner, "is_ten_percent_owner": True}]
    for cik in joint:
        db.upsert_insider(conn, cik, f"Joint {cik}")
        owners.append({"cik": cik, "is_director": True})
    db.replace_insider_owners(conn, fid, owners)
    shares = None if value is None else value / 100 / price
    db.replace_insider_transactions(conn, fid, [{
        "transaction_code": "P" if action == "purchase" else "S", "action": action,
        "tx_date": filing_date, "shares": shares,
        "price_per_share": None if value is None else price,
        "amount_min_cents": value, "amount_max_cents": value,
        "amount_exact_cents": value, "late": 0}])
    conn.commit()
    return fid


def _config(refire_days=30, growth=1.5) -> Config:
    config = Config(telegram_bot_token="t", telegram_chat_id="c",
                    edgar_user_agent="whale-tracker test@example.com")
    config.insiders.alerts = [_parse_rule({"name": "Large buy", "direction": "buy",
                                           "min_value_usd": 1_000_000}, 0),
                              _parse_rule({"name": "Big sale", "direction": "sell",
                                           "min_value_usd": 1}, 1)]
    config.insiders.filing_refire_days = refire_days
    config.insiders.cluster_refire_growth = growth
    return config


def _statuses(conn):
    return [r["status"] for r in conn.execute(
        "SELECT status FROM insider_filings ORDER BY filing_date, id")]


def _cooldowns(conn):
    return [dict(r) for r in conn.execute(
        "SELECT * FROM insider_alert_cooldowns ORDER BY insider_cik, issuer_cik, direction")]


# --- the shape of a run ------------------------------------------------------


def test_the_first_filing_fires(conn, sent):
    _filing(conn, "2026-06-01")
    assert pipeline.notify_insiders(conn, _config(), today=TODAY) == 1
    assert "Large buy" in sent[0] and "filing" not in sent[0].split("\n")[2]
    [state] = _cooldowns(conn)
    assert (state["insider_cik"], state["issuer_cik"], state["direction"]) \
        == (NIPPON, CRBG_CIK, "purchase")
    assert state["filing_count"] == 1
    assert state["reported_cents"] == state["cumulative_cents"] == 6_000_000_00


def test_a_second_filing_inside_the_window_is_folded(conn, sent):
    _filing(conn, "2026-06-01")
    config = _config()
    assert pipeline.notify_insiders(conn, config, today=TODAY) == 1
    # Smaller than the first, so the run is not materially bigger.
    _filing(conn, "2026-06-03", value=2_000_000_00)
    assert pipeline.notify_insiders(conn, config, today=TODAY) == 0
    assert len(sent) == 1
    # Folded, not dropped: history for the dashboard, counted into the run.
    assert _statuses(conn) == ["notified", "backfilled"]
    [state] = _cooldowns(conn)
    assert state["filing_count"] == 2
    assert state["cumulative_cents"] == 8_000_000_00
    assert state["reported_cents"] == 6_000_000_00  # still what the message said
    assert state["last_alert_filing_date"] == "2026-06-01"


def test_a_run_that_has_grown_enough_refires_with_the_cumulative(conn, sent):
    _filing(conn, "2026-06-01")                      # $6M, reported
    config = _config()
    pipeline.notify_insiders(conn, config, today=TODAY)
    _filing(conn, "2026-06-03", value=2_000_000_00)  # $8M cumulative: folded
    pipeline.notify_insiders(conn, config, today=TODAY)
    _filing(conn, "2026-06-13", value=1_000_000_00)  # $9M = 1.5× $6M: speaks
    assert pipeline.notify_insiders(conn, config, today=TODAY) == 1
    assert len(sent) == 2
    assert "<b>3rd filing in 12 days</b>" in sent[1]
    assert "cumulative <b>$9M</b> (shares × reported price)" in sent[1]
    assert _statuses(conn) == ["notified", "backfilled", "notified"]
    [state] = _cooldowns(conn)
    assert state["filing_count"] == 3
    assert state["reported_cents"] == state["cumulative_cents"] == 9_000_000_00
    # The window restarts from the refire.
    assert state["last_alert_filing_date"] == "2026-06-13"


def test_outside_the_window_the_owner_fires_again_as_a_fresh_alert(conn, sent):
    _filing(conn, "2026-05-01")
    config = _config()
    pipeline.notify_insiders(conn, config, today=TODAY)
    _filing(conn, "2026-06-01", value=2_000_000_00)  # 31 days later
    assert pipeline.notify_insiders(conn, config, today=TODAY) == 1
    assert len(sent) == 2
    # A new run, not a refire: no "nth filing" line, count back to one.
    assert "filing" not in sent[1].split("\n")[2]
    [state] = _cooldowns(conn)
    assert state["filing_count"] == 1
    assert state["first_filing_date"] == "2026-06-01"
    assert state["reported_cents"] == 2_000_000_00


def test_the_window_is_inclusive_of_its_last_day(conn, sent):
    _filing(conn, "2026-05-02")
    config = _config()
    pipeline.notify_insiders(conn, config, today=TODAY)
    _filing(conn, "2026-06-01", value=2_000_000_00)  # exactly 30 days later
    assert pipeline.notify_insiders(conn, config, today=TODAY) == 0


def test_a_dry_run_records_nothing_and_demotes_nothing(conn, sent, capsys):
    _filing(conn, "2026-06-01")
    _filing(conn, "2026-06-03", value=2_000_000_00)
    pipeline.notify_insiders(conn, _config(), dry_run=True, today=TODAY)
    out = capsys.readouterr().out
    # The preview shows what a real run would do: one message, the repeat
    # folded — but it writes none of it.
    assert out.count("Large buy") == 1
    assert sent == []
    assert _statuses(conn) == ["parsed", "parsed"]
    assert _cooldowns(conn) == []
    # And the real run that follows still sees both filings.
    assert pipeline.notify_insiders(conn, _config(), today=TODAY) == 1
    assert _statuses(conn) == ["notified", "backfilled"]


def test_a_failed_send_leaves_no_cooldown_behind(conn, sent, monkeypatch):
    _filing(conn, "2026-06-01")
    monkeypatch.setattr(telegram, "send_message",
                        lambda *a, **kw: (_ for _ in ()).throw(RuntimeError("down")))
    assert pipeline.notify_insiders(conn, _config(), today=TODAY) == 0
    # Still pending, and nothing says it was reported: the retry is judged
    # exactly as this attempt was.
    assert _statuses(conn) == ["parsed"]
    assert _cooldowns(conn) == []


def test_the_key_is_owner_issuer_and_direction(conn, sent):
    _filing(conn, "2026-06-01")
    config = _config()
    pipeline.notify_insiders(conn, config, today=TODAY)
    _filing(conn, "2026-06-02", owner="0000900001")              # another owner
    _filing(conn, "2026-06-02", issuer="0000000002", ticker="OTH")  # another issuer
    _filing(conn, "2026-06-02", action="sale")                    # the other way
    assert pipeline.notify_insiders(conn, config, today=TODAY) == 3
    assert len(_cooldowns(conn)) == 4


def test_a_joint_filing_is_keyed_on_its_primary_owner(conn, sent):
    _filing(conn, "2026-06-01", joint=("0000900002",))
    config = _config()
    pipeline.notify_insiders(conn, config, today=TODAY)
    _filing(conn, "2026-06-02", value=1_000_000_00)  # primary alone, inside the window
    assert pipeline.notify_insiders(conn, config, today=TODAY) == 0


def test_an_unpriced_run_cannot_refire_on_growth(conn, sent):
    config = _config()
    config.insiders.alerts = [_parse_rule({"name": "Any buy", "direction": "buy"}, 0)]
    _filing(conn, "2026-06-01", value=None)
    pipeline.notify_insiders(conn, config, today=TODAY)
    assert "an unpriced amount" in sent[0]
    # An unknown value is not a large one: even a priced follow-up has
    # nothing to be 1.5× of.
    _filing(conn, "2026-06-02", value=50_000_000_00)
    assert pipeline.notify_insiders(conn, config, today=TODAY) == 0


def test_zero_days_turns_the_cooldown_off(conn, sent):
    _filing(conn, "2026-06-01")
    config = _config(refire_days=0)
    pipeline.notify_insiders(conn, config, today=TODAY)
    _filing(conn, "2026-06-01", value=1_000_000_00)
    assert pipeline.notify_insiders(conn, config, today=TODAY) == 1
    assert len(sent) == 2


def test_the_cooldown_survives_a_reconnect(conn, sent, tmp_path):
    # The whole point of storing it: the pipeline is a fresh process every
    # three hours.
    path = tmp_path / "persist.sqlite3"
    first = db.connect(path)
    _filing(first, "2026-06-01")
    pipeline.notify_insiders(first, _config(), today=TODAY)
    first.close()
    second = db.connect(path)
    _filing(second, "2026-06-03", value=2_000_000_00)
    assert pipeline.notify_insiders(second, _config(), today=TODAY) == 0
    second.close()
    assert len(sent) == 1


# --- the decision itself -----------------------------------------------------


def _decision(conn, previous, filing_date, value, growth=1.5, refire_days=30):
    fid = _filing(conn, filing_date, value=value)
    filing = conn.execute("SELECT * FROM insider_filings WHERE id = ?", (fid,)).fetchone()
    rows, owners = insider_alerts.load_filing(conn, fid)
    match = insider_alerts.match_filing(
        filing, owners, rows, _parse_rule({"name": "R", "direction": "buy"}, 0))
    return insider_alerts.cooldown_decision(previous, match, refire_days, growth)


def test_growth_boundary_is_inclusive_and_strictly_more(conn):
    first = _decision(conn, None, "2026-06-01", 6_000_000_00)
    assert first.fire and first.count == 1 and not first.repeat
    # Exactly 1.5× fires.
    assert _decision(conn, first.state, "2026-06-05", 3_000_000_00).fire
    # A cent short does not.
    assert not _decision(conn, first.state, "2026-06-05", 3_000_000_00 - 1).fire
    # With growth 1.0 the run must still be strictly bigger: a repeat with
    # no priced rows adds nothing and so says nothing.
    assert _decision(conn, first.state, "2026-06-05", 1, growth=1.0).fire
    assert not _decision(conn, first.state, "2026-06-05", None, growth=1.0).fire


def test_a_fold_keeps_counting_towards_the_next_refire(conn):
    first = _decision(conn, None, "2026-06-01", 6_000_000_00)
    fold = _decision(conn, first.state, "2026-06-03", 2_000_000_00)
    assert not fold.fire and fold.count == 2 and fold.cumulative_cents == 8_000_000_00
    refire = _decision(conn, fold.state, "2026-06-13", 1_000_000_00)
    assert refire.fire and refire.repeat and refire.count == 3 and refire.days == 12
    assert refire.state["reported_cents"] == 9_000_000_00
    assert refire.state["last_alert_filing_date"] == "2026-06-13"


def test_a_stored_row_works_as_the_previous_state(conn):
    first = _decision(conn, None, "2026-06-01", 6_000_000_00)
    db.save_insider_cooldown(conn, first.state)
    conn.commit()
    stored = db.insider_cooldown(conn, NIPPON, CRBG_CIK, "purchase")
    assert isinstance(stored, sqlite3.Row)
    assert not _decision(conn, stored, "2026-06-03", 2_000_000_00).fire


def test_an_uncomparable_date_fires_rather_than_suppresses(conn):
    first = _decision(conn, None, "2026-06-01", 6_000_000_00)
    broken = dict(first.state, last_alert_filing_date="2026-06-31")
    # A missing alert is the larger harm, so the unknown case speaks.
    assert _decision(conn, broken, "2026-06-03", 1_000_000_00).fire


# --- the message -------------------------------------------------------------


def test_the_repeat_line_reads_naturally():
    class Repeat:
        def __init__(self, count, days, cumulative):
            self.count, self.days, self.cumulative_cents = count, days, cumulative

    assert telegram._repeat_line(Repeat(2, 0, 100_00)) == \
        "<b>2nd filing today</b> · cumulative <b>$100</b> (shares × reported price)"
    assert telegram._repeat_line(Repeat(3, 1, 100_00)).startswith("<b>3rd filing in 1 day</b>")
    assert telegram._repeat_line(Repeat(11, 12, 100_00)).startswith("<b>11th filing in 12 days</b>")
    assert telegram._repeat_line(Repeat(22, 30, 100_00)).startswith("<b>22nd filing")
    assert telegram._repeat_line(Repeat(4, 5, None)).endswith("cumulative value unpriced")


# --- configuration -----------------------------------------------------------


def test_filing_refire_days_loads_and_defaults(tmp_path):
    assert load_config(tmp_path / "absent.yaml", tmp_path / "x").insiders.filing_refire_days == 30
    (tmp_path / "c.yaml").write_text("insiders:\n  filing_refire_days: 14\n")
    assert load_config(tmp_path / "c.yaml", tmp_path / "x").insiders.filing_refire_days == 14


def test_a_negative_or_nonsense_cooldown_is_refused():
    with pytest.raises(ConfigError, match="0 \\(off\\) or more"):
        _refire_days(-1)
    with pytest.raises(ConfigError, match="whole number"):
        _refire_days("a month")


# --- the schema --------------------------------------------------------------


def test_a_version_3_database_gains_the_cooldown_table_in_place(tmp_path):
    path = tmp_path / "v3.sqlite3"
    raw = sqlite3.connect(path)
    raw.executescript(db._DDL)
    raw.executescript(db._INSIDER_DDL)
    raw.execute("INSERT INTO insiders (cik, name, updated_at) VALUES ('X', 'Someone', 't')")
    raw.execute("PRAGMA user_version = 3")
    raw.commit()
    raw.close()
    conn = db.connect(path)
    tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    assert "insider_alert_cooldowns" in tables
    assert conn.execute("PRAGMA user_version").fetchone()[0] == db.SCHEMA_VERSION
    assert conn.execute("SELECT name FROM insiders").fetchone()[0] == "Someone"
    conn.close()
