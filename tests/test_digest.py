"""The weekly digest: the week's figures, as ranges, in one message, once.

Three things are load-bearing. Every figure keeps the project's amount rules
— a congressional total is a range with a labelled estimate or `≥floor`, an
insider total is labelled as shares × reported price, and a transcribed row
counts as a trade but never as money. The message stays inside Telegram's
limit however busy the week. And the schedule sends exactly once per week
while a dry run sends and records nothing.
"""

from datetime import date, datetime, timedelta, timezone

import pytest

from whale import db, digest, pipeline, telegram
from whale import __main__ as cli
from whale.config import (Config, ConfigError, DEFAULT_CONFIG_FILE, InsiderRule,
                          TelegramSettings, _parse_telegram, load_config)
from whale.telegram import TELEGRAM_LIMIT

TODAY = date(2026, 10, 18)          # a Sunday
SINCE = TODAY - timedelta(days=7)   # 2026-10-11
UTC = timezone.utc


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


def _config(digest_on=True, telegram_ok=True, **kw) -> Config:
    config = Config(telegram_bot_token="t" if telegram_ok else None,
                    telegram_chat_id="c" if telegram_ok else None, **kw)
    config.telegram = TelegramSettings(digest=digest_on)
    return config


# --- fixtures: a week of filings -------------------------------------------


def _member(conn, name, chamber="house", party="D", state="CA", district="1"):
    return db.upsert_politician(conn, bioguide_id=f"X{abs(hash(name)) % 10**6:06d}",
                                full_name=name, first=name.split()[0], last=name.split()[-1],
                                chamber=chamber, party=party, state=state,
                                district=district, active=1)


def _filing(conn, pid, name, filing_date, chamber="house", status="notified",
            parse_method="text", doc_id=None):
    fid = db.insert_filing(
        conn, chamber=chamber, doc_id=doc_id or f"{name}-{filing_date}-{status}",
        politician_id=pid, filer_name=name, state_district="CA01", filing_type="P",
        filing_date=filing_date, year=2026, pdf_url="http://x/pdf", status=status)
    if parse_method:
        db.set_status(conn, fid, status, None, parse_method)
    return fid


def _tx(ticker, action, lo, hi, exact=None, tx_date="2026-10-01", asset_type="ST",
        asset_name=None):
    return {"ticker": ticker, "action": action, "asset_name": asset_name or f"{ticker} Inc.",
            "asset_type": asset_type, "tx_date": tx_date, "notification_date": None,
            "amount_min_cents": lo, "amount_max_cents": hi, "amount_exact_cents": exact}


def _seed_week(conn):
    """Two House members and a senator file inside the window; one House
    filing is older and must not count."""
    alice = _member(conn, "Alice Adams")
    bob = _member(conn, "Bob Brown", party="R", state="TX", district="7")
    carol = _member(conn, "Carol Cole", chamber="senate", state="WA", district=None)

    fa = _filing(conn, alice, "Alice Adams", "2026-10-14")
    db.replace_transactions(conn, fa, alice, [
        _tx("NVDA", "purchase", 100_100, 1_500_000),
        _tx("MSFT", "sale", 1_500_100, 5_000_000),
        # Treasury bills in the top bracket: counted, never "largest".
        _tx(None, "purchase", 2_500_000_100, 5_000_000_000, asset_type="GS",
            asset_name="U.S. Treasury Bill"),
    ])
    fb = _filing(conn, bob, "Bob Brown", "2026-10-16")
    db.replace_transactions(conn, fb, bob, [
        _tx("NVDA", "purchase", 1_500_100, 5_000_000),
        # Traded 60 days before filing: past the 45-day deadline.
        _tx("AAPL", "sale_partial", 100_100, 1_500_000, tx_date="2026-08-17"),
    ])
    fc = _filing(conn, carol, "Carol Cole", "2026-10-12", chamber="senate",
                 parse_method="efd_html")
    db.replace_transactions(conn, fc, carol, [
        _tx("NVDA", "sale", 5_000_000_100, None),   # open-ended top bracket
    ])
    # Last month: outside the window.
    old = _filing(conn, alice, "Alice Adams", "2026-09-20", doc_id="old")
    db.replace_transactions(conn, old, alice, [_tx("TSLA", "purchase", 100_100, 1_500_000)])
    conn.commit()
    return alice, bob, carol


