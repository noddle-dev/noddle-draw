"""Domain models — plain dataclasses, decoupled from HTTP/storage shapes."""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class DocumentMeta:
    """Metadata about a stored document (what lives in the index).

    Access model (checked by ``services.auth.can``): noddle is anonymous-only,
    so the board URL is the capability. ``link_policy`` is the whole story:
    ``"edit"`` (every board created through the API) grants view+edit to
    anyone with the link, ``"view"`` grants read-only, and legacy
    ``"private"`` rows stay dark. ``owner_id`` survives only so rows written
    by the old accounts build keep loading; it grants nothing.
    """

    id: str
    name: str
    created_at: float
    updated_at: float
    owner_id: str | None = None  # legacy column — ignored by authz
    link_policy: str = "edit"  # edit | view (| legacy "private")


@dataclass
class Document:
    """A document: metadata + the (sanitized) SVG payload + optional diagram.

    ``diagram`` is the editable node/edge JSON produced by the frontend's
    diagram layer (noddle's own model). The SVG remains the render/export shape
    while the diagram JSON is what makes a board round-trip editable.
    """

    meta: DocumentMeta
    svg: str
    diagram: dict | None = field(default=None)


@dataclass
class DocumentVersion:
    """A point-in-time snapshot of a document's payload (svg + diagram).

    Written on every save (coalesced — rapid autosaves overwrite the newest
    snapshot instead of stacking), capped per document. Restore is CLIENT-driven:
    the frontend fetches a version and PUTs it back as a normal save, so the
    restore itself becomes the newest version and flows through the usual
    sanitize/validate path.
    """

    id: str
    doc_id: str
    created_at: float
    author_name: str = ""
    svg: str = ""
    diagram: dict | None = None


@dataclass
class Comment:
    """A comment pinned to a board.

    A thread ROOT carries an ``anchor`` — ``{"kind": "node"|"edge", "ref": id}``
    (follows the object) or ``{"kind": "point", "x": f, "y": f}`` (fixed content
    coords). Replies carry ``parent_id`` (one level deep — replies to a root
    only) and no anchor. Authors are anonymous: the display name/color are
    captured at write time (client-chosen guest identity).
    """

    id: str
    doc_id: str
    body: str
    author_name: str
    created_at: float
    updated_at: float
    author_id: str | None = None  # legacy column — always None for new rows
    author_color: str = "#9aa1ad"
    page_id: str | None = None
    parent_id: str | None = None
    anchor: dict | None = None
    resolved: bool = False
