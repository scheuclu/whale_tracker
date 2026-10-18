"""Options as structured data (#58).

The contract is read out of what the filing printed — and only that. The
fixtures below are the real asset names and descriptions in
data/trades.sqlite3 (the comment is the transactions.id), one per dialect
the corpus uses, plus every near miss that must stay unparsed: a bond's
call date, "callable" notes, "Callaway", "Capital call", "earnings calls".
A strike is only a figure the text calls a strike, so "10 puts at $11.80"
is a put with no strike — $11.80 is the premium.

Then the three things built on it: the schema-11 migration that fills the
columns on an existing database, the per-trade alert that is exempt from the
digest's degradation, and the cluster finder's reading of a put as a bet
against the stock rather than a "buy".
"""

from datetime import date

import pytest

from whale import db, options, pipeline, stats, telegram
from whale.config import (DEFAULT_CONFIG_FILE, AlertSettings, Config, ConfigError,
                          load_config)
from whale.options import OptionContract, parse

TODAY = date(2026, 7, 1)

# (transactions.id, asset_name, description, asset_type, expected)
REAL = [
    # House: the row's "Description:" sub-field carries the contract.
    (597, "Alphabet Inc. - Class A Common Stock",
     "Purchased 20 call options with a strike price of $150 and an expiration date of 1/15/27.",
     "OP", OptionContract("call", 15_000, "2027-01-15")),
    (1541, "Microsoft Corporation - Common Stock",
     "Call options; Strike price $325; Expires 06/18/2026",
     "OP", OptionContract("call", 32_500, "2026-06-18")),
    (2600, "GE Aerospace Common Stock", "Put Option", "OP", OptionContract("put")),
    (2602, "Nokia Corporation Sponsored American Depositary Shares", "Call option",
     "OP", OptionContract("call")),
    # $11.80 is what was paid per contract, not a strike: not guessed.
    (2558, "Meta Platforms, Inc. - Class A Common Stock", "10 puts at $11.80",
     "OP", OptionContract("put")),
    # Filed as stock with the contract in the description: the text decides.
    (2599, "Bank of America Corporation Common Stock", "Call option contracts.",
     "ST", OptionContract("call")),
    # Senate: eFD's sub-detail lines, kept in `description` by senate_ptr.
    (4618, "Williams Companies, Inc. (The) Common Stock",
     "Option Type: Call · Strike price: $75.00 · Expires: 2026-08-21",
     "OP", OptionContract("call", 7_500, "2026-08-21")),
    (4784, "Adobe Systems Inc",
     "Option Type: Put · Strike price: $500.00 · Expires: 12/20/2024",
     "OP", OptionContract("put", 50_000, "2024-12-20")),
    (4967, "Williams Companies, Inc. (The) Common Stock",
     "All transactions notified to Filer on September 1, 2026 · Option Type: Call · "
     "Strike price: $75.00 · Expires: 2026-08-21",
     "OP", OptionContract("call", 7_500, "2026-08-21")),
    # A broker's symbol form as the asset name: no type code, no ticker.
    (5680, "CALL/JNJ FLEX EURO PM @ 245 EXP 07/02/2026", None, None,
     OptionContract("call", 24_500, "2026-07-02")),
    (5923, "CALL/CCEP FLEX EURO PM 99 EXP 07/10/2026", None, None,
     OptionContract("call", 9_900, "2026-07-10")),
    (5926, "PUT/XSP @ 690 EXP 10/16/2026", None, None,
     OptionContract("put", 69_000, "2026-10-16")),
]

NOT_OPTIONS = [
    (53, "California St Go Call 12/1/27 4% due 12/1/47", None, "GS"),
    (953, "VMWARE LLC NOTE CALL MAKE WHOLE 4.70000% 05/15/2030", "928563AF2", "CS"),
    (1, "JP Morgan 3-year auto callable buffer note", "Structured Note", "CS"),
    (4622, "Canadian Imperial Bank of Commerce Trigger Autocallable Contingent Yield Notes",
     "Linked to the Least Performing of the S&P 500 Index · Asset type: Other", None),
    (5697, "CALLAWAY GOLF COMPANY CMN", None, None),
    (4154, "Barry Callebaut AG Unsponsored ADR (BRRLY)", None, "ST"),
    (619, "Alpine Investors IX, LP (GLAS Funds, LP)", "Capital call of $1,432.26", "HN"),
    (1721, "Goldman Sachs MTN 4/29/2030", "Note called by issuer", "CS"),
    (2027, "Pinterest, Inc. Class A Common Stock (PINS) [ST] vest quarterly and can only "
     "be sold during earnings calls to prevent insider trading.",
     "Spouse received restricted stock units (RSUs) as part of compensation", None),
    (5658, "Redeemed New York St Rev Rfdg Ser 2016A 5 000 Due 6/15/33 Full Call", None, None),
]


