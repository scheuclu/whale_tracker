"""Track record: how the stock moved after each member's decisions.

"Whose trades were followed by the biggest market-beating moves" — never
"best trader", "profit" or "returns". A decision is one member, one ticker,
one direction, one filing; it is measured as the ticker's close-to-close
move minus SPY's over the same sessions, at 30/90/180 trading days, signed
by direction, from two starting points:

* the **trade clock** — the first session on or after the trade date (the
  member's own timing);
* the **disclosure clock** — the first session strictly after the filing
  date (the earliest close a member of the public could have acted on).

The methodology lives in `stats` (pure functions, unit-tested); this module
is the pipeline step around it. The daily series for ~1,200 tickers are
fetched transiently, through `prices.PriceClient` (same source, User-Agent,
pacing and refusal handling), and never stored: the database is committed on
every run and the dashboard downloads it. What is stored is one row per
decision (`track_decisions`), one per member and horizon (`track_scores`),
the shrinkage fit (`track_model`), coverage (`track_coverage`) and a
per-ticker fetch record (`track_price_fetches`) so a symbol the source does
not carry is not asked about on every run.

The step is incremental and resumable: a ticker is fetched only when one of
its decisions has a horizon that matured since the series was last read, or
the decision is new; each ticker's work is committed as it finishes; a time
budget (`track_record.budget_seconds`) leaves the rest for the next run; and
nothing here raises into the pipeline (`pipeline._sync_track_record` guards
the rest). Congressional data only — Form 4 insiders will get their own
tables when they are added, never rows in these.
"""

from __future__ import annotations

import logging
import sqlite3
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone

from . import db, stats
from .config import Config
from .prices import PriceClient, PricesBlocked, PricesThrottled, final_through

log = logging.getLogger(__name__)

# sync_state keys. The status uses the audit's vocabulary: `ok: …`,
# `throttled: …`, `blocked: …`, `error: …`, `skipped: …`.
STATE_STATUS = "track_record_status"
# The last final session date a run finished all its work for. A later run
# with the same final session and no changed decision has nothing to do and
# makes no request at all.
STATE_COMPLETE = "track_record_complete_through"

# Calendar days of closes asked for before the earliest t0, so the first
# session on or after it is inside the series.
LOOKBACK_DAYS = 10
# A ticker the source had no series for is asked again after this long (a
# new listing, a symbol the source learns), not on every run.
NO_DATA_RETRY_DAYS = 30

SIGNED_COLUMNS = tuple(f"signed_{clock}_{h}" for clock in stats.TRACK_CLOCKS
                       for h in stats.TRACK_HORIZONS)


@dataclass
class TrackResult:
    status: str
    decisions: int = 0      # decisions stored (measured, pending and excluded)
    eligible: int = 0       # not excluded
    changed: int = 0        # decisions new or changed since the last run
    tickers_due: int = 0    # tickers with a decision that needed a series
    fetched: int = 0        # tickers fetched this run
    no_data: int = 0        # fetched, no series at the source
    errors: int = 0         # fetched, request failed; retried next run
    left: int = 0           # due, but the run stopped first
    measured: int = 0       # decisions (re)measured this run
    scored: bool = False    # track_scores rebuilt this run

    def summary(self) -> str:
        return (f"{self.status} — {self.decisions} decision(s), {self.eligible} eligible, "
                f"{self.changed} new/changed; {self.fetched} of {self.tickers_due} ticker(s) "
                f"fetched ({self.no_data} without data, {self.errors} error(s), {self.left} "
                f"left for the next run); {self.measured} decision(s) measured; "
                f"scores {'rebuilt' if self.scored else 'unchanged'}")


# --- reading ------------------------------------------------------------------


