"""Dashboard thumbnail framing (``export.svg?fit=content`` → services/preview_fit).

The regression this guards: the old fit rewrote only the root viewBox and kept
``width="1600" height="1000"``, so every thumbnail kept the artboard's 1.6:1
intrinsic ratio — a tall tree was letterboxed into a thin strip and the card
could never detect (or frame) it.
"""
from __future__ import annotations

import re

from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.services.preview_fit import (
    FIT_MARGIN,
    THUMB_LONG_SIDE,
    content_box,
    fit_svg_to_content,
    pick_page,
)

ART = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000" width="1600" height="1000">'


def _root(svg: str) -> dict[str, str]:
    tag = re.match(r"<svg\b[^>]*>", svg).group(0)  # type: ignore[union-attr]
    return dict(re.findall(r'(?<=\s)([\w:-]+)="([^"]*)"', tag))


def _node(i, x, y, w=100, h=60, text="", kind="rect", **kw):
    return {"id": f"n{i}", "kind": kind, "x": x, "y": y, "w": w, "h": h, "text": text, **kw}


def test_intrinsic_size_follows_the_content_not_the_artboard():
    # A tall tree: 200 wide, 800 high — the card must see ~0.27:1, not 1.6:1.
    diagram = {"nodes": [_node(1, 300, 100, 200, 60), _node(2, 300, 840, 200, 60)]}
    out = fit_svg_to_content(ART + '<g id="noddle-diagram-baked"/></svg>', diagram)
    a = _root(out)
    vx, vy, vw, vh = map(float, a["viewBox"].split())
    assert (vx, vy) == (300 - FIT_MARGIN, 100 - FIT_MARGIN)
    assert (vw, vh) == (200 + 2 * FIT_MARGIN, 800 + 2 * FIT_MARGIN)
    w, h = float(a["width"]), float(a["height"])
    assert abs(w / h - vw / vh) < 0.01  # aspect ratio = content, not 1.6
    assert max(w, h) == THUMB_LONG_SIDE  # capped thumbnail size
    assert a["preserveAspectRatio"] == "xMidYMid meet"


def test_large_content_gets_legible_non_scaling_strokes_small_does_not():
    big = {"nodes": [_node(1, 0, 0), _node(2, 2900, 1400)]}
    out = fit_svg_to_content(ART + "</svg>", big)
    assert "non-scaling-stroke" in out
    assert out.index("<style") > out.index("<svg")  # inside the root
    small = {"nodes": [_node(1, 0, 0, 120, 80)]}
    out_small = fit_svg_to_content(ART + "</svg>", small)
    assert "non-scaling-stroke" not in out_small
    a = _root(out_small)
    assert float(a["width"]) == 120 + 2 * FIT_MARGIN  # never upscaled


def test_zero_size_and_transparent_nodes_do_not_stretch_the_frame():
    page = {
        "nodes": [
            _node(1, 100, 100),
            _node(2, 5000, 5000, w=0, h=0),
            _node(3, -4000, 50, opacity=0),
            {"id": "junk", "x": "nan?", "y": None},
        ]
    }
    assert content_box(page) == (100, 100, 200, 160)


def test_free_arrow_ends_and_waypoints_are_content():
    page = {
        "nodes": [_node(1, 0, 0)],
        "edges": [
            {
                "id": "e",
                "source": {"kind": "floating", "nodeId": "n1"},
                "target": {"kind": "free", "point": {"x": 640, "y": 20}},
                "waypoints": [{"x": 300, "y": -90}],
            }
        ],
    }
    assert content_box(page) == (0, -90, 640, 60)


