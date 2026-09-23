"""Insider alert rules: parsing, matching, and what actually gets sent.

The rules are user-written YAML, so two things matter as much as the matching
itself: a malformed rule must fail loudly rather than silently never match,
and a filing must be alerted at most once.
"""

from datetime import date

import pytest

from whale import db, insider_alerts, pipeline, stats, telegram
from whale.config import (Config, ConfigError, InsiderRule, InsiderSettings,
                          _parse_rule, _refire_growth)

TODAY = date(2026, 7, 1)


@pytest.fixture
def conn(tmp_path):
    c = db.connect(tmp_path / "t.sqlite3")
    yield c
    c.close()


def _rule(**kw) -> InsiderRule:
    return _parse_rule({"name": "R", **kw}, 0)


def _filing(conn, accession="0000000000-26-000001", ticker="ACME", plan=None,
            filing_date="2026-06-20", status="parsed",
            owners=(("0000000010", "Alex Officer", {"is_officer": True,
                                                    "officer_title": "Chief Executive Officer"}),)):
    fid = db.insert_insider_filing(
        conn, accession=accession, form_type="4", issuer_cik="0000000001",
        issuer_name="Acme & Co.", ticker=ticker, filing_date=filing_date,
        aff_10b5_one=plan, source="feed",
        source_url=f"http://sec/{accession}-index.htm", status=status)
    rows = []
    for cik, name, flags in owners:
        db.upsert_insider(conn, cik, name)
        rows.append({"cik": cik, **flags})
    db.replace_insider_owners(conn, fid, rows)
    return fid


def _tx(action="purchase", value=100_000, shares=100.0, price=10.0, late=0,
        tx_date="2026-06-18"):
    return {"transaction_code": "P" if action == "purchase" else "S", "action": action,
            "tx_date": tx_date, "shares": shares, "price_per_share": price,
            "amount_min_cents": value, "amount_max_cents": value,
            "amount_exact_cents": value, "late": late}


def _load(conn, fid):
    filing = conn.execute("SELECT * FROM insider_filings WHERE id = ?", (fid,)).fetchone()
    rows, owners = insider_alerts.load_filing(conn, fid)
    return filing, owners, rows


def _match(conn, fid, rule):
    filing, owners, rows = _load(conn, fid)
    return insider_alerts.match_filing(filing, owners, rows, rule)


# --- a malformed rule must not fail silently --------------------------------


def test_a_misspelled_condition_is_rejected(conn):
    # The dangerous failure: a typo'd key would make the rule match nothing,
    # forever, with no error.
    with pytest.raises(ConfigError, match="unknown key"):
        _parse_rule({"name": "R", "min_value_used": 100}, 0)


def test_unknown_direction_kind_and_role_are_rejected():
    with pytest.raises(ConfigError, match="direction"):
        _parse_rule({"name": "R", "direction": "long"}, 0)
    with pytest.raises(ConfigError, match="kind"):
        _parse_rule({"name": "R", "kind": "trade"}, 0)
    with pytest.raises(ConfigError, match="role"):
        _parse_rule({"name": "R", "roles": ["chairman"]}, 0)


def test_a_rule_needs_a_name():
    with pytest.raises(ConfigError, match="needs a name"):
        _parse_rule({"direction": "buy"}, 0)


def test_contradictory_10b5_1_conditions_are_rejected():
    with pytest.raises(ConfigError, match="require and exclude"):
        _parse_rule({"name": "R", "exclude_10b5_1": True, "require_10b5_1": True}, 0)


def test_a_cluster_rule_cannot_name_a_person():
    # roles and titles describe one filer; a cluster spans several, so the
    # condition would quietly do nothing.
    with pytest.raises(ConfigError, match="cluster rule"):
        _parse_rule({"name": "R", "kind": "cluster", "titles": ["ceo"]}, 0)


# --- value ------------------------------------------------------------------


def test_value_threshold_is_inclusive(conn):
    fid = _filing(conn)
    db.replace_insider_transactions(conn, fid, [_tx(value=250_000_00)])
    conn.commit()
    assert _match(conn, fid, _rule(min_value_usd=250_000)) is not None
    assert _match(conn, fid, _rule(min_value_usd=250_001)) is None


