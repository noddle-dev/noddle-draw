"""Postgres implementation of the identity & access store.

Drop-in sibling of ``FileAuthRepository`` (same method set — ``AuthService``
duck-types against it). FLAT storage (DB v3, 2026-07-07): every dataclass
field is a real column; team membership lives in the ``team_members`` join
table and jsonb remains only for ``ai_settings.byok_profiles`` (a list of
profile dicts, genuinely document-shaped). Only HASHES of secrets are
persisted — never a raw password, session cookie or API token (unchanged
from the file adapter).

The schema is created by ``pg_repository.init_schema`` (one shared pool, one
idempotent bootstrap at startup).
"""
from __future__ import annotations

import time

from psycopg.types.json import Json
from psycopg_pool import ConnectionPool

from app.domain.models import AISettings, ApiToken, Session, Team, User
from app.infrastructure.pg_repository import _epoch


class PgAuthRepository:
    def __init__(self, pool: ConnectionPool) -> None:
        self._pool = pool

    _USER_COLS = "id, email, name, color, password_hash, created_at, avatar, title"

    @staticmethod
    def _user_from_row(row) -> User:
        uid, email, name, color, password_hash, created_at, avatar, title = row
        return User(
            id=uid,
            email=email,
            name=name,
            color=color,
            password_hash=password_hash,
            created_at=_epoch(created_at),
            avatar=avatar,
            title=title,
        )

    # ---- users ---------------------------------------------------------------
    def save_user(self, user: User) -> None:
        with self._pool.connection() as conn:
            conn.execute(
                """
                INSERT INTO users
                    (id, email, name, color, password_hash, created_at,
                     avatar, title)
                VALUES (%s, %s, %s, %s, %s, to_timestamp(%s), %s, %s)
                ON CONFLICT (id) DO UPDATE SET
                    email = EXCLUDED.email,
                    name = EXCLUDED.name,
                    color = EXCLUDED.color,
                    password_hash = EXCLUDED.password_hash,
                    created_at = EXCLUDED.created_at,
                    avatar = EXCLUDED.avatar,
                    title = EXCLUDED.title
                """,
                (
                    user.id,
                    user.email,
                    user.name,
                    user.color,
                    user.password_hash,
                    user.created_at,
                    user.avatar,
                    user.title,
                ),
            )

    def user_by_id(self, user_id: str) -> User | None:
        with self._pool.connection() as conn:
            row = conn.execute(
                f"SELECT {self._USER_COLS} FROM users WHERE id = %s", (user_id,)
            ).fetchone()
        return self._user_from_row(row) if row else None

    def user_by_email(self, email: str) -> User | None:
        # Emails are normalized (strip+lower) at write time by AuthService;
        # normalize the needle the same way the file adapter does.
        needle = email.strip().lower()
        with self._pool.connection() as conn:
            row = conn.execute(
                f"SELECT {self._USER_COLS} FROM users WHERE email = %s", (needle,)
            ).fetchone()
        return self._user_from_row(row) if row else None

    def list_users(self) -> list[User]:
        with self._pool.connection() as conn:
            rows = conn.execute(f"SELECT {self._USER_COLS} FROM users").fetchall()
        return [self._user_from_row(r) for r in rows]

    # ---- sessions --------------------------------------------------------------
    def save_session(self, session: Session) -> None:
        with self._pool.connection() as conn:
            conn.execute(
                """
                INSERT INTO sessions (token_hash, user_id, created_at, expires_at)
                VALUES (%s, %s, to_timestamp(%s), to_timestamp(%s))
                ON CONFLICT (token_hash) DO UPDATE SET
                    user_id = EXCLUDED.user_id,
                    created_at = EXCLUDED.created_at,
                    expires_at = EXCLUDED.expires_at
                """,
                (
                    session.token_hash,
                    session.user_id,
                    session.created_at,
                    session.expires_at,
                ),
            )

    def session_by_hash(self, token_hash: str) -> Session | None:
        with self._pool.connection() as conn:
            row = conn.execute(
                "SELECT token_hash, user_id, created_at, expires_at"
                " FROM sessions WHERE token_hash = %s",
                (token_hash,),
            ).fetchone()
        if not row:
            return None
        sess = Session(
            token_hash=row[0],
            user_id=row[1],
            created_at=_epoch(row[2]),
            expires_at=_epoch(row[3]),
        )
        if sess.expires_at < time.time():  # lazy expiry, like the file adapter
            self.delete_session(token_hash)
            return None
        return sess

    def delete_session(self, token_hash: str) -> None:
        with self._pool.connection() as conn:
            conn.execute("DELETE FROM sessions WHERE token_hash = %s", (token_hash,))

    def delete_user_sessions(self, user_id: str, keep_hash: str | None = None) -> None:
        """Revoke every session of ``user_id`` except ``keep_hash`` (the
        caller's own) — used after a password change."""
        with self._pool.connection() as conn:
            if keep_hash:
                conn.execute(
                    "DELETE FROM sessions WHERE user_id = %s AND token_hash <> %s",
                    (user_id, keep_hash),
                )
            else:
                conn.execute("DELETE FROM sessions WHERE user_id = %s", (user_id,))

    _TOKEN_COLS = "id, user_id, name, token_hash, scopes, created_at, last_used_at"

    @staticmethod
    def _token_from_row(row) -> ApiToken:
        tid, user_id, name, token_hash, scopes, created_at, last_used_at = row
        return ApiToken(
            id=tid,
            user_id=user_id,
            name=name,
            token_hash=token_hash,
            scopes=list(scopes or []),
            created_at=_epoch(created_at),
            last_used_at=_epoch(last_used_at),
        )

    # ---- api tokens -------------------------------------------------------------
    def save_token(self, token: ApiToken) -> None:
        with self._pool.connection() as conn:
            conn.execute(
                """
                INSERT INTO tokens
                    (id, user_id, name, token_hash, scopes, created_at,
                     last_used_at)
                VALUES (%s, %s, %s, %s, %s, to_timestamp(%s), to_timestamp(%s))
                ON CONFLICT (id) DO UPDATE SET
                    user_id = EXCLUDED.user_id,
                    name = EXCLUDED.name,
                    token_hash = EXCLUDED.token_hash,
                    scopes = EXCLUDED.scopes,
                    created_at = EXCLUDED.created_at,
                    last_used_at = EXCLUDED.last_used_at
                """,
                (
                    token.id,
                    token.user_id,
                    token.name,
                    token.token_hash,
                    list(token.scopes),
                    token.created_at,
                    token.last_used_at,
                ),
            )

    def token_by_hash(self, token_hash: str) -> ApiToken | None:
        with self._pool.connection() as conn:
            row = conn.execute(
                f"SELECT {self._TOKEN_COLS} FROM tokens WHERE token_hash = %s",
                (token_hash,),
            ).fetchone()
        return self._token_from_row(row) if row else None

    def tokens_of_user(self, user_id: str) -> list[ApiToken]:
        with self._pool.connection() as conn:
            rows = conn.execute(
                f"SELECT {self._TOKEN_COLS} FROM tokens WHERE user_id = %s",
                (user_id,),
            ).fetchall()
        return [self._token_from_row(r) for r in rows]

    def delete_token(self, token_id: str) -> None:
        with self._pool.connection() as conn:
            conn.execute("DELETE FROM tokens WHERE id = %s", (token_id,))

    # ---- teams -------------------------------------------------------------------
    # The team_members join table IS the membership storage (DB v3); the
    # members map on the dataclass is reassembled with jsonb_object_agg.
    _TEAM_SELECT = """
        t.id, t.name, t.created_at,
        (SELECT coalesce(jsonb_object_agg(m.user_id, m.role), '{}'::jsonb)
           FROM team_members m WHERE m.team_id = t.id)
    """

    @staticmethod
    def _team_from_row(row) -> Team:
        tid, name, created_at, members = row
        return Team(
            id=tid,
            name=name,
            created_at=_epoch(created_at),
            members=dict(members or {}),
        )

    def save_team(self, team: Team) -> None:
        with self._pool.connection() as conn:
            conn.execute(
                """
                INSERT INTO teams (id, name, created_at)
                VALUES (%s, %s, to_timestamp(%s))
                ON CONFLICT (id) DO UPDATE SET
                    name = EXCLUDED.name,
                    created_at = EXCLUDED.created_at
                """,
                (team.id, team.name, team.created_at),
            )
            # Delete-then-insert keeps the join table an exact mirror of the
            # members map (removed members disappear too).
            conn.execute(
                "DELETE FROM team_members WHERE team_id = %s", (team.id,)
            )
            for member_uid, member_role in team.members.items():
                conn.execute(
                    """
                    INSERT INTO team_members (team_id, user_id, role, created_at)
                    VALUES (%s, %s, %s, to_timestamp(%s))
                    """,
                    (team.id, member_uid, member_role, team.created_at),
                )

    def team_by_id(self, team_id: str) -> Team | None:
        with self._pool.connection() as conn:
            row = conn.execute(
                f"SELECT {self._TEAM_SELECT} FROM teams t WHERE t.id = %s",
                (team_id,),
            ).fetchone()
        return self._team_from_row(row) if row else None

    def teams_of_user(self, user_id: str) -> list[Team]:
        with self._pool.connection() as conn:
            rows = conn.execute(
                f"""
                SELECT {self._TEAM_SELECT} FROM teams t
                WHERE t.id IN (SELECT team_id FROM team_members
                               WHERE user_id = %s)
                """,
                (user_id,),
            ).fetchall()
        return [self._team_from_row(r) for r in rows]

    def delete_team(self, team_id: str) -> None:
        with self._pool.connection() as conn:
            conn.execute("DELETE FROM teams WHERE id = %s", (team_id,))
            # team_members carries no FK to teams (expand phase keeps DDL
            # additive/loose) — clean the mirror rows explicitly.
            conn.execute("DELETE FROM team_members WHERE team_id = %s", (team_id,))

    # ---- per-user AI settings -----------------------------------------------
    def save_ai_settings(self, settings: AISettings) -> None:
        # Wallet columns are written on INSERT only (first mint carries the
        # signup defaults). After that they are mutated EXCLUSIVELY by the
        # atomic wallet_* ops below — a settings save must never clobber a
        # balance that moved since this object was read.
        with self._pool.connection() as conn:
            conn.execute(
                """
                INSERT INTO ai_settings
                    (user_id, mode, provider, api_key_enc, model, api_base,
                     byok_profiles, byok_active_id,
                     credits, month_spent, credits_month)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (user_id) DO UPDATE SET
                    mode = EXCLUDED.mode,
                    provider = EXCLUDED.provider,
                    api_key_enc = EXCLUDED.api_key_enc,
                    model = EXCLUDED.model,
                    api_base = EXCLUDED.api_base,
                    byok_profiles = EXCLUDED.byok_profiles,
                    byok_active_id = EXCLUDED.byok_active_id
                """,
                (
                    settings.user_id,
                    settings.mode,
                    settings.provider,
                    settings.api_key_enc,
                    settings.model,
                    settings.api_base,
                    Json(list(settings.byok_profiles)),
                    settings.byok_active_id,
                    settings.credits,
                    settings.month_spent,
                    settings.credits_month,
                ),
            )

    def ai_settings_by_user(self, user_id: str) -> AISettings | None:
        with self._pool.connection() as conn:
            row = conn.execute(
                "SELECT user_id, mode, provider, api_key_enc, model, api_base,"
                " byok_profiles, byok_active_id, credits, month_spent,"
                " credits_month"
                " FROM ai_settings WHERE user_id = %s",
                (user_id,),
            ).fetchone()
        if row is None:
            return None
        return AISettings(
            user_id=row[0],
            mode=row[1],
            provider=row[2],
            api_key_enc=row[3],
            model=row[4],
            api_base=row[5],
            byok_profiles=list(row[6] or []),
            byok_active_id=row[7],
            credits=row[8] if row[8] is not None else 0,
            month_spent=row[9] if row[9] is not None else 0,
            credits_month=row[10] or "",
        )

    # ---- ✦ wallet (atomic single-statement ops — DESIGN-v2 P7) ---------------
    def wallet_spend(self, user_id: str, cost: int) -> bool:
        """Debit atomically; False (nothing spent) when the balance is short."""
        with self._pool.connection() as conn:
            row = conn.execute(
                "UPDATE ai_settings SET credits = credits - %s,"
                " month_spent = month_spent + %s"
                " WHERE user_id = %s AND credits >= %s RETURNING credits",
                (cost, cost, user_id, cost),
            ).fetchone()
        return row is not None

    def wallet_refund(self, user_id: str, cost: int) -> None:
        with self._pool.connection() as conn:
            conn.execute(
                "UPDATE ai_settings SET credits = credits + %s,"
                " month_spent = GREATEST(0, month_spent - %s)"
                " WHERE user_id = %s",
                (cost, cost, user_id),
            )

    def wallet_add(self, user_id: str, n: int) -> None:
        with self._pool.connection() as conn:
            conn.execute(
                "UPDATE ai_settings SET credits = GREATEST(0, credits + %s)"
                " WHERE user_id = %s",
                (n, user_id),
            )

    def wallet_rollover(self, user_id: str, month: str, allowance: int) -> None:
        """First touch in a new month: refill up to the tier floor, reset the
        month meter. The WHERE guard makes re-runs within a month no-ops."""
        with self._pool.connection() as conn:
            conn.execute(
                "UPDATE ai_settings SET credits_month = %s, month_spent = 0,"
                " credits = GREATEST(credits, %s)"
                " WHERE user_id = %s AND credits_month IS DISTINCT FROM %s",
                (month, allowance, user_id, month),
            )
