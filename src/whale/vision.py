"""Scanned paper PTRs: a vision model transcribes the text, the printed grid
is read geometrically, and the two are joined row by row.

About 11% of House PTRs are filed on paper and scanned to image-only PDFs
with no text layer, so `ptr.py` cannot read them. Two readers share the
work, each on what it is good at:

* The model (Gemini) transcribes what is *written*: filer name, state and
  district, asset names, dates, owner codes. Those were right on every row of
  every trial measured for issue #1.
* `paper_form` reads what is *ticked*: the amount column and the transaction
  type. The paper form records both as rows of checkboxes, and every model
  tested misreads those — it loses count across the long grid — in about a
  quarter of rows. The grid is ruled and printed, so the boxes are found from
  the rules and the ink inside each is measured. The grid is authoritative
  for amount and type; the model's own reading of them is only a check.

The join is by row order, page by page. Each page is matched on its own:
the model says which page every row is on, the grid knows how many rows it
found there, and a page whose counts disagree is refused alone — its grid
rows are stored unjoined and its transcription dropped — while the other
pages keep their rows. A page whose grid could not be decomposed yields no
rows and carries the reason. A row whose model type contradicts the grid's
keeps the grid's type and is flagged (`scan_rows.status = 'type_disputed'`);
only when the disputed share of a filing passes `MAX_DISPUTED_SHARE` is
the whole filing refused, since at that rate the rows are not aligned and a
half-matched filing would put one row's amount on another's asset.

Transcribed rows are stored with the filing marked `parse_method =
'vision'`, which `stats.py` and the dashboard quarantine from every volume
figure (they count as trades, never as money). The path is still off by
default (`vision.enabled`); see config.yaml for what turning it on does.
"""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Callable
from dataclasses import dataclass, field

from .ptr import ParsedFiling, Transaction

log = logging.getLogger(__name__)

MODEL = "gemini-3.8-flash"

PROMPT = """This is a scanned US House "Periodic Transaction Report" (STOCK Act disclosure),
filed on PAPER. Transcribe the written text; the ticked boxes are read by
another program from the printed grid, so you need not be careful with them.

The table has these blocks, left to right: an owner code (SP, DC or JT),
the full asset name, a "Type of Transaction" block of tick columns, one or
two dates, and an "Amount of Transaction" block of lettered tick columns.
Some filers attach their own spreadsheet with the same columns instead of
using the printed form; read it the same way. The asset column says
"Provide full name, not ticker symbol", so these forms carry NO ticker:
return null for ticker and never infer one from the company name.

Return JSON only:

{
  "filer_name": "name without the Hon./Rep. prefix",
  "state_district": "two-letter state plus district, e.g. WI08",
  "type_columns": ["the tick-column headings between the asset name and the dates, left to right, as printed, e.g. Purchase, Sale, Partial Sale, Exchange"],
  "amount_letters": "the first and last letters printed over the amount columns, e.g. A-K",
  "transactions": [
    {
      "page": 1,
      "asset_name": "the full asset name exactly as written",
      "ticker": null,
      "owner": "SP, DC, JT, or null if blank",
      "action": "your own reading of the ticked type: purchase, sale, sale_partial, exchange, or null",
      "tx_date": "YYYY-MM-DD",
      "notification_date": "YYYY-MM-DD or null",
      "amount_column": "your own reading of the ticked amount column's letter, or null"
    }
  ]
}

Rules:
- List EVERY transaction row, in the order printed, page by page, top to
  bottom. Do not merge, reorder or skip rows, and do not add rows: the rows
  are matched one-to-one with the grid by position.
- "page" is the 1-based page of this PDF the row is printed on. Give it on
  every row: the rows are matched to the grid page by page, and a page
  whose count disagrees is set aside on its own.
- A row is a transaction if it has an asset name AND a transaction date. A
  line that only names an account, trust or sub-holding, with no date and
  no ticks, is a heading, not a transaction: leave it out. A name that
  wraps onto a second line is one row.
- The printed "Example: Mega Corp Common Stock" row on page 1 is not a
  transaction.
- Two-digit years are 20xx: 07/22/26 is 2026-07-22.
- If a tick is unclear, return null for it. A missing reading is fine; a
  guessed one is not.
- Return no prose, only the JSON object.
"""


