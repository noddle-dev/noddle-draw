"""AuthService — identity, sessions, agent tokens, teams + the authz check.

Design (ADR-0002):
  * Passwords: PBKDF2-HMAC-SHA256, 200k iterations, per-user salt (stdlib —
    a temporary placeholder; production will use an external SSO, e.g. Google).
  * Sessions: 256-bit random cookie value, sha256 at rest, 30-day TTL,
    revocable server-side.
  * API tokens: ``noddle_`` + 32-byte urlsafe secret shown ONCE, sha256 at
    rest, scoped. A token is an AGENT principal — AI collaborators act as
    themselves (own name in presence/audit), never impersonating a human.
  * Principal: the single identity envelope every request resolves to —
    kind "user" | "agent" | "guest".
  * ``can(principal, action, meta)``: one auditable authorization function.
    Precedence: owner → per-user share role → team role → link_policy.
"""
from __future__ import annotations

import base64
import hashlib
import os
import re
import secrets
import threading
import time
from dataclasses import dataclass, field

from app.domain.ids import new_id
from app.domain.models import (
    AISettings,
    ApiToken,
    DocumentMeta,
    Session,
    Team,
    User,
    listed_for,
)
from app.infrastructure.auth_repository import FileAuthRepository

SESSION_TTL = 30 * 24 * 3600
PBKDF2_ITERS = 200_000
TOKEN_PREFIX = "noddle_"
KNOWN_SCOPES = {"boards:read", "boards:write", "ai:invoke"}
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

# --- profile completeness (WS1) ------------------------------------------------
# Avatars are small data URLs (client downscales to ≤128px before upload).
# The cap bounds what one profile row can weigh in auth.json / users.data jsonb.
AVATAR_MAX_LEN = 140_000
_AVATAR_RE = re.compile(r"^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$")
TITLE_MAX_LEN = 80
# Sentinel: PATCH /api/me must distinguish "avatar omitted" (keep) from
# "avatar: null" (remove) — None can't carry both meanings.
_UNSET = object()
_COLORS = ["#2563eb", "#7c3aed", "#ec4899", "#d97706", "#16a34a", "#0891b2", "#dc2626"]

# --- per-user AI settings -----------------------------------------------------
# --- anonymous mode (NODDLE_ANON) --------------------------------------------
# Set once at boot by create_app(); read by can() and the create-route guard.
_ANON_MODE = False


def set_anon_mode(enabled: bool) -> None:
    global _ANON_MODE
    _ANON_MODE = bool(enabled)


def anon_mode_enabled() -> bool:
    return _ANON_MODE


AI_PROVIDERS = {"claude", "openai", "gemini", "openrouter", "custom"}
AI_MODES = {"subscription", "byok"}
DEFAULT_AI_CREDITS = 50  # one-time signup grant (on top of the monthly floor)
_MODEL_MAX_LEN = 100  # BYOK model-id override — sanity cap, goes into a JSON body
_API_BASE_MAX_LEN = 300  # custom OpenAI-compatible base URL
_PROFILE_NAME_MAX_LEN = 40  # named BYOK profile label
# The pre-profiles single-key config surfaces as a synthetic profile with THIS
# id; the write-time fold-in (_ensure_migrated) must keep the SAME id, or the
# UI's delete/edit/activate on the id it was shown would 404 mid-request.
_LEGACY_PROFILE_ID = "legacy"

# One lock guards every credit operation (spend / refund / rollover / grant).
# Since DESIGN-v2 P7 the Pg adapter runs each op as ONE atomic UPDATE, so
# there the lock is belt-and-braces; it remains ESSENTIAL for the file
# adapter, whose wallet ops are read-modify-write on the auth.json blob.
# Class-level: there is one AuthService per app, and a shared lock is also
# correct if tests build several.
_CREDITS_LOCK = threading.Lock()


def _current_month() -> str:
    """UTC month stamp for the credit rollover, e.g. '2026-07'."""
    return time.strftime("%Y-%m", time.gmtime())

