"""Public X posts mirror the alert log (xpost.py).

The posts follow the range rules like every other surface: summed brackets,
`≥floor` for the open-ended top bracket, no amount on a transcribed row,
"shares × reported price" on an insider value. An alert is posted once,
a failed post is tried again by the next run, and a dry run records nothing.
"""

from datetime import datetime, timedelta, timezone

import httpx
import pytest

from whale import db, pipeline, stats, xpost
from whale.config import Config, ConfigError, XSettings, _parse_x

BASE = "https://www.fatcatwatch.com"
CREDS = xpost.Credentials("ck", "cs", "at", "ats")


@pytest.fixture
def conn(tmp_path):
    c = db.connect(tmp_path / "t.sqlite3")
    yield c
    c.close()


def _config(**x):
    return Config(dashboard_url=BASE, x=XSettings(enabled=True, **x),
                  x_api_key="ck", x_api_secret="cs", x_access_token="at", x_access_token_secret="ats")


def _member_filing(conn, rows, parse_method="text", filing_date="2026-11-01", doc="20035484"):
    pid = db.upsert_politician(conn, bioguide_id="M001239", full_name="John J. McGuire III",
                               first="John", last="McGuire", chamber="house", party="R",
                               state="VA", district="5", active=1)
    fid = db.insert_filing(conn, chamber="house", doc_id=doc, politician_id=pid,
                           filer_name="John McGuire", state_district="VA05", filing_type="P",
                           filing_date=filing_date, year=2026, pdf_url=f"http://x/{doc}.pdf",
                           status="notified", parse_method=parse_method)
    full = []
    for r in rows:
        full.append({"tx_date": "2026-09-24", "notification_date": None, "owner": None,
                     "asset_name": r.get("asset_name", "Some Co - Common Stock"), "ticker": r.get("ticker"),
                     "asset_type": "ST", "action": r["action"], "amount_min_cents": r.get("lo"),
                     "amount_max_cents": r.get("hi"), "amount_exact_cents": r.get("exact"),
                     "amount_raw": "", "description": None, "cap_gains_over_200": None,
                     "raw_text": "", "option_kind": None} | ({"tx_date": r["tx_date"]} if "tx_date" in r else {}))
    db.replace_transactions(conn, fid, pid, full)
    conn.commit()
    return fid


def _alert(conn, kind, **kw):
    aid = db.record_alert(conn, kind, kw.pop("ticker", None), kw.pop("direction", None),
                          kw.pop("window_days", 0), kw.pop("count", 1), **kw)
    conn.commit()
    return conn.execute("SELECT * FROM alerts WHERE id = ?", (aid,)).fetchone()


B1 = dict(lo=100_100, hi=1_500_000)          # $1,001 - $15,000
B4 = dict(lo=10_000_100, hi=25_000_000)      # $100,001 - $250,000
TOP = dict(lo=5_000_000_100, hi=None)        # Over $50,000,000: open-ended


# --- length -------------------------------------------------------------------


def test_weighted_length_counts_links_as_23_and_wide_characters_as_2():
    assert xpost.weighted_length("abc") == 3
    assert xpost.weighted_length("see https://www.fatcatwatch.com/members/a-very-long-slug?utm_source=x") == 4 + 23
    assert xpost.weighted_length("🏛") == 2
    assert xpost.weighted_length("$1,001–$15k") == 11  # the en dash is a narrow character


# --- composing ----------------------------------------------------------------


def test_a_filing_post_sums_each_assets_ranges_and_links_the_member_page(conn):
    fid = _member_filing(conn, [
        dict(action="purchase", ticker="MU", **B1), dict(action="purchase", ticker="MU", **B1),
        dict(action="purchase", ticker="MU", **B1), dict(action="sale_partial", ticker="AVGO", **B4),
    ])
    text = xpost.compose(conn, _alert(conn, stats.FILING_KIND, filing_id=fid), _config())
    assert text == (
        "🏛 Rep. John J. McGuire III (R-VA5) disclosed 4 trades, filed Nov 1:\n"
        "↘ Sold part of $AVGO · $100k–$250k\n"
        "↗ Bought $MU ×3 · $3,003–$45k\n"
        f"{BASE}/members/john-j-mcguire-iii-m001239?utm_source=x")


