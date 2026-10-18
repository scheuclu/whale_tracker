"""Weekly Telegram digest: the week in one message.

Telegram otherwise gets one message per filing and per cluster, and nothing
that says what the week added up to. This builds that summary — filings and
trades by chamber, the tickers most members touched, the largest trades as
the ranges they were filed in, who filed late, insider convergence and the
largest insider buys, how the scans went, and the pipeline's health in a
line — and the poll run sends it once a week.

Two rules carry over from the rest of the project. Every figure is a range
or a labelled estimate: congressional totals print as `min–max (est. mid)`,
or `≥floor` when a total holds the open-ended top bracket, and insider values
are labelled as shares × the price as filed. And a `--dry-run` prints the
message and records nothing: previewing the digest never marks the week as
sent.

The window is on *filing date* (`--days`, default 7): "the week" is what was
filed in it, which is what a reader can check against the dashboard. The
Clerk publishes some filings days after their filing date, so a filing can
land after the digest that covered its date; the dashboard is the complete
record, and the digest links to it.
"""

from __future__ import annotations

import json
import logging
import re
import sqlite3
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta, timezone

from . import db, stats, telegram
from .amounts import format_amount, usd
from .config import Config
from .db import COUNTED_STATUSES
from .stats import (BUY_ACTIONS, SELL_ACTIONS, STOCK_ACT_DEADLINE_DAYS, InsiderCluster,
                    Volume, counts_toward_volume)
from .telegram import ACTION_EMOJI, ACTION_LABEL, TELEGRAM_LIMIT, esc, member_label

__all__ = ["Digest", "build", "format_digest", "send", "scheduled", "due_week", "STATE_KEY"]

log = logging.getLogger(__name__)

# sync_state key: the Monday (ISO date) of the last week whose digest was
# sent. The poll run compares it with `due_week(now)` and sends when they
# differ, so a missed Monday run is caught up by the next run rather than
# skipped, and a second run on the same Monday does not send twice.
STATE_KEY = "digest_sent_week"

DEFAULT_DAYS = 7

# The digest is due from Monday 07:00 UTC, the same hour as the weekly
# review, and goes out on the first poll run after that.
DUE_WEEKDAY = 0
DUE_HOUR_UTC = 7


def due_week(now: datetime) -> str:
    """The Monday (ISO date) of the most recent Monday 07:00 UTC at or before `now`.

    `now` must be timezone-aware; it is read in UTC. Before 07:00 on a Monday
    the week due is still the previous one.
    """
    now = now.astimezone(timezone.utc)
    monday = now.date() - timedelta(days=(now.weekday() - DUE_WEEKDAY) % 7)
    if now < datetime.combine(monday, time(DUE_HOUR_UTC), tzinfo=timezone.utc):
        monday -= timedelta(days=7)
    return monday.isoformat()


# --- what the week held -----------------------------------------------------


@dataclass
class ChamberCount:
    filings: int = 0       # parsed into the knowledge base
    trades: int = 0
    unread: int = 0        # 'failed': scans, paper filings, parse errors
    queued: int = 0        # 'new' / 'backfill_queued', not yet parsed


@dataclass
class TickerLine:
    ticker: str
    members: int
    buyers: int
    sellers: int
    trades: int


@dataclass
class LateFiler:
    member: str
    chamber: str | None
    late_rows: int
    max_delay_days: int


@dataclass
class InsiderBuy:
    ticker: str | None
    issuer_name: str | None
    owner: str | None
    value_cents: int
    late: bool


