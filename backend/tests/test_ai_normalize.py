"""_normalize_full_diagram must round-trip every field the editor UI writes.

Regression tests for the "AI edit destroys user data" class of bugs: the
normalizer used to whitelist a handful of fields, so every AI chat edit
silently dropped edge label blocks (text on arrows vanished), z paint order
(layers reshuffled), endpoint decorations, node text formatting, and coerced
catalog shape kinds down to "rounded".
"""
from __future__ import annotations

import pytest

from app.services.ai import AIBadOutput, AIService


def normalize(diagram: dict) -> tuple[list, list]:
    return AIService._normalize_full_diagram(diagram)


def base_node(**over) -> dict:
    node = {
        "id": "a",
        "kind": "rect",
        "x": 10,
        "y": 20,
        "w": 100,
        "h": 50,
        "text": "A",
        "fill": "#fff",
        "stroke": "#000",
        "strokeWidth": 2,
    }
    node.update(over)
    return node


def base_edge(**over) -> dict:
    edge = {
        "id": "e1",
        "source": {"kind": "floating", "nodeId": "a"},
        "target": {"kind": "floating", "nodeId": "b"},
        "routing": "elbow",
        "stroke": "#475569",
        "strokeWidth": 2,
        "endArrow": True,
        "startArrow": False,
        "animated": False,
    }
    edge.update(over)
    return edge


def two_nodes() -> list[dict]:
    return [base_node(), base_node(id="b", x=300)]


def test_edge_label_blocks_survive():
    labels = [{"id": "l1", "t": 0.3, "text": "yes"}, {"id": "l2", "t": 0.9, "text": "no"}]
    _, edges = normalize({"nodes": two_nodes(), "edges": [base_edge(labels=labels)]})
    assert edges[0]["labels"] == labels


def test_edge_label_blocks_validated():
    raw = [
        {"id": "l1", "t": 5, "text": "clamped"},   # t clamped to 0..1
        {"t": 0.5, "text": "  "},                   # blank text dropped
        "junk",                                      # non-dict dropped
        {"t": "mid", "text": "no-t"},                # bad t → 0.5 default
    ]
    _, edges = normalize({"nodes": two_nodes(), "edges": [base_edge(labels=raw)]})
    blocks = edges[0]["labels"]
    assert [b["text"] for b in blocks] == ["clamped", "no-t"]
    assert blocks[0]["t"] == 1.0
    assert blocks[1]["t"] == 0.5


def test_z_paint_order_survives_on_nodes_and_edges():
    nodes, edges = normalize(
        {"nodes": [base_node(z=7), base_node(id="b", z=3)], "edges": [base_edge(z=5)]}
    )
    assert nodes[0]["z"] == 7 and nodes[1]["z"] == 3
    assert edges[0]["z"] == 5


def test_edge_heads_and_dash_survive():
    _, edges = normalize(
        {
            "nodes": two_nodes(),
            "edges": [base_edge(endHead="diamond", startHead="circle", dash="dashed")],
        }
    )
    assert edges[0]["endHead"] == "diamond"
    assert edges[0]["startHead"] == "circle"
    assert edges[0]["dash"] == "dashed"
    # junk values are dropped, not passed through
    _, edges = normalize(
        {"nodes": two_nodes(), "edges": [base_edge(endHead="sparkles", dash="wavy")]}
    )
    assert "endHead" not in edges[0] and "dash" not in edges[0]


def test_continuous_flow_speed_survives():
    _, edges = normalize(
        {"nodes": two_nodes(), "edges": [base_edge(animated=True, flowSpeed=1.34)]}
    )
    assert edges[0]["flowSpeed"] == pytest.approx(1.34)


def test_catalog_kinds_are_kept_not_coerced():
    nodes, _ = normalize({"nodes": [base_node(kind="cylinder")], "edges": []})
    assert nodes[0]["kind"] == "cylinder"
    # garbage still falls back
    nodes, _ = normalize({"nodes": [base_node(kind="<svg/>")], "edges": []})
    assert nodes[0]["kind"] == "rounded"


def test_node_format_fields_survive():
    nodes, _ = normalize(
        {
            "nodes": [
                base_node(
                    fontSize=18,
                    bold=True,
                    textColor="#ff0000",
                    textAlign="left",
                    opacity=0.5,
                    cornerRadius=12,
                    strokeDash="dotted",
                    groupId="g1",
                    z=2,
                )
            ],
            "edges": [],
        }
    )
    n = nodes[0]
    assert n["fontSize"] == 18 and n["bold"] is True
    assert n["textColor"] == "#ff0000" and n["textAlign"] == "left"
    assert n["opacity"] == 0.5 and n["cornerRadius"] == 12
    assert n["strokeDash"] == "dotted" and n["groupId"] == "g1" and n["z"] == 2


def test_image_href_only_accepts_data_urls():
    nodes, _ = normalize(
        {"nodes": [base_node(kind="image", imageHref="https://evil/x.png")], "edges": []}
    )
    assert "imageHref" not in nodes[0]
    nodes, _ = normalize(
        {"nodes": [base_node(kind="image", imageHref="data:image/png;base64,AAAA")], "edges": []}
    )
    assert nodes[0]["imageHref"].startswith("data:image/")


def test_bad_shapes_still_rejected():
    with pytest.raises(AIBadOutput):
        normalize({"nodes": "nope", "edges": []})
    with pytest.raises(AIBadOutput):
        normalize({"nodes": [], "edges": "nope"})