class VisionUnavailable(Exception):
    """No API key, or a dependency of this path is not installed."""


class ScanUnreadable(Exception):
    """The scan was read by both readers but cannot be reconciled, or its
    grid could not be found. The message says why."""


# The paper form's amount grid, column letter → bracket. Column K is not an
# amount — it flags a transaction in a spouse's or dependent child's asset
# over $1,000,000 — so it yields no bracket.
AMOUNT_COLUMNS: dict[str, str | None] = {
    "A": "$1,001 - $15,000",
    "B": "$15,001 - $50,000",
    "C": "$50,001 - $100,000",
    "D": "$100,001 - $250,000",
    "E": "$250,001 - $500,000",
    "F": "$500,001 - $1,000,000",
    "G": "$1,000,001 - $5,000,000",
    "H": "$5,000,001 - $25,000,000",
    "I": "$25,000,001 - $50,000,000",
    "J": "Over $50,000,000",
    "K": None,
}

ACTIONS = {"purchase", "sale", "sale_partial", "exchange"}

# A row whose model type contradicts the grid's keeps the grid's type and is
# flagged. A page is refused on its own, and a filing as a whole, only when
# the disputed rows are at least MIN_DISPUTED_ROWS *and* more than
# MAX_DISPUTED_SHARE of the rows joined. The model misreads about a quarter
# of boxes (issue #1; the prompt tells it not to be careful with them), so a
# quarter is what an aligned join looks like, and one or two disputes are
# slips whatever the size: the first day's refusals (#51) were 2 of 6, 2 of
# 3 and 3 of 98 rows, and on every one the grid was right by eye. Rows out
# of step — a wrapped name split and a row merged on the same page, which
# the per-page count check cannot see — dispute several rows in a run on
# that page, well past a quarter of it; that is what refuses it. Two was
# the limit when counts were only checked filing-wide, because a shift on
# one page could then hide behind a miscount on another; per-page counts
# catch that case before the types are compared.
MAX_DISPUTED_SHARE = 0.25
MIN_DISPUTED_ROWS = 3

# Bumped when the join learns to read something it refused before. The
# pipeline (`retry_scanned`) re-queues every `vision_failed` filing once per
# version, so a refusal is retried exactly when the rule that refused it
# changed, never every run.
JOIN_VERSION = 2

Transcriber = Callable[[bytes, str], dict]


@dataclass
class PageJoin:
    """How one page of the PDF was joined."""
    page_no: int                   # 1-based
    grid_rows: int                 # transaction rows the grid found on the page
    model_rows: int                # rows the model placed on the page
    error: str | None = None       # why the page yielded no rows, if it did not
    joined: int = 0                # transactions made from the page
    disputed: int = 0              # of those, with the model's type contradicting the grid's


@dataclass
class ScannedFiling(ParsedFiling):
    """A `ParsedFiling` read from a scan, with the join's page-by-page
    account: which grid row (`scan_rows.row_index`) each transaction came
    from, which pages yielded nothing, and which rows are disputed."""
    pages: list[PageJoin] = field(default_factory=list)
    row_indexes: list[int] = field(default_factory=list)     # per transaction
    disputed_rows: list[int] = field(default_factory=list)   # grid row indexes
    grid: object = None                                      # the GridReading joined

    @property
    def unread_pages(self) -> list[PageJoin]:
        return [p for p in self.pages if p.error]

    @property
    def lost_rows(self) -> int:
        """Rows the model transcribed on pages that yielded none."""
        return sum(p.model_rows for p in self.pages if p.error)

    def note(self) -> str | None:
        """A one-line account of what the join left out, for `last_error`.
        Each page's reason is cut to its first clause; the whole of it is on
        the page itself (`scan_pages.error`)."""
        if not self.unread_pages:
            return None
        parts = [f"page {p.page_no}: {_brief(p.error)}" for p in self.unread_pages]
        return (f"partially read: {len(self.unread_pages)} page(s) yielded no rows "
                f"({self.lost_rows} transcribed row(s) dropped) — " + "; ".join(parts))


