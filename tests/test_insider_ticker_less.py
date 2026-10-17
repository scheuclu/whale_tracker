"""Issuers filed with no trading symbol (NONE / N/A) must not alert.

Private BDCs, interval funds and similar non-listed vehicles file Form 4s
like anyone else, and 16 of the first 291 insider alerts were for them —
nobody can act on "Blackstone Multi-Strategy Hedge Fund". Two cluster alerts
were worse still: keyed and labelled with the issuer's CIK, the message read
"0001742952". Such filings are demoted to history so the dashboard still
counts them, and the audit says so if one ever reaches Telegram again.
"""

from datetime import date

import pytest

from whale import audit, db, insider_alerts, pipeline, stats, telegram
from whale.config import Config, InsiderSettings, _parse_rule
from whale.stats import InsiderCluster, Volume

TODAY = date(2026, 7, 1)
TRUST = "John Hancock GA Mortgage Trust"
TRUST_CIK = "0001742952"


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


def _filing(conn, accession, ticker, owner_cik="0000000010", status="parsed",
            value=5_000_000_00, action="purchase", tx_date="2026-06-25",
            issuer_cik=TRUST_CIK, notified_at=None):
    fid = db.insert_insider_filing(
        conn, accession=accession, form_type="4", issuer_cik=issuer_cik,
        issuer_name=TRUST, ticker=ticker, ticker_as_filed=ticker or "NONE",
        filing_date="2026-06-26", source="feed",
        source_url=f"http://sec/{accession}-index.htm", status=status,
        notified_at=notified_at)
    db.upsert_insider(conn, owner_cik, f"Insider {owner_cik[-2:]}")
    db.replace_insider_owners(conn, fid, [{"cik": owner_cik, "is_director": True}])
    db.replace_insider_transactions(conn, fid, [{
        "transaction_code": "P" if action == "purchase" else "S", "action": action,
        "tx_date": tx_date, "shares": 1000.0, "price_per_share": value / 100 / 1000,
        "amount_min_cents": value, "amount_max_cents": value,
        "amount_exact_cents": value, "late": 0}])
    conn.commit()
    return fid


def _rule(**kw):
    return _parse_rule({"name": "Large buy", "min_value_usd": 1, **kw}, 0)


def _config(*rules) -> Config:
    config = Config(telegram_bot_token="t", telegram_chat_id="c",
                    edgar_user_agent="whale-tracker test@example.com")
    config.insiders.alerts = list(rules)
    return config


def _match(conn, fid, rule):
    filing = conn.execute("SELECT * FROM insider_filings WHERE id = ?", (fid,)).fetchone()
    rows, owners = insider_alerts.load_filing(conn, fid)
    return insider_alerts.match_filing(filing, owners, rows, rule)


# --- filing rules ------------------------------------------------------------


def test_no_filing_rule_claims_an_issuer_with_no_ticker(conn):
    listed = _filing(conn, "0000000000-26-000001", ticker="JHGA")
    unlisted = _filing(conn, "0000000000-26-000002", ticker=None)
    assert _match(conn, listed, _rule()) is not None
    # Same owner, same size, same direction: only the symbol differs.
    assert _match(conn, unlisted, _rule()) is None
    # Not a floor the filing failed to clear: a rule asking nothing at all
    # still does not want it.
    assert _match(conn, unlisted, _parse_rule({"name": "Anything"}, 0)) is None


def test_a_ticker_less_filing_is_demoted_to_history_not_sent(conn, sent):
    _filing(conn, "0000000000-26-000003", ticker=None)
    assert pipeline.notify_insiders(conn, _config(_rule()), today=TODAY) == 0
    assert sent == []
    row = conn.execute("SELECT status, notified_at FROM insider_filings").fetchone()
    # History, not dropped: the dashboard still counts the trade.
    assert row["status"] == "backfilled" and row["notified_at"] is None


def test_a_dry_run_leaves_a_ticker_less_filing_in_the_queue(conn, sent):
    _filing(conn, "0000000000-26-000004", ticker=None)
    pipeline.notify_insiders(conn, _config(_rule()), dry_run=True, today=TODAY)
    assert conn.execute("SELECT status FROM insider_filings").fetchone()["status"] == "parsed"
    assert sent == []


# --- the cluster finder ------------------------------------------------------


