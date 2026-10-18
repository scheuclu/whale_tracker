"""Option contracts, parsed from what the filing printed.

57 rows in the 2026 corpus are typed `OP` and a few more carry a contract in
the asset name itself. They are the most directional disclosures a member
can make, and the text carries the contract — in three dialects, and mostly
not in the asset name:

* House, in the row's "Description:" sub-field (the asset name is the
  underlying): "Purchased 20 call options with a strike price of $150 and
  an expiration date of 1/15/27.", "Call options; Strike price $325;
  Expires 06/18/2026", "Put Option", "10 puts at $11.80".
* Senate, in eFD's sub-detail lines that `senate_ptr` keeps in
  `description`: "Option Type: Call · Strike price: $75.00 · Expires:
  2026-08-21".
* A broker's symbol form as the asset name, with no type code and no
  ticker: "CALL/JNJ FLEX EURO PM @ 245 EXP 07/02/2026", "PUT/XSP @ 690
  EXP 10/16/2026".

So the parser reads the asset name and the description together, and it
never guesses. A row that names no kind, or names both, stays unparsed. A
strike is only a figure the text calls a strike (or the one in the symbol
form's slot): "10 puts at $11.80" is a premium, and stays a put with no
strike. Two different strikes or expiries in one row cancel each other. And
"call" on a bond is the issuer's right to redeem, never a contract, so debt
types are refused outright ("California St Go Call 12/1/27", "NOTE CALL MAKE
WHOLE"); "callable", "Callaway" and "earnings calls" never match at all. The
raw text stays on the row either way, which is what makes a parser fix
replayable with `whale backfill-options`.
"""

from __future__ import annotations

import re
import sqlite3
from dataclasses import dataclass
from datetime import date
from decimal import Decimal, InvalidOperation

CALL = "call"
PUT = "put"
KINDS = (CALL, PUT)

# The House code for an option row; the Senate's "Stock Option" maps to it.
OPTION_TYPE = "OP"
# Where "call" is the issuer's redemption right, not a traded contract.
DEBT_TYPES = frozenset({"GS", "CS", "AB", "BA"})

COLUMNS = ("option_kind", "strike_cents", "expiry")

# A date as the forms print it — 1/15/27, 06/18/2026 — or eFD's ISO form.
_DATE = r"(\d{1,2}/\d{1,2}/\d{2,4}|\d{4}-\d{2}-\d{2})"
_MONEY = r"\$?\s*(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)"

# The word "option" beside the kind, or eFD's labelled field: enough on any row.
_KIND_STRONG = re.compile(
    r"\b(call|put)s?\s+options?\b|\boptions?\s+type\s*:?\s*(call|put)\b", re.I)
# Any mention of the kind at all: enough only when the row is already typed OP.
_KIND_BARE = re.compile(r"\b(call|put)s?\b", re.I)
# A broker's symbol form: "CALL/JNJ FLEX EURO PM @ 245 EXP 07/02/2026". Upper
# case only, and only at the start of the asset name.
_SYMBOL_FORM = re.compile(r"^(CALL|PUT)/[A-Z][A-Z0-9.]*\b(.*)$")
# In that form the figure before EXP is the strike, with or without the "@".
_SYMBOL_STRIKE = re.compile(r"(?:@\s*)?(\d+(?:\.\d+)?)\s+EXP\b")
_STRIKE = re.compile(r"\bstrike(?:\s+price)?\s*(?:of|at|:)?\s*" + _MONEY, re.I)
_EXPIRY = re.compile(
    r"\bexp(?:ir(?:es|ing|y|ed|ation(?:\s+date)?))?\b\s*:?\s*(?:of\s+|on\s+)?" + _DATE,
    re.I)


@dataclass(frozen=True)
class OptionContract:
    kind: str
    strike_cents: int | None = None
    expiry: str | None = None