def _insider_filing(conn, accession, ticker, owner, filing_date="2026-10-15",
                    status="backfilled", issuer_cik=None):
    fid = db.insert_insider_filing(
        conn, accession=accession, form_type="4", issuer_cik=issuer_cik or f"CIK-{ticker}",
        issuer_name=f"{ticker} Corp", ticker=ticker, filing_date=filing_date,
        source="feed", source_url="u", status=status)
    db.upsert_insider(conn, f"OWN-{owner}", owner)
    db.replace_insider_owners(conn, fid, [{"cik": f"OWN-{owner}", "is_officer": True}])
    return fid


def _itx(action, value, tx_date="2026-10-14", late=0, implausible=0):
    exact = value
    return {"transaction_code": "P" if action == "purchase" else "S", "action": action,
            "tx_date": tx_date, "shares": 10.0, "price_per_share": value / 1000 if value else None,
            "amount_min_cents": exact, "amount_max_cents": exact, "amount_exact_cents": exact,
            "late": late, "implausible": implausible}


def _seed_insiders(conn):
    f1 = _insider_filing(conn, "A-1", "ACME", "Dana Director")
    db.replace_insider_transactions(conn, f1, [_itx("purchase", 60_000_00),
                                              _itx("purchase", 40_000_00, late=1)])
    f2 = _insider_filing(conn, "A-2", "ACME", "Eve Exec")
    db.replace_insider_transactions(conn, f2, [_itx("purchase", 30_000_00)])
    f3 = _insider_filing(conn, "A-3", "ACME", "Finn Founder")
    db.replace_insider_transactions(conn, f3, [_itx("purchase", 20_000_00)])
    # A sale, an unpriced row and an implausible one: trades, never value.
    f4 = _insider_filing(conn, "B-1", "BOLT", "Gus Grey", status="notified")
    db.replace_insider_transactions(conn, f4, [
        _itx("sale", 500_000_00), _itx("sale", None),
        _itx("purchase", 10_000_000_000_00, implausible=1)])
    conn.execute("UPDATE insider_filings SET notified_at = '2026-10-15T10:00:00Z' WHERE id = ?",
                 (f4,))
    # Filed before the window.
    f5 = _insider_filing(conn, "C-1", "COLD", "Hal Holt", filing_date="2026-09-01")
    db.replace_insider_transactions(conn, f5, [_itx("purchase", 900_000_00, tx_date="2026-08-30")])
    conn.commit()


def _insider_config(**kw) -> Config:
    config = _config(**kw)
    config.insiders.alerts = [InsiderRule(name="Cluster", kind="cluster", direction="buy",
                                          min_insiders=3)]
    return config


# --- the figures ------------------------------------------------------------


def test_counts_filings_and_trades_per_chamber_inside_the_window(conn):
    _seed_week(conn)
    d = digest.build(conn, _config(), today=TODAY)
    assert d.chambers["house"].filings == 2
    assert d.chambers["house"].trades == 5
    assert d.chambers["senate"].filings == 1
    assert d.chambers["senate"].trades == 1
    assert d.filings == 3 and d.trades == 6
    assert d.buy_count == 3 and d.sell_count == 3


def test_volume_is_a_range_and_open_ended_when_the_top_bracket_is_in_it(conn):
    _seed_week(conn)
    d = digest.build(conn, _config(), today=TODAY)
    # Carol's "Over $50M" row has no upper bound, so neither does the total.
    assert d.volume.open_ended and d.volume.max_cents is None
    assert d.volume.min_cents == (100_100 + 1_500_100 + 2_500_000_100
                                  + 1_500_100 + 100_100 + 5_000_000_100)
    msg = digest.format_digest(d)
    assert "volume ≥$75M" in msg
    assert "est. mid" not in msg.split("<b>Insiders")[0]


def test_bounded_volume_prints_the_range_and_a_labelled_estimate(conn):
    alice = _member(conn, "Alice Adams")
    f = _filing(conn, alice, "Alice Adams", "2026-10-14")
    db.replace_transactions(conn, f, alice, [_tx("NVDA", "purchase", 100_100, 1_500_000),
                                             _tx("MSFT", "sale", 1_500_100, 5_000_000)])
    conn.commit()
    msg = digest.format_digest(digest.build(conn, _config(), today=TODAY))
    # $1,001–$15,000 plus $15,001–$50,000: the midpoints are an estimate and say so.
    assert "volume $16k–$65k (est. mid $41k)" in msg


