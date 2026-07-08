"""Unit tests for the co-editor chat reference-image validation
(``validate_chat_image`` in app/api/ai_schemas.py).

Mirrors test_profile.py's avatar tests: a pure validator over data-URLs — good
schemes accepted, bad schemes rejected, oversize flagged distinctly (so the
router maps it to HTTP 413 vs 400). No HTTP layer needed (TestClient needs
httpx, absent from this venv); the router mapping is a thin passthrough.
"""
from __future__ import annotations

import base64

import pytest

from app.api.ai_schemas import (
    CHAT_IMAGE_MAX_LEN,
    ChatImageError,
    validate_chat_image,
)


def data_url(mime: str = "png", payload: bytes = b"fake-image-bytes") -> str:
    return f"data:image/{mime};base64," + base64.b64encode(payload).decode()


# ---- good ---------------------------------------------------------------------


@pytest.mark.parametrize("mime", ["png", "jpeg", "webp"])
def test_accepts_allowed_image_data_urls(mime):
    url = data_url(mime)
    assert validate_chat_image(url) == url


@pytest.mark.parametrize("empty", [None, ""])
def test_none_and_empty_mean_no_attachment(empty):
    assert validate_chat_image(empty) is None


def test_accepts_url_at_exact_cap():
    prefix = "data:image/png;base64,"
    url = prefix + "A" * (CHAT_IMAGE_MAX_LEN - len(prefix))
    assert len(url) == CHAT_IMAGE_MAX_LEN
    assert validate_chat_image(url) == url


# ---- bad ----------------------------------------------------------------------


@pytest.mark.parametrize(
    "bad",
    [
        "data:image/svg+xml;base64,PHN2Zz4=",  # scriptable format
        "data:image/gif;base64,R0lGOD==",  # not in the whitelist
        "data:text/html;base64,PGI+",  # not an image at all
        "javascript:alert(1)",  # not a data URL
        "https://example.com/a.png",  # remote URL — SSRF, rejected by design
        "data:image/png;base64,not base64!!",  # junk payload chars
        "data:image/png,rawnotbase64",  # missing ;base64
    ],
)
def test_rejects_bad_schemes(bad):
    with pytest.raises(ChatImageError) as ei:
        validate_chat_image(bad)
    assert not ei.value.oversize  # malformed ⇒ 400, not 413


def test_rejects_non_string():
    with pytest.raises(ChatImageError):
        validate_chat_image(b"raw-bytes")  # type: ignore[arg-type]


# ---- oversize -----------------------------------------------------------------


def test_rejects_oversize_and_flags_it():
    prefix = "data:image/png;base64,"
    huge = prefix + "A" * (CHAT_IMAGE_MAX_LEN + 1 - len(prefix))
    assert len(huge) > CHAT_IMAGE_MAX_LEN
    with pytest.raises(ChatImageError) as ei:
        validate_chat_image(huge)
    assert ei.value.oversize  # distinct from malformed ⇒ router returns 413
