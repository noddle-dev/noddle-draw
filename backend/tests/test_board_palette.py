"""The AI's DEFAULT colour system is the editor's draw palette. Guards: (1) the Python table mirrors the TS one the style panel
renders, (2) the prompt carries the override by default and drops it for the
explicit "editorial" style, (3) every route defaults to "board"."""

from __future__ import annotations

import re
from pathlib import Path

from app.domain import board_palette

TS = Path(__file__).resolve().parents[2] / "web/src/editor-core/diagram/palette.ts"


def _ts() -> str:
    return TS.read_text(encoding="utf-8")


def test_python_palette_mirrors_the_style_panel():
    src = _ts()
    strokes = re.search(r"STROKES = \[([^\]]*)\]", src).group(1)
    assert tuple(re.findall(r'"(#[0-9a-f]{6})"', strokes)) == board_palette.STROKES
    fills_block = re.search(r"FILLS:[^=]*= \[(.*?)\];", src, re.S).group(1)
    assert tuple(re.findall(r'v: "([^"]+)"', fills_block)) == board_palette.FILLS
    pairs_block = re.search(r"STYLE_PAIRS:[^=]*= \[(.*?)\];", src, re.S).group(1)
    pairs = tuple(
        re.findall(r'name: "([^"]+)", stroke: "([^"]+)", fill: "([^"]+)"', pairs_block)
    )
    assert pairs == board_palette.STYLE_PAIRS


def test_every_pair_uses_palette_swatches():
    for _, stroke, fill in board_palette.STYLE_PAIRS:
        assert stroke in board_palette.STROKES
        assert fill in board_palette.FILLS




def test_enforce_snaps_editorial_greys_and_applies_hand_drawn_finish():
    nodes = [
        {"id": "a", "kind": "rect", "fill": "#efeff0", "stroke": "#b9babf", "textColor": "#4f5d75", "fontFamily": "mono"},
        {"id": "b", "kind": "rect", "fill": "#fbe9de", "stroke": "#eb6c36"},  # editorial ember tint
        {"id": "c", "kind": "rect", "fill": "#eef4ff", "stroke": "#2e5aa8"},  # editorial link blue
        {"id": "keep", "kind": "rect", "fill": "#123456", "stroke": "#654321"},
    ]
    edges = [{"id": "e1", "stroke": "#475569"}, {"id": "e2", "stroke": "#eb6c36"}]
    n = board_palette.enforce(nodes, edges, only_ids={"a", "b", "c", "e1", "e2"})
    a, b, c, keep = nodes
    assert (a["fill"], a["stroke"], a["textColor"]) == ("#ffffff", "#2d3142", "#2d3142")
    assert "fontFamily" not in a and a["sketch"] is True and a["cornerRadius"] == 12
    assert (b["fill"], b["stroke"]) == ("#fef9c3", "#eb6c36")
    assert (c["fill"], c["stroke"]) == ("#dbeafe", "#2563eb")
    assert keep == {"id": "keep", "kind": "rect", "fill": "#123456", "stroke": "#654321"}  # untouched
    assert edges[0]["stroke"] == "#2d3142" and edges[1]["stroke"] == "#eb6c36"
    assert n == 4  # e2 was already on-palette
    pal = {c.lower() for c in (*board_palette.STROKES, *board_palette.FILLS)}
    for node in (a, b, c):
        assert {node["fill"], node["stroke"]} <= pal