@dataclass
class Digest:
    since: date
    today: date
    days: int
    chambers: dict[str, ChamberCount] = field(default_factory=dict)
    buy_count: int = 0
    sell_count: int = 0
    # Over the rows that may enter a total: transcribed rows count as trades
    # above and are kept out of this, as everywhere else.
    volume: Volume = field(default_factory=Volume)
    transcribed_count: int = 0
    tickers: list[TickerLine] = field(default_factory=list)
    # Largest trades, as filed. Equity-like asset types only (the cluster
    # set): members roll Treasury bills and municipal bonds in the top
    # brackets every week, and a list of those says nothing.
    largest: list[dict] = field(default_factory=list)
    late: list[LateFiler] = field(default_factory=list)
    filings_notified: int = 0
    alerts_sent: dict[str, int] = field(default_factory=dict)
    # Insiders (SEC Form 4). Values are exact: shares × the price as filed.
    insider_filings: int = 0
    insider_notified: int = 0
    insider_buy_count: int = 0
    insider_sell_count: int = 0
    insider_buy_volume: Volume = field(default_factory=Volume)
    insider_sell_volume: Volume = field(default_factory=Volume)
    insider_unpriced: int = 0
    insider_clusters: list[InsiderCluster] = field(default_factory=list)
    insider_buys: list[InsiderBuy] = field(default_factory=list)
    # Scans: House paper filings this week, by outcome.
    scans_transcribed: int = 0
    scans_refused: int = 0
    scans_waiting: int = 0
    vision_enabled: bool = False
    senate_paper: int = 0
    # Pipeline health.
    senate_status: str | None = None
    edgar_status: str | None = None
    edgar_gap: str | None = None
    filings_queued: int = 0
    # Whether the Clerk published a filing past `ingest.max_filing_age_days`
    # this week — stored as history, never announced (pipeline.AGE_CUTOFF_STATE).
    age_cutoff_this_week: bool = False

    @property
    def filings(self) -> int:
        return sum(c.filings for c in self.chambers.values())

    @property
    def trades(self) -> int:
        return sum(c.trades for c in self.chambers.values())


def _marks(values) -> str:
    return ", ".join("?" for _ in values)


def build(conn: sqlite3.Connection, config: Config, days: int = DEFAULT_DAYS,
          today: date | None = None) -> Digest:
    """Gather the week's figures. Reads only; sends nothing."""
    today = today or date.today()
    since = today - timedelta(days=days)
    d = Digest(since=since, today=today, days=days)
    window = (since.isoformat(), today.isoformat())
    _congress(conn, config, d, window)
    _alerts(conn, d, since)
    _insiders(conn, config, d, window, today)
    _scans(conn, config, d, since)
    _health(conn, d, since)
    return d


