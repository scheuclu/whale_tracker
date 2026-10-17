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
from .db import COUNTED_STATUSES, connect

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
              AND (t.{column} IS NULL OR t.{column} = '' OR t.{column} = 'unknown')
        """)
        if rows:
            out.append(Finding(
                severity, code, f"{len(rows)} transaction(s) with {label}",
                f"Rows without `{column}` are silently excluded from windowed "
                "statistics, so they inflate nothing but quietly under-report.",
                [f"filing {r['doc_id']}  {r['asset_name'][:50]}" for r in rows],
            ))

    no_amount = _rows(conn, f"""
        SELECT f.doc_id, t.asset_name, f.parse_method FROM transactions t
        JOIN filings f ON f.id = t.filing_id
        WHERE f.status IN {_counted()}
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
               SUM(status IN ('parsed','notified','backfilled')) ok,
               SUM(parse_method = 'vision') vision
        FROM filings WHERE chamber = 'house'
    """).fetchone()
    total = (row["failed"] or 0) + (row["ok"] or 0)
    if not total:
        return []
    pct = 100 * (row["failed"] or 0) / total
    severity = ERROR if pct > 25 else WARN if pct > 15 else INFO
    findings = [Finding(
        severity, "parse_coverage",
        f"{row['failed']} of {total} filings unreadable ({pct:.0f}%)",
        "Scanned paper filings have no text layer. A sharp rise here means "
        "either more members filed on paper, or the text-layer detection "
        "threshold in ptr.py is now rejecting readable filings.",
    )]
    if row["vision"]:
        findings.append(Finding(
            WARN, "vision_rows_in_stats",
            f"{row['vision']} filing(s) were transcribed by the vision model",
            "Vision transcription measured ~25% row error on the amount grid. "
            "Those rows currently count toward the statistics; see issue #1.",
        ))
    return findings


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


def check_alert_health(conn, today: date | None = None) -> list[Finding]:
    """Whether cluster alerting is doing anything at all."""
    n = conn.execute("SELECT COUNT(*) c FROM alerts").fetchone()["c"]
    last = conn.execute("SELECT MAX(fired_at) t FROM alerts").fetchone()["t"]
    if n == 0:
        return [Finding(
            INFO, "no_cluster_alerts",
            "No cluster alert has ever fired",
            "Expected on a young database. If it persists with months of data, "
            "the thresholds in config.yaml are set too high to ever trigger.",
        )]
    return [Finding(INFO, "cluster_alerts", f"{n} cluster alert(s) fired, most recent {last}",
                    "Cluster alerting is active.")]


def check_senate(conn, today: date | None = None) -> list[Finding]:
    from .db import get_state

    status = get_state(conn, "senate_status")
    if status and status.startswith("ok"):
        return [Finding(INFO, "senate_available", f"Senate eFD reachable: {status}",
                        "Senate filings are being indexed and need a parser.")]
    return [Finding(INFO, "senate_blocked", f"Senate eFD unavailable ({status or 'not attempted'})",
                    "Expected. All figures are House-only.")]



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
            "watching and the feed has since forgotten them. They will never "
            "arrive on their own.",
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


CHECKS = (
    check_empty_parsed_filings,
    check_nonstandard_amount_brackets,
    check_stuck_filings,
    check_unnotified_backlog,
    check_house_age_cutoff,
    check_missing_transaction_fields,
    check_ticker_sanity,
    check_unmatched_filers,
    check_date_anomalies,
    check_parse_coverage,
    check_transaction_density,
    check_alert_health,
    check_senate,
    check_insider_empty_filings,
    check_insider_primary_owner,
    check_insider_values,
    check_insider_dates,
    check_insider_feed_health,
    check_insider_coverage,
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
        f"- House filings indexed: **{s['filings']}**",
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
