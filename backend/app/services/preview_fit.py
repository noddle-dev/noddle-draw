"""Dashboard thumbnail framing for ``GET /api/documents/{id}/export.svg?fit=content``.

A stored board SVG is the WHOLE artboard (``viewBox="0 0 1600 1000"
width="1600" height="1000"`` or a grown page), so a small or oddly-shaped
diagram reads as a speck on a dashboard card. ``fit_svg_to_content`` reframes
the root ``<svg>`` around what is actually drawn:

* **Which page.** The client bakes the page that was ACTIVE at save time, the
  server renderer bakes page 1. Neither records which, so on a multi-page board
  the page whose node labels appear in the SVG's TEXT (tags stripped, so
  wrapped <tspan> lines rejoin and attribute values never match) wins; ties →
  page 1.
* **What counts.** Visible nodes only (zero-size and fully transparent nodes
  are ignored), icon captions (drawn BELOW the 64px icon box and often wider
  than it), plus free arrow endpoints and user waypoints. The margin also
  covers connector routes, which run up to ROUTE_PAD (24px) outside shapes.
* **Intrinsic size.** ``width``/``height`` are rewritten together with the
  ``viewBox``. Rewriting only the viewBox (the old behaviour) left the image's
  intrinsic ratio at the artboard's 1.6:1, so a tall tree was letterboxed into
  a thin strip and the card could never tell it was tall. The long side is
  capped at ``THUMB_LONG_SIDE`` px (vector, so no quality loss).
* **Legible strokes.** When the content is larger than the thumbnail, every
  stroke is drawn ``non-scaling`` in that thumbnail space, so a 1px hairline
  on a 3000px board doesn't shrink to 0.1px "grey dust".

Best-effort by contract: anything unexpected returns the SVG unchanged (a
preview must never 500). Only the ``fit=content`` thumbnail route uses this —
plain ``export.svg`` downloads stay byte-identical to what was saved.
"""
from __future__ import annotations

import re
from html import unescape

FIT_MARGIN = 28.0  # > the router's ROUTE_PAD (24) so edge detours stay in frame
# Icon captions hang below the box (NodeView): ~one 13px line + gap.
_ICON_CAPTION_H = 30.0
_ICON_CAPTION_CHAR_W = 6.8
THUMB_LONG_SIDE = 560.0
# Pages compared when guessing which page the SVG bakes (keeps a huge board's
# label scan bounded).
_MAX_LABEL_PROBES = 40

_ROOT_TAG = re.compile(r"<svg\b[^>]*>", re.S)
_TAG = re.compile(r"<[^>]*>")
_WS = re.compile(r"[\s\u00a0]+")
_THUMB_STYLE = (
    '<style data-noddle-thumb="1">'
    ":where(path,line,polyline,polygon,rect,circle,ellipse){vector-effect:non-scaling-stroke}"
    ":where(marker,mask,clipPath,pattern,symbol) *{vector-effect:none}"
    "</style>"
)


def _pages(diagram: dict) -> list[dict]:
    pages = diagram.get("pages")
    if isinstance(pages, list):
        return [p for p in pages if isinstance(p, dict)]
    return [diagram]  # legacy single-page {nodes, edges}


def _f(v: object) -> float | None:
    if isinstance(v, bool):
        return None
    try:
        f = float(v)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return f if f == f and abs(f) != float("inf") else None


def _norm(s: str) -> str:
    """Collapse every whitespace run (incl. the NBSPs AI text carries) to one space."""
    return _WS.sub(" ", s).strip()


def _svg_text(svg: str) -> str:
    """The SVG's visible text as ONE space-separated string: tags become spaces
    (so wrapped ``<tspan>`` lines rejoin and attribute values never match),
    entities are decoded, whitespace collapsed. Padded for word-boundary
    matching."""
    return f" {_norm(unescape(_TAG.sub(' ', svg)))} "


def _label_key(node: dict) -> str | None:
    """The label's first line, whitespace-normalized (≥3 chars)."""
    text = node.get("text")
    if not isinstance(text, str):
        return None
    key = _norm(text.strip().split("\n", 1)[0])
    return key if len(key) >= 3 else None


