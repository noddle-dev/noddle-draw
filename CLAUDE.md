# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**noddle** — open-source ANONYMOUS diagram board (React SPA + FastAPI), live at
draw.noddle.dev. Excalidraw model: no accounts, no login — visiting `/` opens
your most recent board (or mints one); the board URL is the sharing
capability. Live collaboration, anonymous comments, and a BYOK AI co-editor
whose key lives client-side.

```
noddle/
├── backend/   FastAPI (clean architecture: api → services → domain,
│              infrastructure adapters: Postgres via psycopg OR plain files)
├── web/       React + TypeScript (Vite) SPA
├── mcp/       stdlib MCP server (agents edit boards via the REST API, no tokens)
└── Dockerfile / docker-compose.yml   single-container deploy + postgres:16
```

## Run / build / test

```bash
# backend (from repo root)
python3 -m venv .venv && source .venv/bin/activate   # needs Python ≥3.10
pip install -r backend/requirements.txt              # + requirements-dev.txt for tests
cd backend && uvicorn main:app --reload --port 8000  # main.py is a shim → app.main:app

# frontend dev
cd web && npm install && npm run dev     # :5173, proxies /api → :8000
npm run typecheck && npm run build       # web/dist (served by the backend)

# tests (run from repo root; conftest.py adds backend/ to sys.path)
python -m pytest backend/tests -q        # in-memory file adapters by default
python -m pytest backend/tests/test_authz.py::test_edit_policy_grants_view_and_edit
PG_TEST_DSN=postgres://... python -m pytest backend/tests -q   # exercise Pg adapters
```

There is no Python linter/formatter config checked in; match surrounding style.
`npm run typecheck` (`tsc --noEmit`) is the only frontend gate — there is no ESLint config.

## Architecture

### Access model (the whole story)
- No users, sessions, teams or billing. `services/auth.py` is ~50 lines:
  a frozen guest `Principal` (+ `GUEST` singleton, used for audit/presence) and
  `can(action, meta)` — `link_policy "edit"` ⇒ view+edit, `"view"` ⇒ view,
  anything else (legacy `"private"` rows) ⇒ denied. `owner_id` survives on
  `DocumentMeta` only to read old rows; it grants nothing.
- Every board created through the API is `link_policy="edit"` — the URL is the
  capability. There is NO board listing endpoint (link access ≠ discovery),
  no DELETE, no policy toggle: nobody is more trusted than anyone else with
  the link. Recents live in the browser (`noddle.lastBoardId`,
  `noddle.recentBoards` in localStorage).
- Client identity is auto-generated into `localStorage["noddle-user"]`
  (`collabStore.getIdentity()`), renameable in the Share dialog; it rides
  collab `hello`, comments (`guest_name`/`guest_color`) and save attribution
  (`SaveBody.author_name`).

### Backend layering (enforced by convention, not tooling)
- Dependency rule: `api → services → domain`. `infrastructure` implements
  domain **ports** (`domain/repository.py`); `domain` imports nothing outward.
- `create_app()` in `app/main.py` is the **composition root** — the only place
  that picks adapters and wires services into `app.state.*`.
- **Never crash at boot.** `_build_repositories` tries Postgres when
  `DATABASE_URL` is set and reachable, else file adapters with a warning.
  Missing AI config degrades the endpoint to 503, never a boot failure.
- Postgres mode also wires the DB-backed ledgers (`pg_ledgers.py`):
  `PgAuditStore` (ops audit log) + `PgAIJobStore` (AI job history). Tables
  from the old accounts build are left untouched but no longer created.

### AI / BYOK (client-side keys)
- BYOK is PER-REQUEST: the browser keeps `{provider,key,model,base}` in
  `localStorage["noddle.aiKey"]` and sends `X-AI-Provider/X-AI-Key/X-AI-Model/
  X-AI-Base` headers; `api/ai.py::_resolve_backend` validates them
  (provider ∈ `AI_PROVIDERS` in `services/ai.py`; `custom` needs `X-AI-Base`).
  No key → shared Databricks pool when `AIService.pool_available()` → else 503.
  The server never stores or logs the key. New AI headers must also be added
  to CORS `allow_headers` in `main.py`.
- Background image→board jobs are bucketed by `X-Client-Id` (an opaque UUID in
  `localStorage["noddle.clientId"]`); finished jobs create ordinary anonymous
  boards. `GET /api/config` → `{"pool_ai": bool}` drives the frontend's
  backend picker (`features/ai/BackendSelect` + `AiKeySettings`).

### Frontend
- `editor-core/` is **pure TS** (no React/DOM): selection, transform, camera,
  history, serialize, plus `editor-core/diagram/` (geometry, orthogonal edge
  routing, perimeters, mermaid, shape defs). Keep it framework-free.
- Two views only (`appStore.view`): `editor` and `generate`. `applyLocation()`
  maps URLs — `/d/{id}`, `/embed/{id}`, `/generate`, everything else →
  `bootHome()` (reopen `noddle.lastBoardId` or `api.create` a fresh board,
  with `history.replaceState`). `editorStore.openDoc` heals a stale
  lastBoardId by minting a new board; a foreign dead link shows the
  `notFound` screen.
- Features under `features/*` never import another feature's internals —
  cross-feature communication goes through the Zustand stores in `state/`.
  `shared/` holds the API client (incl. BYOK/localStorage helpers), UI
  primitives and utils.

## Hard rules

- **English only.** This is a public OSS repo: all code, comments, docstrings,
  UI strings, commit messages and docs are written in English — no Vietnamese
  (or any other language). Don't hardcode locales in date/number formatting
  (`toLocaleString(undefined, …)`, never `"vi-VN"`).

- Sanitize before store/display: ALL SVG passes `security/svg_sanitizer.py`
  (`sanitize_svg`); untrusted strings are `esc()`'d before touching innerHTML.
- Document ids are `uuid4().hex[:12]`, validated `^[0-9a-f]{12}$` (keep it).
  See `domain/ids.py`.
- File writes go through `infrastructure/atomic.py:atomic_write_text`.
- Single instance only: collab rooms are in-memory — never scale replicas.
- `GET /api/health` is liveness only and never touches the DB.
- Never log request headers around the AI routes (they carry raw BYOK keys).
- Framing: only `/embed/{id}` is iframe-able (`frame-ancestors *`); every other
  HTML response is locked to same-origin.
- SPA deep-link routes (`/d/{id}`, `/embed/{id}`, `/generate`) are enumerated
  in `app/main.py` to serve the SPA shell — add new client routes there or a
  reload 404s.
