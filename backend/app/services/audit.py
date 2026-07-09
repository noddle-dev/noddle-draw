"""AuditService — append-only event log for security-relevant actions (#22).

JSONL at ``storage/audit.log`` — one event per line, never rewritten:

    {"ts": …, "action": "doc.create", "actor_kind": "guest", "actor_id": null,
     "actor_name": …, "doc_id": …, "detail": …}

Scope is deliberate: document lifecycle (create/upload/import/delete).
Payload SAVES are excluded — the version history already records who saved
what, and autosave every ~2s would drown the log. This is an OPS log
(anonymous-only product: actors are guests), read by operators, not the UI.
"""
from __future__ import annotations

import json
import os
import time
from collections.abc import Callable, Iterator
from pathlib import Path

from app.services.auth import Principal
from app.services.log_rotation import rotate_if_needed
from app.services.object_storage import ObjectStorage

_MAX_DETAIL = 200


class AuditService:
    def __init__(
        self,
        storage_dir: Path,
        storage: ObjectStorage | None = None,
        store: object | None = None,
    ) -> None:
        # ``store`` (a PgAuditStore) is the production DB backend; when present
        # it replaces the JSONL file (2026-07-06 "no local files" rule). The
        # file path below is the local-dev fallback only.
        self._path = Path(storage_dir) / "audit.log"
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._storage = storage
        self._store = store

    def log(
        self,
        action: str,
        principal: Principal,
        doc_id: str | None = None,
        detail: str = "",
        team_id: str | None = None,
    ) -> None:
        """Append one event. Never raises — auditing must not break requests.

        ``team_id`` is accepted for row-shape compatibility with old logs;
        the anonymous-only product never stamps it.
        """
        try:
            event = {
                "ts": time.time(),
                "action": action,
                "actor_kind": principal.kind,
                "actor_id": None,
                "actor_name": principal.name,
                "doc_id": doc_id,
                "detail": detail[:_MAX_DETAIL],
            }
            if team_id:
                event["team_id"] = team_id
            if self._store is not None:
                self._store.append(event)
                return
            rotate_if_needed(self._path, self._storage, remote_prefix="logs/audit")
            with self._path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(event, ensure_ascii=False) + "\n")
        except Exception:  # noqa: BLE001 — auditing must never break a request
            pass

    def for_doc(self, doc_id: str, limit: int = 100) -> list[dict]:
        """The newest events of one document (newest first). Reads only the
        LIVE file — events older than the last rotation live in the rotated
        segments (and in R2 when configured); acceptable for a UI trail."""
        if self._store is not None:
            try:
                return self._store.for_doc(doc_id, limit)
            except Exception:  # noqa: BLE001
                return []
        if not self._path.exists():
            return []
        out: list[dict] = []
        try:
            with self._path.open("r", encoding="utf-8") as f:
                for line in f:
                    try:
                        ev = json.loads(line)
                    except ValueError:
                        continue
                    if ev.get("doc_id") == doc_id:
                        out.append(ev)
        except OSError:
            return []
        return out[-limit:][::-1]

    def read_entries(
        self,
        limit: int = 100,
        filter: Callable[[dict], bool] | None = None,  # noqa: A002
    ) -> list[dict]:
        """The newest events matching ``filter`` (newest first).

        Reads the live JSONL file BACKWARDS in blocks, so grabbing the recent
        tail of a large log never parses the whole history — it stops as soon
        as ``limit`` matches are collected.

        Limitation (accepted, same as ``for_doc``): only the LIVE file is
        read. Events older than the last rotation live in the rotated
        segments (and in R2 when configured) and are not surfaced here.
        """
        if self._store is not None:
            try:
                return self._store.read_entries(limit, filter)
            except Exception:  # noqa: BLE001
                return []
        if limit <= 0 or not self._path.exists():
            return []
        out: list[dict] = []
        try:
            for line in _reverse_lines(self._path):
                try:
                    ev = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(ev, dict):
                    continue
                if filter is None or filter(ev):
                    out.append(ev)
                    if len(out) >= limit:
                        break
        except OSError:
            return []
        return out


def _reverse_lines(path: Path, block_size: int = 65536) -> Iterator[str]:
    """Yield the lines of a text file last-to-first without loading it whole."""
    with path.open("rb") as f:
        f.seek(0, os.SEEK_END)
        pos = f.tell()
        buf = b""
        while pos > 0:
            step = min(block_size, pos)
            pos -= step
            f.seek(pos)
            buf = f.read(step) + buf
            parts = buf.split(b"\n")
            buf = parts[0]  # may be a partial line — carry into the next block
            for raw in reversed(parts[1:]):
                if raw.strip():
                    yield raw.decode("utf-8", "replace")
        if buf.strip():
            yield buf.decode("utf-8", "replace")
