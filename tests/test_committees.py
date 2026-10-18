"""Committee assignments (#56): schema, loader, and the refresh's failure modes.

The fixtures are the real congress-legislators YAML trimmed to three
committees that between them cover every shape the loader meets: a House
committee with subcommittees, a Senate one, and a joint one whose seats carry
a per-member chamber and whose two chairs both hold rank 1.
"""

import sqlite3
from pathlib import Path

import httpx
import pytest
import yaml

from whale import db, roster

FIXTURES = Path(__file__).parent / "fixtures"
COMMITTEES_YAML = (FIXTURES / "committees-current.trimmed.yaml").read_text()
MEMBERSHIP_YAML = (FIXTURES / "committee-membership-current.trimmed.yaml").read_text()

# Full committees, subcommittees and seats in the trimmed membership file.
# Mike Rounds sits on SSBK and its Economic Policy subcommittee: two seats.
EXPECTED = roster.CommitteeCounts(committees=3, subcommittees=3, memberships=24, unmatched=0, unknown=0)


def _committees():
    return yaml.safe_load(COMMITTEES_YAML)


def _membership():
    return yaml.safe_load(MEMBERSHIP_YAML)


def _tables(conn):
    return {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}


@pytest.fixture
def conn(tmp_path):
    """A database whose roster holds every member the fixture seats name."""
    c = db.connect(tmp_path / "t.sqlite3")
    for cid, entries in _membership().items():
        for e in entries:
            db.upsert_politician(
                c, bioguide_id=e["bioguide"], full_name=e["name"],
                first=e["name"].split()[0], last=e["name"].split()[-1],
                chamber=e.get("chamber") or ("house" if cid.startswith("H") else "senate"),
                party="R" if e["party"] == "majority" else "D", state="XX", district=None, active=1,
            )
    c.commit()
    yield c
    c.close()


@pytest.fixture
def loaded(conn):
    assert roster.load_committees(conn, _committees(), _membership()) == EXPECTED
    conn.commit()
    return conn


# --- schema -----------------------------------------------------------------


def test_fresh_database_has_committee_tables(tmp_path):
    conn = db.connect(tmp_path / "fresh.sqlite3")
    assert {"committees", "committee_members"} <= _tables(conn)
    assert conn.execute("PRAGMA user_version").fetchone()[0] == db.SCHEMA_VERSION
    assert db.committee_counts(conn) == {"committees": 0, "subcommittees": 0, "memberships": 0}
    conn.close()


def test_version_8_database_gains_committee_tables_in_place(tmp_path):
    path = tmp_path / "v8.sqlite3"
    raw = sqlite3.connect(path)
    for ddl in (db._DDL, db._INSIDER_DDL, db._COOLDOWN_DDL, db._SCAN_DDL):
        raw.executescript(ddl)
    raw.execute("INSERT INTO politicians (bioguide_id, full_name, updated_at) VALUES ('X1', 'Some Member', 't')")
    raw.execute("PRAGMA user_version = 8")
    raw.commit()
    raw.close()

    conn = db.connect(path)
    assert conn.execute("PRAGMA user_version").fetchone()[0] == db.SCHEMA_VERSION
    assert {"committees", "committee_members"} <= _tables(conn)
    assert conn.execute("SELECT full_name FROM politicians").fetchone()[0] == "Some Member"
    conn.close()


# --- loader -----------------------------------------------------------------


def test_load_stores_committees_subcommittees_and_seats(loaded):
    assert db.committee_counts(loaded) == {"committees": 3, "subcommittees": 3, "memberships": 24}
    rows = {r["thomas_id"]: r for r in loaded.execute("SELECT * FROM committees")}
    assert rows["HSIF"]["chamber"] == "house"
    assert rows["HSIF"]["parent_id"] is None
    assert rows["HSIF"]["house_committee_id"] == "IF"
    assert rows["HSIF"]["url"] == "https://energycommerce.house.gov/"
    assert rows["HSIF"]["jurisdiction"].startswith("The House Committee on Energy and Commerce")
    assert rows["HSIF"]["jurisdiction_source"] == "https://energycommerce.house.gov/committee-history/"
    assert rows["SSBK"]["senate_committee_id"] == "SSBK"
    assert rows["JSEC"]["chamber"] == "joint"
    assert rows["JSEC"]["jurisdiction"] is None  # the source has none for it


def test_subcommittee_is_keyed_under_its_parent(loaded):
    sub = loaded.execute("SELECT * FROM committees WHERE thomas_id = 'HSIF16'").fetchone()
    assert sub["parent_id"] == "HSIF"
    assert sub["chamber"] == "house"
    assert sub["name"] == "Communications and Technology"
    assert sub["jurisdiction"] is None


