"""Postgres implementation of the DocumentRepository / CommentRepository /
VersionRepository ports.

Selected by ``DATABASE_URL`` (see ``app.main.create_app``): when the env var is
present AND the database answers at boot, this adapter replaces
``FileDocumentRepository``; otherwise the app logs a warning and falls back to
file storage — it never crashes at boot (same ethos as the AI config → 503).

Design notes:
  * Plain SQL over **psycopg v3** (no ORM — matches the repo's low-dependency
    ethos). One small ``psycopg_pool.ConnectionPool`` is shared with the auth
    adapter (``pg_auth_repository``).
  * Schema is created idempotently at startup (``CREATE TABLE IF NOT EXISTS``
    + one-shot blob→column DO-block migrations), see :func:`init_schema`.
  * FLAT storage (DB v3, 2026-07-07): every ``DocumentMeta`` field is a real
    column and ``shares`` lives in the ``document_shares`` join table —
    ``_meta_from_row`` reassembles the dataclass, so the service's
    ``dataclasses.replace`` invariant keeps working. jsonb remains only for
    genuinely document-shaped values (``diagram``, version ``diagram``,
    comment ``anchor``).
  * Id discipline mirrors the file adapter: writes with a malformed id raise
    ``ValueError``; reads/deletes with a malformed id are no-ops/None/[] —
    plus a CHECK constraint (``^[0-9a-f]{12}$``) as defence in depth.
  * ``audit.log`` and ``games_leaderboard.json`` stay file-based by design.

Runtime DB errors propagate as psycopg exceptions — loud and clear, exactly
like an OSError from the file adapter would be.
"""
from __future__ import annotations

from psycopg.types.json import Json
from psycopg_pool import ConnectionPool

from app.domain.ids import is_valid_id
from app.domain.models import Comment, Document, DocumentMeta, DocumentVersion, Folder

# How long boot waits for the first connection before falling back to files.
_CONNECT_WAIT_S = 5.0


def _epoch(dt):
    """timestamptz → epoch float (None-safe) — the domain speaks floats;
    the conversion to/from timestamptz happens only at this SQL boundary
    (writes go through ``to_timestamp(%s)``)."""
    return dt.timestamp() if dt is not None else None

