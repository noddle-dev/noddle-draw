"""Anonymous-only access control.

noddle is account-less (Excalidraw-style): there are no users, sessions or
teams. Every caller is the shared :data:`GUEST` principal, and a board's URL
is its sharing capability — authorization reduces to the document's
``link_policy``:

- ``"edit"``  → anyone with the link may view and edit (the default for every
  board created through the API).
- ``"view"``  → anyone with the link may view.
- anything else (legacy ``"private"`` rows) → denied.

``can()`` is the single authorization function; the api layer calls it on
every document route and the collab WebSocket calls it on join/state.
"""
from __future__ import annotations

from dataclasses import dataclass

from app.domain.models import DocumentMeta


@dataclass(frozen=True)
class Principal:
    """Who is acting. Anonymous-only: always a link guest.

    Kept as a (tiny) type so call sites that thread an actor through —
    audit logging, collab presence — stay explicit about "who".
    """

    kind: str = "guest"
    name: str = "Guest"
    color: str = "#9aa1ad"


GUEST = Principal()


def can(action: str, meta: DocumentMeta) -> bool:
    """May anyone holding this board's link perform ``action``?

    ``action`` is ``"view"`` or ``"edit"``. The URL is the capability
    (Excalidraw semantics): policy ``"edit"`` grants both, ``"view"`` grants
    read-only, and legacy ``"private"`` rows stay dark.
    """
    if meta.link_policy == "edit":
        return action in ("view", "edit")
    if meta.link_policy == "view":
        return action == "view"
    return False