def counted_rows(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    """Every counted congressional transaction, with what the exclusions need."""
    marks = ", ".join("?" for _ in db.COUNTED_STATUSES)
    return conn.execute(f"""
        SELECT t.filing_id, t.politician_id, t.tx_date, t.notification_date, t.action,
               t.ticker, t.asset_type, t.option_kind, f.filing_date, f.parse_method,
               COALESCE(p.full_name, f.filer_name) AS member_name
        FROM transactions t
        JOIN filings f ON f.id = t.filing_id
        LEFT JOIN politicians p ON p.id = t.politician_id
        WHERE f.status IN ({marks})
        ORDER BY t.id
    """, db.COUNTED_STATUSES).fetchall()


def _fetches(conn: sqlite3.Connection) -> dict[str, sqlite3.Row]:
    return {r["ticker"]: r for r in conn.execute("SELECT * FROM track_price_fetches")}


def _record_fetch(conn, ticker: str, status: str, bars, stamp: str) -> None:
    conn.execute(
        "INSERT INTO track_price_fetches (ticker, fetched_at, status, first_date, last_date) "
        "VALUES (?,?,?,?,?) ON CONFLICT(ticker) DO UPDATE SET fetched_at=excluded.fetched_at, "
        "status=excluded.status, first_date=excluded.first_date, last_date=excluded.last_date",
        (ticker, stamp, status, bars[0].date if bars else None,
         bars[-1].date if bars else None))


# --- reconciling decisions with the transactions --------------------------------


def reconcile(conn: sqlite3.Connection, decisions: list[stats.TrackDecision],
              fetches: dict[str, sqlite3.Row]) -> int:
    """Bring `track_decisions` in line with the current grouping.

    New decisions are inserted unmeasured; a decision whose earliest trade
    date or exclusion changed (a re-parsed filing, a ticker the source turned
    out not to carry) loses its measurement and is measured afresh; one that
    no longer exists is deleted. Returns how many rows changed.
    """
    stored = {(r["filing_id"], r["ticker"], r["direction"]): r
              for r in conn.execute("SELECT * FROM track_decisions")}
    reset = ", ".join(f"{c} = NULL" for c in SIGNED_COLUMNS)
    changed = 0
    seen = set()
    for d in decisions:
        key = (d.filing_id, d.ticker, d.direction)
        seen.add(key)
        exclusion = d.exclusion
        fetch = fetches.get(d.ticker)
        if exclusion is None and fetch is not None and fetch["status"] == "no_data":
            exclusion = "no_price_series"
        old = stored.get(key)
        if old is None:
            conn.execute(
                "INSERT INTO track_decisions (filing_id, politician_id, member_name, ticker, "
                "direction, tx_date, rows, exclusion) VALUES (?,?,?,?,?,?,?,?)",
                (d.filing_id, d.politician_id, d.member_name, d.ticker, d.direction,
                 d.tx_date, d.rows, exclusion))
            changed += 1
            continue
        if old["tx_date"] != d.tx_date or old["exclusion"] != exclusion:
            conn.execute(
                f"UPDATE track_decisions SET politician_id = ?, member_name = ?, tx_date = ?, "
                f"rows = ?, exclusion = ?, t0_trade = NULL, t0_disclosure = NULL, "
                f"checked_through = NULL, series_ended = NULL, {reset} WHERE id = ?",
                (d.politician_id, d.member_name, d.tx_date, d.rows, exclusion, old["id"]))
            changed += 1
        elif (old["politician_id"], old["member_name"], old["rows"]) != (
                d.politician_id, d.member_name, d.rows):
            conn.execute(
                "UPDATE track_decisions SET politician_id = ?, member_name = ?, rows = ? "
                "WHERE id = ?", (d.politician_id, d.member_name, d.rows, old["id"]))
            changed += 1
    for key, old in stored.items():
        if key not in seen:
            conn.execute("DELETE FROM track_decisions WHERE id = ?", (old["id"],))
            changed += 1
    return changed


def write_coverage(conn: sqlite3.Connection, tally: dict[str, int]) -> None:
    """Rebuild `track_coverage`: rows and decisions per outcome.

    Row counts come from the grouping's tally; a decision excluded for want
    of a price series moves its rows from "included" to that reason.
    `series_ended` is a subset of "included", not a reason: those decisions
    are measured at every horizon their series reached and are never
    pending again (stats.series_ended).
    """
    decisions: dict[str, int] = {}
    moved = 0
    ended_rows = 0
    for r in conn.execute("SELECT exclusion, rows, series_ended FROM track_decisions"):
        outcome = r["exclusion"] or "included"
        decisions[outcome] = decisions.get(outcome, 0) + 1
        if r["exclusion"] == "no_price_series":
            moved += r["rows"]
        if r["exclusion"] is None and r["series_ended"]:
            decisions["series_ended"] = decisions.get("series_ended", 0) + 1
            ended_rows += r["rows"]
    rows = dict(tally)
    if moved:
        rows["included"] = rows.get("included", 0) - moved
        rows["no_price_series"] = rows.get("no_price_series", 0) + moved
    rows["series_ended"] = ended_rows
    stamp = db.now_iso()
    conn.execute("DELETE FROM track_coverage")
    for outcome in ("included", "series_ended") + stats.TRACK_EXCLUSIONS:
        if rows.get(outcome) or decisions.get(outcome):
            conn.execute("INSERT INTO track_coverage (outcome, rows, decisions, computed_at) "
                         "VALUES (?,?,?,?)",
                         (outcome, rows.get(outcome, 0), decisions.get(outcome, 0), stamp))


# --- measuring ------------------------------------------------------------------


def _eligible(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    """Decisions that may be measured: not excluded, or excluded only for
    want of a series (re-asked after NO_DATA_RETRY_DAYS)."""
    return conn.execute("""
        SELECT d.*, f.filing_date
        FROM track_decisions d JOIN filings f ON f.id = d.filing_id
        WHERE d.exclusion IS NULL OR d.exclusion = 'no_price_series'
    """).fetchall()


def _targets(calendar: list[str], i_trade: int | None, i_disc: int | None) -> list[str]:
    """Every horizon session either clock has reached on the calendar."""
    out = []
    for i0 in (i_trade, i_disc):
        if i0 is None:
            continue
        out += [calendar[i0 + h] for h in stats.TRACK_HORIZONS if i0 + h < len(calendar)]
    return out


def _measure(calendar, bench, closes, i_trade, i_disc) -> dict[str, float | None]:
    values = {}
    for clock, i0 in (("trade", i_trade), ("disclosure", i_disc)):
        for h in stats.TRACK_HORIZONS:
            # Every row is a measured decision, so its direction is known;
            # the sign is applied by the caller.
            values[f"signed_{clock}_{h}"] = stats.track_excess(calendar, bench, closes, i0, h)
    return values


def sync(conn: sqlite3.Connection, config: Config, *, client: PriceClient | None = None,
         now: datetime | None = None, budget_seconds: float | None = None,
         deadline: float | None = None, clock=time.monotonic,
         rescore: bool = False) -> TrackResult:
    """Group, fetch what has matured, measure, and re-score.

    `budget_seconds` overrides `track_record.budget_seconds` (0 = no limit);
    `deadline` is an absolute `clock()` value the pipeline passes so this
    step, which runs last, cannot push the poll job past its timeout
    whatever the budget says. A throttle or a verification wall stops the
    fetching (asking again only lengthens the penalty) and is recorded in
    `sync_state.track_record_status`; a ticker whose request fails is
    recorded against itself and retried next run. `rescore` rebuilds the
    scores even when no measurement changed.
    """
    settings = config.track_record
    if not settings.enabled:
        result = TrackResult("skipped: track_record.enabled is false")
        db.set_state(conn, STATE_STATUS, result.status)
        conn.commit()
        return result

    now = now or datetime.now(timezone.utc)
    today = now.date()
    stamp = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    budget = settings.budget_seconds if budget_seconds is None else budget_seconds
    ends = [d for d in ((clock() + budget) if budget else None, deadline) if d is not None]
    stop_at = min(ends) if ends else None

    decisions, tally = stats.group_track_decisions(counted_rows(conn), today)
    fetches = _fetches(conn)
    changed = reconcile(conn, decisions, fetches)
    write_coverage(conn, tally)
    conn.commit()

    result = TrackResult("", decisions=len(decisions), changed=changed)
    result.eligible = conn.execute(
        "SELECT COUNT(*) FROM track_decisions WHERE exclusion IS NULL").fetchone()[0]
    final = final_through(now)
    have_scores = conn.execute("SELECT COUNT(*) FROM track_scores").fetchone()[0] > 0
    if (not changed and not rescore and db.get_state(conn, STATE_COMPLETE) == final
            and (have_scores or not result.eligible)):
        result.status = "ok: up to date"
        db.set_state(conn, STATE_STATUS, result.status)
        conn.commit()
        return result

    eligible = _eligible(conn)
    stopped: str | None = None
    if eligible:
        own_client = client is None
        client = client or PriceClient(config.prices.source)
        try:
            stopped = _fetch_and_measure(conn, client, eligible, fetches, today, final, stamp,
                                         stop_at, clock, result)
        finally:
            if own_client:
                client.close()

    if result.measured or changed or rescore or not have_scores or _minimum_changed(conn, settings):
        rescore_all(conn, settings.min_decisions, settings.min_filings)
        result.scored = True
    write_coverage(conn, tally)
    if stopped:
        result.status = stopped
    else:
        result.status = (f"ok: {result.fetched} ticker(s) fetched, {result.measured} "
                         f"decision(s) measured, {result.left} left for the next run")
        if not result.left:
            db.set_state(conn, STATE_COMPLETE, final)
    if result.left:
        log.warning("track record: %d ticker(s) left for the next run", result.left)
    db.set_state(conn, STATE_STATUS, result.status)
    conn.commit()
    return result


def _fetch_and_measure(conn, client, eligible, fetches, today: date, final: str, stamp: str,
                       stop_at: float | None, clock, result: TrackResult) -> str | None:
    """The fetching half of `sync`; returns a stop status, or None."""
    start = min(date.fromisoformat(r["tx_date"]) for r in eligible) - timedelta(days=LOOKBACK_DAYS)
    try:
        bars = client.fetch(stats.BENCHMARK_TICKER, start, today)
    except PricesThrottled as exc:
        return f"throttled: {exc}"
    except PricesBlocked as exc:
        return f"blocked: {exc}"
    except Exception as exc:
        return f"error: benchmark {stats.BENCHMARK_TICKER}: {exc}"[:300]
    bench = {b.date: b.close for b in bars if b.date <= final and b.close > 0}
    calendar = sorted(bench)
    if not calendar:
        return f"error: no {stats.BENCHMARK_TICKER} closes from the source"

    # t0 on both clocks for every eligible decision; which need a series.
    due: dict[str, list] = {}
    retry_before = (today - timedelta(days=NO_DATA_RETRY_DAYS)).isoformat()
    for r in eligible:
        i_trade = stats.session_on_or_after(calendar, r["tx_date"])
        i_disc = stats.session_after(calendar, r["filing_date"])
        t0s = (calendar[i_trade] if i_trade is not None else None,
               calendar[i_disc] if i_disc is not None else None)
        if (r["t0_trade"], r["t0_disclosure"]) != t0s:
            conn.execute("UPDATE track_decisions SET t0_trade = ?, t0_disclosure = ? WHERE id = ?",
                         (*t0s, r["id"]))
        if r["exclusion"] == "no_price_series":
            fetch = fetches.get(r["ticker"])
            if fetch is not None and fetch["fetched_at"][:10] > retry_before:
                continue
        checked = r["checked_through"]
        if any(checked is None or t > checked for t in _targets(calendar, i_trade, i_disc)):
            due.setdefault(r["ticker"], []).append((r, i_trade, i_disc))
    conn.commit()

    def order(ticker: str):
        fetch = fetches.get(ticker)
        failed = fetch is not None and fetch["status"].startswith("error")
        return (fetch is not None, failed, -len(due[ticker]), ticker)

    tickers = sorted(due, key=order)
    result.tickers_due = len(tickers)
    for index, ticker in enumerate(tickers):
        if stop_at is not None and clock() >= stop_at:
            result.left = len(tickers) - index
            return None
        work = due[ticker]
        first = min(calendar[i] for _, i, _ in work if i is not None) if any(
            i is not None for _, i, _ in work) else calendar[0]
        try:
            series = client.fetch(ticker, date.fromisoformat(first) - timedelta(days=LOOKBACK_DAYS),
                                  today)
        except PricesThrottled as exc:
            result.left = len(tickers) - index
            return f"throttled: {exc}"
        except PricesBlocked as exc:
            result.left = len(tickers) - index
            return f"blocked: {exc}"
        except Exception as exc:
            result.errors += 1
            _record_fetch(conn, ticker, f"error: {exc}"[:200], [], stamp)
            conn.commit()
            log.warning("track record: %s failed: %s", ticker, exc)
            continue
        series = [b for b in series if b.date <= final and b.close > 0]
        result.fetched += 1
        _record_fetch(conn, ticker, "ok" if series else "no_data", series, stamp)
        if not series:
            result.no_data += 1
            reset = ", ".join(f"{c} = NULL" for c in SIGNED_COLUMNS)
            conn.execute(f"UPDATE track_decisions SET exclusion = 'no_price_series', "
                         f"checked_through = NULL, series_ended = NULL, {reset} "
                         f"WHERE ticker = ? AND exclusion IS NULL", (ticker,))
            conn.commit()
            continue
        closes = {b.date: b.close for b in series}
        ended = stats.series_ended(calendar, closes)
        for r, i_trade, i_disc in work:
            values = _measure(calendar, bench, closes, i_trade, i_disc)
            sign = -1.0 if r["direction"] == "sell" else 1.0
            signed = [None if v is None else sign * v for v in
                      (values[c] for c in SIGNED_COLUMNS)]
            conn.execute(
                f"UPDATE track_decisions SET exclusion = NULL, checked_through = ?, "
                f"series_ended = ?, {', '.join(f'{c} = ?' for c in SIGNED_COLUMNS)} WHERE id = ?",
                (calendar[-1], ended, *signed, r["id"]))
            result.measured += 1
        conn.commit()
    return None


# --- scoring --------------------------------------------------------------------


def _minimum_changed(conn: sqlite3.Connection, settings) -> bool:
    rows = {(r["min_decisions"], r["min_filings"]) for r in conn.execute(
        "SELECT DISTINCT min_decisions, min_filings FROM track_model")}
    return bool(rows) and rows != {(settings.min_decisions, settings.min_filings)}


def rescore_all(conn: sqlite3.Connection, min_decisions: int = stats.TRACK_MIN_DECISIONS,
                min_filings: int = stats.TRACK_MIN_FILINGS) -> int:
    """Rebuild `track_scores` and `track_model` from the stored decisions;
    returns the number of score rows."""
    decisions = conn.execute(
        "SELECT * FROM track_decisions WHERE exclusion IS NULL AND t0_trade IS NOT NULL "
        "AND t0_disclosure IS NOT NULL").fetchall()
    scores, models = stats.track_scores(decisions, min_decisions=min_decisions,
                                        min_filings=min_filings)
    stamp = db.now_iso()
    conn.execute("DELETE FROM track_scores")
    conn.execute("DELETE FROM track_model")
    for s in scores:
        conn.execute(
            "INSERT INTO track_scores (member_name, politician_id, horizon, n, filings, "
            "min_decisions, min_filings, qualifies, rank, trade_mean, trade_score, trade_lo, trade_hi, "
            "trade_hit_rate, trade_luck, disclosure_mean, disclosure_score, disclosure_lo, "
            "disclosure_hi, disclosure_hit_rate, disclosure_luck, computed_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (s.member_name, s.politician_id, s.horizon, s.n, s.filings, s.min_decisions,
             s.min_filings,
             int(s.qualifies), s.rank,
             s.trade.mean, s.trade.score, s.trade.lo, s.trade.hi, s.trade.hit_rate, s.trade.luck,
             s.disclosure.mean, s.disclosure.score, s.disclosure.lo, s.disclosure.hi,
             s.disclosure.hit_rate, s.disclosure.luck, stamp))
    for m in models:
        conn.execute(
            "INSERT INTO track_model (clock, horizon, k, sigma2, tau2, mean, members_fit, decisions, "
            "members, ranked, min_decisions, min_filings, computed_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (m["clock"], m["horizon"], m["k"], m["sigma2"], m["tau2"], m["mean"], m["members_fit"],
             m["decisions"], m["members"], m["ranked"], m["min_decisions"], m["min_filings"],
             stamp))
    conn.commit()
    return len(scores)
