"""Configuration: config.yaml + environment secrets."""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CONFIG_FILE = REPO_ROOT / "config.yaml"
DEFAULT_DB_PATH = REPO_ROOT / "data" / "trades.sqlite3"

DEFAULT_CLUSTER_ASSET_TYPES = ["ST", "OP", "EF", "ET", "CT", "RS", "SA"]


# More than one lowest-bracket ($1,001–$15,000) trade. 83% of equity-like
# rows sit in that bracket, so a member whose bracket floors in the window add
# up to less than this is trading at the base rate, not converging on anything.
DEFAULT_MIN_MEMBER_FLOOR_USD = 15_001


@dataclass
class AlertSettings:
    # 90 days, not 30: the window is on trade date and must absorb the
    # STOCK Act's 45-day disclosure deadline. See config.yaml.
    window_days: int = 90
    # A cluster must clear BOTH of these. Either alone is base rate: see
    # config.yaml for the measured alert history behind that.
    min_politicians: int = 3
    min_volume_usd: int = 500_000
    # A member counts towards min_politicians only if the FLOORS of their
    # brackets in the window — never the midpoints, which are estimates — sum
    # to at least this. 0 turns the control off.
    min_member_floor_usd: int = DEFAULT_MIN_MEMBER_FLOOR_USD
    cluster_asset_types: list[str] = field(
        default_factory=lambda: list(DEFAULT_CLUSTER_ASSET_TYPES)
    )

    @property
    def min_volume_cents(self) -> int:
        return self.min_volume_usd * 100

    @property
    def min_member_floor_cents(self) -> int:
        return self.min_member_floor_usd * 100


@dataclass
class IngestSettings:
    years: list[int] = field(default_factory=lambda: [2026])
    # 14, not 7: the Clerk's index lags the filing date by up to a week in the
    # observed corpus, and a filing older than this on first sight is history,
    # never announced. See config.yaml for the measurements.
    max_filing_age_days: int = 14


# What a rule may say. Anything else is a typo, and a typo that silently
# never matches is worse than a crash at startup.
RULE_KEYS = frozenset({
    "name", "kind", "direction", "min_value_usd", "roles", "titles",
    "exclude_10b5_1", "require_10b5_1", "min_insiders", "window_days",
})
RULE_KINDS = frozenset({"filing", "cluster"})
RULE_DIRECTIONS = frozenset({"buy", "sell", "any"})
RULE_ROLES = frozenset({"director", "officer", "ten_percent_owner", "other"})


class ConfigError(ValueError):
    """config.yaml says something this code cannot honour."""


@dataclass
class InsiderRule:
    """One alert criterion, as written in config.yaml.

    A `filing` rule is evaluated against each newly stored Form 4: the
    conditions describe one direction's open-market trades within that filing.
    A `cluster` rule is evaluated against issuers where several insiders
    traded the same way inside a window. Rules are tried in order and the
    first match names the alert, so put the specific ones first.
    """

    name: str
    kind: str = "filing"
    direction: str = "any"
    min_value_usd: int = 0
    # Empty means "any" for both: a rule that lists no roles does not care.
    roles: list[str] = field(default_factory=list)
    # Case-insensitive substrings matched against the officer title as filed.
    titles: list[str] = field(default_factory=list)
    exclude_10b5_1: bool = False
    require_10b5_1: bool = False
    # Cluster rules only.
    min_insiders: int = 3
    window_days: int | None = None

    @property
    def min_value_cents(self) -> int:
        return self.min_value_usd * 100

    def wants(self, direction: str) -> bool:
        return self.direction in ("any", direction)


