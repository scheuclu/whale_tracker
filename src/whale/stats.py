"""Aggregation: per-ticker volume, participation, and cluster detection.

This is the analytical point of the tracker. A single disclosure is weak
evidence; several members converging on one ticker inside a short window is
the signal worth an alert.

Volume is always an interval. The STOCK Act requires only a bracket
("$1,001 - $15,000"), so every total carries `min`/`max` and a midpoint that
is explicitly an estimate. Rows in the open-ended top bracket have no upper
bound, so `max_cents` becomes None for any total that includes one and the
caller is expected to render it as "≥".
"""

from __future__ import annotations

import math
import sqlite3
from dataclasses import dataclass, field
from datetime import date, timedelta

from .config import AlertSettings, InsiderSettings
from .db import COUNTED_STATUSES

# Actions that move money in a direction we can aggregate. Exchanges have no
# net direction and are excluded from buy/sell rollups.
# The STOCK Act's reporting deadline, measured from the transaction date.
STOCK_ACT_DEADLINE_DAYS = 45

# How much bigger an insider cluster must get before it is worth a second
# message. See `is_new_insider_cluster`; `insiders.cluster_refire_growth`
# overrides it.
DEFAULT_CLUSTER_REFIRE_GROWTH = 1.5

BUY_ACTIONS = ("purchase",)
SELL_ACTIONS = ("sale", "sale_partial")


@dataclass
class Volume:
    min_cents: int = 0
    max_cents: int | None = 0
    mid_cents: int = 0
    open_ended: bool = False

    def add(self, lo: int | None, hi: int | None, exact: int | None) -> None:
        if exact is not None:
            self.min_cents += exact
            self.mid_cents += exact
            if self.max_cents is not None:
                self.max_cents += exact
            return
        if lo is not None:
            self.min_cents += lo
        if hi is None:
            # Open-ended top bracket: no defensible maximum, and a midpoint
            # would be invented. Track the floor only.
            self.open_ended = True
            self.max_cents = None
            if lo is not None:
                self.mid_cents += lo
            return
        if self.max_cents is not None:
            self.max_cents += hi
        if lo is not None:
            self.mid_cents += (lo + hi) // 2


@dataclass
class TickerStat:
    ticker: str
    asset_name: str | None = None
    politician_count: int = 0
    trade_count: int = 0
    buy_count: int = 0
    sell_count: int = 0
    buy_politicians: set[str] = field(default_factory=set)
    sell_politicians: set[str] = field(default_factory=set)
    volume: Volume = field(default_factory=Volume)
    buy_volume: Volume = field(default_factory=Volume)
    sell_volume: Volume = field(default_factory=Volume)
    last_tx_date: str | None = None

    @property
    def net_direction(self) -> str:
        if self.buy_volume.mid_cents > self.sell_volume.mid_cents:
            return "buy"
        if self.sell_volume.mid_cents > self.buy_volume.mid_cents:
            return "sell"
        return "flat"


def _window_start(days: int, today: date | None = None) -> str:
    return ((today or date.today()) - timedelta(days=days)).isoformat()


def _rows(conn: sqlite3.Connection, since: str | None, tickers_only: bool,
          asset_types: list[str] | None, today: date | None = None) -> list[sqlite3.Row]:
    marks = ", ".join("?" for _ in COUNTED_STATUSES)
    sql = f"""
        SELECT t.*, COALESCE(p.full_name, f.filer_name) AS member_name,
               p.party, p.state, p.district, p.chamber, f.filing_date
        FROM transactions t
        JOIN filings f ON f.id = t.filing_id
        LEFT JOIN politicians p ON p.id = t.politician_id
        WHERE f.status IN ({marks})
    """
    params: list = list(COUNTED_STATUSES)
    if since:
        # Upper bound too: a mistyped future trade date would otherwise fall
        # inside every rolling window forever.
        sql += " AND t.tx_date >= ? AND t.tx_date <= ?"
        params.append(since)
        params.append((today or date.today()).isoformat())
    if tickers_only:
        sql += " AND t.ticker IS NOT NULL AND t.ticker != ''"
    if asset_types:
        sql += f" AND t.asset_type IN ({', '.join('?' for _ in asset_types)})"
        params += asset_types
    return conn.execute(sql, params).fetchall()


