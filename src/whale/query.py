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

        print("\nInsiders (SEC Form 4):")
        for r in conn.execute(
            "SELECT status, COUNT(*) n FROM insider_filings GROUP BY status ORDER BY n DESC"
        ):
            print(f"  {r['status']:<14} {r['n']:>5}")
        itot = conn.execute(
            "SELECT COUNT(*) tx, COUNT(DISTINCT f.issuer_cik) issuers "
            "FROM insider_transactions t JOIN insider_filings f ON f.id = t.filing_id"
        ).fetchone()
        print(f"  open-market trades: {itot['tx']} · issuers: {itot['issuers']}")
        for key, label in (("edgar_status", "EDGAR"), ("edgar_cursor", "cursor"),
                           ("edgar_gap", "gap"), ("edgar_backfill_through", "backfilled through"),
                           ("edgar_skipped", "skipped")):
            value = db.get_state(conn, key)
            if value:
                print(f"  {label}: {value}")

        errors = conn.execute(
            "SELECT doc_id, last_error FROM filings WHERE status = 'failed' LIMIT 8"
        ).fetchall()
        if errors:
            print("\nRecent failures:")
            for e in errors:
                print(f"  {e['doc_id']}: {(e['last_error'] or '')[:70]}")
    finally:
        conn.close()


# --- alert outcomes -----------------------------------------------------------


def print_outcome_summary(conn: sqlite3.Connection) -> None:
    """Price coverage and the per-kind outcome table, as the dashboard shows it.

    Every figure is the alerted ticker's own move after the alert, close to
    close, minus the benchmark over the same sessions — read the way the
    alert pointed, so a sell alert's hit is a fall. Not a trade's return:
    congressional amounts are brackets and none enters this.
    """
    total = conn.execute("SELECT COUNT(*) FROM alerts").fetchone()[0]
    listed = sum(1 for r in conn.execute("SELECT ticker FROM alerts")
                 if stats.is_listed_ticker(r["ticker"]))
    priced = conn.execute("SELECT COUNT(*) FROM alert_outcomes").fetchone()[0]
    newest = conn.execute("SELECT MAX(date) FROM prices WHERE ticker = ?",
                          (stats.BENCHMARK_TICKER,)).fetchone()[0]
    print(f"\nPrice coverage: {priced} of {total} alert(s) have a close at t0 "
          f"({listed} name a listed ticker); {stats.BENCHMARK_TICKER} closes through "
          f"{newest or 'none'}.")
    rows = stats.outcome_summary(conn)
    if not rows:
        print("No alert outcome yet.")
        return
    print(f"\nMove after the alert vs {stats.BENCHMARK_TICKER}, read the way the alert "
          "pointed (median excess · hit rate · n):\n")
    print(f"  {'kind':<16}" + "".join(f"{f'+{h}d':>28}" for h in stats.OUTCOME_HORIZONS))
    for kind in dict.fromkeys(r.kind for r in rows):
        cells = []
        for r in (r for r in rows if r.kind == kind):
            if not r.sufficient:
                cells.append(f"insufficient data (n={r.n})")
            else:
                cells.append(f"{r.median_excess:+.1%} · {r.hit_rate:.0%} hit · n={r.n}")
        print(f"  {kind:<16}" + "".join(f"{c:>28}" for c in cells))
    print(f"\n  n < {stats.MIN_OUTCOME_SAMPLE} is reported as insufficient data; alerts with "
          "no one direction are excluded.")


# --- insiders (SEC Form 4) ---------------------------------------------------

_VALUE_NOTE = ("Values are shares × the price as filed. A filing may report a weighted-average\n"
               "price, so treat them as approximate; rows with no price, or flagged IMPLAUSIBLE\n"
               "as filed, carry no value.")


