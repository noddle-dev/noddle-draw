"""Postgres implementation of the BillingRepository port.

Drop-in sibling of ``FileBillingRepository`` — same shape as the other pg
adapters. FLAT storage (DB v3, 2026-07-07): every ``Subscription`` field is a
real column (``user_id`` is the PRIMARY KEY, ``team_id`` indexed for the
team-entitlement lookup); webhook idempotency rides on the ``event_id``
PRIMARY KEY of ``ls_webhook_events`` (INSERT … ON CONFLICT DO NOTHING). The
raw evolving Lemon Squeezy payloads live only in ``billing_events.raw``.

The schema is created by ``pg_repository.init_schema`` (one shared pool, one
idempotent bootstrap at startup).
"""
from __future__ import annotations

import time

from psycopg.types.json import Json
from psycopg_pool import ConnectionPool

from app.domain.models import BillingEvent, Subscription
from app.infrastructure.pg_repository import _epoch


class PgBillingRepository:
    def __init__(self, pool: ConnectionPool) -> None:
        self._pool = pool

    _SUB_COLS = (
        "user_id, tier, status, billing_interval, current_period_end,"
        " ls_customer_id, ls_subscription_id, team_id, created_at, updated_at,"
        " customer_portal_url"
    )

    @staticmethod
    def _sub_from_row(row) -> Subscription:
        return Subscription(
            user_id=row[0],
            tier=row[1],
            status=row[2],
            billing_interval=row[3],
            current_period_end=_epoch(row[4]),
            ls_customer_id=row[5],
            ls_subscription_id=row[6],
            team_id=row[7],
            created_at=_epoch(row[8]),
            updated_at=_epoch(row[9]),
            customer_portal_url=row[10],
        )

    # ---- subscriptions --------------------------------------------------------
    def get_subscription(self, user_id: str) -> Subscription | None:
        with self._pool.connection() as conn:
            row = conn.execute(
                f"SELECT {self._SUB_COLS} FROM subscriptions WHERE user_id = %s",
                (user_id,),
            ).fetchone()
        return self._sub_from_row(row) if row else None

    def upsert_subscription(self, sub: Subscription) -> None:
        with self._pool.connection() as conn:
            conn.execute(
                """
                INSERT INTO subscriptions
                    (user_id, tier, status, billing_interval,
                     current_period_end, ls_customer_id, ls_subscription_id,
                     team_id, created_at, updated_at, customer_portal_url)
                VALUES (%s, %s, %s, %s, to_timestamp(%s), %s, %s, %s,
                        to_timestamp(%s), to_timestamp(%s), %s)
                ON CONFLICT (user_id) DO UPDATE SET
                    tier = EXCLUDED.tier,
                    status = EXCLUDED.status,
                    billing_interval = EXCLUDED.billing_interval,
                    current_period_end = EXCLUDED.current_period_end,
                    ls_customer_id = EXCLUDED.ls_customer_id,
                    ls_subscription_id = EXCLUDED.ls_subscription_id,
                    team_id = EXCLUDED.team_id,
                    created_at = EXCLUDED.created_at,
                    updated_at = EXCLUDED.updated_at,
                    customer_portal_url = EXCLUDED.customer_portal_url
                """,
                (
                    sub.user_id,
                    sub.tier,
                    sub.status,
                    sub.billing_interval,
                    sub.current_period_end,
                    sub.ls_customer_id,
                    sub.ls_subscription_id,
                    sub.team_id,
                    sub.created_at,
                    sub.updated_at,
                    sub.customer_portal_url,
                ),
            )

    def get_team_subscription(self, team_id: str) -> Subscription | None:
        if not team_id:
            return None
        with self._pool.connection() as conn:
            row = conn.execute(
                f"SELECT {self._SUB_COLS} FROM subscriptions"
                " WHERE team_id = %s AND tier = 'team' LIMIT 1",
                (team_id,),
            ).fetchone()
        return self._sub_from_row(row) if row else None

    # ---- webhook idempotency ----------------------------------------------------
    def record_webhook_event(self, event_id: str, name: str, payload: dict) -> bool:
        del payload  # not persisted — mirrors the file adapter
        with self._pool.connection() as conn:
            cur = conn.execute(
                """
                INSERT INTO ls_webhook_events (event_id, name, created_at)
                VALUES (%s, %s, to_timestamp(%s))
                ON CONFLICT (event_id) DO NOTHING
                """,
                (event_id, name, time.time()),
            )
            return cur.rowcount == 1

    # ---- billing history (user-visible ledger) ----------------------------------
    def add_event(
        self,
        user_id: str,
        event: str,
        amount_usd: float | None,
        credits_granted: int,
        raw: dict,
    ) -> None:
        with self._pool.connection() as conn:
            conn.execute(
                """
                INSERT INTO billing_events
                    (user_id, event, amount_usd, credits_granted, raw, created_at)
                VALUES (%s, %s, %s, %s, %s, to_timestamp(%s))
                """,
                (
                    user_id,
                    event,
                    amount_usd,
                    int(credits_granted),
                    Json(dict(raw or {})),
                    time.time(),
                ),
            )

    def list_events(self, user_id: str, limit: int = 20) -> list[BillingEvent]:
        with self._pool.connection() as conn:
            rows = conn.execute(
                """
                SELECT event, amount_usd, credits_granted, raw, created_at
                FROM billing_events
                WHERE user_id = %s
                ORDER BY created_at DESC, id DESC
                LIMIT %s
                """,
                (user_id, max(1, limit)),
            ).fetchall()
        return [
            BillingEvent(
                user_id=user_id,
                event=event,
                created_at=created_at.timestamp(),
                amount_usd=float(amount) if amount is not None else None,
                credits_granted=int(credits),
                raw=raw or {},
            )
            for (event, amount, credits, raw, created_at) in rows
        ]
