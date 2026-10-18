"""Member roster from unitedstates/congress-legislators.

The Clerk's disclosure feed identifies a filer only by name and state/district
— no party, no chamber, no stable ID. This module supplies those by joining
against the community-maintained legislator dataset, so alerts can say
"Rep. Debbie Wasserman Schultz (D-FL25)" rather than just a surname.

The same dataset publishes the current committee rosters, refreshed here on
the same cadence (`sync_committees`): what a member oversees is the context
that makes a trade interesting.
"""

from __future__ import annotations

import logging
import re
import sqlite3
import unicodedata
from dataclasses import dataclass

import httpx
import yaml

from . import db

log = logging.getLogger(__name__)

CURRENT_URL = "https://unitedstates.github.io/congress-legislators/legislators-current.json"
HISTORICAL_URL = "https://unitedstates.github.io/congress-legislators/legislators-historical.json"
COMMITTEES_URL = "https://unitedstates.github.io/congress-legislators/committees-current.yaml"
MEMBERSHIP_URL = (
    "https://unitedstates.github.io/congress-legislators/committee-membership-current.yaml"
)

PARTY_ABBREV = {"Democrat": "D", "Republican": "R", "Independent": "I", "Libertarian": "L"}

# Suffixes and honorifics that appear on filings but not in the roster.
_SUFFIX_RE = re.compile(r"\b(jr|sr|ii|iii|iv|v|md|phd|esq)\b\.?", re.I)
_HONORIFIC_RE = re.compile(r"^(hon|mr|mrs|ms|dr|rep|sen)\.?\s+", re.I)


def normalize_name(name: str) -> str:
    """Casefold, strip accents, honorifics, suffixes and punctuation."""
    text = unicodedata.normalize("NFKD", name)
    text = "".join(c for c in text if not unicodedata.combining(c))
    text = _HONORIFIC_RE.sub("", text.strip())
    text = _SUFFIX_RE.sub("", text)
    text = re.sub(r"[^\w\s]", " ", text)
    return " ".join(text.lower().split())


def parse_state_district(state_dst: str | None) -> tuple[str | None, int | None]:
    """"FL25" -> ("FL", 25). At-large districts file as "00"."""
    if not state_dst:
        return None, None
    m = re.match(r"^([A-Z]{2})(\d{1,2})?$", state_dst.strip().upper())
    if not m:
        return None, None
    return m.group(1), int(m.group(2)) if m.group(2) is not None else None


def sync(conn: sqlite3.Connection, include_historical: bool = True) -> int:
    """Refresh the politicians table, then the committee tables keyed to it.
    Returns the number of members stored."""
    count = 0
    for url, active in ((CURRENT_URL, 1), (HISTORICAL_URL, 0)):
        if not active and not include_historical:
            continue
        try:
            resp = httpx.get(url, timeout=60, follow_redirects=True)
            resp.raise_for_status()
            people = resp.json()
        except Exception:
            log.exception("roster fetch failed for %s; keeping existing rows", url)
            continue

        for person in people:
            terms = person.get("terms") or []
            if not terms:
                continue
            term = terms[-1]
            # Historical file goes back to 1789; only members who could
            # plausibly have filed under the STOCK Act (2012) are useful.
            if not active and str(term.get("end", ""))[:4] < "2012":
                continue
            name = person.get("name") or {}
            db.upsert_politician(
                conn,
                bioguide_id=person.get("id", {}).get("bioguide") or name.get("official_full"),
                full_name=name.get("official_full")
                or f"{name.get('first','')} {name.get('last','')}".strip(),
                first=name.get("first"),
                last=name.get("last"),
                chamber="house" if term.get("type") == "rep" else "senate",
                party=PARTY_ABBREV.get(term.get("party", ""), term.get("party")),
                state=term.get("state"),
                district=str(term["district"]) if term.get("district") is not None else None,
                active=active,
            )
            count += 1
    conn.commit()
    log.info("roster: %d members stored", count)
    # Same source, same cadence, and seats resolve against the rows just
    # stored. Never raises: a failure keeps the previous committee snapshot.
    sync_committees(conn)
    return count


