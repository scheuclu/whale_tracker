"""Industry classification from EDGAR SIC codes (#55).

The mapping is a pure function; the fill runs against a real EdgarClient
over an httpx.MockTransport serving trimmed copies of EDGAR's
`company_tickers.json` and two `submissions/CIK##########.json` documents,
so the 404, throttle and malformed-response paths are the production ones.
No test here reaches the network.
"""

import json
from datetime import date, timedelta
from pathlib import Path

import httpx
import pytest

from whale import db, edgar, issuers, pipeline
from whale.config import Config, ConfigError, IssuerSettings, _refresh_days
from whale.issuers import sic_group

FIXTURES = Path(__file__).parent / "fixtures"
LISTING = (FIXTURES / "company_tickers.json").read_text()
APPLE, AFLAC, SPDR = "0000320193", "0000004977", "0000884394"
BERKSHIRE = "0001067983"
GHOST = "0000999999"  # an insider filing's issuer EDGAR has no record for
TODAY = date(2026, 10, 18)


# --- the mapping -------------------------------------------------------------


@pytest.mark.parametrize("sic, group", [
    ("3571", "Technology"),          # Apple: electronic computers
    ("7372", "Technology"),          # prepackaged software
    ("7370", "Technology"),          # Alphabet, Meta: computer programming, data processing
    ("3674", "Technology"),          # semiconductors
    ("7389", "Industrials"),         # business services, n.e.c. — not the software carve-out
    ("2834", "Health care"),         # pharmaceutical preparations
    ("2836", "Health care"),         # biological products
    ("8731", "Health care"),         # commercial research: where EDGAR files biotech
    ("3841", "Health care"),         # surgical instruments
    ("2800", "Materials"),           # chemicals, outside the drug carve-out
    ("2844", "Consumer staples"),    # cosmetics, inside it
    ("6321", "Financials"),          # AFLAC: accident and health insurance
    ("6770", "Financials"),          # blank checks
    ("6798", "Real estate"),         # REITs
    ("6500", "Real estate"),
    ("6510", "Real estate"),
    ("1311", "Energy"),              # crude petroleum and natural gas
    ("2911", "Energy"),              # petroleum refining
    ("4610", "Energy"),              # pipelines
    ("4813", "Communication"),       # telephone
    ("2711", "Communication"),       # newspapers
    ("7812", "Communication"),       # motion pictures
    ("4911", "Utilities"),
    ("4922", "Utilities"),
    ("5912", "Consumer staples"),    # drug stores, inside retail
    ("5331", "Consumer discretionary"),  # variety stores
    ("3711", "Consumer discretionary"),  # motor vehicles, inside the transport-equipment division
    ("3721", "Industrials"),         # aircraft
    ("4512", "Industrials"),         # air transport
    ("1040", "Materials"),           # gold ores
    ("100", "Consumer staples"),     # agricultural production — EDGAR drops the leading zero
    ("9995", "Other"),               # non-operating establishments
    ("9999", "Other"),
])
def test_sic_codes_fold_into_the_documented_groups(sic, group):
    assert sic_group(sic) == group
    assert group in issuers.GROUPS


@pytest.mark.parametrize("sic", [None, "", "   ", "n/a", "abc"])
def test_no_code_is_unknown_not_other(sic):
    # An ETF trust has no SIC at all. That is unknown, and stays unknown.
    assert sic_group(sic) is None


def test_integer_codes_are_accepted():
    assert sic_group(3571) == "Technology"


def test_every_range_is_well_formed():
    for low, high, group in issuers._SIC_RANGES:
        assert low <= high, (low, high)
        assert group in issuers.GROUPS, group
    # Every four-digit code lands somewhere in the twelve groups.
    assert {sic_group(str(code)) for code in range(100, 10000)} <= set(issuers.GROUPS)


# --- scripted EDGAR ----------------------------------------------------------