def _brief(reason: str) -> str:
    """The first clause of a page's reason: the grid reader lists every
    orientation it tried, and a refused page every disputed row."""
    first = reason.split(";", 1)[0]
    if "(" in first and ")" not in first:
        first = first[:first.index("(")].rstrip()
    return first.strip()


def _page_error(page) -> str:
    """A grid page's reason without the `page N: ` the reader prefixes —
    the join names the page itself."""
    return re.sub(rf"^page {page.index + 1}: ", "", page.error or "")


def amount_from_column(letter: str | None) -> str | None:
    """Map a paper-form amount column letter to its bracket text."""
    if not letter:
        return None
    return AMOUNT_COLUMNS.get(str(letter).strip().upper()[:1])


def parse_scanned(pdf_bytes: bytes, api_key: str | None,
                  transcribe: Transcriber | None = None) -> ScannedFiling:
    """Read a scanned PTR. Raises VisionUnavailable without a key or the
    `vision` extra, ScanUnreadable when the readings cannot be reconciled.

    `transcribe` replaces the model call (tests pass a stub); the grid is
    always read, and first, so an unreadable grid costs no API call.
    """
    if not api_key:
        raise VisionUnavailable("GEMINI_API_KEY not set")
    grid = read_grid(pdf_bytes)
    data = (transcribe or _transcribe)(pdf_bytes, api_key)
    return join(data, grid)


def read_grid(pdf_bytes: bytes):
    """The printed grid's reading of every page. A page that could not be
    decomposed is carried with its reason; ScanUnreadable only when no page
    at all could be, so there is nothing to join and no model call to make."""
    from . import paper_form

    try:
        grid = paper_form.read_pdf(pdf_bytes)
    except ImportError as exc:
        raise VisionUnavailable(f"grid reader dependency missing: {exc}") from exc
    except paper_form.GridNotFound as exc:
        raise ScanUnreadable(f"grid: {exc}") from exc
    if grid.unread and not grid.readable:
        raise ScanUnreadable("grid: " + "; ".join(p.error for p in grid.unread))
    return grid


def _transcribe(pdf_bytes: bytes, api_key: str) -> dict:
    try:
        from google import genai
        from google.genai import types
    except ImportError as exc:
        raise VisionUnavailable(f"google-genai not installed: {exc}") from exc

    client = genai.Client(api_key=api_key)
    response = client.models.generate_content(
        model=MODEL,
        contents=[
            types.Part.from_bytes(data=pdf_bytes, mime_type="application/pdf"),
            PROMPT,
        ],
        # Gemini 3.x deprecates the sampling parameters (temperature, top_p,
        # top_k); the migration guide says to drop them rather than pin them.
        config={"response_mime_type": "application/json"},
    )
    text = (response.text or "").strip()
    if not text:
        raise ValueError("vision returned an empty response")
    return json_object(text)


def json_object(text: str) -> dict:
    """The JSON object in a model reply.

    The request asks for JSON only, but a reply can still arrive fenced
    (```json … ```) or with a sentence around it, and the first live run lost
    a filing to exactly that. The outermost object is taken; a reply with no
    object at all is still an error the caller reports.
    """
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end < start:
        raise ValueError(f"vision returned no JSON object: {text[:80]!r}")
    return json.loads(text[start:end + 1])