# ⚠️ MOCKUP-ONLY key obfuscation. base64 + XOR with a settings-derived key is
# NOT encryption — it is trivially reversible by anyone who can read this source
# plus the env. It exists only so the raw BYOK key isn't sitting in auth.json as
# plaintext. PROD MUST use a real KMS / envelope encryption (e.g. AWS KMS, Vault
# transit) and store only ciphertext + a key reference.
_OBF_KEY = (os.environ.get("NODDLE_AI_KEY_SECRET") or "noddle-mockup-not-a-real-kms").encode()


def _xor_b64(data: bytes) -> bytes:
    return bytes(b ^ _OBF_KEY[i % len(_OBF_KEY)] for i, b in enumerate(data))


def _obfuscate(plain: str) -> str:
    if not plain:
        return ""
    return base64.b64encode(_xor_b64(plain.encode())).decode()


def _deobfuscate(enc: str) -> str:
    if not enc:
        return ""
    try:
        return _xor_b64(base64.b64decode(enc.encode())).decode("utf-8", "replace")
    except (ValueError, TypeError):
        return ""


def _mask_key(key: str) -> str | None:
    """Mask a raw key for display: ``sk-…abcd``. Never returns the full key."""
    if not key:
        return None
    if len(key) >= 8:
        return f"{key[:3]}…{key[-4:]}"
    return "••••"


def _profile_public(prof: dict) -> dict:
    """API-safe view of one named BYOK profile: MASKED key only, never raw."""
    key = _deobfuscate(prof.get("api_key_enc", ""))
    return {
        "id": prof.get("id", ""),
        "name": prof.get("name", ""),
        "provider": prof.get("provider", "claude"),
        "model": prof.get("model", ""),
        "api_base": prof.get("api_base", ""),
        "masked_key": _mask_key(key),
        "has_key": bool(key),
    }


class AuthError(Exception):
    """Bad credentials / duplicate email / malformed input. → 400/401."""


class Forbidden(Exception):
    """Principal lacks the permission for this action. → 403."""


@dataclass
class Principal:
    """Who is acting: a person, an AI agent (API token), or a link guest."""

    kind: str  # "user" | "agent" | "guest"
    user_id: str | None = None  # the human (or the agent's owner)
    agent_token_id: str | None = None
    name: str = "Guest"
    color: str = "#9aa1ad"
    scopes: list[str] = field(default_factory=list)

    @property
    def is_authenticated(self) -> bool:
        return self.kind in ("user", "agent")

    def has_scope(self, scope: str) -> bool:
        # Humans are not scope-limited; agents are.
        return self.kind != "agent" or scope in self.scopes


GUEST = Principal(kind="guest")


def _sha256(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def _hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode(), bytes.fromhex(salt), PBKDF2_ITERS
    ).hex()
    return f"pbkdf2${PBKDF2_ITERS}${salt}${digest}"

def _verify_password(password: str, stored: str) -> bool:
    try:
        _, iters, salt, digest = stored.split("$")
        candidate = hashlib.pbkdf2_hmac(
            "sha256", password.encode(), bytes.fromhex(salt), int(iters)
        ).hex()
        return secrets.compare_digest(candidate, digest)
    except ValueError:
        return False


# Login brute-force throttle: after MAX consecutive failures for one email,
# further attempts are rejected for LOCK_S seconds (per-process, in-memory —
# resets on restart, which is fine: it only needs to break automation speed).
LOGIN_MAX_FAILS = 5
LOGIN_LOCK_S = 60.0


