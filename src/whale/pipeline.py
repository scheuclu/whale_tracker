"""Pipeline orchestration: sync → parse → notify → cluster → insiders.

Every step commits DB state before the next runs, so a crash at any point
resumes cleanly on the next cron tick via the filing status state machine.
"""

from __future__ import annotations

import io
import json
import logging
import sqlite3
from datetime import date

from . import (db, house, insider_alerts, insiders, roster, senate, senate_ptr, stats,
               telegram)
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
        notify_insiders(conn, config, dry_run=dry_run)
    finally:
        conn.close()


# --- sync -------------------------------------------------------------------

# sync_state key: House filings that were already older than
# `ingest.max_filing_age_days` when a run *after the first* first saw them.
# JSON {count, last_doc_id, last_filing_date, last_seen_at}. On the first
# sight of a year the cutoff is doing its job — holding back history — and
# nothing is counted; afterwards every hit is a filing the Clerk published
# later than the cutoff allows for, stored as history and never announced.
# The audit reports the counter, so a Clerk slowdown is visible rather than
# indistinguishable from first-run history.
AGE_CUTOFF_STATE = "house_age_cutoff"


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
        #
        # Whether this is that first sight is decided per year, before any
        # insert: a year newly added to ingest.years is expected to arrive as
        # history, and must not read as a week of late Clerk publication.
        first_sight = not _year_seen(conn, year)
        cutoff_hits = []
        for entry in entries:
            if db.filing_exists(conn, "house", entry.doc_id):
                continue
            member = matcher.match(entry.filer_name, entry.state_district, "house")
            recent = house.is_recent(entry.filing_date, config.ingest.max_filing_age_days)
            if not recent and config.watchlist.match(
                    member["bioguide_id"] if member else None, entry.filer_name):
                # A watched member is watched regardless of how late the Clerk
                # published the filing. The age cutoff exists to stop a first
                # run replaying a year of everyone's history; someone named
                # explicitly in config.yaml is the case it is not protecting
                # against. Bounded by ingest.years, so it is that year at most.
                recent = True
            elif not recent and not first_sight:
                # Not history: the Clerk published this later than the cutoff
                # allows for. It is stored as seen_skipped and will never be
                # announced, so say so where the run log and the audit can
                # see it rather than letting it pass as first-run replay.
                cutoff_hits.append(entry)
                log.warning(
                    "filing %s (%s, filed %s) is older than %d days on first sight; "
                    "recorded as history, not notified",
                    entry.doc_id, entry.filer_name, entry.filing_date,
                    config.ingest.max_filing_age_days)
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
        if cutoff_hits:
            # Same transaction as the inserts, so a crash cannot leave filings
            # recorded without the count that explains their status. A counter
            # that cannot be updated must not stall the ingest it describes:
            # the audit reports an unreadable one as `check_failed`.
            try:
                _record_age_cutoff(conn, cutoff_hits)
            except Exception:
                log.exception("could not update sync_state %r", AGE_CUTOFF_STATE)
        conn.commit()

    if config.senate_enabled:
        new_count += _sync_senate(conn, config)

    log.info("sync: %d new filing(s) queued", new_count)
    return new_count


def _year_seen(conn: sqlite3.Connection, year: int) -> bool:
    """Whether any House filing from this index year is already recorded."""
    return conn.execute(
        "SELECT 1 FROM filings WHERE chamber = 'house' AND year = ? LIMIT 1", (year,)
    ).fetchone() is not None


def _record_age_cutoff(conn: sqlite3.Connection, hits: list[house.IndexEntry]) -> None:
    """Add this run's cutoff hits to the running counter in sync_state."""
    raw = db.get_state(conn, AGE_CUTOFF_STATE)
    state = json.loads(raw) if raw else {}
    last = hits[-1]
    state = {
        "count": int(state.get("count", 0)) + len(hits),
        "last_doc_id": last.doc_id,
        "last_filing_date": last.filing_date,
        "last_seen_at": db.now_iso(),
    }
    db.set_state(conn, AGE_CUTOFF_STATE, json.dumps(state, sort_keys=True))