def test_value_sums_one_direction_within_the_filing(conn):
    fid = _filing(conn)
    db.replace_insider_transactions(conn, fid, [
        _tx(value=60_000_00), _tx(value=45_000_00),
        _tx(action="sale", value=900_000_00),   # the other direction must not help
    ])
    conn.commit()
    match = _match(conn, fid, _rule(direction="buy", min_value_usd=100_000))
    assert match is not None and match.value_cents == 105_000_00
    assert len(match.rows) == 2


def test_an_unpriced_direction_cannot_clear_a_value_floor(conn):
    # An unknown value is not a large one.
    fid = _filing(conn)
    db.replace_insider_transactions(conn, fid, [
        _tx(value=None, price=None, shares=5_000_000.0)])
    conn.commit()
    assert _match(conn, fid, _rule(min_value_usd=1)) is None
    # A rule that asks nothing about value still matches it.
    match = _match(conn, fid, _rule(direction="buy"))
    assert match is not None and match.value_cents is None


# --- direction --------------------------------------------------------------


def test_direction_filters(conn):
    fid = _filing(conn)
    db.replace_insider_transactions(conn, fid, [_tx(action="sale")])
    conn.commit()
    assert _match(conn, fid, _rule(direction="sell")) is not None
    assert _match(conn, fid, _rule(direction="buy")) is None
    assert _match(conn, fid, _rule(direction="any")) is not None


# --- who ---------------------------------------------------------------------


def test_role_condition(conn):
    director = (("0000000020", "Dana Director", {"is_director": True}),)
    fid = _filing(conn, owners=director)
    db.replace_insider_transactions(conn, fid, [_tx()])
    conn.commit()
    assert _match(conn, fid, _rule(roles=["director"])) is not None
    assert _match(conn, fid, _rule(roles=["ten_percent_owner"])) is None
    assert _match(conn, fid, _rule(roles=["officer", "director"])) is not None


def test_title_matching_is_case_insensitive_and_substring(conn):
    fid = _filing(conn)  # title: "Chief Executive Officer"
    db.replace_insider_transactions(conn, fid, [_tx()])
    conn.commit()
    assert _match(conn, fid, _rule(titles=["chief executive"])) is not None
    assert _match(conn, fid, _rule(titles=["CHIEF EXECUTIVE"])) is not None
    assert _match(conn, fid, _rule(titles=["chief financial"])) is None


def test_roles_and_titles_must_be_met_by_the_same_person(conn):
    # A director with no title, plus an officer titled CFO: a rule asking for
    # a director titled CEO must not be satisfied by combining two people.
    fid = _filing(conn, owners=(
        ("0000000020", "Dana Director", {"is_director": True}),
        ("0000000021", "Finn Finance", {"is_officer": True, "officer_title": "CFO"}),
    ))
    db.replace_insider_transactions(conn, fid, [_tx()])
    conn.commit()
    assert _match(conn, fid, _rule(roles=["director"], titles=["ceo"])) is None
    assert _match(conn, fid, _rule(roles=["officer"], titles=["cfo"])) is not None


def test_any_owner_on_a_joint_filing_can_satisfy_a_rule(conn):
    # A founder filing alongside their holding company is one economic act.
    fid = _filing(conn, owners=(
        ("0000000030", "Founder Holdings LLC", {"is_ten_percent_owner": True}),
        ("0000000031", "Fran Founder", {"is_officer": True, "officer_title": "CEO"}),
    ))
    db.replace_insider_transactions(conn, fid, [_tx()])
    conn.commit()
    match = _match(conn, fid, _rule(titles=["ceo"]))
    assert match is not None
    # The primary owner is still the one the message leads with.
    assert match.primary["name"] == "Founder Holdings LLC"


# --- 10b5-1 -----------------------------------------------------------------


def test_excluding_planned_trades(conn):
    planned = _filing(conn, accession="0000000000-26-000002", plan=1)
    unplanned = _filing(conn, accession="0000000000-26-000003", plan=0)
    unknown = _filing(conn, accession="0000000000-26-000004", plan=None)
    for fid in (planned, unplanned, unknown):
        db.replace_insider_transactions(conn, fid, [_tx()])
    conn.commit()
    rule = _rule(exclude_10b5_1=True)
    assert _match(conn, planned, rule) is None
    assert _match(conn, unplanned, rule) is not None
    # An absent checkbox is not an assertion that a plan existed.
    assert _match(conn, unknown, rule) is not None