class AuthService:
    def __init__(self, repo: FileAuthRepository) -> None:
        self._repo = repo
        self._login_fails: dict[str, tuple[int, float]] = {}  # email → (count, locked_until)
        self._login_lock = threading.Lock()

    # ---- accounts ------------------------------------------------------------
    def register(self, email: str, name: str, password: str) -> tuple[User, str]:
        email = email.strip().lower()
        if not _EMAIL_RE.match(email):
            raise AuthError("Invalid email.")
        if len(password) < 8:
            raise AuthError("Password must be at least 8 characters.")
        if self._repo.user_by_email(email):
            raise AuthError("Email is already registered.")
        user = User(
            id=new_id(),
            email=email,
            name=name.strip()[:60] or email.split("@")[0],
            color=_COLORS[int(time.time()) % len(_COLORS)],
            password_hash=_hash_password(password),
            created_at=time.time(),
        )
        self._repo.save_user(user)
        return user, self._new_session(user.id)

    def login(self, email: str, password: str) -> tuple[User, str]:
        key = email.strip().lower()
        now = time.time()
        with self._login_lock:
            count, until = self._login_fails.get(key, (0, 0.0))
            if count >= LOGIN_MAX_FAILS and now < until:
                # Same wording regardless of whether the account exists — the
                # throttle must not become an account-enumeration oracle.
                raise AuthError("Too many attempts. Try again in a minute.")
        user = self._repo.user_by_email(key)
        if not user or not _verify_password(password, user.password_hash):
            with self._login_lock:
                count, _ = self._login_fails.get(key, (0, 0.0))
                count += 1
                self._login_fails[key] = (count, now + LOGIN_LOCK_S)
            raise AuthError("Incorrect email or password.")
        with self._login_lock:
            self._login_fails.pop(key, None)
        return user, self._new_session(user.id)

    def login_oidc(self, email: str, name: str) -> tuple[User, str]:
        """SSO login (ADR-0003): find-or-create by VERIFIED provider email.
        Created accounts get an unusable random password (SSO-only)."""
        email = email.strip().lower()
        if not _EMAIL_RE.match(email):
            raise AuthError("Provider returned an invalid email.")
        user = self._repo.user_by_email(email)
        if not user:
            user = User(
                id=new_id(),
                email=email,
                name=(name or email.split("@")[0]).strip()[:60],
                color=_COLORS[int(time.time()) % len(_COLORS)],
                password_hash=_hash_password(secrets.token_urlsafe(32)),
                created_at=time.time(),
            )
            self._repo.save_user(user)
        return user, self._new_session(user.id)

    def logout(self, session_token: str) -> None:
        self._repo.delete_session(_sha256(session_token))

    def update_profile(
        self,
        user_id: str,
        name: str | None,
        color: str | None,
        title: str | None = None,
        avatar: object = _UNSET,
    ) -> User:
        """Patch profile fields. ``avatar`` uses the ``_UNSET`` sentinel:
        omitted → keep, ``None``/``""`` → remove, a string → validated data
        URL (``data:image/(png|jpeg|webp);base64,…`` ≤ AVATAR_MAX_LEN chars).
        """
        user = self._repo.user_by_id(user_id)
        if not user:
            raise AuthError("Account not found.")
        if name and name.strip():
            user.name = name.strip()[:60]
        if color and re.match(r"^#[0-9a-fA-F]{6}$", color):
            user.color = color
        if title is not None:
            user.title = title.strip()[:TITLE_MAX_LEN]
        if avatar is not _UNSET:
            if avatar is None or avatar == "":
                user.avatar = None
            elif not isinstance(avatar, str):
                raise AuthError("Avatar must be a data-URL string or null.")
            elif len(avatar) > AVATAR_MAX_LEN:
                raise AuthError("Avatar image is too large.")
            elif not _AVATAR_RE.match(avatar):
                raise AuthError(
                    "Avatar must be a data:image/(png|jpeg|webp);base64 URL."
                )
            else:
                user.avatar = avatar
        self._repo.save_user(user)
        return user

    def change_password(
        self,
        user_id: str,
        current_password: str,
        new_password: str,
        current_session_token: str | None = None,
    ) -> None:
        """Verify the CURRENT password, rehash the new one, and revoke every
        other session of this user (the caller's own session — identified by
        its raw cookie value — survives). Raises AuthError on a mismatch."""
        user = self._repo.user_by_id(user_id)
        if not user or not _verify_password(current_password, user.password_hash):
            raise AuthError("Current password is incorrect.")
        if len(new_password) < 8:
            raise AuthError("Password must be at least 8 characters.")
        user.password_hash = _hash_password(new_password)
        self._repo.save_user(user)
        keep = _sha256(current_session_token) if current_session_token else None
        self._repo.delete_user_sessions(user_id, keep_hash=keep)

    def _new_session(self, user_id: str) -> str:
        raw = secrets.token_urlsafe(32)
        now = time.time()
        self._repo.save_session(
            Session(
                token_hash=_sha256(raw),
                user_id=user_id,
                created_at=now,
                expires_at=now + SESSION_TTL,
            )
        )
        return raw

    # ---- principal resolution --------------------------------------------------
    def principal_from_session(self, session_token: str | None) -> Principal:
        if not session_token:
            return GUEST
        sess = self._repo.session_by_hash(_sha256(session_token))
        if not sess:
            return GUEST
        user = self._repo.user_by_id(sess.user_id)
        if not user:
            return GUEST
        return Principal(
            kind="user", user_id=user.id, name=user.name, color=user.color
        )

    def principal_from_bearer(self, bearer: str | None) -> Principal:
        if not bearer or not bearer.startswith(TOKEN_PREFIX):
            return GUEST
        token = self._repo.token_by_hash(_sha256(bearer))
        if not token:
            return GUEST
        token.last_used_at = time.time()
        self._repo.save_token(token)
        return Principal(
            kind="agent",
            user_id=token.user_id,
            agent_token_id=token.id,
            name=token.name,
            color="#7c3aed",  # agents render purple, like Claude
            scopes=list(token.scopes),
        )

    # ---- agent tokens -------------------------------------------------------------
    def create_token(
        self, user_id: str, name: str, scopes: list[str]
    ) -> tuple[ApiToken, str]:
        clean_scopes = [s for s in scopes if s in KNOWN_SCOPES] or ["boards:read"]
        raw = TOKEN_PREFIX + secrets.token_urlsafe(32)
        token = ApiToken(
            id=new_id(),
            user_id=user_id,
            name=name.strip()[:60] or "Agent",
            token_hash=_sha256(raw),
            scopes=clean_scopes,
            created_at=time.time(),
        )
        self._repo.save_token(token)
        return token, raw  # raw is shown exactly once

    def list_tokens(self, user_id: str) -> list[ApiToken]:
        return sorted(self._repo.tokens_of_user(user_id), key=lambda t: t.created_at)

    def delete_token(self, user_id: str, token_id: str) -> None:
        for t in self._repo.tokens_of_user(user_id):
            if t.id == token_id:
                self._repo.delete_token(token_id)
                return
        raise Forbidden("This token does not belong to you.")

    # ---- teams -----------------------------------------------------------------------
    def create_team(self, user_id: str, name: str) -> Team:
        team = Team(
            id=new_id(),
            name=name.strip()[:60] or "New team",
            created_at=time.time(),
            members={user_id: "admin"},
        )
        self._repo.save_team(team)
        return team

    def my_teams(self, user_id: str) -> list[Team]:
        return sorted(self._repo.teams_of_user(user_id), key=lambda t: t.created_at)

    def add_member(
        self, actor_id: str, team_id: str, email: str, role: str
    ) -> Team:
        team = self._repo.team_by_id(team_id)
        if not team:
            raise AuthError("Team not found.")
        if team.members.get(actor_id) != "admin":
            raise Forbidden("Only a team admin can add members.")
        user = self._repo.user_by_email(email)
        if not user:
            raise AuthError("No account exists with this email.")
        team.members[user.id] = role if role in ("admin", "member") else "member"
        self._repo.save_team(team)
        return team

    def user_public(self, user_id: str) -> dict | None:
        u = self._repo.user_by_id(user_id)
        if not u:
            return None
        return {
            "id": u.id,
            "name": u.name,
            "email": u.email,
            "color": u.color,
            "avatar": u.avatar,
            "title": u.title,
        }

    def find_user_by_email(self, email: str) -> User | None:
        return self._repo.user_by_email(email)

    def team_by_id(self, team_id: str | None) -> Team | None:
        return self._repo.team_by_id(team_id) if team_id else None

    def team_role(self, user_id: str | None, team_id: str | None) -> str | None:
        if not user_id or not team_id:
            return None
        team = self._repo.team_by_id(team_id)
        return team.members.get(user_id) if team else None

    # ---- per-user AI settings ----------------------------------------------------
    def get_ai_settings(self, user_id: str) -> AISettings:
        """Return this user's AI settings, minting a sane default on first read
        (subscription mode, provider claude, DEFAULT_AI_CREDITS credits)."""
        s = self._repo.ai_settings_by_user(user_id)
        if s is None:
            s = AISettings(user_id=user_id, credits=DEFAULT_AI_CREDITS)
            self._repo.save_ai_settings(s)
        return s

    def ai_api_key(self, user_id: str) -> str:
        """The ACTIVE BYOK profile's key in the clear (for the AIService
        transport). Falls back to the legacy single-config key when no named
        profiles exist. Returns "" when nothing usable is configured."""
        prof = self._active_profile(self.get_ai_settings(user_id))
        return _deobfuscate(prof.get("api_key_enc", "")) if prof else ""

    # ---- named BYOK profiles -------------------------------------------------
    def _synth_profiles(self, s: AISettings) -> list[dict]:
        """Raw profile dicts (with ``api_key_enc``). When the user has no named
        profiles yet, surface the LEGACY single-config as a synthetic "Default"
        profile so old accounts keep working — a read-only view, never
        persisted (see ``_ensure_migrated`` for the write-time fold-in)."""
        if s.byok_profiles:
            return s.byok_profiles
        if s.api_key_enc:
            return [{
                "id": _LEGACY_PROFILE_ID,
                "name": "Default",
                "provider": s.provider,
                "api_key_enc": s.api_key_enc,
                "model": s.model,
                "api_base": s.api_base,
            }]
        return []

    def _active_profile(self, s: AISettings) -> dict | None:
        """The profile a byok-mode call resolves against: ``byok_active_id`` if
        it still exists, else the first profile, else None."""
        profiles = self._synth_profiles(s)
        if not profiles:
            return None
        for p in profiles:
            if p.get("id") == s.byok_active_id:
                return p
        return profiles[0]

    def _ensure_migrated(self, s: AISettings) -> None:
        """First mutating profile op folds the legacy single-config into a real
        named profile, so it isn't lost once ``byok_profiles`` becomes the
        source of truth. In-memory only — the caller persists ``s``.

        ⚠ The folded profile MUST keep ``_LEGACY_PROFILE_ID`` — the UI already
        holds that id (from the synthetic read view); minting a fresh one here
        made every delete/edit/activate on the legacy profile 404."""
        if not s.byok_profiles and s.api_key_enc:
            pid = _LEGACY_PROFILE_ID
            s.byok_profiles = [{
                "id": pid,
                "name": "Default",
                "provider": s.provider,
                "api_key_enc": s.api_key_enc,
                "model": s.model,
                "api_base": s.api_base,
            }]
            if not s.byok_active_id:
                s.byok_active_id = pid

    def add_byok_profile(
        self,
        user_id: str,
        name: str,
        provider: str,
        api_key: str = "",
        model: str = "",
        api_base: str = "",
    ) -> str:
        """Create a named BYOK profile and return its id. The first profile
        added (and any migrated legacy config) becomes the active one."""
        if provider not in AI_PROVIDERS:
            raise AuthError("Unknown AI provider.")
        s = self.get_ai_settings(user_id)
        self._ensure_migrated(s)
        pid = new_id()
        prof = {
            "id": pid,
            "name": (name or "").strip()[:_PROFILE_NAME_MAX_LEN] or "Profile",
            "provider": provider,
            "api_key_enc": _obfuscate(api_key.strip()) if api_key and api_key.strip() else "",
            "model": (model or "").strip()[:_MODEL_MAX_LEN],
            "api_base": (api_base or "").strip()[:_API_BASE_MAX_LEN],
        }
        s.byok_profiles = [*s.byok_profiles, prof]
        if not s.byok_active_id:
            s.byok_active_id = pid
        self._repo.save_ai_settings(s)
        return pid

    def update_byok_profile(
        self,
        user_id: str,
        pid: str,
        *,
        name: str | None = None,
        provider: str | None = None,
        api_key: str | None = None,
        model: str | None = None,
        api_base: str | None = None,
    ) -> AISettings:
        """Patch one profile. A non-empty ``api_key`` replaces the stored key;
        ``None``/empty leaves it. ``model``/``api_base``: ``None`` keeps,
        ``""`` clears. Unknown profile ⇒ AuthError."""
        s = self.get_ai_settings(user_id)
        self._ensure_migrated(s)
        prof = next((p for p in s.byok_profiles if p.get("id") == pid), None)
        if prof is None:
            raise AuthError("BYOK profile not found.")
        if name is not None:
            prof["name"] = name.strip()[:_PROFILE_NAME_MAX_LEN] or prof.get("name") or "Profile"
        if provider is not None:
            if provider not in AI_PROVIDERS:
                raise AuthError("Unknown AI provider.")
            prof["provider"] = provider
        if api_key and api_key.strip():
            prof["api_key_enc"] = _obfuscate(api_key.strip())
        if model is not None:
            prof["model"] = model.strip()[:_MODEL_MAX_LEN]
        if api_base is not None:
            prof["api_base"] = api_base.strip()[:_API_BASE_MAX_LEN]
        self._repo.save_ai_settings(s)
        return s

    def delete_byok_profile(self, user_id: str, pid: str) -> AISettings:
        """Remove a profile. If it was active, the first survivor takes over."""
        s = self.get_ai_settings(user_id)
        self._ensure_migrated(s)
        remaining = [p for p in s.byok_profiles if p.get("id") != pid]
        if len(remaining) == len(s.byok_profiles):
            raise AuthError("BYOK profile not found.")
        s.byok_profiles = remaining
        # Clear the legacy single-config mirror alongside its profile —
        # otherwise _synth_profiles would resurrect the "deleted" key as a
        # synthetic "Default" once the profile list is empty again.
        if pid == _LEGACY_PROFILE_ID or not remaining:
            s.api_key_enc = ""
        if s.byok_active_id == pid:
            s.byok_active_id = remaining[0]["id"] if remaining else ""
        self._repo.save_ai_settings(s)
        return s

    def set_active_byok(self, user_id: str, pid: str) -> AISettings:
        """Pick which profile byok-mode calls resolve against. Unknown ⇒ error."""
        s = self.get_ai_settings(user_id)
        self._ensure_migrated(s)
        if not any(p.get("id") == pid for p in s.byok_profiles):
            raise AuthError("BYOK profile not found.")
        s.byok_active_id = pid
        self._repo.save_ai_settings(s)
        return s

    def active_byok(self, user_id: str) -> dict | None:
        """The active BYOK profile as ``{provider, api_key (cleartext), model,
        api_base}`` for the AIService transport, or None when there is no
        usable profile/key (byok mode then degrades to 503)."""
        prof = self._active_profile(self.get_ai_settings(user_id))
        if not prof:
            return None
        key = _deobfuscate(prof.get("api_key_enc", ""))
        if not key:
            return None
        return {
            "provider": prof.get("provider", "claude"),
            "api_key": key,
            "model": prof.get("model", ""),
            "api_base": prof.get("api_base", ""),
        }

    def byok_by_id(self, user_id: str, pid: str) -> dict | None:
        """A SPECIFIC named profile as ``{provider, api_key (cleartext), model,
        api_base}`` — the per-call override path (e.g. the upload flow's
        backend picker), bypassing ``byok_active_id``. None when the profile
        doesn't exist or has no usable key."""
        s = self.get_ai_settings(user_id)
        prof = next(
            (p for p in self._synth_profiles(s) if p.get("id") == pid), None
        )
        if not prof:
            return None
        key = _deobfuscate(prof.get("api_key_enc", ""))
        if not key:
            return None
        return {
            "provider": prof.get("provider", "claude"),
            "api_key": key,
            "model": prof.get("model", ""),
            "api_base": prof.get("api_base", ""),
        }

    def set_ai_settings(
        self,
        user_id: str,
        mode: str | None = None,
        provider: str | None = None,
        api_key: str | None = None,
        model: str | None = None,
        api_base: str | None = None,
    ) -> AISettings:
        """Update mode/provider/key/model/api_base. A non-empty ``api_key``
        replaces the stored key (obfuscated); ``None``/empty leaves it
        untouched. ``model`` is the BYOK model-id override (``None`` keeps,
        ``""`` clears to default). ``api_base`` is the custom provider's
        OpenAI-compatible URL (``None`` keeps, ``""`` clears)."""
        s = self.get_ai_settings(user_id)
        if mode in AI_MODES:
            s.mode = mode
        if provider in AI_PROVIDERS:
            s.provider = provider
        if api_key and api_key.strip():
            s.api_key_enc = _obfuscate(api_key.strip())
        if model is not None:
            s.model = model.strip()[:_MODEL_MAX_LEN]
        if api_base is not None:
            s.api_base = api_base.strip()[:_API_BASE_MAX_LEN]
        self._repo.save_ai_settings(s)
        return s

    # ---- credit wallet -------------------------------------------------------
    # The balance model (aligned with the landing-page tiers):
    #   * ``credits`` is a WALLET — webhook payment grants (billing.py) stack up.
    #   * Once per calendar month the wallet is refilled UP TO the tier's
    #     monthly allowance (refill-to-floor, non-accumulating): free users get
    #     their 25 ✦ back, and paid users are guaranteed the advertised
    #     "N ✦/month" even if a webhook delivery was lost. Balances above the
    #     floor (yearly grants, leftover paid credits) are never clamped down.
    #   * Spends are per-action (AI_CREDIT_COSTS in services/ai.py), charged
    #     up-front and refunded when the provider call fails.

    # All four ops delegate to the repository's wallet_* primitives (DESIGN-v2
    # P7): the Pg adapter runs each as ONE atomic UPDATE on real columns, the
    # file adapter does read-modify-write guarded by _CREDITS_LOCK below. The
    # get_ai_settings() call first mints the settings row on first touch, so
    # the wallet ops always have a row to hit.

    def ensure_month_allowance(self, user_id: str, allowance: int) -> AISettings:
        """Lazy monthly rollover: on the first touch in a new month, refill the
        wallet up to ``allowance`` and reset the month-spent meter."""
        with _CREDITS_LOCK:
            self.get_ai_settings(user_id)
            self._repo.wallet_rollover(user_id, _current_month(), int(allowance))
            return self.get_ai_settings(user_id)

    def add_credits(self, user_id: str, n: int) -> AISettings:
        """Grant purchased credits (billing webhook). Stacks on the wallet."""
        with _CREDITS_LOCK:
            self.get_ai_settings(user_id)
            self._repo.wallet_add(user_id, int(n))
            return self.get_ai_settings(user_id)

    def spend_credits(self, user_id: str, cost: int) -> bool:
        """Atomically consume ``cost`` credits. Returns False (and spends
        nothing) when the balance is short — never goes negative."""
        cost = max(0, int(cost))
        with _CREDITS_LOCK:
            self.get_ai_settings(user_id)
            return self._repo.wallet_spend(user_id, cost)

    def refund_credits(self, user_id: str, cost: int) -> None:
        """Give back an up-front charge after a failed AI call."""
        cost = max(0, int(cost))
        with _CREDITS_LOCK:
            self.get_ai_settings(user_id)
            self._repo.wallet_refund(user_id, cost)

    def ai_settings_public(self, user_id: str) -> dict:
        """API-safe view: masked key only, never the raw secret."""
        s = self.get_ai_settings(user_id)
        key = _deobfuscate(s.api_key_enc)
        profiles = self._synth_profiles(s)
        active = self._active_profile(s)
        return {
            "mode": s.mode,
            "provider": s.provider,
            "model": s.model,
            "api_base": s.api_base,
            "credits": s.credits,
            "month_spent": s.month_spent,
            "masked_key": _mask_key(key),
            "has_key": bool(key),
            "byok_profiles": [_profile_public(p) for p in profiles],
            "byok_active_id": active.get("id") if active else "",
        }


