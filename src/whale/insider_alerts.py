"""Matching stored Form 4 filings against the alert rules in config.yaml.

Rules are tried in order and the first match names the alert, so a specific
rule ("CEO selling") must be listed above a general one ("large sale") or the
general one will claim the filing first.

A filing rule describes *one direction's* open-market trades inside a single
filing: the value is that direction's total, and the role and title conditions
are satisfied by any one reporting owner on the filing. Joint filings are why
"any owner" rather than "the primary owner": a founder filing alongside their
holding company is one economic act, and the roles printed on it describe who
is behind it.
"""

from __future__ import annotations

import logging
import sqlite3
from dataclasses import dataclass
from datetime import date

from . import stats
from .config import InsiderRule, InsiderSettings
from .stats import InsiderCluster

log = logging.getLogger(__name__)

DIRECTIONS = ("purchase", "sale")
# config.yaml speaks of buy/sell; the database stores purchase/sale.
RULE_DIRECTION = {"purchase": "buy", "sale": "sell"}


class FilingMatch:
    """A filing, the rule that claimed it, and the rows that satisfied it."""

    def __init__(self, rule: InsiderRule, filing: sqlite3.Row, direction: str,
                 value_cents: int | None, rows: list[sqlite3.Row],
                 owners: list[sqlite3.Row]) -> None:
        self.rule = rule
        self.filing = filing
        self.direction = direction  # 'purchase' | 'sale'
        self.value_cents = value_cents
        self.rows = rows
        self.owners = owners

    @property
    def primary(self) -> sqlite3.Row | None:
        return self.owners[0] if self.owners else None

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return (f"FilingMatch({self.rule.name!r}, {self.filing['accession']}, "
                f"{self.direction}, {self.value_cents})")


def load_filing(conn: sqlite3.Connection,
                filing_id: int) -> tuple[list[sqlite3.Row], list[sqlite3.Row]]:
    """The filing's open-market rows and its reporting owners, in filing order."""
    rows = conn.execute(
        "SELECT * FROM insider_transactions WHERE filing_id = ? ORDER BY id",
        (filing_id,),
    ).fetchall()
    owners = conn.execute(
        """SELECT o.*, i.name FROM insider_filing_owners o
           JOIN insiders i ON i.cik = o.insider_cik
           WHERE o.filing_id = ? ORDER BY o.owner_index""",
        (filing_id,),
    ).fetchall()
    return rows, owners


def _direction_value(rows: list[sqlite3.Row]) -> int | None:
    """Summed value of these rows, or None when none of them carries a price.

    A row flagged `implausible` is unknown too, not large: a price cell that
    holds the aggregate consideration must not clear a value floor.
    """
    values = [r["amount_exact_cents"] for r in rows
              if r["amount_exact_cents"] is not None and r["implausible"] != 1]
    return sum(values) if values else None


def _owner_satisfies(owner: sqlite3.Row, rule: InsiderRule) -> bool:
    if rule.roles:
        has = {
            "director": owner["is_director"],
            "officer": owner["is_officer"],
            "ten_percent_owner": owner["is_ten_percent_owner"],
            "other": owner["is_other"],
        }
        if not any(has[role] for role in rule.roles):
            return False
    if rule.titles:
        title = (owner["officer_title"] or "").lower()
        if not any(want in title for want in rule.titles):
            return False
    return True


def match_filing(filing: sqlite3.Row, owners: list[sqlite3.Row],
                 rows: list[sqlite3.Row], rule: InsiderRule) -> FilingMatch | None:
    """Whether one rule claims this filing, and on which direction."""
    if rule.kind != "filing":
        return None
    if not filing["ticker"]:
        # Filed with the trading symbol NONE or N/A: a private BDC, interval
        # fund or similar non-listed vehicle. Nobody can act on it, so no rule
        # claims it; the pipeline demotes it to history, where the dashboard
        # still counts it. 16 of the first 291 insider alerts were these.
        return None

    plan = filing["aff_10b5_one"]
    if rule.exclude_10b5_1 and plan == 1:
        return None
    if rule.require_10b5_1 and plan != 1:
        return None
    if (rule.roles or rule.titles) and not any(_owner_satisfies(o, rule) for o in owners):
        return None

    for direction in DIRECTIONS:
        if not rule.wants(RULE_DIRECTION[direction]):
            continue
        in_direction = [r for r in rows if r["action"] == direction]
        if not in_direction:
            continue
        value = _direction_value(in_direction)
        if rule.min_value_cents:
            # An unknown value cannot clear a value floor.
            if value is None or value < rule.min_value_cents:
                continue
        return FilingMatch(rule, filing, direction, value, in_direction, owners)
    return None


def first_filing_match(filing: sqlite3.Row, owners: list[sqlite3.Row],
                       rows: list[sqlite3.Row],
                       rules: list[InsiderRule]) -> FilingMatch | None:
    for rule in rules:
        match = match_filing(filing, owners, rows, rule)
        if match is not None:
            return match
    return None


# --- the filing-rule cooldown -------------------------------------------------
#
# A filing rule has no memory: Nippon Life bought Corebridge on 24 of the 33
# business days to 2026-10-16 and each filing cleared the floor on its own,
# so each was its own alert — 24 messages for one accumulation decision, and
# 67 of the first 291 insider alerts were repeats of this shape. The cooldown
# keys on (primary owner, issuer, direction) and mirrors the cluster rule:
# a repeat inside the window is folded into history, and the run speaks again
# only once its cumulative value is `cluster_refire_growth`× what was last
# reported, so a programme that keeps growing stays visible without a message
# per filing.