def test_the_open_ended_top_bracket_is_a_floor_never_an_upper_bound(conn):
    fid = _member_filing(conn, [dict(action="purchase", ticker="NVDA", **TOP),
                                dict(action="purchase", ticker="NVDA", **B1)])
    text = xpost.compose(conn, _alert(conn, stats.FILING_KIND, filing_id=fid), _config())
    assert "↗ Bought $NVDA ×2 · ≥$50M" in text


def test_a_long_filing_keeps_the_largest_lines_and_counts_the_rest(conn):
    rows = [dict(action="sale", asset_name=f"Asset {i}",
                 lo=100_100 * (i + 1), hi=1_500_000 * (i + 1)) for i in range(30)]
    for i, r in enumerate(rows):
        r["ticker"] = "".join(chr(65 + int(d)) for d in f"{i:03d}")  # AAA, AAB, …: distinct symbols
    fid = _member_filing(conn, rows)
    text = xpost.compose(conn, _alert(conn, stats.FILING_KIND, filing_id=fid), _config())
    assert xpost.weighted_length(text) <= 280
    lines = text.splitlines()
    assert lines[1].startswith("↘ Sold $ACJ")  # row 29, the largest, first
    assert any(line.startswith("+ ") and line.endswith("more on the page") for line in lines)
    assert lines[-1].startswith(f"{BASE}/members/")


def test_a_transcribed_filing_carries_no_amount(conn):
    fid = _member_filing(conn, [dict(action="purchase", asset_name="Austin TX BE/R/", **B4)],
                         parse_method="vision")
    text = xpost.compose(conn, _alert(conn, stats.FILING_KIND, filing_id=fid), _config())
    assert "$100k" not in text and "↗ Bought Austin TX BE/R/\n" in text
    assert "Read from a paper scan" in text


def test_a_late_filing_says_how_late_first(conn):
    fid = _member_filing(conn, [dict(action="sale", ticker="PG", tx_date="2026-08-01", **B1)],
                         filing_date="2026-10-15")
    text = xpost.compose(conn, _alert(conn, stats.FILING_KIND, filing_id=fid), Config(dashboard_url=BASE))
    assert text.startswith("⏰ Filed 30 days past the 45-day deadline\n🏛 ")


def test_a_cluster_names_its_members_only_when_it_named_exactly_those_it_counted(conn):
    named = _alert(conn, stats.CLUSTER_KIND, ticker="PG", direction="sell", window_days=90, count=3,
                   participants="A Member, B Member, C Member",
                   volume_min_cents=4_500_300, volume_max_cents=15_000_000)
    text = xpost.compose(conn, named, _config())
    assert text == ("🔥 3 members of Congress sold $PG within 90 days\n"
                    "A Member, B Member, C Member\n"
                    "Disclosed: $45k–$150k combined.\n"
                    f"{BASE}/tickers/PG?utm_source=x")
    # A fourth name below the floor was in the message but not in the count.
    extra = _alert(conn, stats.CLUSTER_KIND, ticker="PG", direction="sell", window_days=90, count=3,
                   participants="A, B, C, D")
    assert "A, B, C, D" not in xpost.compose(conn, extra, _config())