def ticker_stats(conn: sqlite3.Connection, window_days: int | None = None,
                 asset_types: list[str] | None = None,
                 today: date | None = None) -> dict[str, TickerStat]:
    """Roll transactions up per ticker: volume, participation, buy/sell split."""
    since = _window_start(window_days, today) if window_days else None
    stats: dict[str, TickerStat] = {}

    for r in _rows(conn, since, tickers_only=True, asset_types=asset_types, today=today):
        s = stats.setdefault(r["ticker"], TickerStat(ticker=r["ticker"]))
        s.asset_name = s.asset_name or r["asset_name"]
        s.trade_count += 1
        member = r["member_name"] or "unknown"
        amounts = (r["amount_min_cents"], r["amount_max_cents"], r["amount_exact_cents"])
        s.volume.add(*amounts)

        if r["action"] in BUY_ACTIONS:
            s.buy_count += 1
            s.buy_politicians.add(member)
            s.buy_volume.add(*amounts)
        elif r["action"] in SELL_ACTIONS:
            s.sell_count += 1
            s.sell_politicians.add(member)
            s.sell_volume.add(*amounts)

        if r["tx_date"] and (s.last_tx_date is None or r["tx_date"] > s.last_tx_date):
            s.last_tx_date = r["tx_date"]

    for s in stats.values():
        s.politician_count = len(s.buy_politicians | s.sell_politicians)
    return stats


def top_tickers(conn: sqlite3.Connection, window_days: int | None = None,
                by: str = "volume", limit: int = 20,
                asset_types: list[str] | None = None) -> list[TickerStat]:
    """Leaderboard, ranked by traded volume or by number of distinct members."""
    stats = list(ticker_stats(conn, window_days, asset_types).values())
    key = (lambda s: (s.politician_count, s.volume.mid_cents)) if by == "politicians" \
        else (lambda s: (s.volume.mid_cents, s.politician_count))
    return sorted(stats, key=key, reverse=True)[:limit]


def ticker_context(conn: sqlite3.Connection, ticker: str, window_days: int = 30,
                   today: date | None = None) -> TickerStat | None:
    """Aggregate for one ticker — the context line on a per-filing alert."""
    return ticker_stats(conn, window_days, today=today).get(ticker)


@dataclass
class Cluster:
    ticker: str
    direction: str
    politician_count: int
    trade_count: int
    members: list[str]
    volume: Volume
    reason: str


def find_clusters(conn: sqlite3.Connection, settings: AlertSettings,
                  today: date | None = None) -> list[Cluster]:
    """Tickers crossing the participation or volume threshold in the window.

    Only asset types configured as cluster-eligible are considered: members
    roll Treasury bills over constantly, and including them would bury real
    equity conviction under housekeeping.
    """
    stats = ticker_stats(conn, settings.window_days,
                         asset_types=settings.cluster_asset_types, today=today)
    clusters = []
    for s in stats.values():
        for direction, members, count, volume in (
            ("buy", s.buy_politicians, s.buy_count, s.buy_volume),
            ("sell", s.sell_politicians, s.sell_count, s.sell_volume),
        ):
            reasons = []
            if len(members) >= settings.min_politicians:
                reasons.append(f"{len(members)} members")
            if volume.mid_cents >= settings.min_volume_cents:
                reasons.append("volume")
            if not reasons:
                continue
            clusters.append(Cluster(
                ticker=s.ticker,
                direction=direction,
                politician_count=len(members),
                trade_count=count,
                members=sorted(members),
                volume=volume,
                reason=" + ".join(reasons),
            ))
    clusters.sort(key=lambda c: (c.politician_count, c.volume.mid_cents), reverse=True)
    return clusters


CLUSTER_KIND = "cluster"
INSIDER_CLUSTER_KIND = "insider_cluster"


def is_new_cluster(conn: sqlite3.Connection, cluster: Cluster) -> bool:
    """Whether this cluster is worth sending.

    Re-firing on every run for an unchanged cluster would be spam, so a
    (ticker, direction) only alerts again once more members have joined it.
    """
    from . import db as _db

    previous = _db.last_alert(conn, cluster.ticker, cluster.direction, CLUSTER_KIND)
    if previous is None:
        return True
    return cluster.politician_count > previous["politician_count"]


def is_new_insider_cluster(conn: sqlite3.Connection, cluster: InsiderCluster,
                           growth: float = DEFAULT_CLUSTER_REFIRE_GROWTH) -> bool:
    """Same rule for insiders, but keyed on its own alert kind and damped.

    Without the kind, a congressional cluster on NVDA would suppress an
    insider cluster on NVDA — two unrelated facts sharing a dedupe row.

    Unlike the congressional side, one more insider is not on its own worth a
    second message. Form 4 is due in two business days, so a coordinated board
    purchase lands as a burst of filings over a day or two and the cluster
    grows on nearly every poll: Banco Bradesco (BBD) went 4 → 5 → 10 → 21
    buyers in 24 hours and sent four alerts describing one event. Re-firing
    therefore needs the convergence to be materially bigger — `growth` times
    the size last reported — so 3 → 5 speaks up and 20 → 21 does not.
    """
    from . import db as _db

    key = cluster.ticker or cluster.issuer_cik
    previous = _db.last_alert(conn, key, cluster.direction, INSIDER_CLUSTER_KIND)
    if previous is None:
        return True
    before = previous["politician_count"]
    # At least one more insider, and at least `growth`× the reported size.
    # ceil() so a fractional threshold rounds towards fewer messages.
    return cluster.insider_count >= max(before + 1, math.ceil(before * growth))


