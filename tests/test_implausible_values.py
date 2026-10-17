"""Implausible as-filed insider values (#15).

SL Science (SLBT) filed 4,545,306 shares at $2,272,653.00 a share — the
aggregate consideration in the price cell — and the stored value became
$10.3 trillion, leading the buy leaderboard by four orders of magnitude and
sent as a "Large insider buy". The row stays as filed; the `implausible` flag,
derived once at ingest like `late`, keeps the value out of every total,
cluster volume, alert floor and message, and the audit lists it.
"""

import re
import sqlite3
from datetime import date

import pytest

from whale import audit, db, edgar, form4, insider_alerts, insiders, stats, telegram
from whale.config import _parse_rule

TODAY = date(2026, 10, 10)

# The rows from the issue, as filed.
SLBT = dict(shares=4_545_306.0, price=2_272_653.0)            # $10.33T
IHT_BIG = dict(shares=43_111.0, price=50_410.80)              # $2.17B on a ~$1.50 stock
IHT_SMALL = dict(shares=16_000.0, price=22_593.60)            # $361M
UUU = dict(shares=18_000.0, price=5_134.0)                    # $92M on a ~$5 stock
BRK_A = dict(shares=12.0, price=700_000.0)                    # a real, high-priced stock
FANG = dict(shares=9_079_675.0, price=205.26)                 # the largest real row stored


def _cents(row: dict) -> int:
    return round(row["shares"] * row["price"] * 100)


def _judge(row: dict, reference: float | None = None) -> bool | None:
    return stats.form4_is_implausible(row["shares"], row["price"], _cents(row), reference)


# --- the rule ----------------------------------------------------------------


def test_value_above_the_absolute_ceiling_is_implausible():
    assert _judge(SLBT) is True
    assert _cents(SLBT) > stats.IMPLAUSIBLE_VALUE_CENTS


def test_absurd_price_with_many_shares_is_implausible_without_issuer_history():
    # IHT has no other stored filings, so only the price × share-count branch
    # can catch it.
    assert _judge(IHT_BIG) is True
    assert _judge(IHT_SMALL) is True


def test_price_alone_is_not_enough():
    # A director buying a dozen BRK.A at $700k is real; the share count is
    # the second signal.
    assert _judge(BRK_A) is False
    assert _judge(BRK_A, reference=695_000.0) is False


def test_the_largest_real_row_is_not_flagged():
    assert _judge(FANG) is False


def test_price_far_above_the_issuers_history_is_implausible():
    assert _judge(UUU, reference=5.05) is True
    assert _judge(UUU) is False  # no history, under every absolute threshold: uncatchable


def test_a_weighted_average_spread_is_not_an_outlier():
    # NVDA rows run $218–$224; nothing near 20× the median.
    for price in (218.0144, 219.7219, 223.7479):
        assert stats.form4_is_implausible(1_356_000.0, price, round(1_356_000 * price * 100),
                                          reference_price=220.0) is False


def test_a_row_without_a_value_is_unknown_not_plausible():
    assert stats.form4_is_implausible(100.0, None, None) is None
    assert stats.form4_is_implausible(None, 10.0, None) is None


# --- derived at ingest, stored, recomputed ------------------------------------


@pytest.fixture
def conn(tmp_path):
    c = db.connect(tmp_path / "t.sqlite3")
    yield c
    c.close()


