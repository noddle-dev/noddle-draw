"""HTTP router for /api/auth, /api/me, /api/tokens, /api/teams.

Session cookie: ``noddle_session`` — HttpOnly, SameSite=Lax, 30d (the raw value
never touches storage; only its sha256 does). Agent tokens authenticate via
``Authorization: Bearer noddle_…`` and resolve to their OWN agent principal.
"""
from __future__ import annotations

import secrets

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import RedirectResponse
from pydantic import BaseModel

from app.services import oidc
from app.services.ai import AIBadOutput, AIUnavailable, ProviderSettings
from app.services.auth import (
    SESSION_TTL,
    AuthError,
    AuthService,
    Forbidden,
    KNOWN_SCOPES,
    Principal,
)

router = APIRouter(prefix="/api", tags=["auth"])

SESSION_COOKIE = "noddle_session"


def get_auth(request: Request) -> AuthService:
    return request.app.state.auth_service


def get_principal(request: Request) -> Principal:
    """Resolve the acting identity: session cookie → user; bearer → agent;
    otherwise guest. Never raises — endpoints decide what guests may do."""
    auth: AuthService = request.app.state.auth_service
    bearer = request.headers.get("authorization", "")
    if bearer.lower().startswith("bearer "):
        p = auth.principal_from_bearer(bearer[7:].strip())
        if p.is_authenticated:
            return p
    return auth.principal_from_session(request.cookies.get(SESSION_COOKIE))


def require_user(
    principal: Principal = Depends(get_principal),
) -> Principal:
    """For account-management endpoints — humans only (agents can't mint
    tokens or reshape teams; that stays under their owner's control)."""
    if principal.kind != "user":
        raise HTTPException(status_code=401, detail="You must be signed in.")
    return principal


def _set_session(resp: Response, token: str, request: Request | None = None) -> None:
    # `secure` rides the real scheme: behind Railway's edge uvicorn runs with
    # --proxy-headers so request.url.scheme is "https" in prod, while local
    # http dev keeps working. Never hardcode either way.
    resp.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=SESSION_TTL,
        httponly=True,
        samesite="lax",
        secure=bool(request and request.url.scheme == "https"),
        path="/",
    )


# ---- accounts ---------------------------------------------------------------


class RegisterBody(BaseModel):
    email: str
    name: str = ""
    password: str


class LoginBody(BaseModel):
    email: str
    password: str


class ProfileBody(BaseModel):
    """PATCH /api/me. ``avatar`` is tri-state: omitted → keep, ``null`` →
    remove, string → data:image/(png|jpeg|webp);base64 URL (validated in the
    service). ``title`` is the user-card job title (≤ 80 chars)."""

    name: str | None = None
    color: str | None = None
    title: str | None = None
    avatar: str | None = None


class ChangePasswordBody(BaseModel):
    current_password: str
    new_password: str


def _user_payload(user) -> dict:
    return {
        "kind": "user",
        "id": user.id,
        "name": user.name,
        "email": user.email,
        "color": user.color,
        "avatar": user.avatar,
        "title": user.title,
    }


def _me_payload(p: Principal, auth: AuthService) -> dict:
    if p.kind == "user" and p.user_id:
        u = auth.user_public(p.user_id)
        if u:
            return {"kind": "user", **u}
    if p.kind == "agent":
        return {
            "kind": "agent",
            "id": p.agent_token_id,
            "name": p.name,
            "color": p.color,
            "scopes": p.scopes,
            "owner_id": p.user_id,
        }
    return {"kind": "guest"}


@router.post("/auth/register")
def register(
    body: RegisterBody,
    request: Request,
    response: Response,
    auth: AuthService = Depends(get_auth),
) -> dict:
    try:
        user, session = auth.register(body.email, body.name, body.password)
    except AuthError as e:
        raise HTTPException(status_code=400, detail=str(e))
    _set_session(response, session, request)
    request.app.state.audit_service.log(
        "auth.register",
        Principal(kind="user", user_id=user.id, name=user.name),
        detail=user.email,
    )
    return _user_payload(user)