def test_requiring_planned_trades(conn):
    planned = _filing(conn, accession="0000000000-26-000005", plan=1)
    unknown = _filing(conn, accession="0000000000-26-000006", plan=None)
    for fid in (planned, unknown):
        db.replace_insider_transactions(conn, fid, [_tx()])
    conn.commit()
    rule = _rule(require_10b5_1=True)
    assert _match(conn, planned, rule) is not None
    assert _match(conn, unknown, rule) is None


# --- ordering ---------------------------------------------------------------


def test_the_first_matching_rule_claims_the_filing(conn):
    fid = _filing(conn)  # a CEO buying $1M
    db.replace_insider_transactions(conn, fid, [_tx(value=1_000_000_00)])
    conn.commit()
    filing, owners, rows = _load(conn, fid)
    specific = _parse_rule({"name": "CEO buying", "titles": ["chief executive"]}, 0)
    general = _parse_rule({"name": "Large buy", "min_value_usd": 100_000}, 1)
    assert insider_alerts.first_filing_match(filing, owners, rows,
                                             [specific, general]).rule.name == "CEO buying"
    # Order is the whole mechanism: reversed, the general rule claims it.
    assert insider_alerts.first_filing_match(filing, owners, rows,
                                             [general, specific]).rule.name == "Large buy"


def test_a_cluster_rule_never_claims_a_single_filing(conn):
    fid = _filing(conn)
    db.replace_insider_transactions(conn, fid, [_tx()])
    conn.commit()
    assert _match(conn, fid, _rule(kind="cluster", min_insiders=1)) is None


# --- clusters ---------------------------------------------------------------


def _cluster_setup(conn, n=3, action="purchase", tx_date="2026-06-25"):
    for i in range(n):
        fid = _filing(conn, accession=f"0000000000-26-1000{i}", ticker="CLU",
                      owners=((f"000000010{i}", f"Insider {i}", {"is_officer": True}),))
        db.replace_insider_transactions(conn, fid, [_tx(action=action, tx_date=tx_date)])
    conn.commit()


def _settings(*rules, **kw) -> InsiderSettings:
    return InsiderSettings(alerts=list(rules), **kw)


def test_cluster_rule_honours_its_own_threshold(conn):
    _cluster_setup(conn, n=3)
    tight = _parse_rule({"name": "Four buyers", "kind": "cluster", "direction": "buy",
                         "min_insiders": 4}, 0)
    loose = _parse_rule({"name": "Three buyers", "kind": "cluster", "direction": "buy",
                         "min_insiders": 3}, 1)
    assert insider_alerts.cluster_matches(conn, _settings(tight), TODAY) == []
    matched = insider_alerts.cluster_matches(conn, _settings(loose), TODAY)
    assert [(c.ticker, r.name) for c, r, _ in matched] == [("CLU", "Three buyers")]


def test_cluster_rule_honours_its_own_window(conn):
    _cluster_setup(conn, n=3, tx_date="2026-05-01")  # 61 days before TODAY
    narrow = _parse_rule({"name": "30d", "kind": "cluster", "min_insiders": 3,
                          "window_days": 30}, 0)
    wide = _parse_rule({"name": "90d", "kind": "cluster", "min_insiders": 3,
                        "window_days": 90}, 1)
    assert insider_alerts.cluster_matches(conn, _settings(narrow), TODAY) == []
    assert len(insider_alerts.cluster_matches(conn, _settings(wide), TODAY)) == 1


def test_only_one_rule_reports_a_given_convergence(conn):
    _cluster_setup(conn, n=4)
    first = _parse_rule({"name": "Three buyers", "kind": "cluster", "min_insiders": 3}, 0)
    second = _parse_rule({"name": "Four buyers", "kind": "cluster", "min_insiders": 4}, 1)
    matched = insider_alerts.cluster_matches(conn, _settings(first, second), TODAY)
    assert [r.name for _, r, _ in matched] == ["Three buyers"]


def test_cluster_direction_is_respected(conn):
    _cluster_setup(conn, n=3, action="sale")
    buys = _parse_rule({"name": "Buying", "kind": "cluster", "direction": "buy",
                        "min_insiders": 3}, 0)
    assert insider_alerts.cluster_matches(conn, _settings(buys), TODAY) == []


# --- what gets sent ---------------------------------------------------------


@pytest.fixture
def sent(monkeypatch):
    messages = []
    monkeypatch.setattr(telegram, "send_message",
                        lambda token, chat, text, **kw: messages.append(text))
    return messages


def _config(*rules) -> Config:
    config = Config(telegram_bot_token="t", telegram_chat_id="c",
                    edgar_user_agent="whale-tracker test@example.com")
    config.insiders.alerts = list(rules)
    return config