def _sync_senate(conn: sqlite3.Connection, config: Config,
                 today: date | None = None) -> int:
    """Best-effort: eFD refusing or failing is recorded, never raised.

    `senate.sync` never raises: it classifies the outcome into the vocabulary
    `sync_state.senate_status` stores and `audit.check_senate` reads, so a
    failure on our side cannot be filed under a block.

    Filings queue exactly as House ones do: `new` inside
    `ingest.max_filing_age_days` — the watchlist bypasses the cutoff for the
    same reason it does for the House — and `seen_skipped` otherwise, for
    `backfill` to parse as history. eFD prints its dates MM/DD/YYYY; they are
    stored ISO like the House's, and rows indexed before this parser existed
    are brought into line first (#40). Returns the number queued as `new`.
    """
    _normalise_senate_rows(conn)
    result = senate.sync(config.senate_proxy_url)
    db.set_state(conn, "senate_status", result.status)
    if result.kind == senate.STATUS_BLOCKED:
        log.warning("senate eFD refused the session (%s); no Senate filings this run",
                    result.status)
        conn.commit()
        return 0
    if result.kind != senate.STATUS_OK:
        log.warning("senate eFD not reached: %s", result.status)
        conn.commit()
        return 0

    # As for the House: on the first sight of the Senate the cutoff is holding
    # back history, which is its job; afterwards a filing already older than
    # the cutoff is one eFD listed late, and it is stored as history without
    # ever being announced, so say so in the log.
    first_sight = conn.execute(
        "SELECT 1 FROM filings WHERE chamber = 'senate' LIMIT 1").fetchone() is None
    matcher = roster.Matcher(conn)
    new_count = 0
    for f in result.filings:
        if db.filing_exists(conn, "senate", f.doc_id):
            continue
        # eFD prints no state on the search row or the report page; the roster
        # resolves a senator by surname and chamber, which is unique in practice.
        name = f"{f.first} {f.last}".strip()
        member = matcher.match(name, None, "senate")
        filing_date = senate.iso_date(f.filed_date)
        recent = house.is_recent(filing_date, config.ingest.max_filing_age_days, today=today)
        if not recent and config.watchlist.match(
                member["bioguide_id"] if member else None, name):
            recent = True
        elif not recent and not first_sight:
            log.warning(
                "senate filing %s (%s, filed %s) is older than %d days on first sight; "
                "recorded as history, not notified",
                f.doc_id, name, filing_date, config.ingest.max_filing_age_days)
        db.insert_filing(
            conn, chamber="senate", doc_id=f.doc_id,
            politician_id=member["id"] if member else None,
            # The state comes from the roster, so the alert can say "(R-AL)"
            # the way a House filing's Clerk-supplied "AL01" lets it.
            filer_name=name, state_district=member["state"] if member else None,
            filing_type="P", filing_date=filing_date,
            year=int(filing_date[:4]) if filing_date else 0, pdf_url=f.url,
            status="new" if recent else "seen_skipped",
        )
        new_count += recent
    conn.commit()
    log.info("senate: %d new filing(s) queued", new_count)
    return new_count


def _normalise_senate_rows(conn: sqlite3.Connection) -> int:
    """Bring Senate rows indexed before the parser existed into line.

    The first hundred were stored with eFD's MM/DD/YYYY `filing_date`,
    `year = 0` and no state. Every date comparison downstream — the age
    cutoff, the disclosure delay, the dashboard's ordering — assumes ISO, and
    the alert header reads the state off the filing, so both are filled here
    (the state from the roster row the filing already matched). Idempotent:
    nothing matches once converted, which is why this runs on every sync and
    backfill rather than as a schema bump (#40).
    """
    rows = conn.execute(
        "SELECT id, filing_date FROM filings WHERE chamber = 'senate' "
        "AND (filing_date LIKE '%/%' OR year = 0)"
    ).fetchall()
    fixed = 0
    for row in rows:
        iso = senate.iso_date(row["filing_date"])
        if not iso:
            continue
        conn.execute(
            "UPDATE filings SET filing_date = ?, year = ?, updated_at = ? WHERE id = ?",
            (iso, int(iso[:4]), db.now_iso(), row["id"]))
        fixed += 1
    fixed += conn.execute(
        """UPDATE filings
           SET state_district = (SELECT p.state FROM politicians p WHERE p.id = filings.politician_id)
           WHERE chamber = 'senate' AND politician_id IS NOT NULL
             AND (state_district IS NULL OR state_district = '')
             AND (SELECT p.state FROM politicians p WHERE p.id = filings.politician_id) IS NOT NULL"""
    ).rowcount
    if fixed:
        conn.commit()
        log.info("senate: normalised %d filing row(s) (ISO dates, state from the roster)", fixed)
    return fixed