# --- committees -------------------------------------------------------------


@dataclass(frozen=True)
class CommitteeCounts:
    committees: int
    subcommittees: int
    memberships: int
    # Seats dropped: the bioguide id is not in `politicians` (roster fetch
    # failed or lags the committee file), or the committee id is not in the
    # committees file. Logged, because either means a member page is missing
    # an assignment the source has.
    unmatched: int
    unknown: int


def _fetch_yaml(url: str):
    resp = httpx.get(url, timeout=60, follow_redirects=True)
    resp.raise_for_status()
    return yaml.safe_load(resp.text)


def sync_committees(conn: sqlite3.Connection) -> CommitteeCounts | None:
    """Refresh `committees` and `committee_members` from the current snapshot.

    Never raises into the pipeline: a failed fetch, or a body that is not the
    expected shape (GitHub Pages serves an HTML page with a 200 on some
    outages), keeps the previous rows and returns None. Stale committee data
    is a smaller harm than none, and the roster refresh behaves the same way.
    """
    try:
        committees = _fetch_yaml(COMMITTEES_URL)
        membership = _fetch_yaml(MEMBERSHIP_URL)
    except Exception:
        log.exception("committee fetch failed; keeping existing rows")
        return None
    try:
        counts = load_committees(conn, committees, membership)
    except Exception:
        conn.rollback()
        log.exception("committee files were not the expected shape; keeping existing rows")
        return None
    conn.commit()
    log.info(
        "committees: %d committees, %d subcommittees, %d seats stored; %d seats unmatched, %d on unknown committees",
        counts.committees, counts.subcommittees, counts.memberships, counts.unmatched, counts.unknown,
    )
    if counts.unmatched:
        log.warning("committees: %d seat(s) belong to bioguide ids missing from the roster", counts.unmatched)
    return counts


def committee_rows(committees: object) -> list[dict]:
    """Flatten `committees-current.yaml` into `committees` rows, parents first.

    A subcommittee's id is the parent's thomas_id plus its own two-digit code
    — the key the membership file uses for it. Raises ValueError on anything
    that is not that file's shape, so a wrong body cannot empty the table.
    """
    if not isinstance(committees, list):
        raise ValueError("committees file is not a list")
    rows: list[dict] = []
    for c in committees:
        if not isinstance(c, dict) or not all(c.get(k) for k in ("thomas_id", "name", "type")):
            raise ValueError(f"malformed committee entry: {str(c)[:200]}")
        tid = str(c["thomas_id"])
        rows.append({
            "thomas_id": tid,
            "parent_id": None,
            "chamber": str(c["type"]),
            "name": str(c["name"]),
            "house_committee_id": c.get("house_committee_id"),
            "senate_committee_id": c.get("senate_committee_id"),
            "url": c.get("url"),
            "jurisdiction": c.get("jurisdiction"),
            "jurisdiction_source": c.get("jurisdiction_source"),
        })
        for s in c.get("subcommittees") or []:
            if not isinstance(s, dict) or not s.get("thomas_id") or not s.get("name"):
                raise ValueError(f"malformed subcommittee entry under {tid}: {str(s)[:200]}")
            rows.append({
                "thomas_id": tid + str(s["thomas_id"]).zfill(2),
                "parent_id": tid,
                "chamber": str(c["type"]),
                "name": str(s["name"]),
                "house_committee_id": None,
                "senate_committee_id": None,
                "url": None,
                "jurisdiction": None,
                "jurisdiction_source": None,
            })
    return rows


