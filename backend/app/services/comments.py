"""CommentService — comment threads pinned to a board.

Business rules, testable without HTTP or a real filesystem:
  * a thread ROOT must carry a valid anchor (node/edge ref or a content point);
    replies reference an existing root (one level deep) and carry no anchor,
  * body is required plain text, capped; mentions are a capped list of user ids,
  * ids are minted like every other domain id (``uuid4().hex[:12]``),
  * deleting a root cascades to its replies.

WHO may do each operation is the api layer's job (``services.auth.can`` +
author checks) — this service is pure state transition, like DocumentService.
It depends only on the ``CommentRepository`` port.
"""
from __future__ import annotations

import time

from app.domain.ids import is_valid_id, new_id
from app.domain.models import Comment
from app.domain.repository import CommentRepository

_MAX_BODY = 4_000
_MAX_MENTIONS = 20
_MAX_REF = 64


class CommentNotFound(Exception):
    """Raised when a comment id does not exist on this document."""


class InvalidComment(Exception):
    """Raised when a comment payload fails validation."""


class CommentService:
    def __init__(self, repo: CommentRepository) -> None:
        self._repo = repo

    def list(self, doc_id: str) -> list[Comment]:
        return sorted(self._repo.list_comments(doc_id), key=lambda c: c.created_at)

    def mentions_of_user(self, user_id: str, limit: int = 200) -> list[Comment]:
        """Cross-board @mention candidates, newest first — the caller still
        filters by per-board view access (a mention is not a grant)."""
        return self._repo.mentions_of_user(user_id, limit)

    def get(self, doc_id: str, comment_id: str) -> Comment:
        for c in self._repo.list_comments(doc_id):
            if c.id == comment_id:
                return c
        raise CommentNotFound(comment_id)

    def add(
        self,
        doc_id: str,
        body: str,
        author_name: str,
        author_id: str | None = None,
        author_color: str = "#9aa1ad",
        page_id: str | None = None,
        parent_id: str | None = None,
        anchor: dict | None = None,
        mentions: list[str] | None = None,
    ) -> Comment:
        if not is_valid_id(doc_id):
            raise InvalidComment("Invalid document id.")
        clean_body = (body or "").strip()
        if not clean_body:
            raise InvalidComment("Comment body cannot be empty.")
        if len(clean_body) > _MAX_BODY:
            raise InvalidComment(f"Comment is too long (max {_MAX_BODY} characters).")

        if parent_id:
            parent = self.get(doc_id, parent_id)
            if parent.parent_id:
                raise InvalidComment("Only root comments can be replied to (1 level deep).")
            anchor = None  # replies inherit the root's anchor
            page_id = parent.page_id
        else:
            anchor = self._validate_anchor(anchor)

        clean_mentions = [
            str(m)[:_MAX_REF] for m in (mentions or []) if isinstance(m, str) and m
        ][:_MAX_MENTIONS]

        now = time.time()
        comment = Comment(
            id=new_id(),
            doc_id=doc_id,
            body=clean_body,
            author_name=(author_name or "Guest").strip()[:60] or "Guest",
            created_at=now,
            updated_at=now,
            author_id=author_id,
            author_color=author_color,
            page_id=str(page_id)[:_MAX_REF] if page_id else None,
            parent_id=parent_id,
            anchor=anchor,
            mentions=clean_mentions,
        )
        self._repo.save_comment(comment)
        return comment

    def update(
        self,
        doc_id: str,
        comment_id: str,
        body: str | None = None,
        resolved: bool | None = None,
    ) -> Comment:
        comment = self.get(doc_id, comment_id)
        if body is not None:
            clean = body.strip()
            if not clean:
                raise InvalidComment("Comment body cannot be empty.")
            if len(clean) > _MAX_BODY:
                raise InvalidComment(f"Comment is too long (max {_MAX_BODY} characters).")
            comment.body = clean
        if resolved is not None:
            if comment.parent_id:
                raise InvalidComment("Only root comments can be resolved.")
            comment.resolved = bool(resolved)
        comment.updated_at = time.time()
        self._repo.save_comment(comment)
        return comment

    def delete(self, doc_id: str, comment_id: str) -> list[str]:
        """Delete a comment; a root takes its replies with it. Returns the ids
        actually removed."""
        target = self.get(doc_id, comment_id)
        ids = [target.id]
        if not target.parent_id:  # root → cascade replies
            ids += [
                c.id
                for c in self._repo.list_comments(doc_id)
                if c.parent_id == target.id
            ]
        self._repo.delete_comments(doc_id, ids)
        return ids

    @staticmethod
    def _validate_anchor(anchor: object) -> dict:
        if not isinstance(anchor, dict):
            raise InvalidComment("A root comment needs an anchor (node/edge/point).")
        kind = anchor.get("kind")
        if kind in ("node", "edge"):
            ref = anchor.get("ref")
            if not isinstance(ref, str) or not ref or len(ref) > _MAX_REF:
                raise InvalidComment("Node/edge anchor needs a valid 'ref'.")
            return {"kind": kind, "ref": ref}
        if kind == "point":
            x, y = anchor.get("x"), anchor.get("y")
            if not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
                raise InvalidComment("Point anchor needs numeric x/y coordinates.")
            return {"kind": "point", "x": float(x), "y": float(y)}
        raise InvalidComment("Anchor kind must be node | edge | point.")