def join(data: dict, grid) -> ScannedFiling:
    """Marry the model's text to the grid's ticks, row by row, page by page.

    The grid supplies amount and type. The model's own readings of them are
    compared: a contradiction on the type flags the row (the grid's type is
    kept), and a page — or the filing — with disputes past the threshold
    above is refused rather than joined wrongly. Amount disagreements are
    logged only — that the model gets them wrong is the measured reason the
    grid reader exists.

    Pages are matched on their own counts. A page the grid could not
    decompose yields no transactions, whatever the model read there; a page
    where the two counts differ is refused alone, its grid rows left
    unjoined. If the model gave no page numbers at all the rows are matched
    in order across the filing, as before, and a count mismatch cannot be
    localised, so it refuses the filing.
    """
    model_rows = [r for r in (data.get("transactions") or []) if r.get("asset_name")]
    paged = _by_page(model_rows)
    grid_pages = list(grid.pages)
    layouts = [p.layout for p in grid_pages if p.layout is not None]
    if layouts:
        _check_headers(data, layouts[0])

    result = ScannedFiling(
        filer_name=(data.get("filer_name") or "").strip() or None,
        state_district=(data.get("state_district") or "").strip() or None,
        grid=grid,
    )

    # The grid's rows per page, each with its filing-wide index: the order
    # `scan_capture` stores them in, so a transaction can point at its row.
    per_page: list[list[tuple[int, object]]] = []
    row_index = 0
    for page in grid_pages:
        rows = []
        for g in page.rows:
            if g.populated:
                rows.append((row_index, g))
                row_index += 1
        per_page.append(rows)

    if paged is None:
        # No page numbers: one sequence against the whole grid.
        total = sum(len(rows) for rows in per_page)
        if len(model_rows) != total:
            raise ScanUnreadable(
                f"the grid has {total} transaction rows but the model "
                f"transcribed {len(model_rows)}")
        paged, cursor = {}, 0
        for index, rows in enumerate(per_page):
            paged[index + 1] = model_rows[cursor:cursor + len(rows)]
            cursor += len(rows)

    type_conflicts: list[str] = []
    amount_conflicts = 0
    for index, page in enumerate(grid_pages):
        page_no = index + 1
        rows = per_page[index]
        m_rows = paged.pop(page_no, [])
        pj = PageJoin(page_no, len(rows), len(m_rows))
        result.pages.append(pj)
        if page.error:
            pj.error = _page_error(page)
            continue
        if len(rows) != len(m_rows):
            pj.error = (f"the grid found {len(rows)} transaction row(s) on this page "
                        f"but the model placed {len(m_rows)} here")
            continue
        page_txs, page_disputed = [], []
        for (ri, g), m in zip(rows, m_rows):
            tx, disputed, conflict = _join_row(m, g, ri)
            page_txs.append((ri, tx))
            if disputed:
                page_disputed.append((ri, disputed))
            amount_conflicts += conflict
        if _too_disputed(len(page_disputed), len(page_txs)):
            pj.error = (f"the model's transaction type contradicts the grid on "
                        f"{len(page_disputed)} of {len(page_txs)} rows on this page "
                        f"({'; '.join(d for _, d in page_disputed)})")
            continue
        pj.joined = len(page_txs)
        pj.disputed = len(page_disputed)
        for ri, tx in page_txs:
            result.transactions.append(tx)
            result.row_indexes.append(ri)
        for ri, disputed in page_disputed:
            result.disputed_rows.append(ri)
            type_conflicts.append(disputed)
    for page_no, m_rows in sorted(paged.items()):
        # Rows the model put on a page the PDF does not have.
        result.pages.append(PageJoin(
            page_no, 0, len(m_rows),
            error=f"the model placed {len(m_rows)} row(s) on page {page_no}, "
                  f"which the PDF does not have"))

    joined = len(result.transactions)
    if _too_disputed(len(type_conflicts), joined):
        raise ScanUnreadable(
            f"the model's transaction type contradicts the grid on "
            f"{len(type_conflicts)} of {joined} rows ({'; '.join(type_conflicts)})")
    if type_conflicts:
        log.info("type disagreement on %d of %d rows, grid kept: %s",
                 len(type_conflicts), joined, "; ".join(type_conflicts))
    if amount_conflicts:
        log.info("model's amount letter differed from the grid on %d of %d rows; "
                 "grid kept", amount_conflicts, joined)
    unread = result.unread_pages
    if unread and not joined:
        raise ScanUnreadable("no page could be joined: " + "; ".join(
            f"page {p.page_no}: {p.error}" for p in unread))
    if unread:
        log.warning("%s", result.note())
    return result