def _insider_filing(conn, ticker="ASPE", owners=(("0001", "ARCH Venture Fund X, L.P.", 0, 0, 1, None),)):
    cur = conn.execute(
        "INSERT INTO insider_filings (accession, form_type, issuer_cik, issuer_name, ticker, filing_date, "
        "source, source_url, status, first_seen_at, updated_at) VALUES ('acc-1', '4', '0002124080', "
        "'Aspen Neuroscience, Inc.', ?, '2026-11-02', 'feed', 'http://sec/acc-1', 'notified', '2026-11-02', '2026-11-02')",
        (ticker,))
    fid = cur.lastrowid
    for i, (cik, name, officer, director, ten, title) in enumerate(owners):
        conn.execute("INSERT OR IGNORE INTO insiders (cik, name, updated_at) VALUES (?, ?, '2026-11-02')", (cik, name))
        conn.execute("INSERT INTO insider_filing_owners (filing_id, insider_cik, owner_index, is_director, "
                     "is_officer, is_ten_percent_owner, is_other, officer_title) VALUES (?, ?, ?, ?, ?, ?, 0, ?)",
                     (fid, cik, i, director, officer, ten, title))
    conn.commit()
    return fid


def test_an_insider_filing_labels_its_value_as_computed(conn):
    owners = [("0001", "ARCH Venture Fund X, L.P.", 0, 0, 1, None)] + [
        (f"000{i}", f"Joint {i}", 0, 0, 1, None) for i in range(2, 10)]
    fid = _insider_filing(conn, owners=owners)
    alert = _alert(conn, stats.INSIDER_FILING_KIND, ticker="ASPE", direction="buy", insider_filing_id=fid,
                   volume_min_cents=2_000_000_000, volume_max_cents=2_000_000_000)
    assert xpost.compose(conn, alert, _config()) == (
        "💼 Insider buy: $ASPE\n"
        "ARCH Venture Fund X, L.P. (10% owner) +8 joint filers bought $20M of Aspen Neuroscience, Inc. "
        "(shares × reported price), filed Nov 2.\n"
        f"{BASE}/tickers/ASPE?utm_source=x#insiders")


def test_an_unpriced_insider_trade_is_never_a_zero(conn):
    fid = _insider_filing(conn, owners=[("0001", "Doe Jane", 1, 1, 0, "CEO")])
    alert = _alert(conn, stats.INSIDER_FILING_KIND, ticker="ASPE", direction="sell", insider_filing_id=fid)
    text = xpost.compose(conn, alert, _config())
    assert "Doe Jane (CEO, Director) sold shares of Aspen Neuroscience, Inc.; no price was reported" in text
    assert "$0" not in text


def test_an_insider_cluster_keyed_on_a_cik_gets_no_cashtag(conn):
    _insider_filing(conn, ticker=None)
    alert = _alert(conn, stats.INSIDER_CLUSTER_KIND, ticker="0002124080", direction="buy", window_days=30,
                   count=3, volume_min_cents=28_400_000, volume_max_cents=28_400_000)
    text = xpost.compose(conn, alert, _config())
    assert text == ("🔥 3 insiders at Aspen Neuroscience, Inc. bought within 30 days\n"
                    "$284k in all (shares × reported price).\n"
                    f"{BASE}/insiders?utm_source=x")


def test_a_watched_filing_is_posted_once_as_the_filing(conn):
    # Pelosi is watched with every_trade: her filings are logged only as
    # per-trade watchlist messages, never as a filing alert.
    fid = _member_filing(conn, [dict(action="purchase", ticker="NVDA", **B4),
                                dict(action="purchase", ticker="AAPL", **B4)])
    first = _alert(conn, stats.WATCHLIST_KIND, ticker="NVDA", filing_id=fid)
    second = _alert(conn, stats.WATCHLIST_KIND, ticker="AAPL", filing_id=fid)
    replay = _alert(conn, stats.WATCHLIST_KIND, ticker="NVDA", filing_id=fid)
    text = xpost.compose(conn, first, _config())
    assert text.startswith("🏛 Rep. John J. McGuire III (R-VA5) disclosed 2 trades")
    assert xpost.compose(conn, second, _config()) is None
    assert xpost.compose(conn, replay, _config()) is None
    result = xpost.sync(conn, _config(), send=lambda *a: "ok")
    assert (result.posted, result.skipped) == (1, 2)