def pick_page(svg: str, diagram: dict) -> dict | None:
    pages = _pages(diagram)
    if not pages:
        return None
    if len(pages) == 1:
        return pages[0]
    text = _svg_text(svg)
    best, best_score = pages[0], -1
    for page in pages:
        nodes = page.get("nodes") if isinstance(page.get("nodes"), list) else []
        keys = {k for n in nodes[:_MAX_LABEL_PROBES] if isinstance(n, dict) and (k := _label_key(n))}
        # whole-word match: "end" must not hit "Backend"
        score = sum(1 for k in keys if f" {k} " in text)
        if score > best_score:
            best, best_score = page, score
    return best


def content_box(page: dict) -> tuple[float, float, float, float] | None:
    """(x0, y0, x1, y1) of the drawn content, or None when nothing is drawn."""
    xs: list[float] = []
    ys: list[float] = []
    nodes = page.get("nodes") if isinstance(page.get("nodes"), list) else []
    for n in nodes:
        if not isinstance(n, dict):
            continue
        x, y, w, h = _f(n.get("x")), _f(n.get("y")), _f(n.get("w")), _f(n.get("h"))
        if x is None or y is None or w is None or h is None or w <= 0 or h <= 0:
            continue
        if _f(n.get("opacity")) == 0:
            continue
        x0, x1, y1 = x, x + w, y + h
        if n.get("kind") == "icon" and isinstance(n.get("text"), str) and n["text"].strip():
            first = n["text"].strip().split("\n", 1)[0]
            spill = max(0.0, len(first) * _ICON_CAPTION_CHAR_W - w) / 2
            x0, x1, y1 = x0 - spill, x1 + spill, y1 + _ICON_CAPTION_H
        xs += [x0, x1]
        ys += [y, y1]
    edges = page.get("edges") if isinstance(page.get("edges"), list) else []
    for e in edges:
        if not isinstance(e, dict):
            continue
        pts: list[object] = []
        for end in ("source", "target"):
            att = e.get(end)
            if isinstance(att, dict) and att.get("kind") == "free":
                pts.append(att.get("point"))
        if isinstance(e.get("waypoints"), list):
            pts += e["waypoints"]
        for p in pts:
            if isinstance(p, dict):
                px, py = _f(p.get("x")), _f(p.get("y"))
                if px is not None and py is not None:
                    xs.append(px)
                    ys.append(py)
    if not xs:
        return None
    return min(xs), min(ys), max(xs), max(ys)


def _set_attr(tag: str, name: str, value: str) -> str:
    # (?<=\s) so "width" never matches inside "stroke-width".
    pat = re.compile(rf"(?<=\s){name}\s*=\s*(\"[^\"]*\"|'[^']*')")
    if pat.search(tag):
        return pat.sub(f'{name}="{value}"', tag, count=1)
    end = -2 if tag.endswith("/>") else -1
    return f'{tag[:end]} {name}="{value}"{tag[end:]}'


def fit_svg_to_content(
    svg: str,
    diagram: dict,
    *,
    margin: float = FIT_MARGIN,
    long_side: float = THUMB_LONG_SIDE,
) -> str:
    """Reframe ``svg``'s root element around the diagram content (see module
    docstring). Returns ``svg`` unchanged when there is nothing to frame."""
    try:
        if not isinstance(diagram, dict):
            return svg
        page = pick_page(svg, diagram)
        box = content_box(page) if page else None
        m = _ROOT_TAG.search(svg)
        if box is None or m is None or m.group(0).endswith("/>"):
            return svg
        x0, y0, x1, y1 = box
        vx, vy = x0 - margin, y0 - margin
        vw, vh = (x1 - x0) + 2 * margin, (y1 - y0) + 2 * margin
        k = min(1.0, long_side / max(vw, vh))
        tag = m.group(0)
        tag = _set_attr(tag, "viewBox", f"{vx:.1f} {vy:.1f} {vw:.1f} {vh:.1f}")
        tag = _set_attr(tag, "width", f"{vw * k:.1f}")
        tag = _set_attr(tag, "height", f"{vh * k:.1f}")
        tag = _set_attr(tag, "preserveAspectRatio", "xMidYMid meet")
        style = _THUMB_STYLE if k < 1.0 else ""
        return svg[: m.start()] + tag + style + svg[m.end():]
    except Exception:  # a preview must never 500
        return svg
