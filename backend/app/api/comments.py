"""HTTP router for /api/documents/{doc_id}/comments (M1 — comment threads).

Access rules (anonymous-only, Excalidraw-style):
  * list / create / reply → "view" — anyone who can see the board may discuss
    it (the display name travels in the payload),
  * edit body / resolve / delete → "edit" — the board link is the capability;
    there is no server-side author identity to gate on.

Every mutation returns the FULL comment list (LWW, like the collab protocol)
and pushes a ``{"t": "comments"}`` frame to the document's live room so open
editors update instantly without polling.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from app.api.collab import push_to_room
from app.domain.models import Comment, DocumentMeta
from app.services.auth import can
from app.services.comments import (
    CommentNotFound,
    CommentService,
    InvalidComment,
)
from app.services.documents import DocumentNotFound, DocumentService

router = APIRouter(prefix="/api/documents/{doc_id}/comments", tags=["comments"])

_NOT_FOUND = "Document not found."
_NO_VIEW = "You don't have permission to view this board."
_NO_EDIT = "This board's link is view-only."


def get_service(request: Request) -> CommentService:
    return request.app.state.comment_service


def get_documents(request: Request) -> DocumentService:
    return request.app.state.document_service


class CommentIn(BaseModel):
    body: str
    page_id: str | None = None
    parent_id: str | None = None
    anchor: dict | None = None
    # Display name chosen client-side (localStorage guest identity).
    guest_name: str | None = None
    guest_color: str | None = None


class CommentPatch(BaseModel):
    body: str | None = None
    resolved: bool | None = None


class CommentOut(BaseModel):
    id: str
    body: str
    author_id: str | None
    author_name: str
    author_color: str
    page_id: str | None
    parent_id: str | None
    anchor: dict | None
    resolved: bool
    created_at: float
    updated_at: float

    @classmethod
    def from_domain(cls, c: Comment) -> "CommentOut":
        return cls(
            id=c.id,
            body=c.body,
            author_id=c.author_id,
            author_name=c.author_name,
            author_color=c.author_color,
            page_id=c.page_id,
            parent_id=c.parent_id,
            anchor=c.anchor,
            resolved=c.resolved,
            created_at=c.created_at,
            updated_at=c.updated_at,
        )


class CommentsOut(BaseModel):
    comments: list[CommentOut]


def _require(
    action: str, doc_id: str, documents: DocumentService
) -> DocumentMeta:
    try:
        meta = documents.get(doc_id).meta
    except DocumentNotFound:
        raise HTTPException(status_code=404, detail=_NOT_FOUND)
    if not can(action, meta):
        raise HTTPException(
            status_code=403, detail=_NO_EDIT if action == "edit" else _NO_VIEW
        )
    return meta


def _serialize(service: CommentService, doc_id: str) -> list[CommentOut]:
    return [CommentOut.from_domain(c) for c in service.list(doc_id)]


async def _notify(service: CommentService, doc_id: str) -> None:
    await push_to_room(
        doc_id,
        {
            "t": "comments",
            "comments": [c.model_dump() for c in _serialize(service, doc_id)],
        },
    )


@router.get("")
def list_comments(
    doc_id: str,
    service: CommentService = Depends(get_service),
    documents: DocumentService = Depends(get_documents),
) -> CommentsOut:
    _require("view", doc_id, documents)
    return CommentsOut(comments=_serialize(service, doc_id))


@router.post("")
async def create_comment(
    doc_id: str,
    body: CommentIn,
    service: CommentService = Depends(get_service),
    documents: DocumentService = Depends(get_documents),
) -> CommentsOut:
    _require("view", doc_id, documents)
    author_name = (body.guest_name or "Guest").strip()[:40] or "Guest"
    author_color = (body.guest_color or "#9aa1ad").strip()[:16] or "#9aa1ad"
    try:
        service.add(
            doc_id,
            body.body,
            author_name=author_name,
            author_color=author_color,
            page_id=body.page_id,
            parent_id=body.parent_id,
            anchor=body.anchor,
        )
    except CommentNotFound:
        raise HTTPException(status_code=404, detail="Root comment not found.")
    except InvalidComment as e:
        raise HTTPException(status_code=400, detail=str(e))
    await _notify(service, doc_id)
    return CommentsOut(comments=_serialize(service, doc_id))


@router.patch("/{comment_id}")
async def patch_comment(
    doc_id: str,
    comment_id: str,
    body: CommentPatch,
    service: CommentService = Depends(get_service),
    documents: DocumentService = Depends(get_documents),
) -> CommentsOut:
    _require("edit", doc_id, documents)
    try:
        service.get(doc_id, comment_id)
    except CommentNotFound:
        raise HTTPException(status_code=404, detail="Comment not found.")
    try:
        service.update(doc_id, comment_id, body=body.body, resolved=body.resolved)
    except InvalidComment as e:
        raise HTTPException(status_code=400, detail=str(e))
    await _notify(service, doc_id)
    return CommentsOut(comments=_serialize(service, doc_id))


@router.delete("/{comment_id}")
async def delete_comment(
    doc_id: str,
    comment_id: str,
    service: CommentService = Depends(get_service),
    documents: DocumentService = Depends(get_documents),
) -> CommentsOut:
    _require("edit", doc_id, documents)
    try:
        service.get(doc_id, comment_id)
    except CommentNotFound:
        raise HTTPException(status_code=404, detail="Comment not found.")
    service.delete(doc_id, comment_id)
    await _notify(service, doc_id)
    return CommentsOut(comments=_serialize(service, doc_id))
