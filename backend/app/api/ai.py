"""HTTP router for /api/ai — AI-backed generation endpoints.

Handlers are thin: validate/parse input, call the injected ``AIService``, and
translate domain errors to HTTP:
  * AIUnavailable -> 503 (no Databricks config / provider unreachable — graceful)
  * AIBadOutput   -> 422 (model produced no usable result; body carries the raw
                          model text for debugging)

⚠️ Privacy note: these endpoints send user-supplied images/text to the
configured AI provider — don't submit confidential data you wouldn't share
with that provider.
"""
from __future__ import annotations

import time
from typing import Callable, NamedTuple

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool

from app.api.ai_schemas import (
    ChatImageError,
    DiagramBody,
    EditDiagramBody,
    SvgOut,
    validate_chat_image,
)
from app.api.auth import get_principal
from app.services.ai import (
    AI_CREDIT_COSTS,
    AIBadOutput,
    AIService,
    AIUnavailable,
    ProviderSettings,
)
from app.services.billing import QuotaExceeded

router = APIRouter(prefix="/api/ai", tags=["ai"])

# Image content types Claude vision accepts.
_ALLOWED_MEDIA = {"image/png", "image/jpeg", "image/webp", "image/gif"}
_MAX_IMAGE_BYTES = 8 * 1024 * 1024  # 8 MB guard


def get_service(request: Request) -> AIService:
    """DI hook: the concrete service is stashed on app state in create_app()."""
    return request.app.state.ai_service


def _noop() -> None:
    return None


class ResolvedBackend(NamedTuple):
    """Outcome of backend resolution + charging for one AI call."""

    backend: ProviderSettings | None  # None ⇒ shared Databricks pool
    refund: Callable[[], None]  # gives the up-front charge back on failure
    mode: str  # subscription | byok | pool (guests/agents)
    charged: int  # flat ✦ actually debited (0 for byok/pool)
    user_id: str  # "" for guests/agents


def _record_usage(request: Request, resolved: ResolvedBackend, action: str, usage: dict) -> None:
    """Append the call to the usage ledger (never raises — accounting only)."""
    request.app.state.ai_usage.record(
        user_id=resolved.user_id,
        action=action,
        mode=resolved.mode,
        usage=usage,
        credits_charged=resolved.charged,
    )


