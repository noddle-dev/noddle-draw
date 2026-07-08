"""Size-based rotation for the append-only JSONL files (audit.log, ai_usage.jsonl).

Without a cap the two ledgers grow unbounded on the storage volume. At the cap
the live file is renamed to ``{name}.{utc-stamp}`` and a fresh one starts;
the rotated segment is shipped to object storage (R2) when configured — that
is what makes the volume expendable — and only the newest ``keep`` segments
stay local. Uploads run on a daemon thread: rotation happens inside request
handling and a 10MB PUT must not stall a save.
"""
from __future__ import annotations

import logging
import threading
import time
from pathlib import Path

from app.services.object_storage import ObjectStorage

logger = logging.getLogger("noddle")

MAX_LOG_BYTES = 10 * 1024 * 1024  # rotate at 10MB
KEEP_LOCAL_SEGMENTS = 3


def rotate_if_needed(
    path: Path,
    storage: ObjectStorage | None,
    remote_prefix: str = "logs",
    max_bytes: int = MAX_LOG_BYTES,
    keep: int = KEEP_LOCAL_SEGMENTS,
) -> None:
    """Rotate ``path`` when it exceeds ``max_bytes``. Never raises — callers
    are append paths that must not fail the request. Call under the caller's
    write lock (a concurrent second rename simply fails and is swallowed)."""
    try:
        if not path.exists() or path.stat().st_size < max_bytes:
            return
        stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
        rotated = path.with_name(f"{path.name}.{stamp}")
        path.rename(rotated)
        logger.info("Rotated %s -> %s", path.name, rotated.name)

        if storage is not None and storage.enabled:
            def _ship() -> None:
                try:
                    data = rotated.read_bytes()
                    storage.put_object(
                        f"{remote_prefix}/{rotated.name}", data, "application/x-ndjson"
                    )
                except OSError as e:  # pragma: no cover
                    logger.warning("Log segment upload failed: %s", e)

            threading.Thread(target=_ship, daemon=True).start()

        # Prune the oldest local segments (stamps sort lexicographically).
        segments = sorted(path.parent.glob(f"{path.name}.2*"))
        for old in segments[:-keep]:
            old.unlink(missing_ok=True)
    except OSError as e:
        logger.warning("Log rotation for %s failed: %s", path.name, e)
