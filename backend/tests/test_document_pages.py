"""Presentation visibility is durable page metadata, including merged saves."""
from copy import deepcopy

from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


def test_hidden_page_survives_save_and_reopen_and_can_be_unhidden(tmp_path):
    settings = Settings(storage_dir=tmp_path, database_url=None)
    with TestClient(create_app(settings)) as client:
        pages = [{"id": "p1", "name": "Visible", "nodes": [], "edges": []},
                 {"id": "p2", "name": "Hidden", "hidden": True, "nodes": [], "edges": []}]
        doc = client.post("/api/documents/new", json={
            "name": "Slides", "diagram": {"pages": pages},
        }).json()["id"]
        base = client.get(f"/api/documents/{doc}").json()["diagram"]
        assert base["pages"][1]["hidden"] is True
        assert "hidden" not in base["pages"][0]
        desired = deepcopy(base)
        desired["pages"][0]["name"] = "Renamed"
        response = client.put(f"/api/documents/{doc}", json={
            "svg": "<svg/>", "diagram": desired, "base_diagram": base,
        })
        assert response.status_code == 200
    # Recreate the app: assert durable storage, not just live-room state.
    app = create_app(settings)
    persisted = app.state.document_service.get(doc).diagram
    assert persisted["pages"][1]["hidden"] is True
    assert persisted["pages"][0]["name"] == "Renamed"
    with TestClient(app) as client:
        desired = deepcopy(persisted)
        desired["pages"][1].pop("hidden")
        response = client.put(f"/api/documents/{doc}", json={
            "svg": "<svg/>", "diagram": desired, "base_diagram": persisted,
        })
        assert response.status_code == 200
        assert not client.get(f"/api/documents/{doc}").json()["diagram"]["pages"][1].get("hidden")


def test_only_a_literal_true_hides_a_page(tmp_path):
    with TestClient(create_app(Settings(storage_dir=tmp_path, database_url=None))) as client:
        doc = client.post("/api/documents/new", json={"name": "x", "diagram": {"pages": [
            {"id": "p1", "name": "A", "hidden": "yes", "nodes": [], "edges": []}]}}).json()["id"]
        assert "hidden" not in client.get(f"/api/documents/{doc}").json()["diagram"]["pages"][0]
