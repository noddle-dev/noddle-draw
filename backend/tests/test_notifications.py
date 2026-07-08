"""NotificationService (the 🔔 feed) over the file fallback.

Same style as test_folders.py / test_activity.py: no HTTP client (the api/
modules can't import under this venv), so the feed is exercised at the
service level — ``record`` + ``for_user`` — which is where all the logic
lives. The endpoint (api/notifications.py) is a thin pass-through.

The Postgres adapter is covered separately in test_pg_ledgers.py (gated on
PG_TEST_DSN).
"""
from __future__ import annotations

from app.services.notifications import NotificationService


def test_record_and_read_newest_first(tmp_path):
    svc = NotificationService(tmp_path)
    svc.record("u1", "share", doc_id="abc123abc123", doc_name="Roadmap", role="editor", actor_name="Alice")
    svc.record("u1", "share", doc_id="def456def456", doc_name="Budget", role="viewer", actor_name="Bob")
    rows = svc.for_user("u1")
    assert len(rows) == 2
    # newest first
    assert rows[0]["doc_name"] == "Budget" and rows[0]["role"] == "viewer"
    assert rows[1]["doc_name"] == "Roadmap"
    # each carries an id + the recipient + the kind
    assert all(r["kind"] == "share" and r["user_id"] == "u1" and r["id"] for r in rows)


def test_feed_is_per_user(tmp_path):
    svc = NotificationService(tmp_path)
    svc.record("u1", "share", doc_name="Mine")
    svc.record("u2", "share", doc_name="Theirs")
    assert [r["doc_name"] for r in svc.for_user("u1")] == ["Mine"]
    assert [r["doc_name"] for r in svc.for_user("u2")] == ["Theirs"]
    assert svc.for_user("nobody") == []


def test_empty_user_id_is_a_noop(tmp_path):
    svc = NotificationService(tmp_path)
    svc.record("", "share", doc_name="Nope")  # never raises, records nothing
    assert svc.for_user("") == []


def test_persists_across_instances(tmp_path):
    NotificationService(tmp_path).record("u1", "share", doc_name="Kept")
    # a fresh service on the same dir reads the file the first one wrote
    assert [r["doc_name"] for r in NotificationService(tmp_path).for_user("u1")] == ["Kept"]


def test_limit_caps_the_read(tmp_path):
    svc = NotificationService(tmp_path)
    for i in range(10):
        svc.record("u1", "share", doc_name=f"b{i}")
    assert len(svc.for_user("u1", limit=3)) == 3
