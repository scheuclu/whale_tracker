"""Senate filings through the pipeline (#40).

Queueing in `_sync_senate` follows the House rules (the age cutoff, the
watchlist's exemption from it), `parse_pending` routes Senate filings to the
eFD parser without touching the House path, paper filings take the House
scan's path without a fetch, `backfill` loads the rows indexed before the
parser existed, and the roster resolves eFD's name forms. Every network
touch is replaced by canned pages: nothing here reaches efdsearch.senate.gov.
"""

import logging
from datetime import date
from pathlib import Path

import httpx
import pytest

from whale import db, pipeline, roster, senate, telegram
from whale.config import Config, WatchedMember, WatchlistSettings

TODAY = date(2026, 10, 17)
RECENT = "10/15/2026"    # 2 days old: inside the 14-day default
OLD = "09/20/2026"       # 27 days old: outside it
FIXTURES = Path(__file__).parent / "fixtures"
PTR_URL = "https://efdsearch.senate.gov/search/view/ptr/{}/"
PAPER_URL = "https://efdsearch.senate.gov/search/view/paper/{}/"


@pytest.fixture
def conn(tmp_path):
    c = db.connect(tmp_path / "t.sqlite3")
    yield c
    c.close()


def _page(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def _senator(conn, bioguide="T000278", name="Tommy Tuberville", first="Tommy",
             last="Tuberville", state="AL", party="R"):
    return db.upsert_politician(conn, bioguide_id=bioguide, full_name=name, first=first,
                                last=last, chamber="senate", party=party, state=state,
                                district=None, active=1)


def _efd(doc_id, filed, first="Thomas H", last="Tuberville", paper=False):
    url = (PAPER_URL if paper else PTR_URL).format(doc_id)
    return senate.SenateFiling(doc_id=doc_id, first=first, last=last,
                               office=f"{last}, {first} (Senator)",
                               report_type="Periodic Transaction Report",
                               filed_date=filed, url=url)


def _sync(conn, config, filings, monkeypatch):
    monkeypatch.setattr(senate, "fetch_ptrs", lambda *a, **k: list(filings))
    return pipeline._sync_senate(conn, config, today=TODAY)


def _rows(conn):
    return {r["doc_id"]: dict(r) for r in conn.execute(
        "SELECT * FROM filings WHERE chamber = 'senate'")}


def _filing(conn, doc_id, status="new", url=None, politician_id=None,
            filing_date="2026-10-15", year=2026, filer_name="Thomas H Tuberville"):
    return db.insert_filing(
        conn, chamber="senate", doc_id=doc_id, politician_id=politician_id,
        filer_name=filer_name, state_district=None, filing_type="P",
        filing_date=filing_date, year=year, pdf_url=url or PTR_URL.format(doc_id),
        status=status)


class FakeSession:
    """Stands in for `senate.Session`: canned pages, no network."""

    def __init__(self, pages, fail_open=None):
        self.pages = pages
        self.fail_open = fail_open
        self.requests: list[str] = []
        self.closed = False

    def open(self):
        if self.fail_open is not None:
            raise self.fail_open

    def close(self):
        self.closed = True

    def get_report(self, url):
        self.requests.append(url)
        page = self.pages[url]
        if isinstance(page, Exception):
            raise page
        return page


def _sessions(monkeypatch, pages, fail_open=None):
    made = []

    def factory(proxy_url=None, **kwargs):
        session = FakeSession(pages, fail_open)
        made.append(session)
        return session

    monkeypatch.setattr(senate, "Session", factory)
    return made


# --- sync: queueing follows the House rules -------------------------------------


def test_recent_filing_queues_as_new_and_old_as_history(conn, monkeypatch):
    _senator(conn)
    conn.commit()
    queued = _sync(conn, Config(), [_efd("a", RECENT), _efd("b", OLD)], monkeypatch)
    rows = _rows(conn)
    assert queued == 1
    assert rows["a"]["status"] == "new"
    assert rows["b"]["status"] == "seen_skipped"
    assert db.get_state(conn, "senate_status") == "ok: 2 filings seen"


def test_dates_are_stored_iso_with_the_year_and_state_filled(conn, monkeypatch):
    _senator(conn)
    conn.commit()
    _sync(conn, Config(), [_efd("a", RECENT)], monkeypatch)
    row = _rows(conn)["a"]
    assert row["filing_date"] == "2026-10-15"
    assert row["year"] == 2026
    assert row["state_district"] == "AL"
    assert row["filer_name"] == "Thomas H Tuberville"
    assert row["pdf_url"] == PTR_URL.format("a")


def test_filer_is_resolved_through_the_roster(conn, monkeypatch):
    pid = _senator(conn)
    conn.commit()
    _sync(conn, Config(), [_efd("a", RECENT)], monkeypatch)
    assert _rows(conn)["a"]["politician_id"] == pid


def test_unmatched_filer_is_still_recorded(conn, monkeypatch):
    _sync(conn, Config(), [_efd("a", RECENT, first="Nobody", last="Known")], monkeypatch)
    row = _rows(conn)["a"]
    assert row["politician_id"] is None
    assert row["state_district"] is None
    assert row["status"] == "new"


def test_watched_senator_bypasses_the_age_cutoff(conn, monkeypatch):
    _senator(conn)
    conn.commit()
    config = Config()
    config.watchlist = WatchlistSettings(
        members=[WatchedMember(name="Tommy Tuberville", bioguide_id="T000278")])
    _sync(conn, config, [_efd("a", OLD)], monkeypatch)
    assert _rows(conn)["a"]["status"] == "new"


def test_watchlist_name_fallback_applies_to_an_unmatched_senator(conn, monkeypatch):
    config = Config()
    config.watchlist = WatchlistSettings(members=[WatchedMember(name="Nobody Known")])
    _sync(conn, config, [_efd("a", OLD, first="Nobody", last="Known")], monkeypatch)
    assert _rows(conn)["a"]["status"] == "new"


def test_a_known_filing_is_not_reinserted(conn, monkeypatch):
    _senator(conn)
    conn.commit()
    _sync(conn, Config(), [_efd("a", RECENT)], monkeypatch)
    db.set_status(conn, _rows(conn)["a"]["id"], "notified")
    conn.commit()
    _sync(conn, Config(), [_efd("a", RECENT)], monkeypatch)
    assert _rows(conn)["a"]["status"] == "notified"


def test_a_late_listing_after_first_sight_is_logged(conn, monkeypatch, caplog):
    _senator(conn)
    conn.commit()
    with caplog.at_level(logging.WARNING, logger="whale.pipeline"):
        _sync(conn, Config(), [_efd("a", OLD)], monkeypatch)
    assert "older than" not in caplog.text         # first sight: history, by design
    with caplog.at_level(logging.WARNING, logger="whale.pipeline"):
        _sync(conn, Config(), [_efd("a", OLD), _efd("b", OLD)], monkeypatch)
    assert "senate filing b (Thomas H Tuberville, filed 2026-09-20) is older than 14 days" \
        in caplog.text
    assert _rows(conn)["b"]["status"] == "seen_skipped"


def test_a_block_or_error_records_the_status_and_queues_nothing(conn, monkeypatch):
    monkeypatch.setattr(senate, "fetch_ptrs",
                        lambda *a, **k: (_ for _ in ()).throw(senate.SenateBlocked("403")))
    assert pipeline._sync_senate(conn, Config(), today=TODAY) == 0
    assert db.get_state(conn, "senate_status") == "blocked: 403"
    assert _rows(conn) == {}


def test_sync_counts_senate_filings_into_the_run_total(conn, monkeypatch):
    from whale import house

    _senator(conn)
    conn.commit()
    monkeypatch.setattr(roster, "sync", lambda c: None)
    monkeypatch.setattr(house, "fetch_index", lambda year: [])
    monkeypatch.setattr(senate, "fetch_ptrs", lambda *a, **k: [_efd("a", RECENT)])
    real = house.is_recent
    monkeypatch.setattr(house, "is_recent",
                        lambda d, age, today=None: real(d, age, today=TODAY))
    assert pipeline.sync(conn, Config()) == 1


# --- the rows indexed before the parser existed ------------------------------------


def test_legacy_rows_are_normalised_on_sync_and_only_once(conn, monkeypatch):
    pid = _senator(conn)
    _filing(conn, "legacy", status="seen_skipped", politician_id=pid,
            filing_date="10/07/2026", year=0)
    conn.commit()
    _sync(conn, Config(), [], monkeypatch)
    row = _rows(conn)["legacy"]
    assert (row["filing_date"], row["year"], row["state_district"]) == ("2026-10-07", 2026, "AL")
    assert row["status"] == "seen_skipped"
    assert pipeline._normalise_senate_rows(conn) == 0


def test_an_unparseable_legacy_date_is_left_as_filed(conn, monkeypatch):
    _filing(conn, "odd", status="seen_skipped", filing_date="13/45/2026", year=0)
    conn.commit()
    assert pipeline._normalise_senate_rows(conn) == 0
    assert _rows(conn)["odd"]["filing_date"] == "13/45/2026"


# --- parse_pending: eFD pages, not PDFs ------------------------------------------


def test_electronic_filing_is_parsed_from_the_report_page(conn, monkeypatch):
    pid = _senator(conn, bioguide="C000127", name="Maria Cantwell", first="Maria",
                   last="Cantwell", state="WA", party="D")
    fid = _filing(conn, "e1", politician_id=pid, filer_name="Maria Cantwell")
    conn.commit()
    made = _sessions(monkeypatch, {PTR_URL.format("e1"): _page("efd_ptr_cantwell_2016-05-11.html")})

    assert pipeline.parse_pending(conn, Config()) == 1
    row = _rows(conn)["e1"]
    assert (row["status"], row["parse_method"], row["last_error"]) == ("parsed", "efd_html", None)
    [tx] = db.transactions_for_filing(conn, fid)
    assert tx["politician_id"] == pid
    assert (tx["tx_date"], tx["owner"], tx["ticker"], tx["asset_type"], tx["action"]) == \
        ("2016-04-28", None, "RNWK", "ST", "sale_partial")
    assert (tx["amount_min_cents"], tx["amount_max_cents"], tx["amount_exact_cents"]) == \
        (100_100, 1_500_000, None)
    assert tx["description"] == "Sale of two blocks"
    assert tx["notification_date"] is None and tx["cap_gains_over_200"] is None
    assert made[0].closed


def test_parse_pending_does_not_touch_the_house_path(conn, monkeypatch):
    # No Senate filings queued: no session is ever constructed.
    made = _sessions(monkeypatch, {})
    db.insert_filing(conn, chamber="house", doc_id="h1", politician_id=None,
                     filer_name="Some Rep", state_district="CA01", filing_type="P",
                     filing_date="2026-10-15", year=2026, pdf_url="http://clerk/h1.pdf",
                     status="new")
    conn.commit()
    from whale import house
    monkeypatch.setattr(house, "fetch_pdf", lambda url: (_ for _ in ()).throw(OSError("down")))
    assert pipeline.parse_pending(conn, Config()) == 0
    assert made == []


def test_paper_filing_is_failed_without_a_fetch(conn, monkeypatch):
    _filing(conn, "p1", url=PAPER_URL.format("p1"))
    conn.commit()
    made = _sessions(monkeypatch, {})
    assert pipeline.parse_pending(conn, Config()) == 0
    row = _rows(conn)["p1"]
    assert (row["status"], row["parse_method"]) == ("failed", "efd_paper")
    assert "paper filing" in row["last_error"]
    assert row["notified_at"] is None
    assert made == []


def test_a_refused_session_leaves_everything_queued(conn, monkeypatch):
    _filing(conn, "e1")
    _filing(conn, "e2")
    conn.commit()
    _sessions(monkeypatch, {}, fail_open=senate.SenateBlocked("403 on home"))
    assert pipeline.parse_pending(conn, Config()) == 0
    assert {r["status"] for r in _rows(conn).values()} == {"new"}


def test_paper_filings_are_classified_even_when_efd_refuses(conn, monkeypatch):
    # Observed on the first replay: the paper rows sorted after an electronic
    # one and were never reached once the session was refused. Classifying
    # them needs no network, so eFD's mood must not delay it.
    _filing(conn, "e1", filing_date="2026-10-14")
    _filing(conn, "p1", filing_date="2026-10-15", url=PAPER_URL.format("p1"))
    conn.commit()
    _sessions(monkeypatch, {}, fail_open=senate.SenateBlocked("403 on home"))
    assert pipeline.parse_pending(conn, Config()) == 0
    rows = _rows(conn)
    assert rows["e1"]["status"] == "new"
    assert (rows["p1"]["status"], rows["p1"]["parse_method"]) == ("failed", "efd_paper")


def test_a_block_mid_run_keeps_what_was_parsed_and_queues_the_rest(conn, monkeypatch):
    _filing(conn, "e1", filing_date="2026-10-14")
    _filing(conn, "e2", filing_date="2026-10-15")
    conn.commit()
    made = _sessions(monkeypatch, {
        PTR_URL.format("e1"): _page("efd_ptr_cantwell_2016-05-11.html"),
        PTR_URL.format("e2"): senate.SenateBlocked("agreement served"),
    })
    assert pipeline.parse_pending(conn, Config()) == 1
    rows = _rows(conn)
    assert rows["e1"]["status"] == "parsed"
    assert rows["e2"]["status"] == "new"
    assert made[0].closed


def test_a_transient_download_failure_retries_next_run(conn, monkeypatch):
    _filing(conn, "e1", filing_date="2026-10-14")
    _filing(conn, "e2", filing_date="2026-10-15")
    conn.commit()
    _sessions(monkeypatch, {
        PTR_URL.format("e1"): httpx.ReadTimeout(""),
        PTR_URL.format("e2"): _page("efd_ptr_carper_2019-10-01.html"),
    })
    assert pipeline.parse_pending(conn, Config()) == 1
    rows = _rows(conn)
    assert rows["e1"]["status"] == "new"
    assert rows["e2"]["status"] == "parsed"
    assert len(db.transactions_for_filing(conn, rows["e2"]["id"])) == 6


def test_a_page_without_the_table_is_failed_not_parsed_empty(conn, monkeypatch):
    _filing(conn, "e1")
    conn.commit()
    _sessions(monkeypatch, {PTR_URL.format("e1"): _page("efd_annual_leahy_2014.html")})
    assert pipeline.parse_pending(conn, Config()) == 0
    row = _rows(conn)["e1"]
    assert (row["status"], row["parse_method"]) == ("failed", "error")
    assert row["last_error"].startswith("parse error: no transactions table")
    assert db.transactions_for_filing(conn, row["id"]) == []


# --- notify: Senate rows take the House path unchanged ---------------------------


@pytest.fixture
def sent(monkeypatch):
    messages = []
    monkeypatch.setattr(telegram, "send_message",
                        lambda token, chat, text, **kw: messages.append(text))
    return messages


def test_parsed_senate_filing_is_announced_as_a_senator(conn, monkeypatch, sent):
    pid = _senator(conn)
    _filing(conn, "e1", politician_id=pid)
    conn.commit()
    pipeline._normalise_senate_rows(conn)
    _sessions(monkeypatch, {PTR_URL.format("e1"): _page("efd_ptr_cantwell_2016-05-11.html")})
    pipeline.parse_pending(conn, Config())
    assert pipeline.notify_pending(conn, Config(telegram_bot_token="t", telegram_chat_id="c")) == 1
    [text] = sent
    assert "New filing — Sen. Tommy Tuberville (R-AL)" in text
    assert "SELL (partial)" in text and "RNWK" in text
    assert PTR_URL.format("e1") in text
    assert _rows(conn)["e1"]["status"] == "notified"


def test_paper_filing_is_reported_once_with_its_link(conn, monkeypatch, sent):
    pid = _senator(conn)
    _filing(conn, "p1", politician_id=pid, url=PAPER_URL.format("p1"))
    conn.commit()
    pipeline._normalise_senate_rows(conn)
    _sessions(monkeypatch, {})
    pipeline.parse_pending(conn, Config())
    config = Config(telegram_bot_token="t", telegram_chat_id="c")
    assert pipeline.notify_pending(conn, config) == 1
    [text] = sent
    assert "Sen. Tommy Tuberville (R-AL)" in text
    assert "paper filing" in text
    assert PAPER_URL.format("p1") in text
    # Still failed — never guessed — but not reported twice.
    assert pipeline.notify_pending(conn, config) == 0
    assert _rows(conn)["p1"]["status"] == "failed"


# --- backfill: history for the statistics, no notifications ----------------------


def test_backfill_parses_indexed_senate_rows_as_history(tmp_path, monkeypatch):
    config = Config(db_path=tmp_path / "b.sqlite3")
    conn = db.connect(config.db_path)
    pid = _senator(conn)
    _filing(conn, "s1", status="seen_skipped", politician_id=pid,
            filing_date="10/07/2026", year=0)
    _filing(conn, "s2", status="seen_skipped", politician_id=pid,
            filing_date="08/31/2026", year=0, url=PAPER_URL.format("s2"))
    db.insert_filing(conn, chamber="house", doc_id="h1", politician_id=None,
                     filer_name="Some Rep", state_district="CA01", filing_type="P",
                     filing_date="2026-06-01", year=2026, pdf_url="http://clerk/h1.pdf",
                     status="seen_skipped")
    conn.commit()
    conn.close()
    _sessions(monkeypatch, {PTR_URL.format("s1"): _page("efd_ptr_loeffler_2020-02-07.html")})

    assert pipeline.backfill(config, 2026, None, chamber="senate") == 1

    conn = db.connect(config.db_path)
    try:
        rows = _rows(conn)
        assert (rows["s1"]["status"], rows["s1"]["parse_method"]) == ("backfilled", "efd_html")
        assert rows["s1"]["notified_at"] is not None
        assert rows["s1"]["filing_date"] == "2026-10-07" and rows["s1"]["year"] == 2026
        assert len(db.transactions_for_filing(conn, rows["s1"]["id"])) == 22
        assert (rows["s2"]["status"], rows["s2"]["parse_method"]) == ("failed", "efd_paper")
        assert rows["s2"]["notified_at"] is not None     # history: never announced
        house_row = conn.execute("SELECT status FROM filings WHERE doc_id = 'h1'").fetchone()
        assert house_row["status"] == "seen_skipped"     # --chamber senate left it alone
    finally:
        conn.close()


def test_backfill_rejects_an_unknown_chamber(tmp_path):
    with pytest.raises(ValueError, match="chamber"):
        pipeline.backfill(Config(db_path=tmp_path / "b.sqlite3"), None, None, chamber="both")


# --- roster: eFD's name forms resolve to senators ----------------------------------


@pytest.mark.parametrize("efd_name, bioguide", [
    ("Thomas H Tuberville", "T000278"),
    ("A. Mitchell McConnell, Jr.", "M000355"),
    ("RICHARD BLUMENTHAL", "B001277"),
    ("Jerry Moran,", "M000934"),
    ("James Conley Justice, II", "J000312"),
])
def test_efd_name_forms_match_the_senate_roster(conn, efd_name, bioguide):
    _senator(conn)
    _senator(conn, bioguide="M000355", name="Mitch McConnell", first="Mitch",
             last="McConnell", state="KY")
    _senator(conn, bioguide="B001277", name="Richard Blumenthal", first="Richard",
             last="Blumenthal", state="CT", party="D")
    _senator(conn, bioguide="M000934", name="Jerry Moran", first="Jerry", last="Moran",
             state="KS")
    _senator(conn, bioguide="J000312", name="James C. Justice", first="James",
             last="Justice", state="WV")
    conn.commit()
    match = roster.Matcher(conn).match(efd_name, None, "senate")
    assert match is not None and match["bioguide_id"] == bioguide


def test_a_representative_with_the_same_surname_does_not_win(conn):
    rep = db.upsert_politician(conn, bioguide_id="S001157", full_name="David Scott",
                               first="David", last="Scott", chamber="house", party="D",
                               state="GA", district="13", active=1)
    sen = _senator(conn, bioguide="S001217", name="Rick Scott", first="Rick", last="Scott",
                   state="FL")
    conn.commit()
    match = roster.Matcher(conn).match("Rick Scott", None, "senate")
    assert match["id"] == sen and match["id"] != rep
