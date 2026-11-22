"""An open browser and an MCP agent share the same live document (anonymous)."""
import copy

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.domain.diagram_merge import merge_diagrams
from app.main import create_app
from mcp_inprocess import backend, tool


def node(nid, **extra):
    return dict(id=nid, kind="rect", x=0, y=0, w=120, h=60, text="Original", **extra)


def receive(ws, kind):
    for _ in range(20):
        msg = ws.receive_json()
        if msg["t"] == kind:
            return msg
    pytest.fail("Expected websocket frame " + kind)


def test_three_way_merge_preserves_other_objects_fields_and_pages():
    base = {"pages": [{"id": "p1", "nodes": [node("a")], "edges": []},
                      {"id": "p2", "nodes": [node("b")], "edges": []}]}
    human, agent = copy.deepcopy(base), copy.deepcopy(base)
    human["pages"][0]["nodes"][0]["x"] = 140
    human["pages"][1]["nodes"].append(node("c"))
    agent["pages"][0]["nodes"][0]["text"] = "MCP revised"
    agent["pages"][0]["nodes"].append(node("clone"))
    merged = merge_diagrams(base, agent, human)
    assert merged["pages"][0]["nodes"][0]["x"] == 140
    assert merged["pages"][0]["nodes"][0]["text"] == "MCP revised"
    assert {n["id"] for n in merged["pages"][0]["nodes"]} == {"a", "clone"}
    assert {n["id"] for n in merged["pages"][1]["nodes"]} == {"b", "c"}
    # A stale style change doesn't resurrect a node a collaborator removed.
    human["pages"][0]["nodes"] = []
    assert [n["id"] for n in merge_diagrams(base, agent, human)["pages"][0]["nodes"]] == ["clone"]


def test_merge_keeps_node_rotation_edits_from_both_sides():
    base = {"pages": [{"id": "p1", "nodes": [node("a")], "edges": []}]}
    human, agent = copy.deepcopy(base), copy.deepcopy(base)
    human["pages"][0]["nodes"][0]["rotation"] = 30
    agent["pages"][0]["nodes"][0]["text"] = "Rotated"
    merged = merge_diagrams(base, agent, human)["pages"][0]["nodes"][0]
    assert merged["rotation"] == 30 and merged["text"] == "Rotated"


def test_first_edits_on_empty_page_merge_instead_of_replacing_peer_nodes():
    a = {"pages": [{"id": "p1", "nodes": [node("a")], "edges": []}]}
    b = {"pages": [{"id": "p1", "nodes": [node("b")], "edges": []}]}
    merged = merge_diagrams(None, a, b)
    assert {n["id"] for n in merged["pages"][0]["nodes"]} == {"a", "b"}


def test_mcp_merges_live_unsaved_drag_and_notifies_open_editor(tmp_path):
    app = create_app(Settings(storage_dir=tmp_path, database_url=None))
    with TestClient(app) as c:
        mcp = backend(c, agent_name="MCP collaborator")
        diagram = {"pages": [{"id": "p1", "name": "First", "nodes": [node("a")], "edges": []},
                             {"id": "p2", "name": "Other", "nodes": [node("b")], "edges": []}]}
        doc = c.post("/api/documents/new", json={"name": "Live", "diagram": diagram}).json()["id"]
        with c.websocket_connect(f"/ws/documents/{doc}") as ws:
            ws.send_json({"t": "hello", "name": "Human", "color": "#c00", "clientId": "h", "pageId": "p1"})
            init = receive(ws, "init")
            assert init["pageId"] == "p1" and [p["id"] for p in init["pages"]] == ["p1", "p2"]
            receive(ws, "presence")
            # MCP reads before a human starts dragging a node.
            before = tool(mcp, "get_board", {"doc_id": doc})
            moved = copy.deepcopy(diagram["pages"][0])
            moved["nodes"][0]["x"] = 240
            ws.send_json({"t": "state", "pageId": "p1", "diagram": moved,
                          "baseDiagram": diagram["pages"][0]})
            # A second socket is the synchronization barrier for server processing.
            with c.websocket_connect(f"/ws/documents/{doc}") as observer:
                observer.send_json({"t": "hello", "name": "Observer", "color": "#0c0",
                                    "clientId": "o", "pageId": "p1"})
                assert receive(observer, "init")["diagram"]["nodes"][0]["x"] == 240
                receive(observer, "presence")
                desired = copy.deepcopy(before["diagram"])
                desired["pages"][0]["nodes"][0]["text"] = "MCP revised"
                saved = tool(mcp, "update_board", {"doc_id": doc, "diagram": desired,
                                                   "edit_revision": before["edit_revision"],
                                                   "expected_updated_at": before["updated_at"]})
                # The person's unsaved drag was merged in: the agent is told about it.
                check = saved["post_save_check"]
                assert {"page_id": "p1", "change": "modified", "ids": ["a"], "label": "MCP revised",
                        "fields": ["x"]} in check["manual_changes"]
                presence = receive(observer, "presence")
                assert any(p["kind"] == "agent" and p["name"] == "MCP collaborator"
                           for p in presence["users"])
                frame = receive(observer, "state")
                assert frame["pageId"] == "p1" and frame["from"] is None
                assert frame["diagram"]["nodes"][0]["x"] == 240
                assert frame["diagram"]["nodes"][0]["text"] == "MCP revised"
                # An old browser autosave carries its old base, not a destructive full replace.
                response = c.put(f"/api/documents/{doc}", json={
                    "svg": "<svg/>", "diagram": {"pages": [moved, diagram["pages"][1]]},
                    "base_diagram": diagram})
                assert response.status_code == 200
                current = c.get(f"/api/documents/{doc}").json()["diagram"]
                assert current["pages"][0]["nodes"][0]["text"] == "MCP revised"
                assert current["pages"][0]["nodes"][0]["x"] == 240
                assert current["pages"][1]["nodes"][0]["id"] == "b"
        # Last open socket gone: all successful edits remain durable.
        assert app.state.document_service.get(doc).diagram["pages"][0]["nodes"][0]["text"] == "MCP revised"


