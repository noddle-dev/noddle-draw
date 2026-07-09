"""AIJobService — server-side background queue for image→board conversions.

The synchronous ``POST /api/ai/image-to-svg`` made the CLIENT wait out a
minutes-long model call: a page reload lost the in-flight conversion, and one
user's upload made the next one queue behind it in the browser. Here each
upload becomes a JOB: the request returns immediately with a job record, a
small worker pool converts in the background (several users run in parallel),
and the finished job carries the created board's ``doc_id`` — so history
survives reloads and "open the board" is one click.

Persistence: job RECORDS go to Postgres via ``PgAIJobStore`` when a pool
exists, else the JSON file fallback. The image BYTES are in-memory only
(single-instance app, like the collab rooms): a job that was queued/processing
when the process died can never finish, so reads lazily mark any
running-status job unknown to this process as failed ("server restarted").

Anonymous product: ``user_id`` is the caller's opaque client id (the
X-Client-Id localStorage UUID) — a history bucket, not an identity.

Job record shape (jsonb / file dict — one shape everywhere)::

    {id, user_id, name, prompt, status: queued|processing|done|error,
     error: "", doc_id: "", created_at, updated_at}
"""
from __future__ import annotations

import json
import logging
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from app.domain.ids import new_id
from app.infrastructure.atomic import atomic_write_text
from app.services.ai import (
    AIBadOutput,
    AIRetryable,
    AIService,
    AIUnavailable,
    ProviderSettings,
)
from app.services.diagram_render import diagram_to_svg
from app.services.documents import DocumentService

logger = logging.getLogger("noddle.ai_jobs")

_MAX_PER_USER = 50  # history cap (file fallback prunes at write, Pg at read)
_WORKERS = 3  # parallel conversions — users must not wait for each other
# Transient provider failures (overload, timeout, network blip) retry with
# backoff before the job fails — sleeping on a worker thread is fine here.
_BACKOFFS = (5.0, 15.0)  # attempts = len(_BACKOFFS) + 1
_RUNNING = {"queued", "processing"}
_RESTART_ERROR = (
    "Server restarted while this job was waiting — please upload the image again."
)


