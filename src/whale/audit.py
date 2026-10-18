"""Data-integrity and pipeline-health checks over the knowledge base.

The pipeline parses a government PDF template that nobody guarantees will stay
stable. When the Clerk changes the form, or a filer uses it in a way the parser
did not anticipate, the failure is usually *silent*: rows come out empty, or an
amount lands in the wrong column, and the totals stay plausible. These checks
exist to make that visible.

Two sources, two failure modes. House PTRs are parsed out of a PDF by word
coordinates, so their risk is a mis-split column. SEC Form 4s arrive as
structured XML, so their risk is not parsing but *coverage*: a throttled or
stalled EDGAR sync silently stops storing filings, and the totals simply stop
growing without anything looking broken.

Every finding is evidence, not a verdict — a spike in unparsed filings may be a
regression or may be a week when several members filed on paper. The report is
written to be read by a human, or by the weekly review workflow.
"""

from __future__ import annotations

import re
import sqlite3
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from .amounts import BRACKETS
from .db import ALERTS_RECORDED_SINCE, COUNTED_STATUSES, connect
from .ptr import TICKER_FROM_NAME_NOTE
from .stats import TRANSCRIBED_METHOD

# Severity ordering, worst first.
ERROR, WARN, INFO = "error", "warning", "info"
SEVERITY_ORDER = {ERROR: 0, WARN: 1, INFO: 2}

# A CUSIP, not a ticker: nine alphanumerics with at least one digit.
CUSIP_RE = re.compile(r"^(?=.*\d)[A-Z0-9]{9}$")

# Deliberately NOT flagging tickers that collide with asset-type codes. Real
# symbols collide constantly — ST is Sensata, AB is AllianceBernstein, BA is
# Boeing, ET is Energy Transfer — so that rule is all false positives.

VALID_BRACKETS = {(lo * 100, hi * 100 if hi is not None else None) for lo, hi in BRACKETS}
# The e-filed form also reports "Spouse/DC Over $1,000,000" for a large trade in
# a spouse's or dependent child's asset. That is a legitimate open-ended amount,
# not a misparse, so it belongs on the accepted list.
VALID_BRACKETS.add((100_000_000, None))


@dataclass
class Finding:
    severity: str
    code: str
    title: str
    detail: str
    evidence: list[str] = field(default_factory=list)

    def as_markdown(self) -> str:
        mark = {ERROR: "🔴", WARN: "🟡", INFO: "⚪️"}[self.severity]
        out = [f"### {mark} `{self.code}` — {self.title}", "", self.detail]
        if self.evidence:
            out += ["", "```"] + self.evidence[:15] + (
                [f"… +{len(self.evidence) - 15} more"] if len(self.evidence) > 15 else []
            ) + ["```"]
        return "\n".join(out)


def _rows(conn: sqlite3.Connection, sql: str, params: tuple = ()) -> list[sqlite3.Row]:
    return conn.execute(sql, params).fetchall()


def _counted() -> str:
    return "(" + ", ".join(f"'{s}'" for s in COUNTED_STATUSES) + ")"


# --- checks -----------------------------------------------------------------


def check_empty_parsed_filings(conn, today: date | None = None) -> list[Finding]:
    """A filing marked parsed that produced no transactions.

    The most dangerous failure mode in the project: the pipeline reports
    success, the filing is never retried, and the trades simply never exist.
    A PTR always contains at least one transaction — that is what it is for.
    """
    rows = _rows(conn, f"""
        SELECT f.doc_id, f.filer_name, f.filing_date, f.parse_method, f.pdf_url
        FROM filings f
        WHERE f.status IN {_counted()}
          AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.filing_id = f.id)
        ORDER BY f.filing_date DESC
    """)
    if not rows:
        return []
    return [Finding(
        ERROR, "empty_parsed_filings",
        f"{len(rows)} filing(s) parsed successfully but produced zero transactions",
        "A periodic transaction report always contains at least one transaction. "
        "A parsed filing with none means the parser silently produced nothing — "
        "those trades are missing from every total and the filing will never be "
        "retried. Check whether the Clerk changed the PDF template.",
        [f"{r['doc_id']}  {r['filer_name']}  filed {r['filing_date']}  ({r['parse_method']})  {r['pdf_url']}"
         for r in rows],
    )]


def check_nonstandard_amount_brackets(conn, today: date | None = None) -> list[Finding]:
    """Amounts that are not on the official disclosure ladder.

    The brackets are fixed by statute, so an off-ladder pair means the amount
    column was misread — the exact failure that would corrupt volume totals
    while leaving them looking plausible.
    """
    rows = _rows(conn, f"""
        SELECT t.amount_min_cents lo, t.amount_max_cents hi, COUNT(*) n,
               MIN(f.doc_id) example
        FROM transactions t JOIN filings f ON f.id = t.filing_id
        WHERE f.status IN {_counted()}
          AND t.amount_exact_cents IS NULL AND t.amount_min_cents IS NOT NULL
        GROUP BY lo, hi
    """)
    bad = [r for r in rows if (r["lo"], r["hi"]) not in VALID_BRACKETS]
    if not bad:
        return []
    return [Finding(
        ERROR, "nonstandard_amount_brackets",
        f"{sum(r['n'] for r in bad)} transaction(s) carry an amount outside the statutory ladder",
        "Disclosure brackets are fixed by statute. A pair that is not on the "
        "ladder means the amount cell was misparsed, which corrupts volume "
        "totals without making them look wrong.",
        [f"${r['lo']/100:,.0f}–${(r['hi'] or 0)/100:,.0f}  ×{r['n']}  e.g. filing {r['example']}"
         for r in bad],
    )]


def check_ticker_sanity(conn, today: date | None = None) -> list[Finding]:
    """Tickers that look like something else — usually a bad column split."""
    rows = _rows(conn, f"""
        SELECT DISTINCT t.ticker, t.asset_type, t.asset_name, f.doc_id
        FROM transactions t JOIN filings f ON f.id = t.filing_id
        WHERE f.status IN {_counted()} AND t.ticker IS NOT NULL AND t.ticker != ''
    """)
    suspicious = [
        r for r in rows
        if CUSIP_RE.match(r["ticker"])
        or len(r["ticker"]) > 6
        or not r["ticker"].replace(".", "").replace("-", "").isalnum()
    ]
    if not suspicious:
        return []
    return [Finding(
        WARN, "suspicious_tickers",
        f"{len(suspicious)} ticker value(s) do not look like ticker symbols",
        "A CUSIP, an over-long symbol, or odd punctuation means the "
        "\"(TICKER) [XX]\" split in ptr.py picked up something that is not a "
        "ticker. Note that colliding with an asset-type code is NOT a bug: "
        "ST is Sensata, AB is AllianceBernstein, BA is Boeing.",
        [f"{r['ticker']!r}  type={r['asset_type']}  filing {r['doc_id']}  {r['asset_name'][:40]}"
         for r in suspicious],
    )]