def test_subcommittee_code_keeps_its_leading_zero():
    # The code is a quoted string in the source; a writer that unquoted it
    # would hand us an int and the membership key would no longer match.
    rows = roster.committee_rows([
        {"type": "house", "name": "X", "thomas_id": "HSXX",
         "subcommittees": [{"name": "Sub", "thomas_id": 3}]},
    ])
    assert rows[1]["thomas_id"] == "HSXX03"


def test_seat_carries_rank_side_and_title(loaded):
    seats = loaded.execute(
        """SELECT p.full_name, cm.rank, cm.party, cm.title, cm.chamber
           FROM committee_members cm JOIN politicians p ON p.id = cm.politician_id
           WHERE cm.committee_id = 'HSIF' ORDER BY cm.party, cm.rank"""
    ).fetchall()
    assert [tuple(s) for s in seats] == [
        ("Brett Guthrie", 1, "majority", "Chair", None),
        ("Robert E. Latta", 2, "majority", None, None),
        ("H. Morgan Griffith", 3, "majority", None, None),
        ("Frank Pallone, Jr.", 1, "minority", "Ranking Member", None),
        ("Diana DeGette", 2, "minority", None, None),
    ]


def test_joint_committee_seats_say_which_chamber(loaded):
    seats = {
        r["full_name"]: (r["rank"], r["title"], r["chamber"])
        for r in loaded.execute(
            """SELECT p.full_name, cm.rank, cm.title, cm.chamber
               FROM committee_members cm JOIN politicians p ON p.id = cm.politician_id
               WHERE cm.committee_id = 'JSEC'"""
        )
    }
    # One chair per chamber, both rank 1 — rank is within a side and chamber.
    assert seats["David Schweikert"] == (1, "Chairman", "house")
    assert seats["Eric Schmitt"] == (1, "Vice Chairman", "senate")
    assert seats["Margaret Wood Hassan"] == (1, "Ranking Member", "senate")


def test_member_on_committee_and_its_subcommittee_has_two_seats(loaded):
    seats = loaded.execute(
        """SELECT cm.committee_id, cm.rank FROM committee_members cm
           JOIN politicians p ON p.id = cm.politician_id
           WHERE p.bioguide_id = 'R000605' ORDER BY cm.committee_id"""
    ).fetchall()
    assert [tuple(s) for s in seats] == [("SSBK", 3), ("SSBK12", 2)]


def test_refresh_replaces_the_previous_snapshot(loaded):
    committees = [c for c in _committees() if c["thomas_id"] != "SSBK"]
    membership = {k: v for k, v in _membership().items() if not k.startswith("SSBK")}
    membership["HSIF"] = [e for e in membership["HSIF"] if e["bioguide"] != "D000197"]

    counts = roster.load_committees(loaded, committees, membership)
    loaded.commit()

    assert counts == roster.CommitteeCounts(committees=2, subcommittees=2, memberships=15,
                                            unmatched=0, unknown=0)
    assert loaded.execute("SELECT COUNT(*) FROM committees WHERE thomas_id LIKE 'SSBK%'").fetchone()[0] == 0
    assert loaded.execute("SELECT COUNT(*) FROM committee_members WHERE committee_id LIKE 'SSBK%'").fetchone()[0] == 0
    gone = loaded.execute(
        """SELECT COUNT(*) FROM committee_members cm JOIN politicians p ON p.id = cm.politician_id
           WHERE p.bioguide_id = 'D000197'"""
    ).fetchone()[0]
    assert gone == 0


def test_seat_for_a_member_missing_from_the_roster_is_dropped_and_counted(conn):
    membership = _membership()
    membership["HSIF"].append({"name": "Nobody Yet", "party": "majority", "rank": 9, "bioguide": "Z999999"})
    counts = roster.load_committees(conn, _committees(), membership)
    assert counts.memberships == 24
    assert counts.unmatched == 1


def test_seat_on_a_committee_the_file_does_not_list_is_counted(conn):
    membership = _membership()
    membership["HSZZ"] = [{"name": "Brett Guthrie", "party": "majority", "rank": 1, "bioguide": "G000558"}]
    counts = roster.load_committees(conn, _committees(), membership)
    assert counts.memberships == 24
    assert counts.unknown == 1


def test_duplicate_seat_is_stored_once(conn):
    membership = _membership()
    membership["HSIF"].append(dict(membership["HSIF"][0]))
    counts = roster.load_committees(conn, _committees(), membership)
    assert counts.memberships == 24