def _sync_insiders(conn: sqlite3.Connection, config: Config,
                   client: insiders.EdgarClient | None = None,
                   today: date | None = None) -> None:
    """Best-effort, and last: an EDGAR slowdown must never delay House alerts.

    `insiders.sync` absorbs the failures it knows about (throttling, network,
    a malformed filing); this guard is for everything else. A recorded feed
    gap is repaired afterwards, so a walk of the daily index can never starve
    the live feed, and only when the feed was read to the end: a throttled
    or out-of-time sync is no moment to ask EDGAR for more.
    """
    if not config.insiders.enabled:
        return
    try:
        result = insiders.sync(conn, config, client=client, today=today)
    except Exception as exc:
        log.exception("insider sync failed unexpectedly")
        db.set_state(conn, insiders.STATE_STATUS, f"error: {exc}")
        conn.commit()
        return
    log.info("insiders: %s", result.summary())
    if result.aborted:
        return
    try:
        insiders.repair_gap(conn, config, result, client=client, today=today)
    except Exception as exc:
        log.exception("insider gap repair failed unexpectedly")
        db.set_state(conn, insiders.STATE_STATUS, f"error: gap repair failed: {exc}")
        conn.commit()


def notify_insiders(conn: sqlite3.Connection, config: Config, dry_run: bool = False,
                    today: date | None = None) -> int:
    """Alert on Form 4 filings and clusters that match a rule in config.yaml.

    Rules are the whole mechanism: with none configured nothing is stored as
    pending in the first place, so this is a no-op rather than a firehose.
    """
    settings = config.insiders
    if not (settings.enabled and settings.alerting):
        return 0
    if not (config.telegram_configured or dry_run):
        log.warning("Telegram secrets not set; skipping insider notifications")
        return 0

    sent = 0
    # Clusters are settled first, because a convergence is the stronger claim
    # and its member filings must not each repeat it. `covered` holds the
    # (issuer, direction) pairs the user has now been told about.
    sent_clusters, covered = _notify_insider_clusters(conn, config, dry_run, today)
    sent += sent_clusters

    filing_rules = settings.rules_of_kind("filing")
    # Cooldown rows touched on this run, so a dry run previews the folding
    # without writing it, and a real run reads what it just wrote.
    cooldowns: dict[tuple[str, str, str], dict] = {}
    for filing in db.insider_filings_by_status(conn, insiders.PENDING_STATUS,
                                               unnotified_only=True):
        rows, owners = insider_alerts.load_filing(conn, filing["id"])
        match = insider_alerts.first_filing_match(filing, owners, rows, filing_rules)
        if match is None:
            # No rule wants it. Demote to history so it is not re-examined
            # every run; the dashboard still counts it. Not on a dry run:
            # previewing the queue must never consume it.
            if not dry_run:
                db.set_insider_status(conn, filing["id"], insiders.HISTORY_STATUS)
                conn.commit()
            continue

        if (filing["issuer_cik"], _CLUSTER_DIRECTION[match.direction]) in covered:
            # This filing is one member of a convergence already reported as a
            # cluster. Sending it too describes the same event twice: one
            # Banco Bradesco board purchase produced 21 of these alongside its
            # cluster alert. Demoted, not dropped — the dashboard still counts
            # it and the cluster message carries the aggregate.
            if not dry_run:
                db.set_insider_status(conn, filing["id"], insiders.HISTORY_STATUS)
                conn.commit()
            log.info("insider filing %s folded into the %s cluster alert",
                     filing["accession"], filing["ticker"] or filing["issuer_cik"])
            continue

        key = insider_alerts.cooldown_key(match)
        previous = cooldowns[key] if key in cooldowns else (
            db.insider_cooldown(conn, *key) if key else None)
        decision = insider_alerts.cooldown_decision(
            previous, match, settings.filing_refire_days, settings.cluster_refire_growth)
        if not decision.fire:
            # The same owner, issuer and direction was reported inside the
            # window and the run has not grown enough to say so again. One
            # accumulation programme is one decision: Nippon Life buying
            # Corebridge sent 24 of these. Folded, not dropped — history for
            # the dashboard, and counted into the run's cumulative so the
            # next refire message carries it.
            cooldowns[key] = decision.state
            if not dry_run:
                db.set_insider_status(conn, filing["id"], insiders.HISTORY_STATUS)
                db.save_insider_cooldown(conn, decision.state)
                conn.commit()
            log.info("insider filing %s folded into the cooldown for %s (%s, %s)",
                     filing["accession"], filing["ticker"], key[0], match.direction)
            continue

        context = None
        if filing["ticker"]:
            context = _insider_context(conn, settings, filing["ticker"], match.direction,
                                       today)
        text = telegram.format_insider_filing(
            match, context, repeat=decision if decision.repeat else None)
        if _deliver(config, text, dry_run):
            # Only a delivered alert starts or extends a cooldown: a failed
            # send leaves the filing pending and the state untouched, so the
            # retry next run is judged exactly as this one was.
            if key:
                cooldowns[key] = decision.state
            if not dry_run:
                db.set_insider_status(conn, filing["id"], "notified")
                db.mark_insider_notified(conn, filing["id"])
                if key:
                    db.save_insider_cooldown(conn, decision.state)
                sent += 1
                log.info("insider alert %r for %s", match.rule.name, filing["accession"])
        conn.commit()
    return sent