def check_tickers_from_asset_names(conn, today: date | None = None) -> list[Finding]:
    """Tickers read off the asset name because the ticker column was empty (#50).

    Informational: the symbol is the one the filer typed, just in the wrong
    cell. The evidence lists every such symbol with its row and member
    counts, because this is where a parenthesised word that is not a ticker
    would surface. Silent when no row carries the provenance note.
    """
    rows = _rows(conn, f"""
        SELECT t.ticker, COUNT(*) AS n, COUNT(DISTINCT t.politician_id) AS members
        FROM transactions t JOIN filings f ON f.id = t.filing_id
        WHERE f.status IN {_counted()} AND t.ticker IS NOT NULL AND t.description LIKE ?
        GROUP BY t.ticker ORDER BY n DESC, t.ticker
    """, (f"%{TICKER_FROM_NAME_NOTE}%",))
    if not rows:
        return []
    total = sum(r["n"] for r in rows)
    return [Finding(
        INFO, "tickers_from_asset_names",
        f"{total} transaction(s) carry a ticker read from the asset name "
        f"({len(rows)} distinct symbol(s))",
        "The ticker column was empty and the asset name carried exactly one "
        "symbol in parentheses — \"BHP Group Limited (BHP)\" — so the parser "
        "took it and marked the row in `description`; the name is kept "
        "verbatim. On a House row only the form's own \"(SYM) [XX]\" slot "
        "counts. A symbol colliding with an asset-type code is not a defect "
        "(SE is Sea Limited); a plain word in this list would be.",
        [f"{r['ticker']:<8}{r['n']:>5} row(s)  {r['members']} member(s)" for r in rows],
    )]


def check_stuck_filings(conn, today: date | None = None) -> list[Finding]:
    """Filings queued for work that never drained — the pipeline is stalling."""
    cutoff = ((today or date.today()) - timedelta(days=2)).isoformat()
    rows = _rows(conn, """
        SELECT doc_id, filer_name, status, first_seen_at, last_error
        FROM filings
        WHERE status IN ('new', 'backfill_queued') AND substr(first_seen_at, 1, 10) < ?
        ORDER BY first_seen_at
    """, (cutoff,))
    if not rows:
        return []
    return [Finding(
        ERROR, "stuck_filings",
        f"{len(rows)} filing(s) have been queued for more than 2 days",
        "The pipeline runs every 3 hours, so anything still queued after two "
        "days is failing repeatedly and silently — most likely a download error "
        "or an exception that leaves the status unchanged by design.",
        [f"{r['doc_id']}  {r['status']}  seen {r['first_seen_at']}  {r['last_error'] or ''}"
         for r in rows],
    )]


def check_unnotified_backlog(conn, today: date | None = None) -> list[Finding]:
    """Parsed filings that were never sent to Telegram."""
    cutoff = ((today or date.today()) - timedelta(days=1)).isoformat()
    rows = _rows(conn, """
        SELECT doc_id, filer_name, filing_date FROM filings
        WHERE status = 'parsed' AND notified_at IS NULL
          AND substr(updated_at, 1, 10) < ?
    """, (cutoff,))
    if not rows:
        return []
    return [Finding(
        WARN, "unnotified_backlog",
        f"{len(rows)} parsed filing(s) still awaiting Telegram after a day",
        "Sends are retried every run, so a persistent backlog means the bot "
        "token or chat id is rejected, or the message itself fails to render.",
        [f"{r['doc_id']}  {r['filer_name']}  filed {r['filing_date']}" for r in rows],
    )]


def check_house_age_cutoff(conn, today: date | None = None) -> list[Finding]:
    """House filings the age cutoff filed as history on a run after the first.

    `ingest.max_filing_age_days` exists to keep a first run from replaying a
    year into Telegram. After that first run, a filing already older than the
    cutoff on first sight means the Clerk published it later than the cutoff
    allows for — and it was stored as `seen_skipped`, never to be announced.
    `pipeline.sync` counts those into `sync_state`; this reports the counter.
    A database where the cutoff has never bitten has no counter and produces
    nothing here, so the check is silent on a healthy pipeline.
    """
    import json

    from .db import get_state

    raw = get_state(conn, "house_age_cutoff")
    if raw is None:
        return []
    # A counter that no longer parses must surface as `check_failed`, not as a
    # pass: json.loads raising is the intended behaviour.
    state = json.loads(raw)
    count = int(state["count"])
    if not count:
        return []

    last_seen = str(state.get("last_seen_at") or "")
    last_doc = state.get("last_doc_id")
    evidence = []
    if last_doc:
        row = conn.execute(
            "SELECT filer_name, filing_date, pdf_url FROM filings "
            "WHERE chamber = 'house' AND doc_id = ?", (last_doc,)
        ).fetchone()
        evidence.append(
            f"last hit: {last_doc}  {row['filer_name'] if row else '?'}  "
            f"filed {state.get('last_filing_date')}  first seen {last_seen}  "
            f"{row['pdf_url'] if row else ''}".rstrip())

    week_ago = (today or date.today()) - timedelta(days=7)
    if last_seen and date.fromisoformat(last_seen[:10]) >= week_ago:
        return [Finding(
            WARN, "house_age_cutoff_hits",
            f"{count} House filing(s) have hit the age cutoff after the first run, "
            f"most recently {last_seen[:10]}",
            "A filing already older than `ingest.max_filing_age_days` when a "
            "run after the first saw it was stored as history and will never "
            "be announced. One in the last 7 days means the Clerk is publishing "
            "later than the cutoff allows for: read the filing below by hand, "
            "and if the lag persists raise the cutoff in config.yaml.",
            evidence,
        )]
    return [Finding(
        INFO, "house_age_cutoff_hits",
        f"{count} House filing(s) have hit the age cutoff after the first run; "
        "none in the last 7 days",
        "Each was stored as history without a notification. The counter is "
        "cumulative; it becomes a warning again the week it next grows.",
        evidence,
    )]


def check_unmatched_filers(conn, today: date | None = None) -> list[Finding]:
    """Filings whose filer could not be resolved to a member of Congress."""
    rows = _rows(conn, """
        SELECT doc_id, filer_name, state_district FROM filings
        WHERE politician_id IS NULL ORDER BY filing_date DESC
    """)
    if not rows:
        return []
    severity = ERROR if len(rows) > 5 else WARN
    return [Finding(
        severity, "unmatched_filers",
        f"{len(rows)} filing(s) could not be matched to a member",
        "Attribution falls back to the name printed on the filing, so these "
        "still appear, but with no party, state or chamber. A cluster of these "
        "usually means the roster feed changed shape or a new member is missing.",
        [f"{r['doc_id']}  {r['filer_name']!r}  {r['state_district']}" for r in rows],
    )]


def check_missing_transaction_fields(conn, today: date | None = None) -> list[Finding]:
    """Transactions missing the fields every rollup depends on."""
    out = []
    for column, code, label, severity in (
        ("tx_date", "missing_tx_date", "no transaction date", ERROR),
        ("action", "missing_action", "no buy/sell direction", ERROR),
    ):
        rows = _rows(conn, f"""
            SELECT f.doc_id, t.asset_name FROM transactions t
            JOIN filings f ON f.id = t.filing_id
            WHERE f.status IN {_counted()}
              AND COALESCE(f.parse_method, '') != '{TRANSCRIBED_METHOD}'
              AND (t.{column} IS NULL OR t.{column} = '' OR t.{column} = 'unknown')
        """)
        if rows:
            out.append(Finding(
                severity, code, f"{len(rows)} transaction(s) with {label}",
                f"Rows without `{column}` are silently excluded from windowed "
                "statistics, so they inflate nothing but quietly under-report.",
                [f"filing {r['doc_id']}  {r['asset_name'][:50]}" for r in rows],
            ))

    # Transcribed rows are left to `check_vision_rows`: a box the grid reader
    # could not call is the expected outcome there, not a parser fault.
    no_amount = _rows(conn, f"""
        SELECT f.doc_id, t.asset_name, f.parse_method FROM transactions t
        JOIN filings f ON f.id = t.filing_id
        WHERE f.status IN {_counted()}
          AND COALESCE(f.parse_method, '') != '{TRANSCRIBED_METHOD}'
          AND t.amount_min_cents IS NULL AND t.amount_exact_cents IS NULL
    """)
    if no_amount:
        out.append(Finding(
            WARN, "missing_amount",
            f"{len(no_amount)} transaction(s) have no amount",
            "These count toward trade and participation totals but contribute "
            "nothing to volume, so volume is understated relative to counts.",
            [f"filing {r['doc_id']}  ({r['parse_method']})  {r['asset_name'][:45]}"
             for r in no_amount],
        ))
    return out


