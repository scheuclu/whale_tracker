"""Telegram notification: HTML formatting with length degradation, sending.

`esc` and `send_message` follow the same contract as the sibling
youtube_finance_bro project (HTML parse mode, 429 backoff, never split a
message across sends).
"""

from __future__ import annotations

import logging
import time
from urllib.parse import quote

import httpx

from .amounts import format_amount, usd
from .options import describe as describe_option
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
    if contract := describe_option(tx.get("option_kind"), tx.get("strike_cents"),
                                   tx.get("expiry")):
        # The contract as the filing printed it: kind, and strike and expiry
        # only when they were given. The most directional line in the message.
        detail.append(esc(contract))
    if tx.get("tx_date"):
        traded = tx["tx_date"][5:].replace("-", "/")
        delay = tx.get("delay_days")
        detail.append(f"traded {traded}" + (f" ({delay}d delay)" if delay is not None else ""))
    if owner := OWNER_LABEL.get(tx.get("owner") or ""):
        detail.append(owner)
    if tx.get("transcribed"):
        # Read off a scanned paper form by the grid reader and a vision
        # model: shown, and kept out of every total.
        detail.append(TRANSCRIBED_LABEL)
    if detail:
        line += "\n     " + " · ".join(detail)
    return line


TRANSCRIBED_LABEL = "transcribed from scan"


def late_prefix(late_by_days: int) -> str:
    """The first line of a filing message whose every trade was disclosed
    past the deadline — the filing is reported once, as itself, and leads
    with how late it was. `late_by_days` comes from
    `stats.filing_late_by_days`: the report's own lateness, measured from the
    due date its earliest trade set."""
    return f"⚠️ late by {late_by_days} day" + ("" if late_by_days == 1 else "s")