def test_an_option_alert_leaves_its_filing_to_the_filings_own_post(conn):
    fid = _member_filing(conn, [dict(action="purchase", ticker="NVDA", **B4)])
    option = _alert(conn, stats.OPTIONS_KIND, ticker="NVDA", filing_id=fid)
    assert xpost.compose(conn, option, _config()) is not None  # the filing was all options
    _alert(conn, stats.FILING_KIND, filing_id=fid)
    assert xpost.compose(conn, option, _config()) is None


def test_kinds_the_public_feed_does_not_carry(conn):
    assert xpost.compose(conn, _alert(conn, stats.LATE_FILING_KIND, ticker="20035484"), _config()) is None
    # An unread scan's filing alert: no rows.
    pid = db.upsert_politician(conn, bioguide_id="X000001", full_name="X", first="X", last="X",
                               chamber="house", party="R", state="WI", district="8", active=1)
    fid = db.insert_filing(conn, chamber="house", doc_id="1", politician_id=pid, filer_name="X",
                           state_district="WI08", filing_type="P", filing_date="2026-11-01", year=2026,
                           pdf_url="http://x/1.pdf", status="failed", parse_method="scanned")
    assert xpost.compose(conn, _alert(conn, stats.FILING_KIND, filing_id=fid), _config()) is None
    # No dashboard URL: a post without a working link is not worth making.
    cluster = _alert(conn, stats.CLUSTER_KIND, ticker="PG", direction="sell", window_days=90, count=3)
    assert xpost.compose(conn, cluster, Config()) is None


# --- signing and sending --------------------------------------------------------


def test_oauth_signature_matches_xs_documented_example():
    # developer.x.com "Creating a signature": the body parameters of that example
    # are passed as query parameters here, which sign identically.
    creds = xpost.Credentials("xvz1evFS4wEEPTGEFPHBog", "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw",
                              "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
                              "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE")
    url = ("https://api.twitter.com/1.1/statuses/update.json?include_entities=true"
           "&status=Hello%20Ladies%20%2B%20Gentlemen%2C%20a%20signed%20OAuth%20request%21")
    header = xpost.oauth_header("POST", url, creds, nonce="kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg",
                                timestamp="1318622958")
    assert 'oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D"' in header


def test_send_post_sends_json_and_returns_the_id():
    seen = {}

    def handler(request: httpx.Request):
        seen["auth"] = request.headers["Authorization"]
        seen["body"] = request.content
        return httpx.Response(201, json={"data": {"id": "1855", "text": "hi"}})

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        assert xpost.send_post(CREDS, "hi", client) == "1855"
    assert seen["auth"].startswith("OAuth ") and seen["body"] == b'{"text":"hi"}'

    with httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(429, text="Too Many"))) as client:
        with pytest.raises(xpost.XError) as limited:
            xpost.send_post(CREDS, "hi", client)
    assert limited.value.stops_run


# --- the step -----------------------------------------------------------------


def _three_clusters(conn):
    return [_alert(conn, stats.CLUSTER_KIND, ticker=t, direction="buy", window_days=90, count=3)
            for t in ("AAA", "BBB", "CCC")]


def _x_rows(conn):
    return {r["alert_id"]: dict(r) for r in conn.execute("SELECT * FROM x_posts")}


def test_each_alert_is_posted_once_oldest_first(conn):
    alerts = _three_clusters(conn)
    sent = []
    result = xpost.sync(conn, _config(), send=lambda creds, text: sent.append(text) or f"id{len(sent)}")
    assert result.posted == 3 and [t.split()[6] for t in sent] == ["$AAA", "$BBB", "$CCC"]
    assert _x_rows(conn)[alerts[0]["id"]]["post_id"] == "id1"
    assert xpost.sync(conn, _config(), send=lambda *a: pytest.fail("posted twice")).posted == 0


