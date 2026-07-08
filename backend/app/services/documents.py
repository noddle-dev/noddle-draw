"""DocumentService — the use-case layer.

Owns the business rules once, testable without HTTP or a real filesystem:
  * sanitize SVG *before* it is stored (and it's stored sanitized, so reads are
    already clean too),
  * validate the optional diagram JSON (structure + size cap) before storing,
  * mint ids as ``uuid4().hex[:12]`` and bookkeep created/updated timestamps,
  * validate the id shape before any lookup,
  * folder CRUD — deleting a folder moves its documents to the root.

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
from app.domain.models import Document, DocumentMeta, DocumentVersion, Folder
from app.domain.repository import DocumentRepository, VersionRepository
from app.security.svg_sanitizer import sanitize_svg
from app.services.auth import AuthError, Principal

# Sentinel distinguishing "not provided" from an explicit None (move to root /
# keep diagram unchanged).
_UNSET = object()

_MAX_DIAGRAM_BYTES = 1_000_000  # 1 MB of JSON is plenty for a board

# Version history: rapid autosaves (1.8s debounce) COALESCE into the newest
# snapshot instead of stacking — a new version starts only after this gap.
_VERSION_COALESCE_S = 60.0
_MAX_VERSIONS = 50

_FOLDER_COLORS = ["#2563eb", "#7c3aed", "#16a34a", "#d97706", "#dc2626", "#0891b2"]


class DocumentNotFound(Exception):
    """Raised when a document id is malformed or does not exist."""


class FolderNotFound(Exception):
    """Raised when a folder id is malformed or does not exist."""


class FolderAccessDenied(Exception):
    """Raised when a principal touches a folder OWNED by someone else.

    Transition rule (DB v2, 2026-07-05): folders created before ownership
    existed have ``owner_id is None`` (LEGACY) — those stay visible and
    mutable to everyone, exactly like before, so nothing disappears after
    the migration. Owned folders are private to their owner. → 403.
    """


class InvalidSvg(Exception):
    """Raised when uploaded/saved SVG cannot be sanitized/parsed."""


class InvalidDiagram(Exception):
    """Raised when the diagram payload is not a valid board JSON."""


class VersionNotFound(Exception):
    """Raised when a version id does not exist for this document."""


def require_folder_creator(principal: Principal) -> None:
    """Creating a folder requires an IDENTITY — the same amendment-2026-07-05
    rule as creating a board (an anonymous create would mint an ownerless,
    everyone-visible legacy folder). Agents with boards:write create folders
    owned by their token's owner. Raises ``AuthError`` (→ 401 in the api
    layer). Lives here (not api/) so it is unit-testable without HTTP —
    same pattern as ``services.activity.require_team_admin``."""
    if principal.user_id is None and not (
        principal.kind == "agent" and principal.has_scope("boards:write")
    ):
        raise AuthError("Sign in to create a folder.")


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

    def list_for_user(
        self, user_id: str, team_ids: Collection[str]
    ) -> list[DocumentMeta]:
        """Boards this user may list (owned / shared / team), newest first."""
        return sorted(
            self._repo.list_for_user(user_id, team_ids),
            key=lambda m: m.updated_at,
            reverse=True,
        )

    def metas_by_ids(self, doc_ids: Collection[str]) -> list[DocumentMeta]:
        return self._repo.metas_by_ids(doc_ids)

    def create(
        self,
        raw_svg: str,
        name: str | None,
        folder_id: str | None = None,
        diagram: dict | None = None,
        owner_id: str | None = None,
        link_policy: str = "private",
    ) -> DocumentMeta:
        clean = self._sanitize(raw_svg)
        if folder_id is not None:
            self._require_folder(folder_id)
        if diagram is not None:
            diagram = self._validate_diagram(diagram)
        now = time.time()
        meta = DocumentMeta(
            id=new_id(),
            name=name or "untitled.svg",
            created_at=now,
            updated_at=now,
            folder_id=folder_id,
            owner_id=owner_id,
            # New boards are PRIVATE until the owner shares (explicit, so the
            # default here never drifts from the security posture). Anonymous
            # mode passes "edit": the link is the capability (Excalidraw-style).
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
        # A payload save must NEVER touch the ACL — carry every meta field.
        # (Rebuilding the meta without owner/shares once silently degraded a
        # private board to legacy-open after any editor's save.)
        meta = replace(existing.meta, updated_at=time.time())
        self._repo.save(Document(meta=meta, svg=clean, diagram=new_diagram))
        self._record_version(doc_id, clean, new_diagram, author_name)
        return meta

    def storage_used(self, owner_id: str) -> int:
        """Bytes at rest across every board this user OWNS (#23)."""
        # list_for_user (owner branch) instead of a full scan; the owner_id
        # filter drops the shared-to-me rows it also returns.
        return sum(
            self._repo.payload_size(m.id)
            for m in self._repo.list_for_user(owner_id, ())
            if m.owner_id == owner_id
        )

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

    def update_meta(
        self,
        doc_id: str,
        name: str | None = None,
        folder_id: object = _UNSET,
        link_policy: str | None = None,
        team_id: object = _UNSET,
        shares: dict | None = None,
    ) -> DocumentMeta:
        """Rename / move / adjust sharing knobs (authorization happens in the
        api layer — this is pure state transition)."""
        existing = self.get(doc_id)
        new_folder = existing.meta.folder_id
        if folder_id is not _UNSET:
            if folder_id is not None:
                self._require_folder(folder_id)  # type: ignore[arg-type]
            new_folder = folder_id  # type: ignore[assignment]
        meta = DocumentMeta(
            id=existing.meta.id,
            name=(name or existing.meta.name).strip() or existing.meta.name,
            created_at=existing.meta.created_at,
            updated_at=time.time(),
            folder_id=new_folder,
            owner_id=existing.meta.owner_id,
            team_id=existing.meta.team_id if team_id is _UNSET else team_id,  # type: ignore[arg-type]
            link_policy=link_policy or existing.meta.link_policy,
            shares=shares if shares is not None else dict(existing.meta.shares),
        )
        self._repo.save(
            Document(meta=meta, svg=existing.svg, diagram=existing.diagram)
        )
        return meta

    def delete(self, doc_id: str) -> None:
        if not is_valid_id(doc_id):
            raise DocumentNotFound(doc_id)
        self._repo.delete(doc_id)

    # ---- folders -----------------------------------------------------------
    # Ownership (DB v2, 2026-07-05 — fixes the v1 "folders are global" bug):
    # folders are per-user. TRANSITION RULE: legacy folders (owner_id None,
    # created before ownership existed) stay visible to EVERYONE and keep the
    # old open rename/delete behavior — so no folder disappears after the
    # migration. Owned folders are listed/mutable only by their owner.
    def list_folders(self, user_id: str | None = None) -> list[Folder]:
        """The caller's own folders PLUS legacy owner-less ones. Guests
        (``user_id is None``) see only the legacy folders."""
        return sorted(
            (
                f
                for f in self._repo.list_folders()
                if f.owner_id is None or f.owner_id == user_id
            ),
            key=lambda f: f.created_at,
        )

    def folder_counts(
        self, user_id: str | None = None, team_ids: Collection[str] = ()
    ) -> dict[str, int]:
        """folder_id → number of documents inside. Scoped to the boards the
        user may list when ``user_id`` is given (so counts match what their
        dashboard shows); unscoped for guests (legacy global folders)."""
        metas = (
            self._repo.list_for_user(user_id, team_ids)
            if user_id
            else self._repo.list()
        )
        counts: dict[str, int] = {}
        for m in metas:
            if m.folder_id:
                counts[m.folder_id] = counts.get(m.folder_id, 0) + 1
        return counts

    def create_folder(
        self, name: str, color: str | None = None, owner_id: str | None = None
    ) -> Folder:
        clean = name.strip() or "Untitled folder"
        n = len(self._repo.list_folders())
        folder = Folder(
            id=new_id(),
            name=clean,
            color=color or _FOLDER_COLORS[n % len(_FOLDER_COLORS)],
            created_at=time.time(),
            owner_id=owner_id,
        )
        self._repo.save_folder(folder)
        return folder

    def rename_folder(
        self,
        folder_id: str,
        name: str,
        color: str | None = None,
        user_id: str | None = None,
    ) -> Folder:
        folder = self._require_folder(folder_id)
        self._require_folder_owner(folder, user_id)
        folder.name = name.strip() or folder.name
        if color:
            folder.color = color
        self._repo.save_folder(folder)
        return folder

    def delete_folder(self, folder_id: str, user_id: str | None = None) -> None:
        folder = self._require_folder(folder_id)
        self._require_folder_owner(folder, user_id)
        # Documents in the folder move to the root rather than being deleted.
        for m in self._repo.list():
            if m.folder_id == folder_id:
                self.update_meta(m.id, folder_id=None)
        self._repo.delete_folder(folder_id)

    @staticmethod
    def _require_folder_owner(folder: Folder, user_id: str | None) -> None:
        """Mutations need the owner; legacy owner-less folders stay open."""
        if folder.owner_id is not None and folder.owner_id != user_id:
            raise FolderAccessDenied(folder.id)

    def _require_folder(self, folder_id: str) -> Folder:
        if not is_valid_id(folder_id):
            raise FolderNotFound(folder_id)
        for f in self._repo.list_folders():
            if f.id == folder_id:
                return f
        raise FolderNotFound(folder_id)

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