def _resolve_backend(
    request: Request, action: str, override: str | None = None
) -> ResolvedBackend:
    """Pick the AI backend for the caller and charge them per their settings.

    ``override`` is the optional PER-CALL selector some endpoints accept
    (e.g. the image-upload flow's backend picker): ``"subscription"`` forces
    the credit wallet, ``"byok"`` the active profile, ``"byok:{pid}"`` a
    specific named profile. Empty/None ⇒ the account-level mode as before.
    Guests/agents ignore it (they ride the shared pool).

    Returns a ``ResolvedBackend``:
    * Guests / agents → ``(None, noop)`` — the shared Databricks pool, unmetered.
    * Signed-in user, BYOK mode → their provider + key + model override; never
      touches credits (their own bill), so ``refund`` is a noop.
    * Signed-in user, subscription mode → lazy monthly rollover (refill the
      wallet up to the effective tier's allowance), then charge the action's
      cost (``AI_CREDIT_COSTS``) UP-FRONT — the pre-call debit is what stops
      concurrent requests racing past zero. The returned ``refund`` gives the
      charge back; callers invoke it when the provider call fails (the user got
      nothing usable). Raises 402 with a machine-readable detail when short.
    """
    principal = get_principal(request)
    if principal.kind != "user" or not principal.user_id:
        # guests + agents keep using the default Databricks pool, unmetered
        return ResolvedBackend(None, _noop, "pool", 0, "")
    auth = request.app.state.auth_service
    user_id = principal.user_id
    s = auth.get_ai_settings(user_id)
    mode, profile_id = s.mode, ""
    if override:
        if override == "subscription":
            mode = "subscription"
        elif override == "byok":
            mode = "byok"
        elif override.startswith("byok:"):
            mode, profile_id = "byok", override[len("byok:"):]
        else:
            raise HTTPException(status_code=400, detail="Unknown AI backend selector.")
    if mode == "byok":
        # A specific named profile when the call picked one, else the ACTIVE
        # profile (falls back to the legacy single config when the user has
        # no named profiles yet). No usable key ⇒ 503.
        prof = (
            auth.byok_by_id(user_id, profile_id)
            if profile_id
            else auth.active_byok(user_id)
        )
        if not prof:
            raise HTTPException(
                status_code=503,
                detail=(
                    "That BYOK profile no longer exists or has no API key — "
                    "pick another one, or add a key in Account."
                    if profile_id
                    else "No API key configured for BYOK mode. Go to Account to add one."
                ),
            )
        return ResolvedBackend(
            ProviderSettings(
                provider=prof["provider"],
                api_key=prof["api_key"],
                model=prof["model"],
                api_base=prof["api_base"],
            ),
            _noop,
            "byok",
            0,
            user_id,
        )
    # subscription mode: pay-per-action from the credit wallet
    allowance = request.app.state.billing_service.effective_tier(principal)[
        "features"
    ]["ai_credits_month"]
    s = auth.ensure_month_allowance(user_id, allowance)
    cost = AI_CREDIT_COSTS.get(action, 1)
    if not auth.spend_credits(user_id, cost):
        raise HTTPException(
            status_code=402,
            detail={
                "error": "credits_exhausted",
                "message": (
                    f"Not enough AI credits: this action costs {cost} ✦ and you "
                    f"have {s.credits}. Upgrade your plan in Account, or switch "
                    "to your own API key (BYOK)."
                ),
                "required": cost,
                "balance": s.credits,
            },
        )
    return ResolvedBackend(
        None, lambda: auth.refund_credits(user_id, cost), "subscription", cost, user_id
    )


