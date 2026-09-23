"""The watchlist: members whose every trade earns its own immediate alert.

Two things matter here beyond the matching itself. A watched member must not
be missed — that is the entire point of naming them — so the age cutoff does
not apply to them and a malformed entry fails at startup rather than watching
nobody. And a watched filing is split per transaction, because the default
per-filing message degrades to fit Telegram's limit and would hide the trade
that was being watched for.
"""

from datetime import date

import pytest

from whale import db, house, pipeline, roster, telegram
from whale.config import (Config, ConfigError, WatchedMember, WatchlistSettings,
                          _parse_watch)

TODAY = date(2026, 7, 1)
PELOSI = WatchedMember(name="Nancy Pelosi", bioguide_id="P000197")


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


def _config(*members) -> Config:
    config = Config(telegram_bot_token="t", telegram_chat_id="c")
    config.watchlist = WatchlistSettings(members=list(members))
    return config


def _member(conn, bioguide="P000197", name="Nancy Pelosi", last="Pelosi"):
    return db.upsert_politician(conn, bioguide_id=bioguide, full_name=name,
                                first=name.split()[0], last=last, chamber="house",
                                party="D", state="CA", district="11", active=1)


def _filing(conn, politician_id=None, filer_name="Nancy Pelosi", doc_id="1",
            status="parsed", n_tx=2):
    fid = db.insert_filing(
        conn, chamber="house", doc_id=doc_id, politician_id=politician_id,
        filer_name=filer_name, state_district="CA11", filing_type="P",
        filing_date="2026-06-20", year=2026,
        pdf_url=f"http://clerk/{doc_id}.pdf", status=status)
    rows = [{"tx_date": "2026-06-18", "notification_date": None, "owner": "SP",
             "asset_name": f"Asset {i}", "ticker": f"TK{i}", "asset_type": "ST",
             "action": "purchase", "amount_min_cents": 100_100,
             "amount_max_cents": 1_500_000, "amount_exact_cents": None,
             "cap_gains_over_200": None, "description": None, "raw_text": ""}
            for i in range(n_tx)]
    db.replace_transactions(conn, fid, politician_id, rows)
    conn.commit()
    return fid


# --- a malformed entry must not silently watch nobody -----------------------


def test_an_unknown_key_is_rejected():
    with pytest.raises(ConfigError, match="unknown key"):
        _parse_watch({"name": "Nancy Pelosi", "bioguide": "P000197"}, 0)


def test_an_entry_needs_a_name():
    with pytest.raises(ConfigError, match="needs a name"):
        _parse_watch({"bioguide_id": "P000197"}, 0)


def test_a_malformed_bioguide_id_is_rejected():
    # It would otherwise fall through to the name match and look like it
    # worked, hiding the typo until someone wondered why alerts differed.
    with pytest.raises(ConfigError, match="not a bioguide ID"):
        _parse_watch({"name": "Nancy Pelosi", "bioguide_id": "P197"}, 0)


def test_an_entry_parses_and_defaults_to_watching():
    m = _parse_watch({"name": "Nancy Pelosi", "bioguide_id": "p000197"}, 0)
    assert m == WatchedMember(name="Nancy Pelosi", bioguide_id="P000197",
                              every_trade=True)


# --- matching ---------------------------------------------------------------


def test_the_bioguide_id_is_authoritative():
    assert PELOSI.matches("P000197", "Someone Else") is True
    assert PELOSI.matches("A000370", "Nancy Pelosi") is False


def test_the_name_is_the_fallback_when_the_roster_missed_the_filing():
    # An unmatched filing still carries the name printed on the PDF, and a
    # watched member going unreported is the failure this exists to prevent.
    assert PELOSI.matches(None, "Nancy Pelosi") is True
    assert PELOSI.matches(None, "Hon. Nancy  Pelosi") is True
    assert PELOSI.matches(None, "Mark Alford") is False


def test_every_trade_false_is_not_watched():
    wl = WatchlistSettings(members=[WatchedMember(name="Nancy Pelosi",
                                                  bioguide_id="P000197",
                                                  every_trade=False)])
    assert wl.active is False
    assert wl.match("P000197", "Nancy Pelosi") is None


def test_an_empty_watchlist_is_inert():
    assert WatchlistSettings().active is False
    assert WatchlistSettings().match("P000197", "Nancy Pelosi") is None


# --- the age cutoff does not apply to a watched member ----------------------


def _entry(last="Pelosi", first="Nancy", doc_id="9001", filing_date="2026-01-05"):
    return house.IndexEntry(doc_id=doc_id, last=last, first=first, suffix="",
                            prefix="", filing_type="P", state_district="CA11",
                            year=2026, filing_date=filing_date)


def _run_sync(conn, config, entries, monkeypatch):
    monkeypatch.setattr(roster, "sync", lambda c: None)
    monkeypatch.setattr(house, "fetch_index", lambda year: b"")
    monkeypatch.setattr(house, "ptr_entries", lambda raw: entries)
    monkeypatch.setattr(house, "is_recent", lambda d, age, today=None: False)
    config.senate_enabled = False
    pipeline.sync(conn, config)


