"""Tests for MCP v2.0: patch_board ops, category colors, auto_fit, auto_layout,
compact reads, real DOM text_metrics lint, cropped 2x capture, and style-guide resource."""
from __future__ import annotations

import base64
import shutil
from pathlib import Path

import pytest

from fastapi.testclient import TestClient

from app.config import Settings
from app.domain import board_palette
from app.main import create_app
from mcp_inprocess import backend, core, rpc
from mcp_inprocess import call as mcp_call


@pytest.fixture()
def env(tmp_path):
    """(app, client, agent, doc, client): an anonymous app with one seeded
    board; ``agent()`` is an MCP backend that dispatches into ``client``."""
    app = create_app(Settings(storage_dir=tmp_path, database_url=None))
    client = TestClient(app)
    doc = client.post("/api/documents/new", json={
        "name": "Flow", "diagram": {"nodes": [{"id": "n1", "kind": "rect", "x": 0, "y": 0,
                                               "w": 100, "h": 50, "text": "A"}], "edges": []},
    }).json()["id"]
    return app, client, lambda: backend(client), doc, client




def call(c, b, name, arguments):
    return mcp_call(b, name, arguments)


def test_mcp_palette_matches_board_palette_ssot():
    nm = core()
    assert nm.PALETTE_INK == board_palette.INK
    assert nm.PALETTE_STROKES == board_palette.STROKES
    assert nm.PALETTE_FILLS == board_palette.FILLS
    for name, stroke, fill in board_palette.STYLE_PAIRS:
        preset = nm.STYLE_PRESETS[name.lower()]
        assert preset["stroke"] == stroke
        assert preset["fill"] == fill


def test_style_guide_resource_readable_and_listed(env):
    _, c, agent, _, _ = env
    b = agent()
    listed = rpc(b, "resources/list")["result"]["resources"]
    assert any(r["uri"] == "noddle://style-guide" for r in listed)
    read = rpc(b, "resources/read", {"uri": "noddle://style-guide"})["result"]["contents"][0]
    assert read["mimeType"] == "text/markdown"
    for cat in ("architecture", "flowchart", "data", "org", "timeline"):
        assert cat in read["text"]


def test_category_themes_assign_distinct_colors_and_strip_shorthands(env):
    _, c, agent, _, client = env
    b = agent()
    # Architecture vs Flowchart use distinct semantic mappings for their roles
    arch = call(c, b, "create_board", {
        "name": "Arch",
        "category": "architecture",
        "diagram": {"pages": [{"id": "p1", "name": "P1", "nodes": [
            {"id": "web", "kind": "rounded", "x": 40, "y": 100, "w": 120, "h": 56, "text": "Web App", "role": "client"},
            {"id": "gw", "kind": "rounded", "x": 260, "y": 100, "w": 120, "h": 56, "text": "API Gateway", "role": "gateway"},
            {"id": "svc", "kind": "rounded", "x": 480, "y": 100, "w": 120, "h": 56, "text": "Order Service", "role": "service"},
            {"id": "db", "kind": "cylinder", "x": 700, "y": 100, "w": 120, "h": 64, "text": "Orders DB", "role": "database"},
            {"id": "waf", "kind": "shield", "x": 260, "y": 240, "w": 120, "h": 56, "text": "WAF Policy", "role": "security"},
            {"id": "ttl", "kind": "text", "x": 40, "y": 20, "w": 220, "h": 32, "text": "Order Architecture"},
        ], "edges": [
            {"id": "e1", "source": {"kind": "floating", "nodeId": "web"}, "target": {"kind": "floating", "nodeId": "gw"}},
            {"id": "e2", "source": {"kind": "floating", "nodeId": "gw"}, "target": {"kind": "floating", "nodeId": "svc"}},
            {"id": "e3", "source": {"kind": "floating", "nodeId": "svc"}, "target": {"kind": "floating", "nodeId": "db"}},
            {"id": "e4", "source": {"kind": "floating", "nodeId": "gw"}, "target": {"kind": "floating", "nodeId": "waf"}, "style": "red"},
        ]}]},
    })
    assert not arch["isError"], arch
    doc_id = arch["structuredContent"]["id"]
    saved = client.get(f"/api/documents/{doc_id}").json()["diagram"]["pages"][0]
    by = {n["id"]: n for n in saved["nodes"]}
    assert by["web"]["fill"] == "#dbeafe" and by["web"]["stroke"] == "#2563eb"
    assert by["gw"]["fill"] == "#fef9c3" and by["gw"]["stroke"] == "#eb6c36"
    assert by["svc"]["fill"] == "#dcfce7" and by["svc"]["stroke"] == "#16a34a"
    assert by["db"]["fill"] == "#ffffff" and by["db"]["stroke"] == "#2d3142"
    assert by["waf"]["fill"] == "#fee2e2" and by["waf"]["stroke"] == "#dc2626"
    assert by["ttl"]["kind"] == "rect" and by["ttl"]["fill"] == "transparent" and by["ttl"]["stroke"] == "transparent"
    for n in saved["nodes"]:
        assert "role" not in n and "style" not in n
    assert saved["edges"][3]["stroke"] == "#dc2626"
    # No monochrome warning because distinct roles have distinct colors
    issues = arch["structuredContent"]["post_save_check"]["issues"]
    assert not any(i["type"] == "monochrome_board" for i in issues)