def politician_stats(conn: sqlite3.Connection, window_days: int | None = None,
                     limit: int = 50) -> list[dict]:
    """Per-member activity, including average disclosure delay.

    The STOCK Act allows 45 days between trade and disclosure; the delay is
    worth surfacing because it is the one compliance fact these filings prove.
    Measured trade date -> filing date; see `disclosure_delay_days`.
    """
    since = _window_start(window_days) if window_days else None
    rows = _rows(conn, since, tickers_only=False, asset_types=None)

    agg: dict[str, dict] = {}
    for r in rows:
        name = r["member_name"] or "unknown"
        a = agg.setdefault(name, {
            "name": name, "party": r["party"], "state": r["state"],
            "district": r["district"], "chamber": r["chamber"],
            "trade_count": 0, "buy_count": 0, "sell_count": 0,
            "tickers": set(), "volume": Volume(), "delays": [], "lags": [],
        })
        a["trade_count"] += 1
        if r["action"] in BUY_ACTIONS:
            a["buy_count"] += 1
        elif r["action"] in SELL_ACTIONS:
            a["sell_count"] += 1
        if r["ticker"]:
            a["tickers"].add(r["ticker"])
        a["volume"].add(r["amount_min_cents"], r["amount_max_cents"], r["amount_exact_cents"])
        delay = disclosure_delay_days(r["tx_date"], r["filing_date"])
        if delay is not None:
            a["delays"].append(delay)
        lag = notification_lag_days(r["tx_date"], r["notification_date"])
        if lag is not None:
            a["lags"].append(lag)

    out = []
    for a in agg.values():
        a["ticker_count"] = len(a["tickers"])
        a["avg_delay_days"] = round(sum(a["delays"]) / len(a["delays"]), 1) if a["delays"] else None
        a["late_count"] = sum(1 for d in a["delays"] if d > STOCK_ACT_DEADLINE_DAYS)
        a["avg_lag_days"] = round(sum(a["lags"]) / len(a["lags"]), 1) if a["lags"] else None
        out.append(a)
    out.sort(key=lambda a: a["volume"].mid_cents, reverse=True)
    return out[:limit]


def disclosure_delay_days(tx_date: str | None, filing_date: str | None) -> int | None:
    """Days from trade to disclosure — the STOCK Act's 45-day clock.

    Measured against the date the report reached the Clerk, NOT the report's
    "Notification Date" column. Those are different facts and confusing them
    understates compliance badly: a member who trades their own account is
    notified the same day, so the notification column reads zero however long
    the paperwork actually took. Nancy Pelosi's 2026 filings all show
    "05/29/2026 05/29/2026" while the report itself was filed 25 days later.

    Returns None when the dates contradict each other. A few filings carry a
    mistyped year, and a negative delay is not a fact about anyone's
    behaviour.
    """
    return _day_gap(tx_date, filing_date)


def notification_lag_days(tx_date: str | None, notification_date: str | None) -> int | None:
    """Days from trade to the member learning of it.

    Distinct from the disclosure delay and worth keeping: a nonzero lag means
    the member was not the one placing the trade — a spouse's account, a
    managed portfolio, or a trust. It carries no compliance meaning on its own.
    """
    return _day_gap(tx_date, notification_date)


def _day_gap(start: str | None, end: str | None) -> int | None:
    if not start or not end:
        return None
    try:
        delta = (date.fromisoformat(end) - date.fromisoformat(start)).days
    except ValueError:
        return None
    return delta if delta >= 0 else None


def dates_inconsistent(tx_date: str | None, notification_date: str | None) -> bool:
    """Whether a row's dates contradict each other, as filed."""
    if not tx_date or not notification_date:
        return False
    try:
        return date.fromisoformat(notification_date) < date.fromisoformat(tx_date)
    except ValueError:
        return False


# --- insiders (SEC Form 4) ---------------------------------------------------
#
# Insider values are exact — shares × the price as filed — so `Volume` carries
# them through `exact`. Everything here counts *primary* reporting owners
# (owner_index 0): a founder and their holding company on one filing are one
# decision, not two insiders.

