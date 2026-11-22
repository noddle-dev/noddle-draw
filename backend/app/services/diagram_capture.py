"""Offline, bounded PNG rendering via the editor's own React bundle + Chromium.

No credentials or live app are loaded into the browser. CSP forbids networking,
and the only user data is an escaped JSON script (React encodes SVG attributes).
The social-card renderer deliberately cannot be used for visual validation.
"""
from __future__ import annotations

import html
import json
import os
import re
import signal
import shutil
import subprocess
import tempfile
import threading
from pathlib import Path

from app.config import REPO_ROOT

_SLOTS = threading.BoundedSemaphore(1)
_MAX_OUTPUT = 16 * 1024 * 1024


class CaptureUnavailable(Exception):
    pass


def capture_diagram(page: dict) -> dict:
    browser = shutil.which("chromium") or shutil.which("chromium-browser")
    if browser is None:
        mac = Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
        browser = str(mac) if mac.exists() else None
    bundle = REPO_ROOT / "web" / "dist" / "capture.js"
    if not browser or not bundle.is_file():
        raise CaptureUnavailable("PNG capture is unavailable: browser or editor capture bundle is missing.")
    if not _SLOTS.acquire(blocking=False):
        raise CaptureUnavailable("PNG capture is busy. Retry shortly.")
    try:
        with tempfile.TemporaryDirectory(prefix="noddle-capture-") as directory:
            root = Path(directory)
            payload = json.dumps(page, allow_nan=False).replace("<", "\\u003c")
            # Copy the trusted bundle into the temporary profile's directory.
            shutil.copyfile(bundle, root / "capture.js")
            source = root / "capture.html"
            source.write_text(
                '<!doctype html><meta charset="utf-8">'
                '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; '
                'script-src \'self\'; img-src data: blob:; style-src \'unsafe-inline\'; font-src data:; connect-src \'none\'">'
                '<div id="root"></div><pre id="capture-result"></pre>'
                f'<script type="application/json" id="capture-data">{payload}</script>'
                '<script src="capture.js"></script>', encoding="utf-8",
            )
            # Sandbox is unavailable on the production container platform. The
            # browser receives no secrets; CSP blocks user scripts and network I/O.
            proc = subprocess.Popen([
                browser, "--headless", "--no-sandbox", "--disable-gpu",
                "--disable-dev-shm-usage", "--disable-background-networking",
                "--disable-extensions", "--no-first-run", "--no-default-browser-check",
                "--allow-file-access-from-files", "--disable-breakpad",
                "--host-resolver-rules=MAP * ~NOTFOUND",
                f"--user-data-dir={root / 'profile'}", "--virtual-time-budget=5000",
                "--dump-dom", source.as_uri(),
            ], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True)
            try:
                output, _ = proc.communicate(timeout=25)
            except subprocess.TimeoutExpired:
                # Kill renderer children too; otherwise repeated timeouts could
                # leave Chromium processes outside the capture concurrency cap.
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                proc.communicate()
                raise
            if proc.returncode or len(output) > _MAX_OUTPUT:
                raise CaptureUnavailable("PNG capture failed. Retry shortly.")
            match = re.search(rb'<pre id="capture-result">(.*?)</pre>', output, re.DOTALL)
            result = json.loads(html.unescape(match[1].decode())) if match else {}
            if not result.get("png_base64"):
                raise CaptureUnavailable("PNG capture failed; visual validation is incomplete.")
            return result
    except (subprocess.TimeoutExpired, OSError, ValueError) as exc:
        raise CaptureUnavailable("PNG capture failed; visual validation is incomplete.") from exc
    finally:
        _SLOTS.release()