def test_transcribed_rows_count_as_trades_but_never_as_money(conn):
    alice = _member(conn, "Alice Adams")
    f = _filing(conn, alice, "Alice Adams", "2026-10-14", parse_method="vision")
    db.replace_transactions(conn, f, alice, [_tx("NVDA", "purchase", 100_100, 1_500_000)])
    conn.commit()
    d = digest.build(conn, _config(), today=TODAY)
    assert d.trades == 1 and d.transcribed_count == 1
    assert d.volume.min_cents == 0
    assert d.largest == []
    msg = digest.format_digest(d)
    assert "1 transcribed from scans, not in the total" in msg


def test_tickers_are_ranked_by_members_with_the_direction_split(conn):
    _seed_week(conn)
    d = digest.build(conn, _config(), today=TODAY)
    assert [t.ticker for t in d.tickers] == ["NVDA"]
    nvda = d.tickers[0]
    assert (nvda.members, nvda.buyers, nvda.sellers, nvda.trades) == (3, 2, 1, 3)
    msg = digest.format_digest(d)
    assert "Most members: <b>NVDA</b> 3 (2 buy, 1 sell)" in msg
    # One member's MSFT row is a filing restated, not a convergence.
    assert "MSFT</b> 1" not in msg


def test_largest_trades_are_equity_only_ranked_by_floor_and_printed_as_ranges(conn):
    _seed_week(conn)
    d = digest.build(conn, _config(), today=TODAY)
    tickers = [r["ticker"] for r in d.largest]
    # The $25M–$50M Treasury bill is not here; the open-ended NVDA sale leads.
    assert None not in tickers
    assert tickers[:3] == ["NVDA", "MSFT", "NVDA"]
    msg = digest.format_digest(d)
    # ">$50M" is the floor of the open-ended bracket, HTML-escaped for Telegram.
    assert "🔴 SELL <b>NVDA</b> &gt;$50M — Sen. Carol Cole (D-WA)" in msg
    assert "🔴 SELL <b>MSFT</b> $15k–$50k — Rep. Alice Adams (D-CA1)" in msg
    assert "Treasury" not in msg


def test_late_filers_are_those_past_the_45_day_deadline(conn):
    _seed_week(conn)
    d = digest.build(conn, _config(), today=TODAY)
    assert [(f.member, f.late_rows, f.max_delay_days) for f in d.late] == [("Bob Brown", 1, 60)]
    msg = digest.format_digest(d)
    assert "Filed past 45 days: 1 — Rep. Bob Brown (1 trade, up to 60d)" in msg


def test_no_late_filers_is_said_rather_than_omitted(conn):
    alice = _member(conn, "Alice Adams")
    f = _filing(conn, alice, "Alice Adams", "2026-10-14")
    db.replace_transactions(conn, f, alice, [_tx("NVDA", "purchase", 100_100, 1_500_000)])
    conn.commit()
    msg = digest.format_digest(digest.build(conn, _config(), today=TODAY))
    assert "Filed past 45 days: none" in msg


def test_sent_counts_only_what_the_notify_path_sent(conn):
    alice = _member(conn, "Alice Adams")
    # Announced this week.
    f1 = _filing(conn, alice, "Alice Adams", "2026-10-14", doc_id="sent")
    db.mark_notified(conn, f1)
    # Backfilled silently this week: stamps notified_at, was never sent.
    f2 = _filing(conn, alice, "Alice Adams", "2026-10-14", status="backfilled", doc_id="silent")
    db.mark_notified(conn, f2)
    # Announced last month.
    f3 = _filing(conn, alice, "Alice Adams", "2026-09-10", doc_id="old")
    conn.execute("UPDATE filings SET notified_at = '2026-09-11T00:00:00Z' WHERE id = ?", (f3,))
    db.record_alert(conn, "cluster", "NVDA", "buy", 90, 4, 100)
    db.record_alert(conn, "insider_cluster", "ACME", "buy", 30, 3, 100)
    db.record_alert(conn, "insider_cluster", "BOLT", "sell", 30, 5, 100)
    conn.commit()
    d = digest.build(conn, _config(), today=TODAY)
    assert d.filings_notified == 1
    assert d.alerts_sent == {"cluster": 1, "insider_cluster": 2}
    msg = digest.format_digest(d)
    assert "Sent: 1 filing alert · 1 congressional cluster · 2 insider cluster · 0 insider alerts" in msg


