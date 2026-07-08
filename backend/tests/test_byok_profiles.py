"""Unit tests for named BYOK profiles (services/auth.py).

Service-level tests over the REAL ``FileAuthRepository`` on a tmp dir (the same
adapter the app uses without ``DATABASE_URL``), so persistence/serialization of
the new ``AISettings.byok_profiles`` list is exercised end-to-end. Mirrors
test_profile.py: the thin HTTP mapping (AuthError → 400) isn't retested here.
"""
from __future__ import annotations

import pytest

from app.infrastructure.auth_repository import FileAuthRepository
from app.services.auth import AuthError, AuthService

PASSWORD = "correct-horse-9"
KEY_A = "sk-aaaaaaaaaaaaaaaaaaaa1111"
KEY_B = "sk-bbbbbbbbbbbbbbbbbbbb2222"


@pytest.fixture
def auth(tmp_path) -> AuthService:
    return AuthService(FileAuthRepository(tmp_path))


@pytest.fixture
def uid(auth) -> str:
    user, _ = auth.register("ada@example.com", "Ada", PASSWORD)
    return user.id


# ---- add ---------------------------------------------------------------------


def test_add_profile_returns_id_and_appears_masked(auth, uid):
    pid = auth.add_byok_profile(uid, "Work OpenAI", "openai", api_key=KEY_A, model="gpt-5.4")
    assert pid
    pub = auth.ai_settings_public(uid)
    assert len(pub["byok_profiles"]) == 1
    prof = pub["byok_profiles"][0]
    assert prof["id"] == pid
    assert prof["name"] == "Work OpenAI"
    assert prof["provider"] == "openai"
    assert prof["model"] == "gpt-5.4"
    assert prof["has_key"] is True
    # masked, never raw
    assert prof["masked_key"] and prof["masked_key"] != KEY_A
    assert KEY_A not in str(pub)


def test_first_profile_becomes_active(auth, uid):
    pid = auth.add_byok_profile(uid, "One", "claude", api_key=KEY_A)
    assert auth.ai_settings_public(uid)["byok_active_id"] == pid
    # second add does NOT steal active
    auth.add_byok_profile(uid, "Two", "openai", api_key=KEY_B)
    assert auth.ai_settings_public(uid)["byok_active_id"] == pid


def test_add_rejects_unknown_provider(auth, uid):
    with pytest.raises(AuthError):
        auth.add_byok_profile(uid, "Bad", "not-a-provider", api_key=KEY_A)


def test_add_truncates_long_name(auth, uid):
    pid = auth.add_byok_profile(uid, "x" * 200, "claude", api_key=KEY_A)
    name = auth.ai_settings_public(uid)["byok_profiles"][0]["name"]
    assert pid and len(name) == 40


# ---- update ------------------------------------------------------------------


def test_update_patches_fields_and_key(auth, uid):
    pid = auth.add_byok_profile(uid, "One", "claude", api_key=KEY_A, model="a")
    before = auth.ai_settings_public(uid)["byok_profiles"][0]["masked_key"]
    auth.update_byok_profile(uid, pid, name="Renamed", provider="openai", model="", api_key=KEY_B)
    prof = auth.ai_settings_public(uid)["byok_profiles"][0]
    assert prof["name"] == "Renamed"
    assert prof["provider"] == "openai"
    assert prof["model"] == ""  # cleared with ""
    assert prof["masked_key"] != before  # key rotated


def test_update_empty_key_keeps_existing(auth, uid):
    pid = auth.add_byok_profile(uid, "One", "claude", api_key=KEY_A)
    before = auth.ai_settings_public(uid)["byok_profiles"][0]["masked_key"]
    auth.update_byok_profile(uid, pid, name="Renamed", api_key="")
    assert auth.ai_settings_public(uid)["byok_profiles"][0]["masked_key"] == before


def test_update_unknown_profile_raises(auth, uid):
    with pytest.raises(AuthError):
        auth.update_byok_profile(uid, "nope", name="x")


# ---- delete + set-active -----------------------------------------------------


def test_delete_reassigns_active(auth, uid):
    p1 = auth.add_byok_profile(uid, "One", "claude", api_key=KEY_A)
    p2 = auth.add_byok_profile(uid, "Two", "openai", api_key=KEY_B)
    assert auth.ai_settings_public(uid)["byok_active_id"] == p1
    auth.delete_byok_profile(uid, p1)  # active removed
    pub = auth.ai_settings_public(uid)
    assert [p["id"] for p in pub["byok_profiles"]] == [p2]
    assert pub["byok_active_id"] == p2


def test_delete_unknown_raises(auth, uid):
    auth.add_byok_profile(uid, "One", "claude", api_key=KEY_A)
    with pytest.raises(AuthError):
        auth.delete_byok_profile(uid, "nope")


def test_set_active_switches_and_validates(auth, uid):
    p1 = auth.add_byok_profile(uid, "One", "claude", api_key=KEY_A)
    p2 = auth.add_byok_profile(uid, "Two", "openai", api_key=KEY_B)
    auth.set_active_byok(uid, p2)
    assert auth.ai_settings_public(uid)["byok_active_id"] == p2
    with pytest.raises(AuthError):
        auth.set_active_byok(uid, "nope")
    assert p1  # still present, unaffected


# ---- resolve uses the active profile -----------------------------------------


def test_active_byok_returns_active_cleartext(auth, uid):
    auth.add_byok_profile(uid, "One", "claude", api_key=KEY_A)
    p2 = auth.add_byok_profile(uid, "Two", "openai", api_key=KEY_B, model="gpt-5.4")
    auth.set_active_byok(uid, p2)
    prof = auth.active_byok(uid)
    assert prof == {
        "provider": "openai",
        "api_key": KEY_B,  # cleartext for the transport
        "model": "gpt-5.4",
        "api_base": "",
    }
    # ai_api_key routes to the same active profile's key
    assert auth.ai_api_key(uid) == KEY_B


