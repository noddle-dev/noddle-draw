"""Pydantic DTOs for the /api/ai endpoints (HTTP wire shapes)."""
from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel

# --- chat-attachment image validation (edit-diagram) -------------------------
# The co-editor chat may carry ONE reference image (e.g. "recreate this
# screenshot", "match these colors"). It rides on the wire as a base64 data URL,
# validated + size-capped like avatars but with a larger cap (~1.5MB binary,
# which base64 inflates to ~2M chars). The frontend downscales to ≤1400px so a
# normal screenshot lands well under this.
CHAT_IMAGE_MAX_LEN = 2_100_000  # data-URL character cap (~1.5MB of image bytes)
_CHAT_IMAGE_RE = re.compile(r"^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$")


class ChatImageError(ValueError):
    """A chat attachment failed validation.

    ``oversize`` distinguishes "too big" (mapped to HTTP 413) from a malformed /
    unsupported value (mapped to 400) by the router.
    """

    def __init__(self, message: str, *, oversize: bool = False) -> None:
        super().__init__(message)
        self.oversize = oversize


def validate_chat_image(image: object) -> str | None:
    """Validate the optional co-editor chat image and return it (or None).

    Accepts only ``data:image/(png|jpeg|webp);base64,…`` under the size cap —
    the same whitelist ethos as avatars (no SVG: it is scriptable; no remote
    URLs: SSRF). ``None``/``""`` mean "no attachment". Raises ``ChatImageError``
    otherwise so the router can map it to 400/413.
    """
    if image is None or image == "":
        return None
    if not isinstance(image, str):
        raise ChatImageError("Image must be a data-URL string.")
    if len(image) > CHAT_IMAGE_MAX_LEN:
        raise ChatImageError("Attached image is too large (max ~1.5MB).", oversize=True)
    if not _CHAT_IMAGE_RE.match(image):
        raise ChatImageError("Image must be a data:image/(png|jpeg|webp);base64 URL.")
    return image


class SvgOut(BaseModel):
    """Response for POST /api/ai/image-to-svg."""

    svg: str


class DiagramBody(BaseModel):
    """Request body for POST /api/ai/text-to-diagram."""

    text: str
    format: Literal["text", "mermaid"] = "text"


class EditDiagramBody(BaseModel):
    """Request body for POST /api/ai/edit-diagram (live co-editing).

    ``history`` is the recent conversation (role user|assistant, text only —
    the CURRENT diagram is always sent fresh, never stale snapshots), so
    follow-ups like "change it to blue" resolve their referents.
    """

    instruction: str
    diagram: dict
    history: list[dict] = []
    # Optional reference image (data:image/(png|jpeg|webp);base64,… — validated
    # + size-capped by validate_chat_image in the router). Sent to the vision
    # model alongside the instruction so users can say "recreate this screenshot"
    # or "match these colors". Absent ⇒ text-only, behavior unchanged.
    image: str | None = None


# The text-to-diagram response is the frontend diagram JSON (nodes/edges). Its
# shape is produced by AIService and returned as a plain dict, so no strict
# response model is enforced here.
