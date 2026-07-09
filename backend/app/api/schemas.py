"""Pydantic DTOs — the HTTP wire shape, kept distinct from domain dataclasses.

Decoupling these from ``app.domain.models`` lets the API contract and the domain
evolve independently.
"""
from __future__ import annotations

from pydantic import BaseModel

from app.domain.models import Document, DocumentMeta

# A minimal empty board used when a JSON create doesn't supply SVG.
BLANK_BOARD_SVG = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000" '
    'width="1600" height="1000"></svg>'
)


class SaveBody(BaseModel):
    """Request body for PUT /api/documents/{id}.

    ``diagram`` semantics: omitted → keep stored; null → clear; object → replace.
    ``author_name`` attributes the version snapshot (client-side identity).
    """

    svg: str
    diagram: dict | None = None
    author_name: str | None = None


class CreateDocBody(BaseModel):
    """Request body for POST /api/documents/new (blank board / template / AI)."""

    name: str | None = None
    svg: str | None = None
    diagram: dict | None = None


class PatchDocBody(BaseModel):
    """PATCH /api/documents/{id}: rename (the only meta knob)."""

    name: str | None = None


class DocMeta(BaseModel):
    """Document metadata as returned to clients."""

    id: str
    name: str
    created_at: float
    updated_at: float
    link_policy: str = "edit"

    @classmethod
    def from_domain(cls, meta: DocumentMeta) -> "DocMeta":
        return cls(
            id=meta.id,
            name=meta.name,
            created_at=meta.created_at,
            updated_at=meta.updated_at,
            link_policy=meta.link_policy,
        )


class DocumentOut(BaseModel):
    """Full document (metadata + sanitized SVG + optional editable diagram).

    ``my_role`` is the CALLER's effective role (editor|viewer) so the frontend
    can lock the UI without re-deriving the link policy client-side.
    """

    meta: DocMeta
    svg: str
    diagram: dict | None = None
    my_role: str = "editor"

    @classmethod
    def from_domain(cls, doc: Document) -> "DocumentOut":
        return cls(
            meta=DocMeta.from_domain(doc.meta), svg=doc.svg, diagram=doc.diagram
        )
