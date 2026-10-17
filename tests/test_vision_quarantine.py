"""Transcribed rows count as trades and enter no total — in Python, in the
dashboard's SQL, in the audit, in Telegram, and through the pipeline.

The SQL half runs the actual `MID` / `TRANSCRIBED` text from
web/lib/queries.ts against the same database as `stats.py`, so the two
definitions CLAUDE.md requires to agree are checked against each other
rather than each against its own expectation.
"""

import re
from datetime import date
from pathlib import Path

import pytest

from whale import audit, db, pipeline, stats, telegram
from whale.config import AlertSettings, Config
from whale.vision import ScanUnreadable

TODAY = date(2026, 7, 1)
QUERIES_TS = Path(__file__).resolve().parents[1] / "web" / "lib" / "queries.ts"


@pytest.fixture
def conn(tmp_path):
    c = db.connect(tmp_path / "t.sqlite3")
    yield c
    c.close()


def _member(conn, bioguide, name):
    return db.upsert_politician(conn, bioguide_id=bioguide, full_name=name,
                                first=name.split()[0], last=name.split()[-1],
                                chamber="house", party="R", state="WI", district="8", active=1)


def _filing(conn, pid, name, doc_id, method, status="backfilled", notified=True):
    fid = db.insert_filing(
        conn, chamber="house", doc_id=doc_id, politician_id=pid, filer_name=name,
        state_district="WI08", filing_type="P", filing_date="2026-06-20", year=2026,
        pdf_url=f"http://x/{doc_id}.pdf", status=status, parse_method=method)
    if notified:
        db.mark_notified(conn, fid)
    return fid


def _tx(ticker, action, lo, hi, asset_type="ST"):
    return {"ticker": ticker, "action": action, "asset_name": f"{ticker or 'Fund'} Inc.",
            "asset_type": asset_type, "tx_date": "2026-06-15",
            "notification_date": "2026-06-20", "amount_min_cents": lo,
            "amount_max_cents": hi, "amount_exact_cents": None}


def _seed(conn):
    """Two members on NVDA: one text-parsed, one transcribed from a scan."""
    alice = _member(conn, "A000001", "Alice A")
    bob = _member(conn, "B000002", "Bob B")
    text = _filing(conn, alice, "Alice A", "t1", "text")
    scan = _filing(conn, bob, "Bob B", "s1", "vision")
    db.replace_transactions(conn, text, alice, [_tx("NVDA", "purchase", 100_100, 1_500_000)])
    db.replace_transactions(conn, scan, bob, [
        _tx("NVDA", "purchase", 1_500_100, 5_000_000),
        _tx("NVDA", "purchase", 5_000_100, 10_000_000),
        _tx("NVDA", "sale", 100_100, 1_500_000),
        _tx(None, "sale", None, None),          # a box the grid could not call
    ])
    conn.commit()
    return alice, bob


# --- stats.py -----------------------------------------------------------------


def test_transcribed_rows_count_as_trades_and_members_but_add_no_volume(conn):
    _seed(conn)
    s = stats.ticker_stats(conn, today=TODAY)["NVDA"]
    assert s.trade_count == 4
    assert (s.buy_count, s.sell_count) == (3, 1)
    assert s.politician_count == 2
    assert s.buy_politicians == {"Alice A", "Bob B"} and s.sell_politicians == {"Bob B"}
    assert s.transcribed_count == 3
    # Only Alice's bracket is money anyone vouched for.
    assert (s.volume.min_cents, s.volume.max_cents, s.volume.mid_cents) == (100_100, 1_500_000, 800_050)
    assert s.buy_volume.mid_cents == 800_050
    assert s.sell_volume.mid_cents == 0
    assert "Bob B" not in s.buy_floors and "Bob B" not in s.sell_floors


