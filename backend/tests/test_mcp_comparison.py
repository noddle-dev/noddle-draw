"""The default MCP editing flow preserves originals and supplies real PNG evidence.

Anonymous OSS edition: no tokens — the MCP tool table runs in-process against
the real app (see mcp_inprocess.py), exactly as the stdio server would over REST.
"""
import base64
import copy
import shutil
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from mcp_inprocess import backend, call, core, tool


@pytest.fixture()
def env(tmp_path):
    app = create_app(Settings(storage_dir=tmp_path, database_url=None))
    client = TestClient(app)
    doc = client.post("/api/documents/new", json={
        "name": "Flow", "diagram": {"nodes": [{"id": "n1", "kind": "rect", "x": 0, "y": 0,
                                               "w": 100, "h": 50, "text": "A"}], "edges": []},
    }).json()["id"]
    return app, client, backend(client), doc


def _stub_png(monkeypatch, **extra):
    monkeypatch.setattr("app.services.diagram_capture.capture_diagram", lambda page: {
        "png_base64": base64.b64encode(b"png-placeholder").decode(), "width": 100,
        "height": 80, "renderer": "editor-react", "visual_validation": "pending_image_inspection",
        **extra})


def test_clone_preserves_original_and_remaps_connections(env):
    _, c, mcp, doc = env
    diagram = {"pages": [{"id": "p1", "name": "First", "nodes": [
        {"id": "a", "kind": "rect", "x": 0, "y": 0, "w": 100, "h": 60, "text": "Original", "groupId": "g1"},
        {"id": "b", "kind": "rect", "x": 200, "y": 0, "w": 100, "h": 60, "text": "End", "groupId": "g1"},
    ], "edges": [{"id": "e", "source": {"kind": "floating", "nodeId": "a"},
                  "target": {"kind": "free", "point": {"x": 180, "y": 30}},
                  "waypoints": [{"x": 120, "y": 30}], "labels": [{"id": "label", "t": .5, "text": "flow"}]}]},
        {"id": "p2", "name": "Untouched", "nodes": [], "edges": []}]}
    c.put(f"/api/documents/{doc}", json={"svg": "<svg/>", "diagram": diagram})
    before = c.get(f"/api/documents/{doc}").json()
    output = tool(mcp, "clone_diagram", {"doc_id": doc, "page_id": "p1",
                                         "expected_updated_at": before["meta"]["updated_at"]})
    after = c.get(f"/api/documents/{doc}").json()
    page = after["diagram"]["pages"][0]
    assert page["nodes"][:2] == before["diagram"]["pages"][0]["nodes"]
    assert page["edges"][0] == before["diagram"]["pages"][0]["edges"][0]
    assert after["diagram"]["pages"][1] == before["diagram"]["pages"][1]
    mapping = output["node_id_map"]
    assert page["nodes"][2]["id"] == mapping["a"]
    assert page["nodes"][2]["x"] >= 420
    assert page["nodes"][2]["groupId"] == page["nodes"][3]["groupId"] != "g1"
    edge = page["edges"][1]
    assert edge["source"]["nodeId"] == mapping["a"]
    assert edge["target"]["point"]["x"] == 180 + output["offset"]["x"]
    assert edge["waypoints"][0]["x"] == 120 + output["offset"]["x"]
    assert edge["labels"][0]["id"] != "label"
    # The save is attributed to the agent in version history.
    assert c.get(f"/api/documents/{doc}/versions").json()[0]["author_name"] == "MCP agent"
    # A fresh non-destructive clone must not be blocked by another autosave.
    tool(mcp, "clone_diagram", {"doc_id": doc, "page_id": "p1",
                                "expected_updated_at": before["meta"]["updated_at"]})
    assert c.get(f"/api/documents/{doc}").json()["diagram"]["pages"][0]["nodes"][:2] \
        == before["diagram"]["pages"][0]["nodes"]


def test_save_precondition_is_checked_inside_serialized_write(env):
    _, c, _, doc = env
    before = c.get(f"/api/documents/{doc}").json()
    body = {"svg": before["svg"], "diagram": before["diagram"],
            "expected_updated_at": before["meta"]["updated_at"]}
    barrier = threading.Barrier(2)

    def save(_):
        barrier.wait(timeout=5)
        return c.put(f"/api/documents/{doc}", json=body).status_code

    with ThreadPoolExecutor(2) as pool:
        assert sorted(pool.map(save, range(2))) == [200, 409]