def _congress(conn: sqlite3.Connection, config: Config, d: Digest,
              window: tuple[str, str]) -> None:
    counted = _marks(COUNTED_STATUSES)
    for r in conn.execute(f"""
        SELECT chamber,
               SUM(status IN ({counted})) AS filings,
               SUM(status = 'failed') AS unread,
               SUM(status IN ('new', 'backfill_queued')) AS queued
        FROM filings WHERE filing_date >= ? AND filing_date <= ?
        GROUP BY chamber
    """, (*COUNTED_STATUSES, *window)):
        d.chambers[r["chamber"]] = ChamberCount(
            filings=r["filings"] or 0, unread=r["unread"] or 0, queued=r["queued"] or 0)

    rows = conn.execute(f"""
        SELECT t.ticker, t.asset_name, t.asset_type, t.action, t.tx_date,
               t.amount_min_cents, t.amount_max_cents, t.amount_exact_cents,
               f.id AS filing_id, f.chamber, f.filing_date, f.parse_method,
               COALESCE(p.full_name, f.filer_name) AS member_name,
               p.party, p.state, p.district, p.chamber AS member_chamber
        FROM transactions t
        JOIN filings f ON f.id = t.filing_id
        LEFT JOIN politicians p ON p.id = t.politician_id
        WHERE f.status IN ({counted}) AND f.filing_date >= ? AND f.filing_date <= ?
    """, (*COUNTED_STATUSES, *window)).fetchall()

    equity = set(config.alerts.cluster_asset_types)
    by_ticker: dict[str, dict] = {}
    late: dict[int, LateFiler] = {}
    candidates: list[dict] = []
    for r in rows:
        chamber = d.chambers.setdefault(r["chamber"], ChamberCount())
        chamber.trades += 1
        member = r["member_name"] or "unknown"
        amounts = (r["amount_min_cents"], r["amount_max_cents"], r["amount_exact_cents"])
        priced = counts_toward_volume(r["parse_method"])
        if priced:
            d.volume.add(*amounts)
        else:
            d.transcribed_count += 1
        is_buy = r["action"] in BUY_ACTIONS
        is_sell = r["action"] in SELL_ACTIONS
        d.buy_count += is_buy
        d.sell_count += is_sell

        if r["ticker"]:
            t = by_ticker.setdefault(r["ticker"], {"members": set(), "buyers": set(),
                                                   "sellers": set(), "trades": 0})
            t["trades"] += 1
            t["members"].add(member)
            if is_buy:
                t["buyers"].add(member)
            elif is_sell:
                t["sellers"].add(member)

        # A transcribed amount is a checkbox read off a scan: a trade, not a
        # figure to rank by. Rows with no amount cannot be ranked either.
        if priced and r["asset_type"] in equity and (
                r["amount_exact_cents"] is not None or r["amount_min_cents"] is not None):
            candidates.append(dict(r))

        delay = stats.disclosure_delay_days(r["tx_date"], r["filing_date"])
        if delay is not None and delay > STOCK_ACT_DEADLINE_DAYS:
            entry = late.setdefault(r["filing_id"], LateFiler(
                member=member, chamber=r["member_chamber"] or r["chamber"],
                late_rows=0, max_delay_days=0))
            entry.late_rows += 1
            entry.max_delay_days = max(entry.max_delay_days, delay)

    # Only tickers more than one member touched: "LMT 1 (1 sell)" is one
    # filing's row restated, not a ticker members converged on.
    d.tickers = sorted(
        (TickerLine(ticker=k, members=len(v["members"]), buyers=len(v["buyers"]),
                    sellers=len(v["sellers"]), trades=v["trades"])
         for k, v in by_ticker.items() if len(v["members"]) > 1),
        key=lambda t: (t.members, t.trades, t.ticker), reverse=True)
    d.largest = sorted(candidates, key=telegram._floor_key)
    d.late = sorted(late.values(), key=lambda f: (f.max_delay_days, f.late_rows), reverse=True)


def _alerts(conn: sqlite3.Connection, d: Digest, since: date) -> None:
    """What Telegram was actually sent this week.

    `notified_at` alone would overcount: a silent backfill stamps it too, to
    say the filing never needs announcing. Only the notify path sets the
    status to 'notified', so that is the count of filing messages sent;
    unreadable filings reported with a link keep status 'failed' and are
    not separable from silently backfilled ones, so they are left out.
    `fired_at` and `notified_at` are ISO timestamps; a bare date sorts before
    any timestamp on that day, so `>=` includes the whole of `since`.
    """
    d.filings_notified = conn.execute(
        "SELECT COUNT(*) FROM filings WHERE status = 'notified' AND notified_at >= ?",
        (since.isoformat(),)).fetchone()[0]
    d.insider_notified = conn.execute(
        "SELECT COUNT(*) FROM insider_filings WHERE status = 'notified' AND notified_at >= ?",
        (since.isoformat(),)).fetchone()[0]
    for r in conn.execute(
            "SELECT kind, COUNT(*) AS n FROM alerts WHERE fired_at >= ? GROUP BY kind",
            (since.isoformat(),)):
        d.alerts_sent[r["kind"]] = r["n"]


