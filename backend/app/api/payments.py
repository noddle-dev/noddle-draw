"""HTTP router for /api/payments + /api/me/subscription (Lemon Squeezy billing).

Handlers are thin: validate → call the injected ``BillingService`` → map domain
errors to HTTP:
  * BillingUnavailable → 503 (billing not configured / LS unreachable — graceful)
  * BillingError       → 400 (unknown variant, bad input)

The webhook endpoint reads the RAW request body (the HMAC is computed over the
exact bytes Lemon Squeezy sent — re-serialized JSON would not verify) and
answers 401 on a bad/missing ``X-Signature`` BEFORE any processing.
"""
from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from app.api.auth import get_principal, require_user
from app.services.auth import Principal
from app.services.billing import BillingError, BillingService, BillingUnavailable

router = APIRouter(prefix="/api", tags=["payments"])


def get_billing(request: Request) -> BillingService:
    """DI hook: the concrete service is stashed on app state in create_app()."""
    return request.app.state.billing_service


def get_audit(request: Request):
    return request.app.state.audit_service


class CheckoutBody(BaseModel):
    variant: str  # pro_monthly | pro_yearly | team_yearly
    seats: int | None = None  # team_yearly only (min 3, enforced server-side)


@router.post("/payments/checkout")
def create_checkout(
    body: CheckoutBody,
    request: Request,
    principal: Principal = Depends(require_user),
    billing: BillingService = Depends(get_billing),
    audit=Depends(get_audit),
) -> dict:
    """Create a hosted Lemon Squeezy checkout for the signed-in user."""
    base = str(request.base_url).rstrip("/")
    try:
        url = billing.create_checkout(
            principal, body.variant, seats=body.seats, base_url=base
        )
    except BillingError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except BillingUnavailable as e:
        raise HTTPException(status_code=503, detail=str(e))
    audit.log("billing.checkout", principal, detail=body.variant)
    return {"url": url}


_WEBHOOK_MAX_BYTES = 1024 * 1024  # 1 MB — real LS events are a few KB


@router.post("/payments/lemonsqueezy/webhook")
async def lemonsqueezy_webhook(
    request: Request,
    billing: BillingService = Depends(get_billing),
    audit=Depends(get_audit),
) -> dict:
    """Lemon Squeezy event sink. Signature-verified, idempotent by event id."""
    # Cap the body BEFORE buffering it: this endpoint is unauthenticated
    # (signature-gated only) — real LS events are a few KB.
    length = request.headers.get("content-length")
    if length and length.isdigit() and int(length) > _WEBHOOK_MAX_BYTES:
        raise HTTPException(status_code=413, detail="Webhook body too large.")
    raw = await request.body()
    if len(raw) > _WEBHOOK_MAX_BYTES:
        raise HTTPException(status_code=413, detail="Webhook body too large.")
    signature = request.headers.get("x-signature", "")
    if not billing.verify_webhook(raw, signature):
        raise HTTPException(status_code=401, detail="Invalid webhook signature.")
    try:
        payload = json.loads(raw)
    except ValueError:
        raise HTTPException(status_code=400, detail="Webhook body is not valid JSON.")
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Webhook body must be a JSON object.")
    status = billing.handle_webhook(payload)
    event_name = str((payload.get("meta") or {}).get("event_name") or "")
    audit.log(
        "billing.webhook",
        Principal(kind="guest", name="Lemon Squeezy"),
        detail=f"{event_name} → {status}",
    )
    return {"status": status}


@router.get("/me/subscription")
def my_subscription(
    principal: Principal = Depends(get_principal),
    billing: BillingService = Depends(get_billing),
) -> dict:
    """The caller's effective plan (guests see the free tier) — powers the
    plan badge + upgrade buttons in the Account modal."""
    return billing.effective_tier(principal)


@router.get("/me/billing-events")
def my_billing_events(
    principal: Principal = Depends(require_user),
    billing: BillingService = Depends(get_billing),
) -> list[dict]:
    """The caller's OWN billing history, newest first (webhook-recorded:
    payments with amount + ✦ granted, subscription lifecycle changes).
    Empty list when billing was never configured — never an error."""
    return billing.list_events(principal)
