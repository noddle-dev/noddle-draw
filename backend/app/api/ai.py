"""HTTP router for /api/ai — AI-backed generation endpoints.

Handlers are thin: validate/parse input, call the injected ``AIService``, and
translate domain errors to HTTP:
  * AIUnavailable -> 503 (no backend / provider unreachable — graceful)
  * AIBadOutput   -> 422 (model produced no usable result; body carries the raw
                          model text for debugging)

BYOK is CLIENT-SIDE (anonymous product, Excalidraw-style): the browser keeps
the user's provider/key/model in localStorage and sends them per-request as
headers — the server proxies the call and never stores or logs the key:

    X-AI-Provider: claude | openai | gemini | openrouter | custom
    X-AI-Key:      the raw API key
    X-AI-Model:    optional model override
    X-AI-Base:     OpenAI-compatible base URL (required for "custom")

No key ⇒ the shared Databricks pool (DATABRICKS_* env), when configured.
Neither ⇒ 503. Background jobs are bucketed by ``X-Client-Id`` — an opaque
UUID the frontend mints once into localStorage (job history, not a secret).

⚠️ Privacy note: these endpoints send user-supplied images/text to the
configured AI provider — don't submit confidential data you wouldn't share
with that provider.
"""
from __future__ import annotations

import time

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool

from app.api.ai_schemas import (
    ChatImageError,
    DiagramBody,
    EditDiagramBody,
    SvgOut,
    validate_chat_image,
)
from app.services.ai import (
    AI_PROVIDERS,
    AIBadOutput,
    AIService,
    AIUnavailable,
    ProviderSettings,
)

router = APIRouter(prefix="/api/ai", tags=["ai"])

# Image content types Claude vision accepts.
_ALLOWED_MEDIA = {"image/png", "image/jpeg", "image/webp", "image/gif"}
_MAX_IMAGE_BYTES = 8 * 1024 * 1024  # 8 MB guard
_MAX_CLIENT_ID = 64

_NO_BACKEND = (
    "No AI backend available — add your API key in AI settings, "
    "or configure the server pool."
)


def get_service(request: Request) -> AIService:
    """DI hook: the concrete service is stashed on app state in create_app()."""
    return request.app.state.ai_service


def _settings_from_headers(request: Request) -> ProviderSettings | None:
    """Parse the X-AI-* headers into ProviderSettings (None when no key)."""
    key = (request.headers.get("X-AI-Key") or "").strip()
    if not key:
        return None
    provider = (request.headers.get("X-AI-Provider") or "").strip().lower()
    if provider not in AI_PROVIDERS:
        raise HTTPException(
            status_code=400,
            detail="Unknown AI provider — expected one of: "
            + ", ".join(sorted(AI_PROVIDERS)) + ".",
        )
    base = (request.headers.get("X-AI-Base") or "").strip()
    if provider == "custom" and not base:
        raise HTTPException(
            status_code=400,
            detail="Provider 'custom' needs X-AI-Base (an OpenAI-compatible base URL).",
        )
    return ProviderSettings(
        provider=provider,
        api_key=key,
        model=(request.headers.get("X-AI-Model") or "").strip(),
        api_base=base,
    )


def _resolve_backend(request: Request) -> ProviderSettings | None:
    """Pick the AI backend for this request.

    1. ``X-AI-Key`` present → the caller's own provider (validated), key never
       stored server-side.
    2. No key → the shared Databricks pool when configured (``None`` selects
       it downstream).
    3. Neither → 503 with an actionable message.
    """
    settings = _settings_from_headers(request)
    if settings is not None:
        return settings
    service: AIService = request.app.state.ai_service
    if service.pool_available():
        return None  # None ⇒ shared Databricks pool
    raise HTTPException(status_code=503, detail=_NO_BACKEND)


def _client_id(request: Request) -> str | None:
    """The anonymous job-history bucket (localStorage UUID), or None."""
    cid = (request.headers.get("X-Client-Id") or "").strip()[:_MAX_CLIENT_ID]
    return cid or None


@router.post("/test-key")
async def test_ai_key(
    request: Request,
    service: AIService = Depends(get_service),
) -> dict:
    """Fire the smallest possible chat at the caller's provider to prove the
    key/model/base combination works. Always resolves ``{ok, message}`` — a
    bad key is ``ok: false``, never a throw (only malformed headers are 400).
    The key rides the X-AI-* headers like every other AI call; it is neither
    stored nor logged.
    """
    settings = _settings_from_headers(request)  # may 400 (bad provider/base)
    if settings is None:
        raise HTTPException(status_code=400, detail="Missing X-AI-Key header.")
    try:
        model = await run_in_threadpool(service.test_key, settings)
        return {"ok": True, "message": f"Key works — model: {model}."}
    except (AIUnavailable, AIBadOutput) as e:
        return {"ok": False, "message": str(e)}


