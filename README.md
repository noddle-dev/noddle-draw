# ◇ noddle

**Open-source collaborative diagram board** — structured shapes and smart
connectors like Lucidchart, instant no-login drawing and link-sharing like
Excalidraw, plus an optional AI co-editor that edits the board with you
(bring your own API key).

- 🎨 **Real diagramming** — flowchart shapes, orthogonal auto-routed arrows
  (A\* elbow routing with draggable waypoints), containers, multi-page boards,
  stencil libraries, text wrap, align/distribute, full keyboard shortcuts.
- 👥 **Live collaboration** — shared cursors, presence, per-page state sync
  over WebSocket. Share a link, draw together. Comments with @mentions.
- ⚡ **Draw without an account** — in anonymous mode (default in this compose
  setup) the board URL is the sharing capability, Excalidraw-style. Accounts,
  teams and private boards are one env var away (`NODDLE_ANON=0`).
- ✦ **AI co-editor (optional, BYOK)** — chat with the board: "add an
  error-handling branch", "group these by tier", image→diagram conversion
  (sketch/whiteboard photo → editable shapes), text/Mermaid→diagram. Works
  with your own Anthropic / OpenAI / Gemini / OpenRouter key; without a key
  the AI simply stays off.
- 📤 **Export** — SVG, PNG, animated GIF, per-page deck PNGs, Mermaid, and a
  re-importable board JSON. Imports draw.io files.
- 🧩 **Agent-friendly** — a small [MCP server](mcp/) lets AI agents create and
  edit boards through the REST API with their own identity.

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
| `NODDLE_ANON` | `1` = draw without accounts (boards are link-shared). `0` = accounts required, boards private by default. |
| `DATABASE_URL` | Postgres persistence (schema auto-migrates at boot). Absent → file storage. |
| `OIDC_ISSUER` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | SSO via any OIDC provider (Google, Keycloak, Entra…). |
| `DATABRICKS_*` | Optional server-side AI pool. Most self-hosters skip this — users bring their own AI key in Settings instead. |
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

Anonymous boards are protected by unguessable URLs (capability links) — same
model as Excalidraw share links. Accounts mode adds ownership, share roles
(viewer/editor), teams, and private-by-default boards. Uploaded and
AI-generated SVG is sanitized server-side (scripts, event handlers and foreign
objects stripped). Agent tokens are stored as SHA-256.

## License

[MIT](LICENSE)
