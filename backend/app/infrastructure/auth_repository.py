"""File-backed store for identity & access data (``auth.json``).

Separate from the documents index on purpose: auth data has a different
lifecycle (sessions expire, tokens revoke) and a different sensitivity level.
Only HASHES of secrets are persisted — never a raw password, session cookie or
API token. Swapping to a real database later means one sibling adapter.
"""
from __future__ import annotations

import json
import time
from dataclasses import asdict
from pathlib import Path

from app.domain.models import AISettings, ApiToken, Session, Team, User
from app.infrastructure.atomic import atomic_write_text


class FileAuthRepository:
    def __init__(self, storage_dir: Path) -> None:
        self._dir = Path(storage_dir)
        self._dir.mkdir(parents=True, exist_ok=True)
        self._path = self._dir / "auth.json"

    # ---- persistence --------------------------------------------------------
    def _load(self) -> dict:
        if not self._path.exists():
            return {"users": {}, "sessions": {}, "tokens": {}, "teams": {}, "ai_settings": {}}
        data = json.loads(self._path.read_text("utf-8"))
        for key in ("users", "sessions", "tokens", "teams", "ai_settings"):
            data.setdefault(key, {})
        return data

    def _save(self, data: dict) -> None:
        atomic_write_text(
            self._path, json.dumps(data, ensure_ascii=False, indent=2)
        )

    # ---- users ---------------------------------------------------------------
    def save_user(self, user: User) -> None:
        d = self._load()
        d["users"][user.id] = asdict(user)
        self._save(d)

    def user_by_id(self, user_id: str) -> User | None:
        u = self._load()["users"].get(user_id)
        return User(**u) if u else None

    def user_by_email(self, email: str) -> User | None:
        needle = email.strip().lower()
        for u in self._load()["users"].values():
            if u["email"] == needle:
                return User(**u)
        return None

    def list_users(self) -> list[User]:
        return [User(**u) for u in self._load()["users"].values()]

    # ---- sessions --------------------------------------------------------------
    def save_session(self, session: Session) -> None:
        d = self._load()
        d["sessions"][session.token_hash] = asdict(session)
        self._save(d)

    def session_by_hash(self, token_hash: str) -> Session | None:
        s = self._load()["sessions"].get(token_hash)
        if not s:
            return None
        sess = Session(**s)
        if sess.expires_at < time.time():
            self.delete_session(token_hash)
            return None
        return sess

    def delete_session(self, token_hash: str) -> None:
        d = self._load()
        if token_hash in d["sessions"]:
            del d["sessions"][token_hash]
            self._save(d)

    def delete_user_sessions(self, user_id: str, keep_hash: str | None = None) -> None:
        """Revoke every session of ``user_id`` except ``keep_hash`` (the
        caller's own) — used after a password change."""
        d = self._load()
        doomed = [
            h
            for h, s in d["sessions"].items()
            if s.get("user_id") == user_id and h != keep_hash
        ]
        if doomed:
            for h in doomed:
                del d["sessions"][h]
            self._save(d)

    # ---- api tokens -------------------------------------------------------------
    def save_token(self, token: ApiToken) -> None:
        d = self._load()
        d["tokens"][token.id] = asdict(token)
        self._save(d)

    def token_by_hash(self, token_hash: str) -> ApiToken | None:
        for t in self._load()["tokens"].values():
            if t["token_hash"] == token_hash:
                return ApiToken(**t)
        return None

    def tokens_of_user(self, user_id: str) -> list[ApiToken]:
        return [
            ApiToken(**t)
            for t in self._load()["tokens"].values()
            if t["user_id"] == user_id
        ]

    def delete_token(self, token_id: str) -> None:
        d = self._load()
        if token_id in d["tokens"]:
            del d["tokens"][token_id]
            self._save(d)

    # ---- teams -------------------------------------------------------------------
    def save_team(self, team: Team) -> None:
        d = self._load()
        d["teams"][team.id] = asdict(team)
        self._save(d)

    def team_by_id(self, team_id: str) -> Team | None:
        t = self._load()["teams"].get(team_id)
        return Team(**t) if t else None

    def teams_of_user(self, user_id: str) -> list[Team]:
        return [
            Team(**t)
            for t in self._load()["teams"].values()
            if user_id in t.get("members", {})
        ]

    def delete_team(self, team_id: str) -> None:
        d = self._load()
        if team_id in d["teams"]:
            del d["teams"][team_id]
            self._save(d)

    # ---- per-user AI settings -----------------------------------------------
    def save_ai_settings(self, settings: AISettings) -> None:
        d = self._load()
        d["ai_settings"][settings.user_id] = asdict(settings)
        self._save(d)

    def ai_settings_by_user(self, user_id: str) -> AISettings | None:
        a = self._load()["ai_settings"].get(user_id)
        return AISettings(**a) if a else None

    # ---- ✦ wallet -------------------------------------------------------------
    # Read-modify-write on the blob — atomicity comes from AuthService's
    # _CREDITS_LOCK (single-process file mode). The Pg adapter does these as
    # single atomic UPDATEs instead; keep the semantics identical.
    def wallet_spend(self, user_id: str, cost: int) -> bool:
        s = self.ai_settings_by_user(user_id)
        if s is None or s.credits < cost:
            return False
        s.credits -= cost
        s.month_spent += cost
        self.save_ai_settings(s)
        return True

    def wallet_refund(self, user_id: str, cost: int) -> None:
        s = self.ai_settings_by_user(user_id)
        if s is None:
            return
        s.credits += cost
        s.month_spent = max(0, s.month_spent - cost)
        self.save_ai_settings(s)

    def wallet_add(self, user_id: str, n: int) -> None:
        s = self.ai_settings_by_user(user_id)
        if s is None:
            return
        s.credits = max(0, s.credits + n)
        self.save_ai_settings(s)

    def wallet_rollover(self, user_id: str, month: str, allowance: int) -> None:
        s = self.ai_settings_by_user(user_id)
        if s is None or s.credits_month == month:
            return
        s.credits_month = month
        s.month_spent = 0
        s.credits = max(s.credits, allowance)
        self.save_ai_settings(s)
