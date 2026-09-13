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


# --- insiders (SEC Form 4) --------------------------------------------------


class _Row(dict):
    """sqlite3.Row is read-only and not constructible; the formatters only
    subscript, so a dict stands in."""

    def __getitem__(self, key):
        return self.get(key)


def _insider_match(rows, *, rule_name="Large insider buy", direction="purchase",
                   issuer="Acme & Co.", ticker="ACME", plan=None,
                   owners=None, value=None):
    from whale.config import _parse_rule
    from whale.insider_alerts import FilingMatch

    filing = _Row(accession="0000000000-26-000001", ticker=ticker, issuer_name=issuer,
                  filing_date="2026-06-20", aff_10b5_one=plan,
                  source_url="http://sec/x-index.htm")
    owners = owners or [_Row(insider_cik="0000000010", name="Alex Officer",
                             is_officer=1, is_director=0, is_ten_percent_owner=0,
                             officer_title="Chief Executive Officer")]
    if value is None:
        value = sum(r["amount_exact_cents"] or 0 for r in rows) or None
    return FilingMatch(_parse_rule({"name": rule_name}, 0), filing, direction,
                       value, rows, owners)


def _insider_row(**over):
    row = {"action": "purchase", "shares": 1000.0, "price_per_share": 10.0,
           "amount_exact_cents": 1_000_000, "tx_date": "2026-06-18", "late": 0}
    row.update(over)
    return _Row(row)


def test_insider_message_leads_with_the_rule_name_and_shows_the_arithmetic():
    msg = telegram.format_insider_filing(_insider_match([_insider_row()]))
    assert msg.startswith("🟢 <b>Large insider buy — ACME</b>")
    # The inputs are the label: nobody has to wonder whether the figure was
    # disclosed or derived.
    assert "1,000 sh @ $10.00 = <b>$10k</b>" in msg
    assert "Chief Executive Officer" in msg
    assert "http://sec/x-index.htm" in msg


def test_insider_message_escapes_html_in_names():
    msg = telegram.format_insider_filing(
        _insider_match([_insider_row()], issuer="Smith & <Sons>"))
    assert "Smith &amp; &lt;Sons&gt;" in msg
    assert "<Sons>" not in msg


def test_insider_row_without_a_price_says_so_rather_than_showing_zero():
    msg = telegram.format_insider_filing(
        _insider_match([_insider_row(price_per_share=None, amount_exact_cents=None)]))
    assert "no price filed" in msg
    assert "$0" not in msg


def test_insider_message_flags_a_late_filing_and_a_plan():
    msg = telegram.format_insider_filing(
        _insider_match([_insider_row(late=1)], plan=1))
    assert "filed late" in msg and "10b5-1 plan" in msg


def test_insider_message_notes_joint_filers():
    owners = [
        _Row(insider_cik="1", name="Fran Founder", is_officer=1, is_director=0,
             is_ten_percent_owner=0, officer_title="CEO"),
        _Row(insider_cik="2", name="Founder LLC", is_officer=0, is_director=0,
             is_ten_percent_owner=1, officer_title=None),
    ]
    msg = telegram.format_insider_filing(_insider_match([_insider_row()], owners=owners))
    assert "+1 joint filer" in msg


def test_insider_message_with_many_rows_stays_within_one_telegram_message():
    rows = [_insider_row(shares=float(i), tx_date=f"2026-06-{i % 28 + 1:02d}")
            for i in range(400)]
    msg = telegram.format_insider_filing(_insider_match(rows))
    assert len(msg) <= telegram.TELEGRAM_LIMIT
    assert "more" in msg  # the list was capped, not the message truncated
    assert msg.rstrip().endswith("x-index.htm")


def test_insider_cluster_message():
    from whale.stats import InsiderCluster, Volume

    vol = Volume()
    vol.add(None, None, 12_400_000_00)
    cluster = InsiderCluster(issuer_cik="0000000001", ticker="ESTC",
                             issuer_name="Elastic N.V.", direction="sell",
                             insider_count=6, filing_count=8, trade_count=14,
                             insiders=["Alice A", "Bob B"], volume=vol)
    msg = telegram.format_insider_cluster(cluster, "Insider cluster selling", 30)
    assert msg.startswith("🔥 <b>Insider cluster selling — ESTC</b>")
    assert "6 insiders sold Elastic N.V. in the last 30 days" in msg
    assert "across 8 filings · 14 sells" in msg
