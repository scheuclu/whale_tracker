"""Daily closes for alerted tickers, and what each alert's ticker did next.

Nothing else in the project measures the value of an alert: the cluster rule
was tightened on plausibility and the insider rules on message volume (#53).
This step fetches a daily close series for every ticker an alert has named,
plus the benchmark, and rebuilds `alert_outcomes` — the ticker's move at
+5/+20/+60 trading days minus the benchmark's — from it (stats.alert_outcomes).

The series is an unofficial, key-less public one, and it is used for one
thing: a descriptive measurement of what happened after a message was sent.
It is never advice and never a trade's return. Two sources are known:

* ``yahoo`` — Yahoo Finance's chart endpoint (JSON). Serves split-adjusted
  closes, answers a descriptive User-Agent and 429s the default library one.
  The default: it was the one that answered when this shipped.
* ``stooq`` — Stooq's daily CSV download (`?s=nvda.us&i=d`), the source the
  issue named. On 2026-10-18 it served a JavaScript proof-of-work page to
  browser user agents and a 404 to every other one, on stooq.com and
  stooq.pl alike. That wall is reported as `blocked`, never solved; its
  known "Exceeded the daily hits limit" answer is reported as `throttled`.

Either way: at most two requests a second, one refresh per ticker per UTC
day, a time budget per poll run, and nothing here raises into the pipeline.
"""

from __future__ import annotations

import csv
import io
import logging
import sqlite3
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone

import httpx

from . import db
from .config import Config
from .stats import (BENCHMARK_TICKER, EASTERN, alert_date_eastern, alert_outcomes,
                    is_listed_ticker)

log = logging.getLogger(__name__)

# sync_state key: the last run's outcome, in the audit's vocabulary —
# `ok: …`, `throttled: …`, `blocked: …`, `error: …`, `skipped: …`.
STATE_STATUS = "prices_status"

# Polite rate: at most two requests a second, whatever the source allows.
MIN_INTERVAL_S = 0.5
# Both sources refuse anonymous library agents one way or another; name the
# project. No contact address: nothing here requires one.
USER_AGENT = "whale-tracker/0.1 (+https://github.com/scheuclu/whale_tracker)"
# Calendar days of closes kept before the earliest alert, so the first alert
# has a session before it to be measured from, and no more: the database is
# committed to git and a full history per ticker has no place in it.
LOOKBACK_DAYS = 10
# A session's close is final once the regular session has ended. Rows for the
# current New York day are dropped before this; they would hold a mid-session
# price labelled as a close until the next refresh overwrote them.
CLOSE_HOUR_ET, CLOSE_MINUTE_ET = 16, 5

STOOQ_URL = "https://stooq.com/q/d/l/?s={symbol}&d1={d1}&d2={d2}&i=d"
STOOQ_THROTTLE_TEXT = "Exceeded the daily hits limit"
STOOQ_WALL_TEXT = "requires JavaScript to verify your browser"
YAHOO_URL = ("https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
             "?period1={p1}&period2={p2}&interval=1d")


class PricesThrottled(Exception):
    """The source refused for rate reasons; the run stops and resumes next time."""


class PricesBlocked(Exception):
    """The source served a browser-verification page instead of data."""


@dataclass(frozen=True)
class Bar:
    date: str  # ISO, the session's date at the exchange
    close: float


# --- symbols and parsing (pure) ---------------------------------------------


def stooq_symbol(ticker: str) -> str:
    """BRK.B -> brk-b.us: lower case, class dots as hyphens, US suffix."""
    return ticker.strip().lower().replace(".", "-") + ".us"


def yahoo_symbol(ticker: str) -> str:
    """BRK.B -> BRK-B."""
    return ticker.strip().upper().replace(".", "-")