def _xml(accession_suffix: str, issuer_cik: str, ticker: str, rows: list[tuple[str, float, float]],
         owner_cik: str = "0000000010") -> str:
    txs = "".join(
        f"""<nonDerivativeTransaction>
              <securityTitle><value>Common Stock</value></securityTitle>
              <transactionDate><value>2026-10-06</value></transactionDate>
              <transactionCoding><transactionCode>{code}</transactionCode></transactionCoding>
              <transactionAmounts>
                <transactionShares><value>{shares}</value></transactionShares>
                <transactionPricePerShare><value>{price}</value></transactionPricePerShare>
                <transactionAcquiredDisposedCode><value>{'A' if code == 'P' else 'D'}</value></transactionAcquiredDisposedCode>
              </transactionAmounts>
              <postTransactionAmounts><sharesOwnedFollowingTransaction><value>1</value></sharesOwnedFollowingTransaction></postTransactionAmounts>
              <ownershipNature><directOrIndirectOwnership><value>D</value></directOrIndirectOwnership></ownershipNature>
            </nonDerivativeTransaction>"""
        for code, shares, price in rows
    )
    return f"""<?xml version="1.0"?>
<ownershipDocument>
  <documentType>4</documentType>
  <periodOfReport>2026-10-06</periodOfReport>
  <issuer><issuerCik>{issuer_cik}</issuerCik><issuerName>Issuer {ticker}</issuerName>
          <issuerTradingSymbol>{ticker}</issuerTradingSymbol></issuer>
  <reportingOwner>
    <reportingOwnerId><rptOwnerCik>{owner_cik}</rptOwnerCik><rptOwnerName>Owner {owner_cik[-2:]}</rptOwnerName></reportingOwnerId>
    <reportingOwnerRelationship><isDirector>1</isDirector></reportingOwnerRelationship>
  </reportingOwner>
  <nonDerivativeTable>{txs}</nonDerivativeTable>
</ownershipDocument>"""


def _store(conn, accession: str, issuer_cik: str, ticker: str, rows, owner_cik="0000000010",
           status="backfilled") -> int:
    doc = form4.parse_form4(_xml(accession, issuer_cik, ticker, rows, owner_cik))
    header = form4.SecHeader(accession=accession, form_type="4", filed_date="2026-10-08",
                             accepted_at=None, period_of_report="2026-10-06",
                             issuer_cik=issuer_cik, issuer_name=f"Issuer {ticker}")
    ref = edgar.FilingRef(accession=accession, form_type="4", cik=issuer_cik, filed_date="2026-10-08")
    fid = insiders.store_filing(conn, header, doc, ref, "feed", status)
    conn.commit()
    return fid


def _flags(conn, filing_id: int) -> list[int | None]:
    return [r[0] for r in conn.execute(
        "SELECT implausible FROM insider_transactions WHERE filing_id = ? ORDER BY id", (filing_id,))]


def test_ingest_flags_the_slbt_row_and_stores_it_as_filed(conn):
    fid = _store(conn, "0000000000-26-000001", "0000000001", "SLBT", [("P", SLBT["shares"], SLBT["price"])])
    row = conn.execute("SELECT * FROM insider_transactions WHERE filing_id = ?", (fid,)).fetchone()
    assert row["implausible"] == 1
    assert (row["shares"], row["price_per_share"]) == (SLBT["shares"], SLBT["price"])
    assert row["amount_exact_cents"] == row["amount_min_cents"] == row["amount_max_cents"] == _cents(SLBT)


def test_ingest_judges_a_filing_against_the_issuers_other_filings(conn):
    history = _store(conn, "0000000000-26-000010", "0000000002", "UUU",
                     [("P", 100.0, 5.0724), ("P", 3000.0, 5.0225), ("P", 12034.0, 5.1086)])
    assert _flags(conn, history) == [0, 0, 0]
    bad = _store(conn, "0000000000-26-000011", "0000000002", "UUU", [("P", UUU["shares"], UUU["price"])],
                 owner_cik="0000000011")
    assert _flags(conn, bad) == [1]


def test_a_filing_is_not_judged_against_its_own_rows(conn):
    # Every row of a mispriced filing agrees with the others; the filing's
    # own rows are not the yardstick, so the first filing of an issuer with
    # moderate prices is simply unjudgeable by the relative branch.
    fid = _store(conn, "0000000000-26-000020", "0000000003", "NEWCO",
                 [("S", 500.0, 40.0), ("S", 500.0, 40.0), ("S", 500.0, 40.0), ("S", 20.0, 2_000.0)])
    assert _flags(conn, fid) == [0, 0, 0, 0]
    # A re-parse of the same filing compares against other filings only, so
    # the verdict is stable.
    again = _store(conn, "0000000000-26-000020", "0000000003", "NEWCO",
                   [("S", 500.0, 40.0), ("S", 500.0, 40.0), ("S", 500.0, 40.0), ("S", 20.0, 2_000.0)])
    assert again == fid and _flags(conn, fid) == [0, 0, 0, 0]


