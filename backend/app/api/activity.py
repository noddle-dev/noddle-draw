"""HTTP router for admin activity & user tracking (WS3).

Two read-only views over the append-only audit log + the activity map:

    GET /api/teams/{team_id}/audit?limit=50   — TEAM-ADMIN-ONLY team trail
    GET /api/me/activity?limit=30             — my own events + last-login/active

Team scoping is resolved at READ time (``services.activity.build_team_filter``):
an entry belongs to a team when it carries ``team_id`` (new writes may stamp
it), when its ``doc_id`` resolves to a board whose meta.team_id matches, or
when its actor is a current team member. ``auth.*`` lifecycle events are
excluded from the team view.

Limitation: reads cover only the LIVE ``audit.log`` — events already rotated
into segments (and shipped to R2) are not merged in (same trade-off as the
per-board trail in ``AuditService.for_doc``).
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from app.api.auth import get_auth, get_principal
from app.services.activity import build_team_filter, require_team_admin
from app.services.auth import AuthError, AuthService, Forbidden, Principal

router = APIRouter(prefix="/api", tags=["activity"])

_LOGIN_ACTIONS = ("auth.login", "auth.register", "auth.sso")
_MAX_LIMIT = 200


def _entry_view(ev: dict) -> dict:
    """API-safe projection of one JSONL line (never echoes unknown fields)."""
    return {
        "ts": ev.get("ts"),
        "action": ev.get("action"),
        "actor_kind": ev.get("actor_kind"),
        "actor_id": ev.get("actor_id"),
        "actor_name": ev.get("actor_name"),
        "doc_id": ev.get("doc_id"),
        "detail": ev.get("detail"),
        "team_id": ev.get("team_id"),
    }


@router.get("/teams/{team_id}/audit")
def team_audit(
    team_id: str,
    request: Request,
    limit: int = Query(default=50, ge=1, le=_MAX_LIMIT),
    principal: Principal = Depends(get_principal),
    auth: AuthService = Depends(get_auth),
) -> dict:
    try:
        require_team_admin(principal, team_id, auth)
    except AuthError as e:
        raise HTTPException(status_code=401, detail=str(e))
    except Forbidden as e:
        raise HTTPException(status_code=403, detail=str(e))
    team = auth.team_by_id(team_id)
    member_ids = frozenset(team.members) if team else frozenset()
    # One metadata pass builds the doc→team map (metas are cheap; payloads
    # are never loaded). Deleted boards simply resolve to None.
    doc_team_by_id = {
        m.id: m.team_id for m in request.app.state.document_service.list()
    }
    matcher = build_team_filter(team_id, member_ids, doc_team_by_id.get)
    entries = request.app.state.audit_service.read_entries(limit, matcher)
    return {"team_id": team_id, "entries": [_entry_view(e) for e in entries]}


@router.get("/me/activity")
def my_activity(
    request: Request,
    limit: int = Query(default=30, ge=1, le=_MAX_LIMIT),
    principal: Principal = Depends(get_principal),
) -> dict:
    """My own recent audit trail + activity signals (Profile tab)."""
    if principal.kind != "user" or not principal.user_id:
        raise HTTPException(status_code=401, detail="You must be signed in.")
    uid = principal.user_id
    audit = request.app.state.audit_service
    entries = audit.read_entries(limit, lambda ev: ev.get("actor_id") == uid)
    # last_login_at is derived lazily from the newest auth.* login event —
    # no login-path code writes it (WS3 scope decision).
    logins = audit.read_entries(
        1,
        lambda ev: ev.get("actor_id") == uid
        and ev.get("action") in _LOGIN_ACTIONS,
    )
    return {
        "entries": [_entry_view(e) for e in entries],
        "last_login_at": logins[0].get("ts") if logins else None,
        "last_active_at": request.app.state.activity_service.last_active_at(uid),
    }