class Edgar:
    """EDGAR's listing and submissions documents by URL, through the real client."""

    def __init__(self, listing: str | None = LISTING):
        self.routes: dict[str, object] = {}
        self.requests: list[str] = []
        if listing is not None:
            self.routes[issuers.COMPANY_TICKERS_URL] = listing
        self.client = edgar.EdgarClient("whale-tracker test@example.com",
                                        transport=httpx.MockTransport(self._handle),
                                        sleep=lambda s: None, clock=lambda: 0.0)

    def submissions(self, cik: str, body):
        self.routes[issuers.SUBMISSIONS_URL.format(cik=cik)] = body
        return self

    def fixture(self, cik: str):
        return self.submissions(cik, (FIXTURES / f"submissions_CIK{cik}.json").read_text())

    def _handle(self, request):
        url = str(request.url)
        self.requests.append(url)
        route = self.routes.get(url)
        if route is None:
            return httpx.Response(404, text="not found")
        if isinstance(route, Exception):
            raise route
        if isinstance(route, httpx.Response):
            return route
        return httpx.Response(200, text=route, headers={"content-type": "application/json"})

    @property
    def submission_fetches(self) -> list[str]:
        return [u for u in self.requests if "/submissions/" in u]


def _sec() -> Edgar:
    return (Edgar().fixture(APPLE).fixture(AFLAC).fixture(SPDR)
            .submissions(BERKSHIRE, json.dumps({
                "cik": "1067983", "sic": "6331", "sicDescription": "Fire, Marine & Casualty Insurance",
                "name": "BERKSHIRE HATHAWAY INC", "tickers": ["BRK-B", "BRK-A"]})))


def _config(**overrides) -> Config:
    config = Config(edgar_user_agent="whale-tracker test@example.com",
                    issuers=IssuerSettings(budget_seconds=90, refresh_days=7))
    for key, value in overrides.items():
        setattr(config.issuers, key, value)
    return config


@pytest.fixture
def conn(tmp_path):
    c = db.connect(tmp_path / "t.sqlite3")
    yield c
    c.close()


def _seed(conn) -> None:
    """A member's trades in four symbols, and Form 4 filings by two issuers."""
    fid = db.insert_filing(conn, chamber="house", doc_id="d1", filer_name="Some Member",
                           filing_type="P", filing_date="2026-10-01", year=2026,
                           pdf_url="http://x/d1.pdf", status="backfilled")
    db.replace_transactions(conn, fid, None, [
        {"asset_name": "Apple Inc.", "ticker": "AAPL", "asset_type": "ST", "action": "purchase",
         "tx_date": "2026-09-20", "amount_min_cents": 100_100, "amount_max_cents": 1_500_000},
        {"asset_name": "Berkshire Hathaway Class B", "ticker": "BRK.B", "asset_type": "ST",
         "action": "sale", "tx_date": "2026-09-21", "amount_min_cents": 1_500_100,
         "amount_max_cents": 5_000_000},
        {"asset_name": "SPDR S&P 500 ETF", "ticker": "SPY", "asset_type": "EF",
         "action": "purchase", "tx_date": "2026-09-22", "amount_min_cents": 100_100,
         "amount_max_cents": 1_500_000},
        {"asset_name": "Something Delisted", "ticker": "ZZZZ", "asset_type": "ST",
         "action": "purchase", "tx_date": "2026-09-23", "amount_min_cents": 100_100,
         "amount_max_cents": 1_500_000},
    ])
    for acc, cik, name, ticker in (
        ("0001104659-26-107065", AFLAC, "AFLAC INC", "AFL"),
        ("0001104659-26-107066", GHOST, "Ghost Holdings", None),
    ):
        db.insert_insider_filing(conn, accession=acc, form_type="4", issuer_cik=cik,
                                 issuer_name=name, ticker=ticker, filing_date="2026-09-11",
                                 source="feed", source_url="u", status="backfilled")
    conn.commit()


def _tickers(conn) -> dict[str, str | None]:
    return {r["ticker"]: r["cik"] for r in conn.execute("SELECT ticker, cik FROM issuer_tickers")}


def _issuers(conn) -> dict[str, tuple]:
    return {r["cik"]: (r["industry_group"], r["sic"], r["name"], r["last_error"])
            for r in conn.execute("SELECT * FROM issuers")}


# --- the fill ----------------------------------------------------------------


