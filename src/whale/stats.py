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

import sqlite3
from dataclasses import dataclass, field
from datetime import date, timedelta

from .config import AlertSettings
from .db import COUNTED_STATUSES

# Actions that move money in a direction we can aggregate. Exchanges have no
# net direction and are excluded from buy/sell rollups.
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
               p.party, p.state, p.district, p.chamber
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


def is_new_cluster(conn: sqlite3.Connection, cluster: Cluster) -> bool:
    """Whether this cluster is worth sending.

    Re-firing on every run for an unchanged cluster would be spam, so a
    (ticker, direction) only alerts again once more members have joined it.
    """
    from . import db as _db

    previous = _db.last_alert(conn, cluster.ticker, cluster.direction)
    if previous is None:
        return True
    return cluster.politician_count > previous["politician_count"]


def politician_stats(conn: sqlite3.Connection, window_days: int | None = None,
                     limit: int = 50) -> list[dict]:
    """Per-member activity, including average disclosure delay.

    The STOCK Act allows 45 days between trade and disclosure; the delay is
    worth surfacing because it is the one compliance fact these filings prove.
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
            "tickers": set(), "volume": Volume(), "delays": [],
        })
        a["trade_count"] += 1
        if r["action"] in BUY_ACTIONS:
            a["buy_count"] += 1
        elif r["action"] in SELL_ACTIONS:
            a["sell_count"] += 1
        if r["ticker"]:
            a["tickers"].add(r["ticker"])
        a["volume"].add(r["amount_min_cents"], r["amount_max_cents"], r["amount_exact_cents"])
        delay = disclosure_delay_days(r["tx_date"], r["notification_date"])
        if delay is not None:
            a["delays"].append(delay)

    out = []
    for a in agg.values():
        a["ticker_count"] = len(a["tickers"])
        a["avg_delay_days"] = round(sum(a["delays"]) / len(a["delays"]), 1) if a["delays"] else None
        a["late_count"] = sum(1 for d in a["delays"] if d > 45)
        out.append(a)
    out.sort(key=lambda a: a["volume"].mid_cents, reverse=True)
    return out[:limit]


def disclosure_delay_days(tx_date: str | None, notification_date: str | None) -> int | None:
    """Days from trade to disclosure, or None when the dates make no sense.

    A handful of filings carry a mistyped year (one 2026 filing reports a trade
    date of 12/26/2026 disclosed on 01/21/2026). The parse is faithful to the
    PDF, but a negative delay is not a fact about anyone's behaviour, so it is
    reported as unknown rather than as "-339 days".
    """
    if not tx_date or not notification_date:
        return None
    try:
        delta = (date.fromisoformat(notification_date) - date.fromisoformat(tx_date)).days
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