def parse_stooq_csv(text: str) -> list[Bar]:
    """Stooq's `Date,Open,High,Low,Close,Volume` download.

    The two non-data answers Stooq gives with a 200 are told apart first:
    the daily hit limit (a one-line text) and the browser-verification page
    (HTML). An unknown symbol answers "No data" — an empty series, not an
    error.
    """
    if STOOQ_THROTTLE_TEXT in text:
        raise PricesThrottled("Stooq: " + STOOQ_THROTTLE_TEXT)
    stripped = text.lstrip()
    if STOOQ_WALL_TEXT in text or stripped.startswith("<"):
        raise PricesBlocked("Stooq served a browser-verification page instead of CSV")
    bars = []
    for row in csv.DictReader(io.StringIO(text)):
        day, close = (row.get("Date") or "").strip(), (row.get("Close") or "").strip()
        if not day or not close or close == "-":
            continue
        try:
            bars.append(Bar(date.fromisoformat(day).isoformat(), float(close)))
        except ValueError:
            log.warning("stooq: unreadable row %r", row)
    return bars


def parse_yahoo_chart(payload: dict) -> list[Bar]:
    """Yahoo's `v8/finance/chart` JSON: one bar per timestamp with a close.

    Timestamps are the session's open in UTC; the exchange's `gmtoffset`
    turns them into the session's local date, so a New York session is dated
    the day it traded whatever UTC day its open fell on. A null close (a
    session Yahoo lists but has no price for) is skipped. `Not Found` is an
    unknown or delisted symbol: an empty series, not an error.
    """
    chart = payload.get("chart") or {}
    result = chart.get("result")
    if not result:
        error = chart.get("error") or {}
        if (error.get("code") or "").lower() == "not found":
            return []
        raise ValueError(f"yahoo: {error.get('code') or 'no result'}: "
                         f"{error.get('description') or ''}".rstrip(": "))
    first = result[0] or {}
    offset = int((first.get("meta") or {}).get("gmtoffset") or 0)
    stamps = first.get("timestamp") or []
    quotes = (first.get("indicators") or {}).get("quote") or [{}]
    closes = (quotes[0] or {}).get("close") or []
    by_day: dict[str, float] = {}
    for stamp, close in zip(stamps, closes):
        if close is None:
            continue
        day = datetime.fromtimestamp(int(stamp) + offset, timezone.utc).date().isoformat()
        by_day[day] = float(close)
    return [Bar(d, c) for d, c in sorted(by_day.items())]


def final_through(now: datetime) -> str:
    """The last New York session date whose close is final at `now`.

    Today, once the regular session has closed; otherwise yesterday. A
    source's row for a session still open is a mid-session price, and a
    refresh that stored it as a close would measure an outcome against a
    number that was not one — the next day's refresh would correct it, but
    the dashboard would have shown it for a day.
    """
    local = now.astimezone(EASTERN)
    closed = (local.hour, local.minute) >= (CLOSE_HOUR_ET, CLOSE_MINUTE_ET)
    return (local.date() if closed else local.date() - timedelta(days=1)).isoformat()


# --- the client -------------------------------------------------------------