def test_patch_board_auto_fits_text_and_resolves_overlaps_without_moving_untouched_nodes(env):
    _, c, agent, doc, client = env
    b = agent()
    # Seed an existing board with one anchored node at (100, 100)
    seed = {"pages": [{"id": "p1", "name": "P1", "nodes": [
        {"id": "fixed", "kind": "rect", "x": 100, "y": 100, "w": 140, "h": 60, "text": "Existing",
         "fill": "#ffffff", "stroke": "#2d3142", "strokeWidth": 2},
    ], "edges": []}]}
    client.put(f"/api/documents/{doc}", json={"svg": "<svg/>", "diagram": seed})
    before = call(c, b, "get_board", {"doc_id": doc, "compact": True})["structuredContent"]

    # Add an overlapping tiny node with long text + a labeled edge in ONE patch_board call
    res = call(c, b, "patch_board", {
        "doc_id": doc,
        "category": "data",
        "edit_revision": before["edit_revision"],
        "ops": [
            {"op": "add", "node": {
                "id": "new1", "kind": "rounded", "x": 120, "y": 110, "w": 50, "h": 30,
                "text": "Stream Ingest Worker", "role": "transform",
            }},
            {"op": "add", "edge": {
                "id": "e1",
                "source": {"kind": "floating", "nodeId": "fixed"},
                "target": {"kind": "floating", "nodeId": "new1"},
                "labels": [{"id": "l1", "t": 0.5, "text": "EVENTS"}],
            }},
        ],
    })
    assert not res["isError"], res
    sc = res["structuredContent"]
    assert sc["applied_ops"] == 2
    assert sc["edit_revision"]
    assert sc["auto_fixed"]
    assert sc["post_save_check"]["error_count"] == 0

    after = client.get(f"/api/documents/{doc}").json()["diagram"]["pages"][0]
    by = {n["id"]: n for n in after["nodes"]}
    # Existing user node did NOT move!
    assert (by["fixed"]["x"], by["fixed"]["y"]) == (100, 100)
    # New node auto-grew to fit text AND moved clear of existing node
    assert by["new1"]["w"] >= 160 and by["new1"]["h"] >= 44
    assert by["new1"]["fill"] == "#dcfce7"
    gap_x = max(by["new1"]["x"] - (by["fixed"]["x"] + by["fixed"]["w"]),
                by["fixed"]["x"] - (by["new1"]["x"] + by["new1"]["w"]))
    gap_y = max(by["new1"]["y"] - (by["fixed"]["y"] + by["fixed"]["h"]),
                by["fixed"]["y"] - (by["new1"]["y"] + by["new1"]["h"]))
    assert max(gap_x, gap_y) >= 24


