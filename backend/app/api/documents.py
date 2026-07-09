"""HTTP router for /api/documents.

Handlers are thin: they validate/parse input, call the injected
``DocumentService``, translate domain errors to HTTP, and map domain models to
DTOs. noddle is anonymous-only — the board URL is the capability, enforced
through ``services.auth.can``:

    action "view" → GET one / export / versions
    action "edit" → PUT payload, rename

There is no board listing (link access ≠ discovery — the client keeps its own
recents in localStorage), no delete and no policy toggle: an anonymous board
has no owner who could be trusted with either.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from fastapi.responses import Response

from app.api.schemas import (
    BLANK_BOARD_SVG,
    CreateDocBody,
    DocMeta,
    DocumentOut,
    PatchDocBody,
    SaveBody,
)
from app.domain.models import DocumentMeta
from app.services.auth import GUEST, can
from app.services.diagram_render import diagram_to_svg
from app.services.documents import (
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
    raw = (await file.read()).decode("utf-8", errors="replace")
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
        doc = service.get(doc_id)
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
        existing = service.get(doc_id)
    except DocumentNotFound:
        raise HTTPException(status_code=404, detail=_NOT_FOUND)
    _guard("edit", existing.meta)
    # Version-history attribution: the client sends its localStorage identity.
    author = (body.author_name or "").strip()[:40]
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
