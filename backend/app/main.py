"""Application factory: build settings, wire dependencies, mount frontend.

Dependency wiring (composition root):
    FileDocumentRepository | PgDocumentRepository (infrastructure)
        -> DocumentService / CommentService (services)
            -> injected into api handlers via Depends (app.state.*)

noddle is ANONYMOUS-ONLY (Excalidraw-style): no accounts, no sessions — the
board URL is the sharing capability. Exposes ``app = create_app()`` so both
``uvicorn app.main:app`` and the ``backend/main.py`` shim (``uvicorn
main:app``) work.
"""
from __future__ import annotations

import html
import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles

from app.api.ai import router as ai_router
from app.api.collab import router as collab_router
from app.api.comments import router as comments_router
from app.api.documents import router as documents_router
from app.config import Settings
from app.infrastructure.file_repository import FileDocumentRepository
from app.services.ai import AIService
from app.services.ai_jobs import AIJobService
from app.services.pool import FreePool
from app.services.audit import AuditService
from app.services.comments import CommentService
from app.services.documents import DocumentService
from app.services.object_storage import ObjectStorage

logger = logging.getLogger("noddle")


def _build_repositories(settings: Settings):
    """Pick the persistence adapter (composition root helper).

    ``DATABASE_URL`` present AND the database reachable → Postgres adapter;
    otherwise (unset, driver missing, connect/bootstrap failure) → the file
    adapter, with a warning. NEVER crashes at boot — same graceful-degrade
    ethos as the AI endpoints (missing config → 503, not a boot failure).
    Returns ``(document_repo, pool)`` — ``pool`` is the psycopg pool in
    Postgres mode (used to wire the DB-backed ledgers — audit + AI jobs) or
    ``None`` in file-fallback mode.
    """
    if settings.database_url:
        try:
            # Imported lazily: psycopg is only required when DATABASE_URL is set.
            from app.infrastructure.pg_repository import (
                PgDocumentRepository,
                create_pool,
                init_schema,
            )

            pool = create_pool(settings.database_url)
            init_schema(pool)
            logger.info("Persistence: Postgres (DATABASE_URL).")
            return PgDocumentRepository(pool), pool
        except Exception as exc:  # unreachable DB, missing driver, bad URL, …
            logger.warning(
                "DATABASE_URL is set but Postgres is unavailable (%s: %s) — "
                "falling back to file storage.",
                type(exc).__name__,
                exc,
            )
    return FileDocumentRepository(settings.storage_dir), None


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()

    app = FastAPI(title="Noddle Board", version="0.1.0")

    # Railway's edge does not compress responses — the SPA bundle and board
    # JSON payloads need it. WebSocket routes are untouched by this middleware.
    app.add_middleware(GZipMiddleware, minimum_size=1024)

    # The frontend is served same-origin by this app, so CORS is only for local
    # dev tooling. Restrict to an explicit allowlist (env override) — never "*".
    # The X-AI-*/X-Client-Id headers carry the client-side BYOK config and the
    # anonymous job identity (see api/ai.py).
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.allowed_origins,
        allow_methods=["GET", "POST", "PUT", "DELETE", "PATCH"],
        allow_headers=[
            "Content-Type",
            "X-AI-Provider",
            "X-AI-Key",
            "X-AI-Model",
            "X-AI-Base",
            "X-Client-Id",
            "X-Turnstile-Token",
        ],
    )

    # Clickjacking guard: the app may only be framed through the dedicated
    # read-only /embed/{id} route (which any site may iframe); every other
    # HTML response is locked to same-origin framing.
    @app.middleware("http")
    async def _frame_headers(request, call_next):  # type: ignore[no-untyped-def]
        response = await call_next(request)
        if request.url.path.startswith("/embed/"):
            response.headers["Content-Security-Policy"] = "frame-ancestors *"
        elif "text/html" in response.headers.get("content-type", ""):
            response.headers["Content-Security-Policy"] = "frame-ancestors 'self'"
            response.headers["X-Frame-Options"] = "SAMEORIGIN"
        return response

    # ---- composition root: wire the repository into the services ----------
    # Postgres when DATABASE_URL is set and reachable, else the file adapter.
    repo, pool = _build_repositories(settings)
    app.state.settings = settings
    app.state.db_pool = pool
    audit_store = None
    ai_job_store = None
    if pool is not None:
        from app.infrastructure.pg_ledgers import PgAIJobStore, PgAuditStore

        audit_store = PgAuditStore(pool)
        ai_job_store = PgAIJobStore(pool)
    app.state.document_service = DocumentService(repo)
    # Comment threads (M1) — the same adapter implements the comment port.
    app.state.comment_service = CommentService(repo)
    # S3-compatible object storage (R2) — receives rotated log segments so the
    # volume is expendable. Unconfigured ⇒ disabled, everything stays local.
    object_storage = ObjectStorage(settings)
    app.state.object_storage = object_storage
    if object_storage.enabled:
        logger.info("Object storage: enabled (%s).", settings.s3_bucket)
    # Append-only ops audit log (#22): document lifecycle events.
    app.state.audit_service = AuditService(
        settings.storage_dir, object_storage, store=audit_store
    )
    # AIService owns its provider clients lazily; constructing it here never
    # touches the network. BYOK is per-request (X-AI-* headers) — the server
    # stores no keys; DATABRICKS_* env is the optional shared pool.
    app.state.ai_service = AIService()
    # Zero-cost shared tier: key-less AI calls ride OPENROUTER_POOL_KEY on
    # OpenRouter :free models, behind per-IP + daily-budget guards (and
    # optional Turnstile). Unconfigured ⇒ disabled; BYOK always works.
    app.state.free_pool = FreePool()
    # Background image→board conversion queue: uploads become jobs a worker
    # pool converts in parallel; history (keyed by the anonymous X-Client-Id)
    # survives page reloads. DB-backed records in Postgres mode, file fallback
    # for dev.
    app.state.ai_jobs = AIJobService(
        settings.storage_dir,
        app.state.document_service,
        app.state.ai_service,
        store=ai_job_store,
    )

    # ---- routes -----------------------------------------------------------
    @app.get("/api/config")
    def _config() -> dict:
        """Frontend feature flags: shared AI availability + Turnstile key."""
        return {
            "pool_ai": app.state.ai_service.pool_available()
            or app.state.free_pool.available(),
            "turnstile_site_key": app.state.free_pool.turnstile_site_key or None,
        }

    @app.get("/api/health")
    def _health() -> dict:
        # Liveness only — never touches the DB (health ≠ DB readiness), so a
        # Postgres outage degrades features instead of cascading restarts.
        return {"status": "ok", "version": app.version}

    app.include_router(documents_router)
    app.include_router(comments_router)  # /api/documents/{id}/comments
    app.include_router(ai_router)
    app.include_router(collab_router)  # WebSocket /ws/documents/{id}

    # ---- serve the frontend (mount last so /api wins) ---------------------
    frontend = settings.frontend_path()
    if frontend is not None:
        # SPA fallback: share links are /d/{id} — deep links must serve the
        # SPA shell (client-side routing opens the document).
        index_html = frontend / "index.html"

        # The SPA shell is read ONCE at boot; when PLAUSIBLE_DOMAIN is set the
        # (cookieless, privacy-friendly) Plausible snippet is injected before
        # </head> — operator opt-in, absent by default like every integration.
        # NOTE: this loads an external script, which works because the only CSP
        # we set is `frame-ancestors` (see _frame_headers). If a `script-src`/
        # `connect-src` policy is ever added, allowlist the Plausible host there
        # or analytics will silently fail to load/report.
        # Values are operator-supplied env, but escaped anyway so an odd domain
        # can't break out of the HTML attribute.
        shell_html = index_html.read_text(encoding="utf-8")
        if settings.plausible_domain:
            snippet = (
                f'<script defer data-domain="{html.escape(settings.plausible_domain)}" '
                f'src="{html.escape(settings.plausible_src)}"></script>'
            )
            shell_html = shell_html.replace("</head>", snippet + "</head>", 1)

        def _shell() -> HTMLResponse:
            return HTMLResponse(shell_html)

        @app.get("/", response_class=HTMLResponse)
        def _spa_root() -> HTMLResponse:
            # explicit route so the shell (with analytics) wins over the
            # StaticFiles html=True default below
            return _shell()

        @app.get("/d/{doc_id}", response_class=HTMLResponse)
        def _spa_document(doc_id: str) -> HTMLResponse:  # noqa: ARG001
            return _shell()

        @app.get("/embed/{doc_id}", response_class=HTMLResponse)
        def _spa_embed(doc_id: str) -> HTMLResponse:  # noqa: ARG001
            """Read-only iframe view — the SPA hides all chrome for /embed/*.
            This route is exempt from the frame-ancestors lockdown above."""
            return _shell()

        @app.get("/generate", response_class=HTMLResponse)
        def _spa_generate() -> HTMLResponse:
            return _shell()

        app.mount(
            "/",
            StaticFiles(directory=str(frontend), html=True),
            name="frontend",
        )
    else:  # pragma: no cover
        @app.get("/", response_class=HTMLResponse)
        def _no_frontend() -> str:
            return "<h1>noddle API</h1><p>Frontend has not been built.</p>"

    return app


app = create_app()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app.main:app", host="127.0.0.1", port=8000, reload=True)