# config.yaml and the cluster finder speak buy/sell; a filing match carries the
# database's purchase/sale.
_CLUSTER_DIRECTION = {"purchase": "buy", "sale": "sell"}


def _notify_insider_clusters(conn: sqlite3.Connection, config: Config, dry_run: bool,
                             today: date | None) -> tuple[int, set[tuple[str, str]]]:
    """Send the cluster alerts and report which convergences are now covered.

    A convergence counts as covered once the user has a message describing it,
    whether that was sent on this run or an earlier one. An unreported cluster
    — one whose delivery failed — is deliberately left uncovered, so its member
    filings still alert individually rather than vanishing into a message that
    was never sent.
    """
    settings = config.insiders
    sent = 0
    covered: set[tuple[str, str]] = set()
    for cluster, rule, window in insider_alerts.cluster_matches(conn, settings, today):
        key = (cluster.issuer_cik, cluster.direction)
        if not stats.is_new_insider_cluster(conn, cluster,
                                            settings.cluster_refire_growth):
            # Already reported, at this size or a smaller one. Still covered:
            # the user knows these insiders are converging.
            covered.add(key)
            continue
        text = telegram.format_insider_cluster(cluster, rule.name, window)
        if _deliver(config, text, dry_run):
            covered.add(key)
            if not dry_run:
                db.record_alert(conn, stats.INSIDER_CLUSTER_KIND,
                                cluster.ticker or cluster.issuer_cik, cluster.direction,
                                window, cluster.insider_count, cluster.volume.mid_cents)
                sent += 1
                log.info("insider cluster alert %r for %s", rule.name,
                         cluster.ticker or cluster.issuer_cik)
        conn.commit()
    return sent, covered


def _insider_context(conn: sqlite3.Connection, settings, ticker: str, direction: str,
                     today: date | None = None) -> stats.InsiderCluster | None:
    """Whether other insiders have moved the same way recently.

    One insider buying is a data point; several is the reason this project
    exists, so the message carries that context when it is true.
    """
    wanted = "buy" if direction == "purchase" else "sell"
    for cluster in stats.find_insider_clusters(conn, settings, today=today, min_insiders=2):
        if cluster.direction == wanted and (cluster.ticker or "") == ticker:
            return cluster
    return None


# --- parse ------------------------------------------------------------------


def parse_pending(conn: sqlite3.Connection, config: Config,
                  statuses: tuple[str, ...] = ("new",),
                  target_status: str = "parsed", limit: int | None = None,
                  silent: bool = False) -> int:
    """Download and parse queued filings into transactions.

    `silent` marks everything it touches as already notified, which is what
    backfill needs: history should populate the statistics without replaying
    months of filings into Telegram.

    House filings are PDFs from the Clerk; Senate filings are eFD report pages
    and take `_parse_senate_filings`. Both land in the same `transactions`
    table in the same vocabulary, so everything after this step is shared.
    """
    queued = db.filings_by_status(conn, *statuses)
    if limit:
        queued = queued[:limit]
    done = _parse_senate_filings(conn, config, [f for f in queued if f["chamber"] == "senate"],
                                 target_status, silent)
    filings = [f for f in queued if f["chamber"] == "house"]

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


