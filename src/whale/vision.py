"""Gemini fallback for scanned paper PTRs.

About 8% of House PTRs are filed on paper and scanned to image-only PDFs with
no text layer, so `ptr.py` cannot read them. Gemini reads the page image
directly and returns the same transaction rows.

This path is optional: without `GEMINI_API_KEY` those filings are reported to
Telegram as metadata-only and excluded from volume statistics rather than
silently dropped.
"""

from __future__ import annotations

import json
import logging

from .amounts import parse_amount
from .ptr import ParsedFiling, Transaction

log = logging.getLogger(__name__)

MODEL = "gemini-3.6-flash"

PROMPT = """This is a scanned US House "Periodic Transaction Report" (STOCK Act disclosure).

Transcribe the filer information and EVERY transaction row in the table. Return JSON only:

{
  "filer_name": "name without the Hon. prefix",
  "state_district": "e.g. FL25",
  "transactions": [
    {
      "asset_name": "asset as written, without the trailing ticker and bracketed code",
      "ticker": "ticker in parentheses, or null",
      "asset_type": "the bracketed two-letter code such as ST, GS, OP, or null",
      "owner": "SP, DC, JT, or null if blank",
      "action": "one of: purchase, sale, sale_partial, exchange",
      "tx_date": "YYYY-MM-DD",
      "notification_date": "YYYY-MM-DD or null",
      "amount_raw": "the amount cell verbatim, e.g. \\"$1,001 - $15,000\\"",
      "cap_gains_over_200": true/false/null
    }
  ]
}

Rules:
- Transaction type letters map as: P = purchase, S = sale, "S (partial)" = sale_partial, E = exchange.
- Copy amounts verbatim as a range. Never convert a range to a single number.
- Handwritten or illegible values: use null rather than guessing.
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
        config={"response_mime_type": "application/json", "temperature": 0},
    )
    text = (response.text or "").strip()
    if not text:
        raise ValueError("vision returned an empty response")

    return _to_parsed_filing(json.loads(text))


def _to_parsed_filing(data: dict) -> ParsedFiling:
    result = ParsedFiling(
        filer_name=(data.get("filer_name") or "").strip() or None,
        state_district=(data.get("state_district") or "").strip() or None,
    )
    for row in data.get("transactions") or []:
        amount_raw = row.get("amount_raw")
        # Drop rows the model could not read an amount or asset for: a
        # half-read row would corrupt the volume statistics.
        if not row.get("asset_name"):
            continue
        if amount_raw and parse_amount(amount_raw) is None:
            log.warning("vision produced an unparseable amount %r; keeping row without it",
                        amount_raw)
            amount_raw = None
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