def test_capture_returns_mcp_image_and_rejects_stale_revision(env, monkeypatch):
    _, c, mcp, doc = env
    before = c.get(f"/api/documents/{doc}").json()
    # A renderer stub verifies transport/version handling independently of Chromium.
    _stub_png(monkeypatch)
    result = call(mcp, "capture_board", {"doc_id": doc, "expected_updated_at": before["meta"]["updated_at"]})
    assert not result["isError"], result
    assert result["content"][1]["type"] == "image"
    assert result["content"][1]["mimeType"] == "image/png"
    assert "png_base64" not in result["structuredContent"]
    assert result["structuredContent"]["visual_validation"] == "pending_image_inspection"
    c.put(f"/api/documents/{doc}", json={"svg": "<svg/>", "diagram": before["diagram"]})
    assert c.post(f"/api/documents/{doc}/capture", json={
        "expected_updated_at": before["meta"]["updated_at"]}).status_code == 409


def test_capture_without_revision_returns_just_the_current_picture(env, monkeypatch):
    _, _, mcp, doc = env
    _stub_png(monkeypatch)
    result = call(mcp, "capture_board", {"doc_id": doc})
    assert not result["isError"], result
    assert [part["type"] for part in result["content"]] == ["text", "image"]
    assert "diagram" not in result["structuredContent"]


def test_capture_needs_view_access_and_a_diagram(env, monkeypatch, tmp_path):
    app, c, _, doc = env

    def forbidden_render(page):
        pytest.fail("Renderer must not receive unauthorized board data")

    monkeypatch.setattr("app.services.diagram_capture.capture_diagram", forbidden_render)
    # Legacy "private" rows grant nothing to anyone (services/auth.py::can).
    service = app.state.document_service
    meta = service.create("<svg/>", "legacy", diagram={"nodes": [], "edges": []}, link_policy="private")
    assert c.post(f"/api/documents/{meta.id}/capture", json={}).status_code == 403
    blank = c.post("/api/documents/new", json={"name": "blank"}).json()["id"]
    assert c.post(f"/api/documents/{blank}/capture", json={}).status_code == 422
    assert c.post("/api/documents/000000000000/capture", json={}).status_code == 404


def test_capture_without_a_browser_is_503(env, monkeypatch):
    _, c, _, doc = env

    def unavailable(page):
        from app.services.diagram_capture import CaptureUnavailable
        raise CaptureUnavailable("PNG capture is unavailable: browser or editor capture bundle is missing.")

    monkeypatch.setattr("app.services.diagram_capture.capture_diagram", unavailable)
    res = c.post(f"/api/documents/{doc}/capture", json={})
    assert res.status_code == 503 and "unavailable" in res.json()["detail"]


def test_capture_rejects_a_board_changed_while_rendering(env, monkeypatch):
    _, c, _, doc = env
    before = c.get(f"/api/documents/{doc}").json()

    def render_then_change(page):
        assert c.put(f"/api/documents/{doc}", json={
            "svg": before["svg"], "diagram": before["diagram"]}).status_code == 200
        return {"png_base64": "placeholder"}

    monkeypatch.setattr("app.services.diagram_capture.capture_diagram", render_then_change)
    assert c.post(f"/api/documents/{doc}/capture", json={
        "expected_updated_at": before["meta"]["updated_at"]}).status_code == 409


@pytest.mark.skipif(not (shutil.which("chromium") or shutil.which("chromium-browser")
                         or Path("/Applications/Google Chrome.app").exists()),
                    reason="Chromium required for real editor-render PNG")
def test_real_capture_has_pixels_and_cannot_run_board_text_as_script():
    from app.config import REPO_ROOT
    from app.services.diagram_capture import capture_diagram
    if not (REPO_ROOT / "web/dist/capture.js").exists():
        pytest.skip("Build frontend capture bundle first")
    result = capture_diagram({"nodes": [{"id": "n", "kind": "rect", "x": 0, "y": 0,
        "w": 220, "h": 80, "text": '</script><script>document.body.innerHTML="owned"</script>',
        "fill": "#ffffff", "stroke": "#2d3142", "strokeWidth": 1}], "edges": []})
    assert base64.b64decode(result["png_base64"]).startswith(b"\x89PNG\r\n\x1a\n")
    assert result["renderer"] == "editor-react"
    assert result["width"] > 200