# Form 4 is due before the end of the second business day after the trade
# (Exchange Act §16(a)(2)(C)). EDGAR does not accept filings on federal
# holidays, so they do not count against the clock.
FORM4_DEADLINE_BUSINESS_DAYS = 2

_MON, _THU = 0, 3


def federal_holidays(year: int) -> set[date]:
    """US federal holidays as observed (Saturday -> Friday, Sunday -> Monday)."""
    def nth_weekday(month: int, weekday: int, n: int) -> date:
        first = date(year, month, 1)
        offset = (weekday - first.weekday()) % 7
        return first + timedelta(days=offset + 7 * (n - 1))

    def last_weekday(month: int, weekday: int) -> date:
        last = date(year + (month == 12), (month % 12) + 1, 1) - timedelta(days=1)
        return last - timedelta(days=(last.weekday() - weekday) % 7)

    observed = {
        nth_weekday(1, _MON, 3),    # Martin Luther King Jr. Day
        nth_weekday(2, _MON, 3),    # Washington's Birthday
        last_weekday(5, _MON),      # Memorial Day
        nth_weekday(9, _MON, 1),    # Labor Day
        nth_weekday(10, _MON, 2),   # Columbus Day
        nth_weekday(11, _THU, 4),   # Thanksgiving
    }
    for month, day in ((1, 1), (6, 19), (7, 4), (11, 11), (12, 25)):
        d = date(year, month, day)
        if d.weekday() == 5:
            d -= timedelta(days=1)
        elif d.weekday() == 6:
            d += timedelta(days=1)
        observed.add(d)
    return observed


def business_days_between(start: date, end: date) -> int:
    """Business days after `start` up to and including `end`."""
    if end <= start:
        return 0
    holidays: set[date] = set()
    for year in range(start.year, end.year + 2):
        holidays |= federal_holidays(year)
    n = 0
    d = start
    while d < end:
        d += timedelta(days=1)
        if d.weekday() < 5 and d not in holidays:
            n += 1
    return n


def form4_is_late(tx_date: str | None, filing_date: str | None) -> bool | None:
    """Whether a Form 4 row was filed past its two-business-day deadline.

    Derived once at ingest and stored (`insider_transactions.late`): the
    holiday logic has no defensible SQL twin, and a definition that lived in
    two places would drift. None when the dates are missing or contradict
    each other — a filer's typo is not a fact about their punctuality.
    """
    if _day_gap(tx_date, filing_date) is None:
        return None
    return business_days_between(date.fromisoformat(tx_date),
                                 date.fromisoformat(filing_date)) > FORM4_DEADLINE_BUSINESS_DAYS


@dataclass
class IssuerStat:
    issuer_cik: str
    ticker: str | None = None
    issuer_name: str | None = None
    filing_ids: set[int] = field(default_factory=set)
    trade_count: int = 0
    buy_count: int = 0
    sell_count: int = 0
    buy_insiders: set[str] = field(default_factory=set)
    sell_insiders: set[str] = field(default_factory=set)
    insider_names: dict[str, str] = field(default_factory=dict)
    volume: Volume = field(default_factory=Volume)
    buy_volume: Volume = field(default_factory=Volume)
    sell_volume: Volume = field(default_factory=Volume)
    last_tx_date: str | None = None

    @property
    def filing_count(self) -> int:
        return len(self.filing_ids)

    @property
    def insider_count(self) -> int:
        return len(self.buy_insiders | self.sell_insiders)

    def names(self, ciks: set[str]) -> list[str]:
        return sorted(self.insider_names.get(c, c) for c in ciks)


def _insider_rows(conn: sqlite3.Connection, since: str | None,
                  today: date | None = None) -> list[sqlite3.Row]:
    marks = ", ".join("?" for _ in COUNTED_STATUSES)
    sql = f"""
        SELECT t.*, f.issuer_cik, f.issuer_name, f.ticker, f.filing_date, f.aff_10b5_one,
               o.insider_cik, i.name AS insider_name
        FROM insider_transactions t
        JOIN insider_filings f ON f.id = t.filing_id
        LEFT JOIN insider_filing_owners o ON o.filing_id = f.id AND o.owner_index = 0
        LEFT JOIN insiders i ON i.cik = o.insider_cik
        WHERE f.status IN ({marks})
    """
    params: list = list(COUNTED_STATUSES)
    if since:
        # Bounded above as well, like `_rows`: a mistyped future trade date
        # would otherwise sit inside every rolling window forever.
        sql += " AND t.tx_date >= ? AND t.tx_date <= ?"
        params.append(since)
        params.append((today or date.today()).isoformat())
    sql += " ORDER BY t.tx_date, t.id"
    return conn.execute(sql, params).fetchall()