@router.post("/auth/login")
def login(
    body: LoginBody,
    request: Request,
    response: Response,
    auth: AuthService = Depends(get_auth),
) -> dict:
    try:
        user, session = auth.login(body.email, body.password)
    except AuthError as e:
        raise HTTPException(status_code=401, detail=str(e))
    _set_session(response, session, request)
    request.app.state.audit_service.log(
        "auth.login",
        Principal(kind="user", user_id=user.id, name=user.name),
        detail=user.email,
    )
    return _user_payload(user)


@router.post("/auth/change-password")
def change_password(
    body: ChangePasswordBody,
    request: Request,
    principal: Principal = Depends(require_user),
    auth: AuthService = Depends(get_auth),
) -> dict:
    """Rotate the account password. Wrong current password → 401; new password
    shorter than 8 chars → 400. Every OTHER session is revoked (the caller's
    own cookie stays valid); the event is audit-logged."""
    if len(body.new_password) < 8:
        raise HTTPException(
            status_code=400, detail="Password must be at least 8 characters."
        )
    try:
        auth.change_password(
            principal.user_id or "",
            body.current_password,
            body.new_password,
            current_session_token=request.cookies.get(SESSION_COOKIE),
        )
    except AuthError as e:
        raise HTTPException(status_code=401, detail=str(e))
    request.app.state.audit_service.log("auth.change_password", principal)
    return {"ok": True}


@router.post("/auth/logout")
def logout(
    request: Request, response: Response, auth: AuthService = Depends(get_auth)
) -> dict:
    raw = request.cookies.get(SESSION_COOKIE)
    if raw:
        principal = auth.principal_from_session(raw)
        auth.logout(raw)
        if principal.is_authenticated:
            request.app.state.audit_service.log("auth.logout", principal)
    response.delete_cookie(SESSION_COOKIE, path="/")
    return {"ok": True}


# ---- OIDC SSO (ADR-0003) -------------------------------------------------------

_OIDC_STATE_COOKIE = "noddle_oidc_state"


@router.get("/auth/oidc/status")
def oidc_status() -> dict:
    """The UI shows the SSO button only when a provider is configured. The
    issuer lets the client label the button ("Continue with Google" vs a
    generic "Sign in with SSO") — it is public discovery info, not a secret."""
    import os

    return {
        "enabled": oidc.enabled(),
        "issuer": (os.environ.get("OIDC_ISSUER") or "").rstrip("/") or None,
    }


@router.get("/auth/oidc/login")
def oidc_login(request: Request) -> RedirectResponse:
    if not oidc.enabled():
        raise HTTPException(status_code=503, detail="SSO is not configured.")
    state = secrets.token_urlsafe(16)
    base = str(request.base_url).rstrip("/")
    try:
        url = oidc.auth_url(state, base)
    except oidc.OidcError as e:
        raise HTTPException(status_code=502, detail=str(e))
    resp = RedirectResponse(url, status_code=302)
    resp.set_cookie(
        _OIDC_STATE_COOKIE, state, max_age=600, httponly=True, samesite="lax", path="/"
    )
    return resp


@router.get("/auth/oidc/callback")
def oidc_callback(
    request: Request,
    code: str = "",
    state: str = "",
    auth: AuthService = Depends(get_auth),
) -> RedirectResponse:
    if not oidc.enabled():
        raise HTTPException(status_code=503, detail="SSO is not configured.")
    expected = request.cookies.get(_OIDC_STATE_COOKIE)
    if not code or not state or not expected or not secrets.compare_digest(state, expected):
        raise HTTPException(status_code=400, detail="Invalid state (CSRF?).")
    base = str(request.base_url).rstrip("/")
    try:
        tokens = oidc.exchange_code(code, base)
        claims = oidc.fetch_userinfo(str(tokens.get("access_token") or ""))
    except oidc.OidcError as e:
        raise HTTPException(status_code=502, detail=str(e))
    email = str(claims.get("email") or "")
    name = str(claims.get("name") or claims.get("preferred_username") or "")
    try:
        user, session = auth.login_oidc(email, name)
    except AuthError as e:
        raise HTTPException(status_code=400, detail=str(e))
    resp = RedirectResponse("/", status_code=302)
    _set_session(resp, session, request)
    resp.delete_cookie(_OIDC_STATE_COOKIE, path="/")
    request.app.state.audit_service.log(
        "auth.sso", Principal(kind="user", user_id=user.id, name=user.name), detail=email
    )
    return resp


