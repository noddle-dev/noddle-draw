"""drawio — parse draw.io / diagrams.net files into noddle diagram JSON.

Pure stdlib (xml.etree + zlib + base64), no network. Handles the three
on-disk shapes draw.io produces:

  * ``<mxfile><diagram>…deflate+base64+urlencoded…</diagram></mxfile>``
    (the DEFAULT "compressed" save format),
  * ``<mxfile><diagram><mxGraphModel>…</mxGraphModel></diagram></mxfile>``
    (uncompressed saves / "Editable SVG" exports),
  * a bare ``<mxGraphModel>`` root.

Each ``<diagram>`` becomes one noddle PAGE — the output is the multi-page
sidecar shape ``{"pages": [{id, name, nodes, edges}]}``.

Mapping notes (core coverage — #9/#10):
  * vertex geometry is made ABSOLUTE by walking the parent chain, so shapes
    inside groups / swimlanes land where the user drew them;
  * groups & swimlanes become plain ``rect`` nodes placed BEFORE their
    children (noddle z-order = insertion order → they render as backgrounds);
  * ``style`` tokens map onto noddle ``NodeKind``s (ellipse, rhombus→diamond,
    cylinder, hexagon, …); unknown shapes degrade to rect/rounded;
  * edges keep their endpoints (floating attachments), user waypoints
    (``<Array as="points">``), labels (own value + child edgeLabel cells),
    dash style and arrow ends.

XML safety: ``xml.etree`` does not fetch external entities/DTDs; defined
entities raise → we fail closed with ``InvalidDrawio``.
"""
from __future__ import annotations

import base64
import html
import re
import urllib.parse
import zlib
import xml.etree.ElementTree as ET
from defusedxml.ElementTree import fromstring as _safe_fromstring

_MAX_XML_BYTES = 5_000_000
_MAX_CELLS = 3_000
# Cap on decompressed <diagram> size — a small deflate payload can inflate to
# gigabytes (decompression bomb); stop well before that.
_MAX_INFLATED_BYTES = 8_000_000

_DEFAULT_W, _DEFAULT_H = 120.0, 60.0
_NODE_FILL = "#eef4ff"
_NODE_STROKE = "#2563eb"
_EDGE_STROKE = "#64748b"


class InvalidDrawio(Exception):
    """Raised when the input is not a parseable draw.io document."""


# ---- style helpers -----------------------------------------------------------


def _parse_style(style: str) -> dict[str, str]:
    """``"rounded=1;fillColor=#fff;shape=hexagon"`` → dict. The optional bare
    leading token (``ellipse;…``) is kept under ``""``."""
    out: dict[str, str] = {}
    for i, tok in enumerate(style.split(";")):
        if not tok:
            continue
        if "=" in tok:
            k, _, v = tok.partition("=")
            out[k] = v
        elif i == 0:
            out[""] = tok
    return out


_SHAPE_TO_KIND = {
    "cylinder": "cylinder",
    "cylinder3": "cylinder",
    "hexagon": "hexagon",
    "parallelogram": "parallelogram",
    "cloud": "cloud",
    "document": "document",
    "card": "card",
    "note": "note",
    "step": "process",
    "process": "process",
    "delay": "delay",
    "display": "display",
    "manualInput": "manualInput",
    "internalStorage": "internalStorage",
    "callout": "callout",
    "star": "star",
    "cross": "cross",
    "actor": "actor",
    "umlActor": "actor",
    "terminator": "terminator",
}


def _kind_of(style: dict[str, str]) -> str:
    bare = style.get("", "")
    shape = style.get("shape", "")
    if shape in _SHAPE_TO_KIND:
        return _SHAPE_TO_KIND[shape]
    if bare in ("ellipse",):
        return "ellipse"
    if bare in ("rhombus",) or shape == "rhombus":
        return "diamond"
    if bare == "triangle" or shape == "triangle":
        return "triangle"
    if bare in ("hexagon", "cloud", "cylinder", "actor", "card", "note", "step"):
        return _SHAPE_TO_KIND.get(bare, bare)
    if bare == "text":
        return "note"
    if style.get("rounded") == "1":
        return "rounded"
    return "rect"


_TAG_RE = re.compile(r"<[^>]+>")


def _clean_label(value: str | None) -> str:
    """draw.io labels are HTML — <br> → newline, strip tags, unescape."""
    if not value:
        return ""
    text = re.sub(r"(?i)<br\s*/?>", "\n", value)
    text = _TAG_RE.sub("", text)
    return html.unescape(text).strip()


