"""Member roster from unitedstates/congress-legislators.

The Clerk's disclosure feed identifies a filer only by name and state/district
— no party, no chamber, no stable ID. This module supplies those by joining
against the community-maintained legislator dataset, so alerts can say
"Rep. Debbie Wasserman Schultz (D-FL25)" rather than just a surname.
"""

from __future__ import annotations

import logging
import re
import sqlite3
import unicodedata

import httpx

from . import db

log = logging.getLogger(__name__)

CURRENT_URL = "https://unitedstates.github.io/congress-legislators/legislators-current.json"
HISTORICAL_URL = "https://unitedstates.github.io/congress-legislators/legislators-historical.json"

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
    """Refresh the politicians table. Returns the number of members stored."""
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
    return count


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