@router.get("/me")
def me(
    principal: Principal = Depends(get_principal),
    auth: AuthService = Depends(get_auth),
) -> dict:
    return _me_payload(principal, auth)


_STORAGE_QUOTA = 200 * 1024 * 1024  # 200 MB mock quota per account


@router.get("/me/storage")
def my_storage(
    request: Request,
    principal: Principal = Depends(get_principal),
) -> dict:
    """REAL per-user byte accounting (#23): bytes at rest across boards this
    account owns (svg + diagram/comments sidecars + version snapshots)."""
    if not principal.user_id:
        return {"used": 0, "quota": _STORAGE_QUOTA}
    used = request.app.state.document_service.storage_used(principal.user_id)
    return {"used": used, "quota": _STORAGE_QUOTA}


@router.patch("/me")
def patch_me(
    body: ProfileBody,
    principal: Principal = Depends(require_user),
    auth: AuthService = Depends(get_auth),
) -> dict:
    from app.services.auth import _UNSET  # sentinel: omitted ≠ null for avatar

    try:
        user = auth.update_profile(
            principal.user_id or "",
            body.name,
            body.color,
            title=body.title,
            avatar=body.avatar if "avatar" in body.model_fields_set else _UNSET,
        )
    except AuthError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return _user_payload(user)


# ---- per-user AI provider settings -------------------------------------------


class AISettingsBody(BaseModel):
    """PUT /api/ai-settings. Omitted fields are left unchanged; a non-empty
    ``api_key`` sets the BYOK key (stored obfuscated), empty/None keeps it.
    ``model`` is the BYOK model override: ``""`` clears back to the provider
    default, ``None`` keeps the current value."""

    mode: str | None = None       # subscription | byok
    provider: str | None = None   # claude | openai | gemini | custom
    api_key: str | None = None
    model: str | None = None
    api_base: str | None = None   # custom provider's OpenAI-compatible base URL


def _ai_settings_view(request: Request, principal: Principal, auth: AuthService) -> dict:
    """Public settings enriched with billing context (tier allowance, per-action
    costs, provider default models), the token↔credit conversion table derived
    from the materialized pricing catalog, and this month's usage summary from
    the ledger. Runs the lazy monthly rollover first so the balance/meter the
    UI shows is always current-month."""
    from app.services.ai import AI_CREDIT_COSTS, PROVIDER_DEFAULT_MODELS

    user_id = principal.user_id or ""
    tier = request.app.state.billing_service.effective_tier(principal)
    allowance = tier["features"]["ai_credits_month"]
    auth.ensure_month_allowance(user_id, allowance)
    return {
        **auth.ai_settings_public(user_id),
        "monthly_allowance": allowance,
        "costs": AI_CREDIT_COSTS,
        "default_models": PROVIDER_DEFAULT_MODELS,
        # tokens one ✦ buys, per model & token type — derived from the catalog
        "token_rates": request.app.state.pricing.credits_per_token_table(),
        # model catalog with human labels + descriptions (pricing_seed.json)
        "model_catalog": request.app.state.pricing.catalog(),
        "usage": request.app.state.ai_usage.month_summary(user_id),
    }


@router.get("/ai-settings")
def get_ai_settings(
    request: Request,
    principal: Principal = Depends(require_user),
    auth: AuthService = Depends(get_auth),
) -> dict:
    return _ai_settings_view(request, principal, auth)