def check_date_anomalies(conn, today: date | None = None) -> list[Finding]:
    """Dates that cannot be true as filed."""
    now = (today or date.today()).isoformat()
    out = []

    future = _rows(conn, f"""
        SELECT f.doc_id, t.tx_date, t.asset_name FROM transactions t
        JOIN filings f ON f.id = t.filing_id
        WHERE f.status IN {_counted()} AND t.tx_date > ?
    """, (now,))
    if future:
        out.append(Finding(
            WARN, "future_trade_dates",
            f"{len(future)} transaction(s) are dated in the future",
            "Almost always a mistyped year on the filing. Rolling windows "
            "already exclude them; they are listed here so a genuine parser "
            "regression is not mistaken for a filer typo.",
            [f"filing {r['doc_id']}  {r['tx_date']}  {r['asset_name'][:40]}" for r in future],
        ))

    backwards = _rows(conn, f"""
        SELECT f.doc_id, t.tx_date, t.notification_date FROM transactions t
        JOIN filings f ON f.id = t.filing_id
        WHERE f.status IN {_counted()}
          AND t.notification_date IS NOT NULL AND t.notification_date < t.tx_date
    """)
    if backwards:
        out.append(Finding(
            INFO, "contradictory_dates",
            f"{len(backwards)} transaction(s) report being notified before the trade",
            "Reproduced as filed; the UI flags these and reports no delay.",
            [f"filing {r['doc_id']}  traded {r['tx_date']}  notified {r['notification_date']}"
             for r in backwards],
        ))
    return out


def check_parse_coverage(conn, today: date | None = None) -> list[Finding]:
    """How much of the corpus is actually readable."""
    row = conn.execute("""
        SELECT SUM(status = 'failed') failed,
               SUM(status IN ('parsed','notified','backfilled')) ok
        FROM filings WHERE chamber = 'house'
    """).fetchone()
    total = (row["failed"] or 0) + (row["ok"] or 0)
    if not total:
        return []
    pct = 100 * (row["failed"] or 0) / total
    severity = ERROR if pct > 25 else WARN if pct > 15 else INFO
    return [Finding(
        severity, "parse_coverage",
        f"{row['failed']} of {total} filings unreadable ({pct:.0f}%)",
        "Scanned paper filings have no text layer. A sharp rise here means "
        "either more members filed on paper, or the text-layer detection "
        "threshold in ptr.py is now rejecting readable filings.",
    )]


def check_vision_rows(conn, today: date | None = None) -> list[Finding]:
    """What was transcribed from scans, and how much of it could not be read.

    Transcribed rows (`parse_method = 'vision'`) count as trades and toward
    member and ticker lists but enter no volume figure, cluster or floor
    (stats.counts_toward_volume; `TRANSCRIBED` in web/lib/queries.ts). The
    grid reader reports a box it cannot call as unknown rather than guess,
    so a share of unknown amounts or types is the expected shape of this
    data and reads as INFO. It becomes a warning when more than a quarter
    of the rows are unknown in either field: at that rate a form has
    changed, or the scans are too poor for the reader, and the filings are
    better reported as unreadable than half-read.
    """
    row = conn.execute(f"""
        SELECT COUNT(DISTINCT f.id) filings, COUNT(t.id) rows_,
               SUM(t.amount_min_cents IS NULL AND t.amount_exact_cents IS NULL) no_amount,
               SUM(t.action IS NULL OR t.action = '' OR t.action = 'unknown') no_action
        FROM filings f LEFT JOIN transactions t ON t.filing_id = f.id
        WHERE f.chamber = 'house' AND f.status IN {_counted()}
          AND f.parse_method = '{TRANSCRIBED_METHOD}'
    """).fetchone()
    refused = conn.execute("""
        SELECT COUNT(*) n FROM filings
        WHERE chamber = 'house' AND status = 'failed' AND parse_method = 'vision_failed'
    """).fetchone()["n"]
    if not row["filings"] and not refused:
        return []
    rows = row["rows_"] or 0
    no_amount, no_action = row["no_amount"] or 0, row["no_action"] or 0
    worst = max(no_amount, no_action) / rows if rows else 0.0
    severity = WARN if worst > 0.25 else INFO
    evidence = _rows(conn, f"""
        SELECT f.doc_id, f.filer_name, COUNT(t.id) n,
               SUM(t.amount_min_cents IS NULL AND t.amount_exact_cents IS NULL) na,
               SUM(t.action IS NULL OR t.action = '' OR t.action = 'unknown') nt
        FROM filings f LEFT JOIN transactions t ON t.filing_id = f.id
        WHERE f.chamber = 'house' AND f.status IN {_counted()}
          AND f.parse_method = '{TRANSCRIBED_METHOD}'
        GROUP BY f.id ORDER BY (na + nt) DESC, f.filing_date DESC
    """)
    return [Finding(
        severity, "vision_rows",
        f"{row['filings']} filing(s), {rows} row(s) transcribed from scans — "
        f"{no_amount} without a readable amount, {no_action} without a type"
        + (f"; {refused} scan(s) refused as unreadable" if refused else ""),
        "Transcribed rows count as trades and in member and ticker lists, and "
        "contribute nothing to any volume, cluster or floor. An unknown amount "
        "or type is a box the grid reader would not call, kept as unknown "
        "rather than guessed. A refused scan is one whose grid could not be "
        "found or whose two readings did not line up; it is reported with a "
        "link, like a scan vision never saw.",
        [f"{r['doc_id']}  {r['filer_name']}  {r['n']} rows, {r['na']} no amount, "
         f"{r['nt']} no type" for r in evidence],
    )]


