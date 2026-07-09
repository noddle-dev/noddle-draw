"""Postgres implementation of the DocumentRepository / CommentRepository /
VersionRepository ports.

Selected by ``DATABASE_URL`` (see ``app.main.create_app``): when the env var is
present AND the database answers at boot, this adapter replaces
``FileDocumentRepository``; otherwise the app logs a warning and falls back to
file storage — it never crashes at boot (same ethos as the AI config → 503).

Design notes:
  * Plain SQL over **psycopg v3** (no ORM — matches the repo's low-dependency
    ethos). One small ``psycopg_pool.ConnectionPool`` shared with the ledger
    stores (``pg_ledgers``).
  * Schema is created idempotently at startup (``CREATE TABLE IF NOT EXISTS``),
    see :func:`init_schema`. Tables owned by the removed accounts/billing/
    games features (users, sessions, tokens, teams, ai_settings,
    subscriptions, billing_events, ls_webhook_events, pricing_catalog,
    folders, document_shares, team_members, mentions, user_activity,
    ai_usage, games_leaderboard, notifications) are NO LONGER created — but
    existing databases keep them untouched; cleanup is a manual, documented
    step.
  * Documents SELECT explicit columns only: rows written by the old accounts
    build carry extra columns (folder_id, team_id, …) that are simply ignored.
  * Id discipline mirrors the file adapter: writes with a malformed id raise
    ``ValueError``; reads/deletes with a malformed id are no-ops/None/[] —
    plus a CHECK constraint (``^[0-9a-f]{12}$``) as defence in depth.

Runtime DB errors propagate as psycopg exceptions — loud and clear, exactly
like an OSError from the file adapter would be.
"""
from __future__ import annotations

from psycopg.types.json import Json
from psycopg_pool import ConnectionPool

from app.domain.ids import is_valid_id
from app.domain.models import Comment, Document, DocumentMeta, DocumentVersion

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
    CREATE TABLE IF NOT EXISTS documents (
        id          text PRIMARY KEY CHECK (id ~ '^[0-9a-f]{12}$'),
        name        text NOT NULL,
        svg         text NOT NULL,
        diagram     jsonb,
        created_at  timestamptz NOT NULL,
        updated_at  timestamptz NOT NULL,
        owner_id    text,
        link_policy text NOT NULL DEFAULT 'edit'
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
    # ---- old-DB catch-up ALTERs ---------------------------------------------
    # CREATE TABLE IF NOT EXISTS cannot add columns to a pre-existing table,
    # so columns this build reads are also added here idempotently.
    "ALTER TABLE documents ADD COLUMN IF NOT EXISTS owner_id text",
    "ALTER TABLE documents ADD COLUMN IF NOT EXISTS link_policy text",
    "ALTER TABLE comments ADD COLUMN IF NOT EXISTS author_name text NOT NULL DEFAULT ''",
    "ALTER TABLE comments ADD COLUMN IF NOT EXISTS author_color text NOT NULL DEFAULT '#9aa1ad'",
    "ALTER TABLE comments ADD COLUMN IF NOT EXISTS author_id text",
    "ALTER TABLE comments ADD COLUMN IF NOT EXISTS page_id text",
    "ALTER TABLE comments ADD COLUMN IF NOT EXISTS parent_id text",
    "ALTER TABLE comments ADD COLUMN IF NOT EXISTS anchor jsonb",
    "ALTER TABLE comments ADD COLUMN IF NOT EXISTS resolved boolean NOT NULL DEFAULT false",
    "ALTER TABLE comments ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT to_timestamp(0)",
    "ALTER TABLE versions ADD COLUMN IF NOT EXISTS svg text NOT NULL DEFAULT ''",
    "ALTER TABLE versions ADD COLUMN IF NOT EXISTS diagram jsonb",
    # ---- append-only ledgers kept DB-side (see infrastructure/pg_ledgers.py).
    # The full event/record dict rides in a jsonb column so the exact file
    # shape round-trips; hot filter columns are mirrored out for indexing.
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
    # Background image→board conversion jobs (services/ai_jobs.py): the full
    # record rides in jsonb (round-trips with the file fallback); ts mirrors
    # created_at as a real column only for the ORDER BY. ``user_id`` holds the
    # anonymous client id (X-Client-Id) that owns the job history.
    """
    CREATE TABLE IF NOT EXISTS ai_jobs (
        id      text PRIMARY KEY,
        user_id text NOT NULL,
        ts      timestamptz NOT NULL,
        job     jsonb NOT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS ai_jobs_user_idx ON ai_jobs (user_id, ts DESC)",
    # ---- epoch double precision → timestamptz (DB v3.1, 2026-07-07) ---------
    # Converts EVERY remaining epoch column (matched by name) in place —
    # idempotent: after conversion data_type is no longer double precision.
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
                  ('created_at', 'updated_at', 'deleted_at', 'ts')
              AND c.table_name IN ('documents', 'comments', 'versions',
                                   'audit_log', 'ai_jobs')
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
    # ---- pre-v3 blob migration (documents/comments/versions only) -----------
    # IF the legacy jsonb blob column still exists, decode it into the flat
    # columns in the same transaction, then DROP the blob. Never runs on a
    # fresh DB; account-era tables are left entirely alone.
    """
    DO $$
    BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'documents' AND column_name = 'meta') THEN
            UPDATE documents SET
                owner_id    = meta->>'owner_id',
                link_policy = COALESCE(meta->>'link_policy', 'private');
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
    # ---- normalization (idempotent on every boot) ----------------------------
    # Rows whose link_policy was never set behave as the account-era default
    # ("private" = dark); the documented cutover migration flips them to
    # 'edit' explicitly. New boards default to 'edit' at the app layer.
    "UPDATE documents SET link_policy = 'private' WHERE link_policy IS NULL",
    "ALTER TABLE documents ALTER COLUMN link_policy SET DEFAULT 'edit'",
    "ALTER TABLE documents ALTER COLUMN link_policy SET NOT NULL",
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


