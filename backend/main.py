"""Thin shim so ``uvicorn main:app`` keeps working after the modular refactor.

The real application lives in the ``app`` package (see ``app/main.py``).
"""
from __future__ import annotations

from app.main import app  # noqa: F401  (re-exported for uvicorn main:app)

if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app.main:app", host="127.0.0.1", port=8000, reload=True)