@router.get("/me/usage")
def my_usage(
    request: Request,
    days: int = 30,
    principal: Principal = Depends(require_user),
) -> dict:
    """Provider-dashboard-style AI usage: per-day series + per-action/model
    breakdowns + window totals + recent calls (from the append-only ledger)."""
    days = max(1, min(int(days), 90))
    return request.app.state.ai_usage.usage_report(principal.user_id or "", days=days)


@router.put("/ai-settings")
def put_ai_settings(
    body: AISettingsBody,
    request: Request,
    principal: Principal = Depends(require_user),
    auth: AuthService = Depends(get_auth),
) -> dict:
    auth.set_ai_settings(
        principal.user_id or "",
        mode=body.mode,
        provider=body.provider,
        api_key=body.api_key,
        model=body.model,
        api_base=body.api_base,
    )
    # Never echo the raw key back — the public view masks it.
    return _ai_settings_view(request, principal, auth)


# ---- named BYOK profiles (several saved key configs, pick one per chat) -------


class ByokProfileBody(BaseModel):
    """POST /api/ai-settings/byok. ``name`` ≤ 40 chars, ``provider`` ∈
    claude|openai|gemini|openrouter|custom. The raw ``api_key`` is stored
    obfuscated and only ever echoed back masked."""

    name: str = ""
    provider: str = "claude"
    api_key: str = ""
    model: str = ""
    api_base: str = ""


class ByokProfilePatch(BaseModel):
    """PATCH /api/ai-settings/byok/{id}. Omitted fields keep their value; a
    non-empty ``api_key`` replaces the stored key. ``model``/``api_base`` clear
    on ``""`` and keep on ``None``."""

    name: str | None = None
    provider: str | None = None
    api_key: str | None = None
    model: str | None = None
    api_base: str | None = None


@router.post("/ai-settings/byok")
def add_byok_profile(
    body: ByokProfileBody,
    request: Request,
    principal: Principal = Depends(require_user),
    auth: AuthService = Depends(get_auth),
) -> dict:
    try:
        auth.add_byok_profile(
            principal.user_id or "",
            body.name,
            body.provider,
            api_key=body.api_key,
            model=body.model,
            api_base=body.api_base,
        )
    except AuthError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return _ai_settings_view(request, principal, auth)


@router.patch("/ai-settings/byok/{pid}")
def update_byok_profile(
    pid: str,
    body: ByokProfilePatch,
    request: Request,
    principal: Principal = Depends(require_user),
    auth: AuthService = Depends(get_auth),
) -> dict:
    try:
        auth.update_byok_profile(
            principal.user_id or "",
            pid,
            name=body.name,
            provider=body.provider,
            api_key=body.api_key,
            model=body.model,
            api_base=body.api_base,
        )
    except AuthError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return _ai_settings_view(request, principal, auth)


@router.delete("/ai-settings/byok/{pid}")
def delete_byok_profile(
    pid: str,
    request: Request,
    principal: Principal = Depends(require_user),
    auth: AuthService = Depends(get_auth),
) -> dict:
    try:
        auth.delete_byok_profile(principal.user_id or "", pid)
    except AuthError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return _ai_settings_view(request, principal, auth)


@router.post("/ai-settings/byok/{pid}/activate")
def activate_byok_profile(
    pid: str,
    request: Request,
    principal: Principal = Depends(require_user),
    auth: AuthService = Depends(get_auth),
) -> dict:
    """Make this profile the one byok-mode calls resolve against AND flip the
    account into byok mode (so "Use this one" is a single action)."""
    try:
        auth.set_active_byok(principal.user_id or "", pid)
    except AuthError as e:
        raise HTTPException(status_code=400, detail=str(e))
    auth.set_ai_settings(principal.user_id or "", mode="byok")
    return _ai_settings_view(request, principal, auth)


