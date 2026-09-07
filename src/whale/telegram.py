"""Telegram notification: HTML formatting with length degradation, sending.

`esc` and `send_message` follow the same contract as the sibling
youtube_finance_bro project (HTML parse mode, 429 backoff, never split a
message across sends).
"""

from __future__ import annotations

import logging
import time

import httpx

from .amounts import format_amount, usd
from .stats import Cluster, TickerStat

log = logging.getLogger(__name__)

TELEGRAM_LIMIT = 4096

ACTION_EMOJI = {
    "purchase": "🟢",
    "sale": "🔴",
    "sale_partial": "🟠",
    "exchange": "🔄",
}
ACTION_LABEL = {
    "purchase": "BUY",
    "sale": "SELL",
    "sale_partial": "SELL (partial)",
    "exchange": "EXCHANGE",
}
OWNER_LABEL = {"SP": "spouse", "DC": "dependent child", "JT": "joint"}


def esc(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def member_label(name: str, party: str | None, state: str | None,
                 district: str | None, chamber: str | None) -> str:
    title = "Sen." if chamber == "senate" else "Rep."
    where = ""
    if party or state:
        district_part = f"{district}" if district not in (None, "", "0") else ""
        where = f" ({'-'.join(p for p in [party, f'{state or ""}{district_part}'] if p)})"
    return f"{title} {name}{where}"


def _tx_line(tx: dict) -> str:
    emoji = ACTION_EMOJI.get(tx["action"], "⚪️")
    label = ACTION_LABEL.get(tx["action"], tx["action"].upper())
    amount = format_amount(tx.get("amount_min_cents"), tx.get("amount_max_cents"),
                           tx.get("amount_exact_cents"))
    name = (tx.get("asset_name") or "").strip()
    ticker = tx.get("ticker")

    # Bonds, Treasuries and private funds have no ticker; leading with a
    # placeholder dash reads as missing data, so the asset name takes the slot.
    headline = ticker or (name[:40] or "unnamed asset")
    line = f"{emoji} <b>{esc(label)}</b>  <b>{esc(headline)}</b>  {esc(amount)}"

    detail = []
    if name and ticker:
        detail.append(esc(name[:60]))
    if tx.get("tx_date"):
        traded = tx["tx_date"][5:].replace("-", "/")
        delay = tx.get("delay_days")
        detail.append(f"traded {traded}" + (f" ({delay}d delay)" if delay is not None else ""))
    if owner := OWNER_LABEL.get(tx.get("owner") or ""):
        detail.append(owner)
    if detail:
        line += "\n     " + " · ".join(detail)
    return line


def format_filing(member: str, party: str | None, state: str | None,
                  district: str | None, chamber: str | None, filing_date: str | None,
                  pdf_url: str, transactions: list[dict],
                  contexts: dict[str, TickerStat] | None = None) -> str:
    """One message per new disclosure filing.

    Degradation order, so a 94-transaction filing still fits in one message:
    drop the aggregate context lines → drop asset detail → cap the transaction
    list. Never splits into multiple messages.
    """
    contexts = contexts or {}

    def build(include_context: bool, include_detail: bool, max_tx: int) -> str:
        header = member_label(member, party, state, district, chamber)
        parts = [
            f"🏛 <b>New filing — {esc(header)}</b>",
            f"Filed {esc(filing_date or 'unknown')} · {len(transactions)} transaction"
            + ("s" if len(transactions) != 1 else ""),
            "",
        ]
        for tx in transactions[:max_tx]:
            line = _tx_line(tx) if include_detail else _tx_line_compact(tx)
            parts.append(line)
        if len(transactions) > max_tx:
            parts.append(f"…+{len(transactions) - max_tx} more")

        if include_context:
            ctx_lines = _context_lines(transactions[:max_tx], contexts)
            if ctx_lines:
                parts += [""] + ctx_lines
        parts += ["", esc(pdf_url)]
        return "\n".join(parts)

    total = len(transactions) or 1
    for include_context, include_detail, max_tx in (
        (True, True, total),
        (False, True, total),
        (False, False, total),
        (False, False, 25),
        (False, False, 10),
    ):
        msg = build(include_context, include_detail, max_tx)
        if len(msg) <= TELEGRAM_LIMIT:
            return msg
    return build(False, False, 5)[:TELEGRAM_LIMIT]


def _tx_line_compact(tx: dict) -> str:
    emoji = ACTION_EMOJI.get(tx["action"], "⚪️")
    label = ACTION_LABEL.get(tx["action"], tx["action"].upper())
    symbol = tx.get("ticker") or (tx.get("asset_name") or "—")[:20]
    amount = format_amount(tx.get("amount_min_cents"), tx.get("amount_max_cents"),
                           tx.get("amount_exact_cents"))
    return f"{emoji} {esc(label)} <b>{esc(symbol)}</b> {esc(amount)}"


def _context_lines(transactions: list[dict], contexts: dict[str, TickerStat]) -> list[str]:
    """Aggregate context for the tickers in this filing — the whole point of
    tracking history rather than reporting filings in isolation."""
    lines = []
    seen = set()
    for tx in transactions:
        ticker = tx.get("ticker")
        if not ticker or ticker in seen:
            continue
        seen.add(ticker)
        ctx = contexts.get(ticker)
        if not ctx or ctx.politician_count < 2:
            continue
        direction = ctx.net_direction
        verb = {"buy": "net buy", "sell": "net sell", "flat": "mixed"}[direction]
        vol = ctx.buy_volume if direction == "buy" else ctx.sell_volume
        lines.append(
            f"<i>30d on {esc(ticker)}: {ctx.politician_count} politicians · "
            f"{esc(usd(vol.mid_cents))} {verb}</i>"
        )
    return lines[:5]


def format_cluster(cluster: Cluster, window_days: int) -> str:
    """Consensus alert: several members converging on one ticker."""
    verb = "bought" if cluster.direction == "buy" else "sold"
    vol = cluster.volume
    if vol.open_ended or vol.max_cents is None:
        vol_text = f"≥{usd(vol.min_cents)}"
    else:
        vol_text = (
            f"{format_amount(vol.min_cents, vol.max_cents)} "
            f"(mid {usd(vol.mid_cents)})"
        )

    members = ", ".join(cluster.members)
    parts = [
        f"🔥 <b>CLUSTER ALERT — {esc(cluster.ticker)}</b>",
        f"{cluster.politician_count} politicians {verb} in the last {window_days} days",
        f"Volume {esc(vol_text)} · {cluster.trade_count} "
        + ("buys" if cluster.direction == "buy" else "sells"),
        esc(members),
    ]
    msg = "\n".join(parts)
    if len(msg) > TELEGRAM_LIMIT:
        keep = cluster.members[:10]
        parts[-1] = esc(", ".join(keep)) + f" …+{len(cluster.members) - len(keep)} more"
        msg = "\n".join(parts)
    return msg[:TELEGRAM_LIMIT]


def format_unparsed(member: str, party: str | None, state: str | None,
                    district: str | None, chamber: str | None,
                    filing_date: str | None, pdf_url: str, reason: str) -> str:
    """Scanned paper filing we could not read — report it rather than drop it."""
    header = member_label(member, party, state, district, chamber)
    return (
        f"🏛 <b>New filing — {esc(header)}</b>\n"
        f"Filed {esc(filing_date or 'unknown')}\n\n"
        f"⚠️ Could not parse ({esc(reason)}) — open the PDF.\n"
        f"{esc(pdf_url)}"
    )


def send_message(bot_token: str, chat_id: str, text: str, max_attempts: int = 3) -> None:
    api_url = f"https://api.telegram.org/bot{bot_token}/sendMessage"
    payload = {
        "chat_id": chat_id,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    }
    for _ in range(max_attempts):
        resp = httpx.post(api_url, json=payload, timeout=30)
        if resp.status_code == 200:
            return
        if resp.status_code == 429:
            retry_after = int(resp.json().get("parameters", {}).get("retry_after", 5))
            log.warning("telegram rate limited; sleeping %ds", retry_after)
            time.sleep(retry_after + 1)
            continue
        raise RuntimeError(f"telegram sendMessage failed: {resp.status_code} {resp.text[:200]}")
    raise RuntimeError("telegram sendMessage failed after retries (rate limited)")
