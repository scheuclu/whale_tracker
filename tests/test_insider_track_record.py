"""Insider track record: the congressional measurement, for Form 4 filers.

A decision is (primary reporting owner, ticker, direction, Form 4), keyed on
the owner's CIK, measured and scored by the same functions as Congress and
stored in `insider_track_*` tables of its own. Nothing crosses over: a run
for one population never writes the other's tables, and the two are never
one ranking. Only the per-ticker fetch record is shared.
"""

from datetime import date

import pytest

from whale import db, stats, track
from tests.test_track_record import CAL, DOWN, SPY, UP, FakeClient, _config, _now


@pytest.fixture
def conn(tmp_path):
    c = db.connect(tmp_path / "t.sqlite3")
    yield c
    c.close()


def _form4(conn, accession, filing_date, owners, rows, ticker="UP", status="backfilled"):
    """One stored Form 4: `owners` [(cik, name)], the first primary; `rows` [(tx_date, action)]."""
    cur = conn.execute(
        "INSERT INTO insider_filings (accession, form_type, issuer_cik, issuer_name, ticker, "
        "filing_date, source, source_url, status, first_seen_at, updated_at) "
        "VALUES (?, '4', '0000000001', 'Up Corp', ?, ?, 'index', 'https://x', ?, ?, ?)",
        (accession, ticker, filing_date, status, filing_date, filing_date))
    fid = cur.lastrowid
    for i, (cik, name) in enumerate(owners):
        conn.execute("INSERT OR IGNORE INTO insiders (cik, name, updated_at) VALUES (?, ?, ?)",
                     (cik, name, filing_date))
        conn.execute("INSERT INTO insider_filing_owners (filing_id, insider_cik, owner_index) "
                     "VALUES (?, ?, ?)", (fid, cik, i))
    for tx_date, action in rows:
        conn.execute(
            "INSERT INTO insider_transactions (filing_id, tx_date, transaction_code, action, "
            "shares, price_per_share) VALUES (?, ?, ?, ?, 100, 10)",
            (fid, tx_date, "P" if action == "purchase" else "S", action))
    conn.commit()
    return fid


def test_insider_rows_are_excluded_as_filed_never_corrected():
    today = date(2026, 10, 23)
    ok = {"action": "purchase", "ticker": "UP", "tx_date": "2026-03-02", "filing_date": "2026-03-04"}
    assert stats.insider_track_row_exclusion(ok, today) is None
    assert stats.insider_track_row_exclusion({**ok, "ticker": None}, today) == "no_ticker"
    assert stats.insider_track_row_exclusion({**ok, "tx_date": "2026-03-09"}, today) == "date_as_filed"
    assert stats.insider_track_row_exclusion({**ok, "tx_date": "2027-01-01"}, today) == "date_as_filed"
    assert stats.insider_track_row_exclusion({**ok, "tx_date": None}, today) == "date_as_filed"


def test_insiders_are_measured_in_their_own_tables_keyed_on_the_primary_owner(conn):
    # A joint filing is one decision, the primary owner's; two buys of one
    # ticker in one filing fold into one decision dated by the earlier.
    _form4(conn, "a-1", "2026-03-04", [("0000000011", "Ann Exec"), ("0000000099", "Ann's Trust")],
           [("2026-03-02", "purchase"), ("2026-03-03", "purchase")])
    _form4(conn, "a-2", "2026-06-03", [("0000000011", "Ann Exec")],
           [("2026-06-01", "sale")], ticker="DOWN")
    _form4(conn, "a-3", "2026-06-03", [("0000000022", "Bo Director")],
           [("2026-06-01", "purchase")], ticker="GONE")
    client = FakeClient({"SPY": SPY, "UP": UP, "DOWN": DOWN})
    result = track.sync(conn, _config(), client=client, now=_now("2026-10-23"),
                        population=track.INSIDERS)
    assert result.status.startswith("ok"), result.status

    rows = {(r["owner_cik"], r["ticker"], r["direction"]): r
            for r in conn.execute("SELECT * FROM insider_track_decisions")}
    assert set(rows) == {("0000000011", "UP", "buy"), ("0000000011", "DOWN", "sell"),
                         ("0000000022", "GONE", "buy")}
    up = rows[("0000000011", "UP", "buy")]
    i0 = CAL.index("2026-03-02")
    assert up["rows"] == 2 and up["t0_trade"] == "2026-03-02" and up["t0_disclosure"] == "2026-03-05"
    assert up["signed_trade_30"] == pytest.approx((UP[CAL[i0 + 30]] / UP[CAL[i0]] - 1)
                                                  - (SPY[CAL[i0 + 30]] / SPY[CAL[i0]] - 1))
    assert rows[("0000000011", "DOWN", "sell")]["signed_trade_90"] > 0, "a sale before a fall scores positive"
    assert rows[("0000000022", "GONE", "buy")]["exclusion"] == "no_price_series"

    scores = conn.execute("SELECT * FROM insider_track_scores WHERE horizon = 90").fetchall()
    assert {s["owner_cik"] for s in scores} == {"0000000011"}
    assert scores[0]["qualifies"] == 0, "two decisions in two filings: listed, never ranked"
    assert conn.execute("SELECT COUNT(*) FROM insider_track_model").fetchone()[0] == 6
    assert db.get_state(conn, track.INSIDERS.state_status).startswith("ok")

    # Nothing crossed into the congressional tables or state.
    for t in ("track_decisions", "track_scores", "track_model", "track_coverage"):
        assert conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] == 0, t
    assert db.get_state(conn, track.STATE_STATUS) is None
    # The fetch record is the one shared table.
    fetched = {r["ticker"] for r in conn.execute("SELECT ticker FROM track_price_fetches")}
    assert {"UP", "DOWN", "GONE"} <= fetched


def test_insider_runs_are_idle_once_up_to_date(conn):
    _form4(conn, "a-1", "2026-03-04", [("0000000011", "Ann Exec")], [("2026-03-02", "purchase")])
    client = FakeClient({"SPY": SPY, "UP": UP})
    track.sync(conn, _config(), client=client, now=_now("2026-10-23"), population=track.INSIDERS)
    calls = len(client.calls)
    again = track.sync(conn, _config(), client=client, now=_now("2026-10-23"),
                       population=track.INSIDERS)
    assert again.status == "ok: up to date" and len(client.calls) == calls


def test_insider_coverage_counts_rows_and_decisions(conn):
    _form4(conn, "a-1", "2026-03-04", [("0000000011", "Ann Exec")],
           [("2026-03-02", "purchase"), ("2026-03-09", "purchase")])
    _form4(conn, "a-2", "2026-03-04", [("0000000022", "Bo Director")], [("2026-03-02", "sale")],
           ticker=None)
    track.sync(conn, _config(), client=FakeClient({"SPY": SPY, "UP": UP}), now=_now("2026-10-23"),
               population=track.INSIDERS)
    coverage = {r["outcome"]: (r["rows"], r["decisions"])
                for r in conn.execute("SELECT * FROM insider_track_coverage")}
    assert coverage["included"] == (1, 1)
    assert coverage["date_as_filed"][0] == 1, "traded after it was filed: counted, never corrected"
    assert coverage["no_ticker"][0] == 1