def _parse_rule(raw: dict, index: int) -> InsiderRule:
    where = f"insiders.alerts[{index}]"
    if not isinstance(raw, dict):
        raise ConfigError(f"{where} must be a mapping, not {type(raw).__name__}")
    unknown = set(raw) - RULE_KEYS
    if unknown:
        raise ConfigError(
            f"{where} has unknown key(s) {sorted(unknown)}; "
            f"allowed: {sorted(RULE_KEYS)}"
        )
    name = str(raw.get("name") or "").strip()
    if not name:
        raise ConfigError(f"{where} needs a name — it is what the alert is called")

    kind = str(raw.get("kind", "filing")).lower()
    if kind not in RULE_KINDS:
        raise ConfigError(f"{where} kind {kind!r} must be one of {sorted(RULE_KINDS)}")
    direction = str(raw.get("direction", "any")).lower()
    if direction not in RULE_DIRECTIONS:
        raise ConfigError(
            f"{where} direction {direction!r} must be one of {sorted(RULE_DIRECTIONS)}")
    roles = [str(r).lower() for r in (raw.get("roles") or [])]
    bad_roles = set(roles) - RULE_ROLES
    if bad_roles:
        raise ConfigError(f"{where} role(s) {sorted(bad_roles)} unknown; "
                          f"allowed: {sorted(RULE_ROLES)}")
    rule = InsiderRule(
        name=name,
        kind=kind,
        direction=direction,
        min_value_usd=int(raw.get("min_value_usd", 0)),
        roles=roles,
        titles=[str(t).lower() for t in (raw.get("titles") or [])],
        exclude_10b5_1=bool(raw.get("exclude_10b5_1", False)),
        require_10b5_1=bool(raw.get("require_10b5_1", False)),
        min_insiders=int(raw.get("min_insiders", 3)),
        window_days=(None if raw.get("window_days") is None else int(raw["window_days"])),
    )
    if rule.exclude_10b5_1 and rule.require_10b5_1:
        raise ConfigError(f"{where} cannot both require and exclude the 10b5-1 flag")
    if rule.kind == "cluster" and (rule.roles or rule.titles):
        # A cluster is counted per issuer across filings, so a per-person
        # condition has nothing to attach to. Say so rather than ignore it.
        raise ConfigError(
            f"{where} is a cluster rule, so roles/titles do not apply — "
            "they describe one filer, and a cluster spans several")
    return rule


def _refire_growth(raw) -> float:
    """The cluster re-fire factor, which must be able to damp anything.

    Below 1.0 the growth test collapses into "one more insider" — the old
    every-poll behaviour — but reads in config.yaml as if it were tuned. That
    is exactly the silent no-op this project refuses to ship, so it raises.
    """
    try:
        value = float(raw)
    except (TypeError, ValueError):
        raise ConfigError(
            f"insiders.cluster_refire_growth must be a number, not {raw!r}") from None
    if value < 1.0:
        raise ConfigError(
            f"insiders.cluster_refire_growth is {value}; it must be at least 1.0 "
            "(1.0 = re-fire on every extra insider, 1.5 = only when half as "
            "many again have joined)")
    return value


def _member_floor(raw) -> int:
    """The per-member bracket floor, a whole number of dollars, 0 or more.

    A negative value would admit every member — one whose window holds a
    single $1,001 trade included — while reading in config.yaml as if it were
    tuned. That is the silent no-op this project refuses to ship, so it raises.
    """
    try:
        value = int(raw)
    except (TypeError, ValueError):
        raise ConfigError(
            f"alerts.min_member_floor_usd must be a whole number of dollars, "
            f"not {raw!r}") from None
    if value < 0:
        raise ConfigError(
            f"alerts.min_member_floor_usd is {value}; it must be 0 (off) or more")
    return value
def _budget_seconds(raw) -> float:
    """`insiders.gap_repair_budget_seconds`: seconds per poll run, or 0 for off.

    A negative budget means nothing, yet would sit in config.yaml looking
    like a setting. That is the silent no-op this project refuses, so it
    raises.
    """
    try:
        value = float(raw)
    except (TypeError, ValueError):
        raise ConfigError(
            f"insiders.gap_repair_budget_seconds must be a number, not {raw!r}") from None
    if value < 0:
        raise ConfigError(
            f"insiders.gap_repair_budget_seconds is {value}; it must be 0 (automatic "
            "gap repair off) or a number of seconds")
    return value


