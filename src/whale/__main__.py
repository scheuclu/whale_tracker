"""CLI entry point: python -m whale <command>."""

from __future__ import annotations

import argparse
import logging
from datetime import date, timedelta
from pathlib import Path

from . import db
from .config import load_config


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    parser = argparse.ArgumentParser(
        prog="whale",
        description="Congressional and corporate-insider stock-trade disclosure tracker",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("init-db", help="create the database")
    sub.add_parser("sync", help="refresh the roster and filing index only")
    sub.add_parser("status", help="pipeline and coverage status")

    p_audit = sub.add_parser(
        "audit", help="data-integrity and pipeline-health checks (markdown report)")
    p_audit.add_argument("--out", type=Path, help="write the report here instead of stdout")
    p_audit.add_argument("--fail-on", choices=("error", "warning"), default=None,
                         help="exit non-zero when a finding at this severity or worse exists")

    p_run = sub.add_parser("run", help="run the full pipeline once")
    p_run.add_argument("--dry-run", action="store_true",
                       help="print Telegram messages instead of sending them")

    p_digest = sub.add_parser(
        "digest", help="the week in one Telegram message (the poll run sends it on Mondays "
                       "when telegram.digest is on)")
    p_digest.add_argument("--dry-run", action="store_true",
                          help="print the digest instead of sending it; records nothing")
    p_digest.add_argument("--days", type=int, default=7,
                          help="window on filing date, in days (default 7)")

    p_backfill = sub.add_parser(
        "backfill", help="parse already-seen filings into the DB without notifying")
    p_backfill.add_argument("--year", type=int, help="limit to one filing year")
    p_backfill.add_argument("--limit", type=int, help="max filings to parse")
    p_backfill.add_argument("--chamber", choices=("house", "senate", "all"), default="all",
                            help="which chamber's indexed filings to parse (default: all)")

    sub.add_parser(
        "backfill-options",
        help="re-derive each stored row's option contract (kind, strike, expiry) "
             "from its asset name and description")

    p_capture = sub.add_parser(
        "capture-scans",
        help="store every scanned filing's pages and the grid reader's rows for the "
             "/scans inspection view (no API key needed; resumable)")
    p_capture.add_argument("--limit", type=int, help="max filings to capture")
    p_capture.add_argument("--budget-seconds", type=float, default=600,
                           help="stop after this long; the next run continues (default 600)")
    p_capture.add_argument("--pdf-dir", type=Path,
                           help="read PDFs from here when present and save downloads here")

    p_tickers = sub.add_parser("tickers", help="ticker leaderboard")
    p_tickers.add_argument("--since", type=_parse_since, default=None, metavar="30d",
                           help="rolling window, e.g. 30d (default: all time)")
    p_tickers.add_argument("--by", choices=("volume", "politicians"), default="volume")
    p_tickers.add_argument("--limit", type=int, default=20)

    p_ticker = sub.add_parser("ticker", help="detail for one ticker")
    p_ticker.add_argument("symbol")
    p_ticker.add_argument("--since", type=_parse_since, default=None, metavar="90d")

    p_people = sub.add_parser("politicians", help="most active members")
    p_people.add_argument("--since", type=_parse_since, default=None, metavar="90d")
    p_people.add_argument("--limit", type=int, default=25)

    # SEC Form 4 (corporate insiders)
    sub.add_parser("sync-insiders", help="pull new SEC Form 4 filings (no notifications)")

    p_bfi = sub.add_parser(
        "backfill-insiders", help="load Form 4 history from EDGAR's daily index")
    p_bfi.add_argument("--from", dest="start", type=date.fromisoformat, metavar="YYYY-MM-DD",
                       help="first day, inclusive")
    p_bfi.add_argument("--to", dest="end", type=date.fromisoformat, metavar="YYYY-MM-DD",
                       help="last day, inclusive (default: yesterday)")
    p_bfi.add_argument("--budget-seconds", type=float, default=480,
                       help="stop after this long and say where to resume (default 480)")
    p_bfi.add_argument("--limit", type=int, help="max filings to examine")
    p_bfi.add_argument("--recompute-late", action="store_true",
                       help="only rebuild the derived late flag, then exit")
    p_bfi.add_argument("--recompute-implausible", action="store_true",
                       help="only re-judge the derived implausible-value flag, then exit")

    p_classify = sub.add_parser(
        "classify-issuers",
        help="fetch EDGAR SIC codes for every traded ticker and Form 4 issuer, "
             "and fold them into industry groups (resumable; needs EDGAR_USER_AGENT)")
    p_classify.add_argument("--budget-seconds", type=float, default=600,
                            help="stop after this long; the next run continues (default 600)")

    p_ins = sub.add_parser("insiders", help="issuer leaderboard for insider trades")
    p_ins.add_argument("--since", type=_parse_since, default=None, metavar="30d")
    p_ins.add_argument("--by", choices=("value", "insiders"), default="value")
    p_ins.add_argument("--direction", choices=("buy", "sell"), default=None)
    p_ins.add_argument("--limit", type=int, default=25)
    p_ins.add_argument("--clusters", action="store_true",
                       help="issuers where several insiders traded the same way")

    p_insider = sub.add_parser("insider", help="insider trades in one issuer")
    p_insider.add_argument("symbol")
    p_insider.add_argument("--since", type=_parse_since, default=None, metavar="90d")

    p_ialerts = sub.add_parser(
        "insider-alerts",
        help="preview which stored filings the configured alert rules match")
    p_ialerts.add_argument("--since", type=_parse_since, default=None, metavar="30d")
    p_ialerts.add_argument("--limit", type=int, default=20)
    p_ialerts.add_argument("--show-message", action="store_true",
                           help="print the Telegram message each match would send")

    p_prices = sub.add_parser(
        "fetch-prices",
        help="refresh daily closes for every alerted ticker and the benchmark, rebuild "
             "the post-alert outcomes, and print the per-kind summary")
    p_prices.add_argument("--budget-seconds", type=float, default=None,
                          help="stop after this long; the next run continues "
                               "(default: prices.budget_seconds)")

    args = parser.parse_args(argv)
    config = load_config()

    if args.command == "init-db":
        db.connect(config.db_path).close()
        print(f"database ready at {config.db_path}")
        return 0

    if args.command == "audit":
        from . import audit

        text, findings = audit.report(config.db_path)
        if args.out:
            args.out.write_text(text)
            print(f"audit written to {args.out}")
        else:
            print(text)
        if args.fail_on:
            worst = {"error": (audit.ERROR,), "warning": (audit.ERROR, audit.WARN)}[args.fail_on]
            if any(f.severity in worst for f in findings):
                return 1
        return 0

    if args.command == "sync":
        from . import pipeline

        conn = db.connect(config.db_path)
        try:
            pipeline.sync(conn, config)
        finally:
            conn.close()
        return 0

    if args.command == "run":
        from . import pipeline

        pipeline.run(config, dry_run=args.dry_run)
        return 0

    if args.command == "digest":
        from . import digest

        if args.days < 1:
            parser.error("--days must be at least 1")
        if not (args.dry_run or config.telegram_configured):
            parser.error("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are not set; "
                         "use --dry-run to preview the digest")
        conn = db.connect(config.db_path)
        try:
            digest.send(conn, config, days=args.days, dry_run=args.dry_run)
        finally:
            conn.close()
        if not args.dry_run:
            print("weekly digest sent")
        return 0

    if args.command == "backfill":
        from . import pipeline

        count = pipeline.backfill(config, args.year, args.limit, args.chamber)
        print(f"parsed {count} filing(s) into the knowledge base (no notifications sent)")
        return 0

    if args.command == "backfill-options":
        from . import options

        conn = db.connect(config.db_path)
        try:
            seen, structured = options.backfill(conn)
            conn.commit()
        finally:
            conn.close()
        print(f"options: {structured} of {seen} row(s) carry a parsed contract")
        return 0

    if args.command == "capture-scans":
        from . import scan_capture

        conn = db.connect(config.db_path)
        try:
            result = scan_capture.capture_scans(
                conn, limit=args.limit, budget_seconds=args.budget_seconds,
                pdf_dir=args.pdf_dir)
        finally:
            conn.close()
        print(f"scan capture: {result.summary()}")
        return 0

    if args.command == "sync-insiders":
        from . import insiders

        conn = db.connect(config.db_path)
        try:
            result = insiders.sync(conn, config)
        finally:
            conn.close()
        print(f"insiders: {result.summary()}")
        return 0

    if args.command == "backfill-insiders":
        from . import insiders

        conn = db.connect(config.db_path)
        try:
            if args.recompute_late:
                print(f"recomputed the late flag on {insiders.recompute_late(conn)} row(s)")
                return 0
            if args.recompute_implausible:
                flagged = insiders.recompute_implausible(conn)
                print(f"re-judged the implausible flag: {flagged} row(s) flagged")
                return 0
            if args.start is None:
                parser.error("backfill-insiders requires --from YYYY-MM-DD")
            end = args.end or (date.today() - timedelta(days=1))
            result = insiders.backfill_range(conn, config, args.start, end,
                                             budget_seconds=args.budget_seconds,
                                             limit=args.limit)
        finally:
            conn.close()
        print(f"insiders backfill: {result.summary()}")
        return 0

    if args.command == "classify-issuers":
        from . import issuers

        conn = db.connect(config.db_path)
        try:
            result = issuers.classify(conn, config, budget_seconds=args.budget_seconds)
        finally:
            conn.close()
        print(f"issuers: {result.summary()}")
        return 0

    from . import query

    if args.command == "fetch-prices":
        from . import prices

        conn = db.connect(config.db_path)
        try:
            result = prices.sync(conn, config, budget_seconds=args.budget_seconds)
            print(f"prices: {result.summary()}")
            query.print_outcome_summary(conn)
        finally:
            conn.close()
        return 0

    if args.command == "tickers":
        query.top_tickers(config, args.since, args.by, args.limit)
    elif args.command == "ticker":
        query.ticker_detail(config, args.symbol, args.since)
    elif args.command == "politicians":
        query.politicians(config, args.since, args.limit)
    elif args.command == "insiders":
        if args.clusters:
            query.insider_clusters(config)
        else:
            query.insider_issuers(config, args.since, args.by, args.direction, args.limit)
    elif args.command == "insider":
        query.insider_detail(config, args.symbol, args.since)
    elif args.command == "insider-alerts":
        query.insider_alert_preview(config, args.since, args.limit, args.show_message)
    elif args.command == "status":
        query.pipeline_status(config)
    return 0


def _parse_since(value: str) -> int:
    return int(value.rstrip("dD"))


if __name__ == "__main__":
    raise SystemExit(main())