# --- the parser --------------------------------------------------------------


@pytest.mark.parametrize("row_id, name, description, asset_type, expected", REAL,
                         ids=[str(r[0]) for r in REAL])
def test_real_option_rows_parse(row_id, name, description, asset_type, expected):
    assert parse(name, description, asset_type) == expected


@pytest.mark.parametrize("row_id, name, description, asset_type", NOT_OPTIONS,
                         ids=[str(r[0]) for r in NOT_OPTIONS])
def test_real_near_misses_stay_unparsed(row_id, name, description, asset_type):
    assert parse(name, description, asset_type) is None


def test_a_row_naming_both_a_call_and_a_put_is_not_one_contract():
    assert parse("Apple Inc.", "Option Type: Call · also sold put options", "OP") is None


def test_an_op_row_whose_text_names_no_contract_stays_unparsed():
    # Typed OP, but nothing to read: the type alone is not a kind.
    assert parse("Apple Inc. - Common Stock", "Sold 5 contracts", "OP") is None


def test_two_different_strikes_or_expiries_cancel_rather_than_pick_one():
    c = parse("Apple Inc.", "Call options; strike $120 and strike $125; "
              "expires 06/18/2026 or expires 07/16/2026", "OP")
    assert c == OptionContract("call", None, None)


def test_a_repeated_strike_is_still_one_strike():
    c = parse("Apple Inc.", "Call options; strike $120; strike price $120.00; "
              "expires 06/18/2026", "OP")
    assert c == OptionContract("call", 12_000, "2026-06-18")


def test_the_word_call_on_a_debt_row_is_never_a_contract():
    # Even phrased as an option: a bond's call is the issuer's right.
    assert parse("ACME 5% 2030", "issuer call option on 12/1/27", "CS") is None


def test_an_impossible_expiry_is_left_null_not_corrected():
    c = parse("Apple Inc.", "Call options; strike $120; expires 13/45/2026", "OP")
    assert c == OptionContract("call", 12_000, None)


def test_a_fractional_strike_is_kept_to_the_cent():
    assert parse("X", "Put options, strike price of $1,250.50", "OP").strike_cents == 125_050


def test_columns_are_null_when_unparsed():
    assert options.columns("CALLAWAY GOLF COMPANY CMN") == {
        "option_kind": None, "strike_cents": None, "expiry": None}
    assert options.columns("PUT/XSP @ 690 EXP 10/16/2026") == {
        "option_kind": "put", "strike_cents": 69_000, "expiry": "2026-10-16"}


def test_describe_prints_only_what_was_parsed():
    assert options.describe("call", 12_000, "2027-01-16") == (
        "call option · strike $120 · expires 01/16/2027")
    assert options.describe("put", 1_180, None) == "put option · strike $11.80"
    assert options.describe("put") == "put option"
    assert options.describe(None) is None


# --- the schema ---------------------------------------------------------------


@pytest.fixture
def conn(tmp_path):
    c = db.connect(tmp_path / "t.sqlite3")
    yield c
    c.close()


def _member(conn, name="Nancy Pelosi", bioguide="P000197"):
    return db.upsert_politician(conn, bioguide_id=bioguide, full_name=name,
                                first=name.split()[0], last=name.split()[-1],
                                chamber="house", party="D", state="CA", district="11",
                                active=1)


def _tx(ticker, action, description=None, asset_type="OP", lo=10_000_100, hi=25_000_000,
        tx_date="2026-06-15", asset_name=None):
    name = asset_name or f"{ticker} Inc."
    return {"ticker": ticker, "action": action, "asset_name": name, "asset_type": asset_type,
            "tx_date": tx_date, "notification_date": tx_date, "owner": None,
            "amount_min_cents": lo, "amount_max_cents": hi, "amount_exact_cents": None,
            "cap_gains_over_200": None, "description": description, "raw_text": "",
            **options.columns(name, description, asset_type)}