# One statement per entry (psycopg v3 prepares statements individually).
_SCHEMA: tuple[str, ...] = (
    """
    CREATE TABLE IF NOT EXISTS folders (
        id         text PRIMARY KEY CHECK (id ~ '^[0-9a-f]{12}$'),
        name       text NOT NULL,
        color      text NOT NULL,
        created_at timestamptz NOT NULL
    )
    """,
    # DB v3 (2026-07-07): FLAT schema. Every dataclass field is a real column;
    # the old ``meta``/``data``/``snapshot`` jsonb blobs are migrated and
    # DROPPED by the DO-block section at the end of this tuple. jsonb remains
    # ONLY where the value is genuinely document-shaped and read whole:
    # documents.diagram, versions.diagram, comments.anchor (shape varies by
    # kind), ai_settings.byok_profiles (list of profile dicts), the ledger
    # payloads (audit_log.event, ai_usage.entry, notifications.notif,
    # billing_events.raw) and pricing_catalog.data (one materialized doc).
    """
    CREATE TABLE IF NOT EXISTS documents (
        id          text PRIMARY KEY CHECK (id ~ '^[0-9a-f]{12}$'),
        name        text NOT NULL,
        folder_id   text,
        svg         text NOT NULL,
        diagram     jsonb,
        created_at  timestamptz NOT NULL,
        updated_at  timestamptz NOT NULL,
        owner_id    text,
        team_id     text,
        link_policy text NOT NULL DEFAULT 'private'
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS comments (
        id           text PRIMARY KEY CHECK (id ~ '^[0-9a-f]{12}$'),
        doc_id       text NOT NULL
                     REFERENCES documents(id) ON DELETE CASCADE,
        body         text NOT NULL,
        author_name  text NOT NULL DEFAULT '',
        author_color text NOT NULL DEFAULT '#9aa1ad',
        author_id    text,
        page_id      text,
        parent_id    text,
        anchor       jsonb,
        mentions     text[] NOT NULL DEFAULT '{}',
        resolved     boolean NOT NULL DEFAULT false,
        created_at   timestamptz NOT NULL,
        updated_at   timestamptz NOT NULL DEFAULT to_timestamp(0)
    )
    """,
    "CREATE INDEX IF NOT EXISTS comments_doc_id_idx ON comments (doc_id)",
    """
    CREATE TABLE IF NOT EXISTS versions (
        doc_id      text NOT NULL
                    REFERENCES documents(id) ON DELETE CASCADE,
        id          text NOT NULL CHECK (id ~ '^[0-9a-f]{12}$'),
        created_at  timestamptz NOT NULL,
        author_name text NOT NULL DEFAULT '',
        svg         text NOT NULL DEFAULT '',
        diagram     jsonb,
        PRIMARY KEY (doc_id, id)
    )
    """,
    # ---- identity & access (used by pg_auth_repository) --------------------
    """
    CREATE TABLE IF NOT EXISTS users (
        id            text PRIMARY KEY,
        email         text NOT NULL UNIQUE,
        name          text NOT NULL DEFAULT '',
        color         text NOT NULL DEFAULT '#7c3aed',
        password_hash text NOT NULL DEFAULT '',
        created_at    timestamptz NOT NULL DEFAULT to_timestamp(0),
        avatar        text,
        title         text NOT NULL DEFAULT ''
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS sessions (
        token_hash text PRIMARY KEY,
        user_id    text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT to_timestamp(0),
        expires_at timestamptz NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS tokens (
        id           text PRIMARY KEY,
        user_id      text NOT NULL,
        token_hash   text NOT NULL,
        name         text NOT NULL DEFAULT '',
        scopes       text[] NOT NULL DEFAULT '{}',
        created_at   timestamptz NOT NULL DEFAULT to_timestamp(0),
        last_used_at timestamptz
    )
    """,
    "CREATE INDEX IF NOT EXISTS tokens_hash_idx ON tokens (token_hash)",
    "CREATE INDEX IF NOT EXISTS tokens_user_idx ON tokens (user_id)",
    """
    CREATE TABLE IF NOT EXISTS teams (
        id         text PRIMARY KEY,
        name       text NOT NULL DEFAULT '',
        created_at timestamptz NOT NULL DEFAULT to_timestamp(0)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS ai_settings (
        user_id        text PRIMARY KEY,
        mode           text NOT NULL DEFAULT 'subscription',
        provider       text NOT NULL DEFAULT 'claude',
        api_key_enc    text NOT NULL DEFAULT '',
        model          text NOT NULL DEFAULT '',
        api_base       text NOT NULL DEFAULT '',
        byok_profiles  jsonb NOT NULL DEFAULT '[]',
        byok_active_id text NOT NULL DEFAULT '',
        credits        integer NOT NULL DEFAULT 0,
        month_spent    integer NOT NULL DEFAULT 0,
        credits_month  text NOT NULL DEFAULT ''
    )
    """,
    # ---- billing (used by pg_billing_repository) ----------------------------
    """
    CREATE TABLE IF NOT EXISTS subscriptions (
        user_id             text PRIMARY KEY,
        team_id             text,
        tier                text NOT NULL DEFAULT 'free',
        status              text NOT NULL DEFAULT 'active',
        billing_interval    text,
        current_period_end  timestamptz,
        ls_customer_id      text NOT NULL DEFAULT '',
        ls_subscription_id  text NOT NULL DEFAULT '',
        customer_portal_url text NOT NULL DEFAULT '',
        created_at          timestamptz NOT NULL DEFAULT to_timestamp(0),
        updated_at          timestamptz NOT NULL DEFAULT to_timestamp(0)
    )
    """,
    "CREATE INDEX IF NOT EXISTS subscriptions_team_idx ON subscriptions (team_id)",
    """
    CREATE TABLE IF NOT EXISTS ls_webhook_events (
        event_id   text PRIMARY KEY,
        name       text NOT NULL,
        created_at timestamptz NOT NULL
    )
    """,
    # User-visible billing history (WS2 2026-07-05) — one row per processed
    # webhook that touched an account; read newest-first per user.
    """
    CREATE TABLE IF NOT EXISTS billing_events (
        id              bigserial PRIMARY KEY,
        user_id         text,
        event           text NOT NULL,
        amount_usd      numeric(10,2),
        credits_granted integer NOT NULL DEFAULT 0,
        raw             jsonb,
        created_at      timestamptz NOT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS billing_events_user_idx"
    " ON billing_events (user_id, created_at DESC)",
    # ---- pricing catalog (used by pg_pricing_repository) --------------------
    # One materialized row: the model price table synced from the versioned
    # seed JSON (domain/pricing_seed.json) at boot.
    """
    CREATE TABLE IF NOT EXISTS pricing_catalog (
        id         int PRIMARY KEY CHECK (id = 1),
        data       jsonb NOT NULL,
        updated_at timestamptz NOT NULL
    )
    """,
    # ---- old-DB catch-up ALTERs (DB v2 2026-07-05 → DB v3 2026-07-07) -------
    # CREATE TABLE IF NOT EXISTS cannot add columns to a pre-existing table,
    # so every flat column is also added here idempotently. On a fresh DB
    # these are all no-ops; on an old blob-schema DB they prepare the columns
    # the DO-block migration below fills from the jsonb blobs.
    "ALTER TABLE documents ADD COLUMN IF NOT EXISTS owner_id text",
    "ALTER TABLE documents ADD COLUMN IF NOT EXISTS team_id text",
    "ALTER TABLE documents ADD COLUMN IF NOT EXISTS link_policy text",
    "ALTER TABLE documents ADD COLUMN IF NOT EXISTS deleted_at timestamptz",
    "ALTER TABLE folders ADD COLUMN IF NOT EXISTS owner_id text",
    "ALTER TABLE comments ADD COLUMN IF NOT EXISTS author_name text NOT NULL DEFAULT ''",
    "ALTER TABLE comments ADD COLUMN IF NOT EXISTS author_color text NOT NULL DEFAULT '#9aa1ad'",
    "ALTER TABLE comments ADD COLUMN IF NOT EXISTS author_id text",
    "ALTER TABLE comments ADD COLUMN IF NOT EXISTS page_id text",
    "ALTER TABLE comments ADD COLUMN IF NOT EXISTS parent_id text",
    "ALTER TABLE comments ADD COLUMN IF NOT EXISTS anchor jsonb",
    "ALTER TABLE comments ADD COLUMN IF NOT EXISTS mentions text[] NOT NULL DEFAULT '{}'",
    "ALTER TABLE comments ADD COLUMN IF NOT EXISTS resolved boolean NOT NULL DEFAULT false",
    "ALTER TABLE comments ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT to_timestamp(0)",
    "ALTER TABLE versions ADD COLUMN IF NOT EXISTS svg text NOT NULL DEFAULT ''",
    "ALTER TABLE versions ADD COLUMN IF NOT EXISTS diagram jsonb",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS name text NOT NULL DEFAULT ''",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS color text NOT NULL DEFAULT '#7c3aed'",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash text NOT NULL DEFAULT ''",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT to_timestamp(0)",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar text",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS title text NOT NULL DEFAULT ''",
    "ALTER TABLE sessions ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT to_timestamp(0)",
    "ALTER TABLE tokens ADD COLUMN IF NOT EXISTS name text NOT NULL DEFAULT ''",
    "ALTER TABLE tokens ADD COLUMN IF NOT EXISTS scopes text[] NOT NULL DEFAULT '{}'",
    "ALTER TABLE tokens ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT to_timestamp(0)",
    "ALTER TABLE tokens ADD COLUMN IF NOT EXISTS last_used_at timestamptz",
    "ALTER TABLE teams ADD COLUMN IF NOT EXISTS name text NOT NULL DEFAULT ''",
    "ALTER TABLE teams ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT to_timestamp(0)",
    "ALTER TABLE ai_settings ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'subscription'",
    "ALTER TABLE ai_settings ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'claude'",
    "ALTER TABLE ai_settings ADD COLUMN IF NOT EXISTS api_key_enc text NOT NULL DEFAULT ''",
    "ALTER TABLE ai_settings ADD COLUMN IF NOT EXISTS model text NOT NULL DEFAULT ''",
    "ALTER TABLE ai_settings ADD COLUMN IF NOT EXISTS api_base text NOT NULL DEFAULT ''",
    "ALTER TABLE ai_settings ADD COLUMN IF NOT EXISTS byok_profiles jsonb NOT NULL DEFAULT '[]'",
    "ALTER TABLE ai_settings ADD COLUMN IF NOT EXISTS byok_active_id text NOT NULL DEFAULT ''",
    "ALTER TABLE ai_settings ADD COLUMN IF NOT EXISTS credits integer",
    "ALTER TABLE ai_settings ADD COLUMN IF NOT EXISTS month_spent integer",
    "ALTER TABLE ai_settings ADD COLUMN IF NOT EXISTS credits_month text",
    "ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS tier text NOT NULL DEFAULT 'free'",
    "ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'",
    "ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS billing_interval text",
    "ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS current_period_end timestamptz",
    "ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS ls_customer_id text NOT NULL DEFAULT ''",
    "ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS ls_subscription_id text NOT NULL DEFAULT ''",
    "ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS customer_portal_url text NOT NULL DEFAULT ''",
    "ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT to_timestamp(0)",
    "ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT to_timestamp(0)",
    """
    CREATE TABLE IF NOT EXISTS document_shares (
        doc_id     text NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        user_id    text NOT NULL,
        role       text NOT NULL CHECK (role IN ('editor','viewer')),
        created_at timestamptz NOT NULL,
        PRIMARY KEY (doc_id, user_id)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS team_members (
        team_id    text NOT NULL,
        user_id    text NOT NULL,
        role       text NOT NULL,
        created_at timestamptz NOT NULL,
        PRIMARY KEY (team_id, user_id)
    )
    """,
    "CREATE INDEX IF NOT EXISTS documents_owner_idx"
    " ON documents (owner_id, updated_at DESC)",
    "CREATE INDEX IF NOT EXISTS documents_team_idx ON documents (team_id)",
    "CREATE INDEX IF NOT EXISTS documents_folder_idx ON documents (folder_id)",
    "CREATE INDEX IF NOT EXISTS document_shares_user_idx"
    " ON document_shares (user_id)",
    "CREATE INDEX IF NOT EXISTS team_members_user_idx ON team_members (user_id)",
    "CREATE INDEX IF NOT EXISTS folders_owner_idx ON folders (owner_id)",
    # ---- append-only ledgers moved DB-side (2026-07-06 "no local files" rule;
    # see infrastructure/pg_ledgers.py). The full event/entry dict rides in a
    # jsonb column so the exact file shape round-trips and the service-layer
    # aggregation code is reused verbatim; hot filter columns are mirrored out
    # for indexing only. -----------------------------------------------------
    """
    CREATE TABLE IF NOT EXISTS audit_log (
        id         bigserial PRIMARY KEY,
        ts         timestamptz NOT NULL,
        action     text NOT NULL,
        actor_id   text,
        doc_id     text,
        team_id    text,
        event      jsonb NOT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS audit_log_doc_idx ON audit_log (doc_id, ts DESC)",
    "CREATE INDEX IF NOT EXISTS audit_log_ts_idx ON audit_log (ts DESC)",
    """
    CREATE TABLE IF NOT EXISTS user_activity (
        user_id        text PRIMARY KEY,
        last_active_at timestamptz NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS ai_usage (
        id      bigserial PRIMARY KEY,
        user_id text NOT NULL,
        ts      timestamptz NOT NULL,
        entry   jsonb NOT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS ai_usage_user_idx ON ai_usage (user_id, ts DESC)",
    """
    CREATE TABLE IF NOT EXISTS games_leaderboard (
        name   text PRIMARY KEY,
        color  text NOT NULL DEFAULT '',
        points integer NOT NULL DEFAULT 0,
        wins   integer NOT NULL DEFAULT 0,
        games  integer NOT NULL DEFAULT 0
    )
    """,
    # Per-user notification feed (🔔): share invites and other actionable
    # events land here; "seen" state is client-side (localStorage). The full
    # notification dict rides in jsonb so the shape round-trips with the file
    # fallback and the service does no aggregation.
    """
    CREATE TABLE IF NOT EXISTS notifications (
        id      text PRIMARY KEY,
        user_id text NOT NULL,
        ts      timestamptz NOT NULL,
        notif   jsonb NOT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id, ts DESC)",
    # Background image→board conversion jobs (services/ai_jobs.py): the full
    # record rides in jsonb (round-trips with the file fallback); ts mirrors
    # created_at as a real column only for the ORDER BY.
    """
    CREATE TABLE IF NOT EXISTS ai_jobs (
        id      text PRIMARY KEY,
        user_id text NOT NULL,
        ts      timestamptz NOT NULL,
        job     jsonb NOT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS ai_jobs_user_idx ON ai_jobs (user_id, ts DESC)",
    # @mention fan-out (DB v2 P5): one row per (comment, mentioned user) so
    # GET /api/me/mentions stops scanning every board's comments. Mirror of
    # comment.mentions, maintained by save_comment (delete-then-insert);
    # comment/document deletion cascades through the FK. Self-mentions are
    # never fanned out. View access is re-checked at READ time — a row here
    # is a candidate, not a grant.
    """
    CREATE TABLE IF NOT EXISTS mentions (
        comment_id text NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
        user_id    text NOT NULL,
        doc_id     text NOT NULL,
        created_at timestamptz NOT NULL,
        PRIMARY KEY (comment_id, user_id)
    )
    """,
    "CREATE INDEX IF NOT EXISTS mentions_user_idx ON mentions (user_id, created_at DESC)",
    # ---- DB v3.1: epoch double precision → timestamptz (2026-07-07) ---------
    # One loop converts EVERY remaining epoch column (matched by name) in
    # place; it runs BEFORE the blob migrations so by the time those DO
    # blocks execute, all time columns are timestamptz on every vintage of
    # DB. Idempotent: after conversion data_type is no longer double
    # precision, so the loop body never runs again. Defaults (always the
    # epoch-0 placeholder) are re-attached as to_timestamp(0).
    """
    DO $$
    DECLARE r record;
    BEGIN
        FOR r IN
            SELECT c.table_name, c.column_name,
                   c.column_default IS NOT NULL AS had_default
            FROM information_schema.columns c
            WHERE c.table_schema = 'public'
              AND c.data_type = 'double precision'
              AND c.column_name IN
                  ('created_at', 'updated_at', 'deleted_at', 'expires_at',
                   'last_used_at', 'current_period_end', 'ts',
                   'last_active_at')
        LOOP
            EXECUTE format('ALTER TABLE %I ALTER COLUMN %I DROP DEFAULT',
                           r.table_name, r.column_name);
            EXECUTE format('ALTER TABLE %I ALTER COLUMN %I TYPE timestamptz'
                           ' USING to_timestamp(%I)',
                           r.table_name, r.column_name, r.column_name);
            IF r.had_default THEN
                EXECUTE format('ALTER TABLE %I ALTER COLUMN %I'
                               ' SET DEFAULT to_timestamp(0)',
                               r.table_name, r.column_name);
            END IF;
        END LOOP;
    END $$
    """,
    # ---- DB v3 blob migration (2026-07-07 flatten/contract) -----------------
    # One DO block per table: IF the legacy blob column still exists, decode
    # it into the flat columns / join tables in the SAME transaction, then
    # DROP the blob. Runs exactly once per environment (the guard makes every
    # later boot a no-op) and never on a fresh DB. ⚠ Dropping the blob is the
    # point of no return for rolling back to pre-v3 code — take a pg_dump
    # before the first boot of this version (see docs/deploy/POST-DEPLOY.md).
    """
    DO $$
    BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'documents' AND column_name = 'meta') THEN
            UPDATE documents SET
                owner_id    = meta->>'owner_id',
                team_id     = meta->>'team_id',
                link_policy = COALESCE(meta->>'link_policy', 'private');
            INSERT INTO document_shares (doc_id, user_id, role, created_at)
            SELECT d.id, s.key, s.value, d.updated_at
            FROM documents d, jsonb_each_text(d.meta->'shares') AS s
            WHERE jsonb_typeof(d.meta->'shares') = 'object'
              AND s.value IN ('editor', 'viewer')
            ON CONFLICT (doc_id, user_id) DO NOTHING;
            ALTER TABLE documents DROP COLUMN meta;
        END IF;
    END $$
    """,
    """
    DO $$
    BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'comments' AND column_name = 'body'
                     AND data_type = 'jsonb') THEN
            UPDATE comments SET
                author_name  = COALESCE(body->>'author_name', ''),
                author_color = COALESCE(body->>'author_color', '#9aa1ad'),
                author_id    = body->>'author_id',
                page_id      = body->>'page_id',
                parent_id    = body->>'parent_id',
                anchor       = NULLIF(body->'anchor', 'null'::jsonb),
                mentions     = COALESCE(
                    (SELECT array_agg(x)
                     FROM jsonb_array_elements_text(
                         CASE WHEN jsonb_typeof(body->'mentions') = 'array'
                              THEN body->'mentions' ELSE '[]'::jsonb END) AS x),
                    '{}'),
                resolved     = COALESCE((body->>'resolved')::boolean, false),
                updated_at   = COALESCE(
                    to_timestamp((body->>'updated_at')::double precision),
                    created_at);
            ALTER TABLE comments ALTER COLUMN body TYPE text
                USING COALESCE(body->>'body', '');
        END IF;
    END $$
    """,
    """
    DO $$
    BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'versions' AND column_name = 'snapshot') THEN
            UPDATE versions SET
                svg     = COALESCE(snapshot->>'svg', ''),
                diagram = NULLIF(snapshot->'diagram', 'null'::jsonb);
            ALTER TABLE versions DROP COLUMN snapshot;
        END IF;
    END $$
    """,
    """
    DO $$
    BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'users' AND column_name = 'data') THEN
            UPDATE users SET
                name          = COALESCE(data->>'name', ''),
                color         = COALESCE(data->>'color', '#7c3aed'),
                password_hash = COALESCE(data->>'password_hash', ''),
                created_at    = to_timestamp(COALESCE((data->>'created_at')::double precision, 0)),
                avatar        = data->>'avatar',
                title         = COALESCE(data->>'title', '');
            ALTER TABLE users DROP COLUMN data;
        END IF;
    END $$
    """,
    """
    DO $$
    BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'sessions' AND column_name = 'data') THEN
            UPDATE sessions SET
                created_at = to_timestamp(COALESCE((data->>'created_at')::double precision, 0));
            ALTER TABLE sessions DROP COLUMN data;
        END IF;
    END $$
    """,
    """
    DO $$
    BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'tokens' AND column_name = 'data') THEN
            UPDATE tokens SET
                name         = COALESCE(data->>'name', ''),
                scopes       = COALESCE(
                    (SELECT array_agg(x)
                     FROM jsonb_array_elements_text(
                         CASE WHEN jsonb_typeof(data->'scopes') = 'array'
                              THEN data->'scopes' ELSE '[]'::jsonb END) AS x),
                    '{}'),
                created_at   = to_timestamp(COALESCE((data->>'created_at')::double precision, 0)),
                last_used_at = to_timestamp((data->>'last_used_at')::double precision);
            ALTER TABLE tokens DROP COLUMN data;
        END IF;
    END $$
    """,
    """
    DO $$
    BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'teams' AND column_name = 'data') THEN
            UPDATE teams SET
                name       = COALESCE(data->>'name', ''),
                created_at = to_timestamp(COALESCE((data->>'created_at')::double precision, 0));
            INSERT INTO team_members (team_id, user_id, role, created_at)
            SELECT t.id, m.key, m.value,
                   to_timestamp(COALESCE((t.data->>'created_at')::double precision, 0))
            FROM teams t, jsonb_each_text(t.data->'members') AS m
            WHERE jsonb_typeof(t.data->'members') = 'object'
            ON CONFLICT (team_id, user_id) DO NOTHING;
            ALTER TABLE teams DROP COLUMN data;
        END IF;
    END $$
    """,
    # Wallet columns (credits/month_spent/credits_month) may already be the
    # source of truth from the P7 deploy — COALESCE keeps their values and
    # only fills rows that never got the P7 backfill.
    """
    DO $$
    BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'ai_settings' AND column_name = 'data') THEN
            UPDATE ai_settings SET
                mode           = COALESCE(data->>'mode', 'subscription'),
                provider       = COALESCE(data->>'provider', 'claude'),
                api_key_enc    = COALESCE(data->>'api_key_enc', ''),
                model          = COALESCE(data->>'model', ''),
                api_base       = COALESCE(data->>'api_base', ''),
                byok_profiles  = CASE WHEN jsonb_typeof(data->'byok_profiles') = 'array'
                                      THEN data->'byok_profiles' ELSE '[]'::jsonb END,
                byok_active_id = COALESCE(data->>'byok_active_id', ''),
                credits        = COALESCE(credits, (data->>'credits')::integer, 0),
                month_spent    = COALESCE(month_spent, (data->>'month_spent')::integer, 0),
                credits_month  = COALESCE(credits_month, data->>'credits_month', '');
            ALTER TABLE ai_settings DROP COLUMN data;
        END IF;
    END $$
    """,
    """
    DO $$
    BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'subscriptions' AND column_name = 'data') THEN
            UPDATE subscriptions SET
                tier                = COALESCE(data->>'tier', 'free'),
                status              = COALESCE(data->>'status', 'active'),
                billing_interval    = data->>'billing_interval',
                current_period_end  = to_timestamp((data->>'current_period_end')::double precision),
                ls_customer_id      = COALESCE(data->>'ls_customer_id', ''),
                ls_subscription_id  = COALESCE(data->>'ls_subscription_id', ''),
                customer_portal_url = COALESCE(data->>'customer_portal_url', ''),
                created_at          = to_timestamp(COALESCE((data->>'created_at')::double precision, 0)),
                updated_at          = to_timestamp(COALESCE((data->>'updated_at')::double precision, 0));
            ALTER TABLE subscriptions DROP COLUMN data;
        END IF;
    END $$
    """,
    # ---- post-migration normalization (idempotent on every boot) ------------
    # Columns added by pre-v3 ALTERs were nullable with no default; align them
    # with the fresh-DB CREATE definitions.
    "UPDATE documents SET link_policy = 'private' WHERE link_policy IS NULL",
    "ALTER TABLE documents ALTER COLUMN link_policy SET DEFAULT 'private'",
    "ALTER TABLE documents ALTER COLUMN link_policy SET NOT NULL",
    "UPDATE ai_settings SET credits = 0 WHERE credits IS NULL",
    "UPDATE ai_settings SET month_spent = 0 WHERE month_spent IS NULL",
    "UPDATE ai_settings SET credits_month = '' WHERE credits_month IS NULL",
    "ALTER TABLE ai_settings ALTER COLUMN credits SET DEFAULT 0",
    "ALTER TABLE ai_settings ALTER COLUMN credits SET NOT NULL",
    "ALTER TABLE ai_settings ALTER COLUMN month_spent SET DEFAULT 0",
    "ALTER TABLE ai_settings ALTER COLUMN month_spent SET NOT NULL",
    "ALTER TABLE ai_settings ALTER COLUMN credits_month SET DEFAULT ''",
    "ALTER TABLE ai_settings ALTER COLUMN credits_month SET NOT NULL",
    # @mention fan-out safety net — reads the flat mentions[] column, so it
    # works identically on fresh and migrated DBs (0 rows once converged).
    """
    INSERT INTO mentions (comment_id, user_id, doc_id, created_at)
    SELECT c.id, u, c.doc_id, c.created_at
    FROM comments c, unnest(c.mentions) AS u
    WHERE u IS DISTINCT FROM c.author_id
    ON CONFLICT (comment_id, user_id) DO NOTHING
    """,
)


def create_pool(database_url: str) -> ConnectionPool:
    """Open a small shared pool and PROVE connectivity before returning.

    ``pool.wait`` raises (PoolTimeout/OperationalError) when the database is
    unreachable, so the composition root can catch it and fall back to file
    storage instead of hanging or crashing at boot.
    """
    pool = ConnectionPool(
        conninfo=database_url, min_size=1, max_size=5, timeout=10, open=True
    )
    try:
        pool.wait(timeout=_CONNECT_WAIT_S)
    except Exception:
        pool.close()
        raise
    return pool


def init_schema(pool: ConnectionPool) -> None:
    """Create all tables idempotently (CREATE TABLE IF NOT EXISTS)."""
    with pool.connection() as conn:
        for stmt in _SCHEMA:
            conn.execute(stmt)


# Flat DocumentMeta selection (DB v3): every field is a column; shares are
# aggregated from the join table in the same query. Alias the table ``d``.
_META_SELECT = """
    d.id, d.name, d.folder_id, d.created_at, d.updated_at,
    d.owner_id, d.team_id, d.link_policy,
    (SELECT coalesce(jsonb_object_agg(s.user_id, s.role), '{}'::jsonb)
       FROM document_shares s WHERE s.doc_id = d.id)