def test_join_board_shows_claude_agent_with_claude_icon(tmp_path):
    app = create_app(Settings(storage_dir=tmp_path, database_url=None))
    with TestClient(app) as c:
        claude, other = backend(c, agent_name="Claude"), backend(c, agent_name="Build bot")
        doc = c.post("/api/documents/new", json={
            "name": "Join", "diagram": {"nodes": [node("a")], "edges": []}}).json()["id"]
        before = c.get(f"/api/documents/{doc}").json()["meta"]["updated_at"]
        # Nobody has it open: joining is harmless and says so.
        assert tool(claude, "join_board", {"doc_id": doc})["live_viewers"] is False
        with c.websocket_connect(f"/ws/documents/{doc}") as ws:
            ws.send_json({"t": "hello", "name": "Human", "color": "#c00", "clientId": "h", "pageId": "p1"})
            receive(ws, "init")
            receive(ws, "presence")
            joined = tool(claude, "join_board", {"doc_id": doc})
            assert joined["live_viewers"] is True
            assert joined["joined_as"] == {"name": "Claude", "color": joined["joined_as"]["color"],
                                           "kind": "agent", "icon": "claude"}
            users = receive(ws, "presence")["users"]
            assert any(p.get("icon") == "claude" and p["name"] == "Claude" and p["id"] < 0 for p in users)
            tool(other, "join_board", {"doc_id": doc})
            users = receive(ws, "presence")["users"]
            bot = next(p for p in users if p["name"] == "Build bot")
            assert bot["kind"] == "agent" and "icon" not in bot
        # Joining never writes.
        assert c.get(f"/api/documents/{doc}").json()["meta"]["updated_at"] == before
        # A name is required and bounded; unknown boards are 404.
        assert c.post(f"/api/documents/{doc}/presence", json={}).status_code == 422
        assert c.post(f"/api/documents/{doc}/presence", json={"name": "x" * 41}).status_code == 422
        assert c.post("/api/documents/000000000000/presence", json={"name": "Claude"}).status_code == 404


def test_legacy_state_frames_stay_full_state_last_write_wins(tmp_path):
    """A frame without baseDiagram replaces its page (the pre-merge protocol)."""
    app = create_app(Settings(storage_dir=tmp_path, database_url=None))
    with TestClient(app) as c:
        doc = c.post("/api/documents/new", json={
            "name": "Legacy", "diagram": {"nodes": [node("a"), node("b")], "edges": []}}).json()["id"]
        with c.websocket_connect(f"/ws/documents/{doc}") as ws:
            ws.send_json({"t": "hello", "name": "Old", "color": "#c00", "clientId": "old"})
            receive(ws, "init")
            ws.send_json({"t": "state", "diagram": {"nodes": [node("b")], "edges": []}})
            with c.websocket_connect(f"/ws/documents/{doc}") as late:
                late.send_json({"t": "hello", "name": "Late", "color": "#0c0", "clientId": "late"})
                assert [n["id"] for n in receive(late, "init")["diagram"]["nodes"]] == ["b"]
