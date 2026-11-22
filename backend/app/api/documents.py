"""HTTP router for /api/documents.

Handlers are thin: they validate/parse input, call the injected
``DocumentService``, translate domain errors to HTTP, and map domain models to
DTOs. noddle is anonymous-only — the board URL is the capability, enforced
through ``services.auth.can``:

    action "view" → GET one / export / versions / capture / agent presence
    action "edit" → PUT payload, rename

There is no board listing (link access ≠ discovery — the client keeps its own
recents in localStorage), no delete and no policy toggle: an anonymous board
has no owner who could be trusted with either.
"""
from __future__ import annotations

import anyio
from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from fastapi.responses import Response

from app.api.schemas import (
    BLANK_BOARD_SVG,
    CaptureBody,
    CreateDocBody,
    DocMeta,
    DocumentOut,
    PatchDocBody,
    PresenceBody,
    SaveBody,
)
from app.domain.models import DocumentMeta
from app.services.auth import GUEST, can
from app.services.diagram_render import diagram_to_svg

# Reject oversized uploads before decode/parse — the AI routes already cap at
# 8MB; do the same for file uploads/imports so a huge body can't tie up a
# worker (and, for .drawio, feed the decompressor).
_MAX_UPLOAD_BYTES = 8_000_000


async def _read_capped(file: UploadFile) -> str:
    raw = await file.read()
    if len(raw) > _MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="File is too large (8MB limit).")
    return raw.decode("utf-8", errors="replace")
from app.services.documents import (
    DocumentConflict,
    DocumentNotFound,
    DocumentService,
    InvalidDiagram,
    InvalidSvg,
    VersionNotFound,
)
from app.services.drawio import InvalidDrawio, drawio_to_diagram

router = APIRouter(prefix="/api/documents", tags=["documents"])

_NOT_FOUND = "Document not found."
_NO_VIEW = "You don't have permission to view this board."
_NO_EDIT = "This board's link is view-only."


def get_service(request: Request) -> DocumentService:
    """DI hook: the concrete service is stashed on app state in create_app()."""
    return request.app.state.document_service


def get_audit(request: Request):
    return request.app.state.audit_service


def _guard(action: str, meta: DocumentMeta) -> None:
    if not can(action, meta):
        raise HTTPException(
            status_code=403, detail=_NO_EDIT if action == "edit" else _NO_VIEW
        )


@router.post("")
async def upload_document(
    file: UploadFile = File(...),
    service: DocumentService = Depends(get_service),
    audit=Depends(get_audit),
) -> DocMeta:
    raw = await _read_capped(file)
    try:
        meta = service.create(raw, file.filename)
    except InvalidSvg as e:
        raise HTTPException(status_code=400, detail=str(e))
    audit.log("doc.upload", GUEST, meta.id, meta.name)
    return DocMeta.from_domain(meta)


@router.post("/new")
def create_document(
    body: CreateDocBody,
    service: DocumentService = Depends(get_service),
    audit=Depends(get_audit),
) -> DocMeta:
    """JSON create: blank board, template instance, or AI diagram."""
    # No SVG supplied but a diagram is → bake a preview SVG so exports aren't
    # blank until the board is first opened+saved. The baked group is stripped
    # on open then re-rendered from JSON, so no doubled shapes.
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
            diagram=body.diagram,
        )
    except InvalidSvg as e:
        raise HTTPException(status_code=400, detail=str(e))
    except InvalidDiagram as e:
        raise HTTPException(status_code=400, detail=str(e))
    audit.log("doc.create", GUEST, meta.id, meta.name)
    return DocMeta.from_domain(meta)