"""


def _meta_from_row(row) -> DocumentMeta:
    (
        doc_id,
        name,
        folder_id,
        created_at,
        updated_at,
        owner_id,
        team_id,
        link_policy,
        shares,
    ) = row
    return DocumentMeta(
        id=doc_id,
        name=name,
        created_at=_epoch(created_at),
        updated_at=_epoch(updated_at),
        folder_id=folder_id,
        owner_id=owner_id,
        team_id=team_id,
        link_policy=link_policy or "private",
        shares=dict(shares or {}),
    )


class PgDocumentRepository:
    """Concrete Postgres adapter for the ``DocumentRepository``,
    ``CommentRepository`` AND ``VersionRepository`` ports — a drop-in sibling
    of ``FileDocumentRepository``."""

    def __init__(self, pool: ConnectionPool) -> None:
        self._pool = pool

    # ---- documents ----------------------------------------------------------
    def save(self, doc: Document) -> None:
        if not is_valid_id(doc.meta.id):
            raise ValueError(f"Invalid document id: {doc.meta.id!r}")
        meta = doc.meta
        with self._pool.connection() as conn:
            conn.execute(
                """
                INSERT INTO documents
                    (id, name, folder_id, svg, diagram, created_at, updated_at,
                     owner_id, team_id, link_policy)
                VALUES (%s, %s, %s, %s, %s, to_timestamp(%s), to_timestamp(%s),
                        %s, %s, %s)
                ON CONFLICT (id) DO UPDATE SET
                    name = EXCLUDED.name,
                    folder_id = EXCLUDED.folder_id,
                    svg = EXCLUDED.svg,
                    diagram = EXCLUDED.diagram,
                    created_at = EXCLUDED.created_at,
                    updated_at = EXCLUDED.updated_at,
                    owner_id = EXCLUDED.owner_id,
                    team_id = EXCLUDED.team_id,
                    link_policy = EXCLUDED.link_policy
                """,
                (
                    meta.id,
                    meta.name,
                    meta.folder_id,
                    doc.svg,
                    Json(doc.diagram) if doc.diagram is not None else None,
                    meta.created_at,
                    meta.updated_at,
                    meta.owner_id,
                    meta.team_id,
                    meta.link_policy,
                ),
            )
            # The join table IS the shares storage: delete-then-insert in the
            # same transaction (removed shares disappear too). Roles other
            # than editor/viewer are skipped — the CHECK constraint would
            # reject them and the authz lattice ignores them anyway.
            conn.execute(
                "DELETE FROM document_shares WHERE doc_id = %s", (meta.id,)
            )
            for share_uid, share_role in meta.shares.items():
                if share_role not in ("editor", "viewer"):
                    continue
                conn.execute(
                    """
                    INSERT INTO document_shares (doc_id, user_id, role, created_at)
                    VALUES (%s, %s, %s, to_timestamp(%s))
                    """,
                    (meta.id, share_uid, share_role, meta.updated_at),
                )

    def load(self, doc_id: str) -> Document | None:
        if not is_valid_id(doc_id):
            return None
        with self._pool.connection() as conn:
            row = conn.execute(
                f"SELECT d.svg, d.diagram, {_META_SELECT}"
                " FROM documents d WHERE d.id = %s",
                (doc_id,),
            ).fetchone()
        if row is None:
            return None
        return Document(meta=_meta_from_row(row[2:]), svg=row[0], diagram=row[1])

    def list(self) -> list[DocumentMeta]:
        with self._pool.connection() as conn:
            rows = conn.execute(
                f"SELECT {_META_SELECT} FROM documents d"
            ).fetchall()
        return [_meta_from_row(r) for r in rows]

    def list_for_user(self, user_id, team_ids) -> list[DocumentMeta]:
        # Answers the dashboard-listing rule (domain.models.listed_for) from
        # the indexed columns/join tables — each UNION branch hits its own
        # index. owner_id IS NOT NULL = ownerless legacy boards are listed to
        # nobody (ADR-0002 amendment #2).
        with self._pool.connection() as conn:
            rows = conn.execute(
                f"""
                SELECT {_META_SELECT} FROM documents d
                WHERE d.owner_id IS NOT NULL AND d.id IN (
                    SELECT id FROM documents WHERE owner_id = %s
                    UNION
                    SELECT doc_id FROM document_shares WHERE user_id = %s
                    UNION
                    SELECT id FROM documents WHERE team_id = ANY(%s)
                )
                ORDER BY d.updated_at DESC
                """,
                (user_id, user_id, list(team_ids)),
            ).fetchall()
        return [_meta_from_row(r) for r in rows]

    def metas_by_ids(self, doc_ids) -> list[DocumentMeta]:
        ids = [d for d in doc_ids if is_valid_id(d)]
        if not ids:
            return []
        with self._pool.connection() as conn:
            rows = conn.execute(
                f"SELECT {_META_SELECT} FROM documents d WHERE d.id = ANY(%s)",
                (ids,),
            ).fetchall()
        return [_meta_from_row(r) for r in rows]

    def delete(self, doc_id: str) -> None:
        if not is_valid_id(doc_id):
            return
        # comments + versions go with the document (ON DELETE CASCADE),
        # mirroring the file adapter's sidecar/rmtree cleanup.
        with self._pool.connection() as conn:
            conn.execute("DELETE FROM documents WHERE id = %s", (doc_id,))

    def exists(self, doc_id: str) -> bool:
        if not is_valid_id(doc_id):
            return False
        with self._pool.connection() as conn:
            row = conn.execute(
                "SELECT 1 FROM documents WHERE id = %s", (doc_id,)
            ).fetchone()
        return row is not None

    def payload_size(self, doc_id: str) -> int:
        """Bytes at rest: svg + diagram + comments + version snapshots —
        the same accounting the file adapter does over its sidecar files."""
        if not is_valid_id(doc_id):
            return 0
        with self._pool.connection() as conn:
            row = conn.execute(
                """
                SELECT
                    coalesce((SELECT octet_length(svg)
                                     + coalesce(octet_length(diagram::text), 0)
                              FROM documents WHERE id = %s), 0)
                  + coalesce((SELECT sum(octet_length(body))
                              FROM comments WHERE doc_id = %s), 0)
                  + coalesce((SELECT sum(octet_length(svg)
                                         + coalesce(octet_length(diagram::text), 0))
                              FROM versions WHERE doc_id = %s), 0)
                """,
                (doc_id, doc_id, doc_id),
            ).fetchone()
        return int(row[0]) if row else 0

    # ---- comments (CommentRepository port) -----------------------------------
    _COMMENT_COLS = (
        "id, doc_id, body, author_name, author_color, author_id, page_id,"
        " parent_id, anchor, mentions, resolved, created_at, updated_at"
    )

    @staticmethod
    def _comment_from_row(row) -> Comment:
        (
            cid,
            doc_id,
            body,
            author_name,
            author_color,
            author_id,
            page_id,
            parent_id,
            anchor,
            mentions,
            resolved,
            created_at,
            updated_at,
        ) = row
        return Comment(
            id=cid,
            doc_id=doc_id,
            body=body,
            author_name=author_name,
            created_at=_epoch(created_at),
            updated_at=_epoch(updated_at),
            author_id=author_id,
            author_color=author_color,
            page_id=page_id,
            parent_id=parent_id,
            anchor=anchor,
            mentions=list(mentions or []),
            resolved=bool(resolved),
        )

    def list_comments(self, doc_id: str) -> list[Comment]:
        if not is_valid_id(doc_id):
            return []
        with self._pool.connection() as conn:
            rows = conn.execute(
                f"SELECT {self._COMMENT_COLS} FROM comments WHERE doc_id = %s",
                (doc_id,),
            ).fetchall()
        return [self._comment_from_row(r) for r in rows]

    def save_comment(self, comment: Comment) -> None:
        if not is_valid_id(comment.doc_id) or not is_valid_id(comment.id):
            raise ValueError(f"Invalid comment/doc id: {comment.id!r}")
        with self._pool.connection() as conn:
            conn.execute(
                """
                INSERT INTO comments
                    (id, doc_id, body, author_name, author_color, author_id,
                     page_id, parent_id, anchor, mentions, resolved,
                     created_at, updated_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                        to_timestamp(%s), to_timestamp(%s))
                ON CONFLICT (id) DO UPDATE SET
                    body = EXCLUDED.body,
                    author_name = EXCLUDED.author_name,
                    author_color = EXCLUDED.author_color,
                    author_id = EXCLUDED.author_id,
                    page_id = EXCLUDED.page_id,
                    parent_id = EXCLUDED.parent_id,
                    anchor = EXCLUDED.anchor,
                    mentions = EXCLUDED.mentions,
                    resolved = EXCLUDED.resolved,
                    updated_at = EXCLUDED.updated_at
                """,
                (
                    comment.id,
                    comment.doc_id,
                    comment.body,
                    comment.author_name,
                    comment.author_color,
                    comment.author_id,
                    comment.page_id,
                    comment.parent_id,
                    Json(comment.anchor) if comment.anchor is not None else None,
                    list(comment.mentions),
                    comment.resolved,
                    comment.created_at,
                    comment.updated_at,
                ),
            )
            # Mirror the @mention fan-out (P5) in the same transaction —
            # delete-then-insert so edits that remove a mention also remove
            # the feed row. Self-mentions never fan out.
            conn.execute(
                "DELETE FROM mentions WHERE comment_id = %s", (comment.id,)
            )
            for uid in dict.fromkeys(comment.mentions):
                if not uid or uid == comment.author_id:
                    continue
                conn.execute(
                    """
                    INSERT INTO mentions (comment_id, user_id, doc_id, created_at)
                    VALUES (%s, %s, %s, to_timestamp(%s))
                    """,
                    (comment.id, uid, comment.doc_id, comment.created_at),
                )

    def delete_comments(self, doc_id: str, comment_ids: list[str]) -> None:
        if not is_valid_id(doc_id) or not comment_ids:
            return
        # mentions rows go with the comment (ON DELETE CASCADE).
        with self._pool.connection() as conn:
            conn.execute(
                "DELETE FROM comments WHERE doc_id = %s AND id = ANY(%s)",
                (doc_id, list(comment_ids)),
            )

    def mentions_of_user(self, user_id: str, limit: int = 200) -> list[Comment]:
        cols = ", ".join(f"c.{c.strip()}" for c in self._COMMENT_COLS.split(","))
        with self._pool.connection() as conn:
            rows = conn.execute(
                f"""
                SELECT {cols} FROM mentions m
                JOIN comments c ON c.id = m.comment_id
                WHERE m.user_id = %s
                ORDER BY m.created_at DESC
                LIMIT %s
                """,
                (user_id, limit),
            ).fetchall()
        return [self._comment_from_row(r) for r in rows]

    # ---- versions (VersionRepository port) -----------------------------------
    def list_versions(self, doc_id: str) -> list[DocumentVersion]:
        if not is_valid_id(doc_id):
            return []
        with self._pool.connection() as conn:
            rows = conn.execute(
                "SELECT id, created_at, author_name FROM versions WHERE doc_id = %s",
                (doc_id,),
            ).fetchall()
        # metadata only — payloads stay in the DB until load_version
        return [
            DocumentVersion(
                id=vid,
                doc_id=doc_id,
                created_at=_epoch(created_at),
                author_name=author_name,
            )
            for vid, created_at, author_name in rows
        ]

    def load_version(self, doc_id: str, version_id: str) -> DocumentVersion | None:
        if not is_valid_id(doc_id) or not is_valid_id(version_id):
            return None
        with self._pool.connection() as conn:
            row = conn.execute(
                """
                SELECT created_at, author_name, svg, diagram
                FROM versions WHERE doc_id = %s AND id = %s
                """,
                (doc_id, version_id),
            ).fetchone()
        if row is None:
            return None
        created_at, author_name, svg, diagram = row
        return DocumentVersion(
            id=version_id,
            doc_id=doc_id,
            created_at=_epoch(created_at),
            author_name=author_name,
            svg=svg or "",
            diagram=diagram,
        )

    def save_version(self, version: DocumentVersion) -> None:
        if not is_valid_id(version.doc_id) or not is_valid_id(version.id):
            raise ValueError(f"Invalid version/doc id: {version.id!r}")
        # Overwrite-by-id keeps the service's 60s/author COALESCE semantics:
        # a coalesced autosave re-saves the newest snapshot under the same id.
        with self._pool.connection() as conn:
            conn.execute(
                """
                INSERT INTO versions (doc_id, id, created_at, author_name, svg, diagram)
                VALUES (%s, %s, to_timestamp(%s), %s, %s, %s)
                ON CONFLICT (doc_id, id) DO UPDATE SET
                    created_at = EXCLUDED.created_at,
                    author_name = EXCLUDED.author_name,
                    svg = EXCLUDED.svg,
                    diagram = EXCLUDED.diagram
                """,
                (
                    version.doc_id,
                    version.id,
                    version.created_at,
                    version.author_name,
                    version.svg,
                    Json(version.diagram) if version.diagram is not None else None,
                ),
            )

    def delete_versions(self, doc_id: str, version_ids: list[str]) -> None:
        if not is_valid_id(doc_id):
            return
        vids = [v for v in version_ids if is_valid_id(v)]
        if not vids:
            return
        with self._pool.connection() as conn:
            conn.execute(
                "DELETE FROM versions WHERE doc_id = %s AND id = ANY(%s)",
                (doc_id, vids),
            )

    # ---- folders -------------------------------------------------------------
    def list_folders(self) -> list[Folder]:
        with self._pool.connection() as conn:
            rows = conn.execute(
                "SELECT id, name, color, created_at, owner_id FROM folders"
            ).fetchall()
        return [
            Folder(
                id=fid,
                name=name,
                color=color,
                created_at=_epoch(created_at),
                owner_id=owner_id,
            )
            for fid, name, color, created_at, owner_id in rows
        ]

    def save_folder(self, folder: Folder) -> None:
        if not is_valid_id(folder.id):
            raise ValueError(f"Invalid folder id: {folder.id!r}")
        with self._pool.connection() as conn:
            conn.execute(
                """
                INSERT INTO folders (id, name, color, created_at, owner_id)
                VALUES (%s, %s, %s, to_timestamp(%s), %s)
                ON CONFLICT (id) DO UPDATE SET
                    name = EXCLUDED.name,
                    color = EXCLUDED.color,
                    created_at = EXCLUDED.created_at,
                    owner_id = EXCLUDED.owner_id
                """,
                (
                    folder.id,
                    folder.name,
                    folder.color,
                    folder.created_at,
                    folder.owner_id,
                ),
            )

    def delete_folder(self, folder_id: str) -> None:
        if not is_valid_id(folder_id):
            return
        with self._pool.connection() as conn:
            conn.execute("DELETE FROM folders WHERE id = %s", (folder_id,))