def test_a_matching_filing_is_sent_once(conn, sent):
    fid = _filing(conn)
    db.replace_insider_transactions(conn, fid, [_tx(value=500_000_00)])
    conn.commit()
    config = _config(_parse_rule({"name": "Large buy", "min_value_usd": 250_000}, 0))

    assert pipeline.notify_insiders(conn, config) == 1
    assert len(sent) == 1 and "Large buy" in sent[0]
    row = conn.execute("SELECT status, notified_at FROM insider_filings").fetchone()
    assert row["status"] == "notified" and row["notified_at"]

    # Re-running must not repeat it.
    assert pipeline.notify_insiders(conn, config) == 0
    assert len(sent) == 1


def test_a_filing_no_rule_wants_is_demoted_to_history(conn, sent):
    fid = _filing(conn)
    db.replace_insider_transactions(conn, fid, [_tx(value=60_000_00)])
    conn.commit()
    config = _config(_parse_rule({"name": "Large buy", "min_value_usd": 250_000}, 0))

    assert pipeline.notify_insiders(conn, config) == 0
    assert sent == []
    # Demoted so it is not re-examined every run, but still counted.
    assert conn.execute("SELECT status FROM insider_filings").fetchone()["status"] == "backfilled"


def test_a_dry_run_previews_without_consuming_the_queue(conn, sent, capsys):
    fid = _filing(conn)
    db.replace_insider_transactions(conn, fid, [_tx(value=500_000_00)])
    conn.commit()
    config = _config(_parse_rule({"name": "Large buy", "min_value_usd": 250_000}, 0))

    pipeline.notify_insiders(conn, config, dry_run=True)
    assert "Large buy" in capsys.readouterr().out
    assert sent == []
    assert conn.execute("SELECT status FROM insider_filings").fetchone()["status"] == "parsed"


def test_no_rules_means_no_alerts(conn, sent):
    fid = _filing(conn)
    db.replace_insider_transactions(conn, fid, [_tx(value=500_000_00)])
    conn.commit()
    assert pipeline.notify_insiders(conn, _config()) == 0
    assert sent == []
    # Untouched: with no rules the filing was never a pending message.
    assert conn.execute("SELECT status FROM insider_filings").fetchone()["status"] == "parsed"


def test_missing_telegram_secrets_does_not_consume_the_queue(conn):
    fid = _filing(conn)
    db.replace_insider_transactions(conn, fid, [_tx(value=500_000_00)])
    conn.commit()
    config = Config()
    config.insiders.alerts = [_parse_rule({"name": "Large buy", "min_value_usd": 1}, 0)]
    assert pipeline.notify_insiders(conn, config) == 0
    assert conn.execute("SELECT status FROM insider_filings").fetchone()["status"] == "parsed"


def test_cluster_alert_is_sent_and_deduped(conn, sent):
    _cluster_setup(conn, n=3)
    config = _config(_parse_rule({"name": "Cluster buying", "kind": "cluster",
                                  "direction": "buy", "min_insiders": 3}, 0))
    # The filings themselves match no filing rule, so only the cluster fires.
    assert pipeline.notify_insiders(conn, config, today=TODAY) == 1
    assert "Cluster buying" in sent[0] and "3 insiders bought" in sent[0]
    assert pipeline.notify_insiders(conn, config, today=TODAY) == 0
    assert len(sent) == 1


def _join_cluster(conn, i, ticker="CLU", action="purchase", tx_date="2026-06-25"):
    """One more insider converging on the same issuer."""
    # 9xx CIKs: _cluster_setup already owns 010x.
    fid = _filing(conn, accession=f"0000000000-26-199{i:02d}", ticker=ticker,
                  owners=((f"00000009{i:02d}", f"Insider 9{i}", {"is_officer": True}),))
    db.replace_insider_transactions(conn, fid, [_tx(action=action, tx_date=tx_date)])
    conn.commit()


def _cluster_config():
    return _config(_parse_rule({"name": "Cluster buying", "kind": "cluster",
                                "direction": "buy", "min_insiders": 3}, 0))


