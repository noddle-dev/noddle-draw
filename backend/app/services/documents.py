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
import time
from collections.abc import Collection
from dataclasses import replace

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


class InvalidSvg(Exception):
    """Raised when uploaded/saved SVG cannot be sanitized/parsed."""


class InvalidDiagram(Exception):
    """Raised when the diagram payload is not a valid board JSON."""


class VersionNotFound(Exception):
    """Raised when a version id does not exist for this document."""


class DocumentService:
    def __init__(
        self, repo: DocumentRepository, versions: VersionRepository | None = None
    ) -> None:
        self._repo = repo
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

    def save(
        self,
        doc_id: str,
        raw_svg: str,
        diagram: object = _UNSET,
        author_name: str = "",
    ) -> DocumentMeta:
        """Overwrite a document's payload. ``diagram`` semantics: omitted →
        keep the stored one (old clients send svg only); ``None`` → clear;
        a dict → validate + replace. Every save also records a version
        snapshot (coalesced against autosave spam, capped per document)."""
        existing = self.get(doc_id)
        clean = self._sanitize(raw_svg)
        if diagram is _UNSET:
            new_diagram = existing.diagram
        elif diagram is None:
            new_diagram = None
        else:
            new_diagram = self._validate_diagram(diagram)  # type: ignore[arg-type]
        # A payload save must NEVER touch the access policy — carry every
        # meta field.
        meta = replace(existing.meta, updated_at=time.time())
        self._repo.save(Document(meta=meta, svg=clean, diagram=new_diagram))
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

    def delete(self, doc_id: str) -> None:
        if not is_valid_id(doc_id):
            raise DocumentNotFound(doc_id)
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
