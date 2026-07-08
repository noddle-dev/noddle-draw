"""WS3 (admin activity & user tracking) unit tests.

Same style as test_authz.py — no HTTP client (httpx/TestClient is not a
dependency, and the api/ modules can't even import under this venv's
Python 3.9), so the endpoint logic is exercised through its service-layer
parts: ``require_team_admin`` (the admin gate — api/activity.py maps
AuthError → 401 and Forbidden → 403) and ``build_team_filter`` (the
read-time team scoping), plus ``ActivityService`` throttle/persistence and
``AuditService.read_entries``.
"""
from __future__ import annotations

import json
import time

import pytest

from app.domain.models import Team
from app.services.activity import (
    ActivityService,
    build_team_filter,
    require_team_admin,
)
from app.services.audit import AuditService, _reverse_lines
from app.services.auth import GUEST, AuthError, AuthService, Forbidden, Principal

ADMIN_ID = "eeeeeeeeeeee"
MEMBER_ID = "ffffffffffff"
STRANGER_ID = "dddddddddddd"
TEAM_ID = "111111111111"
DOC_TEAM = "aaaa11112222"  # a doc belonging to the team
DOC_OTHER = "bbbb33334444"  # a doc belonging to no team


class FakeAuthRepo:
    """Only what team_role()/team_by_id() touch."""

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


def user(uid: str) -> Principal:
    return Principal(kind="user", user_id=uid, name=uid)


# ---- ActivityService: throttle + persistence ---------------------------------


def test_touch_writes_then_throttles(tmp_path):
    svc = ActivityService(tmp_path, throttle=300)
    assert svc.touch("u1", now=1000.0) is True
    assert svc.touch("u1", now=1100.0) is False  # < 300s → throttled
    assert svc.last_active_at("u1") == 1000.0  # throttled touch changed nothing
    assert svc.touch("u1", now=1301.0) is True  # past the window → writes
    assert svc.last_active_at("u1") == 1301.0


def test_touch_throttle_is_per_user(tmp_path):
    svc = ActivityService(tmp_path, throttle=300)
    assert svc.touch("u1", now=1000.0) is True
    assert svc.touch("u2", now=1001.0) is True  # other users are independent
    assert svc.touch("u2", now=1002.0) is False


def test_touch_persists_atomically_and_reloads(tmp_path):
    svc = ActivityService(tmp_path, throttle=300)
    svc.touch("u1", now=1000.0)
    on_disk = json.loads((tmp_path / "activity.json").read_text())
    assert on_disk["u1"]["last_active_at"] == 1000.0
    # A fresh instance (new process) seeds its cache from disk.
    svc2 = ActivityService(tmp_path, throttle=300)
    assert svc2.last_active_at("u1") == 1000.0
    assert svc2.touch("u1", now=1100.0) is False  # throttle survives restarts


def test_throttled_touch_never_reads_disk(tmp_path):
    svc = ActivityService(tmp_path, throttle=300)
    svc.touch("u1", now=1000.0)
    (tmp_path / "activity.json").unlink()  # if the hot path read disk, it'd differ
    assert svc.touch("u1", now=1100.0) is False
    assert svc.last_active_at("u1") == 1000.0


def test_touch_ignores_empty_user_and_corrupt_file(tmp_path):
    (tmp_path / "activity.json").write_text("{not json")
    svc = ActivityService(tmp_path, throttle=300)
    assert svc.touch("", now=1000.0) is False
    assert svc.touch("u1", now=1000.0) is True  # corrupt store → start fresh


# ---- AuditService: team_id kwarg + read_entries ------------------------------


def _seed_audit(tmp_path) -> AuditService:
    audit = AuditService(tmp_path)
    audit.log("auth.login", user(ADMIN_ID), detail="admin@x.com")
    audit.log("doc.create", user(ADMIN_ID), DOC_TEAM, "Team board")
    audit.log("share.add", user(ADMIN_ID), DOC_TEAM, "bob", team_id=TEAM_ID)
    audit.log("doc.create", user(STRANGER_ID), DOC_OTHER, "Private board")
    audit.log("doc.delete", user(MEMBER_ID), DOC_OTHER, "Private board")
    audit.log("auth.login", user(ADMIN_ID), detail="admin@x.com (again)")
    return audit


def test_log_team_id_written_and_legacy_lines_unchanged(tmp_path):
    audit = _seed_audit(tmp_path)
    lines = [json.loads(l) for l in (tmp_path / "audit.log").read_text().splitlines()]
    assert lines[2]["team_id"] == TEAM_ID
    assert all("team_id" not in ev for i, ev in enumerate(lines) if i != 2)


