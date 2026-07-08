"""File-backed implementation of the DocumentRepository port.

Documents are stored as ``{id}.svg`` files (plus an optional ``{id}.diagram.json``
sidecar holding the editable node/edge JSON) under ``storage_dir`` with a JSON
index (``index.json``) holding metadata + folders:

    { "version": 2,
      "documents": { "<id>": {id, name, created_at, updated_at, folder_id} },
      "folders":   { "<id>": {id, name, color, created_at} } }

A v1 index (a bare ``{id: meta}`` mapping) is migrated transparently on read.
This is the only place that touches the filesystem for persistence, so swapping
to a DB/object store later means adding a sibling adapter — services and domain
stay untouched.
"""
from __future__ import annotations

import json
from dataclasses import asdict
from pathlib import Path

import shutil

from app.domain.ids import is_valid_id
from app.domain.models import (
    Comment,
    Document,
    DocumentMeta,
    DocumentVersion,
    Folder,
    listed_for,
)
from app.infrastructure.atomic import atomic_write_text


class FileDocumentRepository:
    """Concrete adapter implementing the ``DocumentRepository``,
    ``CommentRepository`` AND ``VersionRepository`` ports (comments live in a
    ``{id}.comments.json`` sidecar next to the SVG, mirroring the diagram
    sidecar; version snapshots live under ``versions/{id}/{vid}.json``)."""

    def __init__(self, storage_dir: Path) -> None:
        self._dir = Path(storage_dir)
        self._dir.mkdir(parents=True, exist_ok=True)
        self._index = self._dir / "index.json"

    # ---- JSON-index persistence -------------------------------------------
    def _load_index(self) -> dict:
        if not self._index.exists():
            return {"version": 2, "documents": {}, "folders": {}}
        raw = json.loads(self._index.read_text("utf-8"))
        if "version" not in raw:  # v1: the whole file was the documents map
            return {"version": 2, "documents": raw, "folders": {}}
        raw.setdefault("documents", {})
        raw.setdefault("folders", {})
        return raw

    def _save_index(self, idx: dict) -> None:
        atomic_write_text(
            self._index, json.dumps(idx, ensure_ascii=False, indent=2)
        )

    def _doc_path(self, doc_id: str) -> Path:
        # Defence in depth: never build a path from an id that isn't the
        # minted shape, so a separator/traversal can't reach the filesystem.
        if not is_valid_id(doc_id):
            raise ValueError(f"Invalid document id: {doc_id!r}")
        return self._dir / f"{doc_id}.svg"

    def _diagram_path(self, doc_id: str) -> Path:
        if not is_valid_id(doc_id):
            raise ValueError(f"Invalid document id: {doc_id!r}")
        return self._dir / f"{doc_id}.diagram.json"

    def _comments_path(self, doc_id: str) -> Path:
        if not is_valid_id(doc_id):
            raise ValueError(f"Invalid document id: {doc_id!r}")
        return self._dir / f"{doc_id}.comments.json"

    def _versions_dir(self, doc_id: str) -> Path:
        if not is_valid_id(doc_id):
            raise ValueError(f"Invalid document id: {doc_id!r}")
        return self._dir / "versions" / doc_id

    @staticmethod
    def _meta_from(m: dict) -> DocumentMeta:
        """Index row → DocumentMeta. Rows persisted since ADR-0002 always carry
        ``link_policy`` (``asdict`` writes every field); truly pre-auth rows
        lack it and historically behaved as "edit" — pin that here so the
        dataclass default (now "private", amendment 2026-07-05) never
        retroactively locks a legacy board out of its own share links."""
        return DocumentMeta(**{"link_policy": "edit", **m})

    # ---- documents ----------------------------------------------------------
    def save(self, doc: Document) -> None:
        atomic_write_text(self._doc_path(doc.meta.id), doc.svg)
        dpath = self._diagram_path(doc.meta.id)
        if doc.diagram is not None:
            atomic_write_text(dpath, json.dumps(doc.diagram, ensure_ascii=False))
        else:
            dpath.unlink(missing_ok=True)
        idx = self._load_index()
        idx["documents"][doc.meta.id] = asdict(doc.meta)
        self._save_index(idx)

    def load(self, doc_id: str) -> Document | None:
        if not is_valid_id(doc_id):
            return None
        path = self._doc_path(doc_id)
        if not path.exists():
            return None
        idx = self._load_index()
        m = idx["documents"].get(doc_id)
        if m is None:
            return None
        diagram = None
        dpath = self._diagram_path(doc_id)
        if dpath.exists():
            try:
                diagram = json.loads(dpath.read_text("utf-8"))
            except ValueError:  # corrupt sidecar — treat as absent
                diagram = None
        return Document(
            meta=self._meta_from(m), svg=path.read_text("utf-8"), diagram=diagram
        )

    def list(self) -> list[DocumentMeta]:
        idx = self._load_index()
        return [self._meta_from(m) for m in idx["documents"].values()]

    def list_for_user(self, user_id, team_ids) -> list[DocumentMeta]:
        # Scan-and-filter is fine here: the file adapter is the local-dev
        # fallback; the Pg adapter answers the same question from indexed
        # columns/join tables (DB v2 phase 4).
        team_set = set(team_ids)
        return [m for m in self.list() if listed_for(m, user_id, team_set)]

    def metas_by_ids(self, doc_ids) -> list[DocumentMeta]:
        docs = self._load_index()["documents"]
        return [
            self._meta_from(docs[d]) for d in doc_ids if d in docs
        ]

    def delete(self, doc_id: str) -> None:
        if not is_valid_id(doc_id):
            return
        idx = self._load_index()
        if doc_id in idx["documents"]:
            del idx["documents"][doc_id]
            self._save_index(idx)
        self._doc_path(doc_id).unlink(missing_ok=True)
        self._diagram_path(doc_id).unlink(missing_ok=True)
        self._comments_path(doc_id).unlink(missing_ok=True)
        shutil.rmtree(self._versions_dir(doc_id), ignore_errors=True)

    def exists(self, doc_id: str) -> bool:
        return is_valid_id(doc_id) and self._doc_path(doc_id).exists()

    def payload_size(self, doc_id: str) -> int:
        if not is_valid_id(doc_id):
            return 0
        total = 0
        for path in (
            self._doc_path(doc_id),
            self._diagram_path(doc_id),
            self._comments_path(doc_id),
        ):
            if path.exists():
                total += path.stat().st_size
        vdir = self._versions_dir(doc_id)
        if vdir.is_dir():
            total += sum(p.stat().st_size for p in vdir.glob("*.json"))
        return total

    # ---- comments (CommentRepository port) -----------------------------------
    def _load_comments(self, doc_id: str) -> list[dict]:
        path = self._comments_path(doc_id)
        if not path.exists():
            return []
        try:
            raw = json.loads(path.read_text("utf-8"))
        except ValueError:  # corrupt sidecar — treat as empty
            return []
        return raw if isinstance(raw, list) else []

    def _write_comments(self, doc_id: str, items: list[dict]) -> None:
        path = self._comments_path(doc_id)
        if items:
            atomic_write_text(path, json.dumps(items, ensure_ascii=False))
        else:
            path.unlink(missing_ok=True)

    def list_comments(self, doc_id: str) -> list[Comment]:
        if not is_valid_id(doc_id):
            return []
        out = []
        for item in self._load_comments(doc_id):
            try:
                out.append(Comment(**item))
            except TypeError:  # unknown/missing fields — skip the record
                continue
        return out

    def save_comment(self, comment: Comment) -> None:
        items = self._load_comments(comment.doc_id)
        record = asdict(comment)
        for i, item in enumerate(items):
            if item.get("id") == comment.id:
                items[i] = record
                break
        else:
            items.append(record)
        self._write_comments(comment.doc_id, items)

    def delete_comments(self, doc_id: str, comment_ids: list[str]) -> None:
        if not is_valid_id(doc_id):
            return
        drop = set(comment_ids)
        items = [c for c in self._load_comments(doc_id) if c.get("id") not in drop]
        self._write_comments(doc_id, items)

    def mentions_of_user(self, user_id: str, limit: int = 200) -> list[Comment]:
        # Scan every board's comment sidecar — acceptable in the local-dev
        # fallback; the Pg adapter uses the mentions fan-out table (P5).
        out: list[Comment] = []
        for doc_id in self._load_index()["documents"]:
            for c in self.list_comments(doc_id):
                if user_id in c.mentions and c.author_id != user_id:
                    out.append(c)
        out.sort(key=lambda c: c.created_at, reverse=True)
        return out[:limit]

    # ---- versions (VersionRepository port) -----------------------------------
    def list_versions(self, doc_id: str) -> list[DocumentVersion]:
        vdir = self._versions_dir(doc_id)
        if not vdir.is_dir():
            return []
        out: list[DocumentVersion] = []
        for path in vdir.glob("*.json"):
            try:
                raw = json.loads(path.read_text("utf-8"))
                # metadata only — payloads stay on disk until load_version
                out.append(
                    DocumentVersion(
                        id=str(raw["id"]),
                        doc_id=doc_id,
                        created_at=float(raw["created_at"]),
                        author_name=str(raw.get("author_name") or ""),
                    )
                )
            except (ValueError, KeyError, TypeError):
                continue  # corrupt snapshot — skip
        return out

    def load_version(self, doc_id: str, version_id: str) -> DocumentVersion | None:
        if not is_valid_id(version_id):
            return None
        path = self._versions_dir(doc_id) / f"{version_id}.json"
        if not path.exists():
            return None
        try:
            raw = json.loads(path.read_text("utf-8"))
            return DocumentVersion(
                id=str(raw["id"]),
                doc_id=doc_id,
                created_at=float(raw["created_at"]),
                author_name=str(raw.get("author_name") or ""),
                svg=str(raw.get("svg") or ""),
                diagram=raw.get("diagram"),
            )
        except (ValueError, KeyError, TypeError):
            return None

    def save_version(self, version: DocumentVersion) -> None:
        vdir = self._versions_dir(version.doc_id)
        vdir.mkdir(parents=True, exist_ok=True)
        record = asdict(version)
        record.pop("doc_id", None)  # implied by the directory
        atomic_write_text(
            vdir / f"{version.id}.json", json.dumps(record, ensure_ascii=False)
        )

    def delete_versions(self, doc_id: str, version_ids: list[str]) -> None:
        vdir = self._versions_dir(doc_id)
        for vid in version_ids:
            if is_valid_id(vid):
                (vdir / f"{vid}.json").unlink(missing_ok=True)

    # ---- folders -------------------------------------------------------------
    def list_folders(self) -> list[Folder]:
        idx = self._load_index()
        return [Folder(**f) for f in idx["folders"].values()]

    def save_folder(self, folder: Folder) -> None:
        idx = self._load_index()
        idx["folders"][folder.id] = asdict(folder)
        self._save_index(idx)

    def delete_folder(self, folder_id: str) -> None:
        idx = self._load_index()
        if folder_id in idx["folders"]:
            del idx["folders"][folder_id]
            self._save_index(idx)