def _filing(conn, rows, politician_id=None, filer_name="Nancy Pelosi", doc_id="1",
            status="parsed"):
    fid = db.insert_filing(
        conn, chamber="house", doc_id=doc_id, politician_id=politician_id,
        filer_name=filer_name, state_district="CA11", filing_type="P",
        filing_date="2026-06-20", year=2026, pdf_url=f"http://clerk/{doc_id}.pdf",
        status=status)
    db.replace_transactions(conn, fid, politician_id, rows)
    conn.commit()
    return fid


PUT_TEXT = "Option Type: Put · Strike price: $100.00 · Expires: 12/18/2026"
CALL_TEXT = "Call options; Strike price $120; Expires 01/16/2027"


def test_a_fresh_database_stores_the_contract_columns(conn):
    pid = _member(conn)
    _filing(conn, [_tx("NVDA", "purchase", CALL_TEXT)], politician_id=pid)
    row = conn.execute("SELECT option_kind, strike_cents, expiry FROM transactions").fetchone()
    assert tuple(row) == ("call", 12_000, "2027-01-16")


def test_a_version_8_database_gains_and_fills_the_columns_on_connect(tmp_path):
    path = tmp_path / "old.sqlite3"
    c = db.connect(path)
    pid = _member(c)
    _filing(c, [_tx("NVDA", "purchase", CALL_TEXT),
                _tx("CLF", "purchase", PUT_TEXT),
                _tx("MSFT", "purchase", None, asset_type="ST")], politician_id=pid)
    for column in options.COLUMNS:
        c.execute(f"ALTER TABLE transactions DROP COLUMN {column}")
    c.execute("PRAGMA user_version = 8")
    c.commit()
    c.close()

    c = db.connect(path)
    try:
        assert c.execute("PRAGMA user_version").fetchone()[0] >= 11
        rows = c.execute(
            "SELECT ticker, option_kind, strike_cents, expiry FROM transactions ORDER BY id"
        ).fetchall()
        assert [tuple(r) for r in rows] == [
            ("NVDA", "call", 12_000, "2027-01-16"),
            ("CLF", "put", 10_000, "2026-12-18"),
            ("MSFT", None, None, None),
        ]
    finally:
        c.close()


def test_backfill_rewrites_every_row_from_its_own_text(conn):
    pid = _member(conn)
    rows = [_tx("NVDA", "purchase", CALL_TEXT), _tx("MSFT", "purchase", None, asset_type="ST")]
    # A stale contract on a row whose text names none must not survive.
    rows[1].update(option_kind="put", strike_cents=1, expiry="2026-01-01")
    _filing(conn, rows, politician_id=pid)
    assert options.backfill(conn) == (2, 1)
    assert conn.execute(
        "SELECT option_kind FROM transactions WHERE ticker = 'MSFT'").fetchone()[0] is None


def test_the_pipeline_row_builder_carries_the_contract():
    from whale.ptr import Transaction

    tx = Transaction(asset_name="Microsoft Corporation - Common Stock", action="purchase",
                     ticker="MSFT", asset_type="OP", amount_raw="$15,001 - $50,000",
                     description=CALL_TEXT)
    row = pipeline._transaction_row(tx)
    assert (row["option_kind"], row["strike_cents"], row["expiry"]) == (
        "call", 12_000, "2027-01-16")
    assert row["asset_name"] == "Microsoft Corporation - Common Stock"


# --- config -------------------------------------------------------------------


def test_both_switches_default_off(tmp_path):
    assert AlertSettings().options_every_trade is False
    assert AlertSettings().cluster_count_options is False
    absent = load_config(tmp_path / "absent.yaml").alerts
    assert (absent.options_every_trade, absent.cluster_count_options) == (False, False)


def test_the_shipped_config_leaves_both_off():
    shipped = load_config(DEFAULT_CONFIG_FILE).alerts
    assert (shipped.options_every_trade, shipped.cluster_count_options) == (False, False)


def test_the_switches_read_from_config(tmp_path):
    f = tmp_path / "c.yaml"
    f.write_text("alerts:\n  options_every_trade: true\n  cluster_count_options: true\n")
    a = load_config(f).alerts
    assert (a.options_every_trade, a.cluster_count_options) == (True, True)


def test_a_misspelt_alerts_key_is_refused(tmp_path):
    f = tmp_path / "c.yaml"
    f.write_text("alerts:\n  options_every_trades: true\n")
    with pytest.raises(ConfigError, match="unknown key"):
        load_config(f)


def test_a_quoted_false_is_refused_rather_than_read_as_true(tmp_path):
    f = tmp_path / "c.yaml"
    f.write_text('alerts:\n  options_every_trade: "false"\n')
    with pytest.raises(ConfigError, match="true or false"):
        load_config(f)