def test_insider_totals_are_exact_and_labelled_and_unpriced_rows_carry_nothing(conn):
    _seed_insiders(conn)
    d = digest.build(conn, _insider_config(), today=TODAY)
    assert d.insider_filings == 4                 # COLD was filed before the window
    assert d.insider_buy_count == 5 and d.insider_sell_count == 2
    assert d.insider_buy_volume.min_cents == d.insider_buy_volume.max_cents == 150_000_00
    assert d.insider_sell_volume.min_cents == 500_000_00
    assert d.insider_unpriced == 2
    assert d.insider_notified == 1
    msg = digest.format_digest(d)
    assert "values are shares × reported price" in msg
    assert "4 filings stored · 5 buys $150k · 2 sells $500k" in msg
    assert "2 unpriced or implausible row(s) carry no value" in msg
    assert "est. mid" not in msg.split("<b>Insiders")[1]


def test_largest_insider_buys_are_per_filing_and_flag_late_ones(conn):
    _seed_insiders(conn)
    d = digest.build(conn, _insider_config(), today=TODAY)
    assert [(b.ticker, b.owner, b.value_cents, b.late) for b in d.insider_buys] == [
        ("ACME", "Dana Director", 100_000_00, True),
        ("ACME", "Eve Exec", 30_000_00, False),
        ("ACME", "Finn Founder", 20_000_00, False),
    ]
    msg = digest.format_digest(d)
    assert "🟢 <b>ACME</b> $100k — Dana Director · <i>filed late</i>" in msg
    assert "BOLT" not in msg.split("Largest buys")[1].split("<b>Scans")[0]


def test_insider_clusters_are_measured_on_the_digest_window(conn):
    _seed_insiders(conn)
    d = digest.build(conn, _insider_config(), today=TODAY)
    assert [(c.ticker, c.direction, c.insider_count) for c in d.insider_clusters] == [
        ("ACME", "buy", 3)]
    msg = digest.format_digest(d)
    assert "Clusters (7d): 3 bought <b>ACME</b> ($150k)" in msg
    # Nothing within three days: the convergence is outside the window.
    short = digest.build(conn, _insider_config(), days=3, today=date(2026, 10, 25))
    assert short.insider_clusters == []
    assert "Clusters (3d): none" in digest.format_digest(short)


def test_scans_are_counted_by_outcome_this_week(conn):
    alice = _member(conn, "Alice Adams")
    _filing(conn, alice, "Alice Adams", "2026-10-14", status="backfilled",
            parse_method="vision", doc_id="read")
    _filing(conn, alice, "Alice Adams", "2026-10-14", status="failed",
            parse_method="vision_failed", doc_id="refused")
    _filing(conn, alice, "Alice Adams", "2026-10-14", status="new",
            parse_method="scanned", doc_id="waiting")
    _filing(conn, alice, "Alice Adams", "2026-10-14", status="failed",
            parse_method="efd_paper", chamber="senate", doc_id="paper")
    conn.commit()
    d = digest.build(conn, _config(vision_enabled=True), today=TODAY)
    assert (d.scans_transcribed, d.scans_refused, d.scans_waiting, d.senate_paper) == (1, 1, 1, 1)
    msg = digest.format_digest(d)
    assert "<b>Scans</b> 1 transcribed · 1 refused · 1 waiting · 1 Senate paper" in msg
    off = digest.format_digest(digest.build(conn, _config(vision_enabled=False), today=TODAY))
    assert "1 unread (vision off)" in off