def format_filing(member: str, party: str | None, state: str | None,
                  district: str | None, chamber: str | None, filing_date: str | None,
                  pdf_url: str, transactions: list[dict],
                  contexts: dict[str, TickerStat] | None = None,
                  late_by_days: int | None = None) -> str:
    """One message per new disclosure filing.

    Degradation order, so a 94-transaction filing still fits in one message:
    drop the aggregate context lines → drop asset detail → cap the transaction
    list. Never splits into multiple messages. `late_by_days`, when given,
    prefixes the message and survives every degradation step: it is one
    short line, and the reason the filing deserves a second look.
    """
    contexts = contexts or {}

    def build(include_context: bool, include_detail: bool, max_tx: int) -> str:
        header = member_label(member, party, state, district, chamber)
        parts = [late_prefix(late_by_days)] if late_by_days is not None else []
        parts += [
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


# Above this many transactions the per-filing message cannot keep each row's
# detail inside Telegram's limit. Measured on real filings: a 29-row one kept
# its asset names and trade dates at 3,294 characters, and every one of 42+
# rows lost them. Past the budget a summary is sent instead — the largest
# trades in full, the rest by bracket, and a link to the member's page.
FILING_ROW_BUDGET = 40

# How many of the largest trades the summary lists in full.
SUMMARY_TOP_TRADES = 8


def member_page_url(name: str, base_url: str | None = None) -> str:
    """The member's dashboard page.

    Mirrors `memberHref` in web/lib/format.ts: keyed on the display name,
    because that is how the leaderboard groups and an unmatched filing has
    only the name printed on the PDF. Relative when `dashboard.url` is not
    configured — Telegram will not make it clickable, but it is the path.
    """
    path = f"/politicians?m={quote(name, safe='')}"
    return f"{base_url.rstrip('/')}{path}" if base_url else path


def format_filing_summary(member: str, party: str | None, state: str | None,
                          district: str | None, chamber: str | None,
                          filing_date: str | None, pdf_url: str, transactions: list[dict],
                          member_url: str,
                          contexts: dict[str, TickerStat] | None = None,
                          late_by_days: int | None = None) -> str:
    """One message for a filing with more rows than fit with their detail.

    `format_filing` degrades a long filing by dropping context, then every
    row's asset name and trade date, then rows. Six real filings of 42–99
    rows went out that way: every row present, none saying when it was
    traded. This keeps the largest trades in full — as the disclosed ranges,
    never a midpoint — says how the rest spread across the brackets, and
    links the dashboard page that has the whole table.
    """
    contexts = contexts or {}
    header = member_label(member, party, state, district, chamber)
    n = len(transactions)

    buys = sum(1 for t in transactions if t["action"] == "purchase")
    sells = sum(1 for t in transactions if t["action"] in ("sale", "sale_partial"))
    exchanges = sum(1 for t in transactions if t["action"] == "exchange")
    other = n - buys - sells - exchanges
    shape = [f"{buys} buy" + ("s" if buys != 1 else ""),
             f"{sells} sell" + ("s" if sells != 1 else "")]
    if exchanges:
        shape.append(f"{exchanges} exchange" + ("s" if exchanges != 1 else ""))
    if other:
        shape.append(f"{other} other")
    dates = sorted(t["tx_date"] for t in transactions if t.get("tx_date"))
    if dates:
        shape.append("traded " + (_mmdd(dates[0]) if dates[0] == dates[-1]
                                  else f"{_mmdd(dates[0])}–{_mmdd(dates[-1])}"))
    delays = sorted(t["delay_days"] for t in transactions if t.get("delay_days") is not None)
    if delays:
        shape.append("filed " + (f"{delays[0]}d" if delays[0] == delays[-1]
                                 else f"{delays[0]}–{delays[-1]}d") + " later")

    ranked = sorted(transactions, key=_floor_key)

    def build(top: int, include_context: bool) -> str:
        parts = [late_prefix(late_by_days)] if late_by_days is not None else []
        parts += [
            f"🏛 <b>New filing — {esc(header)}</b>",
            f"Filed {esc(filing_date or 'unknown')} · {n} transactions — too many to list, "
            "so a summary",
            " · ".join(shape),
            f"By bracket: {esc(_bracket_breakdown(transactions))}",
            "",
            f"<b>Largest {top} by bracket floor</b>",
        ]
        parts += [_tx_line(t) for t in ranked[:top]]
        if include_context:
            ctx_lines = _context_lines(ranked[:top], contexts)
            if ctx_lines:
                parts += [""] + ctx_lines
        parts += ["", f"Full table: {esc(member_url)}", esc(pdf_url)]
        return "\n".join(parts)

    for top, include_context in ((SUMMARY_TOP_TRADES, True), (5, True), (3, False), (1, False)):
        msg = build(min(top, n) or 1, include_context)
        if len(msg) <= TELEGRAM_LIMIT:
            return msg
    return build(1, False)[:TELEGRAM_LIMIT]


def _mmdd(iso: str) -> str:
    return iso[5:].replace("-", "/")


def _floor_key(tx: dict) -> tuple:
    """Largest first by what the row proves: the exact figure or the bracket
    floor. An open-ended bracket outranks a bounded one with the same floor."""
    exact = tx.get("amount_exact_cents")
    lo = exact if exact is not None else (tx.get("amount_min_cents") or 0)
    hi = tx.get("amount_max_cents")
    open_ended = exact is None and hi is None
    return (-lo, 0 if open_ended else 1, -(hi or 0))


def _bracket_breakdown(transactions: list[dict]) -> str:
    """How many rows sit in each disclosed bracket, largest bracket first.

    Exact figures are one group of their own rather than folded into the
    bracket that would contain them: the breakdown is of what was filed.
    """
    counts: dict[tuple, int] = {}
    for tx in transactions:
        if tx.get("amount_exact_cents") is not None:
            key: tuple = ("exact",)
        else:
            key = (tx.get("amount_min_cents"), tx.get("amount_max_cents"))
        counts[key] = counts.get(key, 0) + 1

    def order(item):
        key = item[0]
        if key[0] == "exact":
            return (1, 0, 0)
        lo, hi = key
        return (0, -(lo or 0), 0 if hi is None else 1)

    parts = []
    for key, count in sorted(counts.items(), key=order):
        label = "exact figures" if key[0] == "exact" else format_amount(key[0], key[1])
        parts.append(f"{label} ×{count}")
    return " · ".join(parts)


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
    return _single_transaction(f"🚨 <b>WATCHLIST — {esc(header)}</b>", filing_date,
                               pdf_url, tx, index, total, context)


def format_options_transaction(member: str, party: str | None, state: str | None,
                               district: str | None, chamber: str | None,
                               filing_date: str | None, pdf_url: str, tx: dict,
                               index: int, total: int,
                               context: TickerStat | None = None) -> str:
    """One message per options trade, for `alerts.options_every_trade`.

    The watchlist's shape, because the reason is the same: the per-filing
    digest degrades to fit Telegram's limit, and an option's contract is the
    detail it would drop first. `index`/`total` place the trade in its filing.
    """
    header = member_label(member, party, state, district, chamber)
    return _single_transaction(f"🎯 <b>OPTIONS — {esc(header)}</b>", filing_date,
                               pdf_url, tx, index, total, context)


def _single_transaction(headline: str, filing_date: str | None, pdf_url: str, tx: dict,
                        index: int, total: int, context: TickerStat | None) -> str:
    parts = [
        headline,
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
    note = " <i>(scan)</i>" if tx.get("transcribed") else ""
    return f"{emoji} {esc(label)} <b>{esc(symbol)}</b> {esc(amount)}{note}"


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
    """Consensus alert: several members converging on one ticker.

    The headline count is of members who cleared the bracket floor — the
    number the alert actually fired on. Members below the floor are named on
    their own line so the message is true to what was counted and still
    shows the whole picture; the volume and trade count cover everyone.
    """
    verb = "bought" if cluster.direction == "buy" else "sold"
    vol = cluster.volume
    if vol.open_ended or vol.max_cents is None:
        vol_text = f"≥{usd(vol.min_cents)}"
    else:
        vol_text = (
            f"{format_amount(vol.min_cents, vol.max_cents)} "
            f"(mid {usd(vol.mid_cents)})"
        )

    headline = f"{cluster.politician_count} politicians {verb} in the last {window_days} days"
    if cluster.member_floor_cents:
        headline += f", each ≥{esc(usd(cluster.member_floor_cents))} by bracket floor"

    def build(cap: int | None) -> str:
        parts = [
            f"🔥 <b>CLUSTER ALERT — {esc(cluster.ticker)}</b>",
            headline,
            f"Volume {esc(vol_text)} · {cluster.trade_count} "
            + ("buys" if cluster.direction == "buy" else "sells"),
            esc(_names(cluster.members, cap)),
        ]
        if cluster.below_floor:
            parts.append(f"<i>+{len(cluster.below_floor)} more {verb} below that floor: "
                         f"{esc(_names(cluster.below_floor, cap))}</i>")
        return "\n".join(parts)

    msg = build(None)
    if len(msg) > TELEGRAM_LIMIT:
        msg = build(10)
    return msg[:TELEGRAM_LIMIT]


def _names(names: list[str], cap: int | None) -> str:
    if cap is None or len(names) <= cap:
        return ", ".join(names)
    return ", ".join(names[:cap]) + f" …+{len(names) - cap} more"


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
    if row["implausible"] == 1:
        # Reproduced, not believed: the figure is shown because it is what
        # was filed, and labelled because it counts toward nothing.
        return (f"{emoji} {esc(shares)} sh @ {esc(_price(row['price_per_share']))}"
                f" = {esc(usd(row['amount_exact_cents']))} · <i>as filed, implausible</i>")
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
    if match.value_cents is not None:
        value = usd(match.value_cents)
    elif any(r["implausible"] == 1 for r in match.rows):
        value = "an implausible as-filed amount"
    else:
        value = "an unpriced amount"

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
