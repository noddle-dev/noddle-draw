"""Postgres implementation of the PricingRepository port.

The catalog is materialized as a SINGLE JSONB row (id enforced = 1) — the same
data-column idiom as the other pg adapters. The seed JSON is the editing
surface; this table is the runtime source of truth. The schema is created by
``pg_repository.init_schema`` (one shared pool, one idempotent bootstrap).
"""
from __future__ import annotations

import time

from psycopg.types.json import Json
from psycopg_pool import ConnectionPool


class PgPricingRepository:
    def __init__(self, pool: ConnectionPool) -> None:
        self._pool = pool

    def load_catalog(self) -> dict | None:
        with self._pool.connection() as conn:
            row = conn.execute(
                "SELECT data FROM pricing_catalog WHERE id = 1"
            ).fetchone()
        return row[0] if row and isinstance(row[0], dict) else None

    def save_catalog(self, data: dict) -> None:
        with self._pool.connection() as conn:
            conn.execute(
                """
                INSERT INTO pricing_catalog (id, data, updated_at)
                VALUES (1, %s, to_timestamp(%s))
                ON CONFLICT (id) DO UPDATE SET
                    data = EXCLUDED.data,
                    updated_at = EXCLUDED.updated_at
                """,
                (Json(data), time.time()),
            )
