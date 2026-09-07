"""Roster matching.

The Clerk's feed gives only a name and a state/district, so every alert's
attribution depends on this matching. Congressional surnames are awkward:
multi-word ("Wasserman Schultz", "Van Epps"), suffixed ("Yakym III"), and
reused across generations.
"""


import pytest

from whale import db, roster
from whale.roster import normalize_name, parse_state_district


@pytest.fixture
def conn(tmp_path):
    c = db.connect(tmp_path / "t.sqlite3")
    members = [
        ("W000797", "Debbie Wasserman Schultz", "Debbie", "Wasserman Schultz", "house", "D", "FL", "25", 1),
        ("Y000067", "Rudy Yakym III", "Rudy", "Yakym", "house", "R", "IN", "2", 1),
        ("V000135", "Matt Van Epps", "Matt", "Van Epps", "house", "R", "TN", "7", 1),
        ("P000197", "Nancy Pelosi", "Nancy", "Pelosi", "house", "D", "CA", "11", 1),
        # Same surname, different state — must not collide.
        ("S000001", "John Smith", "John", "Smith", "house", "R", "TX", "3", 1),
        ("S000002", "Jane Smith", "Jane", "Smith", "house", "D", "NY", "9", 1),
        # Retired member sharing a surname with a sitting one.
        ("P000099", "Old Pelosi", "Old", "Pelosi", "house", "D", "CA", "5", 0),
    ]
    for bioguide, full, first, last, chamber, party, state, district, active in members:
        db.upsert_politician(c, bioguide_id=bioguide, full_name=full, first=first,
                             last=last, chamber=chamber, party=party, state=state,
                             district=district, active=active)
    c.commit()
    yield c
    c.close()


def test_normalize_strips_honorific_and_suffix():
    assert normalize_name("Hon. Rudy C. Yakym III") == "rudy c yakym"
    assert normalize_name("Debbie Wasserman Schultz") == "debbie wasserman schultz"


def test_normalize_strips_accents():
    assert normalize_name("José E. Serrano") == "jose e serrano"


@pytest.mark.parametrize("value,expected", [
    ("FL25", ("FL", 25)),
    ("TN07", ("TN", 7)),
    ("AK00", ("AK", 0)),   # at-large
    ("", (None, None)),
    (None, (None, None)),
])
def test_parse_state_district(value, expected):
    assert parse_state_district(value) == expected


@pytest.mark.parametrize("filer,state_dst,expected", [
    ("Debbie Wasserman Schultz", "FL25", "W000797"),   # two-word surname
    ("Rudy C. Yakym III", "IN02", "Y000067"),          # middle initial + suffix
    ("Matthew Robert Van Epps", "TN07", "V000135"),    # two-word surname, formal first name
    ("Nancy Pelosi", "CA11", "P000197"),
])
def test_matches_real_filer_names(conn, filer, state_dst, expected):
    hit = roster.Matcher(conn).match(filer, state_dst)
    assert hit is not None and hit["bioguide_id"] == expected


def test_shared_surname_disambiguated_by_district(conn):
    m = roster.Matcher(conn)
    assert m.match("John Smith", "TX03")["bioguide_id"] == "S000001"
    assert m.match("Jane Smith", "NY09")["bioguide_id"] == "S000002"


def test_prefers_sitting_member_over_retired_namesake(conn):
    # Without a district hint, a current member is the far likelier filer.
    assert roster.Matcher(conn).match("Pelosi", None)["bioguide_id"] == "P000197"


def test_unknown_filer_returns_none(conn):
    assert roster.Matcher(conn).match("Nobody Atall", "ZZ99") is None
    assert roster.Matcher(conn).match("", "FL25") is None


def test_wrong_district_still_matches_on_surname(conn):
    # Redistricting changes a member's district mid-corpus; the surname and
    # state should still resolve rather than dropping the attribution.
    hit = roster.Matcher(conn).match("Debbie Wasserman Schultz", "FL23")
    assert hit is not None and hit["bioguide_id"] == "W000797"
