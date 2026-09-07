"""Message formatting.

Telegram hard-fails a message over 4096 characters, and a single filing can
carry 94 transactions, so degradation is a correctness concern rather than
cosmetics.
"""

from whale import telegram
from whale.stats import Cluster, TickerStat, Volume
from whale.telegram import TELEGRAM_LIMIT, esc, format_cluster, format_filing, format_unparsed


def _tx(ticker="NVDA", action="purchase", lo=100_100, hi=1_500_000, **kw):
    base = {"ticker": ticker, "action": action, "asset_name": f"{ticker} Corporation",
            "amount_min_cents": lo, "amount_max_cents": hi, "amount_exact_cents": None,
            "tx_date": "2026-06-16", "notification_date": "2026-06-17",
            "owner": None, "delay_days": 1}
    base.update(kw)
    return base


def _filing(transactions, **kw):
    args = {"member": "Debbie Wasserman Schultz", "party": "D", "state": "FL",
            "district": "25", "chamber": "house", "filing_date": "2026-07-14",
            "pdf_url": "https://disclosures-clerk.house.gov/x.pdf",
            "transactions": transactions}
    args.update(kw)
    return format_filing(**args)


def test_escapes_html_so_ampersands_do_not_break_parsing():
    assert esc("Procter & Gamble <Class A>") == "Procter &amp; Gamble &lt;Class A&gt;"


def test_asset_names_with_ampersands_are_escaped():
    msg = _filing([_tx(ticker="PG", asset_name="Procter & Gamble Co.")])
    assert "Procter &amp; Gamble" in msg
    assert "Procter & Gamble" not in msg


def test_filing_message_has_member_action_ticker_and_amount():
    msg = _filing([_tx(ticker="ICHR", action="sale", lo=272_250, hi=272_250,
                       amount_exact_cents=272_250)])
    assert "Rep. Debbie Wasserman Schultz (D-FL25)" in msg
    assert "SELL" in msg and "ICHR" in msg and "$2,723" in msg
    assert "1 transaction" in msg and "1 transactions" not in msg


def test_senator_gets_the_right_title():
    msg = _filing([_tx()], member="Some Senator", chamber="senate", state="CA",
                  district=None)
    assert msg.startswith("🏛 <b>New filing — Sen. Some Senator (D-CA)")


def test_partial_sale_is_labelled_distinctly():
    # 25% of real transactions are partial sales; showing them as plain sells
    # would misstate what was disclosed.
    assert "SELL (partial)" in _filing([_tx(action="sale_partial")])


def test_spouse_trades_are_marked():
    assert "spouse" in _filing([_tx(owner="SP")])


def test_aggregate_context_line_included_when_others_traded():
    ctx = TickerStat(ticker="NVDA", politician_count=5,
                     buy_volume=Volume(min_cents=1, max_cents=2, mid_cents=170_000_000))
    ctx.buy_politicians = {"a", "b", "c", "d", "e"}
    msg = _filing([_tx()], contexts={"NVDA": ctx})
    assert "30d on NVDA: 5 politicians" in msg


def test_no_context_line_for_a_lone_trader():
    ctx = TickerStat(ticker="NVDA", politician_count=1)
    assert "30d on NVDA" not in _filing([_tx()], contexts={"NVDA": ctx})


def test_largest_real_filing_fits_without_dropping_rows():
    # The largest real 2026 filing has 94 transactions. Dropping to the
    # compact per-line form is enough to keep all of them.
    msg = _filing([_tx(ticker=f"TK{i:02d}") for i in range(94)])
    assert len(msg) <= TELEGRAM_LIMIT
    assert "TK00" in msg and "TK93" in msg
    assert "more" not in msg


def test_pathological_filing_truncates_and_says_so():
    msg = _filing([_tx(ticker="X" * 10, asset_name="Y" * 200) for _ in range(400)])
    assert len(msg) <= TELEGRAM_LIMIT
    assert "more" in msg  # truncation is disclosed, never silent


def test_cluster_message_states_people_volume_and_names():
    cluster = Cluster(ticker="NVDA", direction="buy", politician_count=5,
                      trade_count=6, members=["Green", "Khanna", "McCaul"],
                      volume=Volume(min_cents=110_000_000, max_cents=240_000_000,
                                    mid_cents=170_000_000),
                      reason="5 members")
    msg = format_cluster(cluster, 30)
    assert "CLUSTER ALERT — NVDA" in msg
    assert "5 politicians bought in the last 30 days" in msg
    assert "$1.1M–$2.4M" in msg and "mid $1.7M" in msg
    assert "Khanna" in msg


def test_cluster_with_open_ended_volume_reports_a_floor():
    cluster = Cluster(ticker="NVDA", direction="buy", politician_count=3,
                      trade_count=3, members=["A", "B", "C"],
                      volume=Volume(min_cents=5_000_000_000, max_cents=None,
                                    mid_cents=5_000_000_000, open_ended=True),
                      reason="volume")
    assert "≥$50M" in format_cluster(cluster, 30)


def test_cluster_with_many_members_stays_under_the_limit():
    members = [f"Representative Longname Number {i}" for i in range(300)]
    cluster = Cluster(ticker="NVDA", direction="sell", politician_count=len(members),
                      trade_count=400, members=members,
                      volume=Volume(1, 2, 1), reason="many")
    msg = format_cluster(cluster, 30)
    assert len(msg) <= TELEGRAM_LIMIT and "more" in msg


def test_unparsed_filing_is_reported_with_a_link():
    msg = format_unparsed("Tony Wied", "R", "WI", "8", "house", "2026-08-18",
                          "https://example/9116308.pdf", "scanned paper filing")
    assert "Could not parse" in msg
    assert "https://example/9116308.pdf" in msg


def test_send_message_retries_then_raises_on_rate_limit(monkeypatch):
    calls = []

    class Resp:
        status_code = 429
        text = "rate limited"

        @staticmethod
        def json():
            return {"parameters": {"retry_after": 0}}

    monkeypatch.setattr(telegram.httpx, "post", lambda *a, **k: (calls.append(1), Resp())[1])
    monkeypatch.setattr(telegram.time, "sleep", lambda s: None)
    try:
        telegram.send_message("token", "chat", "hi", max_attempts=3)
    except RuntimeError:
        pass
    else:
        raise AssertionError("expected RuntimeError after exhausting retries")
    assert len(calls) == 3