# --- the cluster finder -------------------------------------------------------

SETTINGS = dict(window_days=90, min_politicians=3, min_volume_usd=500_000,
                min_member_floor_usd=15_001)


def _seed(conn, spec):
    for i, (name, rows) in enumerate(spec):
        pid = _member(conn, name=name, bioguide=f"X{i:06d}")
        _filing(conn, rows, politician_id=pid, filer_name=name, doc_id=f"d{i}",
                status="backfilled")


def _clusters(conn, **overrides):
    return stats.find_clusters(conn, AlertSettings(**SETTINGS, **overrides), today=TODAY)


def test_trade_direction_reads_a_put_by_exposure_only_when_asked():
    assert stats.trade_direction("purchase", "put", None) == "buy"      # as filed
    assert stats.trade_direction("purchase", "put", True) == "sell"     # a bet against
    assert stats.trade_direction("sale", "put", True) == "buy"
    assert stats.trade_direction("purchase", "call", True) == "buy"
    assert stats.trade_direction("sale", "call", True) == "sell"
    assert stats.trade_direction("purchase", "put", False) is None      # counts nowhere
    assert stats.trade_direction("purchase", None, False) == "buy"      # nothing known
    assert stats.trade_direction("exchange", "call", True) is None


def test_three_members_buying_puts_are_not_a_buy_cluster(conn):
    _seed(conn, [(f"M{i}", [_tx("NVDA", "purchase", PUT_TEXT)]) for i in range(3)])
    # Off: a parsed contract counts toward neither direction.
    assert _clusters(conn) == []
    # On: by exposure — a sell cluster.
    [c] = _clusters(conn, cluster_count_options=True)
    assert (c.ticker, c.direction, c.politician_count) == ("NVDA", "sell", 3)


def test_three_members_buying_calls_are_a_buy_cluster_when_counted(conn):
    _seed(conn, [(f"M{i}", [_tx("NVDA", "purchase", CALL_TEXT)]) for i in range(3)])
    assert _clusters(conn) == []
    [c] = _clusters(conn, cluster_count_options=True)
    assert (c.direction, c.members) == ("buy", ["M0", "M1", "M2"])


def test_selling_puts_counts_as_buying_when_counted(conn):
    _seed(conn, [(f"M{i}", [_tx("NVDA", "sale", PUT_TEXT)]) for i in range(3)])
    [c] = _clusters(conn, cluster_count_options=True)
    assert c.direction == "buy"


def test_an_op_row_with_no_parsed_contract_counts_as_filed_either_way(conn):
    _seed(conn, [(f"M{i}", [_tx("NVDA", "purchase", "Sold 5 contracts")]) for i in range(3)])
    assert [c.direction for c in _clusters(conn)] == ["buy"]
    assert [c.direction for c in _clusters(conn, cluster_count_options=True)] == ["buy"]


def test_the_ticker_view_still_reproduces_the_filing(conn):
    # Only the cluster finder reads by exposure; everything else shows what
    # was filed, so a bought put is a purchase on the ticker page and in the
    # per-filing context line.
    _seed(conn, [("M0", [_tx("NVDA", "purchase", PUT_TEXT)])])
    s = stats.ticker_stats(conn, 90, today=TODAY)["NVDA"]
    assert (s.buy_count, s.sell_count) == (1, 0)


# --- the per-trade alert -------------------------------------------------------


@pytest.fixture
def sent(monkeypatch):
    messages = []
    monkeypatch.setattr(telegram, "send_message",
                        lambda token, chat, text, **kw: messages.append(text))
    return messages


def _config(**alerts) -> Config:
    config = Config(telegram_bot_token="t", telegram_chat_id="c")
    config.alerts = AlertSettings(**alerts)
    return config


def test_the_contract_is_on_the_transaction_line():
    line = telegram._tx_line(_tx("NVDA", "purchase", CALL_TEXT))
    assert "call option · strike $120 · expires 01/16/2027" in line
    assert "call option" not in telegram._tx_line(_tx("NVDA", "purchase", None, asset_type="ST"))


