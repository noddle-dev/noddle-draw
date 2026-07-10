"""FreePool — the zero-cost shared AI tier (OpenRouter ``:free`` models).

Anonymous visitors who haven't configured a BYOK key can still use the AI:
the operator sets ``OPENROUTER_POOL_KEY`` (an OpenRouter key on an account
with the one-time $10 unlock → 1,000 free-model requests/day at $0) and every
key-less AI call rides it. Because the app is anonymous and the daily quota
is SHARED, the pool fails closed behind three guards:

  * per-IP sliding-window limits (``POOL_RPM_PER_IP`` / ``POOL_RPD_PER_IP``),
  * a global daily budget (``POOL_DAILY_BUDGET``) kept under OpenRouter's
    1,000/day so the shared key never starves,
  * optional Cloudflare Turnstile (``TURNSTILE_SECRET`` set → requests must
    carry a valid ``X-Turnstile-Token``).

All counters are in-memory — the app is single-instance by design (see
CLAUDE.md), same as the collab rooms. Restart = counters reset; acceptable
for an abuse brake (the OpenRouter account itself is the hard backstop).
"""
from __future__ import annotations

import json
import os
import threading
import time
import urllib.parse
import urllib.request
from collections import deque

from app.services.ai import ProviderSettings

# Verified free (price 0) on OpenRouter as of 2026-07. A comma-separated
# FALLBACK CHAIN: free models are shared and individually rate-limited
# upstream, so the OpenRouter call carries the whole list (`models` array) and
# routes to the first one with capacity. Primary = vision + best JSON; the
# rest are text-strong alternates. POOL_MODEL env overrides (same format).
# NOTE: OpenRouter accepts at most 3 entries in the `models` array.
DEFAULT_POOL_MODEL = (
    "google/gemma-4-26b-a4b-it:free,"
    "openai/gpt-oss-120b:free,"
    "meta-llama/llama-3.3-70b-instruct:free"
)

_TURNSTILE_VERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify"


class PoolLimited(Exception):
    """A pool guard rejected the request. ``status`` is the HTTP code."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


def _int_env(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "") or default)
    except ValueError:
        return default


class FreePool:
    def __init__(self) -> None:
        self._key = (os.environ.get("OPENROUTER_POOL_KEY") or "").strip()
        self._model = (os.environ.get("POOL_MODEL") or DEFAULT_POOL_MODEL).strip()
        self.rpm_per_ip = _int_env("POOL_RPM_PER_IP", 3)
        self.rpd_per_ip = _int_env("POOL_RPD_PER_IP", 10)
        self.daily_budget = _int_env("POOL_DAILY_BUDGET", 800)
        self._turnstile_secret = (os.environ.get("TURNSTILE_SECRET") or "").strip()
        self.turnstile_site_key = (os.environ.get("TURNSTILE_SITE_KEY") or "").strip()
        self._lock = threading.Lock()
        self._minute: dict[str, deque[float]] = {}
        self._day: dict[str, int] = {}  # per-IP count for the current day
        self._day_stamp = self._today()
        self._spent = 0  # global requests today

    # ---- config ----------------------------------------------------------
    def available(self) -> bool:
        return bool(self._key)

    def settings(self) -> ProviderSettings:
        return ProviderSettings(provider="openrouter", api_key=self._key, model=self._model)

    # ---- guards ----------------------------------------------------------
    @staticmethod
    def _today() -> str:
        return time.strftime("%Y-%m-%d", time.gmtime())

    def _roll_day(self) -> None:
        today = self._today()
        if today != self._day_stamp:
            self._day_stamp = today
            self._day.clear()
            self._spent = 0
            # Also drop the per-minute deques so the map doesn't grow one entry
            # per IP ever seen (they'd otherwise only empty, never disappear).
            self._minute.clear()

    def check(self, ip: str, turnstile_token: str | None) -> None:
        """Admit or reject one pool request. Raises :class:`PoolLimited`."""
        if self._turnstile_secret and not self._verify_turnstile(turnstile_token):
            raise PoolLimited(
                403,
                "Human check failed for the free AI tier — reload the page and "
                "try again, or add your own API key in AI settings.",
            )
        ip = ip or "unknown"
        now = time.time()
        with self._lock:
            self._roll_day()
            if self._spent >= self.daily_budget:
                raise PoolLimited(
                    503,
                    "The free shared AI quota is used up for today — add your "
                    "own (free) API key in AI settings to keep going.",
                )
            if self._day.get(ip, 0) >= self.rpd_per_ip:
                raise PoolLimited(
                    429,
                    f"You've used today's {self.rpd_per_ip} free AI requests — "
                    "add your own (free) API key in AI settings for unlimited use.",
                )
            window = self._minute.setdefault(ip, deque())
            while window and now - window[0] > 60:
                window.popleft()
            if len(window) >= self.rpm_per_ip:
                raise PoolLimited(
                    429,
                    "Slow down a little — the free tier allows "
                    f"{self.rpm_per_ip} AI requests per minute.",
                )
            window.append(now)
            self._day[ip] = self._day.get(ip, 0) + 1
            self._spent += 1

    def _verify_turnstile(self, token: str | None) -> bool:
        if not token:
            return False
        try:
            data = urllib.parse.urlencode(
                {"secret": self._turnstile_secret, "response": token}
            ).encode()
            req = urllib.request.Request(_TURNSTILE_VERIFY, data=data)
            with urllib.request.urlopen(req, timeout=10) as res:
                return bool(json.loads(res.read()).get("success"))
        except Exception:  # network hiccup → fail closed (it guards free money)
            return False