@dataclass
class InsiderSettings:
    """SEC Form 4 ingestion. See config.yaml for the reasoning behind each."""

    enabled: bool = True
    # Only filings whose open-market buys or sells sum to at least this much
    # in one direction are stored. ~420 Form 4s a day; this is the knob that
    # keeps the git-committed database sane.
    min_trade_usd: int = 50_000
    # 30 days, not 90: Form 4 is due two business days after the trade, so a
    # trade-date window has no reporting lag to absorb.
    cluster_window_days: int = 30
    min_insiders: int = 3
    # How much bigger a cluster must get before it is worth reporting again.
    # 1.5 = "half as many insiders again". Form 4's two-day deadline makes a
    # coordinated purchase arrive as a burst, so +1 insider per poll is the
    # normal shape of one event, not news. See stats.is_new_insider_cluster.
    cluster_refire_growth: float = 1.5
    # A filing older than this on first sight is history, never a
    # notification: it stops a backlog being replayed into Telegram.
    max_filing_age_days: int = 7
    # How long one poll run may spend walking the daily index to repair a
    # recorded feed gap, after the live feed has been read. 0 switches the
    # automatic repair off and leaves the gap to `backfill-insiders`.
    gap_repair_budget_seconds: float = 480
    # No rules means no insider alerts, which is the safe default: an absent
    # config block must never start sending.
    alerts: list[InsiderRule] = field(default_factory=list)

    @property
    def min_trade_cents(self) -> int:
        return self.min_trade_usd * 100

    @property
    def alerting(self) -> bool:
        return bool(self.alerts)

    def rules_of_kind(self, kind: str) -> list[InsiderRule]:
        return [r for r in self.alerts if r.kind == kind]


# What a watchlist entry may say. Same contract as the insider rules: an
# unrecognised key is a typo, and a typo here would silently watch nobody.
WATCH_KEYS = frozenset({"name", "bioguide_id", "every_trade"})


@dataclass
class WatchedMember:
    """A member whose trades are worth an immediate, individual alert."""

    name: str
    bioguide_id: str | None = None
    # Off would mean "watch but say nothing", which is what an absent entry
    # already does; it exists so the intent is explicit in config.yaml.
    every_trade: bool = True

    def matches(self, bioguide_id: str | None, filer_name: str | None) -> bool:
        """Whether this filing is theirs.

        The bioguide ID is authoritative when the roster matched the filing.
        The name is a fallback for when it did not: an unmatched filing still
        carries the name printed on the PDF, and a watched member going
        unreported because the roster missed them is the failure this is for.
        """
        if self.bioguide_id and bioguide_id:
            return self.bioguide_id.upper() == bioguide_id.upper()
        return bool(filer_name) and _normalise_name(filer_name) == _normalise_name(self.name)


def _normalise_name(name: str) -> str:
    # Filings print "Hon. Nancy Pelosi" and "Nancy  Pelosi" alike.
    cleaned = re.sub(r"\b(hon|mr|mrs|ms|dr)\.?\s+", "", name.strip(), flags=re.I)
    return " ".join(cleaned.lower().replace(".", " ").split())


@dataclass
class WatchlistSettings:
    """Members flagged for per-trade alerting. Empty means the feature is off."""

    members: list[WatchedMember] = field(default_factory=list)

    @property
    def active(self) -> bool:
        return any(m.every_trade for m in self.members)

    def match(self, bioguide_id: str | None,
              filer_name: str | None) -> WatchedMember | None:
        for m in self.members:
            if m.every_trade and m.matches(bioguide_id, filer_name):
                return m
        return None


def _parse_watch(raw: dict, index: int) -> WatchedMember:
    where = f"watchlist[{index}]"
    if not isinstance(raw, dict):
        raise ConfigError(f"{where} must be a mapping, not {type(raw).__name__}")
    unknown = set(raw) - WATCH_KEYS
    if unknown:
        raise ConfigError(
            f"{where} has unknown key(s) {sorted(unknown)}; allowed: {sorted(WATCH_KEYS)}")
    name = str(raw.get("name") or "").strip()
    if not name:
        raise ConfigError(
            f"{where} needs a name — it identifies the member and labels the alert")
    bioguide = raw.get("bioguide_id")
    bioguide = str(bioguide).strip().upper() if bioguide else None
    if bioguide and not re.fullmatch(r"[A-Z]\d{6}", bioguide):
        # A malformed ID would fall through to the name match and look like it
        # worked, which hides the typo until someone checks why alerts differ.
        raise ConfigError(
            f"{where} bioguide_id {bioguide!r} is not a bioguide ID "
            "(a letter followed by six digits, e.g. P000197)")
    return WatchedMember(name=name, bioguide_id=bioguide,
                         every_trade=bool(raw.get("every_trade", True)))


