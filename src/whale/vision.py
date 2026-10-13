"""Gemini fallback for scanned paper PTRs.

About 8% of House PTRs are filed on paper and scanned to image-only PDFs with
no text layer, so `ptr.py` cannot read them. Gemini reads the page image
directly and returns the same transaction rows.

This path is optional AND off by default (`vision.enabled` in config.yaml).
The paper form records the amount as a checkbox grid with rotated column
headers, which every model tested misreads — roughly a quarter of rows come
back with a wrong amount or direction. Measurement and proposed fix:
https://github.com/scheuclu/whale_tracker/issues/1

With it off, or without `GEMINI_API_KEY`, scanned filings are reported to
Telegram as metadata-only and excluded from volume statistics rather than
silently dropped.
"""

from __future__ import annotations

import json
import logging

from .amounts import parse_amount
from .ptr import ParsedFiling, Transaction

log = logging.getLogger(__name__)

MODEL = "gemini-3.8-flash"

PROMPT = """This is a scanned US House "Periodic Transaction Report" (STOCK Act disclosure).

This is the PAPER form. Its layout differs from the electronic filing:

* "AMOUNT OF TRANSACTION" is a grid of checkboxes, one column per bracket.
  Each column is labelled with a letter, A through K, printed beside the
  bracket text. Report the LETTER of the ticked box, not the dollar text.
  Counting columns across the grid is error-prone; find the tick, then read
  the letter belonging to that column.
* "TYPE OF TRANSACTION" is four checkbox columns: Purchase, Sale,
  Partial Sale, Exchange.
* The leftmost narrow column holds the owner code: SP, DC or JT.
* The asset column says "Provide full name, not ticker symbol", so these
  forms carry NO ticker. Return null for ticker — never infer one from the
  company name.
* Pages may be rotated, and a filing may run to several pages.

Transcribe the filer information and EVERY transaction row. Return JSON only:

{
  "filer_name": "name without the Hon./Rep. prefix",
  "state_district": "two-letter state plus district, e.g. WI08",
  "transactions": [
    {
      "asset_name": "the full asset name exactly as written",
      "ticker": null,
      "asset_type": null,
      "owner": "SP, DC, JT, or null if blank",
      "action": "one of: purchase, sale, sale_partial, exchange",
      "tx_date": "YYYY-MM-DD",
      "notification_date": "YYYY-MM-DD or null",
      "amount_column": "the single letter A-K of the ticked amount box, or null",
      "cap_gains_over_200": true/false/null
    }
  ]
}

Rules:
- "Partial Sale" ticked means sale_partial, not sale.
- Two-digit years are 20xx: 07/22/26 is 2026-07-22.
- If no amount box is clearly ticked, or the tick is ambiguous between two
  columns, return null for amount_column. A missing amount is acceptable; a
  guessed one is not.
- Include every row across every page. Return no prose, only the JSON object.
"""


class VisionUnavailable(Exception):
    """No API key, or the SDK is not installed."""


def parse_scanned(pdf_bytes: bytes, api_key: str | None) -> ParsedFiling:
    """Read a scanned PTR with Gemini. Raises VisionUnavailable without a key."""
    if not api_key:
        raise VisionUnavailable("GEMINI_API_KEY not set")
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

    return _to_parsed_filing(json.loads(text))


# The paper form's amount grid, column letter → bracket. Asking the model for
# the letter and mapping it here keeps the dollar figures out of the model's
# output entirely: it only has to read one character next to the ticked box.
#
# Column K is not an amount — it flags a transaction in a spouse's or
# dependent child's asset over $1,000,000 — so it yields no bracket.
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


def amount_from_column(letter: str | None) -> str | None:
    """Map a paper-form amount column letter to its bracket text."""
    if not letter:
        return None
    return AMOUNT_COLUMNS.get(str(letter).strip().upper()[:1])


def _to_parsed_filing(data: dict) -> ParsedFiling:
    result = ParsedFiling(
        filer_name=(data.get("filer_name") or "").strip() or None,
        state_district=(data.get("state_district") or "").strip() or None,
    )
    for row in data.get("transactions") or []:
        # Drop rows with no asset: a half-read row would corrupt the statistics.
        if not row.get("asset_name"):
            continue

        # Prefer the column letter. Fall back to transcribed text only if the
        # model ignored the instruction and sent an amount string instead.
        amount_raw = amount_from_column(row.get("amount_column"))
        if amount_raw is None and row.get("amount_raw"):
            amount_raw = row["amount_raw"]
            if parse_amount(amount_raw) is None:
                log.warning("vision produced an unparseable amount %r; dropping it",
                            amount_raw)
                amount_raw = None
        if amount_raw is None:
            log.info("no readable amount for %r; row kept without one",
                     row.get("asset_name"))
        result.transactions.append(Transaction(
            asset_name=str(row["asset_name"]).strip(),
            action=str(row.get("action") or "unknown"),
            ticker=(row.get("ticker") or None),
            asset_type=(row.get("asset_type") or None),
            owner=(row.get("owner") or None),
            tx_date=row.get("tx_date"),
            notification_date=row.get("notification_date"),
            amount_raw=amount_raw,
            cap_gains_over_200=row.get("cap_gains_over_200"),
            raw_text="(scanned filing, transcribed by vision model)",
        ))
    return result