@router.post("/import")
async def import_document(
    file: UploadFile = File(...),
    service: DocumentService = Depends(get_service),
    audit=Depends(get_audit),
) -> DocMeta:
    """Import a foreign diagram file as a NEW editable board.

    Supported today: draw.io / diagrams.net (``.drawio`` / ``.xml`` — plain or
    deflate-compressed, multi-page → noddle pages). Mermaid ``.mmd`` files are
    handled client-side through the existing text→diagram AI path; ``.vsdx``
    is a spike (docs/spikes). A preview SVG is baked so exports aren't blank
    before the first open+save."""
    raw = await _read_capped(file)
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
        meta = service.create(svg, name, diagram=diagram)
    except InvalidDiagram as e:
        raise HTTPException(status_code=400, detail=str(e))
    except InvalidSvg:
        meta = service.create(BLANK_BOARD_SVG, name, diagram=diagram)
    audit.log("doc.import", GUEST, meta.id, file.filename or name)
    return DocMeta.from_domain(meta)


@router.get("/{doc_id}")
def get_document(
    doc_id: str,
    service: DocumentService = Depends(get_service),
) -> DocumentOut:
    try:
        # Live view: includes peers' unsaved edits while the board is open.
        doc = service.get_live(doc_id)
    except DocumentNotFound:
        raise HTTPException(status_code=404, detail=_NOT_FOUND)
    _guard("view", doc.meta)
    out = DocumentOut.from_domain(doc)
    out.my_role = _role_of(doc.meta)
    return out


def _role_of(meta: DocumentMeta) -> str:
    """The caller's effective role — the frontend uses it to lock the UI."""
    return "editor" if can("edit", meta) else "viewer"


@router.put("/{doc_id}")
def save_document(
    doc_id: str,
    body: SaveBody,
    service: DocumentService = Depends(get_service),
) -> DocMeta:
    try:
        existing = service.get_live(doc_id)
    except DocumentNotFound:
        raise HTTPException(status_code=404, detail=_NOT_FOUND)
    _guard("edit", existing.meta)
    # Version-history attribution: the client sends its localStorage identity.
    author = (body.author_name or "").strip()[:40]
    kwargs: dict = {"author_name": author, "expected_updated_at": body.expected_updated_at}
    if "base_diagram" in body.model_fields_set:
        kwargs["base_diagram"] = body.base_diagram
    if "diagram" in body.model_fields_set:
        kwargs["diagram"] = body.diagram
    # else: legacy clients that send svg only → keep the stored diagram
    try:
        meta = service.save(doc_id, body.svg, **kwargs)
    except DocumentConflict as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    except InvalidSvg as e:
        raise HTTPException(status_code=400, detail=str(e))
    except InvalidDiagram as e:
        raise HTTPException(status_code=400, detail=str(e))
    # Sync HTTP/MCP writes to live viewers, including removals and other pages.
    from app.api.collab import publish_document_save

    try:
        anyio.from_thread.run(
            publish_document_save, doc_id, existing.diagram,
            service.get_live(doc_id).diagram, author, body.agent,
        )
    except RuntimeError:
        pass  # direct synchronous service/API use outside an ASGI worker
    return DocMeta.from_domain(meta)


@router.patch("/{doc_id}")
def patch_document(
    doc_id: str,
    body: PatchDocBody,
    service: DocumentService = Depends(get_service),
) -> DocMeta:
    """Rename — needs "edit" (the only remaining meta knob)."""
    try:
        existing = service.get(doc_id)
    except DocumentNotFound:
        raise HTTPException(status_code=404, detail=_NOT_FOUND)
    if "name" not in body.model_fields_set or body.name is None:
        return DocMeta.from_domain(existing.meta)
    _guard("edit", existing.meta)
    meta = service.update_meta(doc_id, name=body.name)
    return DocMeta.from_domain(meta)


@router.get("/{doc_id}/export.svg")
def export_svg(
    doc_id: str,
    service: DocumentService = Depends(get_service),
):
    try:
        doc = service.get(doc_id)
    except DocumentNotFound:
        raise HTTPException(status_code=404, detail=_NOT_FOUND)
    _guard("view", doc.meta)
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
) -> list[dict]:
    """Snapshot metadata, newest first. Needs "view" (like reading the board)."""
    try:
        doc = service.get(doc_id)
    except DocumentNotFound:
        raise HTTPException(status_code=404, detail=_NOT_FOUND)
    _guard("view", doc.meta)
    return [
        {"id": v.id, "created_at": v.created_at, "author_name": v.author_name}
        for v in service.list_versions(doc_id)
    ]


