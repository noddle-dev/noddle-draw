"""Postgres adapters for the append-only ledgers that used to be local files.

Part of the 2026-07-06 "persist to the database, never to local files" rule
(see CLAUDE.md → Conventions). Each class is the DB backend for one service
that previously wrote under ``storage/``:

  * ``PgAuditStore``        ← ``audit.log``            (services/audit.py)
  * ``PgActivityStore``     ← ``activity.json``        (services/activity.py)
  * ``PgUsageStore``        ← ``ai_usage.jsonl``       (services/ai_usage.py)
  * ``PgLeaderboard``       ← ``games_leaderboard.json`` (api/games.py)
  * ``PgNotificationStore`` ← ``notifications.json``   (services/notifications.py)

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

from collections.abc import Callable, Iterator

from psycopg.types.json import Json
from psycopg_pool import ConnectionPool

from app.infrastructure.pg_repository import _epoch

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


class PgActivityStore:
    """DB backend for ActivityService (last-active upsert + read)."""

    def __init__(self, pool: ConnectionPool) -> None:
        self._pool = pool

    def touch(self, user_id: str, now: float) -> None:
        with self._pool.connection() as conn:
            conn.execute(
                "INSERT INTO user_activity (user_id, last_active_at)"
                " VALUES (%s, to_timestamp(%s))"
                " ON CONFLICT (user_id) DO UPDATE SET last_active_at = EXCLUDED.last_active_at",
                (user_id, float(now)),
            )

    def last_active_at(self, user_id: str) -> float | None:
        with self._pool.connection() as conn:
            row = conn.execute(
                "SELECT last_active_at FROM user_activity WHERE user_id = %s",
                (user_id,),
            ).fetchone()
        return _epoch(row[0]) if row else None


class PgUsageStore:
    """DB backend for AIUsageLedger (append + entry iteration for reports)."""

    def __init__(self, pool: ConnectionPool) -> None:
        self._pool = pool

    def append(self, entry: dict) -> None:
        with self._pool.connection() as conn:
            conn.execute(
                "INSERT INTO ai_usage (user_id, ts, entry)"
                " VALUES (%s, to_timestamp(%s), %s)",
                (
                    str(entry.get("user_id") or ""),
                    float(entry.get("ts") or 0.0),
                    Json(entry),
                ),
            )

    def iter_entries(self, user_id: str, since_ts: float | None = None) -> Iterator[dict]:
        """Yield a user's entries (oldest→newest, matching the file adapter) so
        the service's existing aggregation runs unchanged. ``since_ts`` bounds
        the scan to a time window when the caller only needs recent rows."""
        if since_ts is None:
            sql = "SELECT entry FROM ai_usage WHERE user_id = %s ORDER BY ts ASC"
            params: tuple = (user_id,)
        else:
            sql = (
                "SELECT entry FROM ai_usage WHERE user_id = %s"
                " AND ts >= to_timestamp(%s)"
                " ORDER BY ts ASC"
            )
            params = (user_id, float(since_ts))
        with self._pool.connection() as conn:
            with conn.cursor() as cur:
                cur.execute(sql, params)
                for (entry,) in cur:
                    if isinstance(entry, dict):
                        yield entry


class PgLeaderboard:
    """DB backend for the cross-game leaderboard (read-all + fold a game)."""

    def __init__(self, pool: ConnectionPool) -> None:
        self._pool = pool

    def read_all(self) -> list[dict]:
        with self._pool.connection() as conn:
            rows = conn.execute(
                "SELECT name, color, points, wins, games FROM games_leaderboard"
            ).fetchall()
        return [
            {"name": n, "color": c, "points": p, "wins": w, "games": g}
            for (n, c, p, w, g) in rows
        ]

    def record(self, results: list[dict]) -> None:
        """Fold one finished game into the board (keyed by player name). One
        UPSERT per player: points accumulate, games +1, wins +1 for the top
        non-zero score — identical to the file-era ``_record_game``."""
        if not results:
            return
        top = max((r["score"] for r in results), default=0)
        with self._pool.connection() as conn:
            for r in results:
                won = 1 if (r["score"] == top and top > 0) else 0
                conn.execute(
                    "INSERT INTO games_leaderboard (name, color, points, wins, games)"
                    " VALUES (%s, %s, %s, %s, 1)"
                    " ON CONFLICT (name) DO UPDATE SET"
                    "   color = EXCLUDED.color,"
                    "   points = games_leaderboard.points + EXCLUDED.points,"
                    "   wins = games_leaderboard.wins + %s,"
                    "   games = games_leaderboard.games + 1",
                    (r["name"], r["color"], int(r["score"]), won, won),
                )


class PgNotificationStore:
    """DB backend for NotificationService (append + per-user newest-first read)."""

    def __init__(self, pool: ConnectionPool) -> None:
        self._pool = pool

    def append(self, notif: dict) -> None:
        with self._pool.connection() as conn:
            conn.execute(
                "INSERT INTO notifications (id, user_id, ts, notif)"
                " VALUES (%s, %s, to_timestamp(%s), %s)"
                " ON CONFLICT (id) DO NOTHING",
                (
                    str(notif.get("id") or ""),
                    str(notif.get("user_id") or ""),
                    float(notif.get("ts") or 0.0),
                    Json(notif),
                ),
            )

    def for_user(self, user_id: str, limit: int = 50) -> list[dict]:
        with self._pool.connection() as conn:
            rows = conn.execute(
                "SELECT notif FROM notifications WHERE user_id = %s"
                " ORDER BY ts DESC LIMIT %s",
                (user_id, int(limit)),
            ).fetchall()
        return [r[0] for r in rows if isinstance(r[0], dict)]


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
