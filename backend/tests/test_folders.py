"""Folder ownership rules (DB v2, 2026-07-05 — fixes the v1 "folders are
global" bug) over the REAL ``FileDocumentRepository`` on a tmp dir.

Same style as test_authz.py / test_profile.py: no HTTP client (httpx/TestClient
is not a dependency and the api/ modules can't import under this venv's
Python 3.9), so the endpoint logic is exercised at its service/guard level:
``DocumentService.list/create/rename/delete_folder`` and
``require_folder_creator`` (api/folders.py maps AuthError → 401 and
FolderAccessDenied → 403).

TRANSITION RULE under test: folders created before ownership existed have
``owner_id is None`` (LEGACY) — they stay visible to everyone and keep the
old open rename/delete behavior, so nothing disappears after the migration.
Owned folders are listed/mutable only by their owner.
"""
from __future__ import annotations

import json

import pytest

from app.infrastructure.file_repository import FileDocumentRepository
from app.services.auth import GUEST, AuthError, Principal
from app.services.documents import (
    DocumentService,
    FolderAccessDenied,
    require_folder_creator,
)

ALICE = "aaaaaaaaaaaa"
BOB = "bbbbbbbbbbbb"


@pytest.fixture
def repo(tmp_path) -> FileDocumentRepository:
    return FileDocumentRepository(tmp_path)


@pytest.fixture
def service(repo) -> DocumentService:
    return DocumentService(repo)


def user(uid: str) -> Principal:
    return Principal(kind="user", user_id=uid, name=uid)


def agent(uid: str | None, scopes: list[str]) -> Principal:
    return Principal(kind="agent", user_id=uid, agent_token_id="t", scopes=scopes)


# ---- create stamps the owner ---------------------------------------------------


def test_create_folder_stamps_owner(service, repo):
    folder = service.create_folder("Design", owner_id=ALICE)
    assert folder.owner_id == ALICE
    # persisted through the file adapter (fresh read from index.json)
    stored = {f.id: f for f in repo.list_folders()}
    assert stored[folder.id].owner_id == ALICE


def test_create_folder_without_owner_is_legacy(service, repo):
    folder = service.create_folder("Old world")
    assert folder.owner_id is None
    assert repo.list_folders()[0].owner_id is None


# ---- list filters by owner + legacy visibility ----------------------------------


def test_list_returns_own_plus_legacy_only(service):
    mine = service.create_folder("Mine", owner_id=ALICE)
    theirs = service.create_folder("Theirs", owner_id=BOB)
    legacy = service.create_folder("Legacy")  # owner_id None

    ids_alice = {f.id for f in service.list_folders(ALICE)}
    assert ids_alice == {mine.id, legacy.id}
    assert theirs.id not in ids_alice


def test_guest_sees_only_legacy_folders(service):
    service.create_folder("Mine", owner_id=ALICE)
    legacy = service.create_folder("Legacy")
    assert [f.id for f in service.list_folders(None)] == [legacy.id]


def test_legacy_index_record_without_owner_key_loads_as_legacy(service, tmp_path):
    """Pre-v2 index.json rows lack the owner_id key entirely — the dataclass
    default (None) must classify them as legacy, visible to everyone."""
    folder = service.create_folder("Pre-migration", owner_id=ALICE)
    index = tmp_path / "index.json"
    idx = json.loads(index.read_text("utf-8"))
    del idx["folders"][folder.id]["owner_id"]  # simulate a v1 record
    index.write_text(json.dumps(idx), "utf-8")

    listed = service.list_folders(BOB)  # a different user still sees it
    assert [f.id for f in listed] == [folder.id]
    assert listed[0].owner_id is None


# ---- rename / color / delete require the owner ----------------------------------


def test_owner_can_rename_and_recolor(service):
    folder = service.create_folder("Design", owner_id=ALICE)
    out = service.rename_folder(folder.id, "Research", "#16a34a", user_id=ALICE)
    assert (out.name, out.color) == ("Research", "#16a34a")


def test_non_owner_cannot_rename(service):
    folder = service.create_folder("Design", owner_id=ALICE)
    with pytest.raises(FolderAccessDenied):
        service.rename_folder(folder.id, "Hacked", user_id=BOB)
    with pytest.raises(FolderAccessDenied):  # guests neither
        service.rename_folder(folder.id, "Hacked", user_id=None)


def test_non_owner_cannot_delete(service, repo):
    folder = service.create_folder("Design", owner_id=ALICE)
    with pytest.raises(FolderAccessDenied):
        service.delete_folder(folder.id, user_id=BOB)
    assert repo.list_folders()  # still there


def test_owner_can_delete(service, repo):
    folder = service.create_folder("Design", owner_id=ALICE)
    service.delete_folder(folder.id, user_id=ALICE)
    assert repo.list_folders() == []


def test_legacy_folder_keeps_open_mutation_behavior(service, repo):
    """Owner-less folders keep the pre-v2 open behavior (like legacy
    ownerless boards): anyone may rename or delete them."""
    folder = service.create_folder("Legacy")
    service.rename_folder(folder.id, "Renamed by Bob", user_id=BOB)
    service.delete_folder(folder.id, user_id=None)  # even a guest
    assert repo.list_folders() == []


def test_delete_moves_documents_to_root_still_works(service, repo):
    folder = service.create_folder("Design", owner_id=ALICE)
    meta = service.create("<svg xmlns='http://www.w3.org/2000/svg'/>", "b.svg",
                          folder_id=folder.id, owner_id=ALICE)
    service.delete_folder(folder.id, user_id=ALICE)
    assert service.get(meta.id).meta.folder_id is None


# ---- create gate: guests get 401 (AuthError) at the guard level ------------------


def test_guest_cannot_create_folder():
    with pytest.raises(AuthError):
        require_folder_creator(GUEST)


def test_user_can_create_folder():
    require_folder_creator(user(ALICE))  # no raise


def test_write_agent_can_create_folder():
    require_folder_creator(agent(ALICE, ["boards:read", "boards:write"]))


def test_ownerless_agent_without_write_scope_cannot_create():
    with pytest.raises(AuthError):
        require_folder_creator(agent(None, ["boards:read"]))
