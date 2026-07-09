"""Collab presence dedup: one browser (stable clientId) = one presence entry,
even across a reconnect that leaves the previous socket lingering."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app

SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>'


@pytest.fixture()
def app(tmp_path):
    return create_app(Settings(storage_dir=tmp_path))


def _last_presence(ws) -> list[dict]:
    """Read frames until a presence frame arrives; return its users list."""
    for _ in range(10):
        msg = ws.receive_json()
        if msg.get("t") == "presence":
            return msg["users"]
    raise AssertionError("no presence frame received")


def test_same_client_id_dedups_presence(app):
    client = TestClient(app)
    doc_id = client.post(
        "/api/documents/new", json={"name": "b", "svg": SVG}
    ).json()["id"]

    with client.websocket_connect(f"/ws/documents/{doc_id}") as ws1:
        ws1.send_json({"t": "hello", "name": "74", "color": "#c00", "clientId": "same"})
        assert len(_last_presence(ws1)) == 1

        # A second connection from the SAME browser (same clientId) — the server
        # must evict the first so presence never shows two identical "74"s.
        with client.websocket_connect(f"/ws/documents/{doc_id}") as ws2:
            ws2.send_json({"t": "hello", "name": "74", "color": "#c00", "clientId": "same"})
            users = _last_presence(ws2)
            assert len(users) == 1, users
            assert users[0]["name"] == "74"
            # The internal dedup key is never leaked to peers.
            assert "client_id" not in users[0]


def test_distinct_client_ids_are_two_peers(app):
    client = TestClient(app)
    doc_id = client.post(
        "/api/documents/new", json={"name": "b", "svg": SVG}
    ).json()["id"]

    with client.websocket_connect(f"/ws/documents/{doc_id}") as ws1:
        ws1.send_json({"t": "hello", "name": "A", "color": "#c00", "clientId": "aaa"})
        _last_presence(ws1)
        with client.websocket_connect(f"/ws/documents/{doc_id}") as ws2:
            ws2.send_json({"t": "hello", "name": "B", "color": "#0c0", "clientId": "bbb"})
            assert len(_last_presence(ws2)) == 2