def check_vision_join(conn, today: date | None = None) -> list[Finding]:
    """What the page-by-page join set aside this week: pages that yielded no
    rows, and rows whose type the model disputed.

    A scan is joined page by page (vision.join). A page whose grid could not
    be decomposed, or whose row count disagreed with the model's, yields
    nothing and the filing is parsed from its other pages, with the page on
    record (`scan_pages.error`, the note in `filings.last_error`): rows the
    member filed are then missing from the knowledge base, which is worth a
    look at /scans. A row whose model type contradicted the grid keeps the
    grid's type and is stored `type_disputed`; by the measurement in #1 the
    model misreads about a quarter of boxes, so a few of these are the
    expected shape of the data. Both are INFO for the week's transcribed
    filings. It becomes a warning when more than a quarter of the week's
    transcribed rows are disputed: at that rate the join is out of step
    rather than the model slipping, and the grid-kept types on those rows
    deserve a check by eye.
    """
    since = ((today or date.today()) - timedelta(days=7)).isoformat()
    rows = _rows(conn, f"""
        SELECT f.doc_id, f.filer_name, f.last_error,
               (SELECT COUNT(*) FROM transactions t WHERE t.filing_id = f.id) n,
               (SELECT COUNT(*) FROM scan_rows r WHERE r.filing_id = f.id
                  AND r.status = 'type_disputed') disputed,
               (SELECT COUNT(*) FROM scan_rows r WHERE r.filing_id = f.id
                  AND r.status = 'page_refused') refused_rows,
               (SELECT COUNT(*) FROM scan_pages s WHERE s.filing_id = f.id
                  AND s.error IS NOT NULL AND s.error != 'no table on this page') unread
        FROM filings f
        WHERE f.chamber = 'house' AND f.status IN {_counted()}
          AND f.parse_method = '{TRANSCRIBED_METHOD}'
          AND substr(f.updated_at, 1, 10) >= ?
        ORDER BY f.filing_date DESC
    """, (since,))
    flagged = [r for r in rows if r["disputed"] or r["refused_rows"] or r["unread"]
               or (r["last_error"] or "").startswith("partially read")]
    if not flagged:
        return []
    total = sum(r["n"] for r in rows)
    disputed = sum(r["disputed"] for r in rows)
    unread = sum(r["unread"] for r in flagged)
    severity = WARN if total and disputed > 0.25 * total else INFO
    return [Finding(
        severity, "vision_join",
        f"{len(flagged)} transcribed filing(s) this week with pages set aside or rows "
        f"disputed — {unread} page(s) yielded no rows, {disputed} of {total} row(s) "
        f"type-disputed",
        "A scan is joined page by page: a page whose grid could not be read, or "
        "whose row count disagreed with the model's, yields no transactions and "
        "the filing is parsed from the rest, so rows the member filed are "
        "missing until the page is read; the /scans page shows which. A "
        "type-disputed row keeps the grid's type and is flagged — the model "
        "misreads about a quarter of boxes, so a few are expected; more than a "
        "quarter of the week's rows means the join is out of step.",
        [f"{r['doc_id']}  {r['filer_name']}  {r['n']} rows, {r['disputed']} disputed, "
         f"{r['unread']} page(s) unread ({r['refused_rows']} grid rows unjoined)"
         + (f"  {r['last_error'][:90]}" if r["last_error"] else "") for r in flagged],
    )]


def check_transaction_density(conn, today: date | None = None) -> list[Finding]:
    """Transactions per filing over time — a template-change detector.

    If the Clerk alters the PDF, the most likely symptom is not a crash but a
    drop in rows extracted per filing.
    """
    rows = _rows(conn, f"""
        SELECT substr(f.filing_date, 1, 7) month,
               COUNT(DISTINCT f.id) filings,
               COUNT(t.id) txs
        FROM filings f LEFT JOIN transactions t ON t.filing_id = f.id
        WHERE f.status IN {_counted()} AND f.filing_date IS NOT NULL
        GROUP BY month ORDER BY month
    """)
    if len(rows) < 3:
        return []
    per = [(r["month"], r["txs"] / r["filings"]) for r in rows if r["filings"]]
    baseline = sum(v for _, v in per[:-1]) / max(len(per) - 1, 1)
    latest_month, latest = per[-1]
    detail = "  ".join(f"{m}: {v:.1f}" for m, v in per)
    if baseline and latest < baseline * 0.5:
        return [Finding(
            WARN, "transaction_density_drop",
            f"Rows per filing fell to {latest:.1f} in {latest_month} "
            f"(previous average {baseline:.1f})",
            "A halving is the signature of a changed PDF template: the parser "
            "still succeeds but extracts fewer rows per filing.",
            [detail],
        )]
    return [Finding(INFO, "transaction_density",
                    f"Rows per filing stable around {baseline:.1f}",
                    "No sign of a template change.", [detail])]


def check_issuer_classification(conn, today: date | None = None) -> list[Finding]:
    """How much of the corpus carries an industry group (#55).

    Coverage, not correctness: the sector views on the dashboard aggregate
    only the rows whose issuer EDGAR has classified, so the share that is
    unclassified is the share those views are silent about. Measured on
    equity-like congressional rows — the ones that can have a sector — and
    on insider filings by issuer. An issuer EDGAR gives no SIC (ETF trusts,
    funds) is unclassified by design and counted, never guessed. INFO on a
    healthy database; a warning only when the last run itself reported a
    throttle or error, which is the step going dark rather than the data
    being what it is.
    """
    from .config import DEFAULT_CLUSTER_ASSET_TYPES
    from .db import get_state

    equity_types = "(" + ", ".join(f"'{t}'" for t in DEFAULT_CLUSTER_ASSET_TYPES) + ")"
    status = get_state(conn, "issuers_status")
    row = conn.execute(f"""
        SELECT COUNT(*) rows_,
               SUM(s.industry_group IS NOT NULL) classified,
               COUNT(DISTINCT t.ticker) tickers,
               COUNT(DISTINCT CASE WHEN s.industry_group IS NOT NULL THEN t.ticker END)
                 classified_tickers
        FROM transactions t JOIN filings f ON f.id = t.filing_id
        LEFT JOIN issuer_tickers it ON it.ticker = t.ticker
        LEFT JOIN issuers s ON s.cik = it.cik
        WHERE f.status IN {_counted()} AND t.ticker IS NOT NULL AND t.ticker != ''
          AND t.asset_type IN {equity_types}
    """).fetchone()
    insider = conn.execute(f"""
        SELECT COUNT(DISTINCT f.issuer_cik) issuers,
               COUNT(DISTINCT CASE WHEN s.industry_group IS NOT NULL THEN f.issuer_cik END)
                 classified
        FROM insider_filings f LEFT JOIN issuers s ON s.cik = f.issuer_cik
        WHERE f.status IN {_counted()} AND f.issuer_cik IS NOT NULL
    """).fetchone()
    fetched = conn.execute("SELECT COUNT(*) n FROM issuers WHERE fetched_at IS NOT NULL").fetchone()["n"]
    if status is None and not fetched:
        return [Finding(
            INFO, "issuer_classification_not_run",
            "Issuer classification has not run",
            "No sector is known for any ticker or Form 4 issuer. The step runs in the "
            "poll run after the insider sync and needs EDGAR_USER_AGENT; the sector "
            "views on the dashboard stay empty until it has.",
        )]

    rows, classified = row["rows_"] or 0, row["classified"] or 0
    tickers, classified_tickers = row["tickers"] or 0, row["classified_tickers"] or 0
    issuers_n, issuers_classified = insider["issuers"] or 0, insider["classified"] or 0
    pct = 100 * classified / rows if rows else 0.0
    evidence = [
        f"congressional equity rows with a sector: {classified} of {rows} ({pct:.0f}%)",
        f"tickers classified: {classified_tickers} of {tickers}",
        f"Form 4 issuers classified: {issuers_classified} of {issuers_n}",
        f"last run: {status or '—'}",
    ]
    degraded = bool(status) and not status.startswith(("ok", "skipped"))
    return [Finding(
        WARN if degraded else INFO, "issuer_classification",
        f"{pct:.0f}% of congressional equity rows carry an industry group; "
        f"{issuers_classified} of {issuers_n} Form 4 issuers classified"
        + (f" — last run: {status}" if degraded else ""),
        "Sector views aggregate only classified rows, so this is the share they "
        "describe. Unclassified means EDGAR lists no SIC for the issuer (ETF "
        "trusts, funds), the symbol is not in EDGAR's company list, or the fill "
        "has not reached it yet — the last run's status line says which. A "
        "throttle or error is the step going dark, not the data being what it is.",
        evidence,
    )]


