"""Pydantic DTOs — the HTTP wire shape, kept distinct from domain dataclasses.

Decoupling these from ``app.domain.models`` lets the API contract and the domain
evolve independently.
"""
from __future__ import annotations

from pydantic import BaseModel

from app.domain.models import Document, DocumentMeta, Folder

# A minimal empty board used when a JSON create doesn't supply SVG.
BLANK_BOARD_SVG = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000" '
    'width="1600" height="1000"></svg>'
)


class SaveBody(BaseModel):
    """Request body for PUT /api/documents/{id}.

    ``diagram`` semantics: omitted → keep stored; null → clear; object → replace.
    """

    svg: str
    diagram: dict | None = None


class CreateDocBody(BaseModel):
    """Request body for POST /api/documents/new (blank board / template / AI)."""

    name: str | None = None
    svg: str | None = None
    diagram: dict | None = None
    folder_id: str | None = None


class PatchDocBody(BaseModel):
    """PATCH /api/documents/{id}: rename/move ("edit") + sharing knobs ("manage")."""

    name: str | None = None
    folder_id: str | None = None
    link_policy: str | None = None  # edit | view | private
    team_id: str | None = None


class DocMeta(BaseModel):
    """Document metadata as returned to clients."""

    id: str
    name: str
    created_at: float
    updated_at: float
    folder_id: str | None = None
    owner_id: str | None = None
    team_id: str | None = None
    link_policy: str = "private"

    @classmethod
    def from_domain(cls, meta: DocumentMeta) -> "DocMeta":
        return cls(
            id=meta.id,
            name=meta.name,
            created_at=meta.created_at,
            updated_at=meta.updated_at,
            folder_id=meta.folder_id,
            owner_id=meta.owner_id,
            team_id=meta.team_id,
            link_policy=meta.link_policy,
        )


class DocumentOut(BaseModel):
    """Full document (metadata + sanitized SVG + optional editable diagram).

    ``my_role`` is the CALLER's effective role (owner|editor|viewer) so the
    frontend can lock the UI without re-deriving ACLs client-side.
    ``owner`` is the board owner's public profile ({id,name,color,avatar,…})
    so the editor can show a subtle "Owned by …" chip to every viewer.
    """

    meta: DocMeta
    svg: str
    diagram: dict | None = None
    my_role: str = "editor"
    owner: dict | None = None

    @classmethod
    def from_domain(cls, doc: Document) -> "DocumentOut":
        return cls(
            meta=DocMeta.from_domain(doc.meta), svg=doc.svg, diagram=doc.diagram
        )


class FolderBody(BaseModel):
    """Request body for POST/PATCH /api/folders."""

    name: str
    color: str | None = None


class FolderOut(BaseModel):
    """Folder as returned to clients (with live document count)."""

    id: str
    name: str
    color: str
    created_at: float
    count: int = 0

    @classmethod
    def from_domain(cls, folder: Folder, count: int = 0) -> "FolderOut":
        return cls(
            id=folder.id,
            name=folder.name,
            color=folder.color,
            created_at=folder.created_at,
            count=count,
        )