def test_clone_then_patch_with_inline_capture_completes_in_one_write(env, monkeypatch):
    _, c, agent, doc, client = env
    b = agent()
    diagram = {"pages": [{"id": "p1", "name": "P1", "nodes": [
        {"id": "a", "kind": "rounded", "x": 40, "y": 80, "w": 140, "h": 60, "text": "Client",
         "fill": "#dbeafe", "stroke": "#2563eb", "strokeWidth": 2},
        {"id": "b", "kind": "rounded", "x": 280, "y": 80, "w": 140, "h": 60, "text": "API",
         "fill": "#dcfce7", "stroke": "#16a34a", "strokeWidth": 2},
    ], "edges": [
        {"id": "e1", "source": {"kind": "floating", "nodeId": "a"}, "target": {"kind": "floating", "nodeId": "b"},
         "routing": "elbow", "stroke": "#2d3142", "strokeWidth": 2, "endArrow": True, "startArrow": False, "animated": False},
    ]}]}
    client.put(f"/api/documents/{doc}", json={"svg": "<svg/>", "diagram": diagram})
    before = call(c, b, "get_board", {"doc_id": doc, "compact": True})["structuredContent"]

    cloned = call(c, b, "clone_diagram", {
        "doc_id": doc, "page_id": "p1", "expected_updated_at": before["updated_at"],
    })["structuredContent"]
    assert cloned["edit_revision"]
    assert len(cloned["clone_node_ids"]) == 2
    clone_b = cloned["node_id_map"]["b"]

    captured_payloads = []
    def fake_capture(page):
        captured_payloads.append(page)
        return {
            "png_base64": base64.b64encode(b"\x89PNG\r\n\x1a\nfake").decode(),
            "width": 600, "height": 300, "scale": 2.0, "cropped": bool(page.get("node_ids")),
            "renderer": "editor-react", "visual_validation": "pending_image_inspection",
            "edge_routes": {}, "text_metrics": {},
        }
    monkeypatch.setattr("app.services.diagram_capture.capture_diagram", fake_capture)

    patched = call(c, b, "patch_board", {
        "doc_id": doc,
        "page_id": "p1",
        "edit_revision": cloned["edit_revision"],
        "ops": [{"op": "update", "node": {"id": clone_b, "text": "Gateway API", "style": "ember"}}],
        "capture": True,
        "capture_node_ids": cloned["clone_node_ids"],
    })
    assert not patched["isError"], patched
    assert [p["type"] for p in patched["content"][:2]] == ["text", "image"]
    sc = patched["structuredContent"]
    assert sc["capture"]["cropped"] is True
    assert sc["post_save_check"]["dom_verified"] is True
    assert captured_payloads[-1]["node_ids"] == cloned["clone_node_ids"]
    # Original node 'b' is preserved untouched
    final_nodes = {n["id"]: n for n in client.get(f"/api/documents/{doc}").json()["diagram"]["pages"][0]["nodes"]}
    assert final_nodes["b"]["text"] == "API"
    assert final_nodes[clone_b]["text"] == "Gateway API"
    assert final_nodes[clone_b]["fill"] == "#fef9c3"


