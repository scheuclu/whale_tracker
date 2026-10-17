"""Routine filings past the row budget are summarised, not degraded.

`format_filing` fits a long filing into Telegram's 4,096 characters by
dropping context, then every row's asset name and trade date, then rows. Six
real filings of 42–99 transactions went out that way. Past the budget the
pipeline now sends a summary instead: member, filing date, row count, the
largest trades as their disclosed ranges, the spread across brackets, the PDF,
and the member's dashboard page for the full table. Watched members are
untouched: their filings are split per transaction, and stay exempt.
"""

import pytest

from whale import db, pipeline, telegram
from whale.config import Config, WatchedMember, WatchlistSettings, load_config
from whale.stats import TickerStat, Volume
from whale.telegram import (FILING_ROW_BUDGET, TELEGRAM_LIMIT, format_filing_summary,
                            member_page_url)

LOWEST = (100_100, 1_500_000)        # $1,001–$15,000
SECOND = (1_500_100, 5_000_000)      # $15,001–$50,000
MID = (10_000_100, 25_000_000)       # $100,001–$250,000
BIG = (100_000_100, 500_000_000)     # $1,000,001–$5,000,000
OVER = (5_000_000_100, None)         # Over $50,000,000


def _tx(i=0, ticker=None, action="purchase", bracket=LOWEST, exact=None, **kw):
    lo, hi = bracket
    base = {"ticker": ticker or f"TK{i:02d}", "action": action,
            "asset_name": f"Company {i} Inc.", "amount_min_cents": lo,
            "amount_max_cents": hi, "amount_exact_cents": exact,
            "tx_date": f"2026-06-{(i % 28) + 1:02d}", "notification_date": "2026-06-30",
            "owner": None, "delay_days": 30 - (i % 28)}
    base.update(kw)
    return base


def _summary(transactions, **kw):
    args = {"member": "Kevin Hern", "party": "R", "state": "OK", "district": "1",
            "chamber": "house", "filing_date": "2026-09-25",
            "pdf_url": "https://disclosures-clerk.house.gov/x/20035491.pdf",
            "transactions": transactions,
            "member_url": member_page_url("Kevin Hern", "https://whale.example")}
    args.update(kw)
    return format_filing_summary(**args)


def _forty_five():
    rows = [_tx(i) for i in range(45)]
    rows[3] = _tx(3, ticker="MSFT", bracket=MID, action="sale")
    rows[7] = _tx(7, ticker="NVDA", bracket=BIG)
    rows[11] = _tx(11, ticker="AAPL", bracket=SECOND, action="sale_partial")
    return rows


# --- the message ------------------------------------------------------------


def test_summary_carries_member_date_count_links_and_fits():
    msg = _summary(_forty_five())
    assert len(msg) < TELEGRAM_LIMIT
    assert "New filing — Rep. Kevin Hern (R-OK1)" in msg
    assert "Filed 2026-09-25 · 45 transactions" in msg
    assert "43 buys · 2 sells" in msg
    assert "https://whale.example/politicians?m=Kevin%20Hern" in msg
    assert msg.rstrip().endswith("https://disclosures-clerk.house.gov/x/20035491.pdf")


def test_largest_trades_are_ranked_by_bracket_floor_and_shown_as_ranges():
    msg = _summary(_forty_five())
    top = msg.split("Largest 8 by bracket floor")[1].split("Full table")[0]
    lines = [l for l in top.splitlines() if l.startswith(("🟢", "🔴", "🟠"))]
    assert "NVDA" in lines[0] and "$1M–$5M" in lines[0]
    assert "MSFT" in lines[1] and "$100k–$250k" in lines[1]
    assert "AAPL" in lines[2] and "$15k–$50k" in lines[2]
    assert "SELL (partial)" in lines[2]
    # Ranges, never a midpoint presented as a figure.
    assert "mid" not in msg
    for midpoint in ("$3M", "$175k", "$33k", "$8k"):
        assert midpoint not in msg


def test_breakdown_counts_rows_per_bracket_largest_first():
    msg = _summary(_forty_five())
    line = next(l for l in msg.splitlines() if l.startswith("By bracket:"))
    # The lowest bracket renders as "$1,001–$15k": format_amount abbreviates
    # from $10k up, so the floor stays the exact figure the form prints.
    assert line == "By bracket: $1M–$5M ×1 · $100k–$250k ×1 · $15k–$50k ×1 · $1,001–$15k ×42"


def test_open_ended_bracket_ranks_first_and_exact_figures_are_their_own_group():
    rows = [_tx(i) for i in range(41)]
    rows[0] = _tx(0, ticker="OVR", bracket=OVER)
    rows[1] = _tx(1, ticker="BIG", bracket=BIG)
    rows[2] = _tx(2, ticker="EXA", bracket=(272_250, 272_250), exact=272_250)
    msg = _summary(rows)
    top = msg.split("Largest 8 by bracket floor")[1]
    assert top.index("OVR") < top.index("BIG") < top.index("EXA")
    # HTML parse mode: the ">" of an open-ended bracket must arrive escaped.
    assert "&gt;$50M" in msg and ">$50M" not in msg and "$2,723" in msg
    assert "By bracket: &gt;$50M ×1 · $1M–$5M ×1 · $1,001–$15k ×38 · exact figures ×1" in msg


def test_trade_span_and_delay_range_are_stated():
    msg = _summary(_forty_five())
    assert "traded 06/01–06/28" in msg
    assert "filed 3–30d later" in msg


