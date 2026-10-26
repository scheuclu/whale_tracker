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

import bisect
import math
import re
import sqlite3
import statistics
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone

from .amounts import usd
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


def trade_direction(action: str, option_kind: str | None = None,
                    count_options: bool | None = None) -> str | None:
    """Which way a row moves a ticker: 'buy', 'sell', or None for neither.

    An exchange is neither. For a stock the action says it all. For a row
    whose option contract was parsed (`transactions.option_kind`) the action
    alone misleads — buying a put is a bet against the stock, and the cluster
    finder would have read it as a buy — so `count_options` decides:

    * None   as filed: the action's own direction (every view that is not
             the cluster finder reproduces the filing);
    * True   by exposure: a call keeps the action's direction and a put
             reverses it, so a bought put is a sell and a sold put a buy
             (`alerts.cluster_count_options`);
    * False  neither: the row counts toward no direction at all.

    A row typed OP whose text named no contract has no `option_kind` and is
    counted as filed under every setting: nothing more is known about it.
    """
    if action in BUY_ACTIONS:
        base = "buy"
    elif action in SELL_ACTIONS:
        base = "sell"
    else:
        return None
    if option_kind is None or count_options is None:
        return base
    if not count_options:
        return None
    if option_kind == "put":
        return "sell" if base == "buy" else "buy"
    return base


# Filings read by transcribing a scanned paper form (`filings.parse_method`).
# Their rows count as trades and toward member and ticker lists, but add
# nothing to any volume sum, cluster volume or per-member floor: the amount
# is a checkbox read off a scan, not a bracket parsed from a filed text
# layer, and a wrong one would corrupt the totals in the one place nobody
# checks. Mirrors `TRANSCRIBED` in web/lib/queries.ts — keep them in step.
TRANSCRIBED_METHOD = "vision"


def counts_toward_volume(parse_method: str | None) -> bool:
    """Whether a row's disclosed amount may enter a total."""
    return parse_method != TRANSCRIBED_METHOD


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
    # Per member, the sum of what their rows prove: the bracket floor, or the
    # exact figure when one was filed. Never the midpoint — that is an
    # estimate, and it must not decide who counts as a cluster participant.
    buy_floors: dict[str, int] = field(default_factory=dict)
    sell_floors: dict[str, int] = field(default_factory=dict)
    last_tx_date: str | None = None
    # Rows transcribed from a scanned paper filing: counted as trades, worth
    # nothing to any volume or floor. See `counts_toward_volume`.
    transcribed_count: int = 0

    @property
    def net_direction(self) -> str:
        if self.buy_volume.mid_cents > self.sell_volume.mid_cents:
            return "buy"
        if self.sell_volume.mid_cents > self.buy_volume.mid_cents:
            return "sell"
        return "flat"


def _floor_cents(lo: int | None, hi: int | None, exact: int | None) -> int:
    """What a row proves was traded: the exact figure if filed, else the floor."""
    if exact is not None:
        return exact
    return lo or 0


def _window_start(days: int, today: date | None = None) -> str:
    return ((today or date.today()) - timedelta(days=days)).isoformat()