@router.get("/{doc_id}/versions/{version_id}")
def get_version(
    doc_id: str,
    version_id: str,
    service: DocumentService = Depends(get_service),
) -> dict:
    """One full snapshot (svg + diagram) for preview/restore. Restore itself is
    client-driven: the frontend PUTs this payload back as a normal save."""
    try:
        doc = service.get(doc_id)
    except DocumentNotFound:
        raise HTTPException(status_code=404, detail=_NOT_FOUND)
    _guard("view", doc.meta)
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


# ---- agents: live presence + PNG capture ---------------------------------------


@router.post("/{doc_id}/presence")
def join_document(
    doc_id: str,
    body: PresenceBody,
    service: DocumentService = Depends(get_service),
) -> dict:
    """MCP ``join_board``: an agent announces itself to open editors (shown in
    presence under its own name — and the Claude mark when it is Claude)
    without writing anything. People join over the WebSocket instead."""
    try:
        doc = service.get(doc_id)
    except DocumentNotFound:
        raise HTTPException(status_code=404, detail=_NOT_FOUND) from None
    _guard("view", doc.meta)
    name = " ".join(body.name.split())[:40]
    if not name:
        raise HTTPException(status_code=422, detail="Give the agent a display name.")
    client_id = (body.client_id or "").strip() or None
    from app.api.collab import AGENT_JOIN_TTL, agent_presence, announce_agent

    try:
        live = anyio.from_thread.run(announce_agent, doc_id, name, client_id)
    except RuntimeError:
        live = False  # direct synchronous service/API use outside an ASGI worker
    return {"id": doc_id, "joined_as": agent_presence(name), "live_viewers": live,
            "visible_for_seconds": AGENT_JOIN_TTL if live else 0}


_MAX_CAPTURE_OBJECTS = 1500


@router.post("/{doc_id}/capture")
def capture_document(
    doc_id: str,
    body: CaptureBody,
    service: DocumentService = Depends(get_service),
) -> dict:
    """Render one SAVED page through the editor's own React renderer (headless
    Chromium, offline, CSP-locked) and return a PNG — visual evidence for
    agents. 503 when the renderer isn't installed on this instance."""
    from app.services import diagram_capture

    try:
        doc = service.get(doc_id)
    except DocumentNotFound:
        raise HTTPException(status_code=404, detail=_NOT_FOUND) from None
    _guard("view", doc.meta)
    if body.expected_updated_at is not None and abs(doc.meta.updated_at - body.expected_updated_at) > 1e-6:
        raise HTTPException(status_code=409, detail="The board changed. Read it again before capture.")
    if not doc.diagram:
        raise HTTPException(status_code=422, detail="This board has no editable diagram to capture.")
    pages = doc.diagram.get("pages") or [doc.diagram]
    if body.page_id is None and len(pages) != 1:
        raise HTTPException(status_code=422, detail="Choose page_id for a multi-page board.")
    page = (
        next((p for p in pages if p.get("id", "p1") == body.page_id), None)
        if body.page_id else pages[0]
    )
    if page is None:
        raise HTTPException(status_code=404, detail="Page not found.")
    if len(page.get("nodes", [])) + len(page.get("edges", [])) > _MAX_CAPTURE_OBJECTS:
        raise HTTPException(
            status_code=422, detail="This page is too large to capture. Split it into smaller pages."
        )
    capture_payload = {**page, "node_ids": body.node_ids} if body.node_ids else page
    try:
        image = diagram_capture.capture_diagram(capture_payload)
    except diagram_capture.CaptureUnavailable as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    try:
        current = service.get(doc_id)
    except DocumentNotFound:
        raise HTTPException(status_code=409, detail="The board was removed during capture.") from None
    if current.meta.updated_at != doc.meta.updated_at:
        raise HTTPException(
            status_code=409, detail="The board changed during capture. Capture the new revision."
        )
    return {**image, "id": doc_id, "page_id": page.get("id", "p1"),
            "updated_at": doc.meta.updated_at, "scope": "diagram_page"}
