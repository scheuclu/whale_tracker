"""Pipeline orchestration: sync → parse → notify → cluster → insiders.

Every step commits DB state before the next runs, so a crash at any point
resumes cleanly on the next cron tick via the filing status state machine.
"""

from __future__ import annotations

import io
import logging
import sqlite3

from . import db, house, insiders, roster, senate, stats, telegram
from .amounts import parse_amount
from .config import Config
from .ptr import ParsedFiling, ScannedFilingError, parse_pdf
from .vision import VisionUnavailable, parse_scanned

log = logging.getLogger(__name__)


def run(config: Config, dry_run: bool = False) -> None:
    conn = db.connect(config.db_path)
    try:
        sync(conn, config)
        parse_pending(conn, config)
        notify_pending(conn, config, dry_run=dry_run)
        notify_clusters(conn, config, dry_run=dry_run)
        _sync_insiders(conn, config)
    finally:
        conn.close()


# --- sync -------------------------------------------------------------------


def sync(conn: sqlite3.Connection, config: Config) -> int:
    """Refresh the roster and record newly filed disclosures."""
    roster.sync(conn)
    matcher = roster.Matcher(conn)

    new_count = 0
    for year in config.ingest.years:
        try:
            entries = house.ptr_entries(house.fetch_index(year))
        except Exception:
            log.exception("House index fetch failed for %d; continuing", year)
            continue

        # On a first-ever run the whole year is unseen. Notifying about all of
        # it would flood Telegram, so only genuinely recent filings enter the
        # notify path; the rest are recorded for `backfill` to parse silently.
        for entry in entries:
            if db.filing_exists(conn, "house", entry.doc_id):
                continue
            member = matcher.match(entry.filer_name, entry.state_district, "house")
            recent = house.is_recent(entry.filing_date, config.ingest.max_filing_age_days)
            db.insert_filing(
                conn,
                chamber="house",
                doc_id=entry.doc_id,
                politician_id=member["id"] if member else None,
                filer_name=entry.filer_name,
                state_district=entry.state_district,
                filing_type=entry.filing_type,
                filing_date=entry.filing_date,
                year=entry.year,
                pdf_url=entry.pdf_url,
                status="new" if recent else "seen_skipped",
            )
            new_count += recent
        conn.commit()

    if config.senate_enabled:
        _sync_senate(conn, config)

    log.info("sync: %d new filing(s) queued", new_count)
    return new_count


def _sync_senate(conn: sqlite3.Connection, config: Config) -> None:
    """Best-effort. Senate eFD blocks datacenter IPs; a block is not an error."""
    try:
        filings = senate.fetch_ptrs(config.senate_proxy_url)
    except senate.SenateBlocked as exc:
        log.info("senate eFD unavailable (%s); House-only this run", exc)
        db.set_state(conn, "senate_status", f"blocked: {exc}")
        conn.commit()
        return
    except Exception as exc:
        log.warning("senate eFD failed unexpectedly: %s", exc)
        db.set_state(conn, "senate_status", f"error: {exc}")
        conn.commit()
        return

    db.set_state(conn, "senate_status", f"ok: {len(filings)} filings seen")
    # Senate PTRs are HTML reports, not the House's PDF template, so they need
    # their own parser. Recording them keeps the queue ready for that work.
    matcher = roster.Matcher(conn)
    for f in filings:
        if db.filing_exists(conn, "senate", f.doc_id):
            continue
        member = matcher.match(f"{f.first} {f.last}", None, "senate")
        db.insert_filing(
            conn, chamber="senate", doc_id=f.doc_id,
            politician_id=member["id"] if member else None,
            filer_name=f"{f.first} {f.last}".strip(), state_district=None,
            filing_type="P", filing_date=f.filed_date, year=0, pdf_url=f.url,
            status="seen_skipped",
        )
    conn.commit()


def _sync_insiders(conn: sqlite3.Connection, config: Config) -> None:
    """Best-effort, and last: an EDGAR slowdown must never delay House alerts.

    `insiders.sync` absorbs the failures it knows about (throttling, network,
    a malformed filing); this guard is for everything else.
    """
    if not config.insiders.enabled:
        return
    try:
        result = insiders.sync(conn, config)
    except Exception as exc:
        log.exception("insider sync failed unexpectedly")
        db.set_state(conn, insiders.STATE_STATUS, f"error: {exc}")
        conn.commit()
        return
    log.info("insiders: %s", result.summary())