def _color(style: dict[str, str], key: str, fallback: str) -> str:
    v = style.get(key, "")
    if re.match(r"^#[0-9a-fA-F]{3,8}$", v):
        return v
    return fallback


# ---- decompress / page discovery ---------------------------------------------


def _decode_diagram_text(text: str) -> ET.Element:
    """The compressed <diagram> payload: base64 → raw-deflate → urldecode."""
    try:
        raw = base64.b64decode(text.strip(), validate=True)
        # Bounded inflate: stop at the cap so a decompression bomb can't
        # exhaust memory. unconsumed_tail non-empty ⇒ payload exceeds the cap.
        d = zlib.decompressobj(-15)
        inflated = d.decompress(raw, _MAX_INFLATED_BYTES)
        if d.unconsumed_tail:
            raise InvalidDrawio("Diagram content is too large to import.")
        xml_text = urllib.parse.unquote(inflated.decode("utf-8"))
        return _safe_fromstring(xml_text)
    except InvalidDrawio:
        raise
    except Exception as e:  # noqa: BLE001 — any failure = not a drawio payload
        raise InvalidDrawio("Could not decompress the diagram content.") from e


def _models(root: ET.Element) -> list[tuple[str, ET.Element]]:
    """→ [(page_name, <mxGraphModel>)] regardless of on-disk variant."""
    if root.tag == "mxGraphModel":
        return [("Page 1", root)]
    if root.tag != "mxfile":
        raise InvalidDrawio("File is not a draw.io format (mxfile).")
    pages: list[tuple[str, ET.Element]] = []
    for i, diagram in enumerate(root.findall("diagram")):
        name = diagram.get("name") or f"Page {i + 1}"
        model = diagram.find("mxGraphModel")
        if model is None:
            model = _decode_diagram_text(diagram.text or "")
            if model.tag != "mxGraphModel":
                inner = model.find("mxGraphModel")
                if inner is None:
                    raise InvalidDrawio("draw.io page is missing mxGraphModel.")
                model = inner
        pages.append((name, model))
    if not pages:
        raise InvalidDrawio("draw.io file has no pages.")
    return pages


# ---- cell extraction -----------------------------------------------------------


def _cells_of(model: ET.Element) -> list[tuple[ET.Element, str]]:
    """→ [(mxCell, label)] — cells may be wrapped in <object label=…>."""
    out: list[tuple[ET.Element, str]] = []
    root = model.find("root")
    if root is None:
        raise InvalidDrawio("mxGraphModel is missing <root>.")
    for child in root:
        if child.tag == "mxCell":
            out.append((child, child.get("value") or ""))
        else:  # <object|UserObject label="…"><mxCell/></object>
            cell = child.find("mxCell")
            if cell is not None:
                out.append((cell, child.get("label") or cell.get("value") or ""))
    if len(out) > _MAX_CELLS:
        raise InvalidDrawio(f"Board is too large (> {_MAX_CELLS} elements).")
    return out


def _geometry(cell: ET.Element) -> ET.Element | None:
    return cell.find("mxGeometry")


def _abs_origin(
    cell_id: str,
    parents: dict[str, str],
    geoms: dict[str, tuple[float, float]],
    depth: int = 0,
) -> tuple[float, float]:
    """Sum ancestor offsets (group/swimlane children have relative coords)."""
    if depth > 20:
        return (0.0, 0.0)
    parent = parents.get(cell_id, "")
    if parent not in geoms:
        return (0.0, 0.0)
    px, py = geoms[parent]
    gx, gy = _abs_origin(parent, parents, geoms, depth + 1)
    return (px + gx, py + gy)


# ---- main entry -----------------------------------------------------------------


