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
    """Summed value of these rows, or None when none of them carries a price."""
    values = [r["amount_exact_cents"] for r in rows if r["amount_exact_cents"] is not None]
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