# --- parse ------------------------------------------------------------------


def parse_pending(conn: sqlite3.Connection, config: Config,
                  statuses: tuple[str, ...] = ("new",),
                  target_status: str = "parsed", limit: int | None = None,
                  silent: bool = False) -> int:
    """Download and parse queued filings into transactions.

    `silent` marks everything it touches as already notified, which is what
    backfill needs: history should populate the statistics without replaying
    months of filings into Telegram.
    """
    filings = [f for f in db.filings_by_status(conn, *statuses) if f["chamber"] == "house"]
    if limit:
        filings = filings[:limit]

    done = 0
    for filing in filings:
        try:
            pdf_bytes = house.fetch_pdf(filing["pdf_url"])
        except Exception as exc:
            # Transient: leave the status alone so the next run retries.
            log.warning("PDF download failed for %s: %s", filing["doc_id"], exc)
            continue

        try:
            parsed, method = _parse_bytes(pdf_bytes, config)
        except VisionUnavailable as exc:
            db.set_status(conn, filing["id"], "failed",
                          f"scanned paper filing ({exc})", "scanned")
            if silent:
                db.mark_notified(conn, filing["id"])
            conn.commit()
            log.info("filing %s is a scan and vision is unavailable", filing["doc_id"])
            continue
        except Exception as exc:
            db.set_status(conn, filing["id"], "failed", f"parse error: {exc}", "error")
            if silent:
                db.mark_notified(conn, filing["id"])
            conn.commit()
            log.exception("parse failed for %s", filing["doc_id"])
            continue

        rows = [_transaction_row(t) for t in parsed.transactions]
        db.replace_transactions(conn, filing["id"], filing["politician_id"], rows)
        db.set_status(conn, filing["id"], target_status, None, method)
        if silent:
            db.mark_notified(conn, filing["id"])
        conn.commit()
        done += 1
        log.info("parsed %s (%s): %d transaction(s)", filing["doc_id"], method, len(rows))
    return done


def _parse_bytes(pdf_bytes: bytes, config: Config) -> tuple[ParsedFiling, str]:
    """Text layer first; scanned filings fall back to the vision model.

    Returns the filing and which method read it, so the dashboard can show how
    much of the corpus depended on transcription.
    """
    try:
        return parse_pdf(io.BytesIO(pdf_bytes)), "text"
    except ScannedFilingError:
        if not config.vision_enabled:
            raise VisionUnavailable("vision disabled in config.yaml") from None
        # VisionUnavailable propagates: the caller distinguishes "this is a
        # scan we cannot read" from "the parser broke".
        try:
            return parse_scanned(pdf_bytes, config.gemini_api_key), "vision"
        except VisionUnavailable:
            raise
        except Exception as exc:
            raise ValueError(f"vision parse failed: {exc}") from exc


def _transaction_row(tx) -> dict:
    amount = parse_amount(tx.amount_raw)
    return {
        "tx_date": tx.tx_date,
        "notification_date": tx.notification_date,
        "owner": tx.owner,
        "asset_name": tx.asset_name,
        "ticker": tx.ticker,
        "asset_type": tx.asset_type,
        "action": tx.action,
        "amount_min_cents": amount.min_cents if amount else None,
        "amount_max_cents": amount.max_cents if amount else None,
        "amount_exact_cents": amount.exact_cents if amount else None,
        "cap_gains_over_200": (
            None if tx.cap_gains_over_200 is None else int(tx.cap_gains_over_200)
        ),
        "description": tx.description,
        "raw_text": tx.raw_text,
    }


# --- notify -----------------------------------------------------------------


