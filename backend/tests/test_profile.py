"""Unit tests for Workstream 1 — profile completeness (avatar, title,
change-password) in services/auth.py.

Service-level tests over the REAL ``FileAuthRepository`` on a tmp dir (the
same adapter the app uses without ``DATABASE_URL``), so persistence and
serialization are exercised end-to-end. FastAPI's ``TestClient`` needs the
``httpx`` package, which this venv does not carry — the HTTP layer is a thin
mapping (AuthError → 400/401) tested here at the service boundary.
"""
from __future__ import annotations

import base64

import pytest

from app.infrastructure.auth_repository import FileAuthRepository
from app.services.auth import (
    AVATAR_MAX_LEN,
    AuthError,
    AuthService,
    _UNSET,
)

PASSWORD = "correct-horse-9"


def png_data_url(payload: bytes = b"fake-png-bytes") -> str:
    return "data:image/png;base64," + base64.b64encode(payload).decode()


@pytest.fixture
def auth(tmp_path) -> AuthService:
    return AuthService(FileAuthRepository(tmp_path))


@pytest.fixture
def user_session(auth):
    """A registered user + their raw session token."""
    return auth.register("ada@example.com", "Ada", PASSWORD)


# ---- avatar ------------------------------------------------------------------


def test_avatar_defaults_none_and_absent_from_old_records(user_session, auth):
    user, _ = user_session
    assert user.avatar is None
    assert user.title == ""


@pytest.mark.parametrize("mime", ["png", "jpeg", "webp"])
def test_avatar_accepts_allowed_image_data_urls(auth, user_session, mime):
    user, _ = user_session
    url = f"data:image/{mime};base64," + base64.b64encode(b"img").decode()
    updated = auth.update_profile(user.id, None, None, avatar=url)
    assert updated.avatar == url
    # persists through the repository (fresh read from auth.json)
    assert auth.user_public(user.id)["avatar"] == url


@pytest.mark.parametrize(
    "bad",
    [
        "data:image/svg+xml;base64,PHN2Zz4=",  # scriptable format
        "data:image/gif;base64,R0lGOD==",  # not in the whitelist
        "data:text/html;base64,PGI+",  # not an image at all
        "javascript:alert(1)",  # not a data URL
        "https://example.com/a.png",  # remote URL — rejected by design
        "data:image/png;base64,not base64!!",  # junk payload chars
        "data:image/png,rawnotbase64",  # missing ;base64
    ],
)
def test_avatar_rejects_bad_schemes(auth, user_session, bad):
    user, _ = user_session
    with pytest.raises(AuthError):
        auth.update_profile(user.id, None, None, avatar=bad)
    assert auth.user_public(user.id)["avatar"] is None  # nothing stored


def test_avatar_rejects_oversize(auth, user_session):
    user, _ = user_session
    huge = "data:image/png;base64," + "A" * AVATAR_MAX_LEN  # > cap incl. prefix
    assert len(huge) > AVATAR_MAX_LEN
    with pytest.raises(AuthError):
        auth.update_profile(user.id, None, None, avatar=huge)


def test_avatar_at_exact_cap_is_accepted(auth, user_session):
    user, _ = user_session
    prefix = "data:image/png;base64,"
    url = prefix + "A" * (AVATAR_MAX_LEN - len(prefix))
    assert len(url) == AVATAR_MAX_LEN
    assert auth.update_profile(user.id, None, None, avatar=url).avatar == url


def test_avatar_null_removes_and_unset_keeps(auth, user_session):
    user, _ = user_session
    url = png_data_url()
    auth.update_profile(user.id, None, None, avatar=url)
    # omitted (sentinel) → unchanged
    kept = auth.update_profile(user.id, "New Name", None, avatar=_UNSET)
    assert kept.avatar == url
    # explicit None → removed
    removed = auth.update_profile(user.id, None, None, avatar=None)
    assert removed.avatar is None
    assert auth.user_public(user.id)["avatar"] is None


# ---- title ---------------------------------------------------------------------


def test_title_saved_and_in_public_view(auth, user_session):
    user, _ = user_session
    updated = auth.update_profile(user.id, None, None, title="Staff Engineer")
    assert updated.title == "Staff Engineer"
    assert auth.user_public(user.id)["title"] == "Staff Engineer"


def test_title_truncated_to_80_chars(auth, user_session):
    user, _ = user_session
    updated = auth.update_profile(user.id, None, None, title="x" * 200)
    assert len(updated.title) == 80


def test_title_none_keeps_and_empty_clears(auth, user_session):
    user, _ = user_session
    auth.update_profile(user.id, None, None, title="PM")
    assert auth.update_profile(user.id, None, None, title=None).title == "PM"
    assert auth.update_profile(user.id, None, None, title="").title == ""


# ---- change-password -------------------------------------------------------------


def test_change_password_wrong_current_rejected(auth, user_session):
    user, _ = user_session
    with pytest.raises(AuthError, match="Current password"):
        auth.change_password(user.id, "not-the-password", "another-long-pw")
    # old password still works
    auth.login("ada@example.com", PASSWORD)


def test_change_password_short_new_rejected(auth, user_session):
    user, _ = user_session
    with pytest.raises(AuthError, match="at least 8"):
        auth.change_password(user.id, PASSWORD, "short")
    auth.login("ada@example.com", PASSWORD)  # unchanged


def test_change_password_success_rehashes(auth, user_session):
    user, _ = user_session
    old_hash = user.password_hash
    auth.change_password(user.id, PASSWORD, "brand-new-secret")
    stored = auth._repo.user_by_id(user.id)
    assert stored.password_hash != old_hash  # rehashed (fresh salt)
    assert stored.password_hash.startswith("pbkdf2$")
    # old credential dead, new one live
    with pytest.raises(AuthError):
        auth.login("ada@example.com", PASSWORD)
    auth.login("ada@example.com", "brand-new-secret")


def test_change_password_revokes_other_sessions_keeps_current(auth, user_session):
    user, current = user_session
    _, other = auth.login("ada@example.com", PASSWORD)  # a second device
    assert auth.principal_from_session(other).is_authenticated
    auth.change_password(
        user.id, PASSWORD, "brand-new-secret", current_session_token=current
    )
    assert not auth.principal_from_session(other).is_authenticated  # revoked
    assert auth.principal_from_session(current).is_authenticated  # survives