def test_multi_page_picks_the_page_whose_labels_were_baked():
    diagram = {
        "pages": [
            {"id": "p1", "nodes": [_node(1, 0, 0, text="Ingest raw events"), _node(2, 0, 200, text="Kafka topic")]},
            {"id": "p2", "nodes": [_node(3, 900, 900, text="Billing & invoices"), _node(4, 900, 1100, text="Ledger DB")]},
        ]
    }
    # The client bakes the ACTIVE page; labels are XML-escaped and may wrap.
    svg = ART + "<text><tspan>Billing &amp;</tspan><tspan>invoices</tspan></text><text>Ledger DB</text></svg>"
    assert pick_page(svg, diagram)["id"] == "p2"
    vx = float(_root(fit_svg_to_content(svg, diagram))["viewBox"].split()[0])
    assert vx == 900 - FIT_MARGIN
    # No label evidence → page 1 (what the server renderer bakes).
    assert pick_page(ART + "</svg>", diagram)["id"] == "p1"


def test_page_pick_rejoins_wrapped_words_and_ignores_attributes():
    diagram = {
        "pages": [
            {"id": "p1", "nodes": [_node(1, 0, 0, text="start"), _node(2, 0, 200, text="Payments")]},
            {"id": "p2", "nodes": [_node(3, 0, 0, text="Authentication\u00a0Service")]},
        ]
    }
    # p2's label wrapped between its two words; "start"/"Payments" only occur
    # inside attribute values and a longer word — none of that is label text.
    svg = (
        ART + '<g data-x="start"><text><tspan>Authentication</tspan><tspan>Service</tspan></text>'
        "<text>PaymentsGateway</text></g></svg>"
    )
    assert pick_page(svg, diagram)["id"] == "p2"


def test_icon_captions_stay_in_frame():
    page = {"nodes": [_node(1, 100, 100, 64, 64, text="Amazon CloudFront distribution", kind="icon")]}
    x0, y0, x1, y1 = content_box(page)
    assert y1 >= 164 + 28  # caption below the box
    assert x0 < 100 and x1 > 164  # wider than the icon


def test_only_the_root_tag_is_rewritten_and_stroke_width_survives():
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000">'
        '<svg viewBox="0 0 10 10" width="10" height="10"><rect stroke-width="3" width="4" height="4"/></svg></svg>'
    )
    out = fit_svg_to_content(svg, {"nodes": [_node(1, 0, 0)]})
    assert '<svg viewBox="0 0 10 10" width="10" height="10">' in out  # nested untouched
    assert 'stroke-width="3"' in out
    assert "viewBox=" in re.match(r"<svg\b[^>]*>", out).group(0)  # type: ignore[union-attr]


def test_nothing_to_frame_returns_svg_unchanged():
    empty = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000" width="1600" height="1000"/>'
    assert fit_svg_to_content(empty, {"nodes": []}) == empty
    assert fit_svg_to_content(empty, {"nodes": [_node(1, 0, 0)]}) == empty  # self-closing root
    assert fit_svg_to_content("not svg", {"nodes": [_node(1, 0, 0)]}) == "not svg"
    assert fit_svg_to_content(ART + "</svg>", None) == ART + "</svg>"  # type: ignore[arg-type]


def test_route_fit_content_frames_and_plain_export_is_untouched(tmp_path):
    app = create_app(Settings(storage_dir=tmp_path / "storage", database_url=None))
    docs = app.state.document_service
    diagram = {"pages": [{"id": "p1", "name": "Page 1", "edges": [], "nodes": [_node(1, 400, 100, 200, 60), _node(2, 400, 900, 200, 60)]}]}
    baked = ART + '<g id="noddle-diagram-baked"><rect x="400" y="100" width="200" height="60"/></g></svg>'
    doc = docs.create(baked, "Tall tree", diagram=diagram)
    c = TestClient(app)

    plain = c.get(f"/api/documents/{doc.id}/export.svg")
    assert plain.status_code == 200
    assert _root(plain.text)["width"] == "1600"

    fit = c.get(f"/api/documents/{doc.id}/export.svg?fit=content")
    assert fit.status_code == 200
    a = _root(fit.text)
    assert float(a["width"]) < float(a["height"])  # tall content → tall image