def test_fill_resolves_symbols_and_classifies_every_issuer(conn):
    _seed(conn)
    sec = _sec()
    result = issuers.classify(conn, _config(), client=sec.client, today=TODAY)

    assert result.aborted is None
    assert (result.looked_up, result.unresolved) == (4, 1)
    # Three resolved congressional symbols, the Form 4 issuer, and the ghost.
    assert (result.fetched, result.failed, result.remaining) == (4, 1, 0)
    assert _tickers(conn) == {
        "AAPL": APPLE, "BRK.B": BERKSHIRE, "SPY": SPDR, "ZZZZ": None,
        "AFL": AFLAC,  # seeded from the Form 4, no lookup needed
    }
    stored = _issuers(conn)
    assert stored[APPLE] == ("Technology", "3571", "Apple Inc.", None)
    assert stored[BERKSHIRE] == ("Financials", "6331", "BERKSHIRE HATHAWAY INC", None)
    assert stored[AFLAC] == ("Financials", "6321", "AFLAC INC", None)
    # An ETF trust has no SIC: unknown stays unknown, and is still recorded
    # as fetched so it is not asked about every run.
    assert stored[SPDR] == (None, None, "SPDR S&P 500 ETF TRUST", None)
    assert stored[GHOST][0] is None and "404" in stored[GHOST][3]
    assert db.get_state(conn, issuers.STATE_STATUS) == "ok: 4 fetched, 1 failed, 0 to go"
    # One listing request, one submissions request per issuer, nothing else.
    assert sec.requests.count(issuers.COMPANY_TICKERS_URL) == 1
    assert len(sec.submission_fetches) == 5


def test_edgar_symbol_form_is_tried_both_ways():
    listing = {"BRK-B": BERKSHIRE, "GEF.B": "0000043920"}
    assert issuers.resolve_symbol(listing, "BRK.B") == BERKSHIRE
    assert issuers.resolve_symbol(listing, "brk-b") == BERKSHIRE
    assert issuers.resolve_symbol(listing, "GEF-B") == "0000043920"
    assert issuers.resolve_symbol(listing, "NOPE") is None


def test_listing_is_parsed_into_padded_ciks():
    sec = Edgar()
    listing = issuers.fetch_company_tickers(sec.client)
    assert listing["AAPL"] == APPLE
    assert listing["BRK-A"] == listing["BRK-B"] == BERKSHIRE


def test_nothing_is_fetched_again_before_the_refresh(conn):
    _seed(conn)
    sec = _sec()
    issuers.classify(conn, _config(), client=sec.client, today=TODAY)
    before = len(sec.requests)

    again = issuers.classify(conn, _config(), client=sec.client, today=TODAY + timedelta(days=6))
    assert (again.looked_up, again.fetched, again.failed) == (0, 0, 0)
    assert len(sec.requests) == before  # not even the listing: no symbol was pending
    assert db.get_state(conn, issuers.STATE_STATUS) == "ok: 0 fetched, 0 failed, 0 to go"


def test_weekly_refresh_refetches_and_retries_unknown_symbols(conn):
    _seed(conn)
    sec = _sec()
    issuers.classify(conn, _config(), client=sec.client, today=TODAY)
    sec.requests.clear()
    # ZZZZ listed since; the ghost issuer now exists.
    sec.routes[issuers.COMPANY_TICKERS_URL] = json.dumps({
        **json.loads(LISTING), "7": {"cik_str": 999998, "ticker": "ZZZZ", "title": "Zed Corp"}})
    sec.submissions("0000999998", json.dumps({"sic": "4911", "sicDescription": "Electric Services",
                                              "name": "Zed Corp", "tickers": ["ZZZZ"]}))
    sec.submissions(GHOST, json.dumps({"sic": "6798", "sicDescription": "Real Estate Investment Trusts",
                                       "name": "Ghost Holdings", "tickers": []}))

    result = issuers.classify(conn, _config(), client=sec.client, today=TODAY + timedelta(days=8))
    assert (result.looked_up, result.unresolved) == (1, 0)
    assert result.fetched == 6 and result.failed == 0
    assert _tickers(conn)["ZZZZ"] == "0000999998"
    assert _issuers(conn)["0000999998"][0] == "Utilities"
    assert _issuers(conn)[GHOST] == ("Real estate", "6798", "Ghost Holdings", None)
    assert sec.requests.count(issuers.COMPANY_TICKERS_URL) == 1


def test_never_fetched_issuers_come_before_stale_ones(conn):
    _seed(conn)
    sec = _sec()
    issuers.classify(conn, _config(), client=sec.client, today=TODAY)
    # A new Form 4 issuer arrives; on refresh day it must be fetched first.
    db.insert_insider_filing(conn, accession="0001104659-26-200000", form_type="4",
                             issuer_cik="0000777777", issuer_name="New Co", ticker="NEWC",
                             filing_date="2026-10-20", source="feed", source_url="u",
                             status="backfilled")
    conn.commit()
    sec.submissions("0000777777", json.dumps({"sic": "2834", "name": "New Co", "tickers": ["NEWC"]}))
    sec.requests.clear()

    clock = _Clock()
    # The budget allows exactly one fetch before the clock runs out.
    result = issuers.classify(conn, _config(budget_seconds=1), client=sec.client,
                              today=TODAY + timedelta(days=8), clock=clock)
    assert result.fetched == 1 and result.aborted == "budget"
    assert sec.submission_fetches == [issuers.SUBMISSIONS_URL.format(cik="0000777777")]
    assert _issuers(conn)["0000777777"][0] == "Health care"