def insider_issuers(config: Config, window_days: int | None, by: str,
                    direction: str | None, limit: int) -> None:
    conn = db.connect(config.db_path)
    try:
        rows = stats.top_insider_issuers(conn, window_days, by=by, direction=direction, limit=limit)
        if not rows:
            print("no insider trades yet — run `whale sync-insiders` first")
            return
        window = f"last {window_days}d" if window_days else "all time"
        scope = f", {direction}s only" if direction else ""
        print(f"\nTop issuers by {by} ({window}{scope})\n")
        print(f"{'TICKER':<8} {'ISSUER':<28} {'INSIDERS':>8} {'FILINGS':>7} {'BUY/SELL':>9} "
              f"{'BOUGHT':>10} {'SOLD':>10}")
        print("─" * 86)
        for s in rows:
            print(f"{(s.ticker or '—'):<8} {(s.issuer_name or '')[:28]:<28} {s.insider_count:>8} "
                  f"{s.filing_count:>7} {str(s.buy_count) + '/' + str(s.sell_count):>9} "
                  f"{usd(s.buy_volume.mid_cents):>10} {usd(s.sell_volume.mid_cents):>10}")
        print("\nINSIDERS counts primary reporting owners; a joint filing is one insider.")
        print(_VALUE_NOTE)
    finally:
        conn.close()


def insider_detail(config: Config, ticker: str, window_days: int | None) -> None:
    conn = db.connect(config.db_path)
    try:
        symbol = ticker.upper()
        issuers = [s for s in stats.insider_issuer_stats(conn, window_days).values()
                   if s.ticker == symbol]
        if not issuers:
            print(f"no insider trades for {symbol}"
                  + (f" in the last {window_days}d" if window_days else ""))
            return
        for s in issuers:
            print(f"\n{symbol} — {s.issuer_name or ''} (CIK {s.issuer_cik})")
            print(f"{s.insider_count} insiders · {s.filing_count} filings · "
                  f"{s.buy_count} buys / {s.sell_count} sells")
            print(f"Bought {usd(s.buy_volume.mid_cents)} · sold {usd(s.sell_volume.mid_cents)}")
            if s.buy_insiders:
                print(f"\nBought by: {', '.join(s.names(s.buy_insiders))}")
            if s.sell_insiders:
                print(f"Sold by:   {', '.join(s.names(s.sell_insiders))}")

        print("\nTransactions:")
        for r in _insider_rows(conn, symbol, window_days):
            value = usd(r["amount_exact_cents"]) if r["amount_exact_cents"] is not None else "—"
            shares = f"{r['shares']:,.0f}" if r["shares"] is not None else "?"
            price = f"@ ${r['price_per_share']:,.2f}" if r["price_per_share"] is not None else ""
            flags = " ".join(f for f in (
                "10b5-1" if r["aff_10b5_one"] else "",
                "LATE" if r["late"] else "",
                "filer-marked-late" if r["timeliness"] == "L" else "",
                "IMPLAUSIBLE" if r["implausible"] == 1 else "",
            ) if f)
            role = _role(r)
            print(f"  {r['tx_date']}  {r['action']:<8} {shares:>10} {price:<12} {value:>10}  "
                  f"{r['insider_name'] or '?'}{role}  {flags}")
        print()
        print(_VALUE_NOTE)
    finally:
        conn.close()


def _insider_rows(conn: sqlite3.Connection, ticker: str,
                  window_days: int | None) -> list[sqlite3.Row]:
    marks = ", ".join("?" for _ in COUNTED_STATUSES)
    sql = f"""SELECT t.*, f.aff_10b5_one, f.accession, i.name AS insider_name,
                     o.officer_title, o.is_director, o.is_officer, o.is_ten_percent_owner
              FROM insider_transactions t
              JOIN insider_filings f ON f.id = t.filing_id
              LEFT JOIN insider_filing_owners o ON o.filing_id = f.id AND o.owner_index = 0
              LEFT JOIN insiders i ON i.cik = o.insider_cik
              WHERE f.ticker = ? AND f.status IN ({marks})"""
    params: list = [ticker, *COUNTED_STATUSES]
    if window_days:
        from datetime import date, timedelta
        sql += " AND t.tx_date >= ?"
        params.append((date.today() - timedelta(days=window_days)).isoformat())
    sql += " ORDER BY t.tx_date DESC, t.id DESC"
    return conn.execute(sql, params).fetchall()


def _role(r: sqlite3.Row) -> str:
    if r["officer_title"]:
        return f" ({r['officer_title']})"
    if r["is_director"]:
        return " (Director)"
    if r["is_ten_percent_owner"]:
        return " (10% owner)"
    return ""


