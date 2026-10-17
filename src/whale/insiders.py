"""SEC Form 4 ingestion: discover, fetch, filter, store.

Roughly 420 Form 4s are filed every business day and most are compensation
plumbing — option exercises, tax withholding, grants, gifts. The database is
committed to git every three hours, so this step keeps only filings whose
open-market purchases or sales reach the configured floor in one direction,
and stores only those rows. Rejected filings are not recorded; the cursor is
what stops them being re-examined.

The cursor is a watermark. Filings are processed oldest → newest and the
cursor is written after every one, kept or rejected, so a run that stops
part-way (throttled, network error, out of time) has finished everything at
or below the cursor and touched nothing above it; the next tick continues.
If the feed has forgotten more than it remembers — an outage longer than
about two business days — the run records a gap for `backfill-insiders` to
repair from the daily index.

A kept filing enters as `parsed` only when alert rules exist and it is recent
enough to be worth interrupting for; otherwise it enters as `backfilled`,
which is history for the dashboard and never announced. That gate is what
stops a first run — or a long backfill — replaying days of filings into
Telegram.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import statistics
import time
from collections import Counter
from dataclasses import dataclass, field
from datetime import date, timedelta

import httpx

from . import db, edgar, form4, house, stats
from .config import Config
from .edgar import EdgarClient, EdgarThrottled, FilingRef
from .form4 import Form4, SecHeader, Transaction

log = logging.getLogger(__name__)

# Leaves room in the 20-minute job for the House steps and an optional backfill.
SYNC_BUDGET_SECONDS = 420
BACKFILL_BUDGET_SECONDS = 480

STATE_CURSOR = "edgar_cursor"
STATE_STATUS = "edgar_status"
STATE_SKIPPED = "edgar_skipped"
STATE_GAP = "edgar_gap"
STATE_BACKFILL_THROUGH = "edgar_backfill_through"

# History: stored for the dashboard, never announced.
HISTORY_STATUS = "backfilled"
# Owed a notification. `notify_insiders` decides whether a rule wants it.
PENDING_STATUS = "parsed"


@dataclass
class SyncResult:
    seen: int = 0
    stored: int = 0
    skipped: Counter = field(default_factory=Counter)
    cursor: str | None = None
    aborted: str | None = None

    def summary(self) -> str:
        skipped = ", ".join(f"{k} {v}" for k, v in sorted(self.skipped.items())) or "none"
        text = f"{self.stored} stored / {self.seen} seen; skipped: {skipped}"
        if self.aborted:
            text += f"; stopped early ({self.aborted})"
        return text


# --- live sync ---------------------------------------------------------------


def sync(conn: sqlite3.Connection, config: Config, client: EdgarClient | None = None,
         today: date | None = None, budget_seconds: float = SYNC_BUDGET_SECONDS,
         clock=time.monotonic) -> SyncResult:
    """Pull everything the feed has published since the cursor. Never raises
    for the failures it knows about; `pipeline` guards the rest."""
    result = SyncResult()
    if not config.insiders.enabled:
        return result
    if not config.insiders_configured:
        log.warning("%s not set; skipping insider sync", edgar.USER_AGENT_ENV)
        _set_status(conn, f"skipped: {edgar.USER_AGENT_ENV} not set")
        return result
    if "@" not in (config.edgar_user_agent or ""):
        log.warning("%s carries no contact e-mail; SEC may refuse the traffic",
                    edgar.USER_AGENT_ENV)

    own_client = client is None
    client = client or EdgarClient(config.edgar_user_agent)
    started = clock()
    cursor = db.get_state(conn, STATE_CURSOR)
    result.cursor = cursor
    try:
        try:
            refs, reached, amendments = _discover_feed(client, cursor)
        except Exception as exc:
            log.warning("EDGAR feed discovery failed: %s", exc)
            result.aborted = _abort_reason(exc)
            _set_status(conn, result.aborted)
            return result
        result.skipped["amendments"] = amendments
        result.seen = len(refs)
        known = db.known_accessions(conn, [r.accession for r in refs])

        for ref in refs:
            if clock() - started > budget_seconds:
                result.aborted = "budget"
                break
            if ref.accession in known:
                outcome = "known"
            else:
                try:
                    outcome = process_filing(conn, config, client, ref, source="feed",
                                             today=today)
                except (EdgarThrottled, httpx.HTTPError) as exc:
                    # Transient: stop here, cursor stays at the last success.
                    result.aborted = _abort_reason(exc)
                    break
                except Exception:
                    # One malformed filing must not wedge the cursor forever.
                    log.exception("insider filing %s failed", ref.accession)
                    outcome = "error"
            _tally(result, outcome)
            result.cursor = ref.updated_utc
            db.set_state(conn, STATE_CURSOR, ref.updated_utc)
            conn.commit()

        _finish_sync(conn, result, reached, cursor, today)
    finally:
        if own_client:
            client.close()
    return result


def _discover_feed(client: EdgarClient, cursor: str | None) -> tuple[list[FilingRef], bool, int]:
    """Page newest-first until the cursor is reached or the feed runs out.

    Returns refs oldest → newest, whether the cursor was reached (a first run
    counts as reached), and how many amendments were skipped.
    """
    entries = []
    amendments: set[str] = set()
    reached = cursor is None
    start = 0
    while start < edgar.FEED_CAP:
        page = edgar.fetch_feed_page(client, start)
        stop = False
        for e in page:
            if cursor and e.updated_utc <= cursor:
                # Seeing the cursor's own second proves continuity; entries at
                # exactly that second are still re-examined (strict < stops).
                reached = True
                if e.updated_utc < cursor:
                    stop = True
                    break
            if e.form_type != "4":
                if e.form_type == "4/A":
                    amendments.add(e.accession)
                continue
            entries.append(e)
        if stop or len(page) < edgar.FEED_PAGE:
            break
        start += edgar.FEED_PAGE
    refs = edgar.group_feed(entries)
    refs.sort(key=lambda r: (r.updated_utc or "", r.accession))
    return refs, reached, len(amendments)


def _finish_sync(conn: sqlite3.Connection, result: SyncResult, reached: bool,
                 previous_cursor: str | None, today: date | None) -> None:
    db.set_state(conn, STATE_SKIPPED, json.dumps(dict(result.skipped), sort_keys=True))
    if result.aborted and result.aborted != "budget":
        status = result.aborted
    elif not reached:
        start = (previous_cursor or "")[:10]
        end = (today or date.today()).isoformat()
        db.set_state(conn, STATE_GAP, f"{start}..{end}")
        status = (f"gap: feed ran out before reaching the cursor ({previous_cursor}); "
                  f"run `python -m whale backfill-insiders --from {start} --to {end}`")
        log.warning(status)
    else:
        status = f"ok: {result.stored} stored / {result.seen} seen"
        if result.aborted == "budget":
            status += " (out of time; continuing next run)"
    db.set_state(conn, STATE_STATUS, status)
    conn.commit()


# --- one filing --------------------------------------------------------------


def ingest_status(config: Config, filing_date: str | None,
                  today: date | None = None) -> str:
    """Whether a newly stored filing is owed a notification.

    With no rules configured nothing would ever read `parsed`, and a filing
    already older than the age gate is history — both land as history so a
    first run cannot replay days of filings into Telegram.
    """
    if not config.insiders.alerting:
        return HISTORY_STATUS
    recent = house.is_recent(filing_date, config.insiders.max_filing_age_days, today)
    return PENDING_STATUS if recent else HISTORY_STATUS


def process_filing(conn: sqlite3.Connection, config: Config, client: EdgarClient,
                   ref: FilingRef, source: str, status: str | None = None,
                   today: date | None = None) -> str:
    """Fetch, parse, filter and maybe store one filing. Returns the outcome:
    stored | below_floor | no_price | no_open_market | other_form | not_found | parse_failed."""
    text = edgar.fetch_submission(client, ref)
    if text is None:
        return "not_found"
    header, xml = form4.parse_submission(text)
    if header.form_type and header.form_type != "4":
        return "other_form"
    if xml is None:
        _store_failed(conn, header, ref, source, "no ownership XML in submission")
        return "parse_failed"
    try:
        doc = form4.parse_form4(xml)
    except Exception as exc:
        _store_failed(conn, header, ref, source, f"parse error: {exc}")
        return "parse_failed"

    rows = form4.open_market(doc.transactions)
    if not rows:
        return "no_open_market"
    if form4.keep_reason(doc, config.insiders.min_trade_cents) is None:
        # An unknown value cannot clear a value floor; say which it was.
        return "no_price" if all(t.value_cents is None for t in rows) else "below_floor"

    if status is None:
        status = ingest_status(config, header.filed_date or ref.filed_date, today)
    store_filing(conn, header, doc, ref, source, status)
    return "stored"


def store_filing(conn: sqlite3.Connection, header: SecHeader, doc: Form4, ref: FilingRef,
                 source: str, status: str) -> int:
    """Filing, owners and open-market rows — all or nothing."""
    accession = header.accession or ref.accession
    filing_date = header.filed_date or ref.filed_date
    if not filing_date:
        raise ValueError(f"{accession}: no filing date in header or feed")
    try:
        filing_id = db.insert_insider_filing(
            conn,
            accession=accession,
            form_type=header.form_type or ref.form_type,
            issuer_cik=doc.issuer_cik,
            issuer_name=doc.issuer_name,
            ticker=doc.ticker,
            ticker_as_filed=doc.ticker_as_filed,
            period_of_report=doc.period_of_report or header.period_of_report,
            filing_date=filing_date,
            accepted_at=header.accepted_at,
            aff_10b5_one=None if doc.aff_10b5_one is None else int(doc.aff_10b5_one),
            source=source,
            source_url=ref.index_url,
            status=status,
            remarks=doc.remarks,
        )
        if filing_id is None:
            # Already known (a re-parse after a fix): keep the row, refresh
            # its children and status.
            filing_id = db.insider_filing_id(conn, accession)
            db.set_insider_status(conn, filing_id, status, None)
        for owner in doc.owners:
            db.upsert_insider(conn, owner.cik, owner.name)
        db.replace_insider_owners(conn, filing_id, [_owner_row(o) for o in doc.owners])
        # The issuer's price history is the yardstick for an implausible
        # value; this filing's own rows are not part of it.
        reference = stats.issuer_reference_price(conn, doc.issuer_cik, exclude_filing_id=filing_id)
        db.replace_insider_transactions(
            conn, filing_id,
            [_tx_row(t, filing_date, reference) for t in form4.open_market(doc.transactions)],
        )
    except Exception:
        conn.rollback()
        raise
    return filing_id


def _store_failed(conn: sqlite3.Connection, header: SecHeader, ref: FilingRef,
                  source: str, error: str) -> None:
    """Keep an unreadable filing visible and re-parseable, with no children."""
    filing_date = header.filed_date or ref.filed_date or (ref.updated_utc or "")[:10] or None
    if not filing_date:
        raise ValueError(f"{ref.accession}: cannot record a failure without a filing date")
    accession = header.accession or ref.accession
    filing_id = db.insert_insider_filing(
        conn, accession=accession, form_type=header.form_type or ref.form_type,
        issuer_cik=header.issuer_cik, issuer_name=header.issuer_name,
        filing_date=filing_date, accepted_at=header.accepted_at, source=source,
        source_url=ref.index_url, status="failed", last_error=error[:500],
    )
    if filing_id is None:
        db.set_insider_status(conn, db.insider_filing_id(conn, accession), "failed", error[:500])
    log.warning("insider filing %s unreadable: %s", accession, error)


def _owner_row(o: form4.Owner) -> dict:
    return {
        "cik": o.cik, "is_director": o.is_director, "is_officer": o.is_officer,
        "is_ten_percent_owner": o.is_ten_percent_owner, "is_other": o.is_other,
        "officer_title": o.officer_title, "other_text": o.other_text,
    }


def _tx_row(t: Transaction, filing_date: str, reference_price: float | None = None) -> dict:
    value = t.value_cents
    # A deemed execution date, when given, is when the clock starts.
    late = stats.form4_is_late(t.deemed_execution_date or t.tx_date, filing_date)
    implausible = stats.form4_is_implausible(
        _float(t.shares), _float(t.price_per_share), value, reference_price)
    return {
        "tx_date": t.tx_date,
        "deemed_execution_date": t.deemed_execution_date,
        "security_title": t.security_title,
        "transaction_code": t.transaction_code,
        "action": t.action,
        "acquired_disposed": t.acquired_disposed,
        "timeliness": t.timeliness,
        "shares": _float(t.shares),
        "price_per_share": _float(t.price_per_share),
        # Exact figure: min = max = exact, or all None. Never 0 for unknown.
        "amount_min_cents": value,
        "amount_max_cents": value,
        "amount_exact_cents": value,
        "shares_after": _float(t.shares_after),
        "direct_or_indirect": t.direct_or_indirect,
        "nature_of_ownership": t.nature_of_ownership,
        "footnotes": "\n".join(t.footnotes) or None,
        "late": None if late is None else int(late),
        "implausible": None if implausible is None else int(implausible),
    }


def _float(value) -> float | None:
    return None if value is None else float(value)


def _tally(result: SyncResult, outcome: str) -> None:
    if outcome == "stored":
        result.stored += 1
    elif outcome != "known":
        result.skipped[outcome] += 1


def _abort_reason(exc: Exception) -> str:
    return f"throttled: {exc}" if isinstance(exc, EdgarThrottled) else f"error: {exc}"


def _set_status(conn: sqlite3.Connection, status: str) -> None:
    db.set_state(conn, STATE_STATUS, status)
    conn.commit()


# --- backfill ----------------------------------------------------------------


def backfill_range(conn: sqlite3.Connection, config: Config, start: date, end: date,
                   client: EdgarClient | None = None,
                   budget_seconds: float = BACKFILL_BUDGET_SECONDS,
                   limit: int | None = None, clock=time.monotonic) -> SyncResult:
    """Walk the daily form index from `start` to `end`, inclusive.

    Independent of the feed cursor. Progress is recorded per completed day in
    `edgar_backfill_through`; a run that stops early logs where to resume.
    About 420 filings a day at ~7 requests/second is a minute per day of
    history, so callers chunk by time budget rather than by day count.
    """
    result = SyncResult()
    if not config.insiders_configured:
        log.warning("%s not set; cannot backfill insiders", edgar.USER_AGENT_ENV)
        return result

    own_client = client is None
    client = client or EdgarClient(config.edgar_user_agent)
    started = clock()
    day = start
    try:
        while day <= end:
            if clock() - started > budget_seconds:
                result.aborted = "budget"
                break
            if day.weekday() >= 5:
                day += timedelta(days=1)
                continue
            try:
                rows = edgar.fetch_daily_index(client, day)
            except (EdgarThrottled, httpx.HTTPError) as exc:
                result.aborted = _abort_reason(exc)
                break
            if rows is None:
                log.info("no daily index for %s (holiday?)", day)
                db.set_state(conn, STATE_BACKFILL_THROUGH, day.isoformat())
                conn.commit()
                day += timedelta(days=1)
                continue

            refs = edgar.group_index([r for r in rows if r.form_type == "4"])
            result.skipped["amendments"] += len({r.accession for r in rows if r.form_type == "4/A"})
            known = db.known_accessions(conn, [r.accession for r in refs])
            stopped = False
            for ref in refs:
                if limit is not None and result.seen >= limit:
                    result.aborted = "limit"
                    stopped = True
                    break
                if clock() - started > budget_seconds:
                    result.aborted = "budget"
                    stopped = True
                    break
                result.seen += 1
                if ref.accession in known:
                    continue
                try:
                    # History never notifies, however recent the day's index.
                    outcome = process_filing(conn, config, client, ref, source="index",
                                             status=HISTORY_STATUS)
                except (EdgarThrottled, httpx.HTTPError) as exc:
                    result.aborted = _abort_reason(exc)
                    stopped = True
                    break
                except Exception:
                    log.exception("insider filing %s failed", ref.accession)
                    outcome = "error"
                _tally(result, outcome)
                conn.commit()
            if stopped:
                break
            db.set_state(conn, STATE_BACKFILL_THROUGH, day.isoformat())
            conn.commit()
            log.info("backfilled %s: %d Form 4 filing(s) examined", day, len(refs))
            day += timedelta(days=1)

        if result.aborted:
            log.warning("backfill stopped (%s); resume with --from %s", result.aborted, day)
        else:
            _clear_gap_if_covered(conn, start, end)
    finally:
        if own_client:
            client.close()
    return result


def _clear_gap_if_covered(conn: sqlite3.Connection, start: date, end: date) -> None:
    gap = db.get_state(conn, STATE_GAP)
    if not gap or ".." not in gap:
        return
    try:
        gap_start, gap_end = (date.fromisoformat(s) for s in gap.split("..", 1))
    except ValueError:
        return
    if start <= gap_start and end >= gap_end:
        db.set_state(conn, STATE_GAP, None)
        conn.commit()
        log.info("insider feed gap %s repaired", gap)


def recompute_late(conn: sqlite3.Connection) -> int:
    """Rebuild the derived `late` flag from the stored dates."""
    rows = conn.execute(
        """SELECT t.id, t.tx_date, t.deemed_execution_date, f.filing_date
           FROM insider_transactions t JOIN insider_filings f ON f.id = t.filing_id"""
    ).fetchall()
    for r in rows:
        late = stats.form4_is_late(r["deemed_execution_date"] or r["tx_date"], r["filing_date"])
        conn.execute("UPDATE insider_transactions SET late = ? WHERE id = ?",
                     (None if late is None else int(late), r["id"]))
    conn.commit()
    return len(rows)


def recompute_implausible(conn: sqlite3.Connection) -> int:
    """Rebuild the derived `implausible` flag for every stored row.

    The issuer-relative branch of the rule depends on what else is stored, so
    a flag set at ingest can go stale as an issuer's history fills in; this
    re-judges every row against the current table. Returns how many rows are
    now flagged.
    """
    rows = conn.execute(
        """SELECT t.id, t.filing_id, f.issuer_cik, f.status, t.shares, t.price_per_share,
                  t.amount_exact_cents
           FROM insider_transactions t JOIN insider_filings f ON f.id = t.filing_id"""
    ).fetchall()
    # Reference prices per (issuer, filing) in memory: one query per row would
    # be thousands of median scans over the same few rows.
    by_issuer: dict[str, list[sqlite3.Row]] = {}
    for r in rows:
        by_issuer.setdefault(r["issuer_cik"], []).append(r)
    flagged = 0
    for r in rows:
        others = [
            x["price_per_share"] for x in by_issuer[r["issuer_cik"]]
            if x["filing_id"] != r["filing_id"] and x["status"] in db.COUNTED_STATUSES
            and x["price_per_share"] is not None and x["price_per_share"] > 0
        ]
        verdict = stats.form4_is_implausible(
            r["shares"], r["price_per_share"], r["amount_exact_cents"],
            statistics.median(others) if others else None)
        flagged += verdict is True
        conn.execute("UPDATE insider_transactions SET implausible = ? WHERE id = ?",
                     (None if verdict is None else int(verdict), r["id"]))
    conn.commit()
    return flagged