def test_transcribed_rows_never_make_a_member_a_cluster_participant(conn):
    _seed(conn)
    carol = _member(conn, "C000003", "Carol C")
    f = _filing(conn, carol, "Carol C", "t2", "text")
    db.replace_transactions(conn, f, carol, [_tx("NVDA", "purchase", 100_100, 1_500_000)])
    conn.commit()
    settings = AlertSettings(window_days=90, min_politicians=3, min_volume_usd=1,
                             min_member_floor_usd=1)
    clusters = stats.find_clusters(conn, settings, today=TODAY)
    # Bob's transcribed rows would be the third member and $3M of volume.
    assert clusters == []


def test_member_leaderboard_counts_the_trades_and_not_the_money(conn):
    _seed(conn)
    bob = next(a for a in stats.politician_stats(conn) if a["name"] == "Bob B")
    assert bob["trade_count"] == 4
    assert bob["transcribed_count"] == 4
    assert bob["volume"].mid_cents == 0 and bob["volume"].min_cents == 0


# --- web/lib/queries.ts --------------------------------------------------------


def _ts_const(name: str) -> str:
    src = QUERIES_TS.read_text()
    m = re.search(rf"(?:export )?const {name} = `(.*?)`;", src, re.S)
    assert m, f"{name} not found in queries.ts"
    return m.group(1)


def _sql_from_ts(expr: str) -> str:
    """Expand the template references the way the TS does, textually."""
    for _ in range(3):
        expr = re.sub(r"\$\{(\w+)\}", lambda m: _ts_const(m.group(1)), expr)
    return expr


def test_dashboard_sql_agrees_with_stats_on_what_counts(conn):
    _seed(conn)
    mid = _sql_from_ts(_ts_const("MID"))
    transcribed = _sql_from_ts(_ts_const("TRANSCRIBED"))
    row = conn.execute(f"""
        SELECT SUM(COALESCE({mid}, 0)) AS volume_mid, COUNT(*) AS trades,
               SUM({transcribed}) AS transcribed
        FROM transactions t JOIN filings f ON f.id = t.filing_id
        WHERE t.ticker = 'NVDA'
    """).fetchone()
    s = stats.ticker_stats(conn, today=TODAY)["NVDA"]
    assert row["volume_mid"] == s.volume.mid_cents
    assert row["trades"] == s.trade_count
    assert row["transcribed"] == s.transcribed_count


def test_dashboard_sql_marks_transcribed_filings_by_parse_method(conn):
    _seed(conn)
    transcribed = _sql_from_ts(_ts_const("TRANSCRIBED"))
    rows = conn.execute(f"""
        SELECT f.doc_id, {transcribed} AS transcribed
        FROM transactions t JOIN filings f ON f.id = t.filing_id
        GROUP BY f.doc_id ORDER BY f.doc_id
    """).fetchall()
    assert [(r["doc_id"], r["transcribed"]) for r in rows] == [("s1", 1), ("t1", 0)]


# --- db.py / telegram.py ---------------------------------------------------------


def test_filing_rows_carry_the_transcribed_flag(conn):
    _seed(conn)
    text = conn.execute("SELECT id FROM filings WHERE doc_id = 't1'").fetchone()["id"]
    scan = conn.execute("SELECT id FROM filings WHERE doc_id = 's1'").fetchone()["id"]
    assert {r["transcribed"] for r in db.transactions_for_filing(conn, text)} == {0}
    assert {r["transcribed"] for r in db.transactions_for_filing(conn, scan)} == {1}


def test_telegram_labels_transcribed_rows():
    tx = {"action": "purchase", "asset_name": "SCHWAB SHORT TERM U S TREASURY ETF",
          "amount_min_cents": 5_000_100, "amount_max_cents": 10_000_000,
          "tx_date": "2026-07-22", "transcribed": 1}
    line = telegram._tx_line(tx)
    assert "transcribed from scan" in line
    assert "(scan)" in telegram._tx_line_compact(tx)
    tx["transcribed"] = 0
    assert "transcribed" not in telegram._tx_line(tx)
    assert "scan" not in telegram._tx_line_compact(tx)


# --- audit.py --------------------------------------------------------------------


