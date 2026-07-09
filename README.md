# ◇ noddle

**Open-source anonymous diagram board** — structured shapes and smart
connectors like Lucidchart, instant no-login drawing and link-sharing like
Excalidraw, plus an optional AI co-editor that edits the board with you
(bring your own API key). Live at **draw.noddle.dev**.

- ⚡ **Zero friction** — open the site, you're drawing. No accounts, no
  workspaces: your identity lives in your browser and the board URL is the
  sharing capability (Excalidraw-style). `/` reopens the board you were
  working on.
- 🎨 **Real diagramming** — flowchart shapes, orthogonal auto-routed arrows
  (A\* elbow routing with draggable waypoints), containers, multi-page boards,
  stencil libraries, text wrap, align/distribute, full keyboard shortcuts.
- 👥 **Live collaboration** — shared cursors, presence, per-page state sync
  over WebSocket. Share a link, draw together. Anonymous comment threads.
- ✦ **AI co-editor (optional, BYOK)** — chat with the board: "add an
  error-handling branch", "group these by tier", image→diagram conversion
  (sketch/whiteboard photo → editable shapes), text/Mermaid→diagram. Your
  Anthropic / OpenAI / Gemini / OpenRouter key stays in your browser and rides
  each request — the server never stores it. Without a key the AI simply
  stays off (or self-hosters can configure a shared Databricks pool).
- 📤 **Export** — SVG, PNG, animated GIF, per-page deck PNGs, Mermaid, and a
  re-importable board JSON. Imports draw.io files.
- 🧩 **Agent-friendly** — a small [MCP server](mcp/) lets AI agents create and
  edit boards through the REST API (the board URL is the capability — no
  tokens needed).

## Quick start

```bash
docker compose up --build
# → http://localhost:8000  — start drawing, no sign-up
```

That's it: one container (FastAPI + prebuilt React SPA) plus Postgres.
Without Docker:

```bash
# backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r backend/requirements.txt
cd backend && uvicorn main:app --reload --port 8000

# frontend (dev server with hot reload, proxies /api → :8000)
cd web && npm install && npm run dev   # → http://localhost:5173
```

No database needed for local hacking — without `DATABASE_URL` everything
persists to `backend/storage/` files.

## Configuration

Everything is optional; the app degrades gracefully when a feature isn't
configured. Copy `.env.example` to `.env` and fill in what you need:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres persistence (schema auto-migrates at boot). Absent → file storage. |
| `NODDLE_ALLOWED_ORIGINS` | CORS allowlist for dev tooling (prod is same-origin). |
| `DATABRICKS_*` | Optional shared server AI pool. Most self-hosters skip this — users bring their own AI key in the app instead. |
| `S3_*` | Optional S3-compatible object storage for log shipping/backups. |

## Architecture (short version)

Single deployable, clean layering:

- `backend/` — FastAPI, hexagonal: `api → services → domain`, with
  `infrastructure/` adapters (Postgres via psycopg, or plain files — chosen at
  boot). WebSocket rooms for live collab. Whitelist SVG sanitizer on every
  stored/generated SVG.
- `web/` — React + TypeScript (Vite). The editor engine (`editor-core/`) is
  pure TypeScript with no React/DOM dependencies; state is Zustand; features
  are vertical slices.
- `mcp/` — stdlib-only MCP server for AI agents.

Run the tests: `python -m pytest backend/tests -q` and `cd web && npm run typecheck`.

## Security notes

Boards are protected by unguessable URLs (capability links) — the same model
as Excalidraw share links: anyone with a board's link can view and co-edit it,
so treat the link as the secret it is. Uploaded and AI-generated SVG is
sanitized server-side (scripts, event handlers and foreign objects stripped).
BYOK AI keys live only in the browser's localStorage and transit per-request
over HTTPS; the server neither stores nor logs them.

### Upgrading from the accounts-era build

Older deployments (with users/teams/billing) keep their extra tables — this
build simply stops using them. To make pre-existing boards reachable under the
anonymous model, run once against your database:

```sql
UPDATE documents SET owner_id = NULL;
UPDATE documents SET link_policy = 'edit' WHERE link_policy = 'private';
```

(Skip the second statement if some boards must stay dark.) Optional cleanup of
dead tables: `DROP TABLE users, sessions, tokens, teams, team_members,
ai_settings, subscriptions, ls_webhook_events, billing_events,
pricing_catalog, folders, document_shares, mentions, user_activity, ai_usage,
games_leaderboard, notifications;`

## License

[MIT](LICENSE)