@router.post("/image-to-svg", response_model=SvgOut)
async def image_to_svg(
    request: Request,
    file: UploadFile = File(...),
    prompt: str = Form(""),  # optional user enrichment (style/palette/labels…)
    service: AIService = Depends(get_service),
) -> SvgOut:
    media_type = (file.content_type or "").split(";", 1)[0].strip().lower()
    if media_type not in _ALLOWED_MEDIA:
        raise HTTPException(
            status_code=415,
            detail="Only png/jpeg/webp/gif images are supported.",
        )
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Image file is empty.")
    if len(raw) > _MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="Image is too large (max 8MB).")

    backend = _resolve_backend(request)  # may 503 (no backend) / 400 (bad headers)

    def _convert() -> str:
        return service.image_to_svg(
            raw, media_type, prompt.strip()[:2000], settings=backend
        )

    try:
        # threadpool, NEVER inline: this is a minutes-long blocking urllib
        # call — running it on the event loop froze the whole app (health
        # checks, websockets, every other request) for the duration.
        svg = await run_in_threadpool(_convert)
    except AIUnavailable as e:
        raise HTTPException(status_code=503, detail=str(e))
    except AIBadOutput as e:
        raise HTTPException(status_code=422, detail={"message": str(e), "raw": e.raw})
    return SvgOut(svg=svg)


# ---- background jobs: image→board conversions that survive reloads ----------
# The sync endpoint above stays for compatibility, but the product flow is the
# job queue: submit returns immediately, a server worker pool converts several
# clients' uploads in PARALLEL, and history (with the created board's id) is
# persistent per anonymous client id — a page reload no longer loses a running
# conversion.


@router.post("/jobs/image-to-svg", status_code=202)
async def submit_image_job(
    request: Request,
    file: UploadFile = File(...),
    prompt: str = Form(""),
) -> dict:
    cid = _client_id(request)
    if not cid:
        raise HTTPException(
            status_code=400, detail="Missing X-Client-Id header for job tracking."
        )
    media_type = (file.content_type or "").split(";", 1)[0].strip().lower()
    if media_type not in _ALLOWED_MEDIA:
        raise HTTPException(
            status_code=415, detail="Only png/jpeg/webp/gif images are supported."
        )
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Image file is empty.")
    if len(raw) > _MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="Image is too large (max 8MB).")
    backend = _resolve_backend(request)  # may 503 / 400
    job = request.app.state.ai_jobs.submit(
        user_id=cid,
        name=file.filename or "sketch",
        prompt=prompt.strip()[:2000],
        raw=raw,
        media_type=media_type,
        backend=backend,
        now=time.time(),
    )
    return job


@router.get("/jobs")
def list_image_jobs(request: Request) -> list[dict]:
    cid = _client_id(request)
    if not cid:
        return []
    return request.app.state.ai_jobs.list_for_user(cid)


@router.get("/jobs/{job_id}")
def get_image_job(job_id: str, request: Request) -> dict:
    cid = _client_id(request)
    job = request.app.state.ai_jobs.get(cid, job_id) if cid else None
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found.")
    return job


@router.delete("/jobs/{job_id}")
def delete_image_job(job_id: str, request: Request) -> dict:
    cid = _client_id(request)
    ok = request.app.state.ai_jobs.delete(cid, job_id) if cid else False
    if not ok:
        raise HTTPException(status_code=404, detail="Job not found (or still running).")
    return {"ok": True}


@router.post("/text-to-diagram")
def text_to_diagram(
    body: DiagramBody,
    request: Request,
    service: AIService = Depends(get_service),
) -> dict:
    if not body.text.strip():
        raise HTTPException(status_code=400, detail="Missing 'text' content.")
    backend = _resolve_backend(request)
    try:
        return service.text_to_diagram(body.text, body.format, settings=backend)
    except AIUnavailable as e:
        raise HTTPException(status_code=503, detail=str(e))
    except AIBadOutput as e:
        raise HTTPException(status_code=422, detail={"message": str(e), "raw": e.raw})


@router.post("/edit-diagram")
async def edit_diagram(
    body: EditDiagramBody,
    request: Request,
    service: AIService = Depends(get_service),
) -> dict:
    """Live co-editing: apply a chat instruction to the current board.

    An optional ``model`` in the body selects the Databricks serving-endpoint
    for this chat session (pool mode only); the service whitelists it (must
    start with ``databricks-``) and otherwise falls back to the default
    endpoint.
    """
    if not body.instruction.strip():
        raise HTTPException(status_code=400, detail="Missing 'instruction'.")
    # Optional reference image — validate + size-cap before it hits the model.
    try:
        image = validate_chat_image(body.image)
    except ChatImageError as e:
        raise HTTPException(status_code=413 if e.oversize else 400, detail=str(e))
    # `model` isn't part of EditDiagramBody — read it from the raw (cached) body.
    try:
        payload = await request.json()
        model = payload.get("model") if isinstance(payload, dict) else None
    except Exception:
        model = None
    if not isinstance(model, str):
        model = None
    backend = _resolve_backend(request)
    try:
        return await run_in_threadpool(
            service.edit_diagram,
            body.diagram,
            body.instruction,
            body.history,
            settings=backend,
            model=model,
            image=image,
        )
    except AIUnavailable as e:
        raise HTTPException(status_code=503, detail=str(e))
    except AIBadOutput as e:
        raise HTTPException(status_code=422, detail={"message": str(e), "raw": e.raw})