def _insiders(conn: sqlite3.Connection, config: Config, d: Digest,
              window: tuple[str, str], today: date) -> None:
    counted = _marks(COUNTED_STATUSES)
    d.insider_filings = conn.execute(f"""
        SELECT COUNT(*) FROM insider_filings
        WHERE status IN ({counted}) AND filing_date >= ? AND filing_date <= ?
    """, (*COUNTED_STATUSES, *window)).fetchone()[0]

    rows = conn.execute(f"""
        SELECT t.action, t.amount_exact_cents, t.implausible, t.late,
               f.id AS filing_id, f.ticker, f.issuer_name, i.name AS owner_name
        FROM insider_transactions t
        JOIN insider_filings f ON f.id = t.filing_id
        LEFT JOIN insider_filing_owners o ON o.filing_id = f.id AND o.owner_index = 0
        LEFT JOIN insiders i ON i.cik = o.insider_cik
        WHERE f.status IN ({counted}) AND f.filing_date >= ? AND f.filing_date <= ?
    """, (*COUNTED_STATUSES, *window)).fetchall()

    # The largest buys are per filing — the summed value of one direction in
    # one filing, which is also what the alert rules compare against.
    buys: dict[int, InsiderBuy] = {}
    for r in rows:
        value = r["amount_exact_cents"]
        # An unpriced or implausible row has an unknown value, never a large
        # one: it counts as a trade and adds nothing anywhere.
        priced = value is not None and r["implausible"] != 1
        if not priced:
            d.insider_unpriced += 1
        if r["action"] in BUY_ACTIONS:
            d.insider_buy_count += 1
            if priced:
                d.insider_buy_volume.add(value, value, value)
                b = buys.setdefault(r["filing_id"], InsiderBuy(
                    ticker=r["ticker"], issuer_name=r["issuer_name"],
                    owner=r["owner_name"], value_cents=0, late=False))
                b.value_cents += value
                b.late = b.late or r["late"] == 1
        elif r["action"] in SELL_ACTIONS:
            d.insider_sell_count += 1
            if priced:
                d.insider_sell_volume.add(value, value, value)
    d.insider_buys = sorted(buys.values(), key=lambda b: b.value_cents, reverse=True)

    if config.insiders.enabled:
        # Measured on the digest's own window, not the 30-day alert window:
        # Form 4 is due in two business days, so a week of trade dates is a
        # week of filings, and "this week" stays true.
        d.insider_clusters = stats.find_insider_clusters(
            conn, config.insiders, today=today, window_days=d.days)


def _scans(conn: sqlite3.Connection, config: Config, d: Digest, since: date) -> None:
    # Outcomes are dated by `updated_at`: a scan's status changes when it is
    # transcribed or refused, so that is when the week's count should see it.
    d.vision_enabled = bool(config.vision_enabled)
    counted = _marks(COUNTED_STATUSES)
    r = conn.execute(f"""
        SELECT SUM(status IN ({counted}) AND parse_method = ?) AS transcribed,
               SUM(status = 'failed' AND parse_method = 'vision_failed') AS refused
        FROM filings WHERE chamber = 'house' AND updated_at >= ?
    """, (*COUNTED_STATUSES, stats.TRANSCRIBED_METHOD, since.isoformat())).fetchone()
    d.scans_transcribed = r["transcribed"] or 0
    d.scans_refused = r["refused"] or 0
    d.scans_waiting = conn.execute("""
        SELECT COUNT(*) FROM filings
        WHERE chamber = 'house' AND parse_method = 'scanned'
          AND status IN ('new', 'backfill_queued', 'failed')
    """).fetchone()[0]
    d.senate_paper = conn.execute("""
        SELECT COUNT(*) FROM filings
        WHERE chamber = 'senate' AND parse_method = 'efd_paper' AND updated_at >= ?
    """, (since.isoformat(),)).fetchone()[0]


def _health(conn: sqlite3.Connection, d: Digest, since: date) -> None:
    d.senate_status = db.get_state(conn, "senate_status")
    d.edgar_status = db.get_state(conn, "edgar_status")
    d.edgar_gap = db.get_state(conn, "edgar_gap") or None
    d.filings_queued = conn.execute(
        "SELECT COUNT(*) FROM filings WHERE status IN ('new', 'backfill_queued')"
    ).fetchone()[0]
    raw = db.get_state(conn, "house_age_cutoff")
    if raw:
        # The counter is cumulative; the week only cares whether it moved.
        try:
            last = str(json.loads(raw).get("last_seen_at") or "")
        except (ValueError, AttributeError):
            last = ""
        d.age_cutoff_this_week = last >= since.isoformat()


# --- the message ------------------------------------------------------------

