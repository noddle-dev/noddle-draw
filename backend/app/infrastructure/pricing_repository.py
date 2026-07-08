"""File-backed implementation of the PricingRepository port.

Layout under the storage dir:
    pricing.json    the whole materialized catalog dict (version, credit_usd,
                    models[]) — the file-storage twin of the Postgres
                    ``pricing_catalog`` row.
"""
from __future__ import annotations

import json
import threading
from pathlib import Path

from app.infrastructure.atomic import atomic_write_text


class FilePricingRepository:
    def __init__(self, storage_dir: Path) -> None:
        self._path = Path(storage_dir) / "pricing.json"
        self._lock = threading.Lock()

    def load_catalog(self) -> dict | None:
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
        except (FileNotFoundError, ValueError, OSError):
            return None
        return data if isinstance(data, dict) else None

    def save_catalog(self, data: dict) -> None:
        with self._lock:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            atomic_write_text(
                self._path, json.dumps(data, indent=2, sort_keys=True)
            )
