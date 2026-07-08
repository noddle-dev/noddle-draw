"""HTTP router for the per-user 🔔 notification feed.

    GET /api/me/notifications  → the signed-in user's newest notifications.

Like the mention feed (api/comments.py::my_mentions) this is a PURE READ —
"seen" state is client-side (localStorage in MentionsBell). Guests get an
empty list; the service already degrades to empty on any error, so a feed
hiccup never surfaces as a 500.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from app.api.auth import get_principal
from app.services.auth import Principal
from app.services.notifications import NotificationService

router = APIRouter(prefix="/api/me", tags=["notifications"])


def get_notifications(request: Request) -> NotificationService:
    return request.app.state.notification_service


@router.get("/notifications")
def my_notifications(
    principal: Principal = Depends(get_principal),
    notifications: NotificationService = Depends(get_notifications),
) -> list[dict]:
    if not principal.user_id:
        return []
    return notifications.for_user(principal.user_id, limit=50)