# Degradation, in order: the lists shrink together (5 → 3 → 2 → 1 → none),
# the totals and the health line never go. A week could not plausibly
# overflow even the fullest shape — the dry run against the 2026 corpus is
# well under half the limit — but the limit is a hard failure, so the last
# resort is a truncation that at least sends the headline figures.
_SHAPES = ((5, 5, 5, 4, 5), (3, 3, 3, 3, 3), (2, 2, 2, 2, 2), (1, 1, 1, 1, 1), (0, 0, 0, 0, 0))

_DASHBOARD_PAGES = (("Dashboard", "/"), ("Tickers", "/tickers"), ("Members", "/politicians"),
                    ("Insiders", "/insiders"), ("Scans", "/scans"), ("Pipeline", "/pipeline"))


def format_digest(d: Digest, dashboard_url: str | None = None) -> str:
    """Render the digest as Telegram HTML, inside the limit."""
    for shape in _SHAPES:
        msg = _render(d, dashboard_url, *shape)
        if len(msg) <= TELEGRAM_LIMIT:
            return msg
    return msg[:TELEGRAM_LIMIT]


def _volume_text(vol: Volume, count: int) -> str:
    """A congressional total: the range with its labelled estimate, or
    `≥floor` when it holds an open-ended bracket and has no defensible maximum."""
    if not count:
        return "no priced trades"
    if vol.open_ended or vol.max_cents is None:
        return f"≥{usd(vol.min_cents)}"
    return f"{format_amount(vol.min_cents, vol.max_cents)} (est. mid {usd(vol.mid_cents)})"


def _exact_text(vol: Volume, count: int) -> str:
    """An insider total: exact by construction (shares × reported price), so a
    single figure — labelled where it is printed. Zero with trades means
    nothing was priced, which is unknown, not nothing."""
    if not count:
        return "—"
    if not vol.min_cents:
        return "unpriced"
    return usd(vol.min_cents)


def _plural(n: int, word: str) -> str:
    return f"{n} {word}" + ("" if n == 1 else "s")


def _chamber_line(d: Digest) -> str:
    parts = []
    for chamber, label in (("house", "House"), ("senate", "Senate")):
        c = d.chambers.get(chamber, ChamberCount())
        text = f"{label} {_plural(c.filings, 'filing')} · {_plural(c.trades, 'trade')}"
        extra = []
        if c.unread:
            extra.append(f"{c.unread} unread")
        if c.queued:
            extra.append(f"{c.queued} queued")
        if extra:
            text += f" (+{', '.join(extra)})"
        parts.append(text)
    return " — ".join(parts)


def _ticker_text(t: TickerLine) -> str:
    split = []
    if t.buyers:
        split.append(f"{t.buyers} buy")
    if t.sellers:
        split.append(f"{t.sellers} sell")
    return f"<b>{esc(t.ticker)}</b> {t.members} ({', '.join(split) or 'other'})"


def _largest_line(r: dict) -> str:
    emoji = ACTION_EMOJI.get(r["action"], "⚪️")
    label = ACTION_LABEL.get(r["action"], r["action"].upper())
    amount = format_amount(r["amount_min_cents"], r["amount_max_cents"], r["amount_exact_cents"])
    symbol = r["ticker"] or (r["asset_name"] or "unnamed asset")[:30]
    who = member_label(r["member_name"], r["party"], r["state"], r["district"],
                       r["member_chamber"] or r["chamber"])
    return f"{emoji} {esc(label)} <b>{esc(symbol)}</b> {esc(amount)} — {esc(who)}"


def _late_text(f: LateFiler) -> str:
    title = "Sen." if f.chamber == "senate" else "Rep."
    return (f"{title} {esc(f.member)} ({_plural(f.late_rows, 'trade')}, "
            f"up to {f.max_delay_days}d)")


def _cluster_text(c: InsiderCluster) -> str:
    verb = "bought" if c.direction == "buy" else "sold"
    return f"{c.insider_count} {verb} <b>{esc(c.ticker or c.issuer_name or '?')}</b> ({esc(usd(c.volume.mid_cents))})"


