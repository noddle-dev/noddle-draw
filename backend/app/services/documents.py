"""DocumentService — the use-case layer.

Owns the business rules once, testable without HTTP or a real filesystem:
  * sanitize SVG *before* it is stored (and it's stored sanitized, so reads are
    already clean too),
  * validate the optional diagram JSON (structure + size cap) before storing,
  * mint ids as ``uuid4().hex[:12]`` and bookkeep created/updated timestamps,
  * validate the id shape before any lookup.

It depends only on the repository PORT (Protocol) — the concrete
``FileDocumentRepository`` is injected by the api layer via FastAPI ``Depends``.
Errors are raised as plain domain exceptions; the api layer maps them to HTTP.
"""
from __future__ import annotations

import json
import threading
import time
from collections.abc import Collection
from copy import deepcopy
from dataclasses import replace
from functools import wraps

from app.domain.diagram_merge import merge_diagrams, pages_of
from app.domain.ids import is_valid_id, new_id
from app.domain.models import Document, DocumentMeta, DocumentVersion
from app.domain.repository import DocumentRepository, VersionRepository
from app.security.svg_sanitizer import sanitize_svg

# Sentinel distinguishing "not provided" from an explicit None (keep diagram
# unchanged).
_UNSET = object()

_MAX_DIAGRAM_BYTES = 1_000_000  # 1 MB of JSON is plenty for a board

# Version history: rapid autosaves (1.8s debounce) COALESCE into the newest
# snapshot instead of stacking — a new version starts only after this gap.
_VERSION_COALESCE_S = 60.0
_MAX_VERSIONS = 50


class DocumentNotFound(Exception):
    """Raised when a document id is malformed or does not exist."""


class DocumentConflict(Exception):
    """The board changed after the caller read it (``expected_updated_at``)."""


class InvalidSvg(Exception):
    """Raised when uploaded/saved SVG cannot be sanitized/parsed."""


class InvalidDiagram(Exception):
    """Raised when the diagram payload is not a valid board JSON."""


class VersionNotFound(Exception):
    """Raised when a version id does not exist for this document."""


def _serialized_write(method):
    """Run a read-modify-write under the service lock so a precondition check
    (``expected_updated_at``) and the merge against live state can't race."""

    @wraps(method)
    def call(self, *args, **kwargs):
        with self._write_lock:
            return method(self, *args, **kwargs)

    return call