def test_a_cluster_refires_only_when_materially_bigger(conn, sent):
    # Form 4 is due in two business days, so a coordinated purchase arrives as
    # a burst and the cluster grows on nearly every poll. One more insider is
    # the normal shape of one event, not a second event: BBD went 4 -> 5 -> 10
    # -> 21 in a day and sent four alerts describing one board purchase.
    _cluster_setup(conn, n=3)
    config = _cluster_config()
    assert pipeline.notify_insiders(conn, config, today=TODAY) == 1
    assert "3 insiders bought" in sent[-1]

    _join_cluster(conn, 1)  # 3 -> 4: same event, still growing
    assert pipeline.notify_insiders(conn, config, today=TODAY) == 0
    assert len(sent) == 1

    _join_cluster(conn, 2)  # 3 -> 5: half as many again, worth saying
    assert pipeline.notify_insiders(conn, config, today=TODAY) == 1
    assert "5 insiders bought" in sent[-1]


def test_the_refire_growth_factor_is_configurable(conn, sent):
    _cluster_setup(conn, n=3)
    config = _cluster_config()
    config.insiders.cluster_refire_growth = 1.0  # every extra insider speaks
    assert pipeline.notify_insiders(conn, config, today=TODAY) == 1
    _join_cluster(conn, 1)
    assert pipeline.notify_insiders(conn, config, today=TODAY) == 1
    assert "4 insiders bought" in sent[-1]


def test_a_growth_factor_that_cannot_damp_anything_is_rejected():
    # Below 1.0 the test collapses to "one more insider" — the behaviour it
    # reads as replacing. A silent no-op is the failure this project avoids.
    with pytest.raises(ConfigError, match="at least 1.0"):
        _refire_growth(0.5)
    with pytest.raises(ConfigError, match="must be a number"):
        _refire_growth("soon")


# --- a cluster's members must not each repeat it ----------------------------


def test_cluster_members_do_not_also_alert_individually(conn, sent):
    # The BBD case: 21 board members bought on the same day, each filing
    # cleared the "large buy" floor, and the user got 21 messages plus the
    # cluster alert for one corporate event.
    _cluster_setup(conn, n=3)
    config = _config(
        _parse_rule({"name": "Cluster buying", "kind": "cluster",
                     "direction": "buy", "min_insiders": 3}, 0),
        _parse_rule({"name": "Large buy", "min_value_usd": 1}, 1),
    )
    assert pipeline.notify_insiders(conn, config, today=TODAY) == 1
    assert len(sent) == 1 and "Cluster buying" in sent[0]

    # Folded in, not lost: demoted to history so the dashboard still counts it.
    statuses = {r["status"] for r in conn.execute("SELECT status FROM insider_filings")}
    assert statuses == {"backfilled"}


def test_a_filing_outside_the_cluster_still_alerts(conn, sent):
    # Suppression is scoped to the converging issuer and direction, not to
    # every filing that happens to arrive alongside one.
    _cluster_setup(conn, n=3)
    fid = _filing(conn, accession="0000000000-26-20001", ticker="OTHER")
    conn.execute("UPDATE insider_filings SET issuer_cik = '0000000002' WHERE id = ?",
                 (fid,))
    db.replace_insider_transactions(conn, fid, [_tx(value=500_000_00)])
    conn.commit()
    config = _config(
        _parse_rule({"name": "Cluster buying", "kind": "cluster",
                     "direction": "buy", "min_insiders": 3}, 0),
        _parse_rule({"name": "Large buy", "min_value_usd": 250_000}, 1),
    )
    assert pipeline.notify_insiders(conn, config, today=TODAY) == 2
    assert any("Cluster buying" in m for m in sent)
    assert any("Large buy" in m for m in sent)


def test_a_sale_is_not_suppressed_by_a_buying_cluster(conn, sent):
    # Direction is part of the key: insiders buying says nothing about the
    # officer selling the same stock.
    _cluster_setup(conn, n=3)
    fid = _filing(conn, accession="0000000000-26-20002", ticker="CLU")
    db.replace_insider_transactions(conn, fid, [_tx(action="sale", value=500_000_00)])
    conn.commit()
    config = _config(
        _parse_rule({"name": "Cluster buying", "kind": "cluster",
                     "direction": "buy", "min_insiders": 3}, 0),
        _parse_rule({"name": "Big sale", "direction": "sell",
                     "min_value_usd": 250_000}, 1),
    )
    assert pipeline.notify_insiders(conn, config, today=TODAY) == 2
    assert any("Big sale" in m for m in sent)


