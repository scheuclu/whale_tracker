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

The join is by row order across pages. If the two readers disagree on how
many transactions there are, or the model's type contradicts the grid on
more than one row, the filing is unreadable and the reason is recorded —
a half-matched filing would put one row's amount on another's asset.

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

# How many rows the model's type reading may contradict the grid's before
# the join is not trusted. One is a model slip; two is a misaligned join.
MAX_TYPE_DISAGREEMENTS = 1

Transcriber = Callable[[bytes, str], dict]


def amount_from_column(letter: str | None) -> str | None:
    """Map a paper-form amount column letter to its bracket text."""
    if not letter:
        return None
    return AMOUNT_COLUMNS.get(str(letter).strip().upper()[:1])


def parse_scanned(pdf_bytes: bytes, api_key: str | None,
                  transcribe: Transcriber | None = None) -> ParsedFiling:
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
    """The printed grid's reading of every page; ScanUnreadable if any page
    with a table could not be decomposed."""
    from . import paper_form

    try:
        return paper_form.read_pdf(pdf_bytes)
    except ImportError as exc:
        raise VisionUnavailable(f"grid reader dependency missing: {exc}") from exc
    except paper_form.GridNotFound as exc:
        raise ScanUnreadable(f"grid: {exc}") from exc


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
    return json.loads(text)


def join(data: dict, grid) -> ParsedFiling:
    """Marry the model's text to the grid's ticks, row by row.

    The grid supplies amount and type. The model's own readings of them are
    compared and counted: a contradiction on the type in more than one row
    means the rows are not aligned, and the filing is refused rather than
    joined wrongly. Amount disagreements are logged only — that the model
    gets them wrong is the measured reason the grid reader exists.
    """
    model_rows = [r for r in (data.get("transactions") or []) if r.get("asset_name")]
    grid_rows = grid.rows
    if len(model_rows) != len(grid_rows):
        raise ScanUnreadable(
            f"the grid has {len(grid_rows)} transaction rows but the model "
            f"transcribed {len(model_rows)}")
    if grid_rows:
        _check_headers(data, grid_rows[0].layout)

    result = ParsedFiling(
        filer_name=(data.get("filer_name") or "").strip() or None,
        state_district=(data.get("state_district") or "").strip() or None,
    )
    type_conflicts: list[str] = []
    amount_conflicts = 0
    for index, (m, g) in enumerate(zip(model_rows, grid_rows), start=1):
        model_action = str(m.get("action") or "").strip().lower() or None
        if model_action in ACTIONS and g.action and _direction(model_action) != _direction(g.action):
            type_conflicts.append(f"row {index}: model {model_action}, grid {g.action}")
        model_letter = (str(m.get("amount_column") or "").strip().upper()[:1]) or None
        if model_letter and g.amount and model_letter != g.amount:
            amount_conflicts += 1

        amount_raw = amount_from_column(g.amount)
        if g.amount is None:
            log.info("no single amount tick for %r (ticks %s); row kept without one",
                     m.get("asset_name"), g.amount_marks)
        result.transactions.append(Transaction(
            asset_name=str(m["asset_name"]).strip(),
            action=g.action or "unknown",
            ticker=None,
            asset_type=None,
            owner=(str(m.get("owner") or "").strip().upper() or None),
            tx_date=m.get("tx_date"),
            notification_date=m.get("notification_date"),
            amount_raw=amount_raw,
            cap_gains_over_200=g.cap_gains,
            raw_text=(
                f"(scanned filing: text transcribed by {MODEL}; "
                f"amount column {g.amount or '?'} and type {g.action or '?'} read "
                f"from the printed grid, page {g.page + 1}; model read "
                f"{model_letter or '?'} / {model_action or '?'})"
            ),
        ))

    if len(type_conflicts) > MAX_TYPE_DISAGREEMENTS:
        raise ScanUnreadable(
            f"the model's transaction type contradicts the grid on "
            f"{len(type_conflicts)} rows ({'; '.join(type_conflicts)})")
    if type_conflicts:
        log.info("one type disagreement, grid kept: %s", type_conflicts[0])
    if amount_conflicts:
        log.info("model's amount letter differed from the grid on %d of %d rows; "
                 "grid kept", amount_conflicts, len(grid_rows))
    return result


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
