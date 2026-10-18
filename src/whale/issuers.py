"""Industry classification of issuers from EDGAR's SIC codes (#55).

Every leaderboard in the tracker is per ticker. "Which sectors is a member
buying" and "which industries see insider selling" need one more fact per
issuer: its Standard Industrial Classification code, which EDGAR assigns to
every filer and publishes in two free, unauthenticated places:

* ``company_tickers.json`` — every listed symbol with its CIK, one request.
  Symbols are in EDGAR's hyphen form (``BRK-B``); House and Senate filings
  print the dot form (``BRK.B``), so lookups try both.
* ``submissions/CIK##########.json`` — one request per CIK, carrying
  ``sic``, ``sicDescription`` and the issuer's listed tickers. Form 4
  filings already name the issuer CIK, so insider issuers skip the symbol
  lookup altogether.

Two tables (`db._ISSUER_DDL`): ``issuers`` is one row per CIK — the EDGAR
entity, with its SIC and the group derived from it — and ``issuer_tickers``
is the symbol → CIK resolution, including the symbols EDGAR does not list, so
an unknown ticker is recorded as unknown and not asked about again until the
weekly refresh. Both joins the dashboard needs are therefore one-to-one:
``transactions.ticker → issuer_tickers → issuers`` and
``insider_filings.issuer_cik → issuers``. A CIK with several symbols
(Berkshire's BRK.A and BRK.B) is one issuer with two ticker rows.

The fill runs inside the poll run, after the insider sync, under its own
time budget (``issuers.budget_seconds``), through ``edgar.EdgarClient`` so
SEC's rate ceiling and User-Agent rule hold across both steps. Progress is
committed per issuer; a run that stops on the budget or a throttle has
finished everything it wrote and continues next time. Never-fetched issuers
go first, then the stalest, so the weekly refresh cannot starve a new
symbol. Nothing here raises into the pipeline.

The SIC → group mapping
-----------------------

SIC's own divisions (Manufacturing is 2000–3999) are too coarse to answer the
question, so the four-digit codes are folded into twelve groups that follow
the familiar sector vocabulary. The table below is the whole mapping;
``_SIC_RANGES`` is its code. Carve-outs are listed before the division they
sit inside, and the first matching range wins.

===========================  ===========================================================
Group                        SIC ranges
===========================  ===========================================================
Energy                       1300–1399 oil & gas extraction and services; 2900–2999
                             petroleum refining; 4610–4619 pipelines
Materials                    1000–1299 metal and coal mining; 1400–1499 quarrying;
                             2400–2499 lumber; 2600–2699 paper; 2800–2899 chemicals
                             (less drugs and cosmetics); 3000–3099 rubber and plastics
                             (less tyres); 3200–3399 glass, stone, primary metals
Industrials                  1500–1799 construction; 3400–3599 fabricated metal and
                             machinery (less computers); 3600–3699 electrical
                             equipment (less appliances, electronics); 3700–3799
                             aerospace, rail, ships, defence (less autos); 3800–3899
                             instruments (less medical, measuring); 4000–4799
                             transport (less pipelines); 5000–5199 wholesale (less
                             food, drugs, medical); 7300–7399 business services (less
                             software); 8100–8999 professional services (less
                             education, biological research)
Consumer discretionary       2200–2399 textiles and apparel; 2500–2599 furniture;
                             3011 tyres; 3100–3199 leather; 3630–3639 appliances;
                             3651–3652 home audio; 3711–3716 motor vehicles;
                             3750–3751 motorcycles; 3900–3999 toys, jewellery, misc
                             manufacturing; 5200–5999 retail (less food and drug
                             stores); 7000–7099 hotels; 7200–7299 personal services;
                             7500–7699 repair; 7800–7999 recreation (less film);
                             8200–8299 education
Consumer staples             0100–0999 agriculture; 2000–2199 food, drink, tobacco;
                             2840–2844 soap and cosmetics; 5140–5149, 5180–5182 food
                             and drink wholesale; 5400–5499 food stores; 5912 drug
                             stores
Health care                  2830–2836 drugs and biologicals; 3840–3851 medical
                             instruments and supplies; 5047 medical wholesale; 5122
                             drug wholesale; 8000–8099 health services; 8731
                             commercial physical and biological research (where
                             EDGAR files much of biotech)
Financials                   6000–6799 banks, brokers, insurance, holding companies,
                             blank checks (less real estate)
Real estate                  6500–6599 real estate; 6798 REITs
Technology                   3570–3579 computers and storage; 3660–3679 communications
                             equipment, components, semiconductors; 3820–3829
                             measuring instruments; 3860–3861 photographic;
                             7370–7379 software and data processing
Communication                2700–2799 publishing; 4800–4899 telephone, broadcasting,
                             cable; 7810–7849 film and video
Utilities                    4900–4999 electric, gas, water, sanitary
Other                        any other code: 9000–9999 public administration and
                             non-operating shells, and anything unforeseen
===========================  ===========================================================

An issuer with no SIC at all — ETF trusts and many funds — has no group and
stays unknown; the dashboard says "unclassified" and counts it, rather than
inventing a sector for it.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import time
from dataclasses import dataclass
from datetime import date, timedelta

import httpx

from . import db
from .config import Config
from .edgar import USER_AGENT_ENV, EdgarClient, EdgarThrottled

log = logging.getLogger(__name__)

COMPANY_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"
SUBMISSIONS_URL = "https://data.sec.gov/submissions/CIK{cik}.json"

STATE_STATUS = "issuers_status"
DEFAULT_BUDGET_SECONDS = 90.0
DEFAULT_REFRESH_DAYS = 7

GROUP_ENERGY = "Energy"
GROUP_MATERIALS = "Materials"
GROUP_INDUSTRIALS = "Industrials"
GROUP_DISCRETIONARY = "Consumer discretionary"
GROUP_STAPLES = "Consumer staples"
GROUP_HEALTH = "Health care"
GROUP_FINANCIALS = "Financials"
GROUP_REAL_ESTATE = "Real estate"
GROUP_TECHNOLOGY = "Technology"
GROUP_COMMUNICATION = "Communication"
GROUP_UTILITIES = "Utilities"
GROUP_OTHER = "Other"

GROUPS = (
    GROUP_ENERGY, GROUP_MATERIALS, GROUP_INDUSTRIALS, GROUP_DISCRETIONARY,
    GROUP_STAPLES, GROUP_HEALTH, GROUP_FINANCIALS, GROUP_REAL_ESTATE,
    GROUP_TECHNOLOGY, GROUP_COMMUNICATION, GROUP_UTILITIES, GROUP_OTHER,
)

# (low, high, group), inclusive. Carve-outs first; the first match wins. The
# module docstring is the human-readable form of this table — keep them in step.
_SIC_RANGES: tuple[tuple[int, int, str], ...] = (
    # --- carve-outs ---------------------------------------------------------
    (2830, 2836, GROUP_HEALTH),          # drugs, diagnostics, biologicals
    (2840, 2844, GROUP_STAPLES),         # soap, detergents, cosmetics
    (3011, 3011, GROUP_DISCRETIONARY),   # tyres
    (3570, 3579, GROUP_TECHNOLOGY),      # computers, storage, peripherals
    (3630, 3639, GROUP_DISCRETIONARY),   # household appliances
    (3651, 3652, GROUP_DISCRETIONARY),   # household audio and video
    (3660, 3679, GROUP_TECHNOLOGY),      # communications equipment, components, semiconductors
    (3711, 3716, GROUP_DISCRETIONARY),   # motor vehicles, bodies, parts
    (3750, 3751, GROUP_DISCRETIONARY),   # motorcycles, bicycles
    (3820, 3829, GROUP_TECHNOLOGY),      # measuring and controlling instruments
    (3840, 3851, GROUP_HEALTH),          # medical, dental, x-ray, ophthalmic
    (3860, 3861, GROUP_TECHNOLOGY),      # photographic equipment
    (4610, 4619, GROUP_ENERGY),          # pipelines
    (5047, 5047, GROUP_HEALTH),          # medical equipment wholesale
    (5122, 5122, GROUP_HEALTH),          # drug wholesale
    (5140, 5149, GROUP_STAPLES),         # groceries wholesale
    (5180, 5182, GROUP_STAPLES),         # beer, wine, spirits wholesale
    (5400, 5499, GROUP_STAPLES),         # food stores
    (5912, 5912, GROUP_STAPLES),         # drug stores
    (6500, 6599, GROUP_REAL_ESTATE),     # real estate operators, agents, developers
    (6798, 6798, GROUP_REAL_ESTATE),     # REITs
    (7370, 7379, GROUP_TECHNOLOGY),      # software, data processing
    (7810, 7849, GROUP_COMMUNICATION),   # motion pictures, video
    (8000, 8099, GROUP_HEALTH),          # health services
    (8200, 8299, GROUP_DISCRETIONARY),   # educational services
    (8731, 8731, GROUP_HEALTH),          # commercial physical and biological research
    # --- divisions ----------------------------------------------------------
    (100, 999, GROUP_STAPLES),           # agriculture, forestry, fishing
    (1000, 1299, GROUP_MATERIALS),       # metal mining, coal
    (1300, 1399, GROUP_ENERGY),          # oil and gas extraction and services
    (1400, 1499, GROUP_MATERIALS),       # nonmetallic minerals
    (1500, 1799, GROUP_INDUSTRIALS),     # construction
    (2000, 2199, GROUP_STAPLES),         # food, beverages, tobacco
    (2200, 2399, GROUP_DISCRETIONARY),   # textiles, apparel
    (2400, 2499, GROUP_MATERIALS),       # lumber and wood
    (2500, 2599, GROUP_DISCRETIONARY),   # furniture
    (2600, 2699, GROUP_MATERIALS),       # paper
    (2700, 2799, GROUP_COMMUNICATION),   # printing and publishing
    (2800, 2899, GROUP_MATERIALS),       # chemicals
    (2900, 2999, GROUP_ENERGY),          # petroleum refining
    (3000, 3099, GROUP_MATERIALS),       # rubber and plastics
    (3100, 3199, GROUP_DISCRETIONARY),   # leather
    (3200, 3399, GROUP_MATERIALS),       # stone, clay, glass; primary metals
    (3400, 3599, GROUP_INDUSTRIALS),     # fabricated metal; machinery
    (3600, 3699, GROUP_INDUSTRIALS),     # electrical equipment
    (3700, 3799, GROUP_INDUSTRIALS),     # aerospace, rail, ships, defence
    (3800, 3899, GROUP_INDUSTRIALS),     # instruments
    (3900, 3999, GROUP_DISCRETIONARY),   # toys, jewellery, misc manufacturing
    (4000, 4799, GROUP_INDUSTRIALS),     # transportation
    (4800, 4899, GROUP_COMMUNICATION),   # telephone, broadcasting, cable
    (4900, 4999, GROUP_UTILITIES),       # electric, gas, water, sanitary
    (5000, 5199, GROUP_INDUSTRIALS),     # wholesale
    (5200, 5999, GROUP_DISCRETIONARY),   # retail
    (6000, 6799, GROUP_FINANCIALS),      # finance and insurance
    (7000, 7099, GROUP_DISCRETIONARY),   # hotels
    (7200, 7299, GROUP_DISCRETIONARY),   # personal services
    (7300, 7399, GROUP_INDUSTRIALS),     # business services
    (7500, 7699, GROUP_DISCRETIONARY),   # repair services
    (7800, 7999, GROUP_DISCRETIONARY),   # amusement and recreation
    (8100, 8999, GROUP_INDUSTRIALS),     # legal, engineering, management
)


def sic_group(sic: str | int | None) -> str | None:
    """The industry group for a SIC code, or None when there is no code.

    A code outside every range is `Other`, never None: EDGAR assigned it and
    the mapping simply has no better word. None is reserved for an issuer
    EDGAR gives no code at all, which stays unknown.
    """
    if sic is None:
        return None
    text = str(sic).strip()
    if not text:
        return None
    try:
        code = int(text)
    except ValueError:
        return None
    for low, high, group in _SIC_RANGES:
        if low <= code <= high:
            return group
    return GROUP_OTHER


# --- the fill ----------------------------------------------------------------


@dataclass
class ClassifyResult:
    looked_up: int = 0      # symbols resolved against company_tickers.json this run
    unresolved: int = 0     # of those, not in EDGAR's list
    fetched: int = 0        # submissions fetched and stored this run
    failed: int = 0         # fetches that ended in an error recorded on the row
    remaining: int = 0      # issuers still to fetch when the run stopped
    aborted: str | None = None

    def summary(self) -> str:
        text = (f"{self.fetched} issuer(s) fetched, {self.failed} failed, "
                f"{self.remaining} to go; {self.looked_up} symbol(s) looked up, "
                f"{self.unresolved} not listed")
        if self.aborted:
            text += f"; stopped early ({self.aborted})"
        return text


def classify(conn: sqlite3.Connection, config: Config, client: EdgarClient | None = None,
             budget_seconds: float | None = None, today: date | None = None,
             clock=time.monotonic) -> ClassifyResult:
    """Resolve new symbols and fetch the SIC of every issuer that needs one.

    Issuers are every CIK a congressional ticker resolves to and every issuer
    of a stored Form 4. One is fetched when it has never been, or when its
    last fetch is older than ``issuers.refresh_days``. Never raises for the
    failures it knows about (throttling, network, a malformed response); the
    outcome is written to ``sync_state.issuers_status`` either way.
    """
    result = ClassifyResult()
    if not config.insiders_configured:
        log.warning("%s not set; skipping issuer classification", USER_AGENT_ENV)
        _set_status(conn, f"skipped: {USER_AGENT_ENV} not set")
        return result
    if budget_seconds is None:
        budget_seconds = config.issuers.budget_seconds
    today = today or date.today()
    stale_before = (today - timedelta(days=config.issuers.refresh_days)).isoformat()

    own_client = client is None
    client = client or EdgarClient(config.edgar_user_agent)
    started = clock()
    try:
        _seed_from_insider_filings(conn)
        pending_symbols = _pending_symbols(conn, stale_before)
        if pending_symbols:
            try:
                listing = fetch_company_tickers(client)
            except (EdgarThrottled, httpx.HTTPError) as exc:
                result.aborted = _abort_reason(exc)
                _finish(conn, result)
                return result
            for symbol in pending_symbols:
                cik = resolve_symbol(listing, symbol)
                db.upsert_issuer_ticker(conn, symbol, cik)
                result.looked_up += 1
                result.unresolved += cik is None
            conn.commit()

        pending = _pending_issuers(conn, stale_before)
        for index, cik in enumerate(pending):
            if clock() - started > budget_seconds:
                result.aborted = "budget"
                result.remaining = len(pending) - index
                break
            try:
                _fetch_issuer(conn, client, cik)
            except httpx.HTTPStatusError as exc:
                if exc.response.status_code != 404:
                    result.aborted = _abort_reason(exc)
                    result.remaining = len(pending) - index
                    break
                # EDGAR knows no such CIK: recorded, so it is not asked again
                # before the refresh. The ticker it came from stays unknown.
                db.upsert_issuer(conn, cik, error="not found (HTTP 404)")
                result.failed += 1
            except (EdgarThrottled, httpx.HTTPError) as exc:
                result.aborted = _abort_reason(exc)
                result.remaining = len(pending) - index
                break
            except Exception as exc:
                # A response that does not parse must not wedge the queue:
                # the row records why, and the refresh will try again.
                log.exception("issuer %s failed", cik)
                db.upsert_issuer(conn, cik, error=f"{type(exc).__name__}: {exc}"[:500])
                result.failed += 1
            else:
                result.fetched += 1
            conn.commit()
        _finish(conn, result)
    finally:
        if own_client:
            client.close()
    return result


def _seed_from_insider_filings(conn: sqlite3.Connection) -> int:
    """Form 4 filings name both the symbol and the issuer CIK, so their
    symbols need no lookup. Recorded only when the symbol is new: a
    resolution from EDGAR's own listing is never overwritten by a filer's."""
    cur = conn.execute(
        """INSERT OR IGNORE INTO issuer_tickers (ticker, cik, looked_up_at)
           SELECT DISTINCT ticker, issuer_cik, ? FROM insider_filings
           WHERE ticker IS NOT NULL AND ticker != '' AND issuer_cik IS NOT NULL""",
        (db.now_iso(),),
    )
    conn.commit()
    return cur.rowcount


def _pending_symbols(conn: sqlite3.Connection, stale_before: str) -> list[str]:
    """Congressional tickers never looked up, or unresolved and due a retry."""
    return [r["ticker"] for r in conn.execute(
        """SELECT DISTINCT t.ticker FROM transactions t
           LEFT JOIN issuer_tickers it ON it.ticker = t.ticker
           WHERE t.ticker IS NOT NULL AND t.ticker != ''
             AND (it.ticker IS NULL OR (it.cik IS NULL AND it.looked_up_at < ?))
           ORDER BY t.ticker""", (stale_before,))]


def _pending_issuers(conn: sqlite3.Connection, stale_before: str) -> list[str]:
    """CIKs to fetch: never fetched first, then the stalest."""
    return [r["cik"] for r in conn.execute(
        """WITH wanted(cik) AS (
             SELECT DISTINCT cik FROM issuer_tickers WHERE cik IS NOT NULL
             UNION
             SELECT DISTINCT issuer_cik FROM insider_filings WHERE issuer_cik IS NOT NULL
           )
           SELECT w.cik FROM wanted w LEFT JOIN issuers s ON s.cik = w.cik
           WHERE s.cik IS NULL OR s.fetched_at IS NULL OR s.fetched_at < ?
           ORDER BY s.fetched_at IS NOT NULL, s.fetched_at, w.cik""", (stale_before,))]


def _fetch_issuer(conn: sqlite3.Connection, client: EdgarClient, cik: str) -> None:
    doc = fetch_submissions(client, cik)
    sic = str(doc.get("sic") or "").strip() or None
    tickers = [str(t).strip().upper() for t in (doc.get("tickers") or []) if str(t).strip()]
    db.upsert_issuer(
        conn, cik,
        ticker=tickers[0] if tickers else None,
        name=str(doc.get("name") or "").strip() or None,
        sic=sic,
        sic_description=str(doc.get("sicDescription") or "").strip() or None,
        industry_group=sic_group(sic),
    )


def _finish(conn: sqlite3.Connection, result: ClassifyResult) -> None:
    if result.aborted and result.aborted != "budget":
        status = f"{result.aborted}; {result.remaining} issuer(s) still to fetch"
    else:
        status = (f"ok: {result.fetched} fetched, {result.failed} failed, "
                  f"{result.remaining} to go")
        if result.aborted == "budget":
            status += " (out of time; continuing next run)"
    _set_status(conn, status)
    log.info("issuers: %s", result.summary())


def _set_status(conn: sqlite3.Connection, status: str) -> None:
    db.set_state(conn, STATE_STATUS, status)
    conn.commit()


def _abort_reason(exc: Exception) -> str:
    return f"throttled: {exc}" if isinstance(exc, EdgarThrottled) else f"error: {exc}"


# --- EDGAR -------------------------------------------------------------------


def fetch_company_tickers(client: EdgarClient) -> dict[str, str]:
    """EDGAR's symbol listing as {SYMBOL: 10-digit CIK}, symbols upper-cased
    in EDGAR's hyphen form."""
    raw = client.get(COMPANY_TICKERS_URL).json()
    # {"0": {"cik_str": 320193, "ticker": "AAPL", "title": "Apple Inc."}, ...}
    entries = raw.values() if isinstance(raw, dict) else raw
    listing: dict[str, str] = {}
    for entry in entries:
        symbol = str(entry.get("ticker") or "").strip().upper()
        cik = entry.get("cik_str")
        if symbol and cik is not None:
            listing.setdefault(symbol, str(int(cik)).zfill(10))
    return listing


def resolve_symbol(listing: dict[str, str], symbol: str) -> str | None:
    """A filing's symbol against EDGAR's listing: as printed, then with the
    class-share punctuation swapped (BRK.B is EDGAR's BRK-B)."""
    sym = symbol.strip().upper()
    for candidate in (sym, sym.replace(".", "-"), sym.replace("-", ".")):
        cik = listing.get(candidate)
        if cik:
            return cik
    return None


def fetch_submissions(client: EdgarClient, cik: str) -> dict:
    """The issuer's submissions document. Raises httpx.HTTPStatusError on a
    404 so the caller can record an unknown CIK rather than retry it."""
    return client.get(SUBMISSIONS_URL.format(cik=cik.zfill(10))).json()
