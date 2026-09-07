"""CLI entry point: python -m whale <command>."""

from __future__ import annotations

import argparse
import logging

from . import db
from .config import load_config


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    parser = argparse.ArgumentParser(
        prog="whale", description="Congressional stock-trade disclosure tracker"
    )
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("init-db", help="create the database")
    sub.add_parser("sync", help="refresh the roster and filing index only")
    sub.add_parser("status", help="pipeline and coverage status")

    p_run = sub.add_parser("run", help="run the full pipeline once")
    p_run.add_argument("--dry-run", action="store_true",
                       help="print Telegram messages instead of sending them")

    p_backfill = sub.add_parser(
        "backfill", help="parse already-seen filings into the DB without notifying")
    p_backfill.add_argument("--year", type=int, help="limit to one filing year")
    p_backfill.add_argument("--limit", type=int, help="max filings to parse")

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

    args = parser.parse_args(argv)
    config = load_config()

    if args.command == "init-db":
        db.connect(config.db_path).close()
        print(f"database ready at {config.db_path}")
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

    if args.command == "backfill":
        from . import pipeline

        count = pipeline.backfill(config, args.year, args.limit)
        print(f"parsed {count} filing(s) into the knowledge base (no notifications sent)")
        return 0

    from . import query

    if args.command == "tickers":
        query.top_tickers(config, args.since, args.by, args.limit)
    elif args.command == "ticker":
        query.ticker_detail(config, args.symbol, args.since)
    elif args.command == "politicians":
        query.politicians(config, args.since, args.limit)
    elif args.command == "status":
        query.pipeline_status(config)
    return 0


def _parse_since(value: str) -> int:
    return int(value.rstrip("dD"))


if __name__ == "__main__":
    raise SystemExit(main())
