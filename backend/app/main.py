"""Application factory: build settings, wire dependencies, mount frontend.

Dependency wiring (composition root):
    FileDocumentRepository (infrastructure)
        -> DocumentService (services)
            -> injected into api handlers via Depends (app.state.document_service)

Exposes ``app = create_app()`` so both ``uvicorn app.main:app`` and the
``backend/main.py`` shim (``uvicorn main:app``) work.
"""
from __future__ import annotations

import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles

from app.api.activity import router as activity_router
from app.api.ai import router as ai_router
from app.api.auth import SESSION_COOKIE
from app.api.auth import router as auth_router
from app.api.collab import router as collab_router
from app.api.comments import mentions_router
from app.api.comments import router as comments_router
from app.api.documents import router as documents_router
from app.api.folders import router as folders_router
from app.api.game_trivia import router as trivia_router
from app.api.game_wordbomb import router as wordbomb_router
from app.api.games import router as games_router
from app.api.notifications import router as notifications_router
from app.api.payments import router as payments_router
from app.config import Settings
from app.domain.pricing import PriceCatalog, load_seed
from app.infrastructure.auth_repository import FileAuthRepository
from app.infrastructure.billing_repository import FileBillingRepository
from app.infrastructure.file_repository import FileDocumentRepository
from app.infrastructure.pricing_repository import FilePricingRepository
from app.services.activity import ActivityService
from app.services.ai import AIService
from app.services.ai_jobs import AIJobService
from app.services.ai_usage import AIUsageLedger
from app.services.audit import AuditService
from app.services.auth import AuthService, set_anon_mode
from app.services.billing import BillingService
from app.services.comments import CommentService
from app.services.documents import DocumentService
from app.services.notifications import NotificationService
from app.services.object_storage import ObjectStorage

logger = logging.getLogger("noddle")


def _build_repositories(settings: Settings):
    """Pick the persistence adapters (composition root helper).

    ``DATABASE_URL`` present AND the database reachable → Postgres adapters;
    otherwise (unset, driver missing, connect/bootstrap failure) → the file
    adapters, with a warning. NEVER crashes at boot — same graceful-degrade
    ethos as the AI endpoints (missing config → 503, not a boot failure).
    Returns ``(document_repo, auth_repo, billing_repo, pricing_repo, pool)`` —
    all ends must come from the SAME backend so ACLs and subscriptions
    reference the same user store. ``pool`` is the psycopg pool in Postgres
    mode (used to wire the DB-backed ledgers — audit/activity/usage/games) or
    ``None`` in file-fallback mode.
    """
    if settings.database_url:
        try:
            # Imported lazily: psycopg is only required when DATABASE_URL is set.
            from app.infrastructure.pg_auth_repository import PgAuthRepository
            from app.infrastructure.pg_billing_repository import PgBillingRepository
            from app.infrastructure.pg_pricing_repository import PgPricingRepository
            from app.infrastructure.pg_repository import (
                PgDocumentRepository,
                create_pool,
                init_schema,
            )

            pool = create_pool(settings.database_url)
            init_schema(pool)
            logger.info("Persistence: Postgres (DATABASE_URL).")
            return (
                PgDocumentRepository(pool),
                PgAuthRepository(pool),
                PgBillingRepository(pool),
                PgPricingRepository(pool),
                pool,
            )
        except Exception as exc:  # unreachable DB, missing driver, bad URL, …
            logger.warning(
                "DATABASE_URL is set but Postgres is unavailable (%s: %s) — "
                "falling back to file storage.",
                type(exc).__name__,
                exc,
            )
    return (
        FileDocumentRepository(settings.storage_dir),
        FileAuthRepository(settings.storage_dir),
        FileBillingRepository(settings.storage_dir),
        FilePricingRepository(settings.storage_dir),
        None,
    )


