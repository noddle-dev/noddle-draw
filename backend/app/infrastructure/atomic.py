"""Atomic file writes for the file-backed adapters.

A plain ``Path.write_text`` truncates first and writes after — a crash (or a
full disk) in between leaves a corrupt/empty file, and ``index.json`` /
``auth.json`` corruption loses the whole store. Writing to a unique temp file
in the SAME directory and ``os.replace``-ing it over the target is atomic on
POSIX and Windows: readers see either the old or the new content, never a
partial one.
"""
from __future__ import annotations

import os
import tempfile
from pathlib import Path


def atomic_write_text(path: Path, text: str) -> None:
    """Write ``text`` to ``path`` atomically (tmp file + rename).

    The temp file lives next to the target so ``os.replace`` never crosses a
    filesystem boundary (rename would stop being atomic). fsync before the
    rename so the data survives a power loss, not just a process crash.
    """
    path = Path(path)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
