"""HTTP router for /api/documents.

Handlers are thin: they validate/parse input, call the injected
``DocumentService``, translate domain errors to HTTP, and map domain models to
DTOs. Every route now resolves the acting ``Principal`` (session cookie, agent
bearer token, or guest) and enforces the ADR-0002 access model through
``services.auth.can``:

    action "view"   → GET one / export / list-filter
    action "edit"   → PUT payload, rename/move-to-folder
    action "manage" → delete, sharing (link_policy / team / per-user shares)
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel

from app.api.auth import get_auth, get_principal, require_user
from app.api.schemas import (
    BLANK_BOARD_SVG,
    CreateDocBody,
    DocMeta,
    DocumentOut,
    PatchDocBody,
    SaveBody,
)
from app.domain.models import DocumentMeta
from app.services.auth import AuthService, Principal, can
from app.services.billing import QuotaExceeded
from app.services.diagram_render import diagram_to_svg
from app.services.drawio import InvalidDrawio, drawio_to_diagram
from app.services.auth import anon_mode_enabled
from app.services.documents import (
    DocumentNotFound,
    DocumentService,
    FolderNotFound,
    InvalidDiagram,
    InvalidSvg,
    VersionNotFound,
)

router = APIRouter(prefix="/api/documents", tags=["documents"])

_NOT_FOUND = "Document not found."
_NO_EDIT = "You only have view access to this board."
_NO_MANAGE = "Only the owner (or a team admin) can do this."


def get_service(request: Request) -> DocumentService:
    """DI hook: the concrete service is stashed on app state in create_app()."""
    return request.app.state.document_service


def get_audit(request: Request):
    return request.app.state.audit_service


def get_notifications(request: Request):
    return request.app.state.notification_service


def _guard(
    principal: Principal, action: str, meta: DocumentMeta, auth: AuthService
) -> None:
    if not can(principal, action, meta, auth):
        raise HTTPException(
            status_code=403, detail=_NO_MANAGE if action == "manage" else _NO_EDIT
        )


def _require_creator(principal: Principal) -> None:
    """Creating a board requires an IDENTITY (amendment 2026-07-05): a signed-in
    user, or an agent token with boards:write (agents create boards owned by
    their owner — ``principal.user_id`` is the token owner's id). Guests may
    still view/edit shared boards per link_policy; only creation is gated —
    anonymous creates minted ownerless, unmanageable boards."""
    if anon_mode_enabled():
        return  # NODDLE_ANON: anonymous creation is the whole point
    if principal.user_id is None and not (
        principal.kind == "agent" and principal.has_scope("boards:write")
    ):
        raise HTTPException(status_code=401, detail="Sign in to create a board.")

def _creator_link_policy(principal: Principal) -> str:
    """Anonymous boards ship with link_policy "edit" — with no owner to grant
    access later, the URL itself must be the sharing capability."""
    return "edit" if principal.user_id is None else "private"



def _enforce_board_quota(
    request: Request, principal: Principal, service: DocumentService
) -> None:
    """Plan gate for creating a NEW board (upload / new / import) — a FREE-tier
    owner at their board limit gets 402 Payment Required. (Creation itself now
    requires an identity — ``_require_creator`` runs first — so the no-user_id
    early-return is just defence in depth.)"""
    if not principal.user_id:
        return
    owned = sum(
        1
        for m in service.list_for_user(principal.user_id, ())
        if m.owner_id == principal.user_id
    )
    try:
        request.app.state.billing_service.check_board_quota(principal, owned)
    except QuotaExceeded as e:
        raise HTTPException(status_code=402, detail=str(e))


@router.get("")
def list_documents(
    service: DocumentService = Depends(get_service),
    principal: Principal = Depends(get_principal),
    auth: AuthService = Depends(get_auth),
) -> list[DocMeta]:
    # DB v2 phase 4 (switch reads): the repository answers "boards I may
    # list" directly — indexed columns/join tables in Pg mode — instead of
    # this handler scanning every document with is_listed().
    if not principal.user_id:
        return []  # guests: link access ≠ discovery, nothing is ever listed
    team_ids = [t.id for t in auth.my_teams(principal.user_id)]
    return [
        DocMeta.from_domain(m)
        for m in service.list_for_user(principal.user_id, team_ids)
    ]


@router.post("")
async def upload_document(
    request: Request,
    file: UploadFile = File(...),
    service: DocumentService = Depends(get_service),
    principal: Principal = Depends(get_principal),
    audit=Depends(get_audit),
) -> DocMeta:
    _require_creator(principal)  # 401 for guests — new boards need an owner
    _enforce_board_quota(request, principal, service)  # may 402 (free-plan cap)
    raw = (await file.read()).decode("utf-8", errors="replace")
    try:
        meta = service.create(
            raw,
            file.filename,
            owner_id=principal.user_id,
            link_policy=_creator_link_policy(principal),
        )
    except InvalidSvg as e:
        raise HTTPException(status_code=400, detail=str(e))
    audit.log("doc.upload", principal, meta.id, meta.name)
    return DocMeta.from_domain(meta)


@router.post("/new")
def create_document(
    body: CreateDocBody,
    request: Request,
    service: DocumentService = Depends(get_service),
    principal: Principal = Depends(get_principal),
    audit=Depends(get_audit),
) -> DocMeta:
    """JSON create: blank board, template instance, or AI diagram."""
    _require_creator(principal)  # 401 for guests — new boards need an owner
    _enforce_board_quota(request, principal, service)  # may 402 (free-plan cap)
    # No SVG supplied but a diagram is → bake a preview SVG so the dashboard card
    # isn't blank until the board is first opened+saved. The baked group is
    # stripped on open then re-rendered from JSON, so no doubled shapes.
    initial_svg = body.svg
    if not initial_svg and body.diagram:
        try:
            initial_svg = diagram_to_svg(body.diagram)
        except Exception:
            initial_svg = None
    try:
        meta = service.create(
            initial_svg or BLANK_BOARD_SVG,
            body.name or "Untitled board",
            folder_id=body.folder_id,
            diagram=body.diagram,
            owner_id=principal.user_id,
            link_policy=_creator_link_policy(principal),
        )
    except InvalidSvg as e:
        raise HTTPException(status_code=400, detail=str(e))
    except InvalidDiagram as e:
        raise HTTPException(status_code=400, detail=str(e))
    except FolderNotFound:
        raise HTTPException(status_code=404, detail="Folder not found.")
    audit.log("doc.create", principal, meta.id, meta.name)
    return DocMeta.from_domain(meta)


@router.post("/import")
async def import_document(
    request: Request,
    file: UploadFile = File(...),
    service: DocumentService = Depends(get_service),
    principal: Principal = Depends(get_principal),
    audit=Depends(get_audit),
) -> DocMeta:
    """Import a foreign diagram file as a NEW editable board.

    Supported today: draw.io / diagrams.net (``.drawio`` / ``.xml`` — plain or
    deflate-compressed, multi-page → noddle pages). Mermaid ``.mmd`` files are
    handled client-side through the existing text→diagram AI path; ``.vsdx``
    is a spike (docs/spikes). A preview SVG is baked so the dashboard card
    isn't blank before the first open+save."""
    _require_creator(principal)  # 401 for guests — new boards need an owner
    _enforce_board_quota(request, principal, service)  # may 402 (free-plan cap)
    raw = (await file.read()).decode("utf-8", errors="replace")
    name = (file.filename or "Imported board").rsplit(".", 1)[0][:120]
    if "<mxfile" not in raw and "<mxGraphModel" not in raw:
        raise HTTPException(
            status_code=400,
            detail="Format not supported yet — currently accepts draw.io files (.drawio/.xml).",
        )
    try:
        diagram = drawio_to_diagram(raw)
    except InvalidDrawio as e:
        raise HTTPException(status_code=400, detail=str(e))
    try:
        svg = diagram_to_svg(diagram)
    except Exception:  # preview is best-effort — never fail the import on it
        svg = BLANK_BOARD_SVG
    try:
        meta = service.create(
            svg, name, diagram=diagram, owner_id=principal.user_id,
            link_policy=_creator_link_policy(principal),
        )
    except InvalidDiagram as e:
        raise HTTPException(status_code=400, detail=str(e))
    except InvalidSvg:
        meta = service.create(
            BLANK_BOARD_SVG, name, diagram=diagram, owner_id=principal.user_id,
            link_policy=_creator_link_policy(principal),
        )
    audit.log("doc.import", principal, meta.id, file.filename or name)
    return DocMeta.from_domain(meta)


@router.get("/shared")
def list_shared_with_me(
    service: DocumentService = Depends(get_service),
    principal: Principal = Depends(get_principal),
    auth: AuthService = Depends(get_auth),
) -> list[dict]:
    """Boards someone ELSE owns that this user can access by name (per-user
    share or team) — the "Shared with me" table. Registered *before*
    ``/{doc_id}`` so the literal path wins; guests get an empty list."""
    if not principal.user_id:
        return []
    team_ids = [t.id for t in auth.my_teams(principal.user_id)]
    rows: list[dict] = []
    # list_for_user already applies the listing rule (and sorts newest
    # first); everything it returns that I don't own is share- or team-visible.
    for m in service.list_for_user(principal.user_id, team_ids):
        if m.owner_id == principal.user_id:
            continue  # owned boards live in the main dashboard list
        rows.append(
            {
                "id": m.id,
                "name": m.name,
                "updated_at": m.updated_at,
                "owner": auth.user_public(m.owner_id),
                "my_role": _role_of(principal, m, auth),
                "via": "share" if principal.user_id in m.shares else "team",
            }
        )
    return rows


@router.get("/{doc_id}")
def get_document(
    doc_id: str,
    service: DocumentService = Depends(get_service),
    principal: Principal = Depends(get_principal),
    auth: AuthService = Depends(get_auth),
) -> DocumentOut:
    try:
        doc = service.get(doc_id)
    except DocumentNotFound:
        raise HTTPException(status_code=404, detail=_NOT_FOUND)
    _guard(principal, "view", doc.meta, auth)
    out = DocumentOut.from_domain(doc)
    out.my_role = _role_of(principal, doc.meta, auth)
    # The owner's public profile powers the editor's "Owned by …" chip — every
    # viewer sees it (unlike GET /shares, which is manage-only).
    out.owner = auth.user_public(doc.meta.owner_id) if doc.meta.owner_id else None
    return out


def _role_of(principal: Principal, meta: DocumentMeta, auth: AuthService) -> str:
    """The caller's effective role — the frontend uses it to lock the UI."""
    if can(principal, "manage", meta, auth):
        return "owner"
    if can(principal, "edit", meta, auth):
        return "editor"
    return "viewer"


@router.put("/{doc_id}")
def save_document(
    doc_id: str,
    body: SaveBody,
    service: DocumentService = Depends(get_service),
    principal: Principal = Depends(get_principal),
    auth: AuthService = Depends(get_auth),
) -> DocMeta:
    try:
        existing = service.get(doc_id)
    except DocumentNotFound:
        raise HTTPException(status_code=404, detail=_NOT_FOUND)
    _guard(principal, "edit", existing.meta, auth)
    author = principal.name if principal.is_authenticated else ""
    try:
        if "diagram" in body.model_fields_set:
            meta = service.save(
                doc_id, body.svg, diagram=body.diagram, author_name=author
            )
        else:  # legacy clients that send svg only → keep the stored diagram
            meta = service.save(doc_id, body.svg, author_name=author)
    except InvalidSvg as e:
        raise HTTPException(status_code=400, detail=str(e))
    except InvalidDiagram as e:
        raise HTTPException(status_code=400, detail=str(e))
    return DocMeta.from_domain(meta)


@router.patch("/{doc_id}")
def patch_document(
    doc_id: str,
    body: PatchDocBody,
    service: DocumentService = Depends(get_service),
    principal: Principal = Depends(get_principal),
    auth: AuthService = Depends(get_auth),
    audit=Depends(get_audit),
) -> DocMeta:
    """Rename / move-to-folder need "edit"; sharing knobs (link_policy,
    team_id) need "manage"."""
    try:
        existing = service.get(doc_id)
    except DocumentNotFound:
        raise HTTPException(status_code=404, detail=_NOT_FOUND)

    kwargs: dict = {}
    if "name" in body.model_fields_set and body.name is not None:
        kwargs["name"] = body.name
    if "folder_id" in body.model_fields_set:
        # Moving INTO a folder: it must be one the caller can use (their own or
        # a legacy owner-less folder) — never file a board into someone else's.
        if body.folder_id is not None:
            allowed = {f.id for f in service.list_folders(principal.user_id)}
            if body.folder_id not in allowed:
                raise HTTPException(status_code=403, detail="You can't move a board into that folder.")
        kwargs["folder_id"] = body.folder_id
    share_kwargs: dict = {}
    if "link_policy" in body.model_fields_set and body.link_policy is not None:
        if body.link_policy not in ("edit", "view", "private"):
            raise HTTPException(status_code=400, detail="Invalid link_policy.")
        share_kwargs["link_policy"] = body.link_policy
    if "team_id" in body.model_fields_set:
        share_kwargs["team_id"] = body.team_id

    if kwargs:
        _guard(principal, "edit", existing.meta, auth)
    if share_kwargs:
        _guard(principal, "manage", existing.meta, auth)
        if share_kwargs.get("team_id") and not auth.team_role(
            principal.user_id, share_kwargs["team_id"]
        ):
            raise HTTPException(status_code=400, detail="You are not a member of that team.")

    try:
        meta = service.update_meta(doc_id, **kwargs, **share_kwargs)
    except DocumentNotFound:
        raise HTTPException(status_code=404, detail=_NOT_FOUND)
    except FolderNotFound:
        raise HTTPException(status_code=404, detail="Folder not found.")
    if share_kwargs:  # sharing knobs are the security-relevant part of PATCH
        audit.log(
            "share.policy", principal, doc_id,
            ", ".join(f"{k}={v}" for k, v in share_kwargs.items()),
        )
    return DocMeta.from_domain(meta)


@router.get("/{doc_id}/audit")
def doc_audit(
    doc_id: str,
    service: DocumentService = Depends(get_service),
    principal: Principal = Depends(get_principal),
    auth: AuthService = Depends(get_auth),
    audit=Depends(get_audit),
) -> list[dict]:
    """Owner-visible audit trail (#22): who created/imported/deleted/shared."""
    try:
        doc = service.get(doc_id)
    except DocumentNotFound:
        raise HTTPException(status_code=404, detail=_NOT_FOUND)
    _guard(principal, "manage", doc.meta, auth)
    return audit.for_doc(doc_id)


@router.delete("/{doc_id}")
def delete_document(
    doc_id: str,
    service: DocumentService = Depends(get_service),
    principal: Principal = Depends(get_principal),
    auth: AuthService = Depends(get_auth),
    audit=Depends(get_audit),
):
    try:
        existing = service.get(doc_id)
    except DocumentNotFound:
        raise HTTPException(status_code=404, detail=_NOT_FOUND)
    _guard(principal, "manage", existing.meta, auth)
    service.delete(doc_id)
    audit.log("doc.delete", principal, doc_id, existing.meta.name)
    return {"ok": True}


@router.get("/{doc_id}/export.svg")
def export_svg(
    doc_id: str,
    service: DocumentService = Depends(get_service),
    principal: Principal = Depends(get_principal),
    auth: AuthService = Depends(get_auth),
):
    try:
        doc = service.get(doc_id)
    except DocumentNotFound:
        raise HTTPException(status_code=404, detail=_NOT_FOUND)
    _guard(principal, "view", doc.meta, auth)
    # Legacy blanks: template/AI boards created before preview-baking (or never
    # opened) have an empty SVG but a diagram sidecar — render one on the fly so
    # the preview isn't blank. Boards that were opened+saved carry the baked
    # group and keep their richer client-rendered SVG.
    svg = doc.svg
    if doc.diagram and "noddle-diagram-baked" not in svg:
        try:
            svg = diagram_to_svg(doc.diagram)
        except Exception:
            svg = doc.svg
    return Response(
        content=svg,
        media_type="image/svg+xml",
        headers={"Content-Disposition": f'attachment; filename="{doc_id}.svg"'},
    )


# ---- version history ---------------------------------------------------------


@router.get("/{doc_id}/versions")
def list_versions(
    doc_id: str,
    service: DocumentService = Depends(get_service),
    principal: Principal = Depends(get_principal),
    auth: AuthService = Depends(get_auth),
) -> list[dict]:
    """Snapshot metadata, newest first. Needs "view" (like reading the board)."""
    try:
        doc = service.get(doc_id)
    except DocumentNotFound:
        raise HTTPException(status_code=404, detail=_NOT_FOUND)
    _guard(principal, "view", doc.meta, auth)
    return [
        {"id": v.id, "created_at": v.created_at, "author_name": v.author_name}
        for v in service.list_versions(doc_id)
    ]


@router.get("/{doc_id}/versions/{version_id}")
def get_version(
    doc_id: str,
    version_id: str,
    service: DocumentService = Depends(get_service),
    principal: Principal = Depends(get_principal),
    auth: AuthService = Depends(get_auth),
) -> dict:
    """One full snapshot (svg + diagram) for preview/restore. Restore itself is
    client-driven: the frontend PUTs this payload back as a normal save."""
    try:
        doc = service.get(doc_id)
    except DocumentNotFound:
        raise HTTPException(status_code=404, detail=_NOT_FOUND)
    _guard(principal, "view", doc.meta, auth)
    try:
        v = service.get_version(doc_id, version_id)
    except VersionNotFound:
        raise HTTPException(status_code=404, detail="Version not found.")
    return {
        "id": v.id,
        "created_at": v.created_at,
        "author_name": v.author_name,
        "svg": v.svg,
        "diagram": v.diagram,
    }


# ---- per-user shares ---------------------------------------------------------


class ShareBody(BaseModel):
    email: str
    role: str = "editor"  # editor | viewer


@router.get("/{doc_id}/shares")
def list_shares(
    doc_id: str,
    service: DocumentService = Depends(get_service),
    principal: Principal = Depends(require_user),
    auth: AuthService = Depends(get_auth),
) -> dict:
    try:
        doc = service.get(doc_id)
    except DocumentNotFound:
        raise HTTPException(status_code=404, detail=_NOT_FOUND)
    _guard(principal, "manage", doc.meta, auth)
    people = []
    for uid, role in doc.meta.shares.items():
        u = auth.user_public(uid)
        if u:
            people.append({**u, "role": role})
    owner = auth.user_public(doc.meta.owner_id) if doc.meta.owner_id else None
    return {
        "owner": owner,
        "shares": people,
        "link_policy": doc.meta.link_policy,
        "team_id": doc.meta.team_id,
    }


@router.post("/{doc_id}/shares")
def add_share(
    doc_id: str,
    body: ShareBody,
    service: DocumentService = Depends(get_service),
    principal: Principal = Depends(require_user),
    auth: AuthService = Depends(get_auth),
    audit=Depends(get_audit),
    notifications=Depends(get_notifications),
) -> dict:
    try:
        doc = service.get(doc_id)
    except DocumentNotFound:
        raise HTTPException(status_code=404, detail=_NOT_FOUND)
    _guard(principal, "manage", doc.meta, auth)
    user = auth.find_user_by_email(body.email)
    if not user:
        raise HTTPException(status_code=400, detail="No account exists with this email.")
    role = body.role if body.role in ("editor", "viewer") else "editor"
    shares = dict(doc.meta.shares)
    shares[user.id] = role
    service.update_meta(doc_id, shares=shares)
    audit.log("share.add", principal, doc_id, f"{user.email} → {role}")
    # 🔔 tell the recipient — best-effort, never blocks the share (skip a
    # self-share so you don't notify yourself).
    if user.id != principal.user_id:
        notifications.record(
            user.id,
            "share",
            doc_id=doc_id,
            doc_name=doc.meta.name,
            role=role,
            actor_name=principal.name,
            actor_color=principal.color,
        )
    return {"ok": True, "user": auth.user_public(user.id), "role": role}


@router.delete("/{doc_id}/shares/{user_id}")
def remove_share(
    doc_id: str,
    user_id: str,
    service: DocumentService = Depends(get_service),
    principal: Principal = Depends(require_user),
    auth: AuthService = Depends(get_auth),
    audit=Depends(get_audit),
):
    try:
        doc = service.get(doc_id)
    except DocumentNotFound:
        raise HTTPException(status_code=404, detail=_NOT_FOUND)
    _guard(principal, "manage", doc.meta, auth)
    shares = {k: v for k, v in doc.meta.shares.items() if k != user_id}
    service.update_meta(doc_id, shares=shares)
    audit.log("share.remove", principal, doc_id, user_id)
    return {"ok": True}