def parse(asset_name: str | None, description: str | None = None,
          asset_type: str | None = None) -> OptionContract | None:
    """The contract a row describes, or None when its text does not say."""
    if asset_type in DEBT_TYPES:
        return None
    name = _collapse(asset_name)
    text = _collapse(f"{asset_name or ''}\n{description or ''}")
    if not text:
        return None

    kinds: set[str] = set()
    symbol = _SYMBOL_FORM.match(name)
    if symbol:
        kinds.add(symbol.group(1).lower())
    for m in _KIND_STRONG.finditer(text):
        kinds.add((m.group(1) or m.group(2)).lower())
    if asset_type == OPTION_TYPE:
        for m in _KIND_BARE.finditer(text):
            kinds.add(m.group(1).lower())
    if len(kinds) != 1:
        # Nothing named, or a call and a put in one row (a straddle, or a
        # description that mentions both): either way not one contract.
        return None
    kind = kinds.pop()

    strikes = {_cents(m.group(1)) for m in _STRIKE.finditer(text)}
    if not strikes and symbol and (m := _SYMBOL_STRIKE.search(symbol.group(2))):
        strikes.add(_cents(m.group(1)))
    strikes.discard(None)
    expiries = {_iso(m.group(1)) for m in _EXPIRY.finditer(text)}
    expiries.discard(None)

    return OptionContract(
        kind=kind,
        strike_cents=strikes.pop() if len(strikes) == 1 else None,
        expiry=expiries.pop() if len(expiries) == 1 else None,
    )


def columns(asset_name: str | None, description: str | None = None,
            asset_type: str | None = None) -> dict:
    """The three `transactions` columns for a row, NULL when unparsed."""
    c = parse(asset_name, description, asset_type)
    if c is None:
        return dict.fromkeys(COLUMNS)
    return {"option_kind": c.kind, "strike_cents": c.strike_cents, "expiry": c.expiry}


def describe(kind: str | None, strike_cents: int | None = None,
             expiry: str | None = None) -> str | None:
    """The contract in words — "call option · strike $120 · expires 01/16/2027".

    Only what was parsed: a kind alone is still a fact worth printing, and a
    missing strike is left out rather than shown as a placeholder.
    """
    if not kind:
        return None
    parts = [f"{kind} option"]
    if strike_cents is not None:
        parts.append(f"strike {strike_usd(strike_cents)}")
    if expiry:
        parts.append(f"expires {_mdy(expiry)}")
    return " · ".join(parts)


def strike_usd(cents: int) -> str:
    """A strike as printed on a contract: $120, or $11.80 when it is not whole."""
    dollars, rest = divmod(int(cents), 100)
    return f"${dollars:,}" if not rest else f"${dollars:,}.{rest:02d}"


def backfill(conn: sqlite3.Connection) -> tuple[int, int]:
    """Re-derive the option columns for every stored row from its own text.

    Run by the schema-11 migration and by `whale backfill-options` after a
    parser change. Every row is rewritten — a row that no longer parses loses
    its structure rather than keeping a stale one. Returns (rows seen, rows
    with a contract).
    """
    rows = conn.execute(
        "SELECT id, asset_name, description, asset_type FROM transactions").fetchall()
    structured = 0
    for row_id, asset_name, description, asset_type in rows:
        c = columns(asset_name, description, asset_type)
        conn.execute(
            "UPDATE transactions SET option_kind = ?, strike_cents = ?, expiry = ? WHERE id = ?",
            (c["option_kind"], c["strike_cents"], c["expiry"], row_id))
        structured += c["option_kind"] is not None
    return len(rows), structured


def _collapse(text: str | None) -> str:
    return " ".join((text or "").split())


def _cents(text: str) -> int | None:
    try:
        value = Decimal(text.replace(",", ""))
    except InvalidOperation:
        return None
    if value <= 0:
        return None
    return int((value * 100).to_integral_value())


def _iso(text: str) -> str | None:
    """An ISO date from 1/15/27, 06/18/2026 or 2026-08-21; None if no such day."""
    if "-" in text:
        y, m, d = text.split("-")
    else:
        m, d, y = text.split("/")
        if len(y) == 2:
            # An option expires in the near future; "27" can only be 2027.
            y = f"20{y}"
    try:
        return date(int(y), int(m), int(d)).isoformat()
    except ValueError:
        return None


def _mdy(iso: str) -> str:
    y, m, d = iso.split("-")
    return f"{m}/{d}/{y}"
