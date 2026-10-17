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
from .stats import Cluster, InsiderCluster, TickerStat

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


def format_watchlist_transaction(member: str, party: str | None, state: str | None,
                                 district: str | None, chamber: str | None,
                                 filing_date: str | None, pdf_url: str, tx: dict,
                                 index: int, total: int,
                                 context: TickerStat | None = None) -> str:
    """One message per transaction by a watched member.

    Deliberately not `format_filing`: a watched member's filing is split so
    each trade arrives as its own alert rather than one line inside a digest
    that may have been degraded to fit. `index`/`total` keep the filing
    reconstructable, so a 7-trade filing reads as 7 of one event, not 7 events.
    """
    header = member_label(member, party, state, district, chamber)
    parts = [
        f"🚨 <b>WATCHLIST — {esc(header)}</b>",
        _tx_line(tx),
        "",
        f"Filed {esc(filing_date or 'unknown')} · transaction {index} of {total}",
    ]
    if context is not None:
        line = _context_line(context)
        if line:
            parts.append(line)
    parts += ["", esc(pdf_url)]
    msg = "\n".join(parts)
    if len(msg) <= TELEGRAM_LIMIT:
        return msg
    # One transaction cannot plausibly overflow, but a pathological asset name
    # must truncate rather than fail the send.
    return msg[:TELEGRAM_LIMIT]


def _tx_line_compact(tx: dict) -> str:
    emoji = ACTION_EMOJI.get(tx["action"], "⚪️")
    label = ACTION_LABEL.get(tx["action"], tx["action"].upper())
    symbol = tx.get("ticker") or (tx.get("asset_name") or "—")[:20]
    amount = format_amount(tx.get("amount_min_cents"), tx.get("amount_max_cents"),
                           tx.get("amount_exact_cents"))
    return f"{emoji} {esc(label)} <b>{esc(symbol)}</b> {esc(amount)}"


def _context_line(ctx: TickerStat | None) -> str | None:
    """How the rest of Congress has traded this ticker lately.

    None when there is nothing to say: a single member trading a ticker is
    just the filing being reported, not context for it.
    """
    if not ctx or ctx.politician_count < 2:
        return None
    direction = ctx.net_direction
    verb = {"buy": "net buy", "sell": "net sell", "flat": "mixed"}[direction]
    vol = ctx.buy_volume if direction == "buy" else ctx.sell_volume
    return (f"<i>30d on {esc(ctx.ticker)}: {ctx.politician_count} politicians · "
            f"{esc(usd(vol.mid_cents))} {verb}</i>")


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
        line = _context_line(contexts.get(ticker))
        if line:
            lines.append(line)
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


# --- insiders (SEC Form 4) ---------------------------------------------------


def _shares(n: float | None) -> str:
    if n is None:
        return "?"
    return f"{n:,.0f}" if float(n).is_integer() else f"{n:,.2f}"


def _price(n: float | None) -> str:
    return "—" if n is None else f"${n:,.2f}" if n >= 1 else f"${n:,.4f}"


def _insider_row(row) -> str:
    """One transaction, with its inputs shown rather than just the product.

    A Form 4 value is shares × the price as filed. Printing the arithmetic is
    the label: nobody has to wonder whether the figure was disclosed or
    derived, and a weighted-average price is visible as the odd number it is.
    """
    emoji = ACTION_EMOJI.get(row["action"], "⚪️")
    shares = _shares(row["shares"])
    if row["amount_exact_cents"] is None:
        return f"{emoji} {esc(shares)} sh · <i>no price filed</i>"
    return (f"{emoji} {esc(shares)} sh @ {esc(_price(row['price_per_share']))}"
            f" = <b>{esc(usd(row['amount_exact_cents']))}</b>")


def owner_label(owner) -> str:
    """A reporting owner and the relationship they declared."""
    if owner is None:
        return "unknown filer"
    roles = [
        owner["officer_title"] or ("Officer" if owner["is_officer"] else None),
        "Director" if owner["is_director"] else None,
        "10% owner" if owner["is_ten_percent_owner"] else None,
    ]
    role = ", ".join(r for r in roles if r)
    name = (owner["name"] or owner["insider_cik"]).strip()
    return f"<b>{esc(name)}</b>" + (f" ({esc(role)})" if role else "")


def _ordinal(n: int) -> str:
    suffix = "th" if 10 <= n % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
    return f"{n}{suffix}"


