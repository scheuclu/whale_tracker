"""The shipped config.yaml: "Large insider buy" means the people who run the
company, and a 10% holder needs a much larger buy to be news.

Of the first 291 insider alerts, 82 had a 10% owner with no officer or
director flag as the primary filer — Berkshire in Lennar, GoldenTree in QVC,
Nippon Life in Corebridge — although the rule's own comment said it was for
"the people who set guidance". These tests load the real config.yaml, so a
rule edited back into a catch-all fails here rather than in Telegram.
"""

import pytest

from whale import db, insider_alerts
from whale.config import DEFAULT_CONFIG_FILE, load_config


@pytest.fixture(scope="module")
def rules():
    settings = load_config(DEFAULT_CONFIG_FILE).insiders
    assert settings.alerting, "config.yaml should ship with insider alert rules"
    return settings.rules_of_kind("filing")


@pytest.fixture
def conn(tmp_path):
    c = db.connect(tmp_path / "t.sqlite3")
    yield c
    c.close()


def _by_name(rules, name):
    return next(r for r in rules if r.name == name)


def _filing(conn, owners, value, accession="0000000000-26-000001", title=None):
    """A purchase of `value` cents by `owners`: (cik, flags) pairs, primary first."""
    fid = db.insert_insider_filing(
        conn, accession=accession, form_type="4", issuer_cik="0000000001",
        issuer_name="Lennar Corp", ticker="LEN", filing_date="2026-06-20",
        source="feed", source_url=f"http://sec/{accession}-index.htm", status="parsed")
    rows = []
    for cik, flags in owners:
        db.upsert_insider(conn, cik, f"Owner {cik[-2:]}")
        rows.append({"cik": cik, **flags})
    db.replace_insider_owners(conn, fid, rows)
    db.replace_insider_transactions(conn, fid, [{
        "transaction_code": "P", "action": "purchase", "tx_date": "2026-06-18",
        "shares": 1000.0, "price_per_share": value / 100 / 1000,
        "amount_min_cents": value, "amount_max_cents": value,
        "amount_exact_cents": value, "late": 0}])
    conn.commit()
    filing = conn.execute("SELECT * FROM insider_filings WHERE id = ?", (fid,)).fetchone()
    tx, own = insider_alerts.load_filing(conn, fid)
    return filing, own, tx


FUND = ("0000000050", {"is_ten_percent_owner": True})
DIRECTOR = ("0000000020", {"is_director": True})
OFFICER = ("0000000010", {"is_officer": True, "officer_title": "Chief Operating Officer"})
CEO = ("0000000011", {"is_officer": True, "officer_title": "Chief Executive Officer"})


# --- what config.yaml says ----------------------------------------------------


def test_large_insider_buy_asks_for_an_officer_or_director(rules):
    rule = _by_name(rules, "Large insider buy")
    assert rule.direction == "buy"
    assert sorted(rule.roles) == ["director", "officer"]
    assert rule.min_value_usd == 1_000_000


def test_a_ten_percent_owner_rule_follows_it_with_a_higher_floor(rules):
    names = [r.name for r in rules]
    assert names.index("Large 10% owner buy") == names.index("Large insider buy") + 1
    rule = _by_name(rules, "Large 10% owner buy")
    assert rule.direction == "buy"
    assert rule.roles == ["ten_percent_owner"]
    assert rule.min_value_usd == 10_000_000


def test_the_specific_rules_still_come_first(rules):
    names = [r.name for r in rules]
    assert names.index("CEO or CFO buying") < names.index("Large insider buy")


# --- what that means for a filing -------------------------------------------


def test_a_fund_buying_five_million_alone_is_no_longer_an_insider_buy(conn, rules):
    match = insider_alerts.first_filing_match(*_filing(conn, [FUND], 5_000_000_00), rules)
    assert match is None


def test_a_fund_buying_ten_million_is_a_ten_percent_owner_buy(conn, rules):
    match = insider_alerts.first_filing_match(*_filing(conn, [FUND], 10_000_000_00), rules)
    assert match is not None and match.rule.name == "Large 10% owner buy"


def test_a_director_buying_a_million_is_an_insider_buy(conn, rules):
    match = insider_alerts.first_filing_match(*_filing(conn, [DIRECTOR], 1_000_000_00), rules)
    assert match is not None and match.rule.name == "Large insider buy"
    match = insider_alerts.first_filing_match(
        *_filing(conn, [OFFICER], 1_000_000_00, accession="0000000000-26-000002"), rules)
    assert match is not None and match.rule.name == "Large insider buy"


def test_any_one_owner_on_a_joint_filing_satisfies_the_role(conn, rules):
    # A fund filing jointly with the founder on its board is one economic
    # act, and the roles printed on it describe who is behind it — so it is
    # an insider buy, not a 10% owner buy, and the primary stays the fund.
    match = insider_alerts.first_filing_match(
        *_filing(conn, [FUND, DIRECTOR], 1_000_000_00), rules)
    assert match is not None and match.rule.name == "Large insider buy"
    assert match.primary["insider_cik"] == FUND[0]


def test_a_ceo_is_still_claimed_by_the_ceo_rule_first(conn, rules):
    match = insider_alerts.first_filing_match(*_filing(conn, [CEO], 1_000_000_00), rules)
    assert match is not None and match.rule.name == "CEO or CFO buying"
