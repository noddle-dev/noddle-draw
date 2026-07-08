"""File-backed implementation of the BillingRepository port.

Two JSON sidecars under ``storage_dir`` (mirroring ``auth.json``):

    billing.json         { "subscriptions": { "<user_id>": {…Subscription…} } }
    billing_events.json  { "events": { "<event_id>": {"name": …, "ts": …} },
                           "history": [ {…BillingEvent…}, … ] }

Separate files on purpose: subscriptions are small mutable state, the events
map is an append-mostly idempotency ledger (payloads are NOT persisted here —
the audit log records the interesting facts; keeping raw webhook bodies at
rest would only duplicate Lemon Squeezy's own event history). ``history`` is
the user-visible billing ledger (compact summaries only, appended in order —
``list_events`` reads it back newest first).
"""
from __future__ import annotations

import json
import threading
import time
from dataclasses import asdict
from pathlib import Path

from app.domain.models import BillingEvent, Subscription
from app.infrastructure.atomic import atomic_write_text


class FileBillingRepository:
    def __init__(self, storage_dir: Path) -> None:
        self._dir = Path(storage_dir)
        self._dir.mkdir(parents=True, exist_ok=True)
        self._subs_path = self._dir / "billing.json"
        self._events_path = self._dir / "billing_events.json"
        # One lock for both files: webhook handling runs in FastAPI's threadpool
        # and Lemon Squeezy retries deliveries — without this, two concurrent
        # deliveries of the SAME event both pass the dedupe check (TOCTOU) and
        # credits get granted twice.
        self._lock = threading.Lock()

    # ---- persistence --------------------------------------------------------
    def _load_subs(self) -> dict:
        if not self._subs_path.exists():
            return {"subscriptions": {}}
        data = json.loads(self._subs_path.read_text("utf-8"))
        data.setdefault("subscriptions", {})
        return data

    def _save_subs(self, data: dict) -> None:
        atomic_write_text(
            self._subs_path, json.dumps(data, ensure_ascii=False, indent=2)
        )

    def _load_events(self) -> dict:
        if not self._events_path.exists():
            return {"events": {}, "history": []}
        data = json.loads(self._events_path.read_text("utf-8"))
        data.setdefault("events", {})
        data.setdefault("history", [])
        return data

    def _save_events(self, data: dict) -> None:
        atomic_write_text(
            self._events_path, json.dumps(data, ensure_ascii=False, indent=2)
        )

    # ---- subscriptions --------------------------------------------------------
    def get_subscription(self, user_id: str) -> Subscription | None:
        s = self._load_subs()["subscriptions"].get(user_id)
        try:
            return Subscription(**s) if s else None
        except TypeError:  # unknown/missing fields — treat as absent
            return None

    def upsert_subscription(self, sub: Subscription) -> None:
        with self._lock:
            data = self._load_subs()
            data["subscriptions"][sub.user_id] = asdict(sub)
            self._save_subs(data)

    def get_team_subscription(self, team_id: str) -> Subscription | None:
        if not team_id:
            return None
        for s in self._load_subs()["subscriptions"].values():
            if s.get("team_id") == team_id and s.get("tier") == "team":
                try:
                    return Subscription(**s)
                except TypeError:
                    continue
        return None

    # ---- webhook idempotency ----------------------------------------------------
    def record_webhook_event(self, event_id: str, name: str, payload: dict) -> bool:
        del payload  # not persisted — see module docstring
        with self._lock:  # atomic check-and-claim — see __init__
            data = self._load_events()
            if event_id in data["events"]:
                return False
            data["events"][event_id] = {"name": name, "ts": time.time()}
            self._save_events(data)
            return True

    # ---- billing history (user-visible ledger) ----------------------------------
    def add_event(
        self,
        user_id: str,
        event: str,
        amount_usd: float | None,
        credits_granted: int,
        raw: dict,
    ) -> None:
        row = BillingEvent(
            user_id=user_id,
            event=event,
            created_at=time.time(),
            amount_usd=amount_usd,
            credits_granted=int(credits_granted),
            raw=dict(raw or {}),
        )
        with self._lock:
            data = self._load_events()
            data["history"].append(asdict(row))
            self._save_events(data)

    def list_events(self, user_id: str, limit: int = 20) -> list[BillingEvent]:
        out: list[BillingEvent] = []
        # Appended in time order → walk backwards for newest-first.
        for row in reversed(self._load_events()["history"]):
            if row.get("user_id") != user_id:
                continue
            try:
                out.append(BillingEvent(**row))
            except TypeError:  # unknown/missing fields — skip the row
                continue
            if len(out) >= max(1, limit):
                break
        return out