def test_context_lines_follow_the_largest_trades():
    ctx = TickerStat(ticker="NVDA", politician_count=5,
                     buy_volume=Volume(min_cents=1, max_cents=2, mid_cents=170_000_000))
    ctx.buy_politicians = {"a", "b", "c", "d", "e"}
    msg = _summary(_forty_five(), contexts={"NVDA": ctx})
    assert "30d on NVDA: 5 politicians" in msg


def test_pathological_filing_still_fits_and_keeps_both_links():
    rows = [_tx(i, ticker="X" * 10, asset_name="Y" * 200) for i in range(400)]
    msg = _summary(rows)
    assert len(msg) <= TELEGRAM_LIMIT
    assert "400 transactions" in msg
    assert "https://whale.example/politicians?m=Kevin%20Hern" in msg
    assert msg.rstrip().endswith("20035491.pdf")


def test_html_in_names_is_escaped():
    rows = [_tx(i) for i in range(41)]
    rows[0] = _tx(0, ticker="PG", bracket=BIG, asset_name="Procter & Gamble <Co>")
    msg = _summary(rows, member="Smith & Jones")
    assert "Procter &amp; Gamble &lt;Co&gt;" in msg and "<Co>" not in msg
    assert "Rep. Smith &amp; Jones" in msg


# --- the member page link ---------------------------------------------------


def test_member_page_url_matches_the_dashboards_memberhref():
    # web/lib/format.ts: `/politicians?m=${encodeURIComponent(name)}`.
    assert member_page_url("Gilbert Ray Cisneros, Jr.") == \
        "/politicians?m=Gilbert%20Ray%20Cisneros%2C%20Jr."
    assert member_page_url("Kevin Hern", "https://whale.example/") == \
        "https://whale.example/politicians?m=Kevin%20Hern"


def test_dashboard_url_is_read_from_config_and_absent_means_relative(tmp_path):
    f = tmp_path / "config.yaml"
    f.write_text("dashboard:\n  url: https://whale.example/\n")
    assert load_config(f, tmp_path / "db").dashboard_url == "https://whale.example"
    f.write_text("dashboard:\n  url: ''\n")
    assert load_config(f, tmp_path / "db").dashboard_url is None
    f.write_text("alerts: {}\n")
    assert load_config(f, tmp_path / "db").dashboard_url is None


# --- the pipeline -----------------------------------------------------------


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


def _config(dashboard_url=None, *watch) -> Config:
    config = Config(telegram_bot_token="t", telegram_chat_id="c", dashboard_url=dashboard_url)
    config.watchlist = WatchlistSettings(members=list(watch))
    return config


def _filing(conn, n_tx, bioguide="H001082", name="Kevin Hern", doc_id="1"):
    pid = db.upsert_politician(conn, bioguide_id=bioguide, full_name=name,
                               first=name.split()[0], last=name.split()[-1],
                               chamber="house", party="R", state="OK", district="1",
                               active=1)
    fid = db.insert_filing(conn, chamber="house", doc_id=doc_id, politician_id=pid,
                           filer_name=name, state_district="OK01", filing_type="P",
                           filing_date="2026-09-25", year=2026,
                           pdf_url=f"http://clerk/{doc_id}.pdf", status="parsed")
    rows = [{**_tx(i), "asset_type": "ST", "cap_gains_over_200": None,
             "description": None, "raw_text": ""} for i in range(n_tx)]
    for r in rows:
        r.pop("delay_days")
    db.replace_transactions(conn, fid, pid, rows)
    conn.commit()
    return fid


def test_a_routine_filing_past_the_budget_is_summarised_and_consumed(conn, sent):
    _filing(conn, FILING_ROW_BUDGET + 5)
    assert pipeline.notify_pending(conn, _config("https://whale.example")) == 1
    [msg] = sent
    assert "45 transactions — too many to list, so a summary" in msg
    assert "Full table: https://whale.example/politicians?m=Kevin%20Hern" in msg
    assert "Largest 8 by bracket floor" in msg
    row = conn.execute("SELECT status, notified_at FROM filings").fetchone()
    assert row["status"] == "notified" and row["notified_at"]


def test_a_filing_at_the_budget_still_gets_the_full_list(conn, sent):
    _filing(conn, FILING_ROW_BUDGET)
    assert pipeline.notify_pending(conn, _config()) == 1
    [msg] = sent
    assert "40 transactions" in msg
    assert "summary" not in msg and "Full table" not in msg
    assert "TK00" in msg and "TK39" in msg


def test_without_a_dashboard_url_the_link_is_the_relative_path(conn, sent):
    _filing(conn, FILING_ROW_BUDGET + 1)
    pipeline.notify_pending(conn, _config())
    assert "Full table: /politicians?m=Kevin%20Hern" in sent[0]


def test_a_watched_members_large_filing_is_still_split_per_transaction(conn, sent):
    _filing(conn, FILING_ROW_BUDGET + 5)
    hern = WatchedMember(name="Kevin Hern", bioguide_id="H001082")
    assert pipeline.notify_pending(conn, _config(None, hern)) == 45
    assert len(sent) == 45
    assert all("WATCHLIST" in m for m in sent)
    assert not any("summary" in m for m in sent)


def test_a_dry_run_prints_the_summary_without_consuming_it(conn, sent, capsys):
    _filing(conn, FILING_ROW_BUDGET + 5)
    pipeline.notify_pending(conn, _config(), dry_run=True)
    assert "too many to list, so a summary" in capsys.readouterr().out
    assert sent == []
    row = conn.execute("SELECT status, notified_at FROM filings").fetchone()
    assert row["status"] == "parsed" and row["notified_at"] is None