def check_alert_health(conn, today: date | None = None) -> list[Finding]:
    """Whether alerting is doing anything at all, and of which kinds."""
    rows = _rows(conn, "SELECT kind, COUNT(*) n, MAX(fired_at) last FROM alerts "
                       "GROUP BY kind ORDER BY kind")
    if not rows:
        return [Finding(
            INFO, "no_alerts",
            "No alert has ever fired",
            "Expected on a young database. If it persists with months of data, "
            "the thresholds in config.yaml are set too high to ever trigger.",
        )]
    total = sum(r["n"] for r in rows)
    last = max(r["last"] for r in rows)
    return [Finding(
        INFO, "alerts_recorded", f"{total} alert(s) recorded, most recent {last}",
        "Alerting is active. Every alert sent, with its message, is on the "
        "dashboard's /alerts page.",
        [f"{r['kind']:<16} {r['n']:>5}  last {r['last']}" for r in rows],
    )]


def check_alert_recording(conn, today: date | None = None) -> list[Finding]:
    """Every alert delivered since the log began must have a row in `alerts`.

    The /alerts page claims to be the complete history, so a delivery path
    that forgot to log would read as a quiet week. Keyed on status
    'notified', not `notified_at`: a backfill marks filings notified without
    sending anything, and only the notify step sets the status itself.
    Unreadable filings (status 'failed', reported by link) have no such
    distinction and are not checked.
    """
    marker = conn.execute("SELECT value FROM sync_state WHERE key = ?",
                          (ALERTS_RECORDED_SINCE,)).fetchone()
    if marker is None or not marker["value"]:
        return [Finding(
            WARN, "alert_recording_unknown",
            "Cannot tell whether alerts are being recorded",
            "The `alerts_recorded_since` marker written by schema migration 13 is "
            "missing, so there is no point before which an unlogged alert is "
            "expected. Treat as unknown, not as a pass.",
        )]
    since = marker["value"]
    missing = _rows(conn, """
        SELECT doc_id AS ref, filer_name AS who, notified_at FROM filings f
        WHERE f.status = 'notified' AND f.notified_at >= ?
          AND NOT EXISTS (SELECT 1 FROM alerts a WHERE a.filing_id = f.id)""", (since,))
    missing += _rows(conn, """
        SELECT accession AS ref, issuer_name AS who, notified_at FROM insider_filings f
        WHERE f.status = 'notified' AND f.notified_at >= ?
          AND NOT EXISTS (SELECT 1 FROM alerts a WHERE a.insider_filing_id = f.id)""",
                     (since,))
    if not missing:
        return []
    return [Finding(
        WARN, "alert_unrecorded",
        f"{len(missing)} delivered alert(s) have no row in `alerts`",
        f"These filings were marked notified after {since}, when every delivery "
        "began logging its message, yet nothing was logged for them. The /alerts "
        "page is missing them: a notify path is not calling `db.record_alert`.",
        [f"{r['ref']}  {r['who']}  notified {r['notified_at']}" for r in missing],
    )]


def check_senate(conn, today: date | None = None) -> list[Finding]:
    """The Senate side's last attempt, read from `sync_state.senate_status`.

    eFD answers GitHub's US runners (#40), so a block is not the expected
    outcome any more: it is the Senate side going dark, and warns with the
    fix named (a sticky US proxy). A failure on our side — an empty proxy
    URL, DNS, a timeout — is kept apart from a block because it needs a
    different human; filing the first under the second is how an unset secret
    went unnoticed for every run (#16).
    """
    from .db import get_state
    from .senate import STATUS_BLOCKED, STATUS_OK, status_kind

    status = get_state(conn, "senate_status")
    if status is None:
        # `senate.enabled: false`, or no run yet. Neither a pass nor a failure,
        # so it gets its own code rather than being folded into a block.
        return [Finding(INFO, "senate_not_attempted", "Senate eFD not attempted",
                        "No Senate run is recorded (`senate.enabled` is off, or the "
                        "pipeline has not run yet). Congressional figures cover the "
                        "House only until one does.")]
    kind = status_kind(status)
    if kind == STATUS_OK:
        return [Finding(INFO, "senate_available", f"Senate eFD reachable: {status}",
                        "Senate PTRs are indexed from eFD and parsed from the electronic "
                        "report pages; paper filings are listed as unreadable. "
                        "`senate_parse_coverage` says how the parsing went.")]
    if kind == STATUS_BLOCKED:
        return [Finding(WARN, "senate_blocked", f"Senate eFD refused the session ({status})",
                        "eFD refused the session, so no Senate filings are being added. "
                        "Akamai geo-fences non-US addresses (a 403 on the agreement "
                        "page itself) but has answered GitHub's US runners since "
                        "2026-10-17, so from the runner this is news, not the norm. If "
                        "it persists, set `SENATE_PROXY_URL` to a sticky US proxy: the "
                        "agreement is bound to the accepting IP, so a rotating pool "
                        "loses the session.")]
    # `error`, or a prefix this check does not know. Either way the request
    # never reached eFD, so the Senate side has not been tested this run.
    return [Finding(WARN, "senate_error", f"Senate eFD attempt failed ({status})",
                    "A configuration or client failure, not eFD refusing us: the "
                    "request failed on our side or never left (bad proxy URL, DNS, "
                    "timeout, unexpected HTTP status). Check `SENATE_PROXY_URL` and "
                    "the pipeline log. Until this reads `ok`, the Senate side has not "
                    "actually been tested.")]


def check_senate_parse_coverage(conn, today: date | None = None) -> list[Finding]:
    """How the Senate filings that reached the parser actually went.

    Silent while no Senate filing has been parsed, so it says nothing on a
    database that only indexed them. Paper filings are unreadable by design
    and are counted, not flagged. A parse error is eFD's template changing
    under the parser, or a page that was not an electronic PTR; the parser
    refuses to produce an empty filing rather than guess, so those warn with
    the pages to open.
    """
    row = conn.execute(f"""
        SELECT SUM(status IN {_counted()}) ok,
               SUM(status = 'failed' AND parse_method = 'efd_paper') paper,
               SUM(status = 'failed' AND COALESCE(parse_method, '') != 'efd_paper') errors,
               SUM(status IN ('new', 'backfill_queued')) queued,
               SUM(status = 'seen_skipped') unparsed_history
        FROM filings WHERE chamber = 'senate'
    """).fetchone()
    ok, paper, errors = (row["ok"] or 0), (row["paper"] or 0), (row["errors"] or 0)
    total = ok + paper + errors
    if not total:
        return []
    findings = [Finding(
        INFO, "senate_parse_coverage",
        f"{ok} of {total} Senate filing(s) parsed; {paper} paper, {errors} parse error(s)",
        "Electronic Senate PTRs are read from eFD's report pages (`efd_html`). "
        "Paper filings are scanned images and are reported unreadable, like "
        "House scans; they are never transcribed. A parse error means the "
        "page did not carry the nine-column transactions table the parser "
        "expects.",
        [f"queued for parsing: {row['queued'] or 0}",
         f"indexed, not yet backfilled: {row['unparsed_history'] or 0}"],
    )]
    if errors:
        rows = _rows(conn, """
            SELECT doc_id, filer_name, filing_date, last_error, pdf_url FROM filings
            WHERE chamber = 'senate' AND status = 'failed'
              AND COALESCE(parse_method, '') != 'efd_paper'
            ORDER BY filing_date DESC
        """)
        findings.append(Finding(
            WARN, "senate_parse_errors",
            f"{errors} Senate filing(s) failed to parse",
            "Either eFD changed its report template, or the page was not an "
            "electronic PTR (the agreement form served in place of it, an "
            "amendment of another shape). Open the pages below; the parser "
            "refuses to store an empty filing rather than guess at the columns.",
            [f"{r['doc_id']}  {r['filer_name']}  filed {r['filing_date']}  "
             f"{r['last_error'] or ''}  {r['pdf_url']}" for r in rows],
        ))
    return findings


