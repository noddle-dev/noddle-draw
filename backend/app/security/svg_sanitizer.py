"""Whitelist-based SVG sanitizer.

SVG is a direct XSS vector (scripts, event handlers, javascript: URLs,
foreignObject with HTML). Before any uploaded SVG is stored or rendered back
to a browser we strip everything not on an allow-list. This is a pragmatic
mockup-grade sanitizer built on the stdlib; for production, back it with a
hardened library (e.g. DOMPurify on the client + a server-side equivalent) and
security review.
"""
from __future__ import annotations

import re
import xml.etree.ElementTree as ET
# Parse with defusedxml — it rejects DOCTYPE/entity declarations, so a
# "billion laughs" entity-expansion bomb in an uploaded SVG can't blow up
# memory at parse time. Element construction/serialization stays stdlib ET.
from defusedxml.ElementTree import fromstring as _safe_fromstring
from defusedxml.common import DefusedXmlException

SVG_NS = "http://www.w3.org/2000/svg"
XLINK_NS = "http://www.w3.org/1999/xlink"

# Elements safe to keep. Anything else (script, foreignObject, animate*, ...)
# is dropped along with its subtree.
ALLOWED_TAGS = {
    "svg", "g", "defs", "title", "desc", "metadata", "style", "a", "switch",
    "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
    "text", "tspan", "textPath",
    "linearGradient", "radialGradient", "stop",
    "pattern", "clipPath", "mask", "symbol", "use",
    "filter", "feGaussianBlur", "feOffset", "feBlend", "feColorMatrix",
    "feComponentTransfer", "feFuncA", "feFuncR", "feFuncG", "feFuncB",
    "feFlood", "feMerge", "feMergeNode", "feDropShadow",
    "image", "marker",
}

# Attributes allowed on any element. on* handlers are never allowed.
ALLOWED_ATTRS = {
    "id", "class", "style", "transform", "viewBox", "xmlns", "version",
    "width", "height", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r",
    "rx", "ry", "d", "points", "dx", "dy", "rotate",
    "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width",
    "stroke-linecap", "stroke-linejoin", "stroke-dasharray", "stroke-opacity",
    "stroke-dashoffset", "stroke-miterlimit",
    "opacity", "color", "display", "visibility", "overflow",
    "offset", "stop-color", "stop-opacity", "gradientUnits", "gradientTransform",
    "spreadMethod", "patternUnits", "patternContentUnits", "clip-path", "mask",
    "clipPathUnits", "maskUnits", "maskContentUnits", "preserveAspectRatio",
    "font-family", "font-size", "font-weight", "font-style", "text-anchor",
    "letter-spacing", "word-spacing", "dominant-baseline", "alignment-baseline",
    "marker-start", "marker-mid", "marker-end", "vector-effect",
    "filter", "flood-color", "flood-opacity", "stdDeviation", "in", "in2",
    "result", "mode", "type", "values", "tableValues", "slope", "intercept",
    "amplitude", "exponent", "k1", "k2", "k3", "k4", "operator", "radius",
    "orient", "refX", "refY", "markerWidth", "markerHeight", "markerUnits",
    "pointer-events", "paint-order", "shape-rendering", "text-rendering",
    "cursor", "writing-mode", "baseline-shift", "text-decoration", "space",
    "href",  # sanitized below (only local #ref or data: images)
}

# url() values allowed inside CSS / attributes (local defs + embedded rasters).
_SAFE_URL = re.compile(r"^\s*(#|data:image/)", re.I)

DANGEROUS_URL = re.compile(r"^\s*(javascript|vbscript|data:text/html)", re.I)
CSS_URL = re.compile(r"url\(\s*['\"]?\s*(javascript|vbscript)", re.I)


def _local(tag: str) -> str:
    return tag.split("}", 1)[-1] if "}" in tag else tag


def _clean_href(value: str) -> str | None:
    v = value.strip()
    if v.startswith("#"):  # local reference to a def
        return v
    if v.startswith("data:image/"):  # embedded raster is allowed
        return v
    return None  # drop remote / dangerous references


def _clean_style(value: str) -> str:
    # Strip any style declaration containing a script-y url()
    if CSS_URL.search(value):
        return ""
    return value


def _clean_css(css: str) -> str:
    """Sanitize the text content of a <style> element: drop @import and any
    dangerous url()/expression() while keeping local #refs (markers, gradients)
    and data:image URLs intact."""
    if not css:
        return css
    css = re.sub(r"@import[^;]*;?", "", css, flags=re.I)
    css = re.sub(r"expression\s*\(", "(", css, flags=re.I)

    def _url(m: "re.Match[str]") -> str:
        inner = m.group(1).strip().strip("'\"")
        return m.group(0) if _SAFE_URL.match(inner) else "none"

    return re.sub(r"url\(([^)]*)\)", _url, css, flags=re.I)


def _sanitize_element(el: ET.Element) -> bool:
    """Return True to keep this element, False to drop it (and subtree)."""
    if _local(el.tag) not in ALLOWED_TAGS:
        return False

    if _local(el.tag) == "style":
        el.text = _clean_css(el.text or "")

    for name in list(el.attrib.keys()):
        local = _local(name)
        lname = local.lower()
        # never allow event handlers
        if lname.startswith("on"):
            del el.attrib[name]
            continue
        if local not in ALLOWED_ATTRS:
            del el.attrib[name]
            continue
        val = el.attrib[name]
        if local in ("href",) or local.endswith("href"):
            cleaned = _clean_href(val)
            if cleaned is None:
                del el.attrib[name]
            else:
                el.attrib[name] = cleaned
        elif local == "style":
            el.attrib[name] = _clean_style(val)
        elif DANGEROUS_URL.search(val):
            del el.attrib[name]

    # recurse, dropping disallowed children
    for child in list(el):
        if not _sanitize_element(child):
            el.remove(child)
    return True


def sanitize_svg(raw: str) -> str:
    """Parse, strip unsafe nodes/attrs, and re-serialize. Raises ValueError
    if the input is not parseable SVG."""
    # Register the default namespace so serialization stays clean.
    ET.register_namespace("", SVG_NS)
    ET.register_namespace("xlink", XLINK_NS)
    # Tolerance: content that uses xlink:href without declaring the xlink
    # namespace on the root (client-serialized boards embedding uploaded SVG
    # fragments) is otherwise an "unbound prefix" hard parse error. Injecting
    # the declaration is safe — the attribute values still go through
    # _clean_href like any other href.
    if "xlink:" in raw and "xmlns:xlink" not in raw:
        raw = raw.replace("<svg", f'<svg xmlns:xlink="{XLINK_NS}"', 1)
    try:
        root = _safe_fromstring(raw)
    except DefusedXmlException as e:
        raise ValueError("SVG contains disallowed XML (entities/DOCTYPE).") from e
    except ET.ParseError as e:
        raise ValueError(f"Not a valid SVG file: {e}") from e

    if _local(root.tag) != "svg":
        raise ValueError("Root element is not <svg>.")

    if not _sanitize_element(root):
        raise ValueError("SVG was rejected by the sanitizer.")

    # Ensure a viewBox exists so the editor can frame it.
    if "viewBox" not in root.attrib:
        w = root.attrib.get("width", "0").rstrip("px") or "0"
        h = root.attrib.get("height", "0").rstrip("px") or "0"
        try:
            if float(w) > 0 and float(h) > 0:
                root.attrib["viewBox"] = f"0 0 {w} {h}"
        except ValueError:
            pass

    return ET.tostring(root, encoding="unicode")