def test_active_byok_none_without_key(auth, uid):
    assert auth.active_byok(uid) is None
    # a profile with no key is not usable
    auth.add_byok_profile(uid, "Empty", "claude", api_key="")
    assert auth.active_byok(uid) is None


# ---- resolve a SPECIFIC profile (per-call override, e.g. upload picker) ------


def test_byok_by_id_resolves_non_active_profile(auth, uid):
    p1 = auth.add_byok_profile(uid, "One", "claude", api_key=KEY_A)
    p2 = auth.add_byok_profile(uid, "Two", "openai", api_key=KEY_B, model="gpt-5.4")
    assert auth.ai_settings_public(uid)["byok_active_id"] == p1  # p2 NOT active
    prof = auth.byok_by_id(uid, p2)
    assert prof == {
        "provider": "openai",
        "api_key": KEY_B,
        "model": "gpt-5.4",
        "api_base": "",
    }


def test_byok_by_id_unknown_or_keyless_is_none(auth, uid):
    assert auth.byok_by_id(uid, "nope") is None
    pid = auth.add_byok_profile(uid, "Empty", "claude", api_key="")
    assert auth.byok_by_id(uid, pid) is None


def test_byok_by_id_resolves_legacy_synthetic_profile(auth, uid):
    # pre-profiles account: the single config surfaces with the id "legacy"
    auth.set_ai_settings(uid, mode="byok", provider="gemini", api_key=KEY_A)
    pid = auth.ai_settings_public(uid)["byok_profiles"][0]["id"]
    prof = auth.byok_by_id(uid, pid)
    assert prof and prof["provider"] == "gemini" and prof["api_key"] == KEY_A


# ---- legacy single-config back-compat ----------------------------------------


def test_legacy_config_surfaces_as_default_profile(auth, uid):
    # simulate a pre-profiles account: single-config BYOK key
    auth.set_ai_settings(uid, mode="byok", provider="gemini", api_key=KEY_A, model="gemini-x")
    pub = auth.ai_settings_public(uid)
    assert len(pub["byok_profiles"]) == 1
    prof = pub["byok_profiles"][0]
    assert prof["name"] == "Default"
    assert prof["provider"] == "gemini"
    assert prof["model"] == "gemini-x"
    assert prof["has_key"] is True
    assert prof["masked_key"] != KEY_A
    assert pub["byok_active_id"] == prof["id"]
    # resolve uses that legacy config
    assert auth.active_byok(uid) == {
        "provider": "gemini",
        "api_key": KEY_A,
        "model": "gemini-x",
        "api_base": "",
    }


def test_adding_profile_migrates_legacy_without_loss(auth, uid):
    auth.set_ai_settings(uid, mode="byok", provider="gemini", api_key=KEY_A)
    pid = auth.add_byok_profile(uid, "New", "openai", api_key=KEY_B)
    pub = auth.ai_settings_public(uid)
    names = {p["name"] for p in pub["byok_profiles"]}
    assert names == {"Default", "New"}  # legacy folded in, not dropped
    assert len(pub["byok_profiles"]) == 2
    assert pid in {p["id"] for p in pub["byok_profiles"]}


def test_legacy_profile_writes_use_the_id_the_ui_was_shown(auth, uid):
    """Regression: the synthetic legacy profile surfaces as id "legacy", but
    the write-time fold-in used to mint a FRESH id first — so delete/edit/
    activate on the id the UI held always raised "BYOK profile not found"."""
    auth.set_ai_settings(uid, mode="byok", provider="gemini", api_key=KEY_A)
    pid = auth.ai_settings_public(uid)["byok_profiles"][0]["id"]
    # every write op must accept that same id
    auth.update_byok_profile(uid, pid, name="Renamed")
    assert auth.ai_settings_public(uid)["byok_profiles"][0]["name"] == "Renamed"
    auth.set_active_byok(uid, pid)
    auth.delete_byok_profile(uid, pid)
    pub = auth.ai_settings_public(uid)
    assert pub["byok_profiles"] == []
    assert pub["byok_active_id"] == ""


def test_deleting_legacy_profile_does_not_resurrect(auth, uid):
    """Regression: after deleting the migrated legacy profile, the old
    single-config mirror (api_key_enc) must not re-surface it as a synthetic
    "Default" — the key is gone for good."""
    auth.set_ai_settings(uid, mode="byok", provider="gemini", api_key=KEY_A)
    pid = auth.ai_settings_public(uid)["byok_profiles"][0]["id"]
    auth.delete_byok_profile(uid, pid)
    assert auth.ai_settings_public(uid)["byok_profiles"] == []
    assert auth.active_byok(uid) is None
    assert auth.ai_api_key(uid) == ""


def test_deleting_last_named_profile_clears_legacy_mirror(auth, uid):
    """Legacy config + a named profile: deleting both leaves nothing behind."""
    auth.set_ai_settings(uid, mode="byok", provider="gemini", api_key=KEY_A)
    pid_new = auth.add_byok_profile(uid, "New", "openai", api_key=KEY_B)
    pid_legacy = next(
        p["id"] for p in auth.ai_settings_public(uid)["byok_profiles"] if p["name"] == "Default"
    )
    auth.delete_byok_profile(uid, pid_legacy)
    auth.delete_byok_profile(uid, pid_new)
    assert auth.ai_settings_public(uid)["byok_profiles"] == []
    assert auth.active_byok(uid) is None