def _parse_senate_filings(conn: sqlite3.Connection, config: Config, filings: list,
                          target_status: str, silent: bool) -> int:
    """The Senate half of `parse_pending`: eFD report pages instead of PDFs.

    Paper filings are told apart by URL and never fetched: eFD serves them as
    page images, the same problem as a House paper PTR, so they take the same
    path — `failed`, reported once with a link, never guessed (#1). They are
    settled first, so eFD's availability cannot delay a classification that
    needs no network. One session then serves every electronic filing of the
    run at eFD's pace of one request a second; if eFD refuses the session,
    the rest stay queued for the next run, exactly like a House download
    failure. Nothing here raises.
    """
    done = 0
    for filing in filings:
        if not senate.is_paper_url(filing["pdf_url"]):
            continue
        db.set_status(conn, filing["id"], "failed",
                      "paper filing (scanned images on eFD; not transcribed)", "efd_paper")
        if silent:
            db.mark_notified(conn, filing["id"])
        conn.commit()
        log.info("senate filing %s is a paper filing", filing["doc_id"])

    electronic = [f for f in filings if not senate.is_paper_url(f["pdf_url"])]
    session: senate.Session | None = None
    try:
        for index, filing in enumerate(electronic):
            if session is None:
                session = senate.Session(config.senate_proxy_url)
                try:
                    session.open()
                except Exception as exc:
                    session = None
                    log.warning("senate eFD session not opened (%s: %s); %d filing(s) left queued",
                                type(exc).__name__, exc, len(electronic) - index)
                    return done

            try:
                page = session.get_report(filing["pdf_url"])
            except senate.SenateBlocked as exc:
                log.warning("senate eFD refused %s (%s); %d filing(s) left queued",
                            filing["doc_id"], exc, len(electronic) - index)
                return done
            except Exception as exc:
                # Transient: leave the status alone so the next run retries.
                log.warning("senate report download failed for %s: %s", filing["doc_id"], exc)
                continue

            try:
                parsed = senate_ptr.parse_report(page)
            except Exception as exc:
                db.set_status(conn, filing["id"], "failed", f"parse error: {exc}", "error")
                if silent:
                    db.mark_notified(conn, filing["id"])
                conn.commit()
                log.exception("senate parse failed for %s", filing["doc_id"])
                continue

            rows = [_transaction_row(t) for t in parsed.transactions]
            db.replace_transactions(conn, filing["id"], filing["politician_id"], rows)
            db.set_status(conn, filing["id"], target_status, None, "efd_html")
            if silent:
                db.mark_notified(conn, filing["id"])
            conn.commit()
            done += 1
            log.info("parsed %s (efd_html): %d transaction(s)", filing["doc_id"], len(rows))
    finally:
        if session is not None:
            session.close()
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
    pending = db.filings_by_status(conn, "parsed", unnotified_only=True)
    # Watched members first: their alerts are the ones the user asked to be
    # interrupted for, so they must not queue behind a batch of routine ones.
    watched = []
    for f in pending:
        member = config.watchlist.match(f["bioguide_id"], f["filer_name"])
        if member is None:
            continue
        rows = [dict(r) for r in db.transactions_for_filing(conn, f["id"])]
        if not rows:
            # Nothing to split per transaction. Left to the filing-level path
            # below, which still reports it and consumes it from the queue.
            continue
        watched.append((f, member, rows))
    watched_ids = {f["id"] for f, _, _ in watched}

    for filing, member, rows in watched:
        sent += _notify_watched_filing(conn, config, filing, member, rows, dry_run)

    for filing in pending:
        if filing["id"] in watched_ids:
            continue
        rows = [dict(r) for r in db.transactions_for_filing(conn, filing["id"])]
        for r in rows:
            r["delay_days"] = stats.disclosure_delay_days(r["tx_date"], filing["filing_date"])

        contexts = {}
        for ticker in {r["ticker"] for r in rows if r["ticker"]}:
            ctx = stats.ticker_context(conn, ticker, config.alerts.window_days)
            if ctx:
                contexts[ticker] = ctx

        name = filing["member_name"] or filing["filer_name"]
        common = dict(
            member=name,
            party=filing["party"],
            state=_state_of(filing),
            district=_district_of(filing),
            chamber=filing["member_chamber"] or filing["chamber"],
            filing_date=filing["filing_date"],
            pdf_url=filing["pdf_url"],
            transactions=rows,
            contexts=contexts,
        )
        if len(rows) > telegram.FILING_ROW_BUDGET:
            # Past the budget every row would lose its asset name and trade
            # date to fit. A summary — the largest trades in full, the rest
            # by bracket, and the member's page for the whole table — says
            # more than a wall of tickers. Watched members never reach here:
            # their filings were split per transaction above and stay exempt.
            text = telegram.format_filing_summary(
                member_url=telegram.member_page_url(name, config.dashboard_url), **common)
        else:
            text = telegram.format_filing(**common)
        if _deliver(config, text, dry_run) and not dry_run:
            db.set_status(conn, filing["id"], "notified", None)
            db.mark_notified(conn, filing["id"])
            sent += 1
        conn.commit()

    # Filings we could not read are reported rather than silently dropped. A
    # Senate paper filing is the same case as a House scan: a link, once.
    for filing in db.filings_by_status(conn, "failed", unnotified_only=True):
        if filing["parse_method"] not in ("scanned", "error", "efd_paper"):
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


