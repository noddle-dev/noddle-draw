"""Unit tests for the ADR-0002 authorization lattice (services/auth.py) after
the 2026-07-05 "private by default" amendment.

Pure in-memory tests: ``can()``/``is_listed()`` only reach the repository via
``AuthService.team_role`` → ``repo.team_by_id``, so a minimal fake repo is
enough — no filesystem, no network.
"""
from __future__ import annotations

import time

import pytest

from app.domain.models import DocumentMeta, Team
from app.services.auth import GUEST, AuthService, Principal, can, is_listed

OWNER_ID = "aaaaaaaaaaaa"
EDITOR_ID = "bbbbbbbbbbbb"
VIEWER_ID = "cccccccccccc"
STRANGER_ID = "dddddddddddd"
ADMIN_ID = "eeeeeeeeeeee"
MEMBER_ID = "ffffffffffff"
TEAM_ID = "111111111111"

ACTIONS = ("view", "edit", "manage")


class FakeAuthRepo:
    """Only what can()/is_listed() touch: team lookup."""

    def __init__(self, teams: dict[str, Team] | None = None) -> None:
        self._teams = teams or {}

    def team_by_id(self, team_id: str) -> Team | None:
        return self._teams.get(team_id)


@pytest.fixture
def auth() -> AuthService:
    team = Team(
        id=TEAM_ID,
        name="t",
        created_at=time.time(),
        members={ADMIN_ID: "admin", MEMBER_ID: "member"},
    )
    return AuthService(FakeAuthRepo({TEAM_ID: team}))  # type: ignore[arg-type]


def meta(**overrides) -> DocumentMeta:
    base = dict(
        id="222222222222",
        name="board",
        created_at=0.0,
        updated_at=0.0,
        owner_id=OWNER_ID,
        shares={EDITOR_ID: "editor", VIEWER_ID: "viewer"},
        team_id=TEAM_ID,
    )
    base.update(overrides)
    return DocumentMeta(**base)


def user(uid: str) -> Principal:
    return Principal(kind="user", user_id=uid, name=uid)


def perms(p: Principal, m: DocumentMeta, auth: AuthService) -> tuple[bool, bool, bool]:
    return tuple(can(p, a, m, auth) for a in ACTIONS)  # type: ignore[return-value]


# ---- default -------------------------------------------------------------


def test_new_meta_defaults_private():
    m = DocumentMeta(id="333333333333", name="x", created_at=0, updated_at=0)
    assert m.link_policy == "private"


# ---- owner ----------------------------------------------------------------


def test_owner_can_everything_even_private(auth):
    m = meta(link_policy="private")
    assert perms(user(OWNER_ID), m, auth) == (True, True, True)
    assert is_listed(user(OWNER_ID), m, auth)


# ---- per-user shares --------------------------------------------------------


def test_share_editor_view_edit_not_manage(auth):
    m = meta(link_policy="private", team_id=None)
    assert perms(user(EDITOR_ID), m, auth) == (True, True, False)
    assert is_listed(user(EDITOR_ID), m, auth)


def test_share_viewer_view_only(auth):
    m = meta(link_policy="private", team_id=None)
    assert perms(user(VIEWER_ID), m, auth) == (True, False, False)
    assert is_listed(user(VIEWER_ID), m, auth)


# ---- team roles ------------------------------------------------------------


def test_team_admin_can_everything(auth):
    m = meta(link_policy="private", shares={})
    assert perms(user(ADMIN_ID), m, auth) == (True, True, True)
    assert is_listed(user(ADMIN_ID), m, auth)


def test_team_member_view_edit_not_manage(auth):
    m = meta(link_policy="private", shares={})
    assert perms(user(MEMBER_ID), m, auth) == (True, True, False)
    assert is_listed(user(MEMBER_ID), m, auth)


# ---- link_policy fall-through (owned boards) ---------------------------------


@pytest.mark.parametrize("who", [user(STRANGER_ID), GUEST], ids=["stranger", "guest"])
def test_link_private_denies_outsiders(auth, who):
    m = meta(link_policy="private", shares={}, team_id=None)
    assert perms(who, m, auth) == (False, False, False)
    assert not is_listed(who, m, auth)


@pytest.mark.parametrize("who", [user(STRANGER_ID), GUEST], ids=["stranger", "guest"])
def test_link_view_grants_view_only(auth, who):
    m = meta(link_policy="view", shares={}, team_id=None)
    assert perms(who, m, auth) == (True, False, False)
    assert not is_listed(who, m, auth)  # link ≠ discovery


@pytest.mark.parametrize("who", [user(STRANGER_ID), GUEST], ids=["stranger", "guest"])
def test_link_edit_grants_view_edit_never_manage(auth, who):
    m = meta(link_policy="edit", shares={}, team_id=None)
    assert perms(who, m, auth) == (True, True, False)
    assert not is_listed(who, m, auth)


# ---- ownerless (legacy) boards — amendment #2 2026-07-05: DENY EVERYTHING ----
# The stored link_policy of an ownerless board was never an owner's decision
# (it is the old open default), so it grants nothing. Rescue path:
# scripts/lockdown_link_policy.py --assign-orphans-to.


@pytest.mark.parametrize("who", [user(STRANGER_ID), GUEST], ids=["stranger", "guest"])
@pytest.mark.parametrize("policy", ["edit", "view", "private"])
def test_ownerless_denies_all_actions(auth, who, policy):
    m = meta(owner_id=None, link_policy=policy, shares={}, team_id=None)
    assert perms(who, m, auth) == (False, False, False)


@pytest.mark.parametrize("who", [user(STRANGER_ID), GUEST], ids=["stranger", "guest"])
@pytest.mark.parametrize("policy", ["edit", "view", "private"])
def test_ownerless_listed_to_nobody(auth, who, policy):
    m = meta(owner_id=None, link_policy=policy, shares={}, team_id=None)
    assert not is_listed(who, m, auth)


# ---- agent scope gating -------------------------------------------------------


def agent(uid: str, scopes: list[str]) -> Principal:
    return Principal(kind="agent", user_id=uid, agent_token_id="t", scopes=scopes)


def test_agent_of_owner_with_full_scopes(auth):
    m = meta(link_policy="private")
    a = agent(OWNER_ID, ["boards:read", "boards:write"])
    assert perms(a, m, auth) == (True, True, True)


def test_agent_read_scope_cannot_edit_even_as_owner(auth):
    m = meta(link_policy="private")
    a = agent(OWNER_ID, ["boards:read"])
    assert perms(a, m, auth) == (True, False, False)


def test_agent_without_read_scope_cannot_view(auth):
    m = meta(link_policy="edit")
    a = agent(OWNER_ID, ["boards:write"])
    assert not can(a, "view", m, auth)


def test_agent_scopes_do_not_escalate_beyond_owner_rights(auth):
    # An agent of a stranger gets only what the stranger would (link policy).
    m = meta(link_policy="view", shares={}, team_id=None)
    a = agent(STRANGER_ID, ["boards:read", "boards:write"])
    assert perms(a, m, auth) == (True, False, False)