@router.post("/image-to-svg", response_model=SvgOut)
async def image_to_svg(
    request: Request,
    file: UploadFile = File(...),
    prompt: str = Form(""),  # optional user enrichment (style/palette/labels…)
    # per-call billing pick: "" (account mode) | subscription | byok | byok:{pid}
    backend: str = Form(""),
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

    # may 402 (not enough credits) / 503 (no BYOK key) / 400 (bad selector)
    resolved = _resolve_backend(request, "image_to_svg", backend.strip() or None)

    def _convert() -> tuple[str, dict]:
        # usage is threading.local — read it on the SAME worker thread that
        # made the provider call, and ride it back on the return value.
        svg = service.image_to_svg(
            raw, media_type, prompt.strip()[:2000], settings=resolved.backend
        )
        return svg, service.last_call_usage()

    try:
        # threadpool, NEVER inline: this is a minutes-long blocking urllib
        # call — running it on the event loop froze the whole app (health
        # checks, websockets, every other request) for the duration.
        svg, usage = await run_in_threadpool(_convert)
    except AIUnavailable as e:
        resolved.refund()
        raise HTTPException(status_code=503, detail=str(e))
    except AIBadOutput as e:
        resolved.refund()
        raise HTTPException(status_code=422, detail={"message": str(e), "raw": e.raw})
    _record_usage(request, resolved, "image_to_svg", usage)
    return SvgOut(svg=svg)


# ---- background jobs: image→board conversions that survive reloads ----------
# The sync endpoint above stays for compatibility, but the product flow is the
# job queue: submit returns immediately, a server worker pool converts several
# users' uploads in PARALLEL, and history (with the created board's id) is
# per-user persistent — a page reload no longer loses a running conversion.


@router.post("/jobs/image-to-svg", status_code=202)
async def submit_image_job(
    request: Request,
    file: UploadFile = File(...),
    prompt: str = Form(""),
    backend: str = Form(""),
) -> dict:
    principal = get_principal(request)
    if principal.kind != "user" or not principal.user_id:
        # the finished job CREATES a board, and boards need an owner
        raise HTTPException(status_code=401, detail="Sign in to convert images.")
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
    # board quota gate — same rule as every other create route (402 when over)
    docs = request.app.state.document_service
    owned = sum(
        1
        for m in docs.list_for_user(principal.user_id, ())
        if m.owner_id == principal.user_id
    )
    try:
        request.app.state.billing_service.check_board_quota(principal, owned)
    except QuotaExceeded as e:
        raise HTTPException(status_code=402, detail=str(e))
    # charge up-front exactly like the sync route (worker refunds on failure)
    resolved = _resolve_backend(request, "image_to_svg", backend.strip() or None)
    usage_ledger = request.app.state.ai_usage
    job = request.app.state.ai_jobs.submit(
        user_id=principal.user_id,
        name=file.filename or "sketch",
        prompt=prompt.strip()[:2000],
        raw=raw,
        media_type=media_type,
        backend=resolved.backend,
        refund=resolved.refund,
        record_usage=lambda usage: usage_ledger.record(
            user_id=resolved.user_id,
            action="image_to_svg",
            mode=resolved.mode,
            usage=usage,
            credits_charged=resolved.charged,
        ),
        now=time.time(),
    )
    return job


@router.get("/jobs")
def list_image_jobs(request: Request) -> list[dict]:
    principal = get_principal(request)
    if principal.kind != "user" or not principal.user_id:
        return []
    return request.app.state.ai_jobs.list_for_user(principal.user_id)


@router.get("/jobs/{job_id}")
def get_image_job(job_id: str, request: Request) -> dict:
    principal = get_principal(request)
    job = (
        request.app.state.ai_jobs.get(principal.user_id, job_id)
        if principal.kind == "user" and principal.user_id
        else None
    )
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found.")
    return job


@router.delete("/jobs/{job_id}")
def delete_image_job(job_id: str, request: Request) -> dict:
    principal = get_principal(request)
    ok = (
        request.app.state.ai_jobs.delete(principal.user_id, job_id)
        if principal.kind == "user" and principal.user_id
        else False
    )
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
    resolved = _resolve_backend(request, "text_to_diagram")
    try:
        result = service.text_to_diagram(body.text, body.format, settings=resolved.backend)
    except AIUnavailable as e:
        resolved.refund()
        raise HTTPException(status_code=503, detail=str(e))
    except AIBadOutput as e:
        resolved.refund()
        raise HTTPException(status_code=422, detail={"message": str(e), "raw": e.raw})
    # sync handler ⇒ same threadpool thread as the service call
    _record_usage(request, resolved, "text_to_diagram", service.last_call_usage())
    return result


@router.post("/edit-diagram")
async def edit_diagram(
    body: EditDiagramBody,
    request: Request,
    service: AIService = Depends(get_service),
) -> dict:
    """Live co-editing: apply a chat instruction to the current board.

    An optional ``model`` in the body selects the Databricks serving-endpoint
    for this chat session; the service whitelists it (must start with
    ``databricks-``) and otherwise falls back to the default endpoint.
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
    resolved = _resolve_backend(request, "edit_diagram")
    try:
        result = await run_in_threadpool(
            service.edit_diagram,
            body.diagram,
            body.instruction,
            body.history,
            settings=resolved.backend,
            model=model,
            image=image,
        )
    except AIUnavailable as e:
        resolved.refund()
        raise HTTPException(status_code=503, detail=str(e))
    except AIBadOutput as e:
        resolved.refund()
        raise HTTPException(status_code=422, detail={"message": str(e), "raw": e.raw})
    # the service ran in a threadpool worker — its usage rides on the result
    # dict (thread-local state is NOT visible from this event-loop thread)
    _record_usage(request, resolved, "edit_diagram", result.get("usage") or {})
    return result