# Explicit column list: legacy account-era columns (folder_id, team_id, …)
# may still exist on the table — they are never selected. Alias the table
# ``d``.
_META_SELECT = """
    d.id, d.name, d.created_at, d.updated_at, d.owner_id, d.link_policy
"""


def _meta_from_row(row) -> DocumentMeta:
    doc_id, name, created_at, updated_at, owner_id, link_policy = row
    return DocumentMeta(
        id=doc_id,
        name=name,
        created_at=_epoch(created_at),
        updated_at=_epoch(updated_at),
        owner_id=owner_id,
        link_policy=link_policy or "edit",
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
                    (id, name, svg, diagram, created_at, updated_at,
                     owner_id, link_policy)
                VALUES (%s, %s, %s, %s, to_timestamp(%s), to_timestamp(%s),
                        %s, %s)
                ON CONFLICT (id) DO UPDATE SET
                    name = EXCLUDED.name,
                    svg = EXCLUDED.svg,
                    diagram = EXCLUDED.diagram,
                    created_at = EXCLUDED.created_at,
                    updated_at = EXCLUDED.updated_at,
                    owner_id = EXCLUDED.owner_id,
                    link_policy = EXCLUDED.link_policy
                """,
                (
                    meta.id,
                    meta.name,
                    doc.svg,
                    Json(doc.diagram) if doc.diagram is not None else None,
                    meta.created_at,
                    meta.updated_at,
                    meta.owner_id,
                    meta.link_policy,
                ),
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
        " parent_id, anchor, resolved, created_at, updated_at"
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
                     page_id, parent_id, anchor, resolved,
                     created_at, updated_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                        to_timestamp(%s), to_timestamp(%s))
                ON CONFLICT (id) DO UPDATE SET
                    body = EXCLUDED.body,
                    author_name = EXCLUDED.author_name,
                    author_color = EXCLUDED.author_color,
                    author_id = EXCLUDED.author_id,
                    page_id = EXCLUDED.page_id,
                    parent_id = EXCLUDED.parent_id,
                    anchor = EXCLUDED.anchor,
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
                    comment.resolved,
                    comment.created_at,
                    comment.updated_at,
                ),
            )

    def delete_comments(self, doc_id: str, comment_ids: list[str]) -> None:
        if not is_valid_id(doc_id) or not comment_ids:
            return
        with self._pool.connection() as conn:
            conn.execute(
                "DELETE FROM comments WHERE doc_id = %s AND id = ANY(%s)",
                (doc_id, list(comment_ids)),
            )

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