def test_recompute_rejudges_every_row_against_the_current_table(conn):
    bad = _store(conn, "0000000000-26-000030", "0000000004", "ACME", [("P", UUU["shares"], UUU["price"])])
    assert _flags(conn, bad) == [0]  # first filing of the issuer: nothing to compare
    _store(conn, "0000000000-26-000031", "0000000004", "ACME", [("P", 1000.0, 5.0)], owner_cik="0000000011")
    assert insiders.recompute_implausible(conn) == 1
    assert _flags(conn, bad) == [1]
    # Only counted filings supply a reference price.
    db.set_insider_status(conn, db.insider_filing_id(conn, "0000000000-26-000031"), "failed")
    assert insiders.recompute_implausible(conn) == 0


def test_a_row_without_a_price_has_no_verdict(conn):
    fid = _store(conn, "0000000000-26-000040", "0000000005", "NOPX", [("S", 100000.0, 0)])
    assert _flags(conn, fid) == [None]


# --- excluded from every aggregate and threshold -----------------------------


def _seed(conn, ticker, issuer, filings):
    """filings: list of (accession, owner_cik, [tx dicts])."""
    for accession, owner, txs in filings:
        fid = db.insert_insider_filing(conn, accession=accession, form_type="4", issuer_cik=issuer,
                                       issuer_name=f"{ticker} Corp", ticker=ticker, filing_date="2026-10-08",
                                       source="feed", source_url="u", status="parsed")
        db.upsert_insider(conn, owner, f"Owner {owner[-2:]}")
        db.replace_insider_owners(conn, fid, [{"cik": owner, "is_director": True}])
        db.replace_insider_transactions(conn, fid, txs)
    conn.commit()


def _tx(value_cents, implausible=0, action="purchase", shares=100.0):
    return {"transaction_code": "P" if action == "purchase" else "S", "action": action,
            "tx_date": "2026-10-06", "shares": shares, "price_per_share": value_cents / shares / 100,
            "amount_min_cents": value_cents, "amount_max_cents": value_cents,
            "amount_exact_cents": value_cents, "late": 0, "implausible": implausible}


def _slbt_tx():
    return _tx(_cents(SLBT), implausible=1, shares=SLBT["shares"])


def test_issuer_stats_count_the_trade_but_not_the_value(conn):
    _seed(conn, "SLBT", "0000000001", [
        ("a-1", "0000000010", [_slbt_tx()]),
        ("a-2", "0000000011", [_tx(5_000_000)]),
    ])
    (s,) = stats.insider_issuer_stats(conn, today=TODAY).values()
    assert s.buy_count == 2 and s.buy_insiders == {"0000000010", "0000000011"}
    assert s.implausible_count == 1
    assert s.buy_volume.mid_cents == 5_000_000
    assert s.volume.max_cents == 5_000_000 and s.volume.open_ended is False


def test_leaderboard_no_longer_led_by_the_phantom_value(conn):
    _seed(conn, "SLBT", "0000000001", [("a-1", "0000000010", [_slbt_tx()])])
    _seed(conn, "REAL", "0000000002", [("b-1", "0000000011", [_tx(80_000_000)])])
    top = stats.top_insider_issuers(conn, 30, by="value", direction="buy", today=TODAY)
    assert [s.ticker for s in top] == ["REAL", "SLBT"]


def test_cluster_volume_excludes_the_flagged_row(conn):
    _seed(conn, "ACME", "0000000003", [
        ("c-1", "0000000010", [_tx(10_000_000, implausible=1)]),
        ("c-2", "0000000011", [_tx(10_000)]),
        ("c-3", "0000000012", [_tx(10_000)]),
    ])
    from whale.config import InsiderSettings

    (c,) = stats.find_insider_clusters(conn, InsiderSettings(cluster_window_days=30, min_insiders=3),
                                       today=TODAY)
    assert c.insider_count == 3 and c.volume.mid_cents == 20_000