def _buy_line(b: InsiderBuy) -> str:
    symbol = b.ticker or b.issuer_name or "unknown issuer"
    line = f"🟢 <b>{esc(symbol)}</b> {esc(usd(b.value_cents))} — {esc(b.owner or 'unknown filer')}"
    if b.late:
        line += " · <i>filed late</i>"
    return line


# How the `alerts` table's kinds read in a sentence. A kind this does not
# know is printed as it is spelled, so a new one still appears in the count.
_KIND_LABELS = {stats.CLUSTER_KIND: "congressional cluster",
                stats.INSIDER_CLUSTER_KIND: "insider cluster"}


def _sent_text(d: Digest) -> str:
    parts = [f"{_plural(d.filings_notified, 'filing alert')}"]
    for kind, n in sorted(d.alerts_sent.items()):
        parts.append(f"{n} {esc(_KIND_LABELS.get(kind, kind.replace('_', ' ')))}")
    parts.append(f"{_plural(d.insider_notified, 'insider alert')}")
    return " · ".join(parts)


def _status_word(status: str | None, unset: str) -> str:
    """The vocabulary word a stored status starts with: `ok: 100 filings
    seen` → `ok`. Statuses are `<word>: <detail>` (senate.py, insiders.py);
    anything longer is detail that belongs on the dashboard, not here."""
    if not status:
        return unset
    head = re.split(r"[:;]", status, maxsplit=1)[0].strip()
    return head[:24] or unset


def _health_line(d: Digest) -> str:
    parts = [f"Senate {esc(_status_word(d.senate_status, 'not attempted'))}",
             f"EDGAR {esc(_status_word(d.edgar_status, 'not attempted'))}"]
    if d.edgar_gap:
        parts.append(f"feed gap {esc(d.edgar_gap)}")
    parts.append(f"{d.filings_queued} queued")
    if d.age_cutoff_this_week:
        parts.append("Clerk published past the age cutoff")
    return " · ".join(parts)


def _links(dashboard_url: str | None) -> str:
    if not dashboard_url:
        # Relative paths: the right pages, just not clickable, as elsewhere.
        return " · ".join(f"{label} {path}" for label, path in _DASHBOARD_PAGES)
    base = dashboard_url.rstrip("/")
    return " · ".join(f'<a href="{esc(base + path)}">{label}</a>'
                      for label, path in _DASHBOARD_PAGES)