@router.post("/ai-settings/byok/{pid}/test")
def test_byok_profile(
    pid: str,
    request: Request,
    principal: Principal = Depends(require_user),
    auth: AuthService = Depends(get_auth),
) -> dict:
    """Fire a minimal chat at the profile's provider to prove the key works.

    ALWAYS answers 200 with ``{ok, message}`` — a failing key is a normal
    outcome the UI renders inline, not an HTTP error (only an unknown profile
    is a 404). No credits are involved (BYOK bills the user's own account).
    """
    prof = auth.byok_by_id(principal.user_id or "", pid)
    if prof is None:
        # distinguish "no such profile" (404) from "profile has no key" (ok:false)
        public = auth.ai_settings_public(principal.user_id or "")
        if not any(p["id"] == pid for p in public["byok_profiles"]):
            raise HTTPException(status_code=404, detail="BYOK profile not found.")
        return {"ok": False, "message": "No API key saved on this profile yet."}
    try:
        model = request.app.state.ai_service.test_key(
            ProviderSettings(
                provider=prof["provider"],
                api_key=prof["api_key"],
                model=prof["model"],
                api_base=prof["api_base"],
            )
        )
    except (AIUnavailable, AIBadOutput) as e:
        return {"ok": False, "message": str(e)}
    return {"ok": True, "message": f"Key is valid — {model} replied."}


# ---- agent tokens -------------------------------------------------------------


class TokenBody(BaseModel):
    name: str
    scopes: list[str] = ["boards:read", "boards:write"]


@router.get("/tokens")
def list_tokens(
    principal: Principal = Depends(require_user),
    auth: AuthService = Depends(get_auth),
) -> list[dict]:
    return [
        {
            "id": t.id,
            "name": t.name,
            "scopes": t.scopes,
            "created_at": t.created_at,
            "last_used_at": t.last_used_at,
        }
        for t in auth.list_tokens(principal.user_id or "")
    ]


@router.post("/tokens")
def create_token(
    body: TokenBody,
    principal: Principal = Depends(require_user),
    auth: AuthService = Depends(get_auth),
) -> dict:
    token, raw = auth.create_token(principal.user_id or "", body.name, body.scopes)
    # `token` (the secret) is returned exactly ONCE — it is not retrievable.
    return {
        "id": token.id,
        "name": token.name,
        "scopes": token.scopes,
        "token": raw,
        "known_scopes": sorted(KNOWN_SCOPES),
    }


@router.delete("/tokens/{token_id}")
def delete_token(
    token_id: str,
    principal: Principal = Depends(require_user),
    auth: AuthService = Depends(get_auth),
):
    try:
        auth.delete_token(principal.user_id or "", token_id)
    except Forbidden as e:
        raise HTTPException(status_code=403, detail=str(e))
    return {"ok": True}


# ---- teams ---------------------------------------------------------------------


class TeamBody(BaseModel):
    name: str


class MemberBody(BaseModel):
    email: str
    role: str = "member"


def _team_payload(team, auth: AuthService) -> dict:
    members = []
    for uid, role in team.members.items():
        u = auth.user_public(uid)
        if u:
            members.append({**u, "role": role})
    return {"id": team.id, "name": team.name, "created_at": team.created_at, "members": members}


@router.get("/teams")
def my_teams(
    principal: Principal = Depends(require_user),
    auth: AuthService = Depends(get_auth),
) -> list[dict]:
    return [_team_payload(t, auth) for t in auth.my_teams(principal.user_id or "")]


@router.post("/teams")
def create_team(
    body: TeamBody,
    principal: Principal = Depends(require_user),
    auth: AuthService = Depends(get_auth),
) -> dict:
    return _team_payload(auth.create_team(principal.user_id or "", body.name), auth)


@router.post("/teams/{team_id}/members")
def add_member(
    team_id: str,
    body: MemberBody,
    principal: Principal = Depends(require_user),
    auth: AuthService = Depends(get_auth),
) -> dict:
    try:
        team = auth.add_member(principal.user_id or "", team_id, body.email, body.role)
    except AuthError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Forbidden as e:
        raise HTTPException(status_code=403, detail=str(e))
    return _team_payload(team, auth)