def test_an_option_trade_is_its_own_alert_ahead_of_the_filings_digest(conn, sent):
    pid = _member(conn)
    _filing(conn, [_tx("MSFT", "purchase", None, asset_type="ST"),
                   _tx("NVDA", "purchase", CALL_TEXT)], politician_id=pid)
    assert pipeline.notify_pending(conn, _config(options_every_trade=True)) == 2
    assert len(sent) == 2
    assert sent[0].startswith("🎯 <b>OPTIONS — Rep. Nancy Pelosi (D-CA11)</b>")
    assert "NVDA" in sent[0] and "call option · strike $120 · expires 01/16/2027" in sent[0]
    # Placed in its filing, which the digest then reports whole.
    assert "transaction 2 of 2" in sent[0]
    assert "New filing" in sent[1] and "2 transactions" in sent[1]
    row = conn.execute("SELECT status, notified_at FROM filings").fetchone()
    assert row["status"] == "notified" and row["notified_at"]


def test_off_by_default_the_digest_alone_reports_the_trade(conn, sent):
    pid = _member(conn)
    _filing(conn, [_tx("NVDA", "purchase", CALL_TEXT)], politician_id=pid)
    assert pipeline.notify_pending(conn, _config()) == 1
    assert "OPTIONS" not in sent[0] and "New filing" in sent[0]
    # The digest still shows the contract.
    assert "call option · strike $120" in sent[0]


def test_a_filing_of_only_options_is_consumed_without_a_digest(conn, sent):
    pid = _member(conn)
    _filing(conn, [_tx("NVDA", "purchase", CALL_TEXT), _tx("CLF", "purchase", PUT_TEXT)],
            politician_id=pid)
    assert pipeline.notify_pending(conn, _config(options_every_trade=True)) == 2
    assert [m.startswith("🎯") for m in sent] == [True, True]
    assert "transaction 1 of 2" in sent[0] and "transaction 2 of 2" in sent[1]
    assert conn.execute("SELECT status FROM filings").fetchone()["status"] == "notified"
    assert pipeline.notify_pending(conn, _config(options_every_trade=True)) == 0


def test_options_alerts_go_out_before_other_members_digests(conn, sent):
    other = _member(conn, name="Mark Alford", bioguide="A000370")
    _filing(conn, [_tx("MSFT", "purchase", None, asset_type="ST")], politician_id=other,
            filer_name="Mark Alford", doc_id="1")
    pid = _member(conn)
    _filing(conn, [_tx("MSFT", "purchase", None, asset_type="ST"),
                   _tx("NVDA", "purchase", CALL_TEXT)], politician_id=pid, doc_id="2")
    pipeline.notify_pending(conn, _config(options_every_trade=True))
    assert [m[:1] for m in sent] == ["🎯", "🏛", "🏛"]


def test_a_watched_members_options_are_not_sent_twice(conn, sent):
    from whale.config import WatchedMember, WatchlistSettings

    pid = _member(conn)
    _filing(conn, [_tx("NVDA", "purchase", CALL_TEXT)], politician_id=pid)
    config = _config(options_every_trade=True)
    config.watchlist = WatchlistSettings(
        members=[WatchedMember(name="Nancy Pelosi", bioguide_id="P000197")])
    assert pipeline.notify_pending(conn, config) == 1
    assert len(sent) == 1 and "WATCHLIST" in sent[0]
    assert "call option · strike $120" in sent[0]


def test_a_failed_options_alert_holds_the_whole_filing_for_retry(conn, monkeypatch):
    pid = _member(conn)
    _filing(conn, [_tx("MSFT", "purchase", None, asset_type="ST"),
                   _tx("NVDA", "purchase", CALL_TEXT),
                   _tx("CLF", "purchase", PUT_TEXT)], politician_id=pid)
    calls = []

    def flaky(token, chat, text, **kw):
        calls.append(text)
        if len(calls) == 2:
            raise RuntimeError("telegram down")

    monkeypatch.setattr(telegram, "send_message", flaky)
    assert pipeline.notify_pending(conn, _config(options_every_trade=True)) == 1
    # No digest went out: it would have marked the filing done with an
    # option alert missing. Next run replays the whole filing.
    assert not any("New filing" in m for m in calls)
    row = conn.execute("SELECT status, notified_at FROM filings").fetchone()
    assert row["status"] == "parsed" and row["notified_at"] is None


def test_a_dry_run_previews_without_consuming(conn, sent, capsys):
    pid = _member(conn)
    _filing(conn, [_tx("NVDA", "purchase", CALL_TEXT)], politician_id=pid)
    assert pipeline.notify_pending(conn, _config(options_every_trade=True), dry_run=True) == 0
    assert "OPTIONS" in capsys.readouterr().out
    assert sent == []
    row = conn.execute("SELECT status, notified_at FROM filings").fetchone()
    assert row["status"] == "parsed" and row["notified_at"] is None