@dataclass
class Config:
    alerts: AlertSettings = field(default_factory=AlertSettings)
    ingest: IngestSettings = field(default_factory=IngestSettings)
    insiders: InsiderSettings = field(default_factory=InsiderSettings)
    watchlist: WatchlistSettings = field(default_factory=WatchlistSettings)
    senate_enabled: bool = True
    # Scanned-PDF transcription is opt-in; see config.yaml for the measured
    # accuracy that makes it off by default.
    vision_enabled: bool = False
    db_path: Path = DEFAULT_DB_PATH
    # Public URL of the dashboard, for links in messages. None means the
    # links are relative paths: still the right page, just not clickable.
    dashboard_url: str | None = None

    # Secrets from environment.
    telegram_bot_token: str | None = None
    telegram_chat_id: str | None = None
    gemini_api_key: str | None = None
    senate_proxy_url: str | None = None
    # SEC requires "<project> <contact e-mail>"; without it EDGAR serves an
    # HTML refusal page instead of filings, so the insider step skips itself.
    edgar_user_agent: str | None = None

    @property
    def telegram_configured(self) -> bool:
        return bool(self.telegram_bot_token and self.telegram_chat_id)

    @property
    def insiders_configured(self) -> bool:
        return bool(self.edgar_user_agent and self.edgar_user_agent.strip())


def _env(name: str) -> str | None:
    """An optional secret from the environment; blank means unset.

    GitHub Actions passes an undefined secret as an empty string, and "" is
    not "no proxy": `httpx.Client(proxy="")` raises before any request is
    made, which was recorded as a Senate failure on every run (#16).
    """
    value = os.environ.get(name)
    if value is None or not value.strip():
        return None
    return value


def load_config(config_file: Path = DEFAULT_CONFIG_FILE,
                db_path: Path = DEFAULT_DB_PATH) -> Config:
    raw = {}
    if config_file.exists():
        raw = yaml.safe_load(config_file.read_text()) or {}

    a = raw.get("alerts") or {}
    alerts = AlertSettings(
        window_days=int(a.get("window_days", 90)),
        min_politicians=int(a.get("min_politicians", 3)),
        min_volume_usd=int(a.get("min_volume_usd", 500_000)),
        min_member_floor_usd=_member_floor(
            a.get("min_member_floor_usd", DEFAULT_MIN_MEMBER_FLOOR_USD)),
        cluster_asset_types=[
            str(t).upper()
            for t in (a.get("cluster_asset_types") or DEFAULT_CLUSTER_ASSET_TYPES)
        ],
    )

    i = raw.get("ingest") or {}
    ingest = IngestSettings(
        years=[int(y) for y in (i.get("years") or [2026])],
        max_filing_age_days=int(i.get("max_filing_age_days", 14)),
    )

    n = raw.get("insiders") or {}
    insiders = InsiderSettings(
        enabled=bool(n.get("enabled", True)),
        min_trade_usd=int(n.get("min_trade_usd", 50_000)),
        cluster_window_days=int(n.get("cluster_window_days", 30)),
        min_insiders=int(n.get("min_insiders", 3)),
        cluster_refire_growth=_refire_growth(n.get("cluster_refire_growth", 1.5)),
        max_filing_age_days=int(n.get("max_filing_age_days", 7)),
        gap_repair_budget_seconds=_budget_seconds(n.get("gap_repair_budget_seconds", 480)),
        alerts=[_parse_rule(r, i) for i, r in enumerate(n.get("alerts") or [])],
    )

    watchlist = WatchlistSettings(
        members=[_parse_watch(w, i) for i, w in enumerate(raw.get("watchlist") or [])])

    dashboard_url = str((raw.get("dashboard") or {}).get("url") or "").strip().rstrip("/") or None

    return Config(
        alerts=alerts,
        ingest=ingest,
        insiders=insiders,
        watchlist=watchlist,
        senate_enabled=bool((raw.get("senate") or {}).get("enabled", True)),
        vision_enabled=bool((raw.get("vision") or {}).get("enabled", False)),
        db_path=db_path,
        dashboard_url=dashboard_url,
        telegram_bot_token=_env("TELEGRAM_BOT_TOKEN"),
        telegram_chat_id=_env("TELEGRAM_CHAT_ID"),
        gemini_api_key=_env("GEMINI_API_KEY"),
        senate_proxy_url=_env("SENATE_PROXY_URL"),
        edgar_user_agent=_env("EDGAR_USER_AGENT"),
    )
