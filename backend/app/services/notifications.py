"""NotificationService — the per-user 🔔 feed (share invites, etc.).

Mirrors ActivityService's shape: a ``store`` (a ``PgNotificationStore``) is the
production DB backend (2026-07-06 "persist to the database, never to local
files" rule); the JSON file below is the LOCAL-DEV fallback only. Selected by
the composition root — a pool ⇒ the DB store, no pool ⇒ file.

File shape ``storage/notifications.json``::

    {"<user_id>": [ {id, user_id, kind, ts, ...payload}, ... ], ...}

Each list is newest-last on disk and capped per user. Reads return newest
first. "Seen" state is CLIENT-side (localStorage in MentionsBell) — this
service is append + read only, like the mention feed.

Every method swallows its errors: a notification hiccup must NEVER break the
action that produced it (sharing a board must not fail because the feed did).
"""
from __future__ import annotations

import json
import threading
import time
import uuid
from pathlib import Path

from app.infrastructure.atomic import atomic_write_text

# Keep the file fallback bounded (the DB store is naturally unbounded, capped
# only at read time by ``limit``). 200 recent items per user is plenty for a
# badge feed.
_MAX_PER_USER = 200


class NotificationService:
    def __init__(self, storage_dir: Path, store: object | None = None) -> None:
        self._path = Path(storage_dir) / "notifications.json"
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._store = store
        self._lock = threading.Lock()

    # ---- file fallback helpers ----------------------------------------------
    def _load(self) -> dict[str, list[dict]]:
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    # ---- API -----------------------------------------------------------------
    def record(self, user_id: str, kind: str, **payload) -> None:
        """Append one notification for ``user_id``. Never raises."""
        if not user_id:
            return
        notif = {
            "id": uuid.uuid4().hex[:12],
            "user_id": user_id,
            "kind": kind,
            "ts": time.time(),
            **payload,
        }
        try:
            if self._store is not None:
                self._store.append(notif)
                return
            with self._lock:
                data = self._load()
                items = data.get(user_id)
                items = list(items) if isinstance(items, list) else []
                items.append(notif)
                data[user_id] = items[-_MAX_PER_USER:]
                atomic_write_text(
                    self._path, json.dumps(data, ensure_ascii=False, indent=0)
                )
        except Exception:  # noqa: BLE001 — feed is best-effort, never blocks
            pass

    def for_user(self, user_id: str, limit: int = 50) -> list[dict]:
        """This user's notifications, newest first (empty on any error)."""
        if not user_id:
            return []
        try:
            if self._store is not None:
                return self._store.for_user(user_id, limit)
            with self._lock:
                items = self._load().get(user_id)
            items = items if isinstance(items, list) else []
            return list(reversed(items))[:limit]
        except Exception:  # noqa: BLE001
            return []