def test_unlabelled_seat_is_stored_as_unknown_not_rejected(conn):
    membership = _membership()
    membership["HSIF"].append({"name": "Robert Aderholt", "bioguide": "G000568", "party": "majority"})
    membership["HSIF17"] = [{"bioguide": "G000568"}]
    roster.load_committees(conn, _committees(), membership)
    row = conn.execute(
        "SELECT rank, party, title FROM committee_members WHERE committee_id = 'HSIF17'"
    ).fetchone()
    assert tuple(row) == (None, None, None)


@pytest.mark.parametrize("committees,membership", [
    ("<html>service unavailable</html>", {}),
    ([{"type": "house", "name": "No id"}], {}),
    ([], "<html>service unavailable</html>"),
    ([], {"HSIF": "not a list"}),
])
def test_wrong_shape_is_rejected(conn, committees, membership):
    with pytest.raises(ValueError):
        roster.load_committees(conn, committees, membership)


# --- sync: fetch, commit, and never raise ------------------------------------


class _Resp:
    def __init__(self, text, status=200):
        self.text = text
        self.status_code = status

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError(f"{self.status_code}", request=None, response=None)


def _serve(monkeypatch, bodies):
    """Answer the two committee URLs from memory; `bodies` may hold exceptions."""
    calls = []

    def fake_get(url, **kwargs):
        calls.append(url)
        body = bodies[url]
        if isinstance(body, Exception):
            raise body
        return body

    monkeypatch.setattr(roster.httpx, "get", fake_get)
    return calls


def test_sync_fetches_both_files_and_commits(conn, monkeypatch):
    calls = _serve(monkeypatch, {
        roster.COMMITTEES_URL: _Resp(COMMITTEES_YAML),
        roster.MEMBERSHIP_URL: _Resp(MEMBERSHIP_YAML),
    })
    assert roster.sync_committees(conn) == EXPECTED
    assert calls == [roster.COMMITTEES_URL, roster.MEMBERSHIP_URL]
    # Committed: a second connection sees it.
    other = sqlite3.connect(conn.execute("PRAGMA database_list").fetchone()[2])
    assert other.execute("SELECT COUNT(*) FROM committee_members").fetchone()[0] == 24
    other.close()


def test_sync_keeps_existing_rows_when_a_fetch_fails(loaded, monkeypatch):
    _serve(monkeypatch, {
        roster.COMMITTEES_URL: _Resp(COMMITTEES_YAML),
        roster.MEMBERSHIP_URL: httpx.ConnectError("no route"),
    })
    assert roster.sync_committees(loaded) is None
    assert db.committee_counts(loaded) == {"committees": 3, "subcommittees": 3, "memberships": 24}


def test_sync_keeps_existing_rows_on_an_http_error(loaded, monkeypatch):
    _serve(monkeypatch, {
        roster.COMMITTEES_URL: _Resp("", status=503),
        roster.MEMBERSHIP_URL: _Resp(MEMBERSHIP_YAML),
    })
    assert roster.sync_committees(loaded) is None
    assert db.committee_counts(loaded) == {"committees": 3, "subcommittees": 3, "memberships": 24}


def test_sync_keeps_existing_rows_when_the_body_is_a_200_html_page(loaded, monkeypatch):
    # GitHub Pages answers some outages with an HTML page and a 200.
    _serve(monkeypatch, {
        roster.COMMITTEES_URL: _Resp("<html><body>Unavailable</body></html>"),
        roster.MEMBERSHIP_URL: _Resp(MEMBERSHIP_YAML),
    })
    assert roster.sync_committees(loaded) is None
    assert db.committee_counts(loaded) == {"committees": 3, "subcommittees": 3, "memberships": 24}


def test_sync_rolls_back_a_load_that_fails_midway(loaded, monkeypatch):
    # The committees file is fine, so the old rows are already deleted by
    # the time the malformed seat is met: the previous snapshot must come
    # back whole rather than leaving the table empty or half-filled.
    membership = _membership()
    membership["SSBK"].append("not a seat")
    _serve(monkeypatch, {
        roster.COMMITTEES_URL: _Resp(COMMITTEES_YAML),
        roster.MEMBERSHIP_URL: _Resp(yaml.safe_dump(membership)),
    })
    assert roster.sync_committees(loaded) is None
    assert db.committee_counts(loaded) == {"committees": 3, "subcommittees": 3, "memberships": 24}
    assert loaded.execute("SELECT COUNT(*) FROM committee_members WHERE committee_id = 'SSBK'").fetchone()[0] == 5