def drawio_to_diagram(xml_text: str) -> dict:
    """Parse draw.io XML → noddle multi-page diagram JSON. Raises InvalidDrawio."""
    if len(xml_text.encode("utf-8", "ignore")) > _MAX_XML_BYTES:
        raise InvalidDrawio("File is too large (5MB limit).")
    try:
        root = _safe_fromstring(xml_text)
    except ET.ParseError as e:
        raise InvalidDrawio("Invalid XML.") from e
    except Exception as e:  # noqa: BLE001 — defused rejects DOCTYPE/entities
        raise InvalidDrawio("XML contains disallowed constructs.") from e

    pages = []
    for pi, (page_name, model) in enumerate(_models(root)):
        cells = _cells_of(model)

        # First pass: vertex geometry (local) + parent chain for offsets.
        parents: dict[str, str] = {}
        local_xy: dict[str, tuple[float, float]] = {}
        for cell, _label in cells:
            cid = cell.get("id") or ""
            parents[cid] = cell.get("parent") or ""
            if cell.get("vertex") == "1":
                g = _geometry(cell)
                if g is not None:
                    local_xy[cid] = (float(g.get("x") or 0), float(g.get("y") or 0))

        nodes: list[dict] = []
        edges: list[dict] = []
        node_ids: set[str] = set()
        edge_labels: dict[str, str] = {}  # parent edge id → label from child cell

        for cell, label in cells:
            cid = cell.get("id") or ""
            style = _parse_style(cell.get("style") or "")

            if cell.get("vertex") == "1":
                # child label cells of edges ride along as edge labels
                if "edgeLabel" in (style.get("", "") + (cell.get("style") or "")):
                    parent = cell.get("parent") or ""
                    text = _clean_label(label)
                    if text:
                        edge_labels[parent] = text
                    continue
                g = _geometry(cell)
                if g is None:
                    continue
                ox, oy = _abs_origin(cid, parents, local_xy)
                x = float(g.get("x") or 0) + ox
                y = float(g.get("y") or 0) + oy
                w = float(g.get("width") or _DEFAULT_W)
                h = float(g.get("height") or _DEFAULT_H)
                is_container = (
                    style.get("", "") in ("group", "swimlane")
                    or style.get("shape") == "swimlane"
                    or cell.get("connectable") == "0"
                    and style.get("", "") == "group"
                )
                node = {
                    "id": cid,
                    "kind": "rect" if is_container else _kind_of(style),
                    "x": x,
                    "y": y,
                    "w": w,
                    "h": h,
                    "text": _clean_label(label),
                    "fill": _color(
                        style, "fillColor", "#f8fafc" if is_container else _NODE_FILL
                    ),
                    "stroke": _color(style, "strokeColor", _NODE_STROKE),
                    "strokeWidth": float(style.get("strokeWidth") or 2),
                }
                # Containers render first → background (noddle z = insertion order).
                if is_container:
                    nodes.insert(0, node)
                else:
                    nodes.append(node)
                node_ids.add(cid)

            elif cell.get("edge") == "1":
                g = _geometry(cell)
                src, tgt = cell.get("source"), cell.get("target")

                def endpoint(ref: str | None, as_attr: str) -> dict:
                    if ref:
                        return {"kind": "floating", "nodeId": ref}
                    pt = None
                    if g is not None:
                        pt = g.find(f"mxPoint[@as='{as_attr}']")
                    return {
                        "kind": "free",
                        "point": {
                            "x": float(pt.get("x") or 0) if pt is not None else 0.0,
                            "y": float(pt.get("y") or 0) if pt is not None else 0.0,
                        },
                    }

                waypoints = []
                if g is not None:
                    arr = g.find("Array[@as='points']")
                    if arr is not None:
                        for p in arr.findall("mxPoint"):
                            waypoints.append(
                                {"x": float(p.get("x") or 0), "y": float(p.get("y") or 0)}
                            )
                edge = {
                    "id": cid,
                    "source": endpoint(src, "sourcePoint"),
                    "target": endpoint(tgt, "targetPoint"),
                    "routing": "straight"
                    if style.get("edgeStyle") in (None, "none")
                    and style.get("", "") != "orthogonalEdgeStyle"
                    else "elbow",
                    "stroke": _color(style, "strokeColor", _EDGE_STROKE),
                    "strokeWidth": float(style.get("strokeWidth") or 2),
                    "endArrow": style.get("endArrow", "classic") != "none",
                    "startArrow": style.get("startArrow", "none") not in ("none", ""),
                }
                if style.get("dashed") == "1":
                    edge["dash"] = "dashed"
                text = _clean_label(label)
                if text:
                    edge["label"] = text
                if waypoints:
                    edge["waypoints"] = waypoints
                edges.append(edge)

        # Attach labels that lived on child edgeLabel cells; drop edges whose
        # node endpoints vanished (e.g. pointed at a filtered cell).
        for e in edges:
            if e["id"] in edge_labels and "label" not in e:
                e["label"] = edge_labels[e["id"]]
        edges = [
            e
            for e in edges
            if all(
                ep["kind"] == "free" or ep["nodeId"] in node_ids
                for ep in (e["source"], e["target"])
            )
        ]

        pages.append(
            {"id": f"p{pi + 1}", "name": page_name[:80], "nodes": nodes, "edges": edges}
        )

    if not any(p["nodes"] or p["edges"] for p in pages):
        raise InvalidDrawio("No shapes found in the draw.io file.")
    return {"pages": pages}