class PriceClient:
    """One source, one HTTP session, two requests a second at most."""

    def __init__(self, source: str = "yahoo", *, http: httpx.Client | None = None,
                 min_interval: float = MIN_INTERVAL_S, clock=time.monotonic,
                 sleep=time.sleep):
        self.source = source
        self._http = http or httpx.Client(
            headers={"User-Agent": USER_AGENT,
                     "Accept": "text/csv, application/json;q=0.9, */*;q=0.8"},
            timeout=20.0, follow_redirects=True)
        self._min_interval = min_interval
        self._clock = clock
        self._sleep = sleep
        self._last: float | None = None

    def close(self) -> None:
        self._http.close()

    def _pace(self) -> None:
        if self._last is not None:
            wait = self._min_interval - (self._clock() - self._last)
            if wait > 0:
                self._sleep(wait)
        self._last = self._clock()

    def fetch(self, ticker: str, start: date, end: date) -> list[Bar]:
        """Daily closes for `ticker` from `start` to `end`, both inclusive."""
        self._pace()
        if self.source == "stooq":
            return self._fetch_stooq(ticker, start, end)
        return self._fetch_yahoo(ticker, start, end)

    def _fetch_stooq(self, ticker: str, start: date, end: date) -> list[Bar]:
        url = STOOQ_URL.format(symbol=stooq_symbol(ticker), d1=start.strftime("%Y%m%d"),
                               d2=end.strftime("%Y%m%d"))
        resp = self._http.get(url)
        if resp.status_code == 429:
            raise PricesThrottled(f"Stooq answered 429 for {ticker}")
        if resp.status_code == 404:
            # Stooq answers 404 to user agents it does not take for a
            # browser, for every symbol; an unknown symbol is a 200 "No data".
            raise PricesBlocked("Stooq answered 404 to this client (non-browser user agent)")
        resp.raise_for_status()
        return parse_stooq_csv(resp.text)

    def _fetch_yahoo(self, ticker: str, start: date, end: date) -> list[Bar]:
        p1 = int(datetime.combine(start, datetime.min.time(), timezone.utc).timestamp())
        p2 = int(datetime.combine(end + timedelta(days=1), datetime.min.time(),
                                  timezone.utc).timestamp())
        resp = self._http.get(YAHOO_URL.format(symbol=yahoo_symbol(ticker), p1=p1, p2=p2))
        if resp.status_code == 429:
            raise PricesThrottled(f"Yahoo answered 429 Too Many Requests for {ticker}")
        if resp.status_code == 404:
            # Unknown or delisted symbol: the body says so in the chart envelope.
            return parse_yahoo_chart(resp.json())
        resp.raise_for_status()
        return parse_yahoo_chart(resp.json())


# --- the sync ---------------------------------------------------------------


@dataclass
class SyncResult:
    status: str
    tracked: int = 0    # tickers with an alert, plus the benchmark
    refreshed: int = 0  # fetched this run
    fresh: int = 0      # already refreshed today, skipped
    left: int = 0       # due, but the run stopped first (budget, throttle, wall)
    no_data: int = 0    # fetched, series empty at the source
    errors: int = 0     # fetched, request failed; retried next run
    bars: int = 0       # closes written
    outcomes: int = 0   # alert_outcomes rows after the rebuild

    def summary(self) -> str:
        return (f"{self.status} — {self.refreshed} of {self.tracked} ticker(s) refreshed "
                f"({self.fresh} already today, {self.left} left for the next run, "
                f"{self.no_data} without data, {self.errors} error(s)); "
                f"{self.bars} close(s) written; {self.outcomes} alert outcome(s)")


def alerted_tickers(conn: sqlite3.Connection) -> list[str]:
    """Every listed symbol an alert has named, sorted. NULL (an alert about no
    one ticker) and CIK-shaped keys (an issuer with no symbol) are skipped."""
    return sorted(
        r["ticker"] for r in conn.execute(
            "SELECT DISTINCT ticker FROM alerts WHERE ticker IS NOT NULL")
        if is_listed_ticker(r["ticker"]))


def history_start(conn: sqlite3.Connection) -> date | None:
    """`LOOKBACK_DAYS` before the earliest listed alert; None without alerts."""
    row = conn.execute(
        "SELECT MIN(fired_at) AS first FROM alerts WHERE ticker IS NOT NULL").fetchone()
    if not row or not row["first"]:
        return None
    return alert_date_eastern(row["first"]) - timedelta(days=LOOKBACK_DAYS)


def tickers_due(conn: sqlite3.Connection, today: date) -> tuple[list[str], int]:
    """Tickers not yet refreshed on `today` (UTC), in the order to fetch them,
    and how many were already fresh.

    The benchmark first — without it there is no calendar and no excess —
    then tickers never fetched (a new alert's), then the longest-unrefreshed
    first, so a budget or a throttle that cuts a run short rotates through
    the list over several runs instead of starving the same tail every time.
    """
    wanted = [BENCHMARK_TICKER] + [t for t in alerted_tickers(conn) if t != BENCHMARK_TICKER]
    fetches = db.price_fetches(conn)
    cutoff = today.isoformat()
    due, fresh = [], 0
    for ticker in wanted:
        row = fetches.get(ticker)
        if row is not None and row["fetched_at"][:10] >= cutoff:
            fresh += 1
            continue
        due.append(ticker)

    def order(ticker: str):
        row = fetches.get(ticker)
        return (ticker != BENCHMARK_TICKER, row is not None, row["fetched_at"] if row else "")

    return sorted(due, key=order), fresh