def test_read_entries_newest_first_with_limit(tmp_path):
    audit = _seed_audit(tmp_path)
    entries = audit.read_entries(3)
    assert [e["action"] for e in entries] == ["auth.login", "doc.delete", "doc.create"]
    assert entries[0]["ts"] >= entries[1]["ts"] >= entries[2]["ts"]


def test_read_entries_filter_and_missing_file(tmp_path):
    audit = _seed_audit(tmp_path)
    mine = audit.read_entries(50, lambda ev: ev.get("actor_id") == ADMIN_ID)
    assert [e["action"] for e in mine] == ["auth.login", "share.add", "doc.create", "auth.login"]
    assert audit.read_entries(0) == []
    assert AuditService(tmp_path / "empty").read_entries(10) == []


def test_read_entries_stops_at_limit_matches(tmp_path):
    audit = _seed_audit(tmp_path)
    logins = audit.read_entries(
        1, lambda ev: ev.get("action") == "auth.login" and ev.get("actor_id") == ADMIN_ID
    )
    assert len(logins) == 1
    assert logins[0]["detail"] == "admin@x.com (again)"  # the NEWEST login


def test_reverse_lines_handles_block_boundaries(tmp_path):
    p = tmp_path / "big.log"
    rows = [f'{{"n": {i}}}' for i in range(200)]
    p.write_text("\n".join(rows) + "\n")
    got = list(_reverse_lines(p, block_size=17))  # tiny blocks → many partials
    assert got == rows[::-1]


def test_read_entries_skips_corrupt_lines(tmp_path):
    audit = AuditService(tmp_path)
    audit.log("doc.create", user(ADMIN_ID), DOC_TEAM, "ok")
    with (tmp_path / "audit.log").open("a") as f:
        f.write("NOT JSON\n[1,2]\n")
    entries = audit.read_entries(10)
    assert [e["action"] for e in entries] == ["doc.create"]


# ---- endpoint guard: team-admin only ------------------------------------------


def test_team_audit_gate_admin_passes(auth):
    require_team_admin(user(ADMIN_ID), TEAM_ID, auth)  # no raise


@pytest.mark.parametrize(
    ("who", "exc_type"),
    [
        (GUEST, AuthError),  # → 401 at the endpoint
        (Principal(kind="agent", user_id=ADMIN_ID, agent_token_id="t"), AuthError),
        (user(MEMBER_ID), Forbidden),  # → 403
        (user(STRANGER_ID), Forbidden),
    ],
    ids=["guest", "agent-of-admin", "member", "stranger"],
)
def test_team_audit_gate_denies(auth, who, exc_type):
    with pytest.raises(exc_type):
        require_team_admin(who, TEAM_ID, auth)


def test_team_audit_gate_unknown_team_is_forbidden_not_leak(auth):
    with pytest.raises(Forbidden):
        require_team_admin(user(ADMIN_ID), "000000000000", auth)


# ---- read-time team scoping ------------------------------------------------------


def _matcher():
    doc_team = {DOC_TEAM: TEAM_ID, DOC_OTHER: None}.get
    return build_team_filter(TEAM_ID, frozenset({ADMIN_ID, MEMBER_ID}), doc_team)


def test_team_filter_matches_stamped_doc_and_member_events():
    match = _matcher()
    assert match({"action": "share.add", "team_id": TEAM_ID})  # stamped
    assert match({"action": "doc.create", "actor_id": STRANGER_ID, "doc_id": DOC_TEAM})
    assert match({"action": "doc.delete", "actor_id": MEMBER_ID, "doc_id": DOC_OTHER})


def test_team_filter_excludes_auth_and_outside_events():
    match = _matcher()
    # auth.* is never part of the team trail, even for members / stamped lines
    assert not match({"action": "auth.login", "actor_id": ADMIN_ID})
    assert not match({"action": "auth.login", "team_id": TEAM_ID})
    # a stranger acting on a non-team board is invisible to this team
    assert not match({"action": "doc.create", "actor_id": STRANGER_ID, "doc_id": DOC_OTHER})
    assert not match({"action": "doc.create", "actor_id": STRANGER_ID, "doc_id": None})


def test_end_to_end_team_trail_from_seeded_log(tmp_path):
    """read_entries + build_team_filter together = the endpoint's core."""
    audit = _seed_audit(tmp_path)
    entries = audit.read_entries(50, _matcher())
    # newest first: member's delete, the stamped share, the team-board create.
    # The stranger's create on a non-team board and both logins are filtered.
    assert [e["action"] for e in entries] == ["doc.delete", "share.add", "doc.create"]
    assert all(not e["action"].startswith("auth.") for e in entries)