def test_health_line_reads_the_recorded_statuses(conn):
    db.set_state(conn, "senate_status", "blocked: 403 on the agreement page")
    db.set_state(conn, "edgar_status", "throttled: 429 at 2026-10-17T01:00:00Z")
    db.set_state(conn, "edgar_gap", "2026-10-15T00:00:00Z..2026-10-16T00:00:00Z")
    db.set_state(conn, "house_age_cutoff",
                 '{"count": 3, "last_seen_at": "2026-10-16T09:00:00Z"}')
    alice = _member(conn, "Alice Adams")
    _filing(conn, alice, "Alice Adams", "2026-10-14", status="new", parse_method=None)
    conn.commit()
    msg = digest.format_digest(digest.build(conn, _config(), today=TODAY))
    # The vocabulary word only; the detail is the dashboard's.
    assert "<b>Pipeline</b> Senate blocked · EDGAR throttled · feed gap" in msg
    assert "429" not in msg and "agreement" not in msg
    assert "feed gap 2026-10-15T00:00:00Z..2026-10-16T00:00:00Z" in msg
    assert "1 queued" in msg
    assert "Clerk published past the age cutoff" in msg


def test_an_old_age_cutoff_hit_is_not_this_weeks_news(conn):
    db.set_state(conn, "house_age_cutoff",
                 '{"count": 3, "last_seen_at": "2026-09-01T09:00:00Z"}')
    conn.commit()
    msg = digest.format_digest(digest.build(conn, _config(), today=TODAY))
    assert "age cutoff" not in msg
    assert "Senate not attempted · EDGAR not attempted" in msg


def test_an_empty_week_still_renders_every_section(conn):
    msg = digest.format_digest(digest.build(conn, _config(), today=TODAY))
    assert "House 0 filings · 0 trades — Senate 0 filings · 0 trades" in msg
    assert "Filed past 45 days: none" in msg
    assert "0 filings stored · 0 buys — · 0 sells —" in msg
    assert "Clusters (7d): none" in msg
    assert len(msg) <= TELEGRAM_LIMIT


def test_links_use_the_dashboard_url_when_configured(conn):
    with_url = digest.format_digest(digest.build(conn, _config(), today=TODAY),
                                    "https://example.test/")
    assert '<a href="https://example.test/insiders">Insiders</a>' in with_url
    assert "https://example.test//" not in with_url
    without = digest.format_digest(digest.build(conn, _config(), today=TODAY))
    assert "Insiders /insiders" in without and "<a " not in without


def test_html_in_names_is_escaped(conn):
    pid = _member(conn, "Bo <b>Bold</b> & Co")
    f = _filing(conn, pid, "Bo <b>Bold</b> & Co", "2026-10-14")
    db.replace_transactions(conn, f, pid, [_tx("P&G", "purchase", 100_100, 1_500_000)])
    conn.commit()
    msg = digest.format_digest(digest.build(conn, _config(), today=TODAY))
    assert "Bo &lt;b&gt;Bold&lt;/b&gt; &amp; Co" in msg
    assert "<b>P&amp;G</b>" in msg


# --- the limit --------------------------------------------------------------


def test_a_busy_week_degrades_to_fit_the_limit(conn):
    # 300 late filers with long names, each a member of a 300-way NVDA
    # convergence: the full lists would be tens of thousands of characters.
    for i in range(300):
        name = f"Representative Number {i:03d} Of A Very Long Name Indeed"
        pid = _member(conn, name)
        f = _filing(conn, pid, name, "2026-10-14")
        db.replace_transactions(conn, f, pid, [
            _tx("NVDA", "purchase", 1_000_100, 5_000_000, tx_date="2026-07-01")])
    for i in range(50):
        f = _insider_filing(conn, f"Z-{i}", "ACME", f"Insider With A Long Name {i:02d}")
        db.replace_insider_transactions(conn, f, [_itx("purchase", (50 - i) * 1_000_000_00)])
    conn.commit()
    d = digest.build(conn, _insider_config(), today=TODAY)
    assert len(d.late) == 300 and len(d.insider_buys) == 50
    msg = digest.format_digest(d, "https://example.test")
    assert len(msg) <= TELEGRAM_LIMIT
    # The totals survive; the lists shrank rather than the headline figures.
    assert "House 300 filings · 300 trades" in msg
    assert "Filed past 45 days: 300" in msg
    assert "+" in msg and "more" in msg


def test_the_fullest_shape_is_used_when_it_fits(conn):
    _seed_week(conn)
    d = digest.build(conn, _config(), today=TODAY)
    full = digest._render(d, None, *digest._SHAPES[0])
    assert digest.format_digest(d) == full


# --- the schedule -----------------------------------------------------------