def notify_pending(conn: sqlite3.Connection, config: Config, dry_run: bool = False) -> int:
    if not (config.telegram_configured or dry_run):
        log.warning("Telegram secrets not set; skipping notifications")
        return 0

    sent = 0
    for filing in db.filings_by_status(conn, "parsed", unnotified_only=True):
        rows = [dict(r) for r in db.transactions_for_filing(conn, filing["id"])]
        for r in rows:
            r["delay_days"] = stats.disclosure_delay_days(r["tx_date"], filing["filing_date"])

        contexts = {}
        for ticker in {r["ticker"] for r in rows if r["ticker"]}:
            ctx = stats.ticker_context(conn, ticker, config.alerts.window_days)
            if ctx:
                contexts[ticker] = ctx

        text = telegram.format_filing(
            member=filing["member_name"] or filing["filer_name"],
            party=filing["party"],
            state=_state_of(filing),
            district=_district_of(filing),
            chamber=filing["member_chamber"] or filing["chamber"],
            filing_date=filing["filing_date"],
            pdf_url=filing["pdf_url"],
            transactions=rows,
            contexts=contexts,
        )
        if _deliver(config, text, dry_run) and not dry_run:
            db.set_status(conn, filing["id"], "notified", None)
            db.mark_notified(conn, filing["id"])
            sent += 1
        conn.commit()

    # Filings we could not read are reported rather than silently dropped.
    for filing in db.filings_by_status(conn, "failed", unnotified_only=True):
        if filing["parse_method"] not in ("scanned", "error"):
            continue
        text = telegram.format_unparsed(
            member=filing["member_name"] or filing["filer_name"],
            party=filing["party"], state=_state_of(filing), district=_district_of(filing),
            chamber=filing["member_chamber"] or filing["chamber"],
            filing_date=filing["filing_date"], pdf_url=filing["pdf_url"],
            reason=(filing["last_error"] or "unreadable")[:80],
        )
        if _deliver(config, text, dry_run) and not dry_run:
            # Status stays 'failed': the filing is reported but still unread,
            # so it is re-parsed if the pipeline later gains a vision key.
            db.mark_notified(conn, filing["id"])
            sent += 1
        conn.commit()
    return sent


def notify_clusters(conn: sqlite3.Connection, config: Config, dry_run: bool = False) -> int:
    """Alert when several members converge on one ticker."""
    if not (config.telegram_configured or dry_run):
        return 0

    sent = 0
    for cluster in stats.find_clusters(conn, config.alerts):
        if not stats.is_new_cluster(conn, cluster):
            continue
        text = telegram.format_cluster(cluster, config.alerts.window_days)
        if _deliver(config, text, dry_run) and not dry_run:
            db.record_alert(conn, "cluster", cluster.ticker, cluster.direction,
                            config.alerts.window_days, cluster.politician_count,
                            cluster.volume.mid_cents)
            sent += 1
        conn.commit()
    return sent


def _deliver(config: Config, text: str, dry_run: bool) -> bool:
    """Send, or print under --dry-run. Callers must not persist state on a dry
    run: previewing the queue should never consume it."""
    if dry_run:
        print("\n" + "─" * 60)
        print(text)
        return True
    try:
        telegram.send_message(config.telegram_bot_token, config.telegram_chat_id, text)
    except Exception:
        # Leave status unchanged; retried next run without re-parsing.
        log.exception("telegram send failed")
        return False
    return True


def _state_of(filing) -> str | None:
    if filing["state_district"]:
        return roster.parse_state_district(filing["state_district"])[0]
    return None


def _district_of(filing) -> str | None:
    _, district = roster.parse_state_district(filing["state_district"])
    return str(district) if district is not None else None


# --- backfill ---------------------------------------------------------------


def backfill(config: Config, year: int | None, limit: int | None) -> int:
    """Parse already-seen filings into the DB *without* notifying.

    Cluster alerts are meaningless against an empty database — "3 politicians
    bought NVDA" needs history to be true. This loads that history quietly.
    """
    conn = db.connect(config.db_path)
    try:
        sql = "SELECT id FROM filings WHERE status = 'seen_skipped' AND chamber = 'house'"
        params: list = []
        if year:
            sql += " AND year = ?"
            params.append(year)
        sql += " ORDER BY filing_date DESC"
        if limit:
            sql += " LIMIT ?"
            params.append(limit)

        ids = [r["id"] for r in conn.execute(sql, params).fetchall()]
        for filing_id in ids:
            db.set_status(conn, filing_id, "backfill_queued", None)
        conn.commit()
        return parse_pending(conn, config, statuses=("backfill_queued",),
                             target_status="backfilled", silent=True)
    finally:
        conn.close()