def test_a_dry_run_composes_the_posts_and_records_nothing(conn):
    _three_clusters(conn)
    result = xpost.sync(conn, Config(dashboard_url=BASE), dry_run=True,
                        send=lambda *a: pytest.fail("a dry run posted"))
    assert len(result.previews) == 3 and _x_rows(conn) == {}


def test_a_failed_post_is_retried_next_run_and_a_rate_limit_stops_the_run(conn):
    alerts = _three_clusters(conn)

    def flaky(creds, text):
        if "$AAA" in text:
            raise xpost.XError("HTTP 503: busy", 503)
        if "$BBB" in text:
            raise xpost.XError("HTTP 429: Too Many Requests", 429)
        return "ok"

    result = xpost.sync(conn, _config(), send=flaky)
    assert (result.posted, result.failed, result.left) == (0, 2, 1)
    rows = _x_rows(conn)
    assert rows[alerts[0]["id"]]["status"] == "failed" and alerts[2]["id"] not in rows
    result = xpost.sync(conn, _config(), send=lambda *a: "ok")
    assert result.posted == 3
    assert _x_rows(conn)[alerts[0]["id"]]["attempts"] == 2


def test_posts_per_run_are_capped_and_the_rest_wait(conn):
    _three_clusters(conn)
    result = xpost.sync(conn, _config(max_per_run=2), send=lambda *a: "ok")
    assert (result.posted, result.left) == (2, 1)
    assert xpost.sync(conn, _config(max_per_run=2), send=lambda *a: "ok").posted == 1


def test_old_alerts_are_not_posted(conn):
    _three_clusters(conn)
    later = datetime.now(timezone.utc) + timedelta(hours=25)
    assert xpost.sync(conn, _config(), send=lambda *a: pytest.fail("old news"), now=later).posted == 0


def test_without_credentials_nothing_is_posted_or_recorded(conn):
    _three_clusters(conn)
    result = xpost.sync(conn, Config(dashboard_url=BASE, x=XSettings(enabled=True)),
                        send=lambda *a: pytest.fail("posted without credentials"))
    assert result.stopped and _x_rows(conn) == {}


def test_an_alert_the_feed_does_not_carry_is_set_aside_once(conn):
    alert = _alert(conn, stats.FILING_KIND)  # no filing: nothing to say
    result = xpost.sync(conn, _config(), send=lambda *a: pytest.fail("posted"))
    assert result.skipped == 1 and _x_rows(conn)[alert["id"]]["status"] == "skipped"
    assert xpost.sync(conn, _config(), send=lambda *a: pytest.fail("posted")).skipped == 0


def test_the_pipeline_step_is_off_by_default_and_never_raises(conn, monkeypatch):
    calls = []
    monkeypatch.setattr(xpost, "sync", lambda *a, **k: calls.append(1) or (_ for _ in ()).throw(RuntimeError("x down")))
    pipeline._post_to_x(conn, Config())  # x.enabled defaults to false
    assert calls == []
    pipeline._post_to_x(conn, _config())  # raises inside; the run carries on
    assert calls == [1]


# --- config -------------------------------------------------------------------


def test_x_settings_are_validated():
    assert _parse_x(None) == XSettings(enabled=False, max_age_hours=24, max_per_run=5)
    assert _parse_x({"enabled": True, "max_per_run": 3}).max_per_run == 3
    with pytest.raises(ConfigError):
        _parse_x({"enabeld": True})
    with pytest.raises(ConfigError):
        _parse_x({"enabled": "false"})
    with pytest.raises(ConfigError):
        _parse_x({"max_per_run": 0})
    with pytest.raises(ConfigError):
        _parse_x({"max_age_hours": 0})


def test_a_fresh_database_has_the_x_posts_table(conn):
    assert conn.execute("PRAGMA user_version").fetchone()[0] == db.SCHEMA_VERSION == 18
    assert conn.execute("SELECT COUNT(*) FROM x_posts").fetchone()[0] == 0