def recompute_outcomes(conn: sqlite3.Connection) -> int:
    """Rebuild `alert_outcomes` from the stored prices; returns the row count."""
    rows = [o.row() for o in alert_outcomes(conn)]
    n = db.replace_alert_outcomes(conn, rows)
    conn.commit()
    return n


def sync(conn: sqlite3.Connection, config: Config, *, client: PriceClient | None = None,
         now: datetime | None = None, budget_seconds: float | None = None,
         clock=time.monotonic) -> SyncResult:
    """Refresh the alerted tickers' closes and rebuild the outcomes.

    Each ticker is asked for once per UTC day, for the whole window from
    `LOOKBACK_DAYS` before the first alert to today, and the answer replaces
    what was stored (db.upsert_prices). A throttle or a verification wall
    stops the run — asking again would only lengthen the penalty — and is
    recorded in `sync_state.prices_status`; a request that fails on its own
    is recorded against that ticker and the run goes on. The time budget
    (`prices.budget_seconds`, overridable here) leaves the rest for the next
    run. Outcomes are rebuilt at the end regardless, so an alert that fired
    this run is measured as soon as its ticker has a series.
    """
    settings = config.prices
    if not settings.enabled:
        result = SyncResult("skipped: prices.enabled is false")
        db.set_state(conn, STATE_STATUS, result.status)
        conn.commit()
        return result

    now = now or datetime.now(timezone.utc)
    today = now.date()
    start = history_start(conn)
    if start is None:
        result = SyncResult("ok: no alert names a ticker yet")
        db.set_state(conn, STATE_STATUS, result.status)
        conn.commit()
        return result

    due, fresh = tickers_due(conn, today)
    result = SyncResult("", tracked=len(due) + fresh, fresh=fresh)
    budget = settings.budget_seconds if budget_seconds is None else budget_seconds
    deadline = clock() + budget if budget else None
    final = final_through(now)
    stamp = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    own_client = client is None
    client = client or PriceClient(settings.source)
    stopped: str | None = None
    try:
        for index, ticker in enumerate(due):
            if deadline is not None and clock() >= deadline:
                result.left = len(due) - index
                log.warning("prices: budget of %.0fs spent; %d ticker(s) left for the next run",
                            budget, result.left)
                break
            try:
                bars = client.fetch(ticker, start, today)
            except PricesThrottled as exc:
                stopped = f"throttled: {exc}"
                result.left = len(due) - index
                break
            except PricesBlocked as exc:
                stopped = f"blocked: {exc}"
                result.left = len(due) - index
                break
            except Exception as exc:
                result.errors += 1
                db.record_price_fetch(conn, ticker, f"error: {exc}"[:200], 0, None, stamp)
                conn.commit()
                log.warning("prices: %s failed: %s", ticker, exc)
                continue
            bars = [b for b in bars if b.date <= final]
            written = db.upsert_prices(conn, ticker, settings.source,
                                       ((b.date, b.close) for b in bars), stamp)
            db.record_price_fetch(conn, ticker, "ok" if bars else "no_data", written,
                                  max((b.date for b in bars), default=None), stamp)
            conn.commit()
            result.refreshed += 1
            result.bars += written
            if not bars:
                result.no_data += 1
    finally:
        if own_client:
            client.close()

    result.outcomes = recompute_outcomes(conn)
    if stopped:
        result.status = stopped
        log.warning("prices: %s; %d ticker(s) left for the next run", stopped, result.left)
    else:
        result.status = (f"ok: {result.refreshed} ticker(s) refreshed, "
                         f"{result.outcomes} outcome(s)")
    db.set_state(conn, STATE_STATUS, result.status)
    conn.commit()
    return result