def _load_pricing(pricing_repo) -> PriceCatalog:
    """Materialize the versioned pricing seed and return the runtime catalog.

    A NEWER seed version overwrites the stored catalog ("edit the JSON,
    redeploy, it reflects"); an equal/older seed keeps the stored one (so a
    hot-fixed DB row isn't clobbered by a same-version boot). Any failure
    falls back to the seed in memory — pricing must never block boot.
    """
    seed = load_seed()
    try:
        stored = pricing_repo.load_catalog()
        if not stored or int(stored.get("version") or 0) < int(seed.get("version") or 0):
            pricing_repo.save_catalog(seed)
            stored = seed
        return PriceCatalog.from_dict(stored)
    except Exception as exc:
        logger.warning("Pricing catalog sync failed (%s) — using seed in memory.", exc)
        return PriceCatalog.from_dict(seed)


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()

    app = FastAPI(title="Noddle Board", version="0.1.0")

    # Railway's edge does not compress responses — the SPA bundle and board
    # JSON payloads need it. WebSocket routes are untouched by this middleware.
    app.add_middleware(GZipMiddleware, minimum_size=1024)

    # The frontend is served same-origin by this app, so CORS is only for local
    # dev tooling. Restrict to an explicit allowlist (env override) — never "*".
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.allowed_origins,
        allow_methods=["GET", "POST", "PUT", "DELETE"],
        allow_headers=["Content-Type"],
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

    # ---- composition root: wire the repository into the service -----------
    # Postgres when DATABASE_URL is set and reachable, else file adapters.
    repo, auth_repo, billing_repo, pricing_repo, pool = _build_repositories(settings)
    app.state.settings = settings
    app.state.db_pool = pool
    # DB-backed ledgers (2026-07-06 "no local files" rule): in Postgres mode the
    # audit log / activity / AI-usage ledger / games leaderboard persist to the
    # database, not to storage/ files. ``None`` in file-fallback mode ⇒ the
    # services keep their local-file behavior for offline dev.
    audit_store = activity_store = usage_store = notification_store = None
    ai_job_store = None
    if pool is not None:
        from app.infrastructure.pg_ledgers import (
            PgActivityStore,
            PgAIJobStore,
            PgAuditStore,
            PgLeaderboard,
            PgNotificationStore,
            PgUsageStore,
        )

        audit_store = PgAuditStore(pool)
        activity_store = PgActivityStore(pool)
        usage_store = PgUsageStore(pool)
        notification_store = PgNotificationStore(pool)
        ai_job_store = PgAIJobStore(pool)
        app.state.games_leaderboard = PgLeaderboard(pool)
    # Pricing baseline: the versioned seed JSON is materialized into storage at
    # boot; every token→USD→credit computation reads this catalog.
    app.state.pricing = _load_pricing(pricing_repo)
    app.state.document_service = DocumentService(repo)
    # Comment threads (M1) — the same adapter implements the comment port.
    app.state.comment_service = CommentService(repo)
    # Identity & access (ADR-0002): users/sessions/agent-tokens/teams.
    app.state.auth_service = AuthService(auth_repo)
    # Excalidraw-style anonymous mode (NODDLE_ANON=1): guests create boards,
    # anonymous boards live by their link_policy (see services.auth.can).
    set_anon_mode(settings.anon_mode)
    # Lemon Squeezy billing: subscriptions + webhook + entitlement. The LS
    # client is lazy — missing LEMONSQUEEZY_* config degrades to 503 at the
    # checkout endpoint, never a boot crash; entitlement checks always work
    # (unconfigured ⇒ everyone is free tier).
    app.state.billing_service = BillingService(
        billing_repo, app.state.auth_service, settings
    )
    # S3-compatible object storage (R2) — receives rotated log segments so the
    # volume is expendable. Unconfigured ⇒ disabled, everything stays local.
    object_storage = ObjectStorage(settings)
    app.state.object_storage = object_storage
    if object_storage.enabled:
        logger.info("Object storage: enabled (%s).", settings.s3_bucket)
    # Append-only audit log (#22): auth + doc lifecycle + sharing events.
    app.state.audit_service = AuditService(
        settings.storage_dir, object_storage, store=audit_store
    )
    # Last-active tracking (WS3): touched by the middleware below, throttled
    # in-memory so authenticated requests cost no extra disk I/O.
    app.state.activity_service = ActivityService(
        settings.storage_dir, store=activity_store
    )
    # Per-user 🔔 notification feed (share invites): DB-backed in Postgres mode,
    # file fallback for offline dev — never local files in production.
    app.state.notification_service = NotificationService(
        settings.storage_dir, store=notification_store
    )

    @app.middleware("http")
    async def _touch_activity(request, call_next):  # type: ignore[no-untyped-def]
        response = await call_next(request)
        # Best-effort, AFTER the response — activity tracking must never add
        # latency to (or break) a request. Session-cookie users only: agents
        # already get last_used_at on their token in principal_from_bearer.
        try:
            if request.url.path.startswith("/api/"):
                raw = request.cookies.get(SESSION_COOKIE)
                if raw:
                    p = app.state.auth_service.principal_from_session(raw)
                    if p.kind == "user" and p.user_id:
                        app.state.activity_service.touch(p.user_id)
        except Exception:  # noqa: BLE001 — telemetry only
            pass
        return response
    # AIService owns its Databricks (OpenAI-compatible) client lazily;
    # constructing it here never touches the network or requires
    # DATABRICKS_HOST/DATABRICKS_TOKEN at boot.
    app.state.ai_service = AIService()
    # Per-call token/cost accounting (append-only JSONL, like audit.log) —
    # records what each AI call actually consumed vs the flat ✦ charged.
    app.state.ai_usage = AIUsageLedger(
        settings.storage_dir, app.state.pricing, object_storage, store=usage_store
    )
    # Background image→board conversion queue: uploads become jobs a worker
    # pool converts in parallel; history (with the created board id) survives
    # page reloads. DB-backed records in Postgres mode, file fallback for dev.
    app.state.ai_jobs = AIJobService(
        settings.storage_dir,
        app.state.document_service,
        app.state.ai_service,
        store=ai_job_store,
    )

    # ---- routes -----------------------------------------------------------
    @app.get("/api/config")
    def _config() -> dict:
        """Frontend feature flags (anonymous mode drives the login gate)."""
        return {"anon": settings.anon_mode}

    @app.get("/api/health")
    def _health() -> dict:
        # Liveness only — never touches the DB (health ≠ DB readiness), so a
        # Postgres outage degrades features instead of cascading restarts.
        return {"status": "ok", "version": app.version}

    app.include_router(auth_router)  # /api/auth, /api/me, /api/tokens, /api/teams
    app.include_router(activity_router)  # /api/teams/{id}/audit, /api/me/activity
    app.include_router(documents_router)
    app.include_router(comments_router)  # /api/documents/{id}/comments
    app.include_router(mentions_router)  # /api/me/mentions (badge feed)
    app.include_router(notifications_router)  # /api/me/notifications (🔔 feed)
    app.include_router(folders_router)
    app.include_router(payments_router)  # /api/payments, /api/me/subscription
    app.include_router(ai_router)
    app.include_router(collab_router)  # WebSocket /ws/documents/{id}
    app.include_router(games_router)  # WebSocket /ws/games/{id} (Draw & Guess)
    app.include_router(trivia_router)  # WebSocket /ws/trivia/{id} (Team Trivia)
    app.include_router(wordbomb_router)  # WebSocket /ws/wordbomb/{id} (Word Bomb)

    # ---- serve the frontend (mount last so /api wins) ---------------------
    frontend = settings.frontend_path()
    if frontend is not None:
        # SPA fallback: share links are /d/{id} — deep links must serve the
        # SPA shell (client-side routing opens the document).
        index_html = frontend / "index.html"

        @app.get("/d/{doc_id}", response_class=FileResponse)
        def _spa_document(doc_id: str) -> FileResponse:  # noqa: ARG001
            return FileResponse(index_html)

        @app.get("/embed/{doc_id}", response_class=FileResponse)
        def _spa_embed(doc_id: str) -> FileResponse:  # noqa: ARG001
            """Read-only iframe view — the SPA hides all chrome for /embed/*.
            This route is exempt from the frame-ancestors lockdown below."""
            return FileResponse(index_html)

        @app.get("/play/{room_id}", response_class=FileResponse)
        def _spa_game(room_id: str) -> FileResponse:  # noqa: ARG001
            return FileResponse(index_html)

        @app.get("/play/{game_type}/{room_id}", response_class=FileResponse)
        def _spa_game_typed(game_type: str, room_id: str) -> FileResponse:  # noqa: ARG001
            return FileResponse(index_html)

        # Dashboard SPA pages — reloading these must serve the shell (StaticFiles
        # only auto-serves index.html for "/", not arbitrary client routes).
        @app.get("/templates", response_class=FileResponse)
        @app.get("/shared", response_class=FileResponse)
        @app.get("/games", response_class=FileResponse)
        @app.get("/settings", response_class=FileResponse)
        def _spa_dash() -> FileResponse:
            return FileResponse(index_html)

        @app.get("/folder/{folder_id}", response_class=FileResponse)
        def _spa_folder(folder_id: str) -> FileResponse:  # noqa: ARG001
            return FileResponse(index_html)

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