def _converge(conn, ticker, n=3):
    for i in range(n):
        _filing(conn, f"0000000000-26-1000{i}", ticker=ticker, owner_cik=f"00000001{i:02d}")


def test_the_cluster_finder_skips_issuers_with_no_ticker(conn):
    settings = InsiderSettings()
    _converge(conn, ticker=None)
    assert stats.find_insider_clusters(conn, settings, today=TODAY) == []
    rule = _parse_rule({"name": "Cluster buying", "kind": "cluster", "direction": "buy",
                        "min_insiders": 3}, 0)
    assert insider_alerts.cluster_matches(conn, InsiderSettings(alerts=[rule]), TODAY) == []


def test_the_same_convergence_with_a_ticker_is_found(conn):
    _converge(conn, ticker="JHGA")
    found = stats.find_insider_clusters(conn, InsiderSettings(), today=TODAY)
    assert [(c.ticker, c.insider_count) for c in found] == [("JHGA", 3)]


def test_a_ticker_less_convergence_sends_nothing_and_records_no_alert(conn, sent):
    _converge(conn, ticker=None)
    config = _config(
        _parse_rule({"name": "Cluster buying", "kind": "cluster", "direction": "buy",
                     "min_insiders": 3}, 0),
        _rule(),
    )
    assert pipeline.notify_insiders(conn, config, today=TODAY) == 0
    assert sent == []
    assert conn.execute("SELECT COUNT(*) FROM alerts").fetchone()[0] == 0
    statuses = {r["status"] for r in conn.execute("SELECT status FROM insider_filings")}
    assert statuses == {"backfilled"}


def test_a_cluster_message_never_shows_a_bare_cik():
    # Dedupe may key on the CIK; the reader must never see it.
    cluster = InsiderCluster(
        issuer_cik=TRUST_CIK, ticker=None, issuer_name=TRUST, direction="buy",
        insider_count=4, filing_count=4, trade_count=4,
        insiders=["A", "B", "C", "D"], volume=Volume(min_cents=100, max_cents=100))
    msg = telegram.format_insider_cluster(cluster, "Insider cluster buying", 30)
    assert TRUST_CIK not in msg
    assert TRUST in msg


# --- the audit says so if it regresses ---------------------------------------


def _codes(findings):
    return {f.code for f in findings}


def test_a_notified_filing_without_a_ticker_is_a_warning(conn):
    _filing(conn, "0000000000-26-000005", ticker=None, status="notified",
            notified_at="2026-06-28T10:00:00Z")
    found = audit.check_insider_notified_without_ticker(conn, TODAY)
    assert len(found) == 1 and found[0].severity == audit.WARN
    assert found[0].code == "insider_notified_without_ticker"
    assert "0000000000-26-000005" in found[0].evidence[0]
    assert TRUST in found[0].evidence[0]


def test_history_and_listed_issuers_are_not_flagged(conn):
    # Demoted, as the pipeline now does: counted, never announced.
    _filing(conn, "0000000000-26-000006", ticker=None, status="backfilled")
    # Notified, but tradeable.
    _filing(conn, "0000000000-26-000007", ticker="JHGA", status="notified",
            notified_at="2026-06-28T10:00:00Z")
    assert audit.check_insider_notified_without_ticker(conn, TODAY) == []


def test_alerts_sent_before_the_gate_existed_age_out_of_the_check(conn):
    # The check is a regression detector, not a permanent record of the 16
    # alerts sent before the gate: a check that fires every week on data that
    # cannot change is a defect in the check.
    _filing(conn, "0000000000-26-000008", ticker=None, status="notified",
            notified_at="2026-05-01T10:00:00Z")
    assert audit.check_insider_notified_without_ticker(conn, TODAY) == []
    assert _codes(audit.check_insider_notified_without_ticker(conn, date(2026, 5, 20))) \
        == {"insider_notified_without_ticker"}


def test_the_check_runs_right_after_insider_coverage(conn):
    checks = list(audit.CHECKS)
    assert checks.index(audit.check_insider_notified_without_ticker) \
        == checks.index(audit.check_insider_coverage) + 1
    _filing(conn, "0000000000-26-000009", ticker=None, status="notified",
            notified_at="2026-06-28T10:00:00Z")
    assert "insider_notified_without_ticker" in _codes(audit.run_checks(conn, TODAY))