def test_due_week_turns_over_on_monday_at_0700_utc():
    monday = date(2026, 10, 12)
    assert digest.due_week(datetime(2026, 10, 12, 6, 59, tzinfo=UTC)) == "2026-10-05"
    assert digest.due_week(datetime(2026, 10, 12, 7, 0, tzinfo=UTC)) == monday.isoformat()
    assert digest.due_week(datetime(2026, 10, 15, 12, 0, tzinfo=UTC)) == monday.isoformat()
    assert digest.due_week(datetime(2026, 10, 18, 23, 59, tzinfo=UTC)) == monday.isoformat()
    assert digest.due_week(datetime(2026, 10, 19, 7, 0, tzinfo=UTC)) == "2026-10-19"


def test_due_week_reads_the_clock_in_utc():
    # 08:00 in UTC+2 is 06:00 UTC: still last week.
    plus_two = timezone(timedelta(hours=2))
    assert digest.due_week(datetime(2026, 10, 12, 8, 0, tzinfo=plus_two)) == "2026-10-05"
    assert digest.due_week(datetime(2026, 10, 12, 9, 0, tzinfo=plus_two)) == "2026-10-12"


def test_scheduled_sends_once_per_week_and_records_it(conn, sent):
    _seed_week(conn)
    config = _config()
    monday = datetime(2026, 10, 12, 9, 30, tzinfo=UTC)
    assert digest.scheduled(conn, config, now=monday) is True
    assert len(sent) == 1 and sent[0].startswith("📬 <b>Weekly digest</b>")
    assert db.get_state(conn, digest.STATE_KEY) == "2026-10-12"
    # Later runs in the same week: nothing.
    assert digest.scheduled(conn, config, now=monday + timedelta(hours=3)) is False
    assert digest.scheduled(conn, config, now=datetime(2026, 10, 18, 23, 0, tzinfo=UTC)) is False
    assert len(sent) == 1
    # The next Monday's first run after 07:00.
    assert digest.scheduled(conn, config, now=datetime(2026, 10, 19, 7, 5, tzinfo=UTC)) is True
    assert len(sent) == 2
    assert db.get_state(conn, digest.STATE_KEY) == "2026-10-19"


def test_a_missed_monday_is_caught_up_by_the_next_run(conn, sent):
    db.set_state(conn, digest.STATE_KEY, "2026-10-05")
    conn.commit()
    assert digest.scheduled(conn, _config(), now=datetime(2026, 10, 14, 1, 0, tzinfo=UTC)) is True
    assert db.get_state(conn, digest.STATE_KEY) == "2026-10-12"


def test_scheduled_is_off_unless_configured(conn, sent):
    assert digest.scheduled(conn, _config(digest_on=False),
                            now=datetime(2026, 10, 12, 9, 0, tzinfo=UTC)) is False
    assert sent == []
    assert db.get_state(conn, digest.STATE_KEY) is None


def test_scheduled_without_telegram_secrets_sends_and_records_nothing(conn, sent):
    assert digest.scheduled(conn, _config(telegram_ok=False),
                            now=datetime(2026, 10, 12, 9, 0, tzinfo=UTC)) is False
    assert sent == []
    assert db.get_state(conn, digest.STATE_KEY) is None


def test_a_dry_run_prints_and_records_nothing(conn, sent, capsys):
    _seed_week(conn)
    now = datetime(2026, 10, 12, 9, 0, tzinfo=UTC)
    assert digest.scheduled(conn, _config(telegram_ok=False), dry_run=True, now=now) is True
    assert sent == []
    assert db.get_state(conn, digest.STATE_KEY) is None
    assert "Weekly digest" in capsys.readouterr().out
    # So the next real run still owes the week.
    assert digest.scheduled(conn, _config(), now=now) is True
    assert len(sent) == 1


def test_a_failed_send_leaves_the_week_owed(conn, monkeypatch):
    def boom(*a, **kw):
        raise RuntimeError("telegram down")
    monkeypatch.setattr(telegram, "send_message", boom)
    assert digest.scheduled(conn, _config(), now=datetime(2026, 10, 12, 9, 0, tzinfo=UTC)) is False
    assert db.get_state(conn, digest.STATE_KEY) is None