def test_a_watched_members_old_filing_still_enters_the_queue(conn, monkeypatch):
    _member(conn)
    _member(conn, bioguide="A000370", name="Mark Alford", last="Alford")
    conn.commit()
    config = _config(PELOSI)
    _run_sync(conn, config,
              [_entry(), _entry(last="Alford", first="Mark", doc_id="9002")],
              monkeypatch)

    rows = {r["filer_name"]: r["status"] for r in conn.execute(
        "SELECT filer_name, status FROM filings")}
    assert rows["Nancy Pelosi"] == "new"
    # Everyone else keeps the cutoff: it is what stops a first run replaying
    # a year of history into Telegram.
    assert rows["Mark Alford"] == "seen_skipped"


def test_without_a_watchlist_the_cutoff_applies_to_everyone(conn, monkeypatch):
    _member(conn)
    conn.commit()
    _run_sync(conn, _config(), [_entry()], monkeypatch)
    assert conn.execute("SELECT status FROM filings").fetchone()["status"] == "seen_skipped"


# --- one alert per transaction ----------------------------------------------


def test_a_watched_filing_is_split_per_transaction(conn, sent):
    pid = _member(conn)
    _filing(conn, politician_id=pid, n_tx=3)
    assert pipeline.notify_pending(conn, _config(PELOSI)) == 3
    assert len(sent) == 3
    assert all("WATCHLIST" in m for m in sent)
    # Reconstructable as one filing rather than read as three events.
    assert "transaction 1 of 3" in sent[0]
    assert "transaction 3 of 3" in sent[2]
    row = conn.execute("SELECT status, notified_at FROM filings").fetchone()
    assert row["status"] == "notified" and row["notified_at"]


def test_a_watched_filing_is_not_repeated(conn, sent):
    pid = _member(conn)
    _filing(conn, politician_id=pid, n_tx=2)
    config = _config(PELOSI)
    assert pipeline.notify_pending(conn, config) == 2
    assert pipeline.notify_pending(conn, config) == 0
    assert len(sent) == 2


def test_an_unwatched_member_still_gets_one_filing_message(conn, sent):
    pid = _member(conn, bioguide="A000370", name="Mark Alford", last="Alford")
    _filing(conn, politician_id=pid, filer_name="Mark Alford", n_tx=3)
    assert pipeline.notify_pending(conn, _config(PELOSI)) == 1
    assert len(sent) == 1
    assert "New filing" in sent[0] and "WATCHLIST" not in sent[0]


def test_watched_alerts_are_sent_before_routine_ones(conn, sent):
    other = _member(conn, bioguide="A000370", name="Mark Alford", last="Alford")
    _filing(conn, politician_id=other, filer_name="Mark Alford", doc_id="1", n_tx=1)
    pid = _member(conn)
    _filing(conn, politician_id=pid, doc_id="2", n_tx=1)
    pipeline.notify_pending(conn, _config(PELOSI))
    assert "WATCHLIST" in sent[0] and "New filing" in sent[1]


def test_a_watched_filing_with_no_transactions_falls_back_and_is_consumed(conn, sent):
    # Nothing to split, but the filing is real. It must still be reported and
    # must not sit in the queue being retried forever.
    pid = _member(conn)
    _filing(conn, politician_id=pid, n_tx=0)
    assert pipeline.notify_pending(conn, _config(PELOSI)) == 1
    assert "New filing" in sent[0]
    assert conn.execute("SELECT status FROM filings").fetchone()["status"] == "notified"


def test_a_partial_send_failure_leaves_the_filing_to_retry(conn, monkeypatch):
    pid = _member(conn)
    _filing(conn, politician_id=pid, n_tx=3)
    calls = []

    def flaky(token, chat, text, **kw):
        calls.append(text)
        if len(calls) == 2:
            raise RuntimeError("telegram down")

    monkeypatch.setattr(telegram, "send_message", flaky)
    assert pipeline.notify_pending(conn, _config(PELOSI)) == 0
    # Not marked: a duplicate alert for a watched member beats a missing one.
    row = conn.execute("SELECT status, notified_at FROM filings").fetchone()
    assert row["status"] == "parsed" and row["notified_at"] is None


def test_a_dry_run_does_not_consume_a_watched_filing(conn, sent, capsys):
    pid = _member(conn)
    _filing(conn, politician_id=pid, n_tx=2)
    pipeline.notify_pending(conn, _config(PELOSI), dry_run=True)
    assert "WATCHLIST" in capsys.readouterr().out
    assert sent == []
    row = conn.execute("SELECT status, notified_at FROM filings").fetchone()
    assert row["status"] == "parsed" and row["notified_at"] is None


def test_an_unmatched_filing_is_caught_by_name(conn, sent):
    # No politician_id: the roster failed to match, but the PDF still names her.
    _filing(conn, politician_id=None, filer_name="Nancy Pelosi", n_tx=2)
    assert pipeline.notify_pending(conn, _config(PELOSI)) == 2
    assert all("WATCHLIST" in m for m in sent)