def load_committees(conn: sqlite3.Connection, committees: object,
                    membership: object) -> CommitteeCounts:
    """Replace the committee tables from the two parsed YAML documents.

    Seats are keyed to `politicians` by bioguide id, so the roster must be
    stored first. Does not commit; the caller commits, or rolls back on error
    to keep the previous snapshot.
    """
    rows = committee_rows(committees)
    if not isinstance(membership, dict):
        raise ValueError("membership file is not a mapping of committee id to seats")
    known = {r["thomas_id"] for r in rows}
    ids = db.politician_ids_by_bioguide(conn)
    seats: list[dict] = []
    seen: set[tuple[str, int]] = set()
    unmatched = unknown = 0
    for cid, entries in membership.items():
        cid = str(cid)
        if not isinstance(entries, list):
            raise ValueError(f"seats for {cid} are not a list")
        if cid not in known:
            unknown += len(entries)
            continue
        for e in entries:
            if not isinstance(e, dict) or not e.get("bioguide"):
                raise ValueError(f"malformed seat on {cid}: {str(e)[:200]}")
            pid = ids.get(str(e["bioguide"]))
            if pid is None:
                unmatched += 1
                continue
            if (cid, pid) in seen:
                continue
            seen.add((cid, pid))
            rank = e.get("rank")
            seats.append({
                "committee_id": cid,
                "politician_id": pid,
                "rank": int(rank) if rank is not None else None,
                "party": e.get("party"),
                "title": e.get("title"),
                "chamber": e.get("chamber"),
            })
    _, n_seats = db.replace_committees(conn, rows, seats)
    return CommitteeCounts(
        committees=sum(r["parent_id"] is None for r in rows),
        subcommittees=sum(r["parent_id"] is not None for r in rows),
        memberships=n_seats,
        unmatched=unmatched,
        unknown=unknown,
    )


class Matcher:
    """Resolves a filing's (name, state/district) to a politician row id.

    Built once per run; the roster is small enough to hold in memory and
    matching happens once per filing.
    """

    def __init__(self, conn: sqlite3.Connection):
        self.rows = db.all_politicians(conn)
        self._by_last_state_dist: dict[tuple, list] = {}
        self._by_last_state: dict[tuple, list] = {}
        self._by_last: dict[str, list] = {}
        for r in self.rows:
            last = normalize_name(r["last"] or "")
            if not last:
                continue
            state = (r["state"] or "").upper()
            dist = int(r["district"]) if r["district"] not in (None, "") else None
            self._by_last_state_dist.setdefault((last, state, dist), []).append(r)
            self._by_last_state.setdefault((last, state), []).append(r)
            self._by_last.setdefault(last, []).append(r)

    def match(self, filer_name: str, state_dst: str | None,
              chamber: str = "house") -> sqlite3.Row | None:
        """Best-effort match, narrowing from most to least specific.

        Prefers active members: surnames repeat across decades, and a current
        member is overwhelmingly the likelier filer.
        """
        state, dist = parse_state_district(state_dst)
        norm = normalize_name(filer_name)
        if not norm:
            return None
        tokens = norm.split()

        for last in self._candidate_surnames(tokens):
            lookups: list[list] = []
            if state and dist is not None:
                lookups.append(self._by_last_state_dist.get((last, state, dist), []))
            if state:
                lookups.append(self._by_last_state.get((last, state), []))
            lookups.append(self._by_last.get(last, []))

            for hits in lookups:
                if not hits:
                    continue
                hits = [h for h in hits if h["chamber"] == chamber] or hits
                resolved = self._disambiguate(hits, tokens)
                if resolved is not None:
                    return resolved
        return None

    @staticmethod
    def _candidate_surnames(tokens: list[str]) -> list[str]:
        """Surname guesses, longest first: multi-word surnames like
        "Wasserman Schultz" and "Van Epps" are common in Congress."""
        out = []
        for n in (3, 2, 1):
            if len(tokens) >= n:
                out.append(" ".join(tokens[-n:]))
        return out

    @staticmethod
    def _disambiguate(hits: list, tokens: list[str]) -> sqlite3.Row | None:
        if len(hits) == 1:
            return hits[0]
        active = [h for h in hits if h["active"]]
        if len(active) == 1:
            return active[0]
        pool = active or hits
        # Fall back to first name / initial agreement.
        for h in pool:
            first = normalize_name(h["first"] or "")
            if first and first in tokens:
                return h
        for h in pool:
            first = normalize_name(h["first"] or "")
            if first and tokens and first[0] == tokens[0][0]:
                return h
        return None