def _too_disputed(disputed: int, joined: int) -> bool:
    """Whether this many disputed rows among this many joined ones is past
    the threshold at the top of the module."""
    return disputed >= MIN_DISPUTED_ROWS and disputed > MAX_DISPUTED_SHARE * joined


def _by_page(model_rows: list[dict]) -> dict[int, list[dict]] | None:
    """The model's rows grouped by the page it put them on, in order; None
    when any row lacks a page number (then the rows are one sequence)."""
    pages: dict[int, list[dict]] = {}
    for m in model_rows:
        try:
            page_no = int(m.get("page"))
        except (TypeError, ValueError):
            return None
        pages.setdefault(page_no, []).append(m)
    return pages or None


def _join_row(m: dict, g, row_index: int) -> tuple[Transaction, str | None, int]:
    """One transaction from a model row and its grid row. Returns it, the
    type dispute (a description, or None), and whether the amount differed."""
    model_action = str(m.get("action") or "").strip().lower() or None
    disputed = None
    if model_action in ACTIONS and g.action and _direction(model_action) != _direction(g.action):
        disputed = f"row {row_index + 1}: model {model_action}, grid {g.action}"
    model_letter = (str(m.get("amount_column") or "").strip().upper()[:1]) or None
    amount_conflict = int(bool(model_letter and g.amount and model_letter != g.amount))

    if g.amount is None:
        log.info("no single amount tick for %r (ticks %s); row kept without one",
                 m.get("asset_name"), g.amount_marks)
    tx = Transaction(
        asset_name=str(m["asset_name"]).strip(),
        action=g.action or "unknown",
        ticker=None,
        asset_type=None,
        owner=(str(m.get("owner") or "").strip().upper() or None),
        tx_date=m.get("tx_date"),
        notification_date=m.get("notification_date"),
        amount_raw=amount_from_column(g.amount),
        cap_gains_over_200=g.cap_gains,
        raw_text=(
            f"(scanned filing: text transcribed by {MODEL}; "
            f"amount column {g.amount or '?'} and type {g.action or '?'} read "
            f"from the printed grid, page {g.page + 1}; model read "
            f"{model_letter or '?'} / {model_action or '?'}"
            + ("; type disputed, grid kept" if disputed else "") + ")"
        ),
    )
    return tx, disputed, amount_conflict


def _direction(action: str) -> str:
    return "sale" if action in ("sale", "sale_partial") else action


def _check_headers(data: dict, layout) -> None:
    """The column counts the grid found must match the headings the model
    read, or the count-based meaning of the columns is not safe to use."""
    letters = str(data.get("amount_letters") or "").strip().upper()
    found = re.findall(r"[A-K]", letters)
    if found:
        last = found[-1]
        expected = layout.letters[-1]
        if last != expected:
            raise ScanUnreadable(
                f"the grid has amount columns A-{expected} but the model read "
                f"the headings as {letters!r}")
    headings = data.get("type_columns")
    if isinstance(headings, list) and headings:
        n = layout.type_columns + layout.flag_columns
        if len(headings) != n:
            raise ScanUnreadable(
                f"the grid has {n} tick columns before the dates but the model "
                f"read {len(headings)} headings ({', '.join(map(str, headings))})")
