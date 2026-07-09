"""Postgres adapters for the append-only ledgers that used to be local files.

Part of the 2026-07-06 "persist to the database, never to local files" rule
(see CLAUDE.md → Conventions). Each class is the DB backend for one service
that previously wrote under ``storage/``:

  * ``PgAuditStore``  ← ``audit.log``     (services/audit.py)
  * ``PgAIJobStore``  ← ``ai_jobs.json``  (services/ai_jobs.py)

Design mirrors ``pg_repository``: plain SQL over the shared ``psycopg`` pool,
no ORM. The audit event / usage entry is stored as a ``jsonb`` blob so the
exact file-era shape round-trips and the service keeps its own aggregation
code — only the ROW SOURCE changes, not the maths. Selected by the composition
root when a pool exists; otherwise the services keep their file fallback.

These stores raise on DB errors (loud, like an OSError from the file path);
the callers wrap them exactly as they wrapped file I/O so a ledger hiccup
never breaks a request.
"""
from __future__ import annotations

from collections.abc import Callable

from psycopg.types.json import Json
from psycopg_pool import ConnectionPool

# A bounded newest-first window scanned when a Python-side filter is applied
# (the file adapter reads backwards until `limit` matches; we cap the DB scan
# the same way — recent-tail semantics, not full history).
_FILTER_SCAN_CAP = 5000


class PgAuditStore:
    """DB backend for AuditService (append + doc/filtered reads)."""

    def __init__(self, pool: ConnectionPool) -> None:
        self._pool = pool

    def append(self, event: dict) -> None:
        with self._pool.connection() as conn:
            conn.execute(
                "INSERT INTO audit_log (ts, action, actor_id, doc_id, team_id, event)"
                " VALUES (to_timestamp(%s), %s, %s, %s, %s, %s)",
                (
                    float(event.get("ts") or 0.0),
                    str(event.get("action") or ""),
                    event.get("actor_id"),
                    event.get("doc_id"),
                    event.get("team_id"),
                    Json(event),
                ),
            )

    def for_doc(self, doc_id: str, limit: int = 100) -> list[dict]:
        with self._pool.connection() as conn:
            rows = conn.execute(
                "SELECT event FROM audit_log WHERE doc_id = %s"
                " ORDER BY ts DESC LIMIT %s",
                (doc_id, int(limit)),
            ).fetchall()
        return [r[0] for r in rows]

    def read_entries(
        self,
        limit: int = 100,
        filter: Callable[[dict], bool] | None = None,  # noqa: A002
    ) -> list[dict]:
        if limit <= 0:
            return []
        scan = limit if filter is None else min(_FILTER_SCAN_CAP, max(limit * 50, limit))
        with self._pool.connection() as conn:
            rows = conn.execute(
                "SELECT event FROM audit_log ORDER BY ts DESC LIMIT %s",
                (int(scan),),
            ).fetchall()
        out: list[dict] = []
        for (ev,) in rows:
            if not isinstance(ev, dict):
                continue
            if filter is None or filter(ev):
                out.append(ev)
                if len(out) >= limit:
                    break
        return out


class PgAIJobStore:
    """DB backend for AIJobService (upsert + per-user newest-first read).

    The full job record rides in jsonb (same shape as the file fallback);
    ``created_at`` is a real column only for the ORDER BY."""

    def __init__(self, pool: ConnectionPool) -> None:
        self._pool = pool

    def upsert(self, job: dict) -> None:
        with self._pool.connection() as conn:
            conn.execute(
                "INSERT INTO ai_jobs (id, user_id, ts, job)"
                " VALUES (%s, %s, to_timestamp(%s), %s)"
                " ON CONFLICT (id) DO UPDATE SET job = EXCLUDED.job",
                (
                    str(job.get("id") or ""),
                    str(job.get("user_id") or ""),
                    float(job.get("created_at") or 0.0),
                    Json(job),
                ),
            )

    def delete(self, user_id: str, job_id: str) -> None:
        with self._pool.connection() as conn:
            conn.execute(
                "DELETE FROM ai_jobs WHERE id = %s AND user_id = %s",
                (job_id, user_id),
            )

    def for_user(self, user_id: str, limit: int = 50) -> list[dict]:
        with self._pool.connection() as conn:
            rows = conn.execute(
                "SELECT job FROM ai_jobs WHERE user_id = %s"
                " ORDER BY ts DESC LIMIT %s",
                (user_id, int(limit)),
            ).fetchall()
        return [r[0] for r in rows if isinstance(r[0], dict)]