class _Clock:
    """One second passes per read. The budget is checked before each fetch,
    so a one-second budget allows exactly one: the first check reads one
    second elapsed (not over), the second reads two."""

    def __init__(self):
        self.now = 0.0

    def __call__(self):
        self.now += 1.0
        return self.now


def test_budget_stops_the_fill_and_the_next_run_continues(conn):
    _seed(conn)
    sec = _sec()
    result = issuers.classify(conn, _config(budget_seconds=1), client=sec.client,
                              today=TODAY, clock=_Clock())
    assert result.aborted == "budget"
    assert result.fetched == 1 and result.remaining == 4
    assert db.get_state(conn, issuers.STATE_STATUS) == (
        "ok: 1 fetched, 0 failed, 4 to go (out of time; continuing next run)")
    # Symbols were all resolved before the budget was spent — one request.
    assert set(_tickers(conn)) == {"AAPL", "BRK.B", "SPY", "ZZZZ", "AFL"}

    rest = issuers.classify(conn, _config(), client=sec.client, today=TODAY)
    assert rest.aborted is None and rest.fetched == 3 and rest.failed == 1
    assert len(_issuers(conn)) == 5


def test_throttle_stops_the_fill_and_keeps_what_was_stored(conn):
    _seed(conn)
    sec = _sec()
    sec.submissions(AFLAC, httpx.Response(
        403, text="<html>Request Rate Threshold Exceeded</html>",
        headers={"content-type": "text/html"}))
    result = issuers.classify(conn, _config(), client=sec.client, today=TODAY)

    assert result.aborted and result.aborted.startswith("throttled")
    status = db.get_state(conn, issuers.STATE_STATUS)
    assert status.startswith("throttled:") and "still to fetch" in status
    # Fetched oldest CIK first (AFLAC is 0000004977), so nothing before it;
    # the throttle hit on the first submissions request.
    assert result.fetched == 0 and result.remaining == 5
    assert all(r[3] is None for r in _issuers(conn).values())


def test_throttled_listing_is_recorded_not_raised(conn):
    _seed(conn)
    sec = Edgar(listing=None)
    sec.routes[issuers.COMPANY_TICKERS_URL] = httpx.Response(
        429, text="slow down", headers={"retry-after": "1"})
    result = issuers.classify(conn, _config(), client=sec.client, today=TODAY)
    assert result.aborted.startswith("throttled")
    assert db.get_state(conn, issuers.STATE_STATUS).startswith("throttled:")
    assert _tickers(conn) == {"AFL": AFLAC}  # the Form 4 seed needs no listing


def test_malformed_document_is_recorded_on_the_row_and_the_fill_goes_on(conn):
    _seed(conn)
    sec = _sec().submissions(APPLE, "<html>not json</html>")
    result = issuers.classify(conn, _config(), client=sec.client, today=TODAY)
    assert result.aborted is None
    assert (result.fetched, result.failed) == (3, 2)
    group, sic, name, error = _issuers(conn)[APPLE]
    assert group is None and error and "JSONDecodeError" in error
    assert _issuers(conn)[BERKSHIRE][0] == "Financials"


def test_a_failed_refresh_keeps_the_earlier_classification(conn):
    _seed(conn)
    sec = _sec()
    issuers.classify(conn, _config(), client=sec.client, today=TODAY)
    sec.submissions(APPLE, httpx.Response(500, text="boom"))
    result = issuers.classify(conn, _config(), client=sec.client, today=TODAY + timedelta(days=8))
    assert result.aborted.startswith("error")
    # Apple is the first stale row EDGAR failed on: still Technology.
    assert _issuers(conn)[APPLE][0] == "Technology"


