"""End-to-end anonymous flows: create → open by URL → edit from a second
client — the whole product model (the URL is the capability)."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app

SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>'
SVG2 = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="5"/></svg>'


@pytest.fixture()
def app(tmp_path):
    return create_app(Settings(storage_dir=tmp_path))


def test_anonymous_create_ships_edit_link_policy(app):
    client = TestClient(app)
    r = client.post("/api/documents/new", json={"name": "My board", "svg": SVG})
    assert r.status_code == 200
    meta = r.json()
    assert meta["link_policy"] == "edit"
    # the stored domain meta is ownerless (owner_id is legacy-only)
    doc = app.state.document_service.get(meta["id"])
    assert doc.meta.owner_id is None


def test_second_client_edits_via_the_url(app):
    creator = TestClient(app)
    doc_id = creator.post(
        "/api/documents/new", json={"name": "b", "svg": SVG}
    ).json()["id"]

    visitor = TestClient(app)  # no cookies, no identity — just the URL
    got = visitor.get(f"/api/documents/{doc_id}")
    assert got.status_code == 200 and got.json()["my_role"] == "editor"
    saved = visitor.put(
        f"/api/documents/{doc_id}",
        json={"svg": SVG2, "author_name": "Guest-9f3a"},
    )
    assert saved.status_code == 200
    # the save landed and is attributed in version history
    versions = visitor.get(f"/api/documents/{doc_id}/versions").json()
    assert versions and versions[0]["author_name"] == "Guest-9f3a"


def test_anonymous_comments_round_trip(app):
    client = TestClient(app)
    doc_id = client.post(
        "/api/documents/new", json={"name": "b", "svg": SVG}
    ).json()["id"]
    r = client.post(
        f"/api/documents/{doc_id}/comments",
        json={
            "body": "hello from a guest",
            "guest_name": "Guest-1234",
            "anchor": {"kind": "point", "x": 1.0, "y": 2.0},
        },
    )
    assert r.status_code == 200
    comments = r.json()["comments"]
    assert comments[0]["author_name"] == "Guest-1234"
    assert comments[0]["author_id"] is None


def test_upload_and_rename_need_no_identity(app):
    client = TestClient(app)
    up = client.post(
        "/api/documents",
        files={"file": ("drawing.svg", SVG, "image/svg+xml")},
    )
    assert up.status_code == 200
    doc_id = up.json()["id"]
    renamed = client.patch(f"/api/documents/{doc_id}", json={"name": "Renamed"})
    assert renamed.status_code == 200 and renamed.json()["name"] == "Renamed"
