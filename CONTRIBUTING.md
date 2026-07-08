# Contributing to noddle

Thanks for helping! The short version:

## Dev setup

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r backend/requirements.txt
cd backend && uvicorn main:app --reload --port 8000   # API on :8000
cd web && npm install && npm run dev                  # SPA on :5173
```

## Before you open a PR

- `python -m pytest backend/tests -q` — backend tests must pass.
- `cd web && npm run typecheck && npm run build` — no TS errors.
- Respect the layering: `api → services → domain` on the backend
  (`domain` imports nothing outward); on the frontend `editor-core`
  imports no React/DOM, and features talk to each other only through
  the stores in `web/src/state/`.
- Every uploaded/generated SVG must pass through the sanitizer
  (`backend/app/security/svg_sanitizer.py`) before storage or display.

## Reporting bugs

Open an issue with steps to reproduce and, for editor bugs, a board JSON
export if you can (Export → Board JSON).