@dataclass
class CooldownDecision:
    """What the cooldown says about one rule-matched filing."""

    fire: bool
    # Filings in the run so far, this one included; 1 means a fresh alert.
    count: int
    # From the run's first filing to this one, on filing date.
    days: int
    # Summed value of the run (shares × reported price); None if none was priced.
    cumulative_cents: int | None
    # The cooldown row to persist if this decision is acted on.
    state: dict

    @property
    def repeat(self) -> bool:
        return self.count > 1


def cooldown_key(match: FilingMatch) -> tuple[str, str, str] | None:
    """(primary owner CIK, issuer CIK, direction), or None when a filing has
    no primary owner to key on — the audit flags those; here they just alert."""
    if match.primary is None or not match.filing["issuer_cik"]:
        return None
    return (match.primary["insider_cik"], match.filing["issuer_cik"], match.direction)


def _days_between(start: str | None, end: str | None) -> int | None:
    try:
        return (date.fromisoformat(end) - date.fromisoformat(start)).days
    except (TypeError, ValueError):
        return None


def cooldown_decision(previous: sqlite3.Row | dict | None, match: FilingMatch,
                      refire_days: int, growth: float) -> CooldownDecision:
    """Whether this filing is a fresh alert, a refire, or a fold.

    `previous` is the stored cooldown row for the key, or None. The window
    runs from the last filing that was actually sent, so a refire restarts
    it. Dates that cannot be compared count as outside the window: a missing
    alert is the larger harm, so the unknown case fires.
    """
    filing = match.filing
    value = match.value_cents
    key = cooldown_key(match)
    fresh = {
        "insider_cik": key[0] if key else None,
        "issuer_cik": filing["issuer_cik"],
        "direction": match.direction,
        "first_filing_date": filing["filing_date"],
        "last_alert_filing_date": filing["filing_date"],
        "last_alert_filing_id": filing["id"],
        "filing_count": 1,
        "cumulative_cents": value,
        "reported_cents": value,
    }
    if previous is None or key is None or refire_days <= 0:
        return CooldownDecision(True, 1, 0, value, fresh)
    since_alert = _days_between(previous["last_alert_filing_date"], filing["filing_date"])
    if since_alert is None or since_alert > refire_days:
        return CooldownDecision(True, 1, 0, value, fresh)

    count = previous["filing_count"] + 1
    cumulative = previous["cumulative_cents"]
    if value is not None:
        cumulative = value if cumulative is None else cumulative + value
    days = _days_between(previous["first_filing_date"], filing["filing_date"]) or 0
    state = {f: previous[f] for f in fresh}
    state.update(filing_count=count, cumulative_cents=cumulative)

    reported = previous["reported_cents"]
    # Materially bigger than last reported: strictly more, and at least
    # `growth`× — the cluster rule's "one more insider, and half as many
    # again". An unpriced run cannot grow, so it cannot refire.
    grown = (cumulative is not None and reported is not None
             and cumulative > reported and cumulative >= reported * growth)
    if grown:
        state.update(last_alert_filing_date=filing["filing_date"],
                     last_alert_filing_id=filing["id"], reported_cents=cumulative)
    return CooldownDecision(grown, count, days, cumulative, state)


def cluster_matches(conn: sqlite3.Connection, settings: InsiderSettings,
                    today=None) -> list[tuple[InsiderCluster, InsiderRule, int]]:
    """Clusters claimed by a cluster rule, with the window each was found in.

    One alert per (issuer, direction): the first rule to claim it wins, so a
    second rule cannot double-report the same convergence.
    """
    cache: dict[int, list[InsiderCluster]] = {}
    claimed: set[tuple[str, str]] = set()
    out = []
    for rule in settings.rules_of_kind("cluster"):
        window = rule.window_days or settings.cluster_window_days
        if window not in cache:
            # Gather every candidate once per window, then let each rule apply
            # its own floor.
            cache[window] = stats.find_insider_clusters(
                conn, settings, today=today, window_days=window, min_insiders=1)
        for cluster in cache[window]:
            key = (cluster.ticker or cluster.issuer_cik, cluster.direction)
            if key in claimed:
                continue
            if not rule.wants(cluster.direction):
                continue
            if cluster.insider_count < rule.min_insiders:
                continue
            if cluster.volume.mid_cents < rule.min_value_cents:
                continue
            claimed.add(key)
            out.append((cluster, rule, window))
    return out


def preview(conn: sqlite3.Connection, settings: InsiderSettings,
            window_days: int | None = None, limit: int = 20,
            today=None) -> list[FilingMatch]:
    """Which stored filings the current rules would claim.

    Ignores notification state deliberately: a rule is only tunable if you can
    see what it would have caught, and filings already examined have been
    demoted to history.
    """
    from .db import COUNTED_STATUSES

    marks = ", ".join("?" for _ in COUNTED_STATUSES)
    sql = f"SELECT * FROM insider_filings WHERE status IN ({marks})"
    params: list = list(COUNTED_STATUSES)
    if window_days:
        from datetime import date, timedelta

        since = ((today or date.today()) - timedelta(days=window_days)).isoformat()
        sql += " AND filing_date >= ?"
        params.append(since)
    sql += " ORDER BY filing_date DESC, id DESC"

    rules = settings.rules_of_kind("filing")
    out = []
    for filing in conn.execute(sql, params):
        rows, owners = load_filing(conn, filing["id"])
        match = first_filing_match(filing, owners, rows, rules)
        if match is not None:
            out.append(match)
            if len(out) >= limit:
                break
    return out
