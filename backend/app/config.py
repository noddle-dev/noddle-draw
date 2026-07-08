"""Application settings (12-factor: read from env, sensible defaults).

Paths are derived relative to the ``backend/`` package root so the app runs the
same regardless of the process working directory.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

# backend/app/config.py -> backend/
BACKEND_ROOT = Path(__file__).resolve().parent.parent
# repo root (one above backend/)
REPO_ROOT = BACKEND_ROOT.parent

_DEFAULT_ORIGINS = "http://127.0.0.1:8000,http://localhost:8000"


def _load_dotenv(path: Path) -> None:
    """Minimal KEY=VALUE .env loader (stdlib only; mirrors the companion apps).

    Uses setdefault so a real environment variable always wins over the file.
    Runs at import so os.environ is seeded before Settings/AIService read it.
    """
    if not path.exists():
        return
    for raw in path.read_text("utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, val = line.split("=", 1)
        os.environ.setdefault(key.strip(), val.strip())


_load_dotenv(REPO_ROOT / ".env")


def _default_origins() -> list[str]:
    return [
        o.strip()
        for o in os.environ.get("NODDLE_ALLOWED_ORIGINS", _DEFAULT_ORIGINS).split(",")
        if o.strip()
    ]


@dataclass
class Settings:
    """Runtime configuration."""

    storage_dir: Path = field(default_factory=lambda: BACKEND_ROOT / "storage")
    # Excalidraw-style ANONYMOUS mode (NODDLE_ANON=1): guests create boards
    # without signing in; anonymous boards get link_policy "edit" so the URL
    # itself is the sharing capability. Accounts still work alongside.
    anon_mode: bool = field(
        default_factory=lambda: os.environ.get("NODDLE_ANON", "").strip().lower()
        in ("1", "true", "yes")
    )
    allowed_origins: list[str] = field(default_factory=_default_origins)
    # Optional Postgres persistence (postgresql://user:pass@host:5432/dbname).
    # Present + reachable → Postgres adapters; absent or unreachable → file
    # adapters with a boot warning, never a crash (audit.log stays file-based).
    database_url: str | None = field(
        default_factory=lambda: os.environ.get("DATABASE_URL") or None
    )
    # Admin key for privileged team-play operations (kill a game room). Override
    # via NODDLE_ADMIN_KEY; the default suits the single-tenant LAN mockup (only
    # gates ephemeral game rooms — no document/data access).
    admin_key: str = field(default_factory=lambda: os.environ.get("NODDLE_ADMIN_KEY", "noddle-admin"))
    # ---- Lemon Squeezy billing (all optional — absent ⇒ checkout answers 503,
    # never a boot crash; the webhook rejects everything without the secret).
    lemonsqueezy_api_key: str | None = field(
        default_factory=lambda: os.environ.get("LEMONSQUEEZY_API_KEY") or None
    )
    lemonsqueezy_store_id: str | None = field(
        default_factory=lambda: os.environ.get("LEMONSQUEEZY_STORE_ID") or None
    )
    lemonsqueezy_webhook_secret: str | None = field(
        default_factory=lambda: os.environ.get("LEMONSQUEEZY_WEBHOOK_SECRET") or None
    )
    # Variant ids of the three paid plans (see the landing page tiers).
    lemonsqueezy_variant_pro_monthly: str | None = field(
        default_factory=lambda: os.environ.get("LEMONSQUEEZY_VARIANT_ID_PRO_MONTHLY") or None
    )
    lemonsqueezy_variant_pro_yearly: str | None = field(
        default_factory=lambda: os.environ.get("LEMONSQUEEZY_VARIANT_ID_PRO_YEARLY") or None
    )
    lemonsqueezy_variant_team_yearly: str | None = field(
        default_factory=lambda: os.environ.get("LEMONSQUEEZY_VARIANT_ID_TEAM_YEARLY") or None
    )
    # ---- S3-compatible object storage (Cloudflare R2 — DESIGN.md §7). All
    # optional: any missing ⇒ ObjectStorage.enabled is False and log-segment
    # shipping silently stays local-only (graceful degradation, as with AI).
    s3_endpoint_url: str | None = field(
        default_factory=lambda: os.environ.get("S3_ENDPOINT_URL") or None
    )
    s3_bucket: str | None = field(
        default_factory=lambda: os.environ.get("S3_BUCKET") or None
    )
    s3_access_key_id: str | None = field(
        default_factory=lambda: os.environ.get("S3_ACCESS_KEY_ID") or None
    )
    s3_secret_access_key: str | None = field(
        default_factory=lambda: os.environ.get("S3_SECRET_ACCESS_KEY") or None
    )
    s3_region: str = field(default_factory=lambda: os.environ.get("S3_REGION", "auto"))
    # Preferred SPA build output; falls back to the vanilla frontend when absent.
    web_dist: Path = field(default_factory=lambda: REPO_ROOT / "web" / "dist")
    frontend_dir: Path = field(default_factory=lambda: REPO_ROOT / "frontend")

    def frontend_path(self) -> Path | None:
        """The static dir to serve: built SPA if present, else vanilla frontend,
        else ``None`` (no frontend available)."""
        if self.web_dist.exists():
            return self.web_dist
        if self.frontend_dir.exists():
            return self.frontend_dir
        return None
