"""ActivityService — last-active tracking for users (WS3, admin activity).

A tiny file-backed map ``storage/activity.json``::

    {"<user_id>": {"last_active_at": 1751700000.0}, ...}

``touch(user_id)`` is called from an HTTP middleware on every authenticated
request, so it must be CHEAP and must never break a request:

* writes are throttled — a touch within ``THROTTLE_SECONDS`` of the stored
  value is a no-op decided from an in-memory cache (no disk read per request);
* the file is written atomically (``infrastructure/atomic.atomic_write_text``)
  so a crash mid-write can't corrupt the store;
* every failure path swallows OSError/ValueError (activity tracking is
  best-effort telemetry, never a request blocker).

``last_login_at`` deliberately does NOT live here: it is derived lazily from
the audit log's newest ``auth.login`` / ``auth.register`` / ``auth.sso`` event
per user at read time (api/activity.py), so no login code had to change.
"""
from __future__ import annotations

import json
import threading
import time
from collections.abc import Callable
from pathlib import Path

from app.infrastructure.atomic import atomic_write_text
from app.services.auth import AuthError, AuthService, Forbidden, Principal

THROTTLE_SECONDS = 300.0  # ≥ 5 min between disk writes per user


class ActivityService:
    def __init__(
        self,
        storage_dir: Path,
        throttle: float = THROTTLE_SECONDS,
        store: object | None = None,
    ) -> None:
        # ``store`` (a PgActivityStore) is the production DB backend; the JSON
        # file below is the local-dev fallback (2026-07-06 "no local files"
        # rule). The in-memory throttle cache is used regardless of backend.
        self._path = Path(storage_dir) / "activity.json"
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._throttle = float(throttle)
        self._lock = threading.Lock()
        self._store = store
        # user_id -> last_active_at as last WRITTEN (lazily seeded from disk).
        self._cache: dict[str, float] | None = None

    # ---- internals -----------------------------------------------------------
    def _load(self) -> dict[str, dict]:
        """The on-disk map (empty on missing/corrupt file — never raises)."""
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def _ensure_cache(self) -> dict[str, float]:
        if self._cache is None:
            self._cache = {
                uid: float(rec["last_active_at"])
                for uid, rec in self._load().items()
                if isinstance(rec, dict)
                and isinstance(rec.get("last_active_at"), (int, float))
            }
        return self._cache

    # ---- API -----------------------------------------------------------------
    def touch(self, user_id: str, now: float | None = None) -> bool:
        """Record that ``user_id`` is active. Returns True when a write
        happened, False when throttled (< throttle since the stored value).
        The throttle check reads only the in-memory cache — no disk I/O on
        the hot path."""
        if not user_id:
            return False
        now = time.time() if now is None else now
        with self._lock:
            cache = self._ensure_cache()
            last = cache.get(user_id)
            if last is not None and (now - last) < self._throttle:
                return False
            try:
                if self._store is not None:
                    self._store.touch(user_id, now)
                else:
                    data = self._load()
                    rec = data.get(user_id)
                    rec = dict(rec) if isinstance(rec, dict) else {}
                    rec["last_active_at"] = now
                    data[user_id] = rec
                    atomic_write_text(
                        self._path, json.dumps(data, ensure_ascii=False, indent=0)
                    )
            except Exception:  # noqa: BLE001 — best-effort, never break the request
                return False
            cache[user_id] = now
            return True

    def last_active_at(self, user_id: str) -> float | None:
        if self._store is not None:
            try:
                return self._store.last_active_at(user_id)
            except Exception:  # noqa: BLE001
                return None
        with self._lock:
            return self._ensure_cache().get(user_id)


# ---------------------------------------------------------------------------
# Team activity view helpers (WS3) — service-layer so they stay unit-testable
# without importing the FastAPI routers (the api/ modules pull in pydantic
# request models). api/activity.py maps AuthError → 401 and Forbidden → 403.
# ---------------------------------------------------------------------------


def require_team_admin(
    principal: Principal, team_id: str, auth: AuthService
) -> None:
    """The WS3 admin gate: signed-in USER + admin role on this team.

    Raises ``AuthError`` for anyone unauthenticated (→ 401) and ``Forbidden``
    otherwise — including unknown teams, so a non-admin can't probe which
    team ids exist (→ 403).
    """
    if principal.kind != "user" or not principal.user_id:
        raise AuthError("You must be signed in.")
    if auth.team_role(principal.user_id, team_id) != "admin":
        raise Forbidden("Only a team admin can view team activity.")


def build_team_filter(
    team_id: str,
    member_ids: frozenset[str] | set[str],
    doc_team: Callable[[str], str | None],
) -> Callable[[dict], bool]:
    """Predicate deciding whether one audit entry belongs to a team's trail.

    An entry matches when it is stamped with the team's id (new writes may
    carry ``team_id``), when its ``doc_id`` resolves to a board of that team
    (``doc_team``: doc_id → meta.team_id, None for unknown/teamless), or when
    its actor is a current team member. ``auth.*`` lifecycle events are always
    excluded — the team trail is board + share + membership activity, not a
    login surveillance feed.
    """

    def _match(ev: dict) -> bool:
        action = str(ev.get("action") or "")
        if action.startswith("auth."):
            return False
        if ev.get("team_id") == team_id:
            return True
        doc_id = ev.get("doc_id")
        if doc_id and doc_team(str(doc_id)) == team_id:
            return True
        actor_id = ev.get("actor_id")
        return bool(actor_id) and actor_id in member_ids

    return _match