def test_get_board_svg_is_withheld_for_one_page_of_a_multi_page_board():
    class Stub:
        def board_url(self, doc_id):
            return "https://example.invalid/d/" + doc_id

    doc = {"meta": {"name": "x", "updated_at": 1.0}, "svg": "<svg>page two</svg>",
           "diagram": {"pages": [{"id": "p1", "nodes": [], "edges": []},
                                 {"id": "p2", "nodes": [], "edges": []}]}}
    one = core().summarize_board(Stub(), "0123456789ab", doc, "p1", include_svg=True)
    assert "svg" not in one and "capture_board" in one["svg_note"]
    whole = core().summarize_board(Stub(), "0123456789ab", doc, None, include_svg=True)
    assert whole["svg"] == "<svg>page two</svg>"


def test_post_save_check_reports_manual_edits_and_layout_issues():
    def box(i, x, y, w=100, h=60, text="Box", fill="#fff"):
        return dict(id=i, kind="rect", x=x, y=y, w=w, h=h, text=text, fill=fill, stroke="#000")

    base = {"pages": [{"id": "p1", "nodes": [box("a", 0, 0)], "edges": []},
                      {"id": "p2", "nodes": [box("q", 0, 0), box("r", 50, 30)], "edges": []}]}
    sent = {"pages": [{"id": "p1", "nodes": [box("a", 0, 0), box("b", 60, 20),
                                             box("frame", -40, -40, 400, 300, text="", fill="transparent")],
                       "edges": [{"id": "e", "source": {"kind": "port", "nodeId": "a"},
                                  "target": {"kind": "port", "nodeId": "gone"}}]},
                      base["pages"][1]]}
    saved = copy.deepcopy(sent)
    saved["pages"][0]["nodes"].append(box("human", 500, 500, text=""))   # someone drew a shape
    check = core().post_save_check(base, sent, saved)
    assert check["manual_changes"] == [{"page_id": "p1", "change": "added", "ids": ["human"],
                                        "label": "<empty rect>"}]
    kinds = sorted((i["type"], tuple(i["ids"]), i["yours"]) for i in check["issues"])
    # The frame around its children is fine; p2's pre-existing overlap is untouched, so not reported.
    # The person's empty unconnected shape is a stray, but not the agent's to delete (yours=False).
    assert kinds == [("dangling_edge", ("e",), True), ("overlap", ("a", "b"), True),
                     ("stray_shape", ("human",), False)]
    assert check["error_count"] == 3
    clean = core().post_save_check(base, base, base)
    assert clean["manual_changes"] == [] and clean["issues"] == []


def test_lint_detects_common_layout_defects():
    def n(i, x, y, w=120, h=60, text="Box", **kw):
        return {"id": i, "kind": kw.pop("kind", "rect"), "x": x, "y": y, "w": w, "h": h, "text": text,
                "fill": kw.pop("fill", "#fff"), "stroke": kw.pop("stroke", "#000"), **kw}

    def link(i, a, b):
        return {"id": i, "source": {"kind": "port", "nodeId": a}, "target": {"kind": "port", "nodeId": b}}

    page = {"id": "p", "nodes": [
        n("frame", 0, 0, 600, 400, text="", fill="transparent"),
        n("a", 40, 40), n("b", 240, 43),                              # row off by 3px -> misaligned
        n("dup1", 40, 200, kind="icon", iconKey="aws-s3", text="s3"),
        n("dup2", 42, 202, kind="icon", iconKey="aws-s3", text="s3"),  # stacked copy
        n("long", 240, 200, w=60, text="a very long label that cannot fit"),
        n("lbl", 50, 50, w=100, h=24, text="caption", fill="transparent", stroke="transparent"),  # on 'a'
        n("edge_of_frame", 560, 300),                                  # across the frame's right border
        n("dot", 900, 900, w=4, h=4, text=""),                         # accidental click-drag
        n("lonely", 900, 40, text="Lonely"),                           # unconnected, outside frames
        n("empty_frame", 1200, 0, 300, 200, text="", fill="transparent"),
    ], "edges": [link("e1", "a", "b"), link("e2", "a", "b")]}
    found = {(i["type"], tuple(i["ids"])) for i in core()._page_issues(page)}
    for expected in [("misaligned", ("a", "b")), ("duplicate", ("dup1", "dup2")),
                     ("text_overflow", ("long",)), ("text_overlap", ("lbl", "a")),
                     ("straddles_frame", ("edge_of_frame", "frame")), ("tiny_shape", ("dot",)),
                     ("orphan", ("lonely",)), ("empty_container", ("empty_frame",)),
                     ("duplicate_edge", ("e1", "e2"))]:
        assert expected in found, (expected, sorted(found))
    issues = core()._page_issues(page)
    assert all(i["fix"] and i["severity"] in ("error", "warning") for i in issues)
    assert [i["severity"] for i in issues] == sorted(i["severity"] for i in issues)  # errors first
    clean = {"id": "p", "nodes": [n("frame", 0, 0, 600, 300, text="", fill="transparent"),
                                  n("a", 40, 100), n("b", 300, 100)], "edges": [link("e", "a", "b")]}
    assert core()._page_issues(clean) == []


