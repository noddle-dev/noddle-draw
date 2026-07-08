"""HTTP router for /api/folders — real folder CRUD.

Thin handlers over ``DocumentService``: list (with live doc counts), create,
rename, delete (documents inside move to the root, they are never deleted).

Ownership (DB v2, 2026-07-05 — fixes the v1 "folders are global" bug):
folders belong to the user who created them. Transition rule: LEGACY folders
(created before ownership, ``owner_id`` NULL) remain visible to everyone and
keep the old open rename/delete behavior so nothing disappears. Guests cannot
create folders (401 — same identity rule as creating boards) and only see the
legacy ones. The response shape (id/name/color/count) is unchanged — no
frontend change needed.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request

from app.api.auth import get_auth, get_principal
from app.api.schemas import FolderBody, FolderOut
from app.services.auth import AuthError, AuthService, Principal
from app.services.documents import (
    DocumentService,
    FolderAccessDenied,
    FolderNotFound,
    require_folder_creator,
)

router = APIRouter(prefix="/api/folders", tags=["folders"])

_NOT_FOUND = "Folder not found."
_NOT_YOURS = "Only the folder's owner can do this."


def get_service(request: Request) -> DocumentService:
    return request.app.state.document_service


def _team_ids(principal: Principal, auth: AuthService) -> list[str]:
    if not principal.user_id:
        return []
    return [t.id for t in auth.my_teams(principal.user_id)]


@router.get("")
def list_folders(
    service: DocumentService = Depends(get_service),
    principal: Principal = Depends(get_principal),
    auth: AuthService = Depends(get_auth),
) -> list[FolderOut]:
    counts = service.folder_counts(principal.user_id, _team_ids(principal, auth))
    return [
        FolderOut.from_domain(f, counts.get(f.id, 0))
        for f in service.list_folders(principal.user_id)
    ]


@router.post("")
def create_folder(
    body: FolderBody,
    service: DocumentService = Depends(get_service),
    principal: Principal = Depends(get_principal),
) -> FolderOut:
    try:
        require_folder_creator(principal)  # guests: new folders need an owner
    except AuthError as e:
        raise HTTPException(status_code=401, detail=str(e))
    folder = service.create_folder(body.name, body.color, owner_id=principal.user_id)
    return FolderOut.from_domain(folder, 0)


@router.patch("/{folder_id}")
def rename_folder(
    folder_id: str,
    body: FolderBody,
    service: DocumentService = Depends(get_service),
    principal: Principal = Depends(get_principal),
) -> FolderOut:
    try:
        folder = service.rename_folder(
            folder_id, body.name, body.color, user_id=principal.user_id
        )
    except FolderNotFound:
        raise HTTPException(status_code=404, detail=_NOT_FOUND)
    except FolderAccessDenied:
        raise HTTPException(status_code=403, detail=_NOT_YOURS)
    return FolderOut.from_domain(
        folder, service.folder_counts(principal.user_id).get(folder_id, 0)
    )


@router.delete("/{folder_id}")
def delete_folder(
    folder_id: str,
    service: DocumentService = Depends(get_service),
    principal: Principal = Depends(get_principal),
):
    try:
        service.delete_folder(folder_id, user_id=principal.user_id)
    except FolderNotFound:
        raise HTTPException(status_code=404, detail=_NOT_FOUND)
    except FolderAccessDenied:
        raise HTTPException(status_code=403, detail=_NOT_YOURS)
    return {"ok": True}
