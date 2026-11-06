"""Public X posts (@fatcatwatching): the alert log, mirrored.

Every message the pipeline delivers is a row in `alerts` (db.record_alert).
This step posts the ones a public account should carry — a congressional
filing, a congressional cluster, an insider filing, an insider cluster — as
short posts that link to the dashboard, and records each attempt in
`x_posts`, so an alert is posted once and a failed post is tried again by
the next run. Telegram is untouched: nothing here can hold a message back,
and the step never raises into the pipeline.

The posts follow the rules every other surface follows (CLAUDE.md):
amounts are the disclosed ranges, an open-ended top bracket is `≥floor`,
transcribed rows never enter a total, an insider value is "shares × reported
price", direction is a word, and the tone is playful, never accusatory. They
are written from the stored rows, not from the Telegram text: that text is
HTML, runs to thousands of characters, and links to the PDF rather than the
dashboard.

A watched member's filing (`watchlist`, every trade its own message) and an
option trade (`options`) are posted as their filing, once: the first such
alert of a filing carries the filing's post and the rest are set aside, as
are replays. An option alert whose filing also had its own `filing` message
is left to that one. Not posted: the `late_filing` marker (the filing's own
post says it was late) and a filing alert with no rows (a scan nobody could
read). Alerts older than `x.max_age_hours` are old news and are
left alone, which is also what keeps the first run after `x.enabled` is
turned on from replaying the history.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import re
import secrets
import sqlite3
import time
import urllib.parse
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone

import httpx

from . import db, stats, telegram
from .amounts import _usd
from .config import Config

log = logging.getLogger(__name__)

POST_URL = "https://api.x.com/2/tweets"
MAX_WEIGHT = 280
# X counts every link as this many characters, whatever its length (t.co).
URL_WEIGHT = 23
# twitter-text v3: code points in these ranges weigh 1, everything else 2
# (CJK, emoji). Counting an emoji's variation selector as 2 more overcounts,
# which only ever makes a post shorter than it could be.
_LIGHT_RANGES = ((0, 4351), (8192, 8205), (8208, 8223), (8242, 8247))
_URL_RE = re.compile(r"https?://\S+")
_CASHTAG_RE = re.compile(r"[A-Z]{1,6}")
# A cashtag as twitter-text finds one (`$MSFT`, `$BRK.B`, any case); amounts
# ("$15k") start with a digit.
_CASHTAG_IN_TEXT = re.compile(r"(?<![\w$])\$([A-Za-z]{1,6}(?:[._][A-Za-z]{1,2})?)(?![A-Za-z0-9_])")
_CIK_RE = re.compile(r"\d{10}")

POSTED_KINDS = (stats.FILING_KIND, stats.CLUSTER_KIND, stats.INSIDER_FILING_KIND,
                stats.INSIDER_CLUSTER_KIND, stats.WATCHLIST_KIND, stats.OPTIONS_KIND)
# Kinds that are one message per transaction of a filing.
_PER_TRADE_KINDS = (stats.WATCHLIST_KIND, stats.OPTIONS_KIND)
UTM = "utm_source=x"

VERB = {"purchase": "↗ Bought", "sale": "↘ Sold", "sale_partial": "↘ Sold part of",
        "exchange": "⇄ Exchanged"}
SIDE = {"buy": "bought", "sell": "sold"}


# --- length -------------------------------------------------------------------


def weighted_length(text: str) -> int:
    """The length X measures a post by: links count 23, wide characters 2."""
    urls = _URL_RE.findall(text)
    rest = _URL_RE.sub("", text)
    weight = sum(1 if any(lo <= ord(c) <= hi for lo, hi in _LIGHT_RANGES) else 2 for c in rest)
    return weight + URL_WEIGHT * len(urls)


def _fit(head: list[str], items: list[str], tail: list[str], url: str) -> str:
    """`head`, as many `items` as fit, a count of the rest, `tail`, then the link."""

    def build(shown: list[str], dropped: int) -> str:
        more = [f"+ {dropped} more on the page"] if dropped else []
        return "\n".join(head + shown + more + tail + [url])

    for keep in range(len(items), -1, -1):
        text = build(items[:keep], len(items) - keep)
        if weighted_length(text) <= MAX_WEIGHT:
            return text
    # Even the head does not fit (an absurdly long name): cut the first line.
    text = build([], len(items))
    first, _, others = text.partition("\n")
    room = MAX_WEIGHT - weighted_length(others) - 2
    return first[: max(room, 20)].rstrip() + "…\n" + others


# --- wording ------------------------------------------------------------------


def cashtag(symbol: str | None) -> str | None:
    """`$MSFT` for a plain symbol X links as a cashtag; the symbol as is otherwise."""
    if not symbol:
        return None
    return f"${symbol}" if _CASHTAG_RE.fullmatch(symbol) else symbol


def volume_text(min_cents: int | None, max_cents: int | None, open_ended: bool = False) -> str | None:
    """A disclosed range as filed: `$1,001–$15k`, `≥$5M` for the open-ended top
    bracket (no invented upper bound), None when nothing was disclosed."""
    if min_cents is None:
        return None
    if open_ended or max_cents is None:
        return f"≥{_usd(min_cents)}"
    if min_cents == max_cents:
        return _usd(min_cents)
    return f"{_usd(min_cents)}–{_usd(max_cents)}"


def _day(iso: str | None) -> str | None:
    if not iso:
        return None
    try:
        d = date.fromisoformat(iso[:10])
    except ValueError:
        return None
    return f"{d:%b} {d.day}"


def _link(base_url: str, path: str, fragment: str = "") -> str:
    return f"{base_url.rstrip('/')}{path}?{UTM}{fragment}"


def _ticker_path(symbol: str) -> str:
    """Mirrors `tickerHref` in web/lib/format.ts."""
    return f"/tickers/{urllib.parse.quote(symbol.upper(), safe='')}"


def _plural(n: int, one: str, many: str | None = None) -> str:
    return f"{n} {one if n == 1 else (many or one + 's')}"


# --- composing ----------------------------------------------------------------


def compose(conn: sqlite3.Connection, alert, config: Config) -> str | None:
    """The post for one alert row, or None when the alert is not one the public
    account carries (see the module docstring)."""
    text = _compose(conn, alert, config)
    return one_cashtag(text) if text is not None else None


def one_cashtag(text: str) -> str:
    """Keep the first cashtag and print later ones as plain symbols. The API
    refuses a post with more than one ("Posts are limited to a maximum of one
    cashtag", 403, 2026-11-03), and the first is the post's subject: the
    headline's ticker, or a filing's largest line."""
    seen = False

    def keep_first(m: re.Match) -> str:
        nonlocal seen
        if seen:
            return m.group(1)
        seen = True
        return m.group(0)

    return _CASHTAG_IN_TEXT.sub(keep_first, text)


def _compose(conn: sqlite3.Connection, alert, config: Config) -> str | None:
    base = config.dashboard_url
    if not base:
        return None
    kind = alert["kind"]
    if kind == stats.FILING_KIND:
        return _filing_post(conn, alert, base, config.alerts.late_filing_days)
    if kind in _PER_TRADE_KINDS:
        return (_filing_post(conn, alert, base, config.alerts.late_filing_days)
                if _carries_filing(conn, alert) else None)
    if kind == stats.CLUSTER_KIND:
        return _cluster_post(alert, base)
    if kind == stats.INSIDER_FILING_KIND:
        return _insider_filing_post(conn, alert, base)
    if kind == stats.INSIDER_CLUSTER_KIND:
        return _insider_cluster_post(conn, alert, base)
    return None


def _filing_post(conn, alert, base: str, deadline_days: int) -> str | None:
    if alert["filing_id"] is None:
        return None
    filing = conn.execute(
        """SELECT f.*, p.full_name AS member_name, p.party, p.bioguide_id, p.chamber AS member_chamber
           FROM filings f LEFT JOIN politicians p ON p.id = f.politician_id WHERE f.id = ?""",
        (alert["filing_id"],)).fetchone()
    if filing is None:
        return None
    rows = [dict(r) for r in db.transactions_for_filing(conn, filing["id"])]
    if not rows:
        return None  # an unread scan: the filing alert said so, the public feed need not
    name = filing["member_name"] or filing["filer_name"]
    state, district = _state_district(filing["state_district"])
    member = telegram.member_label(name, filing["party"], state, district,
                                   filing["member_chamber"] or filing["chamber"])
    filed = _day(filing["filing_date"])
    head = [f"🏛 {member} disclosed {_plural(len(rows), 'trade')}"
            + (f", filed {filed}" if filed else "") + ":"]
    delays = [stats.disclosure_delay_days(r["tx_date"], filing["filing_date"]) for r in rows]
    late_by = stats.filing_late_by_days(delays, deadline_days)
    if late_by is not None:
        head.insert(0, f"⏰ Filed {_plural(late_by, 'day')} past the {deadline_days}-day deadline")
    transcribed = any(r.get("transcribed") for r in rows)
    items = [line for line, _ in sorted(_filing_lines(rows, transcribed), key=lambda x: -x[1])]
    tail = ["Read from a paper scan; amounts are on the page."] if transcribed else []
    url = _link(base, telegram.member_page_url(name, None, filing["bioguide_id"]))
    return _fit(head, items, tail, url)


def _carries_filing(conn, alert) -> bool:
    """Whether this per-trade alert is the one that posts its filing: the
    filing had no `filing` message of its own, and this is the first per-trade
    alert logged for it (a replayed watchlist filing logs its repeats)."""
    if alert["filing_id"] is None:
        return False
    marks = ", ".join("?" for _ in _PER_TRADE_KINDS)
    row = conn.execute(
        f"""SELECT SUM(kind = ?) AS filing_alerts,
                   MIN(CASE WHEN kind IN ({marks}) THEN id END) AS first_per_trade
            FROM alerts WHERE filing_id = ?""",
        (stats.FILING_KIND, *_PER_TRADE_KINDS, alert["filing_id"])).fetchone()
    return not row["filing_alerts"] and row["first_per_trade"] == alert["id"]


def _state_district(raw: str | None) -> tuple[str | None, str | None]:
    from . import roster

    if not raw:
        return None, None
    state, district = roster.parse_state_district(raw)
    return state, (str(district) if district is not None else None)


def _filing_lines(rows: list[dict], transcribed: bool) -> list[tuple[str, int]]:
    """One line per (action, asset): `↗ Bought $MU ×3 · $3,003–$45k`, with the
    floor it sorts by. A transcribed row never enters a sum (#1), so a scan's
    lines carry no amount."""
    groups: dict[tuple[str, str], list[dict]] = {}
    for r in rows:
        what = cashtag(r.get("ticker")) or _asset(r.get("asset_name"))
        groups.setdefault((r["action"], what), []).append(r)
    lines = []
    for (action, what), group in groups.items():
        verb = VERB.get(action, action)
        count = f" ×{len(group)}" if len(group) > 1 else ""
        amount = None
        floor = 0
        if not transcribed:
            volume = stats.Volume()
            for r in group:
                volume.add(r.get("amount_min_cents"), r.get("amount_max_cents"),
                           r.get("amount_exact_cents"))
            amount = volume_text(volume.min_cents, volume.max_cents, volume.open_ended)
            floor = volume.min_cents
        lines.append((f"{verb} {what}{count}" + (f" · {amount}" if amount else ""), floor))
    return lines


def _asset(name: str | None) -> str:
    name = re.sub(r"\s+", " ", (name or "an asset")).strip()
    name = re.sub(r"\s*-\s*Common Stock$", "", name, flags=re.I)
    return name if len(name) <= 32 else name[:31].rstrip() + "…"


def _cluster_post(alert, base: str) -> str | None:
    symbol, side = alert["ticker"], SIDE.get(alert["direction"] or "")
    if not symbol or not side:
        return None
    n = alert["politician_count"]
    head = [f"🔥 {n} members of Congress {side} {cashtag(symbol)} within {alert['window_days']} days"]
    names = [p.strip() for p in (alert["participants"] or "").split(",") if p.strip()]
    items = []
    if len(names) == n:
        # Only when the message named exactly the members it counted: a member
        # below the floor is named in the Telegram alert but never counted.
        items.append(", ".join(names))
    amount = volume_text(alert["volume_min_cents"], alert["volume_max_cents"])
    tail = [f"Disclosed: {amount} combined."] if amount else []
    return _fit(head, items, tail, _link(base, _ticker_path(symbol)))


def _insider_filing_post(conn, alert, base: str) -> str | None:
    side = SIDE.get(alert["direction"] or "")
    if alert["insider_filing_id"] is None or not side:
        return None
    filing = conn.execute("SELECT * FROM insider_filings WHERE id = ?",
                          (alert["insider_filing_id"],)).fetchone()
    if filing is None:
        return None
    owners = conn.execute(
        """SELECT o.*, i.name FROM insider_filing_owners o
           LEFT JOIN insiders i ON i.cik = o.insider_cik
           WHERE o.filing_id = ? ORDER BY o.owner_index""", (filing["id"],)).fetchall()
    symbol = filing["ticker"]
    issuer = (filing["issuer_name"] or symbol or "the company").strip()
    who = _owner_text(owners[0]) if owners else "An insider"
    if len(owners) > 1:
        who += f" +{len(owners) - 1} joint filer" + ("" if len(owners) == 2 else "s")
    value = _insider_value(alert)
    what = (f"{value} of {issuer} (shares × reported price)" if value
            else f"shares of {issuer}; no price was reported")
    head = [f"💼 Insider {'buy' if side == 'bought' else 'sale'}" + (f": {cashtag(symbol)}" if symbol else "")]
    filed = _day(filing["filing_date"])
    items = [f"{who} {side} {what}" + (f", filed {filed}." if filed else ".")]
    if symbol and not _CIK_RE.fullmatch(symbol):
        url = _link(base, _ticker_path(symbol), "#insiders")
    elif owners:
        url = _link(base, f"/insiders/{telegram._slugify(owners[0]['name'] or '') or 'insider'}-{owners[0]['insider_cik']}")
    else:
        url = _link(base, "/insiders")
    return _fit(head, items, [], url)


def _owner_text(owner) -> str:
    roles = [
        owner["officer_title"] or ("Officer" if owner["is_officer"] else None),
        "Director" if owner["is_director"] else None,
        "10% owner" if owner["is_ten_percent_owner"] else None,
    ]
    role = ", ".join(r for r in roles if r)
    name = (owner["name"] or owner["insider_cik"]).strip()
    return name + (f" ({role})" if role else "")


def _insider_value(alert) -> str | None:
    """Form 4 values are exact but computed (shares × price as filed), stored
    min = max; None when nothing was priced — an unknown value is not 0."""
    lo, hi = alert["volume_min_cents"], alert["volume_max_cents"]
    if lo is None or hi is None:
        return None
    return volume_text(lo, hi)


def _insider_cluster_post(conn, alert, base: str) -> str | None:
    symbol, side = alert["ticker"], SIDE.get(alert["direction"] or "")
    if not symbol or not side:
        return None
    issuer = conn.execute(
        "SELECT issuer_name FROM insider_filings WHERE ticker = ? OR issuer_cik = ? "
        "ORDER BY filing_date DESC LIMIT 1", (symbol, symbol)).fetchone()
    name = (issuer["issuer_name"].strip() if issuer and issuer["issuer_name"] else None)
    plain = _CIK_RE.fullmatch(symbol) is not None
    where = name or symbol
    if not plain:
        where = f"{name} ({cashtag(symbol)})" if name else cashtag(symbol)
    head = [f"🔥 {alert['politician_count']} insiders at {where} {side} within {alert['window_days']} days"]
    value = _insider_value(alert)
    tail = [f"{value} in all (shares × reported price)."] if value else []
    url = _link(base, "/insiders") if plain else _link(base, _ticker_path(symbol), "#insiders")
    return _fit(head, [], tail, url)


# --- posting ------------------------------------------------------------------


class XError(Exception):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status

    @property
    def stops_run(self) -> bool:
        """A rejected key, no API credits (402 "credits depleted": X bills the
        API per use) or a rate limit fails every post alike."""
        return self.status in (401, 402, 429)

    @property
    def rejected(self) -> bool:
        """X refused this post's content (400, or 403 as for a second cashtag or
        a duplicate): sending it again would be refused again, and billed."""
        return self.status in (400, 403)


@dataclass
class Credentials:
    api_key: str
    api_secret: str
    access_token: str
    access_token_secret: str

    @classmethod
    def from_config(cls, config: Config) -> "Credentials | None":
        values = (config.x_api_key, config.x_api_secret, config.x_access_token,
                  config.x_access_token_secret)
        return cls(*values) if all(values) else None


def _quote(s: str) -> str:
    return urllib.parse.quote(s, safe="~")


def oauth_header(method: str, url: str, creds: Credentials, nonce: str | None = None,
                 timestamp: str | None = None) -> str:
    """OAuth 1.0a (HMAC-SHA1) for a request whose body is JSON: the body is
    not signed, only the oauth parameters and the query string are."""
    oauth = {
        "oauth_consumer_key": creds.api_key,
        "oauth_nonce": nonce or secrets.token_hex(16),
        "oauth_signature_method": "HMAC-SHA1",
        "oauth_timestamp": timestamp or str(int(time.time())),
        "oauth_token": creds.access_token,
        "oauth_version": "1.0",
    }
    base_url, _, query = url.partition("?")
    params = dict(urllib.parse.parse_qsl(query)) | oauth
    normalized = "&".join(f"{_quote(k)}={_quote(v)}" for k, v in sorted(params.items()))
    base = "&".join([method.upper(), _quote(base_url), _quote(normalized)])
    key = f"{_quote(creds.api_secret)}&{_quote(creds.access_token_secret)}".encode()
    oauth["oauth_signature"] = base64.b64encode(hmac.new(key, base.encode(), hashlib.sha1).digest()).decode()
    return "OAuth " + ", ".join(f'{_quote(k)}="{_quote(v)}"' for k, v in sorted(oauth.items()))


def send_post(creds: Credentials, text: str, client: httpx.Client | None = None) -> str:
    """Post `text`; returns X's id for it, or raises XError."""
    http = client if client is not None else httpx.Client(timeout=30)
    try:
        res = http.post(POST_URL, json={"text": text},
                        headers={"Authorization": oauth_header("POST", POST_URL, creds)})
    except httpx.HTTPError as exc:
        raise XError(f"request failed: {exc}") from exc
    finally:
        if client is None:
            http.close()
    if res.status_code not in (200, 201):
        raise XError(f"HTTP {res.status_code}: {res.text[:300]}", res.status_code)
    try:
        return str(res.json()["data"]["id"])
    except (ValueError, KeyError, TypeError) as exc:
        raise XError(f"unexpected reply: {res.text[:300]}", res.status_code) from exc


# --- the step -----------------------------------------------------------------


@dataclass
class Result:
    posted: int = 0
    failed: int = 0
    rejected: int = 0
    skipped: int = 0
    left: int = 0
    stopped: str | None = None
    previews: list[str] = field(default_factory=list)

    def summary(self) -> str:
        out = (f"{self.posted} posted, {self.failed} failed, {self.rejected} rejected by X, "
               f"{self.skipped} not for X, {self.left} left for the next run")
        return out + (f"; stopped: {self.stopped}" if self.stopped else "")


def pending(conn: sqlite3.Connection, max_age_hours: float, now: datetime | None = None) -> list:
    """Alerts of a posted kind, young enough, not yet posted or set aside."""
    now = now or datetime.now(timezone.utc)
    since = (now - timedelta(hours=max_age_hours)).strftime("%Y-%m-%dT%H:%M:%SZ")
    marks = ", ".join("?" for _ in POSTED_KINDS)
    return conn.execute(
        f"""SELECT a.* FROM alerts a LEFT JOIN x_posts x ON x.alert_id = a.id
            WHERE a.kind IN ({marks}) AND a.fired_at >= ?
              AND (x.alert_id IS NULL OR x.status = 'failed')
            ORDER BY a.fired_at, a.id""", (*POSTED_KINDS, since)).fetchall()


def _record(conn, alert_id: int, status: str, text: str | None, post_id: str | None = None,
            error: str | None = None) -> None:
    conn.execute(
        """INSERT INTO x_posts (alert_id, status, post_id, text, attempts, error, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(alert_id) DO UPDATE SET status = excluded.status, post_id = excluded.post_id,
             text = excluded.text, attempts = x_posts.attempts + excluded.attempts,
             error = excluded.error, updated_at = excluded.updated_at""",
        (alert_id, status, post_id, text, 0 if status == "skipped" else 1, error, db.now_iso()))
    conn.commit()


def sync(conn: sqlite3.Connection, config: Config, dry_run: bool = False,
         send=send_post, now: datetime | None = None) -> Result:
    """Post what is pending, oldest first, at most `x.max_per_run`. A dry run
    composes the same posts and records nothing."""
    result = Result()
    settings = config.x
    creds = Credentials.from_config(config)
    if creds is None and not dry_run:
        result.stopped = "X credentials not set (X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET)"
        return result
    queue = pending(conn, settings.max_age_hours, now)
    for i, alert in enumerate(queue):
        if result.posted + result.failed + result.rejected >= settings.max_per_run:
            result.left = len(queue) - i
            break
        text = compose(conn, alert, config)
        if text is None:
            result.skipped += 1
            if not dry_run:
                _record(conn, alert["id"], "skipped", None)
            continue
        if dry_run:
            result.previews.append(text)
            result.posted += 1
            continue
        try:
            post_id = send(creds, text)
        except XError as exc:
            if exc.rejected:
                result.rejected += 1
            else:
                result.failed += 1
            _record(conn, alert["id"], "rejected" if exc.rejected else "failed", text, error=str(exc)[:300])
            log.warning("x: alert %s not posted: %s", alert["id"], exc)
            if exc.stops_run:
                result.stopped = str(exc)[:160]
                result.left = len(queue) - i - 1
                break
            continue
        _record(conn, alert["id"], "posted", text, post_id=post_id)
        result.posted += 1
        log.info("x: posted alert %s as %s", alert["id"], post_id)
    return result


def preview(conn: sqlite3.Connection, config: Config, limit: int) -> list[tuple[int, str, str]]:
    """The posts the latest `limit` postable alerts would make, whatever their
    age or state: (alert id, kind, text). For reviewing the wording."""
    marks = ", ".join("?" for _ in POSTED_KINDS)
    rows = conn.execute(f"SELECT * FROM alerts WHERE kind IN ({marks}) ORDER BY fired_at DESC, id DESC",
                        POSTED_KINDS).fetchall()
    out = []
    for alert in rows:
        text = compose(conn, alert, config)
        if text is not None:
            out.append((alert["id"], alert["kind"], text))
        if len(out) >= limit:
            break
    return out