def _rows(conn: sqlite3.Connection, since: str | None, tickers_only: bool,
          asset_types: list[str] | None, today: date | None = None) -> list[sqlite3.Row]:
    marks = ", ".join("?" for _ in COUNTED_STATUSES)
    sql = f"""
        SELECT t.*, COALESCE(p.full_name, f.filer_name) AS member_name,
               p.party, p.state, p.district, p.chamber, f.filing_date,
               f.parse_method
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
                 today: date | None = None,
                 count_options: bool | None = None) -> dict[str, TickerStat]:
    """Roll transactions up per ticker: volume, participation, buy/sell split.

    `count_options` is how a row with a parsed option contract joins the
    buy/sell split — see `trade_direction`. The default reproduces the
    filing; only the cluster finder passes the configured setting.
    """
    since = _window_start(window_days, today) if window_days else None
    stats: dict[str, TickerStat] = {}

    for r in _rows(conn, since, tickers_only=True, asset_types=asset_types, today=today):
        s = stats.setdefault(r["ticker"], TickerStat(ticker=r["ticker"]))
        s.asset_name = s.asset_name or r["asset_name"]
        s.trade_count += 1
        member = r["member_name"] or "unknown"
        amounts = (r["amount_min_cents"], r["amount_max_cents"], r["amount_exact_cents"])
        # A transcribed row is a trade with an unvouched amount: it counts
        # as a trade and a participant, and adds nothing to any sum or floor.
        priced = counts_toward_volume(r["parse_method"])
        if not priced:
            s.transcribed_count += 1
        if priced:
            s.volume.add(*amounts)

        direction = trade_direction(r["action"], r["option_kind"], count_options)
        if direction == "buy":
            s.buy_count += 1
            s.buy_politicians.add(member)
            if priced:
                s.buy_volume.add(*amounts)
                s.buy_floors[member] = s.buy_floors.get(member, 0) + _floor_cents(*amounts)
        elif direction == "sell":
            s.sell_count += 1
            s.sell_politicians.add(member)
            if priced:
                s.sell_volume.add(*amounts)
                s.sell_floors[member] = s.sell_floors.get(member, 0) + _floor_cents(*amounts)

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
    # Members who cleared the per-member floor. `members` names them; the
    # ones who traded the same way but below the floor are in `below_floor`,
    # mentioned by the alert but never counted.
    politician_count: int
    trade_count: int
    members: list[str]
    volume: Volume
    reason: str
    member_floor_cents: int = 0
    below_floor: list[str] = field(default_factory=list)


def find_clusters(conn: sqlite3.Connection, settings: AlertSettings,
                  today: date | None = None) -> list[Cluster]:
    """Tickers where enough members converged with enough volume in the window.

    Both thresholds must hold; they used to be alternatives, and 32 of the
    first 33 alerts sent were noise. Participation alone is base rate: 83% of
    equity-like rows are in the $1,001–$15,000 bracket and the most widely
    held names collect ten or more distinct buyers a year regardless of any
    event, so "3 members bought MSFT" is the normal state of MSFT. Volume
    alone is one member's trade, which that filing's own message already
    reports — a single member is never a cluster.

    A member counts only if the floors of their brackets in the window sum to
    `min_member_floor_usd`. Floors, not midpoints: the floor is what the
    filing proves. The window's volume and trade count stay those of every
    trade in that direction, so the alert describes the whole picture while
    its headline number is the one it fired on.

    Only asset types configured as cluster-eligible are considered: members
    roll Treasury bills over constantly, and including them would bury real
    equity conviction under housekeeping.

    An option row whose contract was parsed joins a direction only as
    `alerts.cluster_count_options` says: by exposure (a call a buy, a put a
    sell) when on, not at all when off. Either way a bought put is never
    read as a buy, which is what the action alone used to say.
    """
    stats = ticker_stats(conn, settings.window_days,
                         asset_types=settings.cluster_asset_types, today=today,
                         count_options=settings.cluster_count_options)
    floor = settings.min_member_floor_cents
    clusters = []
    for s in stats.values():
        for direction, members, floors, count, volume in (
            ("buy", s.buy_politicians, s.buy_floors, s.buy_count, s.buy_volume),
            ("sell", s.sell_politicians, s.sell_floors, s.sell_count, s.sell_volume),
        ):
            counted = sorted(m for m in members if floors.get(m, 0) >= floor)
            if len(counted) < settings.min_politicians:
                continue
            if volume.mid_cents < settings.min_volume_cents:
                continue
            clusters.append(Cluster(
                ticker=s.ticker,
                direction=direction,
                politician_count=len(counted),
                trade_count=count,
                members=counted,
                volume=volume,
                reason=(f"{len(counted)} members at ≥{usd(floor)} floor"
                        f" + est. volume {usd(volume.mid_cents)}"),
                member_floor_cents=floor,
                below_floor=sorted(members.difference(counted)),
            ))
    clusters.sort(key=lambda c: (c.politician_count, c.volume.mid_cents), reverse=True)
    return clusters


# `alerts.kind`: what fired. The two cluster kinds are also dedupe keys, so
# `db.last_alert` must always be asked for one of them by name. The others
# are logged per message so the /alerts page is the whole history.
CLUSTER_KIND = "cluster"
INSIDER_CLUSTER_KIND = "insider_cluster"
FILING_KIND = "filing"
WATCHLIST_KIND = "watchlist"
INSIDER_FILING_KIND = "insider_filing"
# Option alerts (`alerts.options_every_trade`, #58) are split per transaction
# like a watched member's filing and logged the same way, one row per message.
OPTIONS_KIND = "options"
ALERT_KINDS = (CLUSTER_KIND, INSIDER_CLUSTER_KIND, FILING_KIND, WATCHLIST_KIND,
               INSIDER_FILING_KIND, OPTIONS_KIND)
# One row per filing whose every trade was disclosed past the deadline. The
# `alerts` table has no filing column, so the row is keyed the way `filings`
# is unique: `ticker` holds the Clerk's document id and `direction` the
# chamber. `window_days` is the deadline it was judged by and
# `politician_count` the number of late trades. See `is_new_late_filing`.
LATE_FILING_KIND = "late_filing"
# Not in ALERT_KINDS: it is a marker beside the filing's own `filing` row, not
# a message of its own, so the /alerts page does not list it.


def is_new_cluster(conn: sqlite3.Connection, cluster: Cluster,
                   today: date | None = None) -> bool:
    """Whether this cluster is worth sending.

    Re-firing on every run for an unchanged cluster would be spam, so a
    (ticker, direction) only alerts again once more members have joined it.

    Only while the last alert's own window still overlaps today's: an alert
    fired at T with window W described trades in [T-W, T], and once today is
    past T+W those trades cannot be the convergence being looked at now. Left
    unbounded, the count recorded then would suppress a smaller, genuine
    cluster a year later — and the counts recorded before the per-member
    floor existed are inflated by exactly the members it no longer counts.
    """
    from . import db as _db

    previous = _db.last_alert(conn, cluster.ticker, cluster.direction, CLUSTER_KIND)
    if previous is None:
        return True
    fired = date.fromisoformat(previous["fired_at"][:10])
    if (today or date.today()) > fired + timedelta(days=previous["window_days"]):
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


def filing_late_by_days(delays, deadline_days: int) -> int | None:
    """How late a filing is when every trade in it is past the deadline.

    The report was due `deadline_days` after its earliest trade, so the
    figure is the longest delay minus the deadline: how many days past its
    due date the report reached the Clerk. The per-trade delays are each
    row's own clock; this is the filing's.

    None when the feature is off (`deadline_days` 0), when any trade is
    inside the deadline — the filing is then partly on time, and the
    per-trade lines say which rows were not — or when any delay is unknown:
    a filing whose dates contradict each other cannot be called all-late.
    """
    if deadline_days <= 0:
        return None
    delays = list(delays)
    if not delays or any(d is None for d in delays):
        return None
    if min(delays) <= deadline_days:
        return None
    return max(delays) - deadline_days


def is_new_late_filing(conn: sqlite3.Connection, chamber: str, doc_id: str) -> bool:
    """Whether no `late_filing` alert has been recorded for this filing.

    Deduped per filing, and keyed on the filing itself (document id and
    chamber: what `filings` is unique on), so a late filing is recorded once
    however many times its message is rebuilt. Kind-scoped, like every other
    dedupe: a cluster row on the same key must not suppress it.
    """
    from . import db as _db

    return _db.last_alert(conn, doc_id, chamber, LATE_FILING_KIND) is None


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
            "transcribed_count": 0,
        })
        a["trade_count"] += 1
        if r["action"] in BUY_ACTIONS:
            a["buy_count"] += 1
        elif r["action"] in SELL_ACTIONS:
            a["sell_count"] += 1
        if r["ticker"]:
            a["tickers"].add(r["ticker"])
        if counts_toward_volume(r["parse_method"]):
            a["volume"].add(r["amount_min_cents"], r["amount_max_cents"],
                            r["amount_exact_cents"])
        else:
            a["transcribed_count"] += 1
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


# Implausible as-filed values. The recurring Form 4 mistake is a price cell
# that holds the *aggregate* consideration: SL Science (SLBT) filed 4,545,306
# shares at $2,272,653.00 — the footnote says "aggregate purchase price of
# US$2,272,653" — and the stored value became $10.3 trillion, four orders of
# magnitude above every real row in the table. InnSuites (IHT, a ~$1.50
# stock) did the same twice ($22,593.60 and $50,410.80 a share), and a
# $5 microcap (UUU) once ($5,134.00). The row stays as filed; the flag keeps
# its value out of every total and threshold. Thresholds are from the corpus:
#
# - Value above $5B. The largest real row stored is a $1.86B block sale
#   (FANG, 9.1M shares at $205.26); $5B is 2.7× that record. A genuine block
#   above it would be flagged and listed by the audit for a human to judge,
#   which beats a phantom $10T leading the leaderboard.
# - Price above $10,000 with at least 1,000 shares. No US common stock other
#   than BRK.A (~$700k) is quoted above $10,000, and the highest real price
#   stored is SNDK at $1,734.94; the IHT rows sit at $22k–$50k. Price alone
#   is not enough — a director buying a handful of BRK.A is real — so the
#   share count is the second signal: 1,000 A-shares in one open-market row
#   would be $700M, nothing like which is stored, while the
#   aggregate-in-price-cell error produces exactly this shape (many shares,
#   absurd price).
# - Price more than 20× the median price in the issuer's *other* stored
#   filings. Catches the error for an issuer with a history (UUU: $5,134
#   against a $5.05 median) at a price the absolute floor would miss. Other
#   filings, not other rows: the mistake is per filing, so a filing's rows
#   agree with each other. 20× leaves room for a 1:10 reverse split; a
#   1:20 or larger one would flag the first post-split filing until the
#   history catches up (`backfill-insiders --recompute-implausible`).
#
# What it cannot catch: an issuer whose only stored rows are mispriced, at a
# price under $10,000 (or under 1,000 shares) and a value under $5B — there
# is nothing to compare against.
IMPLAUSIBLE_VALUE_CENTS = 5_000_000_000 * 100
IMPLAUSIBLE_PRICE_USD = 10_000.0
IMPLAUSIBLE_PRICE_MIN_SHARES = 1_000.0
IMPLAUSIBLE_PRICE_RATIO = 20.0


def form4_is_implausible(shares: float | None, price_per_share: float | None,
                         value_cents: int | None,
                         reference_price: float | None = None) -> bool | None:
    """Whether a Form 4 row's as-filed value is beyond belief.

    Derived once at ingest and stored (`insider_transactions.implausible`),
    like `late`; SQL reads the column. `reference_price` is the issuer's
    median price across its other stored filings (`issuer_reference_price`),
    or None when there are none. None when the row has no value to judge.
    """
    if shares is None or price_per_share is None or value_cents is None:
        return None
    if value_cents > IMPLAUSIBLE_VALUE_CENTS:
        return True
    if price_per_share > IMPLAUSIBLE_PRICE_USD and shares >= IMPLAUSIBLE_PRICE_MIN_SHARES:
        return True
    if reference_price and price_per_share > IMPLAUSIBLE_PRICE_RATIO * reference_price:
        return True
    return False


def issuer_reference_price(conn: sqlite3.Connection, issuer_cik: str | None,
                           exclude_filing_id: int | None = None) -> float | None:
    """Median price per share across the issuer's other counted filings.

    The filing being judged is left out so that a re-parse does not compare
    a filing against its own earlier rows.
    """
    if not issuer_cik:
        return None
    marks = ", ".join("?" for _ in COUNTED_STATUSES)
    sql = f"""
        SELECT t.price_per_share FROM insider_transactions t
        JOIN insider_filings f ON f.id = t.filing_id
        WHERE f.issuer_cik = ? AND f.status IN ({marks})
          AND t.price_per_share IS NOT NULL AND t.price_per_share > 0
    """
    params: list = [issuer_cik, *COUNTED_STATUSES]
    if exclude_filing_id is not None:
        sql += " AND t.filing_id != ?"
        params.append(exclude_filing_id)
    prices = [r[0] for r in conn.execute(sql, params)]
    return statistics.median(prices) if prices else None


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
    # Rows flagged `implausible`: counted as trades, worth nothing to any
    # volume. See `form4_is_implausible`.
    implausible_count: int = 0

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
        # it counts as a trade and adds nothing to any total. An implausible
        # as-filed value is unknown in the same way — never a large one.
        priced = any(a is not None for a in amounts)
        if r["implausible"] == 1:
            s.implausible_count += 1
            priced = False
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
        if not s.ticker:
            # Filed as NONE / N/A: a non-listed vehicle. A convergence there is
            # not actionable, and its alert would have to be keyed on a bare
            # CIK — two of the first cluster alerts read "0001742952".
            continue
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


# --- alert outcomes (what the ticker did next) --------------------------------
#
# Whether an alert carried any signal is measured by the alerted ticker's own
# move after it, close to close, against the benchmark over the same trading
# days. This is the ticker's move, never a trade's return: congressional
# amounts are brackets, nothing here touches one, and no position is assumed.
# Derived once here and stored in `alert_outcomes` by prices.sync; SQL and the
# dashboard read the stored columns and never re-derive a return.

BENCHMARK_TICKER = "SPY"
OUTCOME_HORIZONS = (5, 20, 60)
# Fewer alerts than this and a median or hit rate is an anecdote: reported as
# "insufficient data" rather than as a figure. Mirrors MIN_SAMPLE in
# web/lib/outcome-queries.ts — keep them in step.
MIN_OUTCOME_SAMPLE = 5

# Two early insider clusters were keyed on the issuer's bare CIK because the
# Form 4 carried no trading symbol. Nothing lists them, so nothing prices them.
_CIK_SHAPED_RE = re.compile(r"^\d{10}$")

try:
    from zoneinfo import ZoneInfo

    EASTERN = ZoneInfo("America/New_York")
except Exception:  # no tz database on this host: fall back to standard time
    EASTERN = timezone(timedelta(hours=-5), "EST")  # type: ignore[assignment]


def is_listed_ticker(ticker: str | None) -> bool:
    """Whether an alert's key is a symbol a price series could exist for.
    Mirrors `isListedTicker` in web/lib/outcome-queries.ts."""
    return bool(ticker) and not _CIK_SHAPED_RE.match(ticker)


def alert_date_eastern(fired_at: str) -> date:
    """The alert's calendar date in US market time.

    `fired_at` is UTC, and the poll runs at 00:00 and 03:00 UTC are still the
    previous evening in New York: an alert at 02:11Z on a Saturday went out
    on Friday evening, after Friday's close. Day 0 is that Friday, so the
    measurement starts from the last close before the alert and the next
    session's reaction is inside it — which is what an event study wants.
    """
    stamp = datetime.fromisoformat(fired_at.replace(" ", "T").replace("Z", "+00:00"))
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=timezone.utc)
    return stamp.astimezone(EASTERN).date()


@dataclass
class AlertOutcome:
    alert_id: int
    kind: str
    ticker: str
    direction: str | None
    t0_date: str
    t0_close: float
    # Trading days after t0 the benchmark series covers; a horizon past it
    # is pending, not missing.
    days_elapsed: int
    returns: dict[int, float | None] = field(default_factory=dict)
    benchmark: dict[int, float | None] = field(default_factory=dict)
    excess: dict[int, float | None] = field(default_factory=dict)

    def row(self) -> dict:
        """The `alert_outcomes` columns (db.OUTCOME_COLUMNS)."""
        out = {"alert_id": self.alert_id, "ticker": self.ticker, "t0_date": self.t0_date,
               "t0_close": self.t0_close, "days_elapsed": self.days_elapsed}
        for h in OUTCOME_HORIZONS:
            out[f"ret_{h}"] = self.returns.get(h)
            out[f"bench_{h}"] = self.benchmark.get(h)
            out[f"excess_{h}"] = self.excess.get(h)
        return out


def _price_series(conn: sqlite3.Connection) -> dict[str, dict[str, float]]:
    series: dict[str, dict[str, float]] = {}
    for r in conn.execute("SELECT ticker, date, close FROM prices WHERE close > 0"):
        series.setdefault(r["ticker"], {})[r["date"]] = r["close"]
    return series


def alert_outcomes(conn: sqlite3.Connection, benchmark: str = BENCHMARK_TICKER,
                   horizons: tuple[int, ...] = OUTCOME_HORIZONS) -> list[AlertOutcome]:
    """What each alert's ticker did at +5/+20/+60 trading days, minus the benchmark.

    The trading calendar is the benchmark's own series: a day with a SPY close
    is a session, so holidays and weekends fall out without a calendar of
    their own. t0 is the first session on or after the alert's US-Eastern date
    (an alert on Labor Day measures from the Tuesday close); horizon h is the
    h-th session after it, and its return is close(t0+h) / close(t0) − 1 for
    the ticker and for the benchmark alike, the excess being the difference.
    A horizon the series does not reach yet is None, as is one where the
    ticker has no close that day. An alert whose ticker has no close on t0 —
    no series at all, or one that ends before the alert — has no outcome.
    """
    series = _price_series(conn)
    bench = series.get(benchmark)
    if not bench:
        return []
    calendar = sorted(bench)
    out: list[AlertOutcome] = []
    for a in conn.execute(
            "SELECT id, kind, ticker, direction, fired_at FROM alerts "
            "WHERE ticker IS NOT NULL ORDER BY id"):
        if not is_listed_ticker(a["ticker"]):
            continue
        closes = series.get(a["ticker"])
        if not closes:
            continue
        i0 = bisect.bisect_left(calendar, alert_date_eastern(a["fired_at"]).isoformat())
        if i0 >= len(calendar):
            continue
        t0 = calendar[i0]
        c0 = closes.get(t0)
        if c0 is None:
            continue
        o = AlertOutcome(alert_id=a["id"], kind=a["kind"], ticker=a["ticker"],
                         direction=a["direction"], t0_date=t0, t0_close=c0,
                         days_elapsed=len(calendar) - 1 - i0)
        for h in horizons:
            if i0 + h >= len(calendar):
                o.returns[h] = o.benchmark[h] = o.excess[h] = None
                continue
            day = calendar[i0 + h]
            o.benchmark[h] = bench[day] / bench[t0] - 1
            ch = closes.get(day)
            o.returns[h] = None if ch is None else ch / c0 - 1
            o.excess[h] = None if ch is None else o.returns[h] - o.benchmark[h]
        out.append(o)
    return out


def signed_excess(excess: float | None, direction: str | None) -> float | None:
    """The excess return read the way the alert pointed.

    A sell alert is a claim that the ticker will fall, so its hit is a fall:
    the sign is flipped for 'sell' and left for 'buy'. An alert with no one
    direction (a filing on both sides) made no directional claim and is
    excluded from every aggregate. Mirrors `signedExcess` in the web query.
    """
    if excess is None or direction not in ("buy", "sell"):
        return None
    return -excess if direction == "sell" else excess


@dataclass
class OutcomeStat:
    kind: str
    horizon: int
    n: int
    # Median of the direction-signed excess returns; None when n is 0.
    median_excess: float | None
    # Share of alerts whose signed excess was positive; None when n is 0.
    hit_rate: float | None
    min_sample: int = MIN_OUTCOME_SAMPLE

    @property
    def sufficient(self) -> bool:
        return self.n >= self.min_sample


def outcome_summary(conn: sqlite3.Connection, min_sample: int = MIN_OUTCOME_SAMPLE,
                    horizons: tuple[int, ...] = OUTCOME_HORIZONS) -> list[OutcomeStat]:
    """Per alert kind and horizon: n, median signed excess, hit rate.

    Read from the stored `alert_outcomes` rows, so the CLI and the dashboard
    (`summarize` in web/lib/outcome-queries.ts) aggregate the same figures
    the same way: median with the even-count average, a hit being a signed
    excess strictly above zero. Kinds with no outcome row at all are left
    out; a kind is listed with n = 0 at a horizon none of its alerts reach.
    """
    cols = ", ".join(f"o.excess_{h}" for h in horizons)
    rows = conn.execute(
        f"SELECT a.kind, a.direction, {cols} FROM alert_outcomes o "
        "JOIN alerts a ON a.id = o.alert_id"
    ).fetchall()
    kinds = [k for k in ALERT_KINDS if any(r["kind"] == k for r in rows)]
    kinds += sorted({r["kind"] for r in rows} - set(ALERT_KINDS))
    out = []
    for kind in kinds:
        for h in horizons:
            signed = [s for r in rows if r["kind"] == kind
                      for s in [signed_excess(r[f"excess_{h}"], r["direction"])]
                      if s is not None]
            out.append(OutcomeStat(
                kind=kind, horizon=h, n=len(signed),
                median_excess=statistics.median(signed) if signed else None,
                hit_rate=sum(1 for s in signed if s > 0) / len(signed) if signed else None,
                min_sample=min_sample))
    return out


# --- track record (how the stock moved after each member's decisions) -------
#
# "Whose trades were followed by the biggest market-beating moves." The unit
# is a *decision*: one member, one ticker, one direction, one filing. Thirty
# rows for one ticker in one filing are one decision; thirty tickers are
# thirty. Each decision is measured as the ticker's own move after it, close
# to close, minus SPY's over the same sessions, at 30/90/180 trading days,
# read the way the trade pointed (a sale followed by a fall scores positive),
# on two clocks: from the trade date (the member's timing) and from the
# disclosure (what a member of the public could have copied).
#
# No dollar figure enters any of it. Brackets are not amounts, so every
# decision has weight one and the bracket rules are untouched. It is the
# stock's move, not anyone's profit: the exit, the position size and
# dividends are all unknown (closes are split-adjusted, dividends ignored on
# both sides). Derived once here and stored by track.sync; SQL reads the
# stored columns and never re-derives a score.

TRACK_HORIZONS = (30, 90, 180)
TRACK_DEFAULT_HORIZON = 90
TRACK_CLOCKS = ("trade", "disclosure")
# Stocks and exchange-traded funds/notes: a linear position in a listed
# symbol. Options (non-linear), bonds, Treasuries, funds, crypto, RSUs and
# rows with no asset type are not decisions this can price fairly.
TRACK_ASSET_TYPES = ("ST", "EF", "ET")
# Fewer matured decisions than this and a member is listed as "not enough
# matured trades yet", never ranked.
TRACK_MIN_DECISIONS = 8
# ... spread over at least this many filings. A filing is one moment in the
# market: nine tickers bought on one day are one bet on that day, and a
# bootstrap over one or two filings has nothing to re-draw (a one-filing
# member's interval came out narrow and away from zero on the real data).
TRACK_MIN_FILINGS = 3
# Members need this many decisions to inform the shrinkage fit (shrinkage_k).
TRACK_FIT_MIN_DECISIONS = 5
TRACK_BOOTSTRAP_DRAWS = 1000
TRACK_LUCK_DRAWS = 1000
TRACK_SEED = 20261024
TRACK_INTERVAL = 0.90
# The luck check draws, for each of a member's decisions, a ticker move from
# other members' decisions that started within this many calendar days; a
# thinner neighbourhood is widened to the nearest TRACK_LUCK_MIN_POOL.
TRACK_LUCK_WINDOW_DAYS = 7
TRACK_LUCK_MIN_POOL = 20
# ... but never past this many days, and only where at least this many other
# members traded: otherwise there is no comparable universe on that date.
TRACK_LUCK_MAX_DAYS = 30
TRACK_LUCK_MIN_MEMBERS = 3

# Why a row (or a decision) is not measured, in the order they are tested:
# the first that applies is the one counted.
TRACK_EXCLUSIONS = (
    "transcribed",      # read off a scanned form: quarantined from every statistic
    "exchange",         # no direction (exchanges, unknown actions)
    "no_ticker",        # nothing to price
    "option",           # non-linear payoff: option_kind set, or asset type OP
    "non_equity",       # bonds, Treasuries, funds, crypto, no asset type ...
    "date_as_filed",    # missing, contradictory or future dates, reproduced as filed
    "no_price_series",  # the price source carries no series for the ticker
)


def track_row_exclusion(row, today: date) -> str | None:
    """Why a counted transaction row cannot join a measured decision, or None.

    `row` needs action, ticker, asset_type, option_kind, parse_method,
    tx_date, notification_date and filing_date. Dates are never corrected:
    a row whose trade date is missing, in the future, after its own filing
    date or after its notification date is excluded and counted instead.
    """
    if not counts_toward_volume(row["parse_method"]):
        return "transcribed"
    if trade_direction(row["action"]) is None:
        return "exchange"
    if not (row["ticker"] or "").strip():
        return "no_ticker"
    if row["option_kind"] or row["asset_type"] == "OP":
        return "option"
    if row["asset_type"] not in TRACK_ASSET_TYPES:
        return "non_equity"
    try:
        traded = date.fromisoformat(row["tx_date"] or "")
        filed = date.fromisoformat(row["filing_date"] or "")
    except ValueError:
        return "date_as_filed"
    if traded > today or filed < traded or dates_inconsistent(row["tx_date"],
                                                              row["notification_date"]):
        return "date_as_filed"
    return None


def insider_track_row_exclusion(row, today: date) -> str | None:
    """`track_row_exclusion` for a stored Form 4 row (insider_track).

    Every stored row is an open-market purchase or sale of the issuer's own
    equity (form4 keeps only P/S codes from the non-derivative table), so the
    asset-type and option tests have nothing to catch and nothing is ever
    transcribed. What remains: a direction, a ticker to price (the issuer's
    listed symbol; NULL for NONE / N/A), and dates as filed — a trade date
    that is missing, in the future or after the filing is counted, never
    corrected.
    """
    if trade_direction(row["action"]) is None:
        return "exchange"
    if not (row["ticker"] or "").strip():
        return "no_ticker"
    try:
        traded = date.fromisoformat(row["tx_date"] or "")
        filed = date.fromisoformat((row["filing_date"] or "")[:10])
    except ValueError:
        return "date_as_filed"
    if traded > today or filed < traded:
        return "date_as_filed"
    return None


@dataclass
class TrackDecision:
    """One (member, ticker, direction, filing) group of counted rows.

    For insiders (insider_track) `member_name` carries the primary owner's
    CIK — the key a decision is grouped and scored by — and `politician_id`
    is None."""

    filing_id: int
    member_name: str
    politician_id: int | None
    ticker: str
    direction: str
    # Earliest trade date among the group's rows (as filed), and the filing date.
    tx_date: str | None
    filing_date: str | None
    rows: int
    # None when measured; otherwise the TRACK_EXCLUSIONS reason.
    exclusion: str | None = None


def group_track_decisions(rows, today: date,
                          exclusion=None) -> tuple[list[TrackDecision], dict[str, int]]:
    """Fold counted rows into decisions; returns them and rows per outcome.

    `exclusion` is the row test (`track_row_exclusion` by default, or
    `insider_track_row_exclusion`). Rows that pass it group into one decision per
    (filing, ticker, direction), dated by the group's earliest trade. A
    group with no eligible row but a ticker and a direction is kept as an
    excluded decision (reason: its rows' first in `TRACK_EXCLUSIONS` order)
    so coverage can be counted in decisions as well as rows; if the same key
    also has eligible rows, the excluded rows are counted but form nothing.
    The row tally is keyed by reason, plus "included".
    """
    exclusion = exclusion or track_row_exclusion
    tally: dict[str, int] = {}
    eligible: dict[tuple, TrackDecision] = {}
    excluded: dict[tuple, TrackDecision] = {}
    for r in rows:
        reason = exclusion(r, today)
        tally[reason or "included"] = tally.get(reason or "included", 0) + 1
        direction = trade_direction(r["action"])
        ticker = (r["ticker"] or "").strip().upper()
        if direction is None or not ticker:
            continue
        key = (r["filing_id"], ticker, direction)
        bucket = excluded if reason else eligible
        d = bucket.get(key)
        if d is None:
            bucket[key] = TrackDecision(
                filing_id=r["filing_id"], member_name=r["member_name"] or "unknown",
                politician_id=r["politician_id"], ticker=ticker, direction=direction,
                tx_date=r["tx_date"], filing_date=r["filing_date"], rows=1, exclusion=reason)
            continue
        d.rows += 1
        if reason is None:
            if r["tx_date"] < d.tx_date:
                d.tx_date = r["tx_date"]
        elif TRACK_EXCLUSIONS.index(reason) < TRACK_EXCLUSIONS.index(d.exclusion):
            d.exclusion = reason
    out = list(eligible.values())
    out += [d for key, d in excluded.items() if key not in eligible]
    out.sort(key=lambda d: (d.filing_id, d.ticker, d.direction))
    return out, tally


def session_on_or_after(calendar: list[str], day: str) -> int | None:
    """Index of the first session on or after `day` (the trade clock's t0)."""
    i = bisect.bisect_left(calendar, day)
    return i if i < len(calendar) else None


def session_after(calendar: list[str], day: str) -> int | None:
    """Index of the first session strictly after `day` (the disclosure clock's
    t0): the public sees a filing on its filing date, so the earliest close
    anyone could have acted on is the next session's."""
    i = bisect.bisect_right(calendar, day)
    return i if i < len(calendar) else None


def track_excess(calendar: list[str], bench: dict[str, float], closes: dict[str, float],
                 i0: int | None, horizon: int) -> float | None:
    """The ticker's move from session i0 to i0 + horizon minus the benchmark's.

    None when the horizon is past the calendar (pending) or the ticker has
    no close on either session (a series that ended or starts later).
    """
    if i0 is None or i0 + horizon >= len(calendar):
        return None
    t0, th = calendar[i0], calendar[i0 + horizon]
    c0, ch = closes.get(t0), closes.get(th)
    b0, bh = bench.get(t0), bench.get(th)
    if not c0 or not ch or not b0 or not bh:
        return None
    return (ch / c0 - 1) - (bh / b0 - 1)


# A ticker whose newest close is more than this many sessions older than the
# benchmark's has stopped trading (delisted, acquired, renamed), not lagged.
TRACK_SERIES_END_GRACE = 5


def series_ended(calendar: list[str], closes: dict[str, float],
                 grace: int = TRACK_SERIES_END_GRACE) -> str | None:
    """The ticker's last close when its series stopped before the calendar did.

    A horizon that falls after that date can never be measured, so the
    decision is not "waiting for the horizon" but done: counted apart in the
    coverage and out of every pending figure. None for a series that is
    current (within `grace` sessions of the calendar's end) or empty.
    """
    if not closes or not calendar:
        return None
    last = max(closes)
    behind = len(calendar) - bisect.bisect_right(calendar, last)
    return last if behind > grace else None


def shrinkage_k(groups, min_n: int = TRACK_FIT_MIN_DECISIONS) -> dict | None:
    """Empirical-Bayes prior strength from per-member signed excesses.

    Model: decision j of member i scores x_ij = θ_i + ε_ij, and the members'
    true θ_i spread with variance τ². The posterior mean of θ_i under a
    prior centred on zero is n_i / (n_i + k) × mean_i, with k = σ²/τ².

    Estimated by the method of moments with each member's own noise
    (DerSimonian–Laird style): τ² = Var(member means) − mean(s_i² / n_i),
    and σ² = the mean of the members' own variances s_i². Each member counts
    once on both sides. A pooled, decision-weighted σ² was tried first and
    rejected: one member with 584 decisions in volatile chip stocks set the
    noise level for everyone, the low-variance members' noise was
    overstated, and τ² came out negative (k infinite) at 90 days while the
    same data gave k ≈ 17 every other way it was cut. Only members with at
    least `min_n` decisions inform the fit: a variance from two or three
    decisions is too noisy to subtract.

    Returns {k, sigma2, tau2, members}, with k None when no between-member
    spread is detectable (τ² ≤ 0): every score then shrinks to zero. None
    when fewer than three members can inform the estimate.
    """
    usable = [list(g) for g in groups if len(g) >= max(2, min_n)]
    if len(usable) < 3:
        return None
    means = [sum(g) / len(g) for g in usable]
    variances = [sum((x - m) ** 2 for x in g) / (len(g) - 1) for g, m in zip(usable, means)]
    sigma2 = sum(variances) / len(variances)
    grand = sum(means) / len(means)
    var_means = sum((m - grand) ** 2 for m in means) / (len(means) - 1)
    noise = sum(v / len(g) for v, g in zip(variances, usable)) / len(usable)
    tau2 = var_means - noise
    k = sigma2 / tau2 if tau2 > 0 and sigma2 > 0 else None
    return {"k": k, "sigma2": sigma2, "tau2": tau2, "members": len(usable)}


def shrink(mean: float, n: int, k: float | None) -> float:
    """n / (n + k) × mean: no decisions → 0, many → the member's own mean.
    k None (no detectable spread between members) shrinks everything to 0."""
    if n <= 0 or k is None:
        return 0.0
    return n / (n + k) * mean


def _quantile(sorted_values: list[float], q: float) -> float:
    """Linear-interpolation quantile of an already sorted list."""
    pos = q * (len(sorted_values) - 1)
    lo = math.floor(pos)
    hi = min(lo + 1, len(sorted_values) - 1)
    return sorted_values[lo] + (sorted_values[hi] - sorted_values[lo]) * (pos - lo)


def bootstrap_interval(clusters, k: float | None, rng, draws: int = TRACK_BOOTSTRAP_DRAWS,
                       level: float = TRACK_INTERVAL) -> tuple[float, float] | None:
    """A percentile bootstrap interval for the shrunk score.

    Two-stage: filings are re-drawn with replacement, then the decisions
    inside each drawn filing, and the shrunk mean of the result recorded.
    Re-drawing filings rather than decisions keeps a 30-ticker filing on one
    day from counting as 30 independent pieces of evidence; re-drawing
    inside them keeps a member with a single filing from a zero-width
    interval. `clusters` is one list of signed excesses per filing.
    """
    clusters = [list(c) for c in clusters if c]
    if not clusters:
        return None
    m = len(clusters)
    stats = []
    for _ in range(draws):
        total, n = 0.0, 0
        for _ in range(m):
            c = clusters[rng.randrange(m)]
            size = len(c)
            for _ in range(size):
                total += c[rng.randrange(size)]
            n += size
        stats.append(shrink(total / n, n, k))
    stats.sort()
    tail = (1 - level) / 2
    return _quantile(stats, tail), _quantile(stats, 1 - tail)


def luck_percentile(decisions, pool, member: str, rng, draws: int = TRACK_LUCK_DRAWS,
                    window_days: int = TRACK_LUCK_WINDOW_DAYS,
                    min_pool: int = TRACK_LUCK_MIN_POOL,
                    max_days: int = TRACK_LUCK_MAX_DAYS,
                    min_members: int = TRACK_LUCK_MIN_MEMBERS) -> float | None:
    """Share of random portfolios on the same dates this member's mean beats.

    `decisions` is the member's [(t0 ISO date, direction, signed excess)];
    `pool` every measured decision [(t0 ISO date, member, unsigned excess)]
    sorted by date. Each random portfolio keeps the member's dates and
    directions and swaps each ticker for one another member traded within
    `window_days` of that date (widened, nearest first, to `min_pool`
    candidates but never past `max_days`), so the market's direction at the
    time and the member's buy/sell mix are held fixed and only the choice of
    ticker is random. Ties count half.

    A decision whose neighbourhood is thinner than `min_pool` moves by fewer
    than `min_members` other members has no comparable universe — a 2024
    catch-up filing when nobody else was filing — and is left out of the
    check (from the member's own mean too, so like is compared with like).
    None when that leaves fewer than four in five of the member's decisions:
    without the old filings bounded, one member's 2024 sales were "luckier
    than 0%" of portfolios drawn from other members' 2026 trades.
    """
    if not decisions:
        return None
    others = [(date.fromisoformat(d).toordinal(), x, who) for d, who, x in pool if who != member]
    if not others:
        return None
    days = [o[0] for o in others]
    candidates, signs, kept = [], [], []
    for t0, direction, value in decisions:
        day = date.fromisoformat(t0).toordinal()
        lo = bisect.bisect_left(days, day - window_days)
        hi = bisect.bisect_right(days, day + window_days)
        if hi - lo < min_pool:
            # Widen around the date, nearest first, inside max_days.
            lo = hi = bisect.bisect_left(days, day)
            while hi - lo < min_pool:
                left = day - days[lo - 1] if lo > 0 else math.inf
                right = days[hi] - day if hi < len(days) else math.inf
                if min(left, right) > max_days:
                    break
                if left <= right:
                    lo -= 1
                else:
                    hi += 1
        near = others[lo:hi]
        if len(near) < min_pool or len({who for _, _, who in near}) < min_members:
            continue
        candidates.append([x for _, x, _ in near])
        signs.append(-1.0 if direction == "sell" else 1.0)
        kept.append(value)
    if not kept or len(kept) * 5 < len(decisions) * 4:
        return None
    observed = sum(kept) / len(kept)
    n = len(kept)
    below = ties = 0
    for _ in range(draws):
        total = 0.0
        for values, sign in zip(candidates, signs):
            total += sign * values[rng.randrange(len(values))]
        mean = total / n
        if mean < observed - 1e-12:
            below += 1
        elif mean <= observed + 1e-12:
            ties += 1
    return (below + 0.5 * ties) / draws


@dataclass
class TrackClockScore:
    mean: float
    score: float               # the shrunk mean: what the ranking orders by
    lo: float | None           # bootstrap interval of the score; ranked members only
    hi: float | None
    hit_rate: float
    luck: float | None         # luck_percentile; ranked members only


@dataclass
class TrackScore:
    member_name: str
    politician_id: int | None
    horizon: int
    n: int                     # decisions measured on both clocks at this horizon
    filings: int
    min_decisions: int
    min_filings: int
    trade: TrackClockScore
    disclosure: TrackClockScore
    qualifies: bool = False
    rank: int | None = None


def track_scores(decisions, horizons: tuple[int, ...] = TRACK_HORIZONS,
                 min_decisions: int = TRACK_MIN_DECISIONS,
                 min_filings: int = TRACK_MIN_FILINGS,
                 draws: int = TRACK_BOOTSTRAP_DRAWS, luck_draws: int = TRACK_LUCK_DRAWS,
                 seed: int = TRACK_SEED) -> tuple[list[TrackScore], list[dict]]:
    """Per member and horizon, both clocks scored on the same decisions.

    `decisions` are mappings with member_name, politician_id, filing_id,
    direction, t0_trade, t0_disclosure and signed_<clock>_<h>. A decision
    counts at horizon h only when it has a value on *both* clocks, so the
    two scores describe the same trades and their gap is the timing lost to
    the disclosure delay rather than a difference in which trades matured.

    Returns the scores and one model row per (clock, horizon): the
    shrinkage estimate and how many members were measured and ranked.
    Members with at least `min_decisions` over `min_filings` filings are
    ranked by the trade-clock
    score (ties: more decisions first, then name); only they get an
    interval and a luck percentile — the rest are "not enough yet".
    Deterministic for a given seed: every member's draws are seeded from
    (seed, member, clock, horizon).
    """
    import random

    scores: list[TrackScore] = []
    models: list[dict] = []
    for h in horizons:
        paired = [d for d in decisions
                  if d[f"signed_trade_{h}"] is not None and d[f"signed_disclosure_{h}"] is not None]
        by_member: dict[str, list] = {}
        for d in paired:
            by_member.setdefault(d["member_name"], []).append(d)
        fits = {clock: shrinkage_k([[d[f"signed_{clock}_{h}"] for d in ds]
                                    for ds in by_member.values()])
                for clock in TRACK_CLOCKS}
        # The luck check's universe: every measured decision's unsigned move.
        pools = {clock: sorted((d[f"t0_{clock}"], d["member_name"],
                                -d[f"signed_{clock}_{h}"] if d["direction"] == "sell"
                                else d[f"signed_{clock}_{h}"])
                               for d in paired) for clock in TRACK_CLOCKS}
        rows: list[TrackScore] = []
        for member in sorted(by_member):
            ds = by_member[member]
            n = len(ds)
            filings = len({d["filing_id"] for d in ds})
            qualifies = n >= min_decisions and filings >= min_filings
            clocks = {}
            for clock in TRACK_CLOCKS:
                col = f"signed_{clock}_{h}"
                values = [d[col] for d in ds]
                mean = sum(values) / n
                k = fits[clock]["k"] if fits[clock] else None
                lo = hi = luck = None
                if qualifies:
                    rng = random.Random(f"{seed}:{member}:{clock}:{h}")
                    clusters: dict[int, list[float]] = {}
                    for d in ds:
                        clusters.setdefault(d["filing_id"], []).append(d[col])
                    lo, hi = bootstrap_interval(list(clusters.values()), k, rng, draws)
                    luck = luck_percentile([(d[f"t0_{clock}"], d["direction"], d[col]) for d in ds],
                                           pools[clock], member, rng, luck_draws)
                clocks[clock] = TrackClockScore(
                    mean=mean, score=shrink(mean, n, k), lo=lo, hi=hi,
                    hit_rate=sum(1 for v in values if v > 0) / n, luck=luck)
            rows.append(TrackScore(
                member_name=member, politician_id=ds[0]["politician_id"], horizon=h, n=n,
                filings=filings, min_decisions=min_decisions, min_filings=min_filings,
                trade=clocks["trade"], disclosure=clocks["disclosure"], qualifies=qualifies))
        ranked = sorted((r for r in rows if r.qualifies),
                        key=lambda r: (-r.trade.score, -r.n, r.member_name))
        for i, r in enumerate(ranked, 1):
            r.rank = i
        scores += rows
        for clock in TRACK_CLOCKS:
            fit = fits[clock] or {}
            values = [d[f"signed_{clock}_{h}"] for d in paired]
            models.append({
                "clock": clock, "horizon": h, "k": fit.get("k"), "sigma2": fit.get("sigma2"),
                "tau2": fit.get("tau2"), "mean": sum(values) / len(values) if values else None,
                "members_fit": fit.get("members", 0),
                "decisions": len(paired), "members": len(rows), "ranked": len(ranked),
                "min_decisions": min_decisions, "min_filings": min_filings,
            })
    return scores, models
