# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**noddle** — open-source collaborative diagram board (React SPA + FastAPI),
with optional anonymous mode, live collaboration and a BYOK AI co-editor.

```
noddle/
├── backend/   FastAPI (clean architecture: api → services → domain,
│              infrastructure adapters: Postgres via psycopg OR plain files)
├── web/       React + TypeScript (Vite) SPA
├── mcp/       stdlib MCP server (agents edit boards via the REST API)
└── Dockerfile / docker-compose.yml   single-container deploy + postgres:16
```

## Run / build / test

```bash
# backend (from repo root)
python3 -m venv .venv && source .venv/bin/activate
pip install -r backend/requirements.txt          # + requirements-dev.txt for tests
cd backend && uvicorn main:app --reload --port 8000   # main.py is a shim → app.main:app

# frontend dev
cd web && npm install && npm run dev     # :5173, proxies /api → :8000
npm run typecheck && npm run build       # web/dist (served by the backend)

# tests (run from repo root; conftest.py adds backend/ to sys.path)
python -m pytest backend/tests -q        # in-memory file adapters by default
python -m pytest backend/tests/test_authz.py -q          # single file
python -m pytest backend/tests/test_authz.py::test_name   # single test
PG_TEST_DSN=postgres://... python -m pytest backend/tests -q   # exercise Pg adapters
```

There is no Python linter/formatter config checked in; match surrounding style.
`npm run typecheck` (`tsc --noEmit`) is the only frontend gate — there is no ESLint config.

## Architecture

### Backend layering (enforced by convention, not tooling)
- Dependency rule: `api → services → domain`. `infrastructure` implements
  domain **ports** (`domain/repository.py` — a `Protocol`); `domain` imports
  nothing outward. Services depend on the port, never on a concrete adapter.
- `create_app()` in `app/main.py` is the **composition root** — it is the only
  place that picks adapters and wires them into services via `app.state.*`,
  injected into handlers with FastAPI `Depends`.
- **Never crash at boot.** `_build_repositories` tries Postgres when
  `DATABASE_URL` is set and reachable, else falls back to file adapters with a
  warning. Missing AI/billing/storage config degrades the *feature* to a 503 at
  its endpoint — it must not fail startup. Pricing likewise falls back to the
  in-memory seed.
- **All persistence comes from one backend.** Document/auth/billing/pricing
  repos + the DB-backed "ledgers" (audit, activity, AI-usage, notifications,
  AI-jobs, games leaderboard) are all Postgres *or* all file — never mixed, so
  ACLs and subscriptions reference the same user store. The `pg_ledgers.py`
  stores are `None` in file mode (services keep local-file behavior for dev).

### Feature surface (each has an `app/api/*` router + `app/services/*`)
auth (users/sessions/agent-tokens/teams, OIDC via `services/oidc.py`) ·
documents + folders · comments + `@mentions` · notifications (🔔 feed) ·
activity + append-only audit log · payments/billing (Lemon Squeezy webhook +
entitlement) · AI (`services/ai.py`, Databricks OpenAI-compatible client, lazy)
+ AI jobs (background image→board queue) + AI-usage ledger · collab (WebSocket
`/ws/documents/{id}`) · games (WebSocket `/ws/games`, `/ws/trivia`,
`/ws/wordbomb`). Object storage (`services/object_storage.py`, S3/R2) receives
rotated log segments so the volume is expendable.

### Frontend
- `editor-core/` is **pure TS** (no React/DOM): selection, transform, camera,
  history, serialize, plus `editor-core/diagram/` (geometry, orthogonal edge
  routing, perimeters, mermaid, shape defs). Keep it framework-free.
- Features under `features/*` never import another feature's internals —
  cross-feature communication goes through the Zustand stores in `state/`
  (`diagramStore`, `collabStore`, `authStore`, `commentsStore`, `gameStore`, …).
- `shared/` holds the API client, UI primitives and utils.

### MCP
`mcp/noddle_mcp.py` is a stdlib (no-deps) MCP server; agents mutate boards
purely through the REST API using an agent token.

## Hard rules

- Sanitize before store/display: ALL SVG passes `security/svg_sanitizer.py`
  (`sanitize_svg`); untrusted strings are `esc()`'d before touching innerHTML.
- Document ids are `uuid4().hex[:12]`, validated `^[0-9a-f]{12}$` (keep it).
  See `domain/ids.py`.
- File writes go through `infrastructure/atomic.py:atomic_write_text`.
- Anonymous mode (`NODDLE_ANON=1`): guests create boards; anonymous boards
  carry `link_policy="edit"` — the URL is the capability. See `services/auth.py`
  (`set_anon_mode`, `can()`).
- Single instance only: collab/game rooms are in-memory — never scale replicas.
- `GET /api/health` is liveness only and never touches the DB. `GET /api/config`
  exposes frontend feature flags (currently `anon`).
- Framing: only `/embed/{id}` is iframe-able (`frame-ancestors *`); every other
  HTML response is locked to same-origin. New public-embed routes must opt in.
- SPA deep-link routes (`/d/{id}`, `/embed/{id}`, `/play/*`, `/folder/{id}`,
  dashboard pages) are enumerated in `app/main.py` to serve the SPA shell — add
  new client routes there or a reload 404s.
