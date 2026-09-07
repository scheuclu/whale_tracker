"""CLI reporting over the knowledge base."""

from __future__ import annotations

import sqlite3

from .amounts import format_amount, usd
from .config import Config
from .db import COUNTED_STATUSES
from . import db, stats


def top_tickers(config: Config, window_days: int | None, by: str, limit: int) -> None:
    conn = db.connect(config.db_path)
    try:
        rows = stats.top_tickers(conn, window_days, by=by, limit=limit)
        if not rows:
            print("no transactions yet — run `whale backfill` first")
            return
        window = f"last {window_days}d" if window_days else "all time"
        print(f"\nTop tickers by {by} ({window})\n")
        print(f"{'TICKER':<8} {'PEOPLE':>6} {'TRADES':>7} {'BUY/SELL':>10} "
              f"{'VOLUME (mid)':>14}   RANGE")
        print("─" * 78)
        for s in rows:
            vol_range = ("≥" + usd(s.volume.min_cents) if s.volume.max_cents is None
                         else format_amount(s.volume.min_cents, s.volume.max_cents))
            print(f"{s.ticker:<8} {s.politician_count:>6} {s.trade_count:>7} "
                  f"{str(s.buy_count) + '/' + str(s.sell_count):>10} "
                  f"{usd(s.volume.mid_cents):>14}   {vol_range}")
        print("\nAmounts are disclosure brackets; 'mid' is an estimate, not a reported figure.")
    finally:
        conn.close()


def ticker_detail(config: Config, ticker: str, window_days: int | None) -> None:
    conn = db.connect(config.db_path)
    try:
        s = stats.ticker_stats(conn, window_days).get(ticker.upper())
        if not s:
            print(f"no transactions for {ticker.upper()}"
                  + (f" in the last {window_days}d" if window_days else ""))
            return
        print(f"\n{s.ticker} — {s.asset_name or ''}")
        print(f"{s.politician_count} politicians · {s.trade_count} trades · "
              f"{s.buy_count} buys / {s.sell_count} sells")
        print(f"Volume {format_amount(s.volume.min_cents, s.volume.max_cents)} "
              f"(mid {usd(s.volume.mid_cents)})")
        if s.buy_politicians:
            print(f"\nBought by: {', '.join(sorted(s.buy_politicians))}")
        if s.sell_politicians:
            print(f"Sold by:   {', '.join(sorted(s.sell_politicians))}")

        print("\nTransactions:")
        for r in _ticker_rows(conn, ticker.upper(), window_days):
            amount = format_amount(r["amount_min_cents"], r["amount_max_cents"],
                                   r["amount_exact_cents"])
            print(f"  {r['tx_date']}  {r['action']:<13} {amount:<20} {r['member_name']}")
    finally:
        conn.close()


def _ticker_rows(conn: sqlite3.Connection, ticker: str,
                 window_days: int | None) -> list[sqlite3.Row]:
    marks = ", ".join("?" for _ in COUNTED_STATUSES)
    sql = f"""SELECT t.*, COALESCE(p.full_name, f.filer_name) AS member_name
              FROM transactions t
              JOIN filings f ON f.id = t.filing_id
              LEFT JOIN politicians p ON p.id = t.politician_id
              WHERE t.ticker = ? AND f.status IN ({marks})"""
    params: list = [ticker, *COUNTED_STATUSES]
    if window_days:
        from datetime import date, timedelta
        sql += " AND t.tx_date >= ?"
        params.append((date.today() - timedelta(days=window_days)).isoformat())
    sql += " ORDER BY t.tx_date DESC"
    return conn.execute(sql, params).fetchall()


def politicians(config: Config, window_days: int | None, limit: int) -> None:
    conn = db.connect(config.db_path)
    try:
        rows = stats.politician_stats(conn, window_days, limit)
        if not rows:
            print("no transactions yet — run `whale backfill` first")
            return
        window = f"last {window_days}d" if window_days else "all time"
        print(f"\nMost active members ({window})\n")
        print(f"{'MEMBER':<30} {'TRADES':>7} {'TICKERS':>8} {'VOLUME (mid)':>14} "
              f"{'DELAY':>7} {'LATE':>5} {'LAG':>5}")
        print("─" * 84)
        for a in rows:
            who = f"{a['name']} ({a['party'] or '?'}-{a['state'] or '?'})"
            delay = f"{a['avg_delay_days']:.0f}d" if a["avg_delay_days"] is not None else "—"
            lag = f"{a['avg_lag_days']:.0f}d" if a["avg_lag_days"] is not None else "—"
            print(f"{who[:30]:<30} {a['trade_count']:>7} {a['ticker_count']:>8} "
                  f"{usd(a['volume'].mid_cents):>14} {delay:>7} {a['late_count']:>5} {lag:>5}")
        print("\nDELAY = mean days from trade to the report reaching the Clerk.")
        print("LATE  = trades filed past the STOCK Act's 45-day deadline.")
        print("LAG   = mean days until the member was notified of their own trade; a")
        print("        nonzero lag means someone else placed it (spouse, trust, manager).")
    finally:
        conn.close()


def pipeline_status(config: Config) -> None:
    conn = db.connect(config.db_path)
    try:
        print("\nFilings by status:")
        for r in conn.execute(
            "SELECT chamber, status, COUNT(*) n FROM filings "
            "GROUP BY chamber, status ORDER BY chamber, n DESC"
        ):
            print(f"  {r['chamber']:<7} {r['status']:<14} {r['n']:>5}")

        print("\nParse method:")
        for r in conn.execute(
            "SELECT COALESCE(parse_method,'—') m, COUNT(*) n FROM filings "
            "WHERE parse_method IS NOT NULL GROUP BY m ORDER BY n DESC"
        ):
            print(f"  {r['m']:<14} {r['n']:>5}")

        totals = conn.execute(
            "SELECT COUNT(*) tx, COUNT(DISTINCT ticker) tickers, "
            "COUNT(DISTINCT politician_id) people FROM transactions"
        ).fetchone()
        print(f"\nTransactions: {totals['tx']} · tickers: {totals['tickers']} "
              f"· members: {totals['people']}")

        senate_status = db.get_state(conn, "senate_status")
        print(f"Senate eFD:   {senate_status or 'not attempted'}")

        errors = conn.execute(
            "SELECT doc_id, last_error FROM filings WHERE status = 'failed' LIMIT 8"
        ).fetchall()
        if errors:
            print("\nRecent failures:")
            for e in errors:
                print(f"  {e['doc_id']}: {(e['last_error'] or '')[:70]}")
    finally:
        conn.close()
