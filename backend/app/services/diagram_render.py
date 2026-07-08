"""Server-side diagram → SVG thumbnail renderer.

Boards created from a template or AI (POST /api/documents/new with a diagram
but no baked SVG) used to store only a BLANK artboard, so their dashboard
preview (GET .../export.svg) was empty until the board was opened + saved
(which bakes the diagram into the SVG client-side). This renders a lightweight
but faithful SVG straight from the diagram JSON so previews are never blank.

The shapes are approximate (rounded rect / ellipse / diamond / triangle + a
centered label + straight connector lines) — enough for a recognizable card
thumbnail. Output is wrapped in ``<g id="noddle-diagram-baked">`` so that when
such a document is opened in the editor, ``openDoc`` strips this group and
re-renders the live diagram from JSON (no doubled shapes) — matching the
existing board persistence convention.
"""
from __future__ import annotations

from html import escape

_ARTBOARD_W = 1600
_ARTBOARD_H = 1000


def _pages(diagram: dict) -> list[dict]:
    if isinstance(diagram.get("pages"), list) and diagram["pages"]:
        return diagram["pages"]
    return [diagram]  # legacy single-page {nodes, edges}


def _num(v: object, default: float = 0.0) -> float:
    return float(v) if isinstance(v, (int, float)) else default


def _color(v: object, default: str) -> str:
    return v if isinstance(v, str) and v else default


def _node_center(n: dict) -> tuple[float, float]:
    return _num(n.get("x")) + _num(n.get("w")) / 2, _num(n.get("y")) + _num(n.get("h")) / 2


def _shape(n: dict) -> str:
    x, y = _num(n.get("x")), _num(n.get("y"))
    w, h = _num(n.get("w"), 120), _num(n.get("h"), 60)
    fill = escape(_color(n.get("fill"), "#eef4ff"), quote=True)
    stroke = escape(_color(n.get("stroke"), "#2563eb"), quote=True)
    sw = _num(n.get("strokeWidth"), 2)
    kind = n.get("kind")
    common = f'fill="{fill}" stroke="{stroke}" stroke-width="{sw}"'

    if kind == "image":
        href = n.get("imageHref")
        # Only data:image/ hrefs are legitimate (matches svg_sanitizer's
        # _clean_href) — anything else falls through to the rect placeholder.
        if isinstance(href, str) and href.startswith("data:image/"):
            body = (
                f'<image x="{x}" y="{y}" width="{w}" height="{h}" '
                f'preserveAspectRatio="none" href="{escape(href, quote=True)}"/>'
            )
        else:
            body = (
                f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="#f1f3f7" '
                f'stroke="#9aa1ad" stroke-width="1.5" stroke-dasharray="6 4"/>'
            )
    elif kind == "ellipse":
        body = (
            f'<ellipse cx="{x + w / 2}" cy="{y + h / 2}" rx="{w / 2}" ry="{h / 2}" {common}/>'
        )
    elif kind == "diamond":
        pts = f"{x + w / 2},{y} {x + w},{y + h / 2} {x + w / 2},{y + h} {x},{y + h / 2}"
        body = f'<polygon points="{pts}" {common}/>'
    elif kind == "triangle":
        pts = f"{x + w / 2},{y} {x + w},{y + h} {x},{y + h}"
        body = f'<polygon points="{pts}" {common} stroke-linejoin="round"/>'
    else:
        # rounded rect covers rect/rounded/process/sticky/note/card/… — fine for
        # a thumbnail.
        body = f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="8" ry="8" {common}/>'

    label = ""
    text = n.get("text")
    if isinstance(text, str) and text.strip():
        t = escape(text.strip()[:22])
        label = (
            f'<text x="{x + w / 2}" y="{y + h / 2}" text-anchor="middle" '
            f'dominant-baseline="central" font-family="sans-serif" '
            f'font-size="13" fill="#1a1d23">{t}</text>'
        )
    return body + label


def _edge(e: dict, nodes: dict[str, dict]) -> str:
    def endpoint(att: object) -> tuple[float, float] | None:
        if not isinstance(att, dict):
            return None
        if att.get("kind") == "free":
            p = att.get("point") or {}
            return _num(p.get("x")), _num(p.get("y"))
        n = nodes.get(att.get("nodeId"))
        return _node_center(n) if n else None

    a = endpoint(e.get("source"))
    b = endpoint(e.get("target"))
    if not a or not b:
        return ""
    stroke = escape(_color(e.get("stroke"), "#475569"), quote=True)
    sw = _num(e.get("strokeWidth"), 2)
    return (
        f'<line x1="{a[0]}" y1="{a[1]}" x2="{b[0]}" y2="{b[1]}" '
        f'stroke="{stroke}" stroke-width="{sw}"/>'
    )


def diagram_to_svg(diagram: dict) -> str:
    """Render the first page of a diagram to a standalone SVG string."""
    page = _pages(diagram)[0] if isinstance(diagram, dict) else {}
    nodes_list = page.get("nodes") if isinstance(page.get("nodes"), list) else []
    edges_list = page.get("edges") if isinstance(page.get("edges"), list) else []
    nodes = {n.get("id"): n for n in nodes_list if isinstance(n, dict) and n.get("id")}

    # edges first (under nodes), then nodes.
    parts: list[str] = [_edge(e, nodes) for e in edges_list if isinstance(e, dict)]
    parts += [_shape(n) for n in nodes.values()]
    inner = "".join(p for p in parts if p)

    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" '
        f'viewBox="0 0 {_ARTBOARD_W} {_ARTBOARD_H}" '
        f'width="{_ARTBOARD_W}" height="{_ARTBOARD_H}">'
        f'<g id="noddle-diagram-baked">{inner}</g></svg>'
    )