def _render(d: Digest, dashboard_url: str | None, n_tickers: int, n_largest: int,
            n_late: int, n_clusters: int, n_buys: int) -> str:
    span = f"{d.since.isoformat()} → {d.today.isoformat()}"
    parts = [f"📬 <b>Weekly digest</b> · {esc(span)}", ""]

    # --- Congress
    parts.append("<b>Congress</b>")
    parts.append(_chamber_line(d))
    if d.trades:
        line = (f"{_plural(d.buy_count, 'buy')} · {_plural(d.sell_count, 'sell')} · "
                f"volume {esc(_volume_text(d.volume, d.trades - d.transcribed_count))}")
        if d.transcribed_count:
            line += f" · {d.transcribed_count} transcribed from scans, not in the total"
        parts.append(line)
    if d.tickers:
        if n_tickers:
            parts.append("Most members: "
                         + " · ".join(_ticker_text(t) for t in d.tickers[:n_tickers]))
    elif d.trades:
        parts.append("No ticker was traded by more than one member")
    if n_largest and d.largest:
        parts.append("Largest equity trades, as filed:")
        parts += [_largest_line(r) for r in d.largest[:n_largest]]
    if d.late:
        line = f"Filed past {STOCK_ACT_DEADLINE_DAYS} days: {len(d.late)}"
        if n_late:
            line += " — " + "; ".join(_late_text(f) for f in d.late[:n_late])
            if len(d.late) > n_late:
                line += f"; +{len(d.late) - n_late} more"
        parts.append(line)
    else:
        parts.append(f"Filed past {STOCK_ACT_DEADLINE_DAYS} days: none")
    parts.append(f"Sent: {_sent_text(d)}")

    # --- Insiders. Values are exact and computed, so the label goes on the
    # section once rather than "est." on every figure.
    parts += ["", "<b>Insiders (Form 4)</b> · values are shares × reported price"]
    parts.append(f"{_plural(d.insider_filings, 'filing')} stored · "
                 f"{_plural(d.insider_buy_count, 'buy')} {esc(_exact_text(d.insider_buy_volume, d.insider_buy_count))} · "
                 f"{_plural(d.insider_sell_count, 'sell')} {esc(_exact_text(d.insider_sell_volume, d.insider_sell_count))}")
    if d.insider_unpriced:
        parts.append(f"<i>{d.insider_unpriced} unpriced or implausible row(s) carry no value</i>")
    if d.insider_clusters:
        line = f"Clusters ({d.days}d): "
        if n_clusters:
            line += " · ".join(_cluster_text(c) for c in d.insider_clusters[:n_clusters])
            if len(d.insider_clusters) > n_clusters:
                line += f" · +{len(d.insider_clusters) - n_clusters} more"
        else:
            line += str(len(d.insider_clusters))
        parts.append(line)
    else:
        parts.append(f"Clusters ({d.days}d): none")
    if n_buys and d.insider_buys:
        parts.append("Largest buys, one filing each:")
        parts += [_buy_line(b) for b in d.insider_buys[:n_buys]]

    # --- Scans and health
    scans = [f"{d.scans_transcribed} transcribed", f"{d.scans_refused} refused",
             f"{d.scans_waiting} " + ("waiting" if d.vision_enabled else "unread (vision off)")]
    if d.senate_paper:
        scans.append(f"{d.senate_paper} Senate paper")
    parts += ["", f"<b>Scans</b> {' · '.join(scans)}",
              f"<b>Pipeline</b> {_health_line(d)}",
              "", _links(dashboard_url)]
    return "\n".join(parts)


# --- sending ----------------------------------------------------------------


def send(conn: sqlite3.Connection, config: Config, days: int = DEFAULT_DAYS,
         dry_run: bool = False, now: datetime | None = None) -> str:
    """Build and send one digest; print it instead under `dry_run`.

    A real send records the week in `sync_state`, so a digest sent by hand
    on a Monday morning is not followed by the poll run's. A dry run records
    nothing. Returns the message.
    """
    now = now or datetime.now(timezone.utc)
    digest = build(conn, config, days, today=now.astimezone(timezone.utc).date())
    text = format_digest(digest, config.dashboard_url)
    if dry_run:
        print("\n" + "─" * 60)
        print(text)
        return text
    if not config.telegram_configured:
        raise RuntimeError("Telegram secrets not set (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID)")
    telegram.send_message(config.telegram_bot_token, config.telegram_chat_id, text)
    db.set_state(conn, STATE_KEY, due_week(now))
    conn.commit()
    log.info("weekly digest sent (%d chars)", len(text))
    return text


def scheduled(conn: sqlite3.Connection, config: Config, dry_run: bool = False,
              now: datetime | None = None) -> bool:
    """The poll run's hook: send the digest once per week, when it is due.

    Due means the first run after Monday 07:00 UTC whose week is not yet
    recorded in `sync_state.digest_sent_week`. Off unless `telegram.digest`
    is on. Never raises into the pipeline: the digest is a summary of work
    already committed, and a formatting bug in it must not fail the run that
    commits the database.
    """
    if not config.telegram.digest:
        return False
    now = now or datetime.now(timezone.utc)
    try:
        week = due_week(now)
        if db.get_state(conn, STATE_KEY) == week:
            return False
        if not (config.telegram_configured or dry_run):
            log.warning("Telegram secrets not set; weekly digest for %s not sent", week)
            return False
        send(conn, config, DEFAULT_DAYS, dry_run=dry_run, now=now)
        return True
    except Exception:
        log.exception("weekly digest failed; the pipeline run is unaffected")
        return False
