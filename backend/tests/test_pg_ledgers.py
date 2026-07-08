"""Round-trip tests for the Postgres ledger adapters (2026-07-06 "no local
files" rule). SKIPPED unless ``PG_TEST_DSN`` points at a throwaway database —
these need a real Postgres (the file-mode behavior is covered elsewhere).

    PG_TEST_DSN=postgresql://postgres:test@127.0.0.1:55432/noddle \
        python -m pytest backend/tests/test_pg_ledgers.py -q
"""
from __future__ import annotations

import os

import pytest

DSN = os.environ.get("PG_TEST_DSN")
pytestmark = pytest.mark.skipif(not DSN, reason="PG_TEST_DSN not set")


@pytest.fixture()
def pool():
    from app.infrastructure.pg_repository import create_pool, init_schema

    p = create_pool(DSN)
    init_schema(p)
    # clean slate for the ledger tables this test touches
    with p.connection() as conn:
        for t in ("audit_log", "user_activity", "ai_usage", "games_leaderboard", "notifications"):
            conn.execute(f"TRUNCATE {t}")
    yield p
    p.close()


def test_audit_store_roundtrip(pool):
    from app.infrastructure.pg_ledgers import PgAuditStore

    s = PgAuditStore(pool)
    s.append({"ts": 1.0, "action": "doc.create", "actor_id": "u1", "doc_id": "abc123abc123", "detail": "x"})
    s.append({"ts": 2.0, "action": "auth.login", "actor_id": "u1", "doc_id": None})
    assert len(s.for_doc("abc123abc123")) == 1
    # newest-first + Python filter still applies
    only_auth = s.read_entries(10, lambda e: e["action"].startswith("auth."))
    assert len(only_auth) == 1 and only_auth[0]["action"] == "auth.login"


def test_activity_store_upsert(pool):
    from app.infrastructure.pg_ledgers import PgActivityStore

    s = PgActivityStore(pool)
    assert s.last_active_at("u1") is None
    s.touch("u1", 100.0)
    s.touch("u1", 200.0)  # upsert, not duplicate
    assert s.last_active_at("u1") == 200.0


def test_usage_store_iter(pool):
    from app.infrastructure.pg_ledgers import PgUsageStore

    s = PgUsageStore(pool)
    s.append({"user_id": "u1", "ts": 10.0, "mode": "byok", "prompt": 5, "completion": 3})
    s.append({"user_id": "u1", "ts": 20.0, "mode": "subscription", "prompt": 7, "completion": 1})
    s.append({"user_id": "u2", "ts": 30.0, "mode": "byok"})
    rows = list(s.iter_entries("u1"))
    assert [r["ts"] for r in rows] == [10.0, 20.0]  # oldest→newest, user-scoped
    assert list(s.iter_entries("u1", since_ts=15.0)) == [rows[1]]


def test_leaderboard_fold(pool):
    from app.infrastructure.pg_ledgers import PgLeaderboard

    s = PgLeaderboard(pool)
    s.record([{"name": "A", "color": "#f00", "score": 10}, {"name": "B", "color": "#00f", "score": 4}])
    s.record([{"name": "A", "color": "#f00", "score": 3}, {"name": "B", "color": "#00f", "score": 9}])
    rows = {r["name"]: r for r in s.read_all()}
    assert rows["A"]["points"] == 13 and rows["A"]["wins"] == 1 and rows["A"]["games"] == 2
    assert rows["B"]["points"] == 13 and rows["B"]["wins"] == 1


def test_notification_store_roundtrip(pool):
    from app.infrastructure.pg_ledgers import PgNotificationStore

    s = PgNotificationStore(pool)
    s.append({"id": "n1", "user_id": "u1", "ts": 10.0, "kind": "share", "doc_name": "Roadmap", "role": "editor"})
    s.append({"id": "n2", "user_id": "u1", "ts": 20.0, "kind": "share", "doc_name": "Budget", "role": "viewer"})
    s.append({"id": "n3", "user_id": "u2", "ts": 30.0, "kind": "share", "doc_name": "Theirs"})
    s.append({"id": "n1", "user_id": "u1", "ts": 99.0, "kind": "share"})  # dup id → no-op (idempotent)
    rows = s.for_user("u1")
    assert [r["doc_name"] for r in rows] == ["Budget", "Roadmap"]  # newest first, user-scoped
    assert [r["doc_name"] for r in s.for_user("u2")] == ["Theirs"]
    assert len(s.for_user("u1", limit=1)) == 1