# --- pipeline runs ----------------------------------------------------------


def check_pipeline_runs(conn, today: date | None = None) -> list[Finding]:
    """What the last pipeline runs did, from the run log `pipeline.run` keeps.

    The CI digest in the weekly review sees the Actions history: which jobs
    went green. This sees the other half — what each run actually parsed,
    sent and stored — from `sync_state.recent_runs`, newest first. Silent
    on a database no run has written yet (expected until the first run with
    the log), so a fresh checkout says nothing. A failed run warns with its
    error; a log whose newest run is more than a day old warns too, because
    the poll is scheduled every 90 minutes and the database only reaches the
    repository through a run — a day of silence is a broken schedule, not a
    quiet one. The run log is bounded, so this never grows with the corpus.
    """
    import json

    from .db import get_state

    raw = get_state(conn, "recent_runs")
    if raw is None:
        return []
    # A log that no longer parses must surface as `check_failed`, not as a
    # pass: json.loads raising is the intended behaviour.
    runs = [r for r in json.loads(raw) if isinstance(r, dict)]
    if not runs:
        return []

    def line(r: dict) -> str:
        return (f"{r.get('started', '?')}  {r.get('duration_s', '?')}s  "
                f"parsed {r.get('filings_parsed', '?')}  alerts {r.get('alerts_sent', '?')}  "
                f"scans {r.get('scans_transcribed', '?')}  insiders {r.get('insiders_stored', '?')}  "
                f"{r.get('outcome', '?')}" + (f"  {r['error']}" if r.get("error") else ""))

    failed = [r for r in runs if r.get("outcome") != "ok"]
    out = [Finding(
        INFO, "pipeline_runs",
        f"{len(runs)} pipeline run(s) logged, {len(failed)} failed; "
        f"newest started {runs[0].get('started', '?')}",
        "One line per run, newest first: when it started, how long it took, "
        "and what it parsed, sent and stored. Dry runs and runs the job "
        "timeout killed leave no entry; the Actions history has those.",
        [line(r) for r in runs[:10]],
    )]
    if failed:
        out.append(Finding(
            WARN, "pipeline_run_failed",
            f"{len(failed)} of the last {len(runs)} pipeline run(s) failed",
            "A run that raised still logged what it managed before it broke; "
            "every step commits its own work, so the next run resumed from "
            "there. Read the error, then the run's log in Actions.",
            [line(r) for r in failed],
        ))

    newest = str(runs[0].get("started") or "")
    if newest:
        age_days = ((today or date.today()) - date.fromisoformat(newest[:10])).days
        if age_days > 1:
            out.append(Finding(
                WARN, "pipeline_runs_stale",
                f"No pipeline run logged in {age_days} days (newest {newest})",
                "The poll workflow is scheduled every 90 minutes and GitHub "
                "delivers it hours late at worst, never days. Either the "
                "schedule stopped, every run since has been killed before "
                "its `finally`, or the database being audited is not the one "
                "the pipeline writes.",
            ))
    return out



# --- insiders (SEC Form 4) ---------------------------------------------------
#
# Deliberately NOT checking insider ticker shape. A PTR ticker is regex-split
# out of a PDF cell and can pick up a CUSIP; `issuerTradingSymbol` is a
# structured XML element, so there is no column-split failure mode to detect —
# and real values include exchange-prefixed foreign symbols like "ASX:LNW",
# which a naive shape rule would flag every week.


def check_insider_empty_filings(conn, today: date | None = None) -> list[Finding]:
    """A stored Form 4 with no transactions — impossible by construction.

    A filing is only stored if its open-market rows clear the value floor, so
    one with no rows means the store path broke after the filter passed.
    """
    rows = _rows(conn, f"""
        SELECT f.accession, f.ticker, f.issuer_name, f.filing_date, f.source_url
        FROM insider_filings f
        WHERE f.status IN {_counted()}
          AND NOT EXISTS (SELECT 1 FROM insider_transactions t WHERE t.filing_id = f.id)
        ORDER BY f.filing_date DESC
    """)
    if not rows:
        return []
    return [Finding(
        ERROR, "insider_empty_filings",
        f"{len(rows)} stored Form 4 filing(s) have no transactions",
        "A Form 4 is only stored when its open-market rows clear the configured "
        "value floor, so a stored filing with no rows means `store_filing` "
        "dropped them — those trades are missing from every insider total.",
        [f"{r['accession']}  {r['ticker'] or '—'}  {r['issuer_name']}  filed {r['filing_date']}  {r['source_url']}"
         for r in rows],
    )]


def check_insider_primary_owner(conn, today: date | None = None) -> list[Finding]:
    """Every filing needs an owner at index 0.

    "Distinct insiders" counts primary reporting owners, so a filing without
    one contributes an "unknown" insider to every rollup and cluster count.
    """
    rows = _rows(conn, f"""
        SELECT f.accession, f.ticker, f.issuer_name FROM insider_filings f
        WHERE f.status IN {_counted()}
          AND NOT EXISTS (
            SELECT 1 FROM insider_filing_owners o
            WHERE o.filing_id = f.id AND o.owner_index = 0)
        ORDER BY f.filing_date DESC
    """)
    if not rows:
        return []
    return [Finding(
        ERROR, "insider_missing_primary_owner",
        f"{len(rows)} Form 4 filing(s) have no primary reporting owner",
        "Insider counts and cluster detection join on `owner_index = 0`. A "
        "filing without one is attributed to nobody, so it silently inflates "
        "an \"unknown\" insider instead of a named one.",
        [f"{r['accession']}  {r['ticker'] or '—'}  {r['issuer_name']}" for r in rows],
    )]