def test_compact_get_board_strips_defaults_and_filters_nodes(env):
    _, c, agent, doc, client = env
    b = agent()
    diagram = {"pages": [{"id": "p1", "name": "P1", "nodes": [
        {"id": "a", "kind": "rect", "x": 0, "y": 0, "w": 120, "h": 60, "text": "A", "fill": "#fff", "stroke": "#000",
         "bold": False, "italic": False, "wrap": False, "opacity": 1, "z": 5},
        {"id": "b", "kind": "rect", "x": 200, "y": 0, "w": 120, "h": 60, "text": "B", "fill": "#fff", "stroke": "#000"},
    ], "edges": [
        {"id": "e1", "source": {"kind": "floating", "nodeId": "a"}, "target": {"kind": "floating", "nodeId": "b"},
         "routing": "elbow", "animated": False, "startArrow": False, "endArrow": True, "waypoints": [], "labels": []},
    ]}]}
    client.put(f"/api/documents/{doc}", json={"svg": "<svg/>", "diagram": diagram})
    res = call(c, b, "get_board", {"doc_id": doc, "compact": True, "node_ids": ["a"]})["structuredContent"]
    nodes = res["diagram"]["pages"][0]["nodes"]
    assert [n["id"] for n in nodes] == ["a"]
    for dropped in ("bold", "italic", "wrap", "opacity", "z"):
        assert dropped not in nodes[0]
    edge = res["diagram"]["pages"][0]["edges"][0]
    for dropped in ("animated", "startArrow", "endArrow", "routing", "waypoints", "labels"):
        assert dropped not in edge


def test_lint_flags_verbose_text_monochrome_and_dom_text_metrics():
    nm = core()
    long_text = "This is an overly verbose paragraph explaining every implementation detail of a microservice instead of a crisp label"
    page = {"id": "p1", "nodes": [
        {"id": f"n{i}", "kind": "rect", "x": i * 200, "y": 0, "w": 120, "h": 50,
         "text": long_text if i == 0 else f"Node {i}", "fill": "#ffffff", "stroke": "#2d3142"}
        for i in range(4)
    ], "edges": []}
    issues = nm._page_issues(page)
    types = {i["type"] for i in issues}
    assert "verbose_text" in types
    assert "monochrome_board" in types

    # Real DOM text_metrics reports pixel-exact overflow & text-on-text collision
    dom_issues = nm._page_issues(
        page,
        text_metrics={
            "n0": {"x": -40, "y": 15, "w": 220, "h": 20},
            "n1": {"x": 160, "y": 15, "w": 60, "h": 20},
        },
    )
    overflow = [i for i in dom_issues if i["type"] == "text_overflow" and i["ids"] == ["n0"]]
    assert overflow and overflow[0]["severity"] == "error" and "need >=" in overflow[0]["detail"]
    overlap = [i for i in dom_issues if i["type"] == "text_overlap" and set(i["ids"]) == {"n0", "n1"}]
    assert overlap and overlap[0]["severity"] == "error"


@pytest.mark.skipif(not (shutil.which("chromium") or Path("/Applications/Google Chrome.app").exists()),
                    reason="Chromium required for real capture test")
def test_real_capture_returns_text_metrics_and_crops_node_ids():
    from app.config import REPO_ROOT
    from app.services.diagram_capture import capture_diagram

    if not (REPO_ROOT / "web/dist/capture.js").exists():
        pytest.skip("Build frontend capture bundle first")
    page = {
        "nodes": [
            {"id": "orig", "kind": "rounded", "x": 0, "y": 0, "w": 160, "h": 60, "text": "Original",
             "fill": "#dbeafe", "stroke": "#2563eb", "strokeWidth": 2, "sketch": True, "cornerRadius": 12},
            {"id": "tight", "kind": "rounded", "x": 1800, "y": 0, "w": 70, "h": 40, "text": "Way Too Long Label Here",
             "fill": "#fef9c3", "stroke": "#eb6c36", "strokeWidth": 2, "sketch": True, "cornerRadius": 12},
        ],
        "edges": [],
    }
    full = capture_diagram(page)
    assert full["cropped"] is False
    assert "orig" in full["text_metrics"] and "tight" in full["text_metrics"]
    assert full["text_metrics"]["tight"]["w"] > 100  # real rendered text exceeds 70px box!

    cropped = capture_diagram({**page, "node_ids": ["tight"]})
    assert cropped["cropped"] is True
    assert cropped["scale"] == 2  # crisp 2x scale when cropped to a single node!
    assert cropped["width"] < full["width"]
    assert base64.b64decode(cropped["png_base64"]).startswith(b"\x89PNG\r\n\x1a\n")
