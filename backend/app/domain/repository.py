"""The repository PORT.

``DocumentService`` depends only on this Protocol; a concrete adapter
(``infrastructure.file_repository.FileDocumentRepository``) implements it. This
is the seam that lets storage move to Postgres/S3 later without touching the
service or domain.
"""
from __future__ import annotations

from collections.abc import Collection
from typing import Protocol

from app.domain.models import (
    BillingEvent,
    Comment,
    Document,
    DocumentMeta,
    DocumentVersion,
    Folder,
    Subscription,
)


class DocumentRepository(Protocol):
    """Persistence port for documents + folders."""

    # ---- documents ---------------------------------------------------------
    def save(self, doc: Document) -> None:
        """Persist (create or overwrite) a document, its metadata and diagram."""
        ...

    def load(self, doc_id: str) -> Document | None:
        """Return the document (svg + diagram), or ``None`` if absent."""
        ...

    def list(self) -> list[DocumentMeta]:
        """Return metadata for all documents (order unspecified)."""
        ...

    def list_for_user(
        self, user_id: str, team_ids: Collection[str]
    ) -> list[DocumentMeta]:
        """Metadata for every board this user may LIST (dashboard semantics,
        ``domain.models.listed_for``): owned, shared to them, or belonging to
        one of ``team_ids`` (the caller resolves the user's teams). Ownerless
        legacy boards are never returned. Order unspecified — DB v2 phase 4:
        the Pg adapter answers this from indexed columns/join tables instead
        of the API scanning ``list()``."""
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

    # ---- folders -----------------------------------------------------------
    def list_folders(self) -> list[Folder]:
        """Return all folders (order unspecified)."""
        ...

    def save_folder(self, folder: Folder) -> None:
        """Persist (create or overwrite) a folder."""
        ...

    def delete_folder(self, folder_id: str) -> None:
        """Remove a folder. A no-op if it does not exist."""
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


class BillingRepository(Protocol):
    """Persistence port for subscriptions + webhook idempotency.

    Implemented by ``infrastructure.billing_repository.FileBillingRepository``
    and ``infrastructure.pg_billing_repository.PgBillingRepository``.
    """

    def get_subscription(self, user_id: str) -> Subscription | None:
        """This user's subscription row, or ``None`` (= free tier)."""
        ...

    def upsert_subscription(self, sub: Subscription) -> None:
        """Create or overwrite the subscription keyed by ``user_id``."""
        ...

    def get_team_subscription(self, team_id: str) -> Subscription | None:
        """An active-record "team" tier subscription linked to this team."""
        ...

    def record_webhook_event(self, event_id: str, name: str, payload: dict) -> bool:
        """Record a webhook delivery for idempotency.

        Returns ``True`` when this is the FIRST time the event id is seen,
        ``False`` for a duplicate (the caller must then no-op).
        """
        ...

    # ---- billing history (user-visible ledger) ------------------------------
    def add_event(
        self,
        user_id: str,
        event: str,
        amount_usd: float | None,
        credits_granted: int,
        raw: dict,
    ) -> None:
        """Append one billing-history row for ``user_id`` (timestamped now)."""
        ...

    def list_events(self, user_id: str, limit: int = 20) -> list[BillingEvent]:
        """This user's billing history, NEWEST FIRST, at most ``limit`` rows."""
        ...


class PricingRepository(Protocol):
    """Persistence port for the materialized model-price catalog.

    The version-controlled seed (``domain/pricing_seed.json``) is synced into
    this store at boot: a NEWER seed version overwrites the stored catalog
    ("edit the JSON, redeploy, it reflects"); an equal/older seed leaves the
    stored catalog alone. Implemented by
    ``infrastructure.pricing_repository.FilePricingRepository`` and
    ``infrastructure.pg_pricing_repository.PgPricingRepository``.
    """

    def load_catalog(self) -> dict | None:
        """The stored catalog dict (PriceCatalog.from_dict shape), or None."""
        ...

    def save_catalog(self, data: dict) -> None:
        """Overwrite the stored catalog with ``data``."""
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

    def mentions_of_user(self, user_id: str, limit: int = 200) -> list[Comment]:
        """Comments (across ALL documents) that @mention this user, authored
        by someone else — newest first, capped at ``limit``. DB v2 phase 4
        (P5): the Pg adapter answers this from the ``mentions`` fan-out table;
        the caller must still filter by view access per board."""
        ...
