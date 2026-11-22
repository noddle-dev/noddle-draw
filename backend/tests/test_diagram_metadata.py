"""Three-level semantic diagram metadata + fast semantic reads + MCP Apps preview.

* diagram ``metadata`` / page ``metadata`` / node+edge ``meta`` round-trip through
  DocumentService, the three-way merge and the AI normalizer;
* MCP ``create_board`` / ``patch_board`` write it (``role`` is kept as ``meta.role``);
* ``read_board_summary`` returns a geometry-free semantic graph for rich AND legacy boards;
* the ``ui://noddle/preview`` MCP Apps resource is listed, readable and wired to tools;
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess

import pytest
from fastapi.testclient import TestClient

from app.api.schemas import BLANK_BOARD_SVG
from app.config import Settings
from app.domain.diagram_merge import merge_diagrams
from app.domain.diagram_metadata import (
    sanitize_diagram_metadata,
    sanitize_object_meta,
    sanitize_page_metadata,
)
from app.main import create_app
from app.services.ai import AIService
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


GEOMETRY_KEYS = {"x", "y", "w", "h", "fill", "stroke", "waypoints"}




def call(c, b, name, arguments):
    return mcp_call(b, name, arguments)


def node(nid, kind="rounded", x=0, y=0, w=140, h=60, text="", fill="#dbeafe", stroke="#2563eb", **kw):
    return {"id": nid, "kind": kind, "x": x, "y": y, "w": w, "h": h, "text": text,
            "fill": fill, "stroke": stroke, "strokeWidth": 2, **kw}


def edge(eid, src, tgt, label=None, **kw):
    e = {"id": eid, "source": {"kind": "floating", "nodeId": src},
         "target": {"kind": "floating", "nodeId": tgt}, "routing": "elbow", "stroke": "#2d3142",
         "strokeWidth": 2, "endArrow": True, "startArrow": False, "animated": False, **kw}
    if label:
        e["label"] = label
    return e


RICH = {
    "metadata": {"category": "architecture", "summary": "Card checkout: web to PSP.",
                 "domain": "payments", "tags": ["pci", "checkout"], "owner": "payments-team",
                 "version": "3", "links": [{"label": "Runbook", "url": "https://wiki.example/run"}],
                 "custom": {"tier": 1, "regulated": True}},
    "pages": [{
        "id": "p1", "name": "Overview",
        "metadata": {"summary": "Happy path.", "tags": ["v3"], "notes": "PSP is Stripe.",
                     "custom": {"reviewed": True}},
        "nodes": [
            node("web", text="Web App", meta={"role": "client", "tech": "react", "group": "Edge"}),
            node("api", x=200, text="Checkout API", meta={"role": "service", "tech": "go", "group": "Core"}),
            node("db", kind="cylinder", x=400, text="Orders DB",
                 meta={"role": "database", "tech": "postgres", "group": "Core", "tags": ["pii"]}),
        ],
        "edges": [
            edge("e1", "web", "api", "HTTPS", meta={"protocol": "HTTPS", "sla": "99.9%"}),
            edge("e2", "api", "db", meta={"protocol": "SQL"}),
        ],
    }],
}


def _keys(obj):
    """Every dict key anywhere in a JSON value."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield k
            yield from _keys(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from _keys(v)


# --- 1. domain: sanitizers, DocumentService, merge, ops, AI normalizer -----------------


def test_sanitizers_bound_and_strip_invalid_entries():
    raw = {f"k{i}": i for i in range(30)}
    assert len(sanitize_object_meta(raw)) == 20
    out = sanitize_object_meta({
        "role": "db", "": "x", "k" * 65: "too long", 7: "non-str key", "nested": {"a": 1},
        "nan": float("nan"), "none": None, "list": list(range(30)) + [{"bad": 1}],
        "mixed": ["a", 1, True, None, ["deep"]], "long": "v" * 900, "ok": False,
    })
    assert out == {"role": "db", "list": list(range(20)), "mixed": ["a", 1, True],
                   "long": "v" * 500, "ok": False}
    assert sanitize_object_meta("junk") == {} and sanitize_object_meta(None) == {}

    dm = sanitize_diagram_metadata({
        "category": " architecture ", "summary": "", "tags": ["a", "a", "", 3, "b"],
        "links": [{"label": "x", "url": "javascript:alert(1)"}, {"url": "https://ok.example"},
                  "junk"],
        "unknown": "dropped", "custom": {"n": 1, "bad": {"x": 1}},
    })
    assert dm == {"category": "architecture", "tags": ["a", "b"],
                  "links": [{"label": "https://ok.example", "url": "https://ok.example"}],
                  "custom": {"n": 1}}
    assert sanitize_page_metadata({"notes": "n", "domain": "page has no domain"}) == {"notes": "n"}
    assert sanitize_diagram_metadata({"unknown": 1}) == {}


def test_document_service_roundtrips_every_level(env):
    app, *_ = env
    svc = app.state.document_service
    meta = svc.create(BLANK_BOARD_SVG, "Rich", diagram=json.loads(json.dumps(RICH)))
    stored = svc.get(meta.id).diagram
    assert stored == RICH  # already-clean metadata survives byte-for-byte

    # a save with a read base keeps everything; a pure-geometry change merges in
    desired = json.loads(json.dumps(RICH))
    desired["pages"][0]["nodes"][0]["x"] = 40
    svc.save(meta.id, BLANK_BOARD_SVG, diagram=desired, base_diagram=json.loads(json.dumps(RICH)))
    after = svc.get(meta.id).diagram
    assert after["metadata"] == RICH["metadata"]
    assert after["pages"][0]["metadata"] == RICH["pages"][0]["metadata"]
    assert after["pages"][0]["nodes"][0]["meta"] == RICH["pages"][0]["nodes"][0]["meta"]
    assert after["pages"][0]["edges"][0]["meta"] == RICH["pages"][0]["edges"][0]["meta"]

    # legacy single-page shape may carry root metadata too
    legacy = svc.create(BLANK_BOARD_SVG, "Legacy", diagram={
        "metadata": {"summary": "flat", "bogus": 1}, "nodes": [node("a")], "edges": []})
    assert svc.get(legacy.id).diagram["metadata"] == {"summary": "flat"}

    # live collab page writes keep the root metadata (apply_live_page rebuilds pages)
    svc.begin_live(meta.id)
    svc.apply_live_page(meta.id, "p1", {"nodes": [node("web", text="Web")], "edges": []})
    assert svc.get_live(meta.id).diagram["metadata"] == RICH["metadata"]
    assert svc.get_live(meta.id).diagram["pages"][0]["metadata"] == RICH["pages"][0]["metadata"]
    svc.end_live(meta.id)


def test_validate_diagram_sanitizes_metadata(env):
    app, *_ = env
    svc = app.state.document_service
    m = svc.create(BLANK_BOARD_SVG, "X", diagram={
        "metadata": {"summary": "ok", "links": [{"label": "x", "url": "javascript:alert(1)"}]},
        "pages": [{"id": "p1", "name": "P", "metadata": {"notes": "ok", "evil": "<script>"},
                   "nodes": [], "edges": []}]})
    d = svc.get(m.id).diagram
    assert d["metadata"] == {"summary": "ok"}
    assert d["pages"][0]["metadata"] == {"notes": "ok"}
    empty = svc.create(BLANK_BOARD_SVG, "Y", diagram={"metadata": {}, "pages": [
        {"id": "p1", "name": "P", "metadata": "junk", "nodes": [], "edges": []}]})
    d = svc.get(empty.id).diagram
    assert "metadata" not in d and "metadata" not in d["pages"][0]


def test_merge_diagrams_three_way_metadata():
    base = {"metadata": {"summary": "v1"}, "pages": [
        {"id": "p1", "name": "P", "metadata": {"notes": "n1"}, "nodes": [], "edges": []}]}
    # a peer (current) changed the owner and the page notes; we (desired) changed the summary
    current = {"metadata": {"summary": "v1", "owner": "peer"}, "pages": [
        {"id": "p1", "name": "P", "metadata": {"notes": "peer notes"}, "nodes": [], "edges": []}]}
    desired = {"metadata": {"summary": "v2"}, "pages": [
        {"id": "p1", "name": "P", "metadata": {"notes": "n1"}, "nodes": [], "edges": []}]}
    out = merge_diagrams(base, desired, current)
    assert out["metadata"] == {"summary": "v2", "owner": "peer"}
    assert out["pages"][0]["metadata"] == {"notes": "peer notes"}  # untouched by us → kept

    # a writer that never saw metadata (stale client) never drops it
    stale = merge_diagrams({"pages": base["pages"]}, {"pages": base["pages"]}, current)
    assert stale["metadata"] == current["metadata"]

    # an explicit removal is a write
    removed = merge_diagrams(base, {"pages": base["pages"]}, base)
    assert "metadata" not in removed

    # legacy shape: root metadata is NOT wrapped into "Page 1"
    legacy = merge_diagrams({"nodes": [], "edges": []},
                            {"metadata": {"summary": "s"}, "nodes": [], "edges": []},
                            {"nodes": [], "edges": []})
    assert legacy == {"metadata": {"summary": "s"}, "nodes": [], "edges": []}



def test_ai_normalizer_sanitizes_and_roundtrips_meta():
    page = json.loads(json.dumps(RICH["pages"][0]))
    page["nodes"][0]["meta"]["nested"] = {"x": 1}
    page["nodes"][0]["meta"]["many"] = list(range(40))
    nodes, edges = AIService._normalize_full_diagram(page)
    web = next(n for n in nodes if n["id"] == "web")
    assert web["meta"] == {**RICH["pages"][0]["nodes"][0]["meta"], "many": list(range(20))}
    assert next(e for e in edges if e["id"] == "e1")["meta"] == {"protocol": "HTTPS", "sla": "99.9%"}
    bare, _ = AIService._normalize_full_diagram({"nodes": [node("n", meta="junk")], "edges": []})
    assert "meta" not in bare[0]


# --- 2. MCP writes ------------------------------------------------------------------------


def test_create_board_writes_metadata_and_records_role(env):
    _, c, agent, _, client = env
    b = agent()
    res = call(c, b, "create_board", {
        "name": "Arch", "category": "architecture",
        "metadata": {"summary": "Checkout path.", "tags": ["pci"], "domain": "payments"},
        "diagram": {"pages": [{"id": "p1", "name": "P1", "nodes": [
            {"id": "web", "kind": "rounded", "x": 40, "y": 100, "w": 120, "h": 56, "text": "Web",
             "role": "client"},
            {"id": "db", "kind": "cylinder", "x": 300, "y": 100, "w": 120, "h": 64, "text": "DB",
             "role": "database", "meta": {"tech": "postgres", "role": "overridden"}},
        ], "edges": [{"id": "e1", "source": {"kind": "floating", "nodeId": "web"},
                      "target": {"kind": "floating", "nodeId": "db"}, "role": "sync"}]}]},
    })
    assert not res["isError"], res
    saved = client.get(f"/api/documents/{res['structuredContent']['id']}").json()["diagram"]
    assert saved["metadata"] == {"category": "architecture", "summary": "Checkout path.",
                                 "domain": "payments", "tags": ["pci"]}
    by = {n["id"]: n for n in saved["pages"][0]["nodes"]}
    assert by["web"]["meta"] == {"role": "client"} and "role" not in by["web"]
    assert by["db"]["meta"] == {"tech": "postgres", "role": "database"}  # shorthand wins, tech kept
    assert by["web"]["stroke"] == "#2563eb"  # role still drives the color
    assert saved["pages"][0]["edges"][0]["meta"] == {"role": "sync"}

    # explicit metadata.category wins over the category param; metadata alone creates a board
    res = call(c, b, "create_board", {"name": "Meta only", "category": "data",
                                        "metadata": {"category": "custom-cat"}})
    saved = client.get(f"/api/documents/{res['structuredContent']['id']}").json()["diagram"]
    assert saved["metadata"] == {"category": "custom-cat"}


def test_patch_board_metadata_page_metadata_and_node_meta(env):
    _, c, agent, doc, client = env
    b = agent()
    read = call(c, b, "get_board", {"doc_id": doc})["structuredContent"]
    res = call(c, b, "patch_board", {
        "doc_id": doc, "edit_revision": read["edit_revision"],
        "metadata": {"summary": "Flow board", "tags": ["demo"], "owner": "ops"},
        "page_metadata": {"notes": "first page"},
        "ops": [
            {"op": "update", "node": {"id": "n1", "role": "service", "meta": {"tech": "go"}}},
            {"op": "add", "node": {"id": "n2", "kind": "cylinder", "x": 300, "y": 0, "w": 100, "h": 60,
                                   "text": "DB", "meta": {"layer": "data"}}},
            {"op": "add", "edge": {"id": "e1", "source": {"kind": "floating", "nodeId": "n1"},
                                   "target": {"kind": "floating", "nodeId": "n2"},
                                   "meta": {"protocol": "SQL"}}},
        ],
    })
    assert not res["isError"], res
    d = client.get(f"/api/documents/{doc}").json()["diagram"]
    assert d["metadata"] == {"summary": "Flow board", "tags": ["demo"], "owner": "ops"}
    page = (d.get("pages") or [d])[0]
    assert page["metadata"] == {"notes": "first page"}
    by = {n["id"]: n for n in page["nodes"]}
    assert by["n1"]["meta"] == {"tech": "go", "role": "service"} and "role" not in by["n1"]
    assert by["n2"]["meta"] == {"layer": "data"}
    assert page["edges"][0]["meta"] == {"protocol": "SQL"}

    # set_metadata op + key removal + per-key meta merge, no other ops needed
    rev = res["structuredContent"]["edit_revision"]
    res = call(c, b, "patch_board", {"doc_id": doc, "edit_revision": rev, "ops": [
        {"op": "set_metadata", "metadata": {"owner": None, "category": "flowchart"}},
        {"op": "set_metadata", "page_id": page["id"], "metadata": {"summary": "p-sum"}},
        {"op": "update", "node": {"id": "n1", "meta": {"tech": None, "status": "live"}}},
    ]})
    assert not res["isError"], res
    d = client.get(f"/api/documents/{doc}").json()["diagram"]
    page = d["pages"][0]
    assert d["metadata"] == {"summary": "Flow board", "tags": ["demo"], "category": "flowchart"}
    assert page["metadata"] == {"notes": "first page", "summary": "p-sum"}
    assert {n["id"]: n for n in page["nodes"]}["n1"]["meta"] == {"role": "service", "status": "live"}

    rev = res["structuredContent"]["edit_revision"]
    only_meta = call(c, b, "patch_board", {"doc_id": doc, "edit_revision": rev,
                                             "metadata": {"version": "2"}})
    assert not only_meta["isError"], only_meta
    assert client.get(f"/api/documents/{doc}").json()["diagram"]["metadata"]["version"] == "2"
    empty = call(c, b, "patch_board", {"doc_id": doc})
    assert empty["isError"] and "nothing to apply" in empty["content"][0]["text"]


def test_get_board_returns_metadata_full_compact_and_page(env):
    _, c, agent, _, client = env
    b = agent()
    doc = client.post("/api/documents/new", json={"name": "Rich", "diagram": RICH}).json()["id"]
    for args in ({}, {"compact": True}, {"page_id": "p1"}, {"page_id": "p1", "compact": True}):
        sc = call(c, b, "get_board", {"doc_id": doc, **args})["structuredContent"]
        assert sc["metadata"] == RICH["metadata"], args
        assert sc["diagram"]["metadata"] == RICH["metadata"], args
        assert sc["pages"][0]["metadata"] == RICH["pages"][0]["metadata"], args
        nodes = sc["diagram"]["pages"][0]["nodes"]
        assert nodes[0]["meta"] == RICH["pages"][0]["nodes"][0]["meta"], args


# --- 3. read_board_summary ---------------------------------------------------------------


def test_read_board_summary_on_metadata_rich_board(env):
    _, c, agent, _, client = env
    b = agent()  # read bases are bound to the backend identity (origin + agent name)
    doc = client.post("/api/documents/new", json={"name": "Rich", "diagram": RICH}).json()["id"]
    res = call(c, b, "read_board_summary", {"doc_id": doc})
    assert not res["isError"], res
    sc = res["structuredContent"]
    assert not GEOMETRY_KEYS & set(_keys(sc)), "summary must carry zero geometry"
    assert sc["metadata"] == RICH["metadata"]
    assert sc["preview_url"].endswith(f"/embed/{doc}") and sc["url"].endswith(f"/d/{doc}")
    assert sc["edit_revision"]
    page = sc["pages"][0]
    assert page["metadata"] == RICH["pages"][0]["metadata"]
    assert (page["node_count"], page["edge_count"]) == (3, 2)
    groups = {g["label"]: g for g in page["groups"]}
    assert groups["Core"]["members"] == ["api", "db"] and groups["Edge"]["members"] == ["web"]
    by = {n["id"]: n for n in page["nodes"]}
    assert by["db"] == {"id": "db", "text": "Orders DB", "kind": "cylinder", "group": "group:Core",
                        "meta": RICH["pages"][0]["nodes"][2]["meta"]}
    assert page["flows"] == ["Web App --[HTTPS]--> Checkout API", "Checkout API --> Orders DB"]
    assert {e["id"]: e["meta"] for e in page["edges"]} == {
        "e1": {"protocol": "HTTPS", "sla": "99.9%"}, "e2": {"protocol": "SQL"}}
    assert "inferred" not in page  # explicit roles, no frames

    # the returned edit_revision is a usable read base
    w = call(c, b, "patch_board", {"doc_id": doc, "edit_revision": sc["edit_revision"],
                                            "metadata": {"version": "4"}})
    assert not w["isError"], w

    bad = call(c, b, "read_board_summary", {"doc_id": doc, "page_id": "nope"})
    assert bad["isError"] and "not found" in bad["content"][0]["text"]


def _legacy_board():
    """A typical metadata-free board as the editor writes it (full style fields)."""
    style = {"sketch": True, "cornerRadius": 12, "fontSize": 14, "textColor": "#2d3142", "bold": False,
             "fontFamily": "sans", "textAlign": "center", "wrap": True, "opacity": 1}
    nodes = [
        node("title", "rect", 40, 8, 300, 32, "Checkout Platform", fill="transparent",
             stroke="transparent", **style),
        node("vpc", "rect", 20, 60, 760, 300, "", fill="transparent", stroke="#2d3142",
             strokeDash="dashed", **style),
        node("vpct", "rect", 36, 70, 160, 24, "AWS VPC", fill="transparent", stroke="transparent", **style),
        node("web", "rounded", 40, 120, 140, 60, "Web App", **style),
        node("api", "rounded", 240, 120, 140, 60, "Checkout API", **style),
        node("pay", "rounded", 440, 120, 140, 60, "Payment Service", **style),
        node("db", "cylinder", 620, 120, 120, 80, "Orders DB", **style),
        node("q", "queue", 440, 260, 140, 60, "Events Queue", **style),
        node("psp", "cloud", 860, 120, 140, 80, "Stripe", **style),
        node("doodle", "line", 0, 400, 60, 60, ""),
    ]
    edges = [edge("e1", "web", "api", "HTTPS", waypoints=[{"x": 200, "y": 150}], z=3),
             edge("e2", "api", "pay", "gRPC", z=4), edge("e3", "api", "db", z=5),
             edge("e4", "pay", "q", "publish", z=6), edge("e5", "pay", "psp", "REST", z=7),
             edge("e6", "q", "api", labels=[{"id": "l1", "t": 0.5, "text": "retry"}],
                  startArrow=True, z=8)]
    for i, n in enumerate(nodes):
        n["z"] = i
    return {"nodes": nodes, "edges": edges}


def test_read_board_summary_infers_groups_flows_roles_on_legacy_board(env):
    _, c, agent, _, client = env
    b = agent()
    doc = client.post("/api/documents/new", json={"name": "Legacy", "diagram": _legacy_board()}).json()["id"]
    sc = call(c, b, "read_board_summary", {"doc_id": doc})["structuredContent"]
    assert "metadata" not in sc
    assert not GEOMETRY_KEYS & set(_keys(sc))
    page = sc["pages"][0]
    assert page["id"] == "p1" and page["node_count"] == 10 and page["edge_count"] == 6
    # the frame is a group titled by its inside label (not by the board title above it)
    assert page["groups"] == [{"id": "vpc", "label": "AWS VPC",
                               "members": ["web", "api", "pay", "db", "q"]}]
    by = {n["id"]: n for n in page["nodes"]}
    assert "vpc" not in by and "vpct" not in by and "doodle" not in by  # group / title / decoration
    assert page["omitted_decorations"] == 1
    assert by["db"]["meta"] == {"role": "database"} and by["db"]["group"] == "vpc"
    assert by["q"]["meta"] == {"role": "queue"}
    assert by["psp"]["meta"] == {"role": "external"} and "group" not in by["psp"]
    assert by["title"]["meta"] == {"role": "label"}
    assert "meta" not in by["web"]  # a plain box has no inferable role
    assert page["flows"] == [
        "Web App --[HTTPS]--> Checkout API",
        "Checkout API --[gRPC]--> Payment Service",
        "Checkout API --> Orders DB",
        "Payment Service --[publish]--> Events Queue",
        "Payment Service --[REST]--> Stripe",
        "Events Queue <--[retry]--> Checkout API",
    ]
    assert set(page["inferred"]) == {"groups", "roles"}

    # compact: a few hundred tokens, far below the geometry-carrying reads
    summary = len(json.dumps(sc))
    full = len(json.dumps(call(c, b, "get_board", {"doc_id": doc})["structuredContent"]))
    compact = len(json.dumps(call(c, b, "get_board", {"doc_id": doc, "compact": True})["structuredContent"]))
    assert summary < 2000, summary  # ≈ 400 tokens at ~4 chars/token
    assert summary < full * 0.35 and summary < compact * 0.4, (summary, compact, full)

    only = call(c, b, "read_board_summary", {"doc_id": doc, "page_id": "p1"})["structuredContent"]
    assert [p["id"] for p in only["pages"]] == ["p1"]


def test_read_board_summary_multi_page_duplicates_and_groupid(env):
    _, c, agent, _, client = env
    b = agent()
    diagram = {"pages": [
        {"id": "a", "name": "A", "nodes": [node("x1", text="Worker", groupId="g"),
                                           node("x2", x=200, text="Worker", groupId="g")],
         "edges": [edge("e", "x1", "x2", endArrow=False)]},
        {"id": "b", "name": "B", "hidden": True, "nodes": [], "edges": []},
    ]}
    doc = client.post("/api/documents/new", json={"name": "M", "diagram": diagram}).json()["id"]
    sc = call(c, b, "read_board_summary", {"doc_id": doc})["structuredContent"]
    a, b = sc["pages"]
    assert a["groups"] == [{"id": "g", "label": "", "members": ["x1", "x2"]}]
    assert a["flows"] == ["Worker #x1 -- Worker #x2"]  # duplicate labels disambiguated, no heads
    assert b["hidden"] is True and b["nodes"] == [] and b["flows"] == []


# --- 4. MCP Apps preview resource ---------------------------------------------------------


def test_preview_ui_resource_listed_readable_and_wired(env):
    _, c, agent, _, _ = env
    nm = core()
    listed = rpc(agent(), "resources/list")["result"]["resources"]
    ui = next(r for r in listed if r["uri"] == "ui://noddle/preview")
    assert ui["mimeType"] == "text/html;profile=mcp-app"

    # static template: publicly cacheable
    res = rpc(agent(), "resources/read", {"uri": "ui://noddle/preview"})["result"]
    assert res["cacheScope"] == "public"
    content = res["contents"][0]
    assert content["uri"] == "ui://noddle/preview" and content["mimeType"] == "text/html;profile=mcp-app"
    html = content["text"]
    assert html.lstrip().lower().startswith("<!doctype html>") and html.rstrip().endswith("</html>")
    # self-contained: no external scripts, styles, fonts or images
    assert not re.search(r"<(script|link|img|iframe)[^>]+(src|href)\s*=\s*[\"']https?:", html, re.I)
    assert "@import" not in html and "url(http" not in html
    # MCP Apps bridge + safe rendering
    for needle in ("ui/initialize", "ui/notifications/tool-result", "ui/open-link", "Open in noddle"):
        assert needle in html, needle
    assert "innerHTML" not in html and "eval(" not in html

    tools = {t["name"]: t for t in rpc(agent(), "tools/list")["result"]["tools"]}
    for name in ("capture_board", "create_board", "patch_board", "read_board_summary"):
        assert tools[name]["_meta"]["ui"]["resourceUri"] == "ui://noddle/preview", name
    assert "_meta" not in tools["get_board"]
    assert nm.PREVIEW_UI_URI == "ui://noddle/preview"


@pytest.mark.skipif(not shutil.which("node"), reason="node not installed")
def test_preview_ui_script_is_valid_javascript(tmp_path):
    html = core().PREVIEW_HTML
    script = re.search(r"<script>(.*?)</script>", html, re.S).group(1)
    f = tmp_path / "preview.js"
    f.write_text(script, encoding="utf-8")
    r = subprocess.run(["node", "--check", str(f)], capture_output=True, text=True, timeout=30)
    assert r.returncode == 0, r.stderr


def test_preview_ui_sizes_after_image_decode_and_fits_full_width():
    html = core().PREVIEW_HTML
    script = re.search(r"<script>(.*?)</script>", html, re.S).group(1)
    # height is re-reported once the base64 PNG has decoded (the old race left the iframe ~180px)
    assert '$("img").addEventListener("load", scheduleSize)' in script
    assert '$("img").addEventListener("error"' in script
    assert 'new ResizeObserver(reportSize).observe($("card"))' in script
    assert 'window.addEventListener("resize", reportSize)' in script
    assert "requestAnimationFrame(reportSize)" in script and "setTimeout(reportSize, 80)" in script
    # measured from the card's real box, not only the (host-clamped) document scrollHeight
    assert '$("card").getBoundingClientRect()' in script or "card.getBoundingClientRect()" in script
    assert '$("shot").hidden ? 140 : 460' in script
    # true aspect ratio reserved before decode, from capture width/height
    assert "img.style.aspectRatio" in script and "sc.capture" in script
    # full-width, image-first layout: no max-width cap, no separate bottom action bar
    assert "max-width: 880px" not in html and 'class="actions"' not in html
    assert 'id="card"' in html and "width: 100%" in html
    header = re.search(r"<header>(.*?)</header>", html, re.S).group(1)
    for needle in ('id="zoomOut"', 'id="zoomFit"', 'id="zoomIn"', "Open in noddle"):
        assert needle in header, needle
    assert "min-height: 380px" in html and "max-height: 760px" in html and "object-fit: contain" in html
    # Fit restores the whole-image view; zoom-in lets the figure scroll/pan
    assert 'img.style.width = "100%"; img.style.maxHeight = "760px"' in script
    assert 'img.style.width = pct + "%"; img.style.maxHeight = "none"' in script


def test_preview_ui_auto_captures_when_model_skipped_capture():
    script = re.search(r"<script>(.*?)</script>", core().PREVIEW_HTML, re.S).group(1)
    assert "/^[0-9a-f]{12}$/.test(sc.id)" in script
    assert 'captureReqId = request("tools/call", { name: "capture_board", arguments: args })' in script
    assert "include_lint: false" in script
    # the JSON-RPC response for that request is routed to the image renderer
    assert "m.id === captureReqId" in script and "onCaptureResult(m.result)" in script
    # one capture per board revision — no request loop on repeated tool-results
    assert "capturedKey" in script


@pytest.mark.skipif(not shutil.which("node"), reason="node not installed")
def test_preview_ui_auto_capture_round_trip(tmp_path):
    """Drive the widget script in node with a tiny fake DOM: a create_board result
    without an image must trigger capture_board via tools/call, and the response's
    PNG must land in #img with the capture's aspect ratio."""
    script = re.search(r"<script>(.*?)</script>", core().PREVIEW_HTML, re.S).group(1)
    harness = r"""
const els = {};
function el(id) {
  if (!els[id]) {
    const listeners = {};
    els[id] = {
      id, hidden: false, textContent: "", className: "", title: "", children: [], style: {}, attrs: {},
      scrollWidth: 800, scrollHeight: 500, clientWidth: 800, clientHeight: 500, scrollLeft: 0, scrollTop: 0,
      classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); } },
      addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); },
      fire(t, ev) { (listeners[t] || []).forEach(f => f(ev || {})); },
      setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; },
      appendChild(c) { this.children.push(c); },
      getBoundingClientRect() { return { width: 800, height: 520 }; },
    };
    Object.defineProperty(els[id], "src", { set(v) { this.attrs.src = v; }, get() { return this.attrs.src; } });
  }
  return els[id];
}
const winListeners = {};
const sent = [];
const parent = { postMessage(m) { sent.push(m); } };
global.window = { parent, addEventListener(t, f) { (winListeners[t] = winListeners[t] || []).push(f); } };
global.document = { getElementById: el, documentElement: { scrollWidth: 800, scrollHeight: 200 },
                    createElement: () => ({ textContent: "" }) };
global.requestAnimationFrame = f => f();
const fire = data => (winListeners.message || []).forEach(f => f({ source: parent, data }));
""" + script + r"""
fire({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: {
  structuredContent: { id: "0123456789ab", name: "MScFE", updated_at: 5, url: "https://draw.noddle.dev/d/0123456789ab",
                       pages: [{ node_count: 3, edge_count: 2 }] },
  content: [{ type: "text", text: "{}" }] } });
const call = sent.find(m => m.method === "tools/call");
if (!call) throw new Error("no capture_board call");
if (call.params.name !== "capture_board" || call.params.arguments.doc_id !== "0123456789ab"
    || call.params.arguments.include_lint !== false) throw new Error("bad call " + JSON.stringify(call));
if (els.shot.hidden || els.loading.hidden || !els.img.hidden) throw new Error("shot should show loading");
// a repeated result for the same revision must not re-request
fire({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: {
  structuredContent: { id: "0123456789ab", updated_at: 5 }, content: [] } });
if (sent.filter(m => m.method === "tools/call").length !== 1) throw new Error("duplicate capture request");
fire({ jsonrpc: "2.0", id: call.id, result: {
  structuredContent: { id: "0123456789ab", width: 2400, height: 900 },
  content: [{ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }] } });
if (els.img.src !== "data:image/png;base64,iVBORw0KGgo=") throw new Error("image not shown");
if (els.img.style.aspectRatio !== "2400 / 900") throw new Error("aspect " + els.img.style.aspectRatio);
if (els.img.hidden || els.shot.hidden || els.zoom.hidden) throw new Error("image/zoom hidden");
els.img.fire("load");
const sizes = sent.filter(m => m.method === "ui/notifications/size-changed").map(m => m.params.height);
if (Math.max(...sizes) < 460) throw new Error("size too small " + sizes);
els.zoomIn.fire("click");
if (els.img.style.width !== "125%" || els.img.style.maxHeight !== "none") throw new Error("zoom in");
els.zoomFit.fire("click");
if (els.img.style.width !== "100%" || els.img.style.maxHeight !== "760px") throw new Error("fit");
console.log("ok");
process.exit(0);  // the widget's 45s capture-timeout timer would keep node alive
"""
    f = tmp_path / "harness.js"
    f.write_text(harness, encoding="utf-8")
    r = subprocess.run(["node", str(f)], capture_output=True, text=True, timeout=30)
    assert r.returncode == 0 and r.stdout.strip() == "ok", r.stderr + r.stdout


def test_instructions_and_style_guide_mention_fast_reads():
    nm = core()
    assert "read_board_summary" in nm.INSTRUCTIONS and "metadata" in nm.INSTRUCTIONS
    assert "read_board_summary" in nm.STYLE_GUIDE_TEXT and "meta.role" in nm.STYLE_GUIDE_TEXT