# ---------------------------------------------------------------------------
# authorization — the ONE function that answers "may X do Y to board Z?"
# ---------------------------------------------------------------------------

def can(
    principal: Principal,
    action: str,  # "view" | "edit" | "manage"
    meta: DocumentMeta,
    auth: AuthService,
) -> bool:
    # agent scope gate first (humans skip)
    if action == "view" and not principal.has_scope("boards:read"):
        return False
    if action in ("edit", "manage") and not principal.has_scope("boards:write"):
        return False

    if meta.owner_id and principal.user_id == meta.owner_id:
        return True  # owner (and their agents) can do everything

    role = meta.shares.get(principal.user_id or "")
    if role == "editor" and action in ("view", "edit"):
        return True
    if role == "viewer" and action == "view":
        return True

    team_role = auth.team_role(principal.user_id, meta.team_id)
    if team_role == "admin":
        return True
    if team_role == "member" and action in ("view", "edit"):
        return True

    # ANON MODE (NODDLE_ANON=1): ownerless boards are the NORM — guests mint
    # them with an explicit link_policy, so the policy IS the owner's choice.
    # Fall through to the link-policy rules instead of the hard deny below.
    if meta.owner_id is None and anon_mode_enabled():
        if meta.link_policy == "edit":
            return action in ("view", "edit")
        if meta.link_policy == "view":
            return action == "view"
        return False

    # Ownerless (legacy pre-auth) boards: DENY EVERYTHING (amendment #2,
    # 2026-07-05). The earlier transition rule kept view/edit per their stored
    # link_policy, but that stored value was itself just the old open default —
    # not an owner's decision — so it granted strangers access to boards nobody
    # ever chose to share. With no owner there is no one entitled to grant
    # access; rescue path = scripts/lockdown_link_policy.py --assign-orphans-to.
    if meta.owner_id is None:
        return False

    # Everyone else falls through to the link policy — an OWNED board's
    # link_policy is an explicit owner choice (new boards default to private;
    # the lockdown script resets un-evidenced legacy values).
    if meta.link_policy == "edit":
        return action in ("view", "edit")
    if meta.link_policy == "view":
        return action == "view"
    return False


def is_listed(principal: Principal, meta: DocumentMeta, auth: AuthService) -> bool:
    """Whether a board belongs in this principal's DASHBOARD LIST.

    Stricter than ``can(view)``: link-accessible boards are reachable by URL
    only — they never leak into a stranger's file list (Lucid/Figma
    semantics). Ownerless (legacy) boards are listed to NOBODY and (amendment
    #2) ``can()`` denies them entirely — rescue via
    scripts/lockdown_link_policy.py --assign-orphans-to.

    The rule itself lives in ``domain.models.listed_for`` (shared with the
    repository ``list_for_user`` implementations — DB v2 phase 4); this
    wrapper only resolves team membership for a single meta.
    """
    in_team = auth.team_role(principal.user_id, meta.team_id) is not None
    return listed_for(
        meta, principal.user_id, (meta.team_id,) if in_team else ()
    )