def _notify_watched_filing(conn: sqlite3.Connection, config: Config, filing,
                           member, rows: list[dict], dry_run: bool) -> int:
    """One alert per transaction for a member named in `watchlist`.

    The default path sends one message per filing, and degrades it — dropping
    context, then asset detail, then transactions themselves — to stay inside
    Telegram's limit. For a watched member that is the wrong trade-off: the
    point of watching someone is that each trade is worth its own alert, and a
    filing with 40 transactions is exactly when the truncation would bite.

    The filing is marked notified only when every transaction was delivered.
    A partial failure therefore replays the whole filing next run: duplicate
    alerts for a watched member are a smaller harm than a silently missing one.
    """
    total = len(rows)
    delivered = 0
    for index, row in enumerate(rows, start=1):
        row["delay_days"] = stats.disclosure_delay_days(row["tx_date"],
                                                        filing["filing_date"])
        context = (stats.ticker_context(conn, row["ticker"], config.alerts.window_days)
                   if row["ticker"] else None)
        text = telegram.format_watchlist_transaction(
            member=filing["member_name"] or filing["filer_name"],
            party=filing["party"], state=_state_of(filing),
            district=_district_of(filing),
            chamber=filing["member_chamber"] or filing["chamber"],
            filing_date=filing["filing_date"], pdf_url=filing["pdf_url"],
            tx=row, index=index, total=total, context=context,
        )
        if _deliver(config, text, dry_run):
            delivered += 1

    if dry_run:
        return 0
    if delivered == total:
        db.set_status(conn, filing["id"], "notified", None)
        db.mark_notified(conn, filing["id"])
        log.info("watchlist alert for %s: %d transaction(s)",
                 member.name, total)
    conn.commit()
    return delivered if delivered == total else 0


def notify_clusters(conn: sqlite3.Connection, config: Config, dry_run: bool = False) -> int:
    """Alert when several members converge on one ticker."""
    if not (config.telegram_configured or dry_run):
        return 0

    sent = 0
    today = date.today()
    for cluster in stats.find_clusters(conn, config.alerts, today=today):
        if not stats.is_new_cluster(conn, cluster, today=today):
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


BACKFILL_CHAMBERS = ("house", "senate", "all")


def backfill(config: Config, year: int | None, limit: int | None,
             chamber: str = "all") -> int:
    """Parse already-seen filings into the DB *without* notifying.

    Cluster alerts are meaningless against an empty database — "3 politicians
    bought NVDA" needs history to be true. This loads that history quietly.
    Both chambers by default: the Senate filings indexed before their parser
    existed are history too, and `year` applies to them once their dates are
    normalised (#40).
    """
    if chamber not in BACKFILL_CHAMBERS:
        raise ValueError(f"chamber must be one of {BACKFILL_CHAMBERS}, not {chamber!r}")
    conn = db.connect(config.db_path)
    try:
        _normalise_senate_rows(conn)
        chambers = ("house", "senate") if chamber == "all" else (chamber,)
        marks = ", ".join("?" for _ in chambers)
        sql = f"SELECT id FROM filings WHERE status = 'seen_skipped' AND chamber IN ({marks})"
        params: list = list(chambers)
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
