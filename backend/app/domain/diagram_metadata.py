"""Semantic diagram metadata — bounded, optional, round-trip safe (pure, no I/O).

Three levels let an agent understand a board without reading geometry:

* diagram ``metadata`` — ``{category, summary, domain, tags, owner, version,
  links, custom}`` on the diagram root (``{metadata?, pages:[…]}``);
* page ``metadata`` — ``{category, summary, tags, notes, custom}`` per page;
* object ``meta`` — a flat ``Record<string, primitive | primitive[]>`` on any
  node or edge (``role``, ``tech``, ``layer``, ``protocol``, ``sla`` …).

Mirrors ``DiagramMetadata`` / ``PageMetadata`` / ``ObjectMeta`` in
``web/src/editor-core/diagram/types.ts``. Every sanitizer is total: invalid
entries are dropped (never raised on) and an empty result means "absent", so
callers simply omit the key. The bounds keep a hostile or chatty writer from
turning metadata into a second payload channel.
"""
from __future__ import annotations

import math
from typing import Any

MAX_META_KEYS = 20
MAX_KEY_LEN = 64
MAX_LIST_ITEMS = 20
MAX_VALUE_LEN = 500
MAX_TAG_LEN = 64
MAX_LINKS = 20

_SHORT = 64  # category / domain / version
_SUMMARY = 1000
_OWNER = 120
_NOTES = 4000
_LINK_LABEL = 120
_LINK_URL = 2048


def _primitive(v: Any) -> Any:
    """A JSON primitive kept as-is (strings capped), else ``None`` (= drop)."""
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return v if math.isfinite(v) else None
    if isinstance(v, str):
        return v[:MAX_VALUE_LEN]
    return None


def sanitize_object_meta(raw: Any) -> dict:
    """``ObjectMeta``: ≤20 keys (1..64 chars), primitive values or lists of
    ≤20 primitives. Invalid entries are stripped; ``None`` values dropped."""
    if not isinstance(raw, dict):
        return {}
    out: dict = {}
    for key, value in raw.items():
        if len(out) >= MAX_META_KEYS:
            break
        if not isinstance(key, str) or not key or len(key) > MAX_KEY_LEN:
            continue
        if isinstance(value, list):
            items = [p for p in (_primitive(x) for x in value[:MAX_LIST_ITEMS]) if p is not None]
            out[key] = items
            continue
        p = _primitive(value)
        if p is not None:
            out[key] = p
    return out


def _text(v: Any, cap: int) -> str | None:
    if not isinstance(v, str):
        return None
    s = v.strip()
    return s[:cap] if s else None


def _tags(v: Any) -> list[str] | None:
    if not isinstance(v, list):
        return None
    seen: list[str] = []
    for t in v:
        s = _text(t, MAX_TAG_LEN)
        if s and s not in seen:
            seen.append(s)
        if len(seen) >= MAX_LIST_ITEMS:
            break
    return seen or None


def _links(v: Any) -> list[dict] | None:
    if not isinstance(v, list):
        return None
    out: list[dict] = []
    for item in v:
        if not isinstance(item, dict):
            continue
        url = _text(item.get("url"), _LINK_URL)
        # http(s) only — a link is rendered as an anchor in previews, so a
        # javascript:/data: URL must never be stored.
        if not url or not url.lower().startswith(("https://", "http://")):
            continue
        label = _text(item.get("label"), _LINK_LABEL) or url[:_LINK_LABEL]
        out.append({"label": label, "url": url})
        if len(out) >= MAX_LINKS:
            break
    return out or None


def _common(raw: dict, out: dict) -> None:
    for key, cap in (("category", _SHORT), ("summary", _SUMMARY)):
        s = _text(raw.get(key), cap)
        if s:
            out[key] = s
    tags = _tags(raw.get("tags"))
    if tags:
        out["tags"] = tags


def sanitize_diagram_metadata(raw: Any) -> dict:
    """``DiagramMetadata`` (diagram root). Unknown keys are dropped."""
    if not isinstance(raw, dict):
        return {}
    out: dict = {}
    _common(raw, out)
    for key, cap in (("domain", _SHORT), ("owner", _OWNER), ("version", _SHORT)):
        s = _text(raw.get(key), cap)
        if s:
            out[key] = s
    links = _links(raw.get("links"))
    if links:
        out["links"] = links
    custom = sanitize_object_meta(raw.get("custom"))
    if custom:
        out["custom"] = custom
    return out


def sanitize_page_metadata(raw: Any) -> dict:
    """``PageMetadata`` (one page). Unknown keys are dropped."""
    if not isinstance(raw, dict):
        return {}
    out: dict = {}
    _common(raw, out)
    notes = _text(raw.get("notes"), _NOTES)
    if notes:
        out["notes"] = notes
    custom = sanitize_object_meta(raw.get("custom"))
    if custom:
        out["custom"] = custom
    return out


def merge_metadata(current: Any, patch: Any) -> dict:
    """Shallow-merge ``patch`` into ``current``: non-null keys overwrite,
    keys explicitly set to ``None`` are removed (``set_metadata`` semantics)."""
    out = dict(current) if isinstance(current, dict) else {}
    if isinstance(patch, dict):
        for key, value in patch.items():
            if value is None:
                out.pop(key, None)
            else:
                out[key] = value
    return out
