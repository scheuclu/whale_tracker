"""Disclosure amount brackets → cents.

The STOCK Act only requires members to disclose a *range*, so almost every
figure in this project is an interval, not a number. Everything downstream
stores `(min, max)` and treats the midpoint as a derived estimate — never as
a reported value.
"""

from __future__ import annotations

import re

# The bracket ladder used on House PTRs. `None` upper bound = open-ended top
# bracket ("Over $50,000,000"), which has no defensible maximum. Its floor is
# the figure the form prints, because that is what `parse_amount` stores for
# every "Over $X" cell (the e-filed "Spouse/DC Over $1,000,000" included) and
# a floor is displayed as "≥", never as a midpoint. The first real top-bracket
# row (a Senate filing, #40) was off this ladder by one dollar.
BRACKETS: list[tuple[int, int | None]] = [
    (1_001, 15_000),
    (15_001, 50_000),
    (50_001, 100_000),
    (100_001, 250_000),
    (250_001, 500_000),
    (500_001, 1_000_000),
    (1_000_001, 5_000_000),
    (5_000_001, 25_000_000),
    (25_000_001, 50_000_000),
    (50_000_000, None),
]

_MONEY = r"\$?\s*([\d,]+(?:\.\d{1,2})?)"
_RANGE_RE = re.compile(rf"{_MONEY}\s*[-–—]\s*{_MONEY}")
_OVER_RE = re.compile(rf"(?:over|more than)\s+{_MONEY}", re.I)
_SINGLE_RE = re.compile(rf"^{_MONEY}$")


class Amount:
    """A disclosed amount: a bracket, or an exact figure when one is given.

    `exact_cents` is set only when the filing states a precise number (some
    filers do, e.g. "$2,722.50"); in that case min == max == exact.
    """

    __slots__ = ("min_cents", "max_cents", "exact_cents")

    def __init__(self, min_cents: int | None, max_cents: int | None, exact_cents: int | None = None):
        self.min_cents = min_cents
        self.max_cents = max_cents
        self.exact_cents = exact_cents

    @property
    def mid_cents(self) -> int | None:
        """Midpoint estimate. `None` for the open-ended top bracket, where any
        midpoint would be invented rather than estimated."""
        if self.exact_cents is not None:
            return self.exact_cents
        if self.min_cents is None or self.max_cents is None:
            return None
        return (self.min_cents + self.max_cents) // 2

    def __repr__(self) -> str:
        return f"Amount(min={self.min_cents}, max={self.max_cents}, exact={self.exact_cents})"

    def __eq__(self, other: object) -> bool:
        return (
            isinstance(other, Amount)
            and (self.min_cents, self.max_cents, self.exact_cents)
            == (other.min_cents, other.max_cents, other.exact_cents)
        )


def _to_cents(raw: str) -> int:
    return round(float(raw.replace(",", "")) * 100)


def parse_amount(text: str | None) -> Amount | None:
    """Parse an amount cell from a PTR. Returns None if nothing parses.

    Handles the three shapes seen in real filings: a bracket
    ("$1,001 - $15,000"), the open-ended top ("Over $50,000,000"), and an
    exact figure ("$2,722.50").
    """
    if not text:
        return None
    cleaned = " ".join(text.split())
    if not cleaned:
        return None

    m = _RANGE_RE.search(cleaned)
    if m:
        lo, hi = _to_cents(m.group(1)), _to_cents(m.group(2))
        if lo > hi:
            lo, hi = hi, lo
        return Amount(lo, hi)

    m = _OVER_RE.search(cleaned)
    if m:
        return Amount(_to_cents(m.group(1)), None)

    m = _SINGLE_RE.match(cleaned)
    if m:
        cents = _to_cents(m.group(1))
        return Amount(cents, cents, cents)

    return None


def format_amount(min_cents: int | None, max_cents: int | None, exact_cents: int | None = None) -> str:
    """Human-readable amount for Telegram/CLI, preserving range semantics."""
    if exact_cents is not None:
        return _usd(exact_cents)
    if min_cents is None:
        return "unknown"
    if max_cents is None:
        return f">{_usd(min_cents)}"
    if min_cents == max_cents:
        return _usd(min_cents)
    return f"{_usd(min_cents)}–{_usd(max_cents)}"


def _usd(cents: int) -> str:
    """Compact USD: $2,723 / $17k / $1.7M.

    Rounds half away from zero. Python's default formatting rounds half to
    even, which turns $2,722.50 into "$2,722" and reads like an off-by-one.
    """
    dollars = cents / 100
    if dollars >= 1_000_000:
        return f"${_round_half_up(dollars / 100_000) / 10:.1f}M".replace(".0M", "M")
    if dollars >= 10_000:
        return f"${_round_half_up(dollars / 1_000):,.0f}k"
    return f"${_round_half_up(dollars):,.0f}"


def _round_half_up(value: float) -> float:
    from decimal import ROUND_HALF_UP, Decimal

    return float(Decimal(str(value)).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def usd(cents: int | None) -> str:
    return _usd(cents) if cents is not None else "?"