def test_an_implausible_value_cannot_clear_an_alert_value_floor(conn):
    _seed(conn, "SLBT", "0000000001", [("a-1", "0000000010", [_slbt_tx()])])
    filing = conn.execute("SELECT * FROM insider_filings").fetchone()
    rows, owners = insider_alerts.load_filing(conn, filing["id"])
    assert insider_alerts._direction_value(rows) is None
    floor = _parse_rule({"name": "Large insider buy", "direction": "buy", "min_value_usd": 1_000_000}, 0)
    assert insider_alerts.match_filing(filing, owners, rows, floor) is None
    # A rule with no floor still claims it, and the message says what it is.
    any_buy = _parse_rule({"name": "Director buys", "direction": "buy", "roles": ["director"]}, 0)
    match = insider_alerts.match_filing(filing, owners, rows, any_buy)
    assert match is not None and match.value_cents is None
    msg = telegram.format_insider_filing(match)
    assert "bought <b>an implausible as-filed amount</b>" in msg
    assert "4,545,306 sh @ $2,272,653.00 = $10329903.3M · <i>as filed, implausible</i>" in msg
    assert "<b>$10329903.3M</b>" not in msg


def test_audit_lists_the_rows_and_the_arithmetic_check_still_passes(conn):
    _seed(conn, "SLBT", "0000000001", [("a-1", "0000000010", [_slbt_tx()])])
    found = audit.check_insider_implausible_values(conn)
    assert len(found) == 1 and found[0].severity == audit.WARN
    assert found[0].code == "insider_implausible_values"
    assert found[0].evidence == ["a-1  SLBT  purchase  4,545,306 × $2,272,653.00 = $10,329,903,316,818"]
    # The stored value is unchanged, so shares × price still holds.
    assert audit.check_insider_values(conn) == []
    assert audit.check_insider_implausible_values.__name__ in [c.__name__ for c in audit.CHECKS]
    names = [c.__name__ for c in audit.CHECKS]
    assert names.index("check_insider_implausible_values") == names.index("check_insider_values") + 1


def test_audit_is_quiet_when_nothing_is_flagged(conn):
    _seed(conn, "REAL", "0000000002", [("b-1", "0000000011", [_tx(80_000_000)])])
    assert audit.check_insider_implausible_values(conn) == []


# --- migration ---------------------------------------------------------------


def _v3_database(path, rows):
    """A database exactly as the pipeline left it at schema version 3: the
    insider tables without the `implausible` column."""
    v3_insider_ddl = re.sub(r"late INTEGER,.*?implausible INTEGER", "late INTEGER",
                            db._INSIDER_DDL, flags=re.S)
    assert "implausible" not in v3_insider_ddl
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.executescript(db._DDL + v3_insider_ddl)
    _seed(conn, "SLBT", "0000000001", [("a-1", "0000000010", [])])
    fid = db.insider_filing_id(conn, "a-1")
    for shares, price in rows:
        conn.execute(
            """INSERT INTO insider_transactions (filing_id, transaction_code, action, tx_date, shares,
               price_per_share, amount_min_cents, amount_max_cents, amount_exact_cents, late)
               VALUES (?, 'P', 'purchase', '2026-10-06', ?, ?, ?, ?, ?, 0)""",
            (fid, shares, price, round(shares * price * 100), round(shares * price * 100),
             round(shares * price * 100)))
    conn.execute("PRAGMA user_version = 3")
    conn.commit()
    conn.close()


def test_version_3_database_gains_a_populated_column(tmp_path):
    path = tmp_path / "v3.sqlite3"
    _v3_database(path, [(SLBT["shares"], SLBT["price"]), (1000.0, 5.0)])
    raw = sqlite3.connect(path)
    assert "implausible" not in {r[1] for r in raw.execute("PRAGMA table_info(insider_transactions)")}
    raw.close()

    conn = db.connect(path)
    assert conn.execute("PRAGMA user_version").fetchone()[0] >= 4
    assert [r[0] for r in conn.execute("SELECT implausible FROM insider_transactions ORDER BY id")] == [1, 0]
    conn.close()
    # Reconnecting neither re-adds the column nor fails.
    again = db.connect(path)
    assert [r[0] for r in again.execute("SELECT implausible FROM insider_transactions ORDER BY id")] == [1, 0]
    again.close()


def test_fresh_database_has_the_column(conn):
    assert "implausible" in {r[1] for r in conn.execute("PRAGMA table_info(insider_transactions)")}
