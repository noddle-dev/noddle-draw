"""The authorization matrix (anonymous-only): ``can(action, meta)``.

The board URL is the capability — ``link_policy`` is the whole access model:
  * "edit"    → view + edit for anyone with the link,
  * "view"    → view only,
  * "private" (legacy rows from the accounts era) → denied.

Route-level checks confirm the api layer enforces the same matrix.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.domain.models import DocumentMeta
from app.main import create_app
from app.services.auth import can

SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>'


def _meta(link_policy: str) -> DocumentMeta:
    return DocumentMeta(
        id="a" * 12, name="board", created_at=0.0, updated_at=0.0,
        link_policy=link_policy,
    )


# ---- pure matrix --------------------------------------------------------------

def test_edit_policy_grants_view_and_edit():
    assert can("view", _meta("edit")) is True
    assert can("edit", _meta("edit")) is True


def test_view_policy_grants_view_only():
    assert can("view", _meta("view")) is True
    assert can("edit", _meta("view")) is False


def test_private_legacy_rows_stay_dark():
    assert can("view", _meta("private")) is False
    assert can("edit", _meta("private")) is False


def test_owner_id_grants_nothing():
    meta = _meta("private")
    meta.owner_id = "someone"
    assert can("view", meta) is False


# ---- route level ---------------------------------------------------------------

@pytest.fixture()
def client(tmp_path) -> TestClient:
    return TestClient(create_app(Settings(storage_dir=tmp_path)))


def _create(client: TestClient) -> str:
    r = client.post("/api/documents/new", json={"name": "b", "svg": SVG})
    assert r.status_code == 200
    return r.json()["id"]


def _force_policy(client: TestClient, doc_id: str, policy: str) -> None:
    """Arrange a stored policy directly through the service (no API knob)."""
    service = client.app.state.document_service
    doc = service.get(doc_id)
    doc.meta.link_policy = policy
    service._repo.save(doc)  # noqa: SLF001 — test arranging persisted state


def test_view_policy_board_rejects_saves(client):
    doc_id = _create(client)
    _force_policy(client, doc_id, "view")
    assert client.get(f"/api/documents/{doc_id}").status_code == 200
    r = client.put(f"/api/documents/{doc_id}", json={"svg": SVG})
    assert r.status_code == 403
    assert client.patch(
        f"/api/documents/{doc_id}", json={"name": "renamed"}
    ).status_code == 403


def test_private_legacy_board_is_dark(client):
    doc_id = _create(client)
    _force_policy(client, doc_id, "private")
    assert client.get(f"/api/documents/{doc_id}").status_code == 403
    assert client.get(f"/api/documents/{doc_id}/export.svg").status_code == 403


def test_edit_policy_board_round_trips(client):
    doc_id = _create(client)
    r = client.get(f"/api/documents/{doc_id}")
    assert r.status_code == 200
    assert r.json()["my_role"] == "editor"
    assert r.json()["meta"]["link_policy"] == "edit"
    assert client.put(
        f"/api/documents/{doc_id}", json={"svg": SVG, "author_name": "Guest-ab12"}
    ).status_code == 200


def test_view_policy_reports_viewer_role(client):
    doc_id = _create(client)
    _force_policy(client, doc_id, "view")
    assert client.get(f"/api/documents/{doc_id}").json()["my_role"] == "viewer"


def test_removed_account_routes_are_gone(client):
    assert client.post(
        "/api/auth/login", json={"email": "a@b.c", "password": "x"}
    ).status_code in (404, 405)
    assert client.get("/api/teams").status_code in (404, 405)
    assert client.post("/api/payments/checkout", json={}).status_code in (404, 405)
    assert client.get("/api/me/notifications").status_code in (404, 405)
    assert client.get("/api/documents").status_code in (404, 405)  # no listing
    doc_id = _create(client)
    # no delete, no shares, no policy toggle
    assert client.delete(f"/api/documents/{doc_id}").status_code in (404, 405)
    assert client.get(f"/api/documents/{doc_id}/shares").status_code in (404, 405)