class DocumentService:
    def __init__(
        self, repo: DocumentRepository, versions: VersionRepository | None = None
    ) -> None:
        self._repo = repo
        self._write_lock = threading.RLock()
        # Live (unsaved) diagram per board while a collab room is open. Like the
        # rooms themselves this is in-memory — another single-instance
        # dependency (ADR: never scale replicas).
        self._live: dict[str, dict | None] = {}
        # The file adapter implements both ports; a future DB split can inject
        # a distinct snapshot store without touching this service.
        self._versions: VersionRepository = versions or repo  # type: ignore[assignment]

    # ---- documents ---------------------------------------------------------
    def list(self) -> list[DocumentMeta]:
        return sorted(
            self._repo.list(), key=lambda m: m.updated_at, reverse=True
        )

    def metas_by_ids(self, doc_ids: Collection[str]) -> list[DocumentMeta]:
        return self._repo.metas_by_ids(doc_ids)

    def create(
        self,
        raw_svg: str,
        name: str | None,
        diagram: dict | None = None,
        link_policy: str = "edit",
    ) -> DocumentMeta:
        clean = self._sanitize(raw_svg)
        if diagram is not None:
            diagram = self._validate_diagram(diagram)
        now = time.time()
        meta = DocumentMeta(
            id=new_id(),
            name=name or "untitled.svg",
            created_at=now,
            updated_at=now,
            # Anonymous-only: the link is the capability (Excalidraw-style).
            link_policy=link_policy,
        )
        self._repo.save(Document(meta=meta, svg=clean, diagram=diagram))
        return meta

    def get(self, doc_id: str) -> Document:
        if not is_valid_id(doc_id):
            raise DocumentNotFound(doc_id)
        doc = self._repo.load(doc_id)
        if doc is None:
            raise DocumentNotFound(doc_id)
        return doc

    # ---- live collaboration state -------------------------------------------
    # While a board's room is open, peers' unsaved state frames are merged into
    # an in-memory "live" diagram so HTTP/MCP readers and writers see (and merge
    # with) what people are doing right now, not just the last explicit save.

    @_serialized_write
    def get_live(self, doc_id: str) -> Document:
        doc = self.get(doc_id)
        return replace(doc, diagram=deepcopy(self._live.get(doc_id, doc.diagram)))

    @_serialized_write
    def begin_live(self, doc_id: str) -> None:
        if doc_id not in self._live:
            self._live[doc_id] = deepcopy(self.get(doc_id).diagram)

    @_serialized_write
    def end_live(self, doc_id: str) -> None:
        self._live.pop(doc_id, None)

    @_serialized_write
    def apply_live_page(
        self,
        doc_id: str,
        page_id: str | None,
        incoming: dict,
        base: dict | None = None,
        removed_nodes=(),
        removed_edges=(),
    ) -> dict:
        """Merge one page's live state frame into the board's live diagram.
        With ``base`` (the sender's read base) only objects/fields the sender
        changed are applied, so concurrent edits by others survive; without
        it (legacy clients) the frame is the page's full state —
        last-write-wins, as the protocol always was. Explicit tombstones
        (``removed_*``) delete either way."""
        current = self.get_live(doc_id).diagram
        pages = pages_of(current) or [{"id": "p1", "name": "Page 1", "nodes": [], "edges": []}]
        pid = page_id or pages[0]["id"]
        page = next((p for p in pages if p["id"] == pid), None)
        if page is None:
            page = {"id": pid, "name": f"Page {len(pages) + 1}", "nodes": [], "edges": []}
            pages.append(page)
        if base is None:
            merged: dict | None = {"nodes": deepcopy(incoming["nodes"]), "edges": deepcopy(incoming["edges"])}
        else:
            current_page = {"nodes": page.get("nodes", []), "edges": page.get("edges", [])}
            merged = merge_diagrams(base, incoming, current_page)
            if merged and "pages" in merged:
                merged = merged["pages"][0]
        page["nodes"] = [n for n in (merged or {}).get("nodes", []) if n["id"] not in removed_nodes]
        ids = {n["id"] for n in page["nodes"]}
        page["edges"] = [
            e for e in (merged or {}).get("edges", [])
            if e["id"] not in removed_edges and all(
                not isinstance(e.get(end), dict) or not e[end].get("nodeId") or e[end]["nodeId"] in ids
                for end in ("source", "target")
            )
        ]
        self._live[doc_id] = self._validate_diagram({"pages": pages})
        return deepcopy(page)

    @_serialized_write
    def save(
        self,
        doc_id: str,
        raw_svg: str,
        diagram: object = _UNSET,
        author_name: str = "",
        expected_updated_at: float | None = None,
        base_diagram: object = _UNSET,
    ) -> DocumentMeta:
        """Overwrite a document's payload. ``diagram`` semantics: omitted →
        keep the stored one (old clients send svg only); ``None`` → clear;
        a dict → validate + replace. Every save also records a version
        snapshot (coalesced against autosave spam, capped per document).

        ``base_diagram`` (the diagram the caller last read) turns the save into
        a 3-way MERGE onto the current live board: only objects/fields the
        caller changed are written, so concurrent edits by others survive.
        Without a base, ``expected_updated_at`` is an optimistic-concurrency
        precondition (``DocumentConflict`` when the board moved on)."""
        existing = self.get(doc_id)
        if (
            base_diagram is _UNSET
            and expected_updated_at is not None
            and abs(existing.meta.updated_at - expected_updated_at) > 1e-6
        ):
            raise DocumentConflict("The board changed. Read it again and reapply the edit.")
        clean = self._sanitize(raw_svg)
        if diagram is _UNSET:
            new_diagram = existing.diagram
        elif diagram is None:
            new_diagram = None
        else:
            new_diagram = self._validate_diagram(diagram)  # type: ignore[arg-type]
        if base_diagram is not _UNSET:
            base = self._validate_diagram(base_diagram) if base_diagram is not None else None  # type: ignore[arg-type]
            new_diagram = merge_diagrams(base, new_diagram, self.get_live(doc_id).diagram)
            if new_diagram is not None:
                new_diagram = self._validate_diagram(new_diagram)
        # A payload save must NEVER touch the access policy — carry every
        # meta field.
        meta = replace(existing.meta, updated_at=time.time())
        self._repo.save(Document(meta=meta, svg=clean, diagram=new_diagram))
        if doc_id in self._live:
            self._live[doc_id] = deepcopy(new_diagram)
        self._record_version(doc_id, clean, new_diagram, author_name)
        return meta

    # ---- version history ------------------------------------------------------
    def list_versions(self, doc_id: str) -> list[DocumentVersion]:
        """Version metadata, newest first (no payloads)."""
        self.get(doc_id)  # 404 on unknown/malformed ids
        return sorted(
            self._versions.list_versions(doc_id),
            key=lambda v: v.created_at,
            reverse=True,
        )

    def get_version(self, doc_id: str, version_id: str) -> DocumentVersion:
        self.get(doc_id)
        v = self._versions.load_version(doc_id, version_id)
        if v is None:
            raise VersionNotFound(version_id)
        return v

    def _record_version(
        self, doc_id: str, svg: str, diagram: dict | None, author_name: str
    ) -> None:
        now = time.time()
        existing = sorted(
            self._versions.list_versions(doc_id), key=lambda v: v.created_at
        )
        newest = existing[-1] if existing else None
        coalesce = (
            newest is not None
            and now - newest.created_at < _VERSION_COALESCE_S
            and newest.author_name == author_name
        )
        vid = newest.id if coalesce and newest else new_id()
        self._versions.save_version(
            DocumentVersion(
                id=vid,
                doc_id=doc_id,
                created_at=now,
                author_name=author_name,
                svg=svg,
                diagram=diagram,
            )
        )
        if not coalesce and len(existing) + 1 > _MAX_VERSIONS:
            overflow = existing[: len(existing) + 1 - _MAX_VERSIONS]
            self._versions.delete_versions(doc_id, [v.id for v in overflow])

    @_serialized_write
    def update_meta(self, doc_id: str, name: str | None = None) -> DocumentMeta:
        """Rename (authorization happens in the api layer — this is pure
        state transition)."""
        existing = self.get(doc_id)
        meta = replace(
            existing.meta,
            name=(name or existing.meta.name).strip() or existing.meta.name,
            updated_at=time.time(),
        )
        self._repo.save(
            Document(meta=meta, svg=existing.svg, diagram=existing.diagram)
        )
        return meta

    @_serialized_write
    def delete(self, doc_id: str) -> None:
        if not is_valid_id(doc_id):
            raise DocumentNotFound(doc_id)
        self._live.pop(doc_id, None)
        self._repo.delete(doc_id)

    # ---- validation ---------------------------------------------------------
    @staticmethod
    def _sanitize(raw_svg: str) -> str:
        try:
            return sanitize_svg(raw_svg)
        except ValueError as e:
            raise InvalidSvg(str(e)) from e

    @staticmethod
    def _validate_diagram(diagram: dict) -> dict:
        if not isinstance(diagram, dict):
            raise InvalidDiagram("Diagram must be a JSON object.")
        # Two accepted shapes: multi-page `{pages:[{id,name,nodes,edges}]}` or
        # the legacy single `{nodes,edges}` (wrapped as one page on the client).
        if isinstance(diagram.get("pages"), list):
            pages = []
            for i, pg in enumerate(diagram["pages"]):
                if not isinstance(pg, dict):
                    continue
                nodes, edges = pg.get("nodes"), pg.get("edges")
                if not isinstance(nodes, list) or not isinstance(edges, list):
                    raise InvalidDiagram("Each page needs 'nodes' and 'edges' as arrays.")
                pages.append({
                    "id": str(pg.get("id") or f"p{i}"),
                    "name": str(pg.get("name") or f"Page {i + 1}")[:80],
                    # Presentation visibility is durable page metadata.
                    **({"hidden": True} if pg.get("hidden") is True else {}),
                    "nodes": nodes,
                    "edges": edges,
                })
            if not pages:
                raise InvalidDiagram("Diagram has no valid pages.")
            payload = {"pages": pages}
        else:
            nodes = diagram.get("nodes")
            edges = diagram.get("edges")
            if not isinstance(nodes, list) or not isinstance(edges, list):
                raise InvalidDiagram("Diagram needs 'nodes' and 'edges' as arrays.")
            payload = {"nodes": nodes, "edges": edges}
        if len(json.dumps(payload)) > _MAX_DIAGRAM_BYTES:
            raise InvalidDiagram("Diagram is too large (1MB limit).")
        return payload
