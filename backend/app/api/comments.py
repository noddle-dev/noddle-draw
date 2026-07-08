"""HTTP router for /api/documents/{doc_id}/comments (M1 — comment threads).

Access rules (ADR-0002, Figma-style commenting):
  * list / create / reply → "view" — anyone who can see the board may discuss
    it (guests included; their display name travels in the payload),
  * edit body             → the authenticated author only,
  * resolve / unresolve   → the author, or anyone with "edit",
  * delete                → the authenticated author, or anyone with "manage".

Every mutation returns the FULL comment list (LWW, like the collab protocol)
and pushes a ``{"t": "comments"}`` frame to the document's live room so open
editors update instantly without polling.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from app.api.auth import get_auth, get_principal
from app.api.collab import push_to_room
from app.domain.models import Comment, DocumentMeta
from app.services.auth import AuthService, Principal, can
from app.services.comments import (
    CommentNotFound,
    CommentService,
    InvalidComment,
)
from app.services.documents import DocumentNotFound, DocumentService

router = APIRouter(prefix="/api/documents/{doc_id}/comments", tags=["comments"])

# /api/me/mentions — the cross-document mention inbox (badge feed).
mentions_router = APIRouter(prefix="/api/me", tags=["comments"])

_NOT_FOUND = "Document not found."
_NO_VIEW = "You don't have permission to view this board."
_NOT_YOURS = "You don't have permission to act on this comment."


def get_service(request: Request) -> CommentService:
    return request.app.state.comment_service


def get_documents(request: Request) -> DocumentService:
    return request.app.state.document_service


class CommentIn(BaseModel):
    body: str
    page_id: str | None = None
    parent_id: str | None = None
    anchor: dict | None = None
    mentions: list[str] = Field(default_factory=list)
    # Display name for link guests (authenticated principals are server-named).
    guest_name: str | None = None


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
    mentions: list[str]
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
            mentions=c.mentions,
            resolved=c.resolved,
            created_at=c.created_at,
            updated_at=c.updated_at,
        )


class CommentsOut(BaseModel):
    comments: list[CommentOut]
    # Mention candidates: owner + per-user shares + team members. Board
    # collaborators are visible to anyone who can view (Figma semantics).
    people: list[dict] | None = None


def _require_view(
    doc_id: str,
    documents: DocumentService,
    principal: Principal,
    auth: AuthService,
) -> DocumentMeta:
    try:
        meta = documents.get(doc_id).meta
    except DocumentNotFound:
        raise HTTPException(status_code=404, detail=_NOT_FOUND)
    if not can(principal, "view", meta, auth):
        raise HTTPException(status_code=403, detail=_NO_VIEW)
    return meta


def _people_of(meta: DocumentMeta, auth: AuthService) -> list[dict]:
    ids: list[str] = []
    if meta.owner_id:
        ids.append(meta.owner_id)
    ids += [uid for uid in meta.shares if uid not in ids]
    team = auth.team_by_id(meta.team_id)
    if team:
        ids += [uid for uid in team.members if uid not in ids]
    people = []
    for uid in ids:
        u = auth.user_public(uid)
        if u:
            people.append(u)
    return people


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


@mentions_router.get("/mentions")
def my_mentions(
    request: Request,
    service: CommentService = Depends(get_service),
    documents: DocumentService = Depends(get_documents),
    principal: Principal = Depends(get_principal),
    auth: AuthService = Depends(get_auth),
) -> list[dict]:
    """Comments that @mention the signed-in user, across every board they can
    still view — newest first, capped. "Seen" state is CLIENT-side (a badge
    aid, not durable inbox state), so this endpoint stays a pure read."""
    if not principal.user_id:
        return []
    # DB v2 P5: candidates come from the mentions fan-out (one indexed query
    # in Pg mode) instead of scanning every board's comments. A mention row is
    # NOT an access grant — view is re-checked per board, so mentions on
    # boards the user lost access to drop out of the feed immediately.
    cands = service.mentions_of_user(principal.user_id, limit=200)
    metas = {
        m.id: m for m in documents.metas_by_ids(sorted({c.doc_id for c in cands}))
    }
    rows: list[dict] = []
    for c in cands:  # already newest-first
        meta = metas.get(c.doc_id)
        if meta is None or not can(principal, "view", meta, auth):
            continue
        if principal.user_id not in c.mentions or c.author_id == principal.user_id:
            continue  # belt: the adapters filter this too
        rows.append(
            {
                "comment_id": c.id,
                "doc_id": meta.id,
                "doc_name": meta.name,
                "body": c.body[:200],
                "author_name": c.author_name,
                "author_color": c.author_color,
                "resolved": c.resolved,
                "created_at": c.created_at,
            }
        )
        if len(rows) == 50:
            break
    return rows


@router.get("")
def list_comments(
    doc_id: str,
    service: CommentService = Depends(get_service),
    documents: DocumentService = Depends(get_documents),
    principal: Principal = Depends(get_principal),
    auth: AuthService = Depends(get_auth),
) -> CommentsOut:
    meta = _require_view(doc_id, documents, principal, auth)
    return CommentsOut(
        comments=_serialize(service, doc_id), people=_people_of(meta, auth)
    )


@router.post("")
async def create_comment(
    doc_id: str,
    body: CommentIn,
    service: CommentService = Depends(get_service),
    documents: DocumentService = Depends(get_documents),
    principal: Principal = Depends(get_principal),
    auth: AuthService = Depends(get_auth),
) -> CommentsOut:
    _require_view(doc_id, documents, principal, auth)
    if principal.is_authenticated:
        author_name, author_color = principal.name, principal.color
    else:
        author_name = (body.guest_name or "Guest").strip()[:40] or "Guest"
        author_color = "#9aa1ad"
    try:
        service.add(
            doc_id,
            body.body,
            author_name=author_name,
            author_id=principal.user_id,
            author_color=author_color,
            page_id=body.page_id,
            parent_id=body.parent_id,
            anchor=body.anchor,
            mentions=body.mentions,
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
    principal: Principal = Depends(get_principal),
    auth: AuthService = Depends(get_auth),
) -> CommentsOut:
    meta = _require_view(doc_id, documents, principal, auth)
    try:
        existing = service.get(doc_id, comment_id)
    except CommentNotFound:
        raise HTTPException(status_code=404, detail="Comment not found.")
    is_author = (
        existing.author_id is not None and principal.user_id == existing.author_id
    )
    if body.body is not None and not is_author:
        raise HTTPException(status_code=403, detail=_NOT_YOURS)
    if body.resolved is not None and not (
        is_author or can(principal, "edit", meta, auth)
    ):
        raise HTTPException(status_code=403, detail=_NOT_YOURS)
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
    principal: Principal = Depends(get_principal),
    auth: AuthService = Depends(get_auth),
) -> CommentsOut:
    meta = _require_view(doc_id, documents, principal, auth)
    try:
        existing = service.get(doc_id, comment_id)
    except CommentNotFound:
        raise HTTPException(status_code=404, detail="Comment not found.")
    is_author = (
        existing.author_id is not None and principal.user_id == existing.author_id
    )
    if not (is_author or can(principal, "manage", meta, auth)):
        raise HTTPException(status_code=403, detail=_NOT_YOURS)
    service.delete(doc_id, comment_id)
    await _notify(service, doc_id)
    return CommentsOut(comments=_serialize(service, doc_id))