def test_members_stay_suppressed_once_the_cluster_has_been_reported(conn, sent):
    # The cluster alerted last run and has not grown enough to speak again.
    # A member arriving now is still part of a convergence the user knows
    # about, so it must not resurface as an individual alert.
    _cluster_setup(conn, n=3)
    config = _config(
        _parse_rule({"name": "Cluster buying", "kind": "cluster",
                     "direction": "buy", "min_insiders": 3}, 0),
        _parse_rule({"name": "Large buy", "min_value_usd": 1}, 1),
    )
    assert pipeline.notify_insiders(conn, config, today=TODAY) == 1
    _join_cluster(conn, 1)
    assert pipeline.notify_insiders(conn, config, today=TODAY) == 0
    assert len(sent) == 1


def test_a_member_still_alerts_when_the_cluster_message_failed(conn, sent,
                                                               monkeypatch):
    # An undelivered cluster alert must not swallow its members: the user
    # would otherwise hear nothing at all about the convergence.
    _cluster_setup(conn, n=3)
    monkeypatch.setattr(telegram, "send_message",
                        lambda *a, **kw: (_ for _ in ()).throw(RuntimeError("down")))
    config = _config(
        _parse_rule({"name": "Cluster buying", "kind": "cluster",
                     "direction": "buy", "min_insiders": 3}, 0),
        _parse_rule({"name": "Large buy", "min_value_usd": 1}, 1),
    )
    pipeline.notify_insiders(conn, config, today=TODAY)
    # Nothing was delivered, so nothing was consumed and nothing was folded in.
    statuses = {r["status"] for r in conn.execute("SELECT status FROM insider_filings")}
    assert statuses == {"parsed"}


def test_a_congressional_cluster_does_not_suppress_an_insider_one(conn, sent):
    # Both sources can converge on the same ticker. They share the alerts
    # table, so without the kind in the dedupe key one would silence the other.
    db.record_alert(conn, stats.CLUSTER_KIND, "CLU", "buy", 90, 5, 1_000_000)
    conn.commit()
    _cluster_setup(conn, n=3)
    config = _config(_parse_rule({"name": "Cluster buying", "kind": "cluster",
                                  "direction": "buy", "min_insiders": 3}, 0))
    assert pipeline.notify_insiders(conn, config, today=TODAY) == 1
    kinds = [r["kind"] for r in conn.execute("SELECT kind FROM alerts ORDER BY id")]
    assert kinds == [stats.CLUSTER_KIND, stats.INSIDER_CLUSTER_KIND]


# --- preview ----------------------------------------------------------------


def test_preview_ignores_notification_state(conn):
    # Tuning a rule is only possible against filings already examined.
    fid = _filing(conn, status="notified")
    db.replace_insider_transactions(conn, fid, [_tx(value=500_000_00)])
    fid2 = _filing(conn, accession="0000000000-26-000099", status="backfilled")
    db.replace_insider_transactions(conn, fid2, [_tx(value=500_000_00)])
    conn.commit()
    settings = _settings(_parse_rule({"name": "Large buy", "min_value_usd": 250_000}, 0))
    assert len(insider_alerts.preview(conn, settings)) == 2
    assert len(insider_alerts.preview(conn, settings, limit=1)) == 1


def test_preview_window_is_on_the_filing_date(conn):
    fid = _filing(conn, filing_date="2026-01-05")
    db.replace_insider_transactions(conn, fid, [_tx(value=500_000_00)])
    conn.commit()
    settings = _settings(_parse_rule({"name": "Large buy", "min_value_usd": 250_000}, 0))
    assert insider_alerts.preview(conn, settings, window_days=30, today=TODAY) == []
    assert len(insider_alerts.preview(conn, settings, window_days=365, today=TODAY)) == 1


def test_a_dry_run_does_not_demote_a_filing_no_rule_wants(conn, sent):
    # The queue must survive a preview: demoting here would mean a later real
    # run never alerts on the filing, even after the rules are widened.
    fid = _filing(conn)
    db.replace_insider_transactions(conn, fid, [_tx(value=60_000_00)])
    conn.commit()
    config = _config(_parse_rule({"name": "Large buy", "min_value_usd": 250_000}, 0))

    pipeline.notify_insiders(conn, config, dry_run=True, today=TODAY)
    assert conn.execute("SELECT status FROM insider_filings").fetchone()["status"] == "parsed"
    assert sent == []

    # Widening the rule then catches it on the real run.
    wider = _config(_parse_rule({"name": "Any buy", "min_value_usd": 50_000}, 0))
    assert pipeline.notify_insiders(conn, wider, today=TODAY) == 1