def _repeat_line(repeat) -> str:
    """"3rd filing in 12 days · cumulative $22M" — a refire of the same
    owner's programme, so the reader sees the run rather than one filing."""
    when = ("today" if repeat.days == 0 else "in 1 day" if repeat.days == 1
            else f"in {repeat.days} days")
    total = (f"cumulative <b>{esc(usd(repeat.cumulative_cents))}</b> (shares × reported price)"
             if repeat.cumulative_cents is not None else "cumulative value unpriced")
    return f"<b>{_ordinal(repeat.count)} filing {when}</b> · {total}"


def format_insider_filing(match, cluster_context: InsiderCluster | None = None,
                          repeat=None) -> str:
    """One message per Form 4 that a rule claimed.

    The rule's name is the headline, so the chat says *why* this filing was
    worth interrupting for. `repeat` is the cooldown decision when this is a
    refire of a run already reported: the message then also carries how many
    filings the run spans and their cumulative value.
    """
    filing = match.filing
    verb = "bought" if match.direction == "purchase" else "sold"
    emoji = ACTION_EMOJI.get(match.direction, "⚪️")
    symbol = filing["ticker"] or filing["issuer_name"] or "unknown issuer"
    value = usd(match.value_cents) if match.value_cents is not None else "an unpriced amount"

    who = owner_label(match.primary)
    joint = len(match.owners) - 1
    if joint > 0:
        who += f" +{joint} joint filer" + ("s" if joint > 1 else "")

    traded = sorted({r["tx_date"] for r in match.rows if r["tx_date"]})
    detail = [f"Filed {esc(filing['filing_date'])}"]
    if traded:
        span = traded[0] if len(traded) == 1 else f"{traded[0]}–{traded[-1]}"
        detail.append(f"traded {esc(span)}")
    if any(r["late"] == 1 for r in match.rows):
        detail.append("<b>filed late</b>")
    if filing["aff_10b5_one"] == 1:
        detail.append("10b5-1 plan")

    def build(max_rows: int) -> str:
        parts = [
            f"{emoji} <b>{esc(match.rule.name)} — {esc(symbol)}</b>",
            f"{who} {verb} <b>{esc(value)}</b> of {esc(filing['issuer_name'] or 'the issuer')}",
        ]
        if repeat is not None:
            parts.append(_repeat_line(repeat))
        parts += [" · ".join(detail), ""]
        parts += [_insider_row(r) for r in match.rows[:max_rows]]
        if len(match.rows) > max_rows:
            parts.append(f"…+{len(match.rows) - max_rows} more")
        if cluster_context and cluster_context.insider_count > 1:
            moved = "bought" if cluster_context.direction == "buy" else "sold"
            parts += ["", f"<i>{cluster_context.insider_count} insiders {moved} "
                          f"{esc(symbol)} recently · "
                          f"{esc(usd(cluster_context.volume.mid_cents))}</i>"]
        parts += ["", esc(filing["source_url"])]
        return "\n".join(parts)

    for max_rows in (len(match.rows) or 1, 25, 10, 5):
        msg = build(max_rows)
        if len(msg) <= TELEGRAM_LIMIT:
            return msg
    return build(3)[:TELEGRAM_LIMIT]


def format_insider_cluster(cluster: InsiderCluster, rule_name: str,
                           window_days: int) -> str:
    """Several insiders converging on one issuer."""
    verb = "bought" if cluster.direction == "buy" else "sold"
    # Never a bare CIK: a ten-digit number tells the reader nothing.
    symbol = cluster.ticker or cluster.issuer_name or "unknown issuer"
    parts = [
        f"🔥 <b>{esc(rule_name)} — {esc(symbol)}</b>",
        f"{cluster.insider_count} insiders {verb} {esc(cluster.issuer_name or 'this issuer')} "
        f"in the last {window_days} days",
        f"{esc(usd(cluster.volume.mid_cents))} across {cluster.filing_count} filing"
        + ("s" if cluster.filing_count != 1 else "")
        + f" · {cluster.trade_count} " + ("buys" if cluster.direction == "buy" else "sells"),
        esc(", ".join(cluster.insiders)),
    ]
    msg = "\n".join(parts)
    if len(msg) > TELEGRAM_LIMIT:
        keep = cluster.insiders[:10]
        parts[-1] = esc(", ".join(keep)) + f" …+{len(cluster.insiders) - len(keep)} more"
        msg = "\n".join(parts)
    return msg[:TELEGRAM_LIMIT]


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
