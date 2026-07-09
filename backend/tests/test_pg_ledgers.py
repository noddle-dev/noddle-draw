"""Round-trip tests for the Postgres ledger adapters. SKIPPED unless
``PG_TEST_DSN`` points at a throwaway database — these need a real Postgres
(the file-mode behavior is covered elsewhere).

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
        for t in ("audit_log", "ai_jobs"):
            conn.execute(f"TRUNCATE {t}")
    yield p
    p.close()


def test_audit_store_roundtrip(pool):
    from app.infrastructure.pg_ledgers import PgAuditStore

    s = PgAuditStore(pool)
    s.append({"ts": 1.0, "action": "doc.create", "actor_id": None, "doc_id": "abc123abc123", "detail": "x"})
    s.append({"ts": 2.0, "action": "doc.import", "actor_id": None, "doc_id": None})
    assert len(s.for_doc("abc123abc123")) == 1
    # newest-first + Python filter still applies
    only_import = s.read_entries(10, lambda e: e["action"] == "doc.import")
    assert len(only_import) == 1 and only_import[0]["action"] == "doc.import"


def test_ai_job_store_roundtrip(pool):
    from app.infrastructure.pg_ledgers import PgAIJobStore

    s = PgAIJobStore(pool)
    s.upsert({"id": "job1", "user_id": "client-a", "created_at": 10.0, "status": "queued"})
    s.upsert({"id": "job2", "user_id": "client-a", "created_at": 20.0, "status": "queued"})
    s.upsert({"id": "job3", "user_id": "client-b", "created_at": 30.0, "status": "queued"})
    s.upsert({"id": "job1", "user_id": "client-a", "created_at": 10.0, "status": "done"})
    rows = s.for_user("client-a")
    assert [r["id"] for r in rows] == ["job2", "job1"]  # newest first, scoped
    assert rows[1]["status"] == "done"  # upsert replaced the record
    s.delete("client-a", "job2")
    assert [r["id"] for r in s.for_user("client-a")] == ["job1"]
    # deleting under the wrong client id is a no-op
    s.delete("client-b", "job1")
    assert [r["id"] for r in s.for_user("client-a")] == ["job1"]