def test_without_a_user_agent_the_step_skips_itself(conn):
    _seed(conn)
    sec = _sec()
    config = Config()  # no EDGAR_USER_AGENT
    result = issuers.classify(conn, config, client=sec.client, today=TODAY)
    assert result.fetched == 0 and sec.requests == []
    assert db.get_state(conn, issuers.STATE_STATUS) == "skipped: EDGAR_USER_AGENT not set"


# --- the pipeline step -------------------------------------------------------


def test_pipeline_step_never_raises(conn):
    _seed(conn)
    sec = Edgar(listing=None)
    sec.routes[issuers.COMPANY_TICKERS_URL] = RuntimeError("transport exploded")
    pipeline._classify_issuers(conn, _config(), client=sec.client, today=TODAY)
    assert db.get_state(conn, issuers.STATE_STATUS).startswith("error: transport exploded")


def test_pipeline_step_is_off_at_zero_budget(conn):
    _seed(conn)
    sec = _sec()
    pipeline._classify_issuers(conn, _config(budget_seconds=0), client=sec.client, today=TODAY)
    assert sec.requests == []
    assert db.get_state(conn, issuers.STATE_STATUS) is None


def test_pipeline_runs_the_step_last(monkeypatch, tmp_path):
    order = []
    for name in ("sync", "retry_scanned", "parse_pending", "notify_pending",
                 "notify_clusters", "_sync_insiders", "notify_insiders", "_classify_issuers"):
        # The real steps return a count for the run log (#63); the stubs must too.
        monkeypatch.setattr(pipeline, name, lambda *a, _n=name, **k: order.append(_n) or 0)
    pipeline.run(Config(db_path=tmp_path / "t.sqlite3"))
    assert order[-2:] == ["notify_insiders", "_classify_issuers"]


# --- config ------------------------------------------------------------------


def test_refresh_days_must_be_at_least_one():
    assert _refresh_days(7) == 7
    with pytest.raises(ConfigError):
        _refresh_days(0)
    with pytest.raises(ConfigError):
        _refresh_days("weekly")


def test_committed_config_loads_the_issuer_block():
    from whale.config import load_config

    config = load_config()
    assert config.issuers.budget_seconds == 90
    assert config.issuers.refresh_days == 7


# --- schema ------------------------------------------------------------------


def test_version_8_database_gains_the_issuer_tables_in_place(tmp_path):
    path = tmp_path / "v8.sqlite3"
    conn = db.connect(path)
    conn.execute("INSERT INTO politicians (bioguide_id, full_name, updated_at) VALUES ('X1', 'M', 't')")
    conn.executescript("DROP TABLE issuer_tickers; DROP TABLE issuers; PRAGMA user_version = 8;")
    conn.commit()
    conn.close()

    conn = db.connect(path)
    assert conn.execute("PRAGMA user_version").fetchone()[0] == db.SCHEMA_VERSION
    tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    assert {"issuers", "issuer_tickers"} <= tables
    assert conn.execute("SELECT full_name FROM politicians").fetchone()[0] == "M"
    conn.close()


def test_upsert_issuer_error_does_not_blank_a_classification(conn):
    db.upsert_issuer(conn, APPLE, ticker="AAPL", name="Apple Inc.", sic="3571",
                     sic_description="Electronic Computers", industry_group="Technology")
    db.upsert_issuer(conn, APPLE, error="HTTP 500")
    row = conn.execute("SELECT * FROM issuers WHERE cik = ?", (APPLE,)).fetchone()
    assert (row["industry_group"], row["sic"], row["last_error"]) == ("Technology", "3571", "HTTP 500")
    db.upsert_issuer(conn, APPLE, ticker="AAPL", name="Apple Inc.", sic="3571",
                     sic_description="Electronic Computers", industry_group="Technology")
    assert conn.execute("SELECT last_error FROM issuers WHERE cik = ?", (APPLE,)).fetchone()[0] is None


# --- CLI ---------------------------------------------------------------------


def test_cli_command_runs_without_a_user_agent_and_touches_no_network(monkeypatch, tmp_path, capsys):
    from whale import __main__ as cli

    monkeypatch.setattr(cli, "load_config", lambda: Config(db_path=tmp_path / "t.sqlite3"))
    assert cli.main(["classify-issuers", "--budget-seconds", "5"]) == 0
    out = capsys.readouterr().out
    assert out.startswith("issuers: 0 issuer(s) fetched")
    conn = db.connect(tmp_path / "t.sqlite3")
    assert db.get_state(conn, issuers.STATE_STATUS) == "skipped: EDGAR_USER_AGENT not set"
    conn.close()