def test_vision_rows_check_sits_right_after_parse_coverage():
    names = [c.__name__ for c in audit.CHECKS]
    assert names.index("check_vision_rows") == names.index("check_parse_coverage") + 1


def test_vision_rows_check_is_silent_without_scans_and_informative_with(conn):
    assert audit.check_vision_rows(conn, TODAY) == []
    _seed(conn)
    found = audit.check_vision_rows(conn, TODAY)
    assert len(found) == 1 and found[0].code == "vision_rows"
    # One unknown box in four rows is the expected shape of this data.
    assert found[0].severity == audit.INFO
    assert "1 filing(s), 4 row(s)" in found[0].title
    assert "1 without a readable amount" in found[0].title
    assert found[0].evidence and found[0].evidence[0].startswith("s1  Bob B")


def test_vision_rows_check_warns_when_most_boxes_could_not_be_read(conn):
    bob = _member(conn, "B000002", "Bob B")
    scan = _filing(conn, bob, "Bob B", "s1", "vision")
    db.replace_transactions(conn, scan, bob, [
        _tx(None, "unknown", None, None), _tx(None, "unknown", None, None),
        _tx(None, "purchase", 100_100, 1_500_000),
    ])
    conn.commit()
    found = audit.check_vision_rows(conn, TODAY)
    assert found[0].severity == audit.WARN


def test_refused_scans_are_counted_by_the_vision_check(conn):
    bob = _member(conn, "B000002", "Bob B")
    _filing(conn, bob, "Bob B", "r1", "vision_failed", status="failed")
    conn.commit()
    found = audit.check_vision_rows(conn, TODAY)
    assert "1 scan(s) refused" in found[0].title


def test_transcribed_unknowns_do_not_fire_the_parser_field_checks_every_week(conn):
    _seed(conn)
    codes = {f.code for f in audit.check_missing_transaction_fields(conn, TODAY)}
    assert "missing_amount" not in codes
    assert "missing_action" not in codes
    # … while a text-parsed row with no amount still does.
    alice = conn.execute("SELECT id, politician_id FROM filings WHERE doc_id = 't1'").fetchone()
    db.replace_transactions(conn, alice["id"], alice["politician_id"],
                            [_tx("NVDA", "purchase", None, None)])
    conn.commit()
    codes = {f.code for f in audit.check_missing_transaction_fields(conn, TODAY)}
    assert "missing_amount" in codes


def test_parse_coverage_no_longer_claims_vision_rows_are_in_the_stats(conn):
    _seed(conn)
    assert {f.code for f in audit.check_parse_coverage(conn, TODAY)} == {"parse_coverage"}


# --- pipeline.py -------------------------------------------------------------------


def _config(**over) -> Config:
    c = Config(vision_enabled=True, gemini_api_key="key")
    for k, v in over.items():
        setattr(c, k, v)
    return c


def _scan_filing(conn, doc_id, method="scanned", notified=True, status="failed"):
    pid = _member(conn, f"X{doc_id[-6:]:0>6}", f"Member {doc_id}")
    fid = db.insert_filing(
        conn, chamber="house", doc_id=doc_id, politician_id=pid, filer_name=f"Member {doc_id}",
        state_district="WI08", filing_type="P", filing_date="2026-06-20", year=2026,
        pdf_url=f"http://x/{doc_id}.pdf", status=status, parse_method=method,
        last_error="scanned paper filing (GEMINI_API_KEY not set)")
    if notified:
        db.mark_notified(conn, fid)
    conn.commit()
    return fid


def test_failed_scans_are_requeued_only_when_vision_can_run(conn):
    _scan_filing(conn, "9000001")
    _scan_filing(conn, "9000002", method="vision_failed")
    assert pipeline.retry_scanned(conn, _config(vision_enabled=False)) == 0
    assert pipeline.retry_scanned(conn, _config(gemini_api_key=None)) == 0
    assert conn.execute("SELECT status FROM filings WHERE doc_id = '9000001'").fetchone()[0] == "failed"
    assert pipeline.retry_scanned(conn, _config()) == 1
    statuses = dict(conn.execute("SELECT doc_id, status FROM filings").fetchall())
    # The refused one is not retried every run; the never-attempted one is.
    assert statuses == {"9000001": "new", "9000002": "failed"}


