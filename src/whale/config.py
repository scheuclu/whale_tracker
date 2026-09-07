"""Configuration: config.yaml + environment secrets."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CONFIG_FILE = REPO_ROOT / "config.yaml"
DEFAULT_DB_PATH = REPO_ROOT / "data" / "trades.sqlite3"

DEFAULT_CLUSTER_ASSET_TYPES = ["ST", "OP", "EF", "ET", "CT", "RS", "SA"]


@dataclass
class AlertSettings:
    # 90 days, not 30: the window is on trade date and must absorb the
    # STOCK Act's 45-day disclosure deadline. See config.yaml.
    window_days: int = 90
    min_politicians: int = 3
    min_volume_usd: int = 500_000
    cluster_asset_types: list[str] = field(
        default_factory=lambda: list(DEFAULT_CLUSTER_ASSET_TYPES)
    )

    @property
    def min_volume_cents(self) -> int:
        return self.min_volume_usd * 100


@dataclass
class IngestSettings:
    years: list[int] = field(default_factory=lambda: [2026])
    max_filing_age_days: int = 7


@dataclass
class Config:
    alerts: AlertSettings = field(default_factory=AlertSettings)
    ingest: IngestSettings = field(default_factory=IngestSettings)
    senate_enabled: bool = True
    # Scanned-PDF transcription is opt-in; see config.yaml for the measured
    # accuracy that makes it off by default.
    vision_enabled: bool = False
    db_path: Path = DEFAULT_DB_PATH

    # Secrets from environment.
    telegram_bot_token: str | None = None
    telegram_chat_id: str | None = None
    gemini_api_key: str | None = None
    senate_proxy_url: str | None = None

    @property
    def telegram_configured(self) -> bool:
        return bool(self.telegram_bot_token and self.telegram_chat_id)


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
        cluster_asset_types=[
            str(t).upper()
            for t in (a.get("cluster_asset_types") or DEFAULT_CLUSTER_ASSET_TYPES)
        ],
    )

    i = raw.get("ingest") or {}
    ingest = IngestSettings(
        years=[int(y) for y in (i.get("years") or [2026])],
        max_filing_age_days=int(i.get("max_filing_age_days", 7)),
    )

    return Config(
        alerts=alerts,
        ingest=ingest,
        senate_enabled=bool((raw.get("senate") or {}).get("enabled", True)),
        vision_enabled=bool((raw.get("vision") or {}).get("enabled", False)),
        db_path=db_path,
        telegram_bot_token=os.environ.get("TELEGRAM_BOT_TOKEN"),
        telegram_chat_id=os.environ.get("TELEGRAM_CHAT_ID"),
        gemini_api_key=os.environ.get("GEMINI_API_KEY"),
        senate_proxy_url=os.environ.get("SENATE_PROXY_URL"),
    )
