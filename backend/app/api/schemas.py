"""Pydantic DTOs — the HTTP wire shape, kept distinct from domain dataclasses.

Decoupling these from ``app.domain.models`` lets the API contract and the domain
evolve independently.
"""
from __future__ import annotations

from pydantic import BaseModel, Field

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
    ``base_diagram`` (the diagram this client last read) makes the save a
    3-way merge onto the live board — concurrent edits by others survive.
    ``expected_updated_at`` (without a base) fails the save with 409 when the
    board changed since the caller read it. ``agent`` marks an MCP/AI agent
    write: the author is shown in live presence as an agent.
    """

    svg: str
    diagram: dict | None = None
    author_name: str | None = None
    base_diagram: dict | None = None
    expected_updated_at: float | None = Field(default=None, allow_inf_nan=False)
    agent: bool = False


class PresenceBody(BaseModel):
    """POST /api/documents/{id}/presence — an agent (MCP ``join_board``)
    announces itself to everyone who has the board open. Humans join over
    the WebSocket instead."""

    name: str = Field(min_length=1, max_length=40)
    client_id: str | None = Field(default=None, max_length=64)


class CaptureBody(BaseModel):
    """POST /api/documents/{id}/capture — render one saved page to PNG.
    ``expected_updated_at`` omitted ⇒ capture whatever is saved now."""

    page_id: str | None = Field(default=None, max_length=128)
    expected_updated_at: float | None = Field(default=None, allow_inf_nan=False)


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