def check_insider_values(conn, today: date | None = None) -> list[Finding]:
    """Insider values must be exact and internally consistent.

    Form 4 gives share counts and a price, so the value is computed:
    min == max == exact, or all three NULL. Anything else means `_tx_row`
    or the schema drifted, and a range would be presented as a measurement.
    """
    out = []
    inconsistent = _rows(conn, f"""
        SELECT f.accession, t.amount_min_cents lo, t.amount_max_cents hi,
               t.amount_exact_cents ex, t.shares, t.price_per_share px
        FROM insider_transactions t JOIN insider_filings f ON f.id = t.filing_id
        WHERE f.status IN {_counted()}
          AND (t.amount_min_cents IS NOT t.amount_exact_cents
               OR t.amount_max_cents IS NOT t.amount_exact_cents)
    """)
    if inconsistent:
        out.append(Finding(
            ERROR, "insider_amount_inconsistent",
            f"{len(inconsistent)} insider row(s) have disagreeing amount columns",
            "An insider value is exact: min, max and exact must all hold the "
            "same figure, or all be NULL. A disagreement would render an exact "
            "trade as a range, or a range as a measurement.",
            [f"{r['accession']}  lo={r['lo']} hi={r['hi']} exact={r['ex']}" for r in inconsistent],
        ))

    # A value that is not shares × price, to the cent. Catches a regression in
    # the rounding or a unit slip between dollars and cents.
    mismatched = [
        r for r in _rows(conn, f"""
            SELECT f.accession, t.shares, t.price_per_share px, t.amount_exact_cents ex
            FROM insider_transactions t JOIN insider_filings f ON f.id = t.filing_id
            WHERE f.status IN {_counted()}
              AND t.amount_exact_cents IS NOT NULL
              AND t.shares IS NOT NULL AND t.price_per_share IS NOT NULL
        """)
        if abs(r["shares"] * r["px"] * 100 - r["ex"]) > 1.5
    ]
    if mismatched:
        out.append(Finding(
            ERROR, "insider_value_mismatch",
            f"{len(mismatched)} insider row(s) do not equal shares × price",
            "The stored value is derived from the filed share count and price. "
            "A row that no longer matches means the derivation drifted — every "
            "insider volume figure is then wrong while still looking plausible.",
            [f"{r['accession']}  {r['shares']} × {r['px']} ≠ {r['ex']} cents" for r in mismatched],
        ))

    priced_without_inputs = _rows(conn, f"""
        SELECT f.accession, t.shares, t.price_per_share px FROM insider_transactions t
        JOIN insider_filings f ON f.id = t.filing_id
        WHERE f.status IN {_counted()} AND t.amount_exact_cents IS NOT NULL
          AND (t.shares IS NULL OR t.price_per_share IS NULL OR t.price_per_share <= 0)
    """)
    if priced_without_inputs:
        out.append(Finding(
            ERROR, "insider_value_without_inputs",
            f"{len(priced_without_inputs)} insider row(s) carry a value with no shares or price",
            "A value exists only as shares × price. One without them was "
            "invented somewhere, which is the bracket-collapsing failure this "
            "project treats as a bug rather than a simplification.",
            [f"{r['accession']}  shares={r['shares']} price={r['px']}" for r in priced_without_inputs],
        ))

    unpriced = conn.execute(f"""
        SELECT COUNT(*) n FROM insider_transactions t JOIN insider_filings f ON f.id = t.filing_id
        WHERE f.status IN {_counted()} AND t.amount_exact_cents IS NULL
    """).fetchone()["n"]
    if unpriced:
        out.append(Finding(
            INFO, "insider_unpriced_rows",
            f"{unpriced} insider row(s) report no price",
            "Their value is unknown, not zero, so they count toward trade "
            "counts and contribute nothing to volume. Expected in small "
            "numbers: some filers leave the price cell to a footnote.",
        ))
    return out


def check_insider_implausible_values(conn, today: date | None = None) -> list[Finding]:
    """Rows whose as-filed value the ingest rule refused to believe.

    `check_insider_values` proves the arithmetic; this lists the rows where
    the arithmetic is right and the inputs are not (a price cell holding the
    aggregate consideration). They are stored as filed and excluded from
    every total, so the list is for a human to confirm — or to spot a real
    block trade the rule should not have caught.
    """
    rows = _rows(conn, f"""
        SELECT f.accession, f.ticker, t.action, t.shares, t.price_per_share px,
               t.amount_exact_cents ex
        FROM insider_transactions t JOIN insider_filings f ON f.id = t.filing_id
        WHERE f.status IN {_counted()} AND t.implausible = 1
        ORDER BY t.amount_exact_cents DESC
    """)
    if not rows:
        return []
    return [Finding(
        WARN, "insider_implausible_values",
        f"{len(rows)} insider row(s) carry an implausible as-filed value",
        "Kept as filed but excluded from every volume figure, cluster total "
        "and alert value floor (stats.form4_is_implausible). Usually a price "
        "cell that holds the aggregate consideration. A real trade on this "
        "list means the thresholds need revisiting.",
        [f"{r['accession']}  {r['ticker'] or '—'}  {r['action']}  "
         f"{r['shares']:,.0f} × ${r['px']:,.2f} = ${r['ex'] / 100:,.0f}" for r in rows],
    )]


def check_insider_dates(conn, today: date | None = None) -> list[Finding]:
    """Trade dates that cannot be compared to the filing date."""
    rows = _rows(conn, f"""
        SELECT f.accession, f.ticker, f.filing_date, t.tx_date, t.deemed_execution_date
        FROM insider_transactions t JOIN insider_filings f ON f.id = t.filing_id
        WHERE f.status IN {_counted()} AND t.late IS NULL
    """)
    if not rows:
        return []
    return [Finding(
        INFO, "insider_uncomparable_dates",
        f"{len(rows)} insider row(s) have a trade date that cannot be compared to the filing date",
        "Reproduced as filed — some filers write a timezone-suffixed or "
        "malformed date. The lateness flag is left unknown rather than guessed, "
        "and the dashboard shows \"date as filed\".",
        [f"{r['accession']}  {r['ticker'] or '—'}  traded {r['tx_date']!r}  filed {r['filing_date']}"
         for r in rows],
    )]


def check_insider_feed_health(conn, today: date | None = None) -> list[Finding]:
    """Whether the EDGAR sync is still collecting anything.

    The Form 4 feed remembers about two business days. A sync that stops
    working does not fail loudly — it just stops storing filings, and the
    insider totals quietly stop growing.
    """
    from .db import get_state

    out = []
    status = get_state(conn, "edgar_status")
    cursor = get_state(conn, "edgar_cursor")
    gap = get_state(conn, "edgar_gap")

    if status is None:
        return [Finding(
            INFO, "insider_sync_not_attempted",
            "The EDGAR insider sync has never run",
            "Expected until EDGAR_USER_AGENT is configured; the step skips "
            "itself without it.",
        )]
    if status.startswith("skipped"):
        out.append(Finding(
            INFO, "insider_sync_skipped", f"Insider sync skipping itself: {status}",
            "SEC requires a contact e-mail in the User-Agent. Set "
            "EDGAR_USER_AGENT to enable the source.",
        ))
    elif not status.startswith("ok"):
        # throttled / error / gap — the source is degraded, not merely quiet.
        out.append(Finding(
            ERROR if status.startswith(("throttled", "gap")) else WARN,
            "insider_sync_degraded", f"Insider sync last reported: {status}",
            "A throttle means SEC refused the traffic; an error means the run "
            "aborted. The cursor is a watermark, so nothing is lost yet — but "
            "the feed only remembers about two business days, after which the "
            "missing range needs `whale backfill-insiders`.",
        ))

    if gap:
        start, _, end = gap.partition("..")
        out.append(Finding(
            ERROR, "insider_feed_gap",
            f"The insider feed advanced past a gap ({gap})",
            "Filings in this range were published while the pipeline was not "
            "watching and the feed has since forgotten them. The poll run "
            "repairs this itself: after each live-feed sync it walks EDGAR's "
            "daily index for the gap, oldest day first, inside "
            "`insiders.gap_repair_budget_seconds`, and the range narrows as "
            "days are covered — `edgar_status` reports each run's progress. "
            "This stays an error until the gap clears. If the range is not "
            "shrinking between runs (the budget is 0, or the status reports "
            "a repair error) walk it by hand:",
            [f"python -m whale backfill-insiders --from {start} --to {end}"],
        ))

    if cursor and status.startswith("ok"):
        # poll runs every 3h; a cursor older than a day means the step is not
        # advancing even though it reports success.
        age_days = (
            (today or date.today())
            - date.fromisoformat(cursor[:10])
        ).days
        if age_days > 1:
            out.append(Finding(
                WARN, "insider_cursor_stale",
                f"The insider cursor has not advanced in {age_days} days (at {cursor})",
                "The sync reports success but is not moving forward. Either no "
                "Form 4 has been published since — implausible on a business "
                "day — or the feed request is returning nothing usable.",
            ))
    return out


