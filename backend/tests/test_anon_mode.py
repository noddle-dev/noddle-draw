"""Anonymous mode (NODDLE_ANON): guests create link-shared boards."""
from __future__ import annotations

import pytest

from app.domain.models import DocumentMeta
from app.infrastructure.auth_repository import FileAuthRepository
from app.services.auth import (
    AuthService,
    Principal,
    anon_mode_enabled,
    can,
    set_anon_mode,
)


@pytest.fixture(autouse=True)
def _reset_anon():
    yield
    set_anon_mode(False)


@pytest.fixture
def auth(tmp_path) -> AuthService:
    return AuthService(FileAuthRepository(tmp_path))


def _meta(link_policy: str) -> DocumentMeta:
    return DocumentMeta(
        id="a" * 12, name="anon board", created_at=0.0, updated_at=0.0,
        owner_id=None, link_policy=link_policy,
    )


def test_flag_roundtrip():
    assert anon_mode_enabled() is False
    set_anon_mode(True)
    assert anon_mode_enabled() is True


def test_ownerless_edit_board_is_editable_in_anon_mode(auth):
    set_anon_mode(True)
    guest = Principal(kind="guest")
    assert can(guest, "view", _meta("edit"), auth) is True
    assert can(guest, "edit", _meta("edit"), auth) is True
    assert can(guest, "manage", _meta("edit"), auth) is False
    # private anonymous boards stay private
    assert can(guest, "view", _meta("private"), auth) is False


def test_ownerless_still_denied_without_anon_mode(auth):
    guest = Principal(kind="guest")
    assert can(guest, "view", _meta("edit"), auth) is False