def insider_clusters(config: Config) -> None:
    conn = db.connect(config.db_path)
    try:
        clusters = stats.find_insider_clusters(conn, config.insiders)
        window = config.insiders.cluster_window_days
        if not clusters:
            print(f"no issuer has {config.insiders.min_insiders}+ insiders trading the same "
                  f"way in the last {window}d")
            return
        print(f"\nInsider clusters (last {window}d, {config.insiders.min_insiders}+ insiders)\n")
        for c in clusters:
            verb = "bought" if c.direction == "buy" else "sold"
            print(f"{c.ticker or '—':<8} {c.issuer_name or ''}")
            print(f"         {c.insider_count} insiders {verb} · {c.trade_count} trades · "
                  f"{usd(c.volume.mid_cents)} across {c.filing_count} filings")
            print(f"         {', '.join(c.insiders)}")
        print()
        print(_VALUE_NOTE)
    finally:
        conn.close()


def insider_alert_preview(config: Config, window_days: int | None, limit: int,
                          show_message: bool = False) -> None:
    """What the configured rules would alert on, without sending anything."""
    from . import insider_alerts, telegram

    rules = config.insiders.alerts
    if not rules:
        print("no insider alert rules configured — see the `insiders.alerts` "
              "list in config.yaml")
        return

    print("\nConfigured rules, in match order:\n")
    for i, r in enumerate(rules, 1):
        conditions = []
        if r.direction != "any":
            conditions.append(f"direction={r.direction}")
        if r.min_value_usd:
            conditions.append(f"≥{usd(r.min_value_cents)}")
        if r.roles:
            conditions.append("roles=" + "/".join(r.roles))
        if r.titles:
            conditions.append("title~" + "/".join(r.titles))
        if r.exclude_10b5_1:
            conditions.append("not 10b5-1")
        if r.require_10b5_1:
            conditions.append("10b5-1 only")
        if r.kind == "cluster":
            window = r.window_days or config.insiders.cluster_window_days
            conditions.append(f"{r.min_insiders}+ insiders in {window}d")
        print(f"  {i}. [{r.kind}] {r.name} — {', '.join(conditions) or 'anything'}")

    conn = db.connect(config.db_path)
    try:
        matches = insider_alerts.preview(conn, config.insiders, window_days, limit)
        window = f"last {window_days}d" if window_days else "all stored filings"
        print(f"\nFiling rules matched {len(matches)} filing(s) ({window}"
              + (f", showing {limit} at most" if len(matches) >= limit else "") + "):\n")
        for m in matches:
            verb = "bought" if m.direction == "purchase" else "sold"
            value = usd(m.value_cents) if m.value_cents is not None else "unpriced"
            who = (m.primary["name"] if m.primary else "?") or "?"
            print(f"  {m.filing['filing_date']}  {(m.filing['ticker'] or '—'):<6} "
                  f"{value:>9} {verb:<6}  {who[:28]:<28} → {m.rule.name}")
            if show_message:
                print("\n" + telegram.format_insider_filing(m) + "\n")

        clusters = insider_alerts.cluster_matches(conn, config.insiders)
        print(f"\nCluster rules matched {len(clusters)} issuer(s):\n")
        for cluster, rule, cwindow in clusters:
            verb = "buying" if cluster.direction == "buy" else "selling"
            print(f"  {(cluster.ticker or cluster.issuer_cik):<8} "
                  f"{cluster.insider_count} insiders {verb} · "
                  f"{usd(cluster.volume.mid_cents):>9} → {rule.name} ({cwindow}d)")
            if show_message:
                print("\n" + telegram.format_insider_cluster(cluster, rule.name, cwindow) + "\n")
        print("\nNothing was sent. Alerts fire from `whale run` on newly stored filings;")
        print("already-examined filings are demoted to history and never re-alerted.")
        print("Every rule match is listed: at send time a repeat by the same owner in the")
        print(f"same issuer and direction within {config.insiders.filing_refire_days}d "
              "(insiders.filing_refire_days) is folded unless the run has grown.")
    finally:
        conn.close()