def insider_issuer_stats(conn: sqlite3.Connection, window_days: int | None = None,
                         today: date | None = None) -> dict[str, IssuerStat]:
    """Roll insider trades up per issuer, keyed by issuer CIK."""
    since = _window_start(window_days, today) if window_days else None
    out: dict[str, IssuerStat] = {}
    for r in _insider_rows(conn, since, today):
        s = out.setdefault(r["issuer_cik"], IssuerStat(
            issuer_cik=r["issuer_cik"], ticker=r["ticker"], issuer_name=r["issuer_name"]))
        s.ticker = s.ticker or r["ticker"]
        s.filing_ids.add(r["filing_id"])
        s.trade_count += 1
        who = r["insider_cik"] or "unknown"
        if r["insider_name"]:
            s.insider_names[who] = r["insider_name"]
        amounts = (r["amount_min_cents"], r["amount_max_cents"], r["amount_exact_cents"])
        # A row without a price has an unknown value, not an open-ended one:
        # it counts as a trade and adds nothing to any total.
        priced = any(a is not None for a in amounts)
        if priced:
            s.volume.add(*amounts)
        if r["action"] in BUY_ACTIONS:
            s.buy_count += 1
            s.buy_insiders.add(who)
            if priced:
                s.buy_volume.add(*amounts)
        elif r["action"] in SELL_ACTIONS:
            s.sell_count += 1
            s.sell_insiders.add(who)
            if priced:
                s.sell_volume.add(*amounts)
        if r["tx_date"] and (s.last_tx_date is None or r["tx_date"] > s.last_tx_date):
            s.last_tx_date = r["tx_date"]
    return out


def top_insider_issuers(conn: sqlite3.Connection, window_days: int | None = None,
                        by: str = "value", direction: str | None = None,
                        limit: int = 25, today: date | None = None) -> list[IssuerStat]:
    """Issuer leaderboard by traded value or by number of distinct insiders."""
    issuers = list(insider_issuer_stats(conn, window_days, today).values())
    if direction == "buy":
        issuers = [s for s in issuers if s.buy_count]
        value = lambda s: s.buy_volume.mid_cents  # noqa: E731
        people = lambda s: len(s.buy_insiders)  # noqa: E731
    elif direction == "sell":
        issuers = [s for s in issuers if s.sell_count]
        value = lambda s: s.sell_volume.mid_cents  # noqa: E731
        people = lambda s: len(s.sell_insiders)  # noqa: E731
    else:
        value = lambda s: s.volume.mid_cents  # noqa: E731
        people = lambda s: s.insider_count  # noqa: E731
    key = (lambda s: (people(s), value(s))) if by == "insiders" else (lambda s: (value(s), people(s)))
    return sorted(issuers, key=key, reverse=True)[:limit]


@dataclass
class InsiderCluster:
    issuer_cik: str
    ticker: str | None
    issuer_name: str | None
    direction: str
    insider_count: int
    filing_count: int
    trade_count: int
    insiders: list[str]
    volume: Volume


def find_insider_clusters(conn: sqlite3.Connection, settings: InsiderSettings,
                          today: date | None = None, window_days: int | None = None,
                          min_insiders: int | None = None) -> list[InsiderCluster]:
    """Issuers where several distinct insiders traded the same way in the window.

    Buys and sells are evaluated separately and never pooled. The count is of
    primary reporting owners, so a joint filing contributes one insider.

    `window_days` and `min_insiders` override the configured defaults, which is
    what lets one alert rule ask for "3 buyers in 30 days" while another asks
    for "5 in 90".
    """
    window = window_days or settings.cluster_window_days
    floor = settings.min_insiders if min_insiders is None else min_insiders
    clusters = []
    for s in insider_issuer_stats(conn, window, today).values():
        for direction, insiders, count, volume in (
            ("buy", s.buy_insiders, s.buy_count, s.buy_volume),
            ("sell", s.sell_insiders, s.sell_count, s.sell_volume),
        ):
            if len(insiders) < floor:
                continue
            clusters.append(InsiderCluster(
                issuer_cik=s.issuer_cik, ticker=s.ticker, issuer_name=s.issuer_name,
                direction=direction, insider_count=len(insiders),
                filing_count=s.filing_count, trade_count=count,
                insiders=s.names(insiders), volume=volume,
            ))
    clusters.sort(key=lambda c: (c.insider_count, c.volume.mid_cents), reverse=True)
    return clusters