def test_route_lint_flags_lines_through_shapes_and_text_but_not_frames_or_endpoints():
    def n(i, x, y, w=120, h=60, text="Box", **kw):
        return {"id": i, "kind": "rect", "x": x, "y": y, "w": w, "h": h, "text": text,
                "fill": kw.get("fill", "#fff"), "stroke": kw.get("stroke", "#000")}

    page = {"id": "p", "nodes": [n("a", 0, 0), n("b", 600, 0), n("block", 300, 0),
                                 n("frame", -40, -40, 900, 200, text="", fill="transparent"),
                                 n("note", 300, 100, w=120, h=24, text="note", fill="transparent",
                                   stroke="transparent")],
            "edges": [{"id": "e", "source": {"kind": "port", "nodeId": "a"},
                       "target": {"kind": "port", "nodeId": "b"}, "labels": [{"text": "sync"}]},
                      {"id": "f", "source": {"kind": "port", "nodeId": "a"},
                       "target": {"kind": "port", "nodeId": "b"}}]}
    straight = [[x, 30] for x in range(120, 601, 6)]            # a -> b through 'block'
    below = [[x, 112] for x in range(120, 601, 6)]              # through the 'note' label
    found = {(i["type"], tuple(i["ids"])) for i in core()._route_issues(page, {"e": straight, "f": below})}
    assert found == {("edge_crosses_shape", ("e", "block")), ("edge_crosses_text", ("f", "note"))}
    grazing = [[x, 4] for x in range(120, 601, 6)]              # rides an outline: not a crossing
    assert core()._route_issues(page, {"e": grazing}) == []


def test_lint_board_checks_rendered_routes_and_capture_hides_them(env, monkeypatch):
    _, c, mcp, doc = env

    def box(i, x):
        return {"id": i, "kind": "rect", "x": x, "y": 0, "w": 120, "h": 60, "text": i,
                "fill": "#fff", "stroke": "#000", "strokeWidth": 1}

    diagram = {"pages": [{"id": "p1", "name": "P", "nodes": [box("a", 0), box("mid", 300), box("b", 600)],
                          "edges": [{"id": "e", "source": {"kind": "port", "nodeId": "a", "rel": {"x": 1, "y": 0.5}},
                                     "target": {"kind": "port", "nodeId": "b", "rel": {"x": 0, "y": 0.5}},
                                     "routing": "straight", "stroke": "#000", "strokeWidth": 1,
                                     "endArrow": True, "startArrow": False, "animated": False}]}]}
    before = c.get(f"/api/documents/{doc}").json()
    assert c.put(f"/api/documents/{doc}", json={"svg": before["svg"], "diagram": diagram}).status_code == 200
    _stub_png(monkeypatch, edge_routes={"e": [[x, 30] for x in range(120, 601, 6)]})
    lint = tool(mcp, "lint_board", {"doc_id": doc})
    assert lint["routes_checked"] == ["p1"]
    assert any(i["type"] == "edge_crosses_shape" and i["ids"] == ["e", "mid"] for i in lint["issues"])
    shot = tool(mcp, "capture_board", {"doc_id": doc, "page_id": "p1"})
    assert "edge_routes" not in shot

    def unavailable(page):
        from app.services.diagram_capture import CaptureUnavailable
        raise CaptureUnavailable("no browser")

    monkeypatch.setattr("app.services.diagram_capture.capture_diagram", unavailable)
    lint = tool(mcp, "lint_board", {"doc_id": doc})
    assert lint["routes_unchecked"] == ["p1"] and "NOT checked" in lint["note"]