def check_insider_coverage(conn, today: date | None = None) -> list[Finding]:
    """What the floor filter is accepting and rejecting."""
    from .db import get_state

    row = conn.execute(f"""
        SELECT (SELECT COUNT(*) FROM insider_filings WHERE status IN {_counted()}) kept,
               (SELECT COUNT(*) FROM insider_filings WHERE status = 'failed') failed,
               (SELECT COUNT(*) FROM insider_transactions) txs,
               (SELECT COUNT(DISTINCT issuer_cik) FROM insider_filings) issuers
    """).fetchone()
    if not row["kept"] and not row["failed"]:
        return []
    out = []
    if row["failed"]:
        out.append(Finding(
            WARN, "insider_unreadable_filings",
            f"{row['failed']} Form 4 filing(s) could not be parsed",
            "The submission was fetched but its ownership XML did not parse. "
            "They are kept so they stay visible and re-parseable; a cluster of "
            "them means the schema changed.",
        ))
    skipped = get_state(conn, "edgar_skipped")
    out.append(Finding(
        INFO, "insider_coverage",
        f"{row['kept']} Form 4 filing(s) stored — {row['txs']} open-market trades "
        f"across {row['issuers']} issuers",
        "Only filings whose open-market buys or sells reach the configured "
        "floor in one direction are stored; the rest are counted and dropped.",
        [f"last run skipped: {skipped}"] if skipped else [],
    ))
    return out


def check_insider_notified_without_ticker(conn, today: date | None = None) -> list[Finding]:
    """An insider alert went out for an issuer nobody can trade.

    A Form 4 filed with the trading symbol NONE or N/A is a private BDC,
    interval fund or similar non-listed vehicle. The filing rules and the
    cluster finder skip those, so one reaching Telegram means that gate
    regressed. Windowed to the last 30 days of notifications so the alerts
    sent before the gate existed do not read as a standing fault every week.
    """
    cutoff = ((today or date.today()) - timedelta(days=30)).isoformat()
    rows = _rows(conn, """
        SELECT accession, issuer_name, ticker_as_filed, filing_date, notified_at
        FROM insider_filings
        WHERE status = 'notified' AND ticker IS NULL
          AND (notified_at IS NULL OR substr(notified_at, 1, 10) >= ?)
        ORDER BY notified_at DESC, id DESC
    """, (cutoff,))
    if not rows:
        return []
    return [Finding(
        WARN, "insider_notified_without_ticker",
        f"{len(rows)} insider alert(s) went out for an issuer with no ticker",
        "The issuer filed its trading symbol as NONE or N/A — a private fund "
        "or other non-listed vehicle — so nobody can act on the alert. Filing "
        "rules and the cluster finder are meant to skip these and demote them "
        "to history; one being notified means that gate stopped working.",
        [f"{r['accession']}  {r['issuer_name']}  filed as {r['ticker_as_filed'] or '—'}"
         f"  on {r['filing_date']}  notified {r['notified_at']}" for r in rows],
    )]


CHECKS = (
    check_empty_parsed_filings,
    check_nonstandard_amount_brackets,
    check_stuck_filings,
    check_unnotified_backlog,
    check_house_age_cutoff,
    check_missing_transaction_fields,
    check_ticker_sanity,
    check_tickers_from_asset_names,
    check_unmatched_filers,
    check_date_anomalies,
    check_parse_coverage,
    check_vision_rows,
    check_vision_join,
    check_transaction_density,
    check_issuer_classification,
    check_alert_health,
    check_alert_recording,
    check_senate,
    check_senate_parse_coverage,
    check_pipeline_runs,
    check_insider_empty_filings,
    check_insider_primary_owner,
    check_insider_values,
    check_insider_implausible_values,
    check_insider_dates,
    check_insider_feed_health,
    check_insider_coverage,
    check_insider_notified_without_ticker,
)


def run_checks(conn: sqlite3.Connection, today: date | None = None) -> list[Finding]:
    findings: list[Finding] = []
    for check in CHECKS:
        try:
            findings += check(conn, today)
        except Exception as exc:  # a broken check must not hide the others
            findings.append(Finding(
                WARN, "check_failed", f"Check `{check.__name__}` raised",
                f"The check itself failed: {exc!r}. Treat as unknown, not as a pass.",
            ))
    findings.sort(key=lambda f: SEVERITY_ORDER[f.severity])
    return findings


def summary(conn: sqlite3.Connection) -> dict:
    row = conn.execute(f"""
        SELECT (SELECT COUNT(*) FROM filings) filings,
               (SELECT COUNT(*) FROM filings WHERE chamber = 'house') house_filings,
               (SELECT COUNT(*) FROM filings WHERE chamber = 'senate') senate_filings,
               (SELECT COUNT(*) FROM transactions) txs,
               (SELECT COUNT(DISTINCT ticker) FROM transactions WHERE ticker IS NOT NULL) tickers,
               (SELECT COUNT(DISTINCT politician_id) FROM transactions) members,
               (SELECT MAX(filing_date) FROM filings WHERE status IN {_counted()}) newest,
               (SELECT MAX(updated_at) FROM filings) last_run,
               (SELECT COUNT(*) FROM insider_filings) insider_filings,
               (SELECT COUNT(*) FROM insider_transactions) insider_txs,
               (SELECT COUNT(DISTINCT cik) FROM insiders) insiders,
               (SELECT MAX(filing_date) FROM insider_filings) insider_newest
    """).fetchone()
    return dict(row)


def report(db_path: Path, today: date | None = None) -> tuple[str, list[Finding]]:
    """Render the full audit as markdown, and return the findings."""
    conn = connect(db_path)
    try:
        findings = run_checks(conn, today)
        s = summary(conn)
    finally:
        conn.close()

    counts = {sev: sum(1 for f in findings if f.severity == sev) for sev in (ERROR, WARN, INFO)}
    lines = [
        "# Whale Tracker — data audit",
        "",
        f"Generated {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}",
        "",
        "## Corpus",
        "",
        f"- congressional filings indexed: **{s['filings']}** "
        f"(House {s['house_filings']}, Senate {s['senate_filings']})",
        f"- congressional transactions: **{s['txs']}** across **{s['tickers']}** tickers "
        f"and **{s['members']}** members",
        f"- newest parsed filing: {s['newest']}",
        f"- Form 4 filings stored: **{s['insider_filings']}** — "
        f"**{s['insider_txs']}** open-market trades by **{s['insiders']}** insiders "
        f"(newest {s['insider_newest']})",
        f"- database last written: {s['last_run']}",
        "",
        "## Findings",
        "",
        f"**{counts[ERROR]} error · {counts[WARN]} warning · {counts[INFO]} info**",
        "",
    ]
    lines += [f.as_markdown() + "\n" for f in findings] or ["Nothing to report."]
    return "\n".join(lines), findings
