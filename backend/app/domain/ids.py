"""Document id minting + validation.

Ids are minted as ``uuid4().hex[:12]`` and every id-bearing route validates the
shape ``^[0-9a-f]{12}$`` before it ever touches the filesystem, so a caller can
never smuggle path separators / traversal (or an IDOR-shaped id) into storage.
"""
from __future__ import annotations

import re
import uuid

ID_RE = re.compile(r"^[0-9a-f]{12}$")


def new_id() -> str:
    """Mint a fresh document id."""
    return uuid.uuid4().hex[:12]


def is_valid_id(doc_id: str) -> bool:
    """True iff ``doc_id`` matches the minted id shape exactly."""
    return ID_RE.fullmatch(doc_id) is not None
