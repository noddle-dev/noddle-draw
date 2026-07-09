"""The repository PORT.

``DocumentService`` depends only on this Protocol; a concrete adapter
(``infrastructure.file_repository.FileDocumentRepository``) implements it. This
is the seam that lets storage move to Postgres/S3 later without touching the
service or domain.
"""
from __future__ import annotations

from collections.abc import Collection
from typing import Protocol

from app.domain.models import Comment, Document, DocumentMeta, DocumentVersion


class DocumentRepository(Protocol):
    """Persistence port for documents."""

    def save(self, doc: Document) -> None:
        """Persist (create or overwrite) a document, its metadata and diagram."""
        ...

    def load(self, doc_id: str) -> Document | None:
        """Return the document (svg + diagram), or ``None`` if absent."""
        ...

    def list(self) -> list[DocumentMeta]:
        """Return metadata for all documents (order unspecified)."""
        ...

    def metas_by_ids(self, doc_ids: Collection[str]) -> list[DocumentMeta]:
        """Metadata for the given ids; unknown ids are silently skipped."""
        ...

    def delete(self, doc_id: str) -> None:
        """Remove a document. A no-op if it does not exist."""
        ...

    def exists(self, doc_id: str) -> bool:
        """True iff a document with this id is stored."""
        ...

    def payload_size(self, doc_id: str) -> int:
        """Bytes this document occupies at rest (svg + sidecars + versions)."""
        ...


class VersionRepository(Protocol):
    """Persistence port for document version snapshots."""

    def list_versions(self, doc_id: str) -> list[DocumentVersion]:
        """Version METADATA (no payloads), any order."""
        ...

    def load_version(self, doc_id: str, version_id: str) -> DocumentVersion | None:
        """One full snapshot (svg + diagram), or None."""
        ...

    def save_version(self, version: DocumentVersion) -> None:
        """Persist (create or overwrite by id) one snapshot."""
        ...

    def delete_versions(self, doc_id: str, version_ids: list[str]) -> None:
        """Remove the given snapshots. Unknown ids are ignored."""
        ...


class CommentRepository(Protocol):
    """Persistence port for a document's comment threads."""

    def list_comments(self, doc_id: str) -> list[Comment]:
        """Return all comments of a document (order unspecified)."""
        ...

    def save_comment(self, comment: Comment) -> None:
        """Persist (create or overwrite by id) one comment."""
        ...

    def delete_comments(self, doc_id: str, comment_ids: list[str]) -> None:
        """Remove the given comments. Unknown ids are ignored."""
        ...