def test_scheduled_never_raises_into_the_pipeline(conn, sent, monkeypatch):
    def broken(*a, **kw):
        raise ValueError("a formatting bug")
    monkeypatch.setattr(digest, "build", broken)
    assert digest.scheduled(conn, _config(), now=datetime(2026, 10, 12, 9, 0, tzinfo=UTC)) is False
    assert sent == []


def test_pipeline_run_calls_the_hook_after_insider_alerts(monkeypatch, tmp_path):
    order = []
    for step in ("sync", "retry_scanned", "parse_pending", "notify_pending",
                 "notify_clusters", "_sync_insiders", "notify_insiders"):
        # The real steps return a count for the run log (#63); the stubs must too.
        monkeypatch.setattr(pipeline, step,
                            lambda conn, config, _s=step, **kw: order.append(_s) or 0)
    monkeypatch.setattr(pipeline.digest, "scheduled",
                        lambda conn, config, dry_run=False: order.append(("digest", dry_run)))
    pipeline.run(Config(db_path=tmp_path / "t.sqlite3"), dry_run=True)
    assert order[-2:] == ["notify_insiders", ("digest", True)]


def test_a_manual_send_records_the_week_so_the_poll_does_not_repeat_it(conn, sent):
    now = datetime(2026, 10, 13, 12, 0, tzinfo=UTC)
    digest.send(conn, _config(), days=14, now=now)
    assert len(sent) == 1 and "2026-09-29 → 2026-10-13" in sent[0]
    assert db.get_state(conn, digest.STATE_KEY) == "2026-10-12"
    assert digest.scheduled(conn, _config(), now=now) is False
    assert len(sent) == 1


def test_a_manual_send_needs_telegram_secrets(conn, sent):
    with pytest.raises(RuntimeError, match="TELEGRAM_BOT_TOKEN"):
        digest.send(conn, _config(telegram_ok=False))
    assert sent == [] and db.get_state(conn, digest.STATE_KEY) is None


# --- the CLI ----------------------------------------------------------------


def test_cli_digest_dry_run_prints_without_recording(tmp_path, monkeypatch, capsys, sent):
    config = _config(telegram_ok=False, db_path=tmp_path / "t.sqlite3")
    monkeypatch.setattr(cli, "load_config", lambda: config)
    assert cli.main(["digest", "--dry-run", "--days", "14"]) == 0
    out = capsys.readouterr().out
    assert "📬 <b>Weekly digest</b>" in out
    assert sent == []
    conn = db.connect(config.db_path)
    try:
        assert db.get_state(conn, digest.STATE_KEY) is None
    finally:
        conn.close()


def test_cli_digest_refuses_to_send_without_secrets(tmp_path, monkeypatch, sent):
    config = _config(telegram_ok=False, db_path=tmp_path / "t.sqlite3")
    monkeypatch.setattr(cli, "load_config", lambda: config)
    with pytest.raises(SystemExit):
        cli.main(["digest"])
    assert sent == []


def test_cli_digest_rejects_a_window_under_a_day(tmp_path, monkeypatch):
    config = _config(db_path=tmp_path / "t.sqlite3")
    monkeypatch.setattr(cli, "load_config", lambda: config)
    with pytest.raises(SystemExit):
        cli.main(["digest", "--dry-run", "--days", "0"])


# --- the config block -------------------------------------------------------


def test_the_shipped_config_leaves_the_digest_off():
    assert load_config(DEFAULT_CONFIG_FILE).telegram.digest is False


def test_an_absent_block_is_off_and_a_boolean_is_honoured():
    assert _parse_telegram(None).digest is False
    assert _parse_telegram({}).digest is False
    assert _parse_telegram({"digest": True}).digest is True


def test_a_string_is_refused_rather_than_read_as_true():
    with pytest.raises(ConfigError, match="true or false"):
        _parse_telegram({"digest": "false"})


def test_an_unknown_key_is_refused():
    with pytest.raises(ConfigError, match="unknown key"):
        _parse_telegram({"digets": True})


def test_a_non_mapping_block_is_refused():
    with pytest.raises(ConfigError, match="mapping"):
        _parse_telegram(True)


def test_load_config_reads_the_block(tmp_path):
    (tmp_path / "config.yaml").write_text("telegram:\n  digest: true\n")
    assert load_config(tmp_path / "config.yaml", tmp_path / "db").telegram.digest is True