def _parsed(action="purchase", amount="$50,001 - $100,000"):
    from whale.ptr import ParsedFiling, Transaction

    return ParsedFiling(filer_name="Member", state_district="WI08", transactions=[
        Transaction(asset_name="SCHWAB ETF", action=action, amount_raw=amount,
                    tx_date="2026-07-22", raw_text="(scanned)")])


def test_a_scan_announced_as_unreadable_is_parsed_as_history_not_announced_again(conn, monkeypatch):
    announced = _scan_filing(conn, "9000001", notified=True)
    silent = _scan_filing(conn, "9000002", notified=False)
    monkeypatch.setattr(pipeline.house, "fetch_pdf", lambda url: b"pdf")
    monkeypatch.setattr(pipeline, "_parse_bytes", lambda b, c: (_parsed(), "vision"))
    config = _config()
    assert pipeline.retry_scanned(conn, config) == 2
    assert pipeline.parse_pending(conn, config) == 2
    rows = {r["doc_id"]: r for r in conn.execute("SELECT * FROM filings").fetchall()}
    assert (rows["9000001"]["status"], rows["9000001"]["parse_method"]) == ("backfilled", "vision")
    assert rows["9000001"]["notified_at"] is not None
    assert (rows["9000002"]["status"], rows["9000002"]["parse_method"]) == ("parsed", "vision")
    assert rows["9000002"]["notified_at"] is None
    assert len(db.transactions_for_filing(conn, announced)) == 1
    assert len(db.transactions_for_filing(conn, silent)) == 1
    # Telegram: the never-announced one is sent as a filing, the other is not.
    sent = []
    monkeypatch.setattr(pipeline, "_deliver", lambda cfg, text, dry: sent.append(text) or True)
    config.telegram_bot_token, config.telegram_chat_id = "t", "c"
    pipeline.notify_pending(conn, config)
    assert len(sent) == 1 and "Member 9000002" in sent[0]
    assert "transcribed from scan" in sent[0]


def test_a_refused_scan_is_failed_with_its_own_method_and_reported_once(conn, monkeypatch):
    fid = _scan_filing(conn, "9000003", notified=False)
    monkeypatch.setattr(pipeline.house, "fetch_pdf", lambda url: b"pdf")

    def refuse(b, c):
        raise ScanUnreadable("the grid has 7 transaction rows but the model transcribed 6")

    monkeypatch.setattr(pipeline, "_parse_bytes", refuse)
    config = _config()
    pipeline.retry_scanned(conn, config)
    assert pipeline.parse_pending(conn, config) == 0
    row = conn.execute("SELECT * FROM filings WHERE id = ?", (fid,)).fetchone()
    assert (row["status"], row["parse_method"]) == ("failed", "vision_failed")
    assert "7 transaction rows" in row["last_error"]
    sent = []
    monkeypatch.setattr(pipeline, "_deliver", lambda cfg, text, dry: sent.append(text) or True)
    config.telegram_bot_token, config.telegram_chat_id = "t", "c"
    pipeline.notify_pending(conn, config)
    assert len(sent) == 1 and "Could not parse" in sent[0]
    # Not retried on the next run, and not re-announced.
    assert pipeline.retry_scanned(conn, config) == 0
    pipeline.notify_pending(conn, config)
    assert len(sent) == 1


def test_parse_bytes_lets_scan_unreadable_through(monkeypatch):
    from whale import ptr

    def scanned(_):
        raise ptr.ScannedFilingError("no text layer")

    monkeypatch.setattr(pipeline, "parse_pdf", scanned)

    def refuse(pdf_bytes, key):
        raise ScanUnreadable("grid: page 1: no table")

    monkeypatch.setattr(pipeline, "parse_scanned", refuse)
    with pytest.raises(ScanUnreadable):
        pipeline._parse_bytes(b"pdf", _config())