class AIJobService:
    def __init__(
        self,
        storage_dir: Path,
        documents: DocumentService,
        ai: AIService,
        store: object | None = None,
    ) -> None:
        self._path = Path(storage_dir) / "ai_jobs.json"
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._documents = documents
        self._ai = ai
        self._store = store
        self._lock = threading.Lock()
        # Jobs THIS process can still finish. Anything running-status outside
        # this set is an orphan from a previous process → failed on read.
        self._live: set[str] = set()
        self._pool = ThreadPoolExecutor(max_workers=_WORKERS, thread_name_prefix="aijob")

    # ---- persistence (file fallback mirrors NotificationService) -------------
    def _load(self) -> dict[str, list[dict]]:
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def _save_record(self, job: dict) -> None:
        if self._store is not None:
            self._store.upsert(job)  # type: ignore[attr-defined]
            return
        with self._lock:
            data = self._load()
            items = [
                j
                for j in (data.get(job["user_id"]) or [])
                if isinstance(j, dict) and j.get("id") != job["id"]
            ]
            items.append(job)
            data[job["user_id"]] = items[-_MAX_PER_USER:]
            atomic_write_text(self._path, json.dumps(data, ensure_ascii=False, indent=0))

    def _delete_record(self, user_id: str, job_id: str) -> None:
        if self._store is not None:
            self._store.delete(user_id, job_id)  # type: ignore[attr-defined]
            return
        with self._lock:
            data = self._load()
            data[user_id] = [
                j for j in (data.get(user_id) or []) if j.get("id") != job_id
            ]
            atomic_write_text(self._path, json.dumps(data, ensure_ascii=False, indent=0))

    def _records_for_user(self, user_id: str, limit: int) -> list[dict]:
        if self._store is not None:
            return self._store.for_user(user_id, limit)  # type: ignore[attr-defined]
        with self._lock:
            items = self._load().get(user_id)
        items = [j for j in (items or []) if isinstance(j, dict)]
        return list(reversed(items))[:limit]

    def _heal(self, job: dict) -> dict:
        """A running-status job this process doesn't own can never finish
        (image bytes died with the previous process) — fail it on read."""
        if job.get("status") in _RUNNING and job.get("id") not in self._live:
            job = {**job, "status": "error", "error": _RESTART_ERROR}
            try:
                self._save_record(job)
            except Exception:  # noqa: BLE001 — healing is best-effort
                pass
        return job

    # ---- API ------------------------------------------------------------------
    def submit(
        self,
        user_id: str,
        name: str,
        prompt: str,
        raw: bytes,
        media_type: str,
        backend: ProviderSettings | None,
        now: float,
    ) -> dict:
        """Queue one conversion; returns the job record immediately."""
        job = {
            "id": new_id(),
            "user_id": user_id,
            "name": name,
            "prompt": prompt,
            "status": "queued",
            "error": "",
            "doc_id": "",
            "created_at": now,
            "updated_at": now,
        }
        self._live.add(job["id"])
        self._save_record(job)
        self._pool.submit(self._run, dict(job), raw, media_type, backend)
        return job

    def _run(
        self,
        job: dict,
        raw: bytes,
        media_type: str,
        backend: ProviderSettings | None,
    ) -> None:
        import time as _time

        job.update(status="processing", updated_at=_time.time())
        self._save_record(job)
        try:
            for attempt, backoff in enumerate((*_BACKOFFS, None)):
                try:
                    # PREDEFINED shapes, not a freeform SVG reproduction —
                    # the board must be editable like any drawn diagram.
                    diagram = self._ai.image_to_diagram(
                        raw, media_type, job["prompt"], settings=backend
                    )
                    break
                except AIRetryable as e:
                    if backoff is None:  # attempts exhausted — fail the job
                        raise
                    logger.warning(
                        "ai job %s attempt %d hit a transient error (%s) — "
                        "retrying in %.0fs",
                        job["id"], attempt + 1, e, backoff,
                    )
                    _time.sleep(backoff)
            # Server-side approximate render so the finished board has a
            # preview before the first client-side save (same as templates).
            # The created board is anonymous: link_policy "edit", the URL is
            # the capability.
            meta = self._documents.create(
                diagram_to_svg(diagram),
                (job["name"] or "sketch").rsplit(".", 1)[0] + " (AI redraw)",
                diagram=diagram,
            )
            job.update(status="done", doc_id=meta.id, updated_at=_time.time())
        except (AIUnavailable, AIBadOutput) as e:
            job.update(status="error", error=str(e), updated_at=_time.time())
        except Exception:  # noqa: BLE001 — a worker must never die silently
            logger.exception("ai job %s crashed", job["id"])
            job.update(
                status="error",
                error="Unexpected error while converting — please try again.",
                updated_at=_time.time(),
            )
        finally:
            # Persist the terminal state BEFORE leaving _live — the other
            # order let a concurrent read heal the still-"processing" record
            # to "server restarted" in the gap.
            try:
                self._save_record(job)
            except Exception:  # noqa: BLE001
                logger.exception("ai job %s could not persist its result", job["id"])
            self._live.discard(job["id"])

    def list_for_user(self, user_id: str, limit: int = 30) -> list[dict]:
        """This user's job history, newest first (orphans healed to error)."""
        return [self._heal(j) for j in self._records_for_user(user_id, limit)]

    def get(self, user_id: str, job_id: str) -> dict | None:
        for j in self._records_for_user(user_id, _MAX_PER_USER):
            if j.get("id") == job_id:
                return self._heal(j)
        return None

    def delete(self, user_id: str, job_id: str) -> bool:
        """Remove one FINISHED job from history (running jobs must complete)."""
        job = self.get(user_id, job_id)
        if job is None:
            return False
        if job.get("status") in _RUNNING:
            return False
        self._delete_record(user_id, job_id)
        return True
