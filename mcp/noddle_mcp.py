#!/usr/bin/env python3
"""noddle draw MCP server — boards as MCP tools, resources and prompts.

Stdlib-only (urllib + json), stdio transport: one JSON-RPC 2.0 message per
line on stdin/stdout; logs go to STDERR only. A thin wrapper over the noddle
REST API.

Access model: noddle draw is anonymous (Excalidraw-style). There are no
accounts and no tokens — a board's id (12 hex chars) or URL IS the
capability. The agent works on any board it is given, signs its comments and
version snapshots with NODDLE_AGENT_NAME, and can only see boards it was told
about or created itself (there is no board listing in the API).

Protocol: dual-era per the MCP spec "Versioning and Compatibility" page.
  * modern  2026-07-28 — stateless; every request carries
    ``_meta["io.modelcontextprotocol/protocolVersion"]`` + clientCapabilities;
    ``server/discover`` advertises versions/capabilities.
  * legacy  2025-11-25 / 2025-06-18 / 2025-03-26 / 2024-11-05 — the
    ``initialize`` handshake, scoped to this stdio process.

Env:
  NODDLE_BASE_URL    default https://draw.noddle.dev (self-hosted: http://127.0.0.1:8000)
  NODDLE_AGENT_NAME  display name on comments / version history (default "MCP agent")
  NODDLE_TIMEOUT     HTTP timeout in seconds for board calls (default 30)
  NODDLE_AI_TIMEOUT  HTTP timeout for generate_diagram (default 180)
  NODDLE_AI_PROVIDER + NODDLE_AI_KEY (optional NODDLE_AI_MODEL, NODDLE_AI_BASE)
                     bring-your-own AI key for generate_diagram, forwarded as the
                     X-AI-* headers the web app uses. Unset ⇒ the server's
                     shared pool, if the instance has one.

Exit codes: 0 = stdin closed (normal shutdown), 2 = bad configuration.
"""
from __future__ import annotations

import base64
import json
import os
import re
import sys
import threading
import traceback
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional, Tuple

__version__ = "1.0.0"

DEFAULT_BASE_URL = "https://draw.noddle.dev"

SERVER_INFO = {
    "name": "noddle",
    "title": "noddle draw",
    "version": __version__,
    "description": "Read, create and edit noddle draw diagram boards and their comments.",
    "websiteUrl": DEFAULT_BASE_URL,
}
INSTRUCTIONS = (
    "noddle boards are editable diagrams: {pages:[{id,name,nodes,edges}]}. Boards are "
    "anonymous: a board id (12 hex chars) or its URL ({base}/d/{id}) is all you need, and "
    "anyone holding the link can open it. Read with get_board, edit the JSON, then write the "
    "WHOLE diagram back with update_board (pass expected_updated_at from get_board to avoid "
    "clobbering a collaborator). For a styled first draft from prose or Mermaid use "
    "generate_diagram, then create_board/update_board. Never send customer PII, credentials "
    "or account numbers through these tools."
)

MODERN_VERSIONS = ("2026-07-28",)
LEGACY_VERSIONS = ("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05")
META_VERSION = "io.modelcontextprotocol/protocolVersion"
META_CLIENT_CAPS = "io.modelcontextprotocol/clientCapabilities"
META_SERVER_INFO = "io.modelcontextprotocol/serverInfo"

CAPABILITIES = {"tools": {}, "resources": {}, "prompts": {}}

# JSON-RPC / MCP error codes
PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603
UNSUPPORTED_PROTOCOL_VERSION = -32022

# Board ids are uuid4().hex[:12] — mirror the server's validator so an
# agent-supplied id can't smuggle path traversal / query chars into a URL.
DOC_ID_RE = re.compile(r"^[0-9a-f]{12}$")
BOARD_URL_RE = re.compile(r"^(https?://[^/?#\s]+)(?:/[^?#\s]*)?/(?:d|embed)/([0-9a-f]{12})(?:[/?#]\S*)?$")
SAFE_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")
BOARD_URI_RE = re.compile(r"^noddle://board/([0-9a-f]{12})$")
MAX_BODY = 25 * 1024 * 1024
PAGE_SIZE = 100

_log_lock = threading.Lock()


def log(msg: str) -> None:
    """STDERR only — stdout is the protocol channel."""
    with _log_lock:
        sys.stderr.write(f"[noddle-mcp] {redact(msg)}\n")
        sys.stderr.flush()


# ---- configuration ------------------------------------------------------------


class Config:
    def __init__(self, env: Optional[Dict[str, str]] = None) -> None:
        env = os.environ if env is None else env
        self.base_url = (env.get("NODDLE_BASE_URL") or DEFAULT_BASE_URL).strip().rstrip("/")
        self.agent_name = ((env.get("NODDLE_AGENT_NAME") or "").strip() or "MCP agent")[:40]
        self.timeout = _float_env(env, "NODDLE_TIMEOUT", 30.0)
        self.ai_timeout = _float_env(env, "NODDLE_AI_TIMEOUT", 180.0)
        self.ai_provider = (env.get("NODDLE_AI_PROVIDER") or "").strip().lower()
        self.ai_key = (env.get("NODDLE_AI_KEY") or "").strip()
        self.ai_model = (env.get("NODDLE_AI_MODEL") or "").strip()
        self.ai_base = (env.get("NODDLE_AI_BASE") or "").strip()

    def problems(self) -> List[str]:
        parts = urllib.parse.urlsplit(self.base_url)
        if parts.scheme not in ("http", "https") or not parts.netloc:
            return [f"NODDLE_BASE_URL must be an http(s) origin, got {self.base_url!r}"]
        return []

    def warnings(self) -> List[str]:
        out = []
        if self.ai_key and not self.ai_provider:
            out.append("NODDLE_AI_KEY is set without NODDLE_AI_PROVIDER — generate_diagram "
                       "will be rejected by the server.")
        parts = urllib.parse.urlsplit(self.base_url)
        if self.ai_key and parts.scheme == "http" and parts.hostname not in ("127.0.0.1", "localhost", "::1"):
            out.append("NODDLE_BASE_URL is plain http on a non-loopback host — your AI key "
                       "travels in cleartext.")
        return out

    def ai_headers(self) -> Dict[str, str]:
        if not self.ai_key:
            return {}
        h = {"X-AI-Key": self.ai_key}
        if self.ai_provider:
            h["X-AI-Provider"] = self.ai_provider
        if self.ai_model:
            h["X-AI-Model"] = self.ai_model
        if self.ai_base:
            h["X-AI-Base"] = self.ai_base
        return h


def _float_env(env: Dict[str, str], key: str, default: float) -> float:
    try:
        v = float(env.get(key, default))
        return v if v > 0 else default
    except (TypeError, ValueError):
        return default


CONFIG = Config()


def redact(text: str) -> str:
    """Never let a BYOK AI key reach a log line or a tool result."""
    if CONFIG.ai_key and len(CONFIG.ai_key) >= 4:
        text = text.replace(CONFIG.ai_key, "[redacted]")
    return text


# ---- noddle REST client --------------------------------------------------------


class ApiError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


class _SameOriginRedirects(urllib.request.HTTPRedirectHandler):
    """urllib forwards custom headers (the X-AI-Key) on redirects — refuse
    cross-origin hops."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D401
        a, b = urllib.parse.urlsplit(req.full_url), urllib.parse.urlsplit(newurl)
        if (a.scheme, a.netloc) != (b.scheme, b.netloc):
            return None  # → HTTPError with the 3xx code
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_OPENER = urllib.request.build_opener(_SameOriginRedirects)

_STATUS_HINTS = {
    400: "the server rejected this input",
    403: "forbidden — this board's link is view-only",
    404: "not found — check the board id (boards are reachable by id/URL only)",
    413: "payload too large",
    422: "the server could not use this input/output",
    429: "rate limited — the free shared AI tier allows only a few requests; set NODDLE_AI_KEY",
    503: "service unavailable — no AI backend (set NODDLE_AI_PROVIDER + NODDLE_AI_KEY) or the "
         "shared quota is used up",
}


def api(method: str, path: str, payload: Any = None, timeout: Optional[float] = None,
        headers: Optional[Dict[str, str]] = None) -> Any:
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    h = {"Accept": "application/json", "User-Agent": f"noddle-mcp/{__version__}"}
    if data is not None:
        h["Content-Type"] = "application/json"
    h.update(headers or {})
    req = urllib.request.Request(CONFIG.base_url + path, method=method, headers=h, data=data)
    try:
        with _OPENER.open(req, timeout=timeout or CONFIG.timeout) as res:
            raw = res.read(MAX_BODY + 1)
    except urllib.error.HTTPError as e:
        raise ApiError(e.code, _http_error_text(e)) from None
    except urllib.error.URLError as e:
        raise ApiError(0, f"noddle did not respond at {CONFIG.base_url}: {e.reason}") from None
    except (TimeoutError, OSError) as e:  # socket.timeout is an OSError
        raise ApiError(0, f"noddle request timed out or failed at {CONFIG.base_url}: {e}") from None
    if len(raw) > MAX_BODY:
        raise ApiError(0, "noddle response exceeded the 25MB safety cap")
    if not raw.strip():
        return {}
    try:
        return json.loads(raw.decode("utf-8"))
    except ValueError:
        raise ApiError(0, "noddle returned a non-JSON response") from None


def _http_error_text(e: urllib.error.HTTPError) -> str:
    if 300 <= e.code < 400:
        return (f"noddle API {e.code}: refused a cross-origin redirect — set NODDLE_BASE_URL "
                "to the final origin")
    try:
        body = e.read(4096)
    except Exception:  # noqa: BLE001
        body = b""
    return format_api_error(e.code, body)


def format_api_error(code: int, body: bytes) -> str:
    detail = ""
    try:
        parsed = json.loads(body[:4096].decode("utf-8", "replace"))
        d = parsed.get("detail") if isinstance(parsed, dict) else parsed
        if isinstance(d, dict):
            d = d.get("message") or d.get("error") or json.dumps(d)
        detail = d if isinstance(d, str) else json.dumps(d)
    except Exception:  # noqa: BLE001 — best-effort detail only
        detail = ""
    msg = f"noddle API {code}: {_STATUS_HINTS.get(code, 'request failed')}"
    if detail:
        msg += f" — {detail[:300]}"
    return redact(msg)


class Backend:
    """How the tools reach noddle. Subclasses implement ``call``.

    ``call(method, path, payload=None, timeout=None, headers=None)`` performs
    one noddle REST call (path like ``/api/documents/{id}``) and returns the
    parsed JSON, or raises ``ApiError(status, message)``."""

    base_url = DEFAULT_BASE_URL
    agent_name = "MCP agent"
    ai_timeout: Optional[float] = None

    def call(self, method: str, path: str, payload: Any = None, timeout: Optional[float] = None,
             headers: Optional[Dict[str, str]] = None) -> Any:  # pragma: no cover - abstract
        raise NotImplementedError

    def ai_headers(self) -> Dict[str, str]:
        return {}

    def board_url(self, doc_id: str) -> str:
        return f"{self.base_url}/d/{doc_id}"


class RestBackend(Backend):
    """stdio transport: urllib → ``CONFIG.base_url``, no authentication."""

    @property
    def base_url(self) -> str:  # type: ignore[override]
        return CONFIG.base_url

    @property
    def agent_name(self) -> str:  # type: ignore[override]
        return CONFIG.agent_name

    @property
    def ai_timeout(self) -> Optional[float]:  # type: ignore[override]
        return CONFIG.ai_timeout

    def ai_headers(self) -> Dict[str, str]:
        return CONFIG.ai_headers()

    def call(self, method: str, path: str, payload: Any = None, timeout: Optional[float] = None,
             headers: Optional[Dict[str, str]] = None) -> Any:
        return api(method, path, payload, timeout, headers)


REST = RestBackend()


def board_uri(doc_id: str) -> str:
    return f"noddle://board/{doc_id}"


# ---- boards this process knows about -------------------------------------------
# There is no listing endpoint (link access is not discovery), so resources/list
# shows only boards this session created, read or edited.


class KnownBoards:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._boards: Dict[str, Dict[str, Any]] = {}

    def remember(self, doc_id: str, name: Any = None, updated_at: Any = None) -> None:
        if not DOC_ID_RE.match(doc_id):
            return
        with self._lock:
            row = self._boards.setdefault(doc_id, {"id": doc_id})
            if name is not None:
                row["name"] = name
            if updated_at is not None:
                row["updated_at"] = updated_at

    def forget(self, doc_id: str) -> None:
        with self._lock:
            self._boards.pop(doc_id, None)

    def rows(self) -> List[Dict[str, Any]]:
        with self._lock:
            rows = [dict(r) for r in self._boards.values()]
        rows.sort(key=lambda r: (-(r.get("updated_at") or 0), r["id"]))
        return rows


KNOWN = KnownBoards()


# ---- tiny JSON-Schema subset validator (for our own inputSchemas) --------------

_TYPES: Dict[str, Callable[[Any], bool]] = {
    "object": lambda v: isinstance(v, dict),
    "array": lambda v: isinstance(v, list),
    "string": lambda v: isinstance(v, str),
    "boolean": lambda v: isinstance(v, bool),
    "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
    "null": lambda v: v is None,
}


def validate(schema: Dict[str, Any], value: Any, path: str = "arguments") -> List[str]:
    errs: List[str] = []
    t = schema.get("type")
    if t is not None:
        types = t if isinstance(t, list) else [t]
        if not any(_TYPES[x](value) for x in types):
            return [f"{path}: expected {' or '.join(types)}"]
    if "enum" in schema and value not in schema["enum"]:
        errs.append(f"{path}: must be one of {schema['enum']}")
    if isinstance(value, str):
        if "minLength" in schema and len(value) < schema["minLength"]:
            errs.append(f"{path}: must be at least {schema['minLength']} characters")
        if "maxLength" in schema and len(value) > schema["maxLength"]:
            errs.append(f"{path}: must be at most {schema['maxLength']} characters")
        if "pattern" in schema and not re.search(schema["pattern"], value):
            errs.append(f"{path}: must match {schema['pattern']}")
    if _TYPES["number"](value):
        if "minimum" in schema and value < schema["minimum"]:
            errs.append(f"{path}: must be >= {schema['minimum']}")
        if "maximum" in schema and value > schema["maximum"]:
            errs.append(f"{path}: must be <= {schema['maximum']}")
    if isinstance(value, list) and "maxItems" in schema and len(value) > schema["maxItems"]:
        errs.append(f"{path}: must have at most {schema['maxItems']} items")
    if isinstance(value, list) and isinstance(schema.get("items"), dict):
        for i, item in enumerate(value):
            errs += validate(schema["items"], item, f"{path}[{i}]")
    if isinstance(value, dict):
        props = schema.get("properties", {})
        for key in schema.get("required", []):
            if key not in value:
                errs.append(f"{path}.{key}: is required")
        for key, item in value.items():
            if key in props:
                errs += validate(props[key], item, f"{path}.{key}")
            elif schema.get("additionalProperties") is False:
                errs.append(f"{path}.{key}: unknown property")
    return errs


# ---- helpers --------------------------------------------------------------------


class ToolError(Exception):
    """Actionable failure reported to the model as an isError tool result."""


class RpcError(Exception):
    def __init__(self, code: int, message: str, data: Any = None) -> None:
        super().__init__(message)
        self.code, self.message, self.data = code, message, data


def encode_cursor(offset: int) -> str:
    return base64.urlsafe_b64encode(json.dumps({"o": offset}).encode()).decode().rstrip("=")


def decode_cursor(cursor: Any) -> int:
    try:
        pad = "=" * (-len(cursor) % 4)
        o = json.loads(base64.urlsafe_b64decode(cursor + pad))["o"]
        if isinstance(o, int) and not isinstance(o, bool) and o >= 0:
            return o
    except Exception:  # noqa: BLE001
        pass
    raise ValueError("invalid cursor")


def page_of(items: List[Any], cursor: Optional[str], limit: int) -> Tuple[List[Any], Optional[str]]:
    start = decode_cursor(cursor) if cursor else 0
    chunk = items[start:start + limit]
    nxt = encode_cursor(start + limit) if start + limit < len(items) else None
    return chunk, nxt


def iso(ts: Any) -> Optional[str]:
    try:
        return datetime.fromtimestamp(float(ts), tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    except (TypeError, ValueError, OverflowError, OSError):
        return None


def meta_of(obj: Any) -> Dict[str, Any]:
    """GET answers DocumentOut ({meta:…}); POST /new, PUT and PATCH answer the
    bare DocMeta. Accept both so a change on either side doesn't break us."""
    if isinstance(obj, dict) and isinstance(obj.get("meta"), dict):
        return obj["meta"]
    return obj if isinstance(obj, dict) else {}


def resolve_doc_id(b: Backend, value: Any) -> str:
    """A 12-hex id, or a board URL ({base}/d/{id} or /embed/{id}) on THIS
    server's origin — the id/URL is the capability."""
    v = str(value or "").strip()
    if DOC_ID_RE.match(v):
        return v
    m = BOARD_URL_RE.match(v)
    if not m:
        raise ToolError(f"Invalid board id: {v[:80]!r} (expected 12 hex chars or a board URL "
                        f"like {b.base_url}/d/0123456789ab).")
    origin = urllib.parse.urlsplit(m.group(1))
    mine = urllib.parse.urlsplit(b.base_url)
    if (origin.scheme, origin.netloc) != (mine.scheme, mine.netloc):
        raise ToolError(f"That board lives on {m.group(1)}, but this server talks to "
                        f"{b.base_url} — set NODDLE_BASE_URL to the board's origin.")
    return m.group(2)


def pages_of(diagram: Any) -> List[Dict[str, Any]]:
    if not isinstance(diagram, dict):
        return []
    if isinstance(diagram.get("pages"), list):
        return [p for p in diagram["pages"] if isinstance(p, dict)]
    if "nodes" in diagram or "edges" in diagram:
        # legacy single-page sidecar — same deterministic id the backend uses
        return [{"id": "p1", "name": "Page 1", "nodes": diagram.get("nodes") or [],
                 "edges": diagram.get("edges") or []}]
    return []


def check_diagram(diagram: Any) -> None:
    """Shape check only — node/edge fields pass through untouched so new editor
    fields (freedraw `points`, `curved` routing, …) flow without an update."""
    if not isinstance(diagram, dict):
        raise ToolError("diagram must be an object: {pages:[{id,name,nodes,edges}]} or {nodes,edges}")
    if "pages" in diagram:
        if not isinstance(diagram["pages"], list) or not diagram["pages"]:
            raise ToolError("diagram.pages must be a non-empty array")
        for i, p in enumerate(diagram["pages"]):
            if not isinstance(p, dict) or not isinstance(p.get("id"), str):
                raise ToolError(f"diagram.pages[{i}] must be an object with a string id")
            _check_lists(p, f"diagram.pages[{i}]")
    elif "nodes" in diagram or "edges" in diagram:
        _check_lists(diagram, "diagram")
    else:
        raise ToolError("diagram needs `pages` (multi-page) or `nodes`/`edges` (single page)")


def _check_lists(obj: Dict[str, Any], path: str) -> None:
    for key in ("nodes", "edges"):
        items = obj.get(key, [])
        if not isinstance(items, list):
            raise ToolError(f"{path}.{key} must be an array")
        for j, item in enumerate(items):
            if not isinstance(item, dict) or not isinstance(item.get("id"), str):
                raise ToolError(f"{path}.{key}[{j}] must be an object with a string id")


def safe_id(value: str, what: str) -> str:
    if not SAFE_ID_RE.match(value):
        raise ToolError(f"{what} has unexpected characters")
    return urllib.parse.quote(value, safe="")


def summarize_board(b: Backend, doc_id: str, doc: Dict[str, Any], page_id: Optional[str] = None,
                    include_svg: bool = False) -> Dict[str, Any]:
    meta = meta_of(doc)
    KNOWN.remember(doc_id, meta.get("name"), meta.get("updated_at"))
    diagram = doc.get("diagram")
    pages = pages_of(diagram)
    if page_id is not None:
        match = [p for p in pages if p.get("id") == page_id]
        if not match:
            raise ToolError(f"page {page_id!r} not found; pages: {[p.get('id') for p in pages]}")
        diagram = {"pages": match}
    out = {
        "id": doc_id,
        "name": meta.get("name"),
        "url": b.board_url(doc_id),
        "my_role": doc.get("my_role"),
        "updated_at": meta.get("updated_at"),
        "link_policy": meta.get("link_policy"),
        "pages": [
            {"id": p.get("id"), "name": p.get("name"),
             "node_count": len(p.get("nodes") or []), "edge_count": len(p.get("edges") or [])}
            for p in pages
        ],
        "diagram": diagram,
    }
    if include_svg:
        out["svg"] = doc.get("svg")
    return out


# ---- tools ------------------------------------------------------------------------

DOC_ID = {"type": "string", "minLength": 12, "maxLength": 2048,
          "description": "Board id (12 hex chars, the {id} in /d/{id}) or the full board URL."}
DIAGRAM_IN = {
    "type": "object",
    "description": (
        "noddle diagram JSON, passed through as-is: {pages:[{id,name,nodes,edges}]} "
        "(or legacy {nodes,edges}). Node required: id, kind (rect|rounded|ellipse|diamond|"
        "cylinder|text|freedraw|… — the editor catalog), x, y, w, h, text, fill, stroke, "
        "strokeWidth. Edge required: id, source, target (attachments {kind:'floating',nodeId} | "
        "{kind:'port',nodeId,rel:{x,y}} | {kind:'free',point:{x,y}}), routing "
        "(straight|elbow|curved), stroke, strokeWidth, endArrow, startArrow, animated. "
        "Unknown/newer fields are preserved."
    ),
}
DIAGRAM_OUT = {"type": ["object", "null"], "description": "Editable diagram JSON (pass-through)."}
PAGE_SUMMARY = {
    "type": "object",
    "properties": {"id": {"type": ["string", "null"]}, "name": {"type": ["string", "null"]},
                   "node_count": {"type": "integer"}, "edge_count": {"type": "integer"}},
    "required": ["id", "node_count", "edge_count"],
}
BOARD_OUT = {
    "type": "object",
    "properties": {
        "id": {"type": "string"}, "name": {"type": ["string", "null"]}, "url": {"type": "string"},
        "my_role": {"type": ["string", "null"], "enum": ["editor", "viewer", None],
                    "description": "viewer ⇒ the link is view-only; writes will fail."},
        "updated_at": {"type": ["number", "null"],
                       "description": "Pass to update_board.expected_updated_at."},
        "link_policy": {"type": ["string", "null"]},
        "pages": {"type": "array", "items": PAGE_SUMMARY},
        "diagram": DIAGRAM_OUT,
        "svg": {"type": ["string", "null"]},
    },
    "required": ["id", "name", "url", "pages", "diagram"],
}
REF_OUT = {
    "type": "object",
    "properties": {"id": {"type": "string"}, "name": {"type": ["string", "null"]},
                   "url": {"type": "string"}, "updated_at": {"type": ["number", "null"]}},
    "required": ["id", "url"],
}
COMMENTS_OUT = {
    "type": "object",
    "properties": {"comments": {"type": "array", "items": {"type": "object"}}},
    "required": ["comments"],
}


def _ann(title: str, read_only: bool, destructive: bool = False, idempotent: bool = False,
         open_world: bool = False) -> Dict[str, Any]:
    a: Dict[str, Any] = {"title": title, "readOnlyHint": read_only, "openWorldHint": open_world}
    if not read_only:  # destructive/idempotent are only meaningful for writers
        a["destructiveHint"] = destructive
        a["idempotentHint"] = idempotent
    return a


def _ref(b: Backend, doc_id: str, meta: Dict[str, Any], fallback_name: Any) -> Dict[str, Any]:
    name = meta.get("name", fallback_name)
    KNOWN.remember(doc_id, name, meta.get("updated_at"))
    return {"id": doc_id, "name": name, "url": b.board_url(doc_id), "updated_at": meta.get("updated_at")}


def t_get_board(b: Backend, a: Dict[str, Any]) -> Dict[str, Any]:
    doc_id = resolve_doc_id(b, a["doc_id"])
    doc = b.call("GET", f"/api/documents/{doc_id}")
    return summarize_board(b, doc_id, doc, a.get("page_id"), bool(a.get("include_svg")))


def t_create_board(b: Backend, a: Dict[str, Any]) -> Dict[str, Any]:
    body: Dict[str, Any] = {"name": a["name"]}
    if a.get("diagram") is not None:
        check_diagram(a["diagram"])
        body["diagram"] = a["diagram"]
    meta = meta_of(b.call("POST", "/api/documents/new", body))
    doc_id = str(meta.get("id") or "")
    if not DOC_ID_RE.match(doc_id):
        raise ToolError("noddle did not return a board id")
    return _ref(b, doc_id, meta, a["name"])


def t_update_board(b: Backend, a: Dict[str, Any]) -> Dict[str, Any]:
    doc_id = resolve_doc_id(b, a["doc_id"])
    check_diagram(a["diagram"])
    doc = b.call("GET", f"/api/documents/{doc_id}")
    current = meta_of(doc)
    expected = a.get("expected_updated_at")
    if expected is not None and abs(float(current.get("updated_at") or 0) - float(expected)) > 1e-6:
        raise ToolError(
            f"conflict: the board changed since you read it (updated_at is now "
            f"{current.get('updated_at')}). Call get_board again and re-apply your edit."
        )
    # Keep the stored SVG preview — the editor strips the baked layer on open
    # and re-renders from JSON. author_name attributes the version snapshot.
    meta = meta_of(b.call("PUT", f"/api/documents/{doc_id}",
                          {"svg": doc.get("svg") or "", "diagram": a["diagram"],
                           "author_name": b.agent_name}))
    return _ref(b, doc_id, meta, current.get("name"))


def t_rename_board(b: Backend, a: Dict[str, Any]) -> Dict[str, Any]:
    doc_id = resolve_doc_id(b, a["doc_id"])
    meta = meta_of(b.call("PATCH", f"/api/documents/{doc_id}", {"name": a["name"]}))
    return _ref(b, doc_id, meta, a["name"])


def t_list_versions(b: Backend, a: Dict[str, Any]) -> Dict[str, Any]:
    doc_id = resolve_doc_id(b, a["doc_id"])
    rows = b.call("GET", f"/api/documents/{doc_id}/versions")
    return {"versions": rows if isinstance(rows, list) else []}


def t_get_version(b: Backend, a: Dict[str, Any]) -> Dict[str, Any]:
    doc_id = resolve_doc_id(b, a["doc_id"])
    vid = safe_id(a["version_id"], "version_id")
    v = b.call("GET", f"/api/documents/{doc_id}/versions/{vid}")
    if not isinstance(v, dict):
        raise ToolError("unexpected version payload")
    out = {"id": v.get("id"), "created_at": v.get("created_at"),
           "author_name": v.get("author_name"), "diagram": v.get("diagram")}
    if a.get("include_svg"):
        out["svg"] = v.get("svg")
    return out


def t_list_comments(b: Backend, a: Dict[str, Any]) -> Dict[str, Any]:
    doc_id = resolve_doc_id(b, a["doc_id"])
    out = b.call("GET", f"/api/documents/{doc_id}/comments")
    out = out if isinstance(out, dict) else {}
    return {"comments": out.get("comments") or []}


def t_add_comment(b: Backend, a: Dict[str, Any]) -> Dict[str, Any]:
    doc_id = resolve_doc_id(b, a["doc_id"])
    targets = [k for k in ("parent_id", "node_id", "edge_id") if a.get(k)]
    if len(targets) > 1:
        raise ToolError(f"give at most one of parent_id / node_id / edge_id (got {targets})")
    body: Dict[str, Any] = {"body": a["body"], "guest_name": b.agent_name}
    if a.get("page_id"):
        body["page_id"] = a["page_id"]
    if a.get("parent_id"):
        body["parent_id"] = a["parent_id"]
    elif a.get("node_id"):
        body["anchor"] = {"kind": "node", "ref": a["node_id"]}
    elif a.get("edge_id"):
        body["anchor"] = {"kind": "edge", "ref": a["edge_id"]}
    else:
        body["anchor"] = {"kind": "point", "x": float(a.get("x", 100)), "y": float(a.get("y", 100))}
    out = b.call("POST", f"/api/documents/{doc_id}/comments", body)
    out = out if isinstance(out, dict) else {}
    return {"comments": out.get("comments") or []}


def t_generate_diagram(b: Backend, a: Dict[str, Any]) -> Dict[str, Any]:
    body: Dict[str, Any] = {"text": a["text"], "format": a.get("format", "text")}
    result = b.call("POST", "/api/ai/text-to-diagram", body, timeout=b.ai_timeout,
                    headers=b.ai_headers())
    if not isinstance(result, dict):
        raise ToolError("unexpected text-to-diagram payload")
    return {"diagram": result}


TOOLS: List[Dict[str, Any]] = [
    {
        "name": "get_board",
        "title": "Get board",
        "description": "Fetch one board by id or URL: name, url, my_role (editor|viewer), "
                       "updated_at, page summary and the editable diagram JSON. Optionally "
                       "restrict to one page.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "doc_id": DOC_ID,
                "page_id": {"type": "string", "description": "Return only this page."},
                "include_svg": {"type": "boolean", "default": False,
                                "description": "Also return the flattened preview SVG (large)."},
            },
            "required": ["doc_id"],
            "additionalProperties": False,
        },
        "outputSchema": BOARD_OUT,
        "annotations": _ann("Get board", read_only=True),
        "handler": t_get_board,
    },
    {
        "name": "create_board",
        "title": "Create board",
        "description": "Create a NEW board, optionally with diagram JSON. Returns the new id + "
                       "url. The board is anonymous: anyone with the url can open and edit it.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "minLength": 1, "maxLength": 300},
                "diagram": DIAGRAM_IN,
            },
            "required": ["name"],
            "additionalProperties": False,
        },
        "outputSchema": REF_OUT,
        "annotations": _ann("Create board", read_only=False, destructive=False, idempotent=False),
        "handler": t_create_board,
    },
    {
        "name": "update_board",
        "title": "Replace board diagram",
        "description": "Replace a board's WHOLE diagram (full-state, like the live protocol; a "
                       "version snapshot is kept). Fetch with get_board, modify, send everything "
                       "back. Pass expected_updated_at to fail instead of overwriting a "
                       "collaborator's newer edit.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "doc_id": DOC_ID,
                "diagram": DIAGRAM_IN,
                "expected_updated_at": {"type": "number",
                                        "description": "updated_at from get_board (optimistic concurrency)."},
            },
            "required": ["doc_id", "diagram"],
            "additionalProperties": False,
        },
        "outputSchema": REF_OUT,
        "annotations": _ann("Replace board diagram", read_only=False, destructive=True, idempotent=True),
        "handler": t_update_board,
    },
    {
        "name": "rename_board",
        "title": "Rename board",
        "description": "Rename a board (fails on a view-only link).",
        "inputSchema": {
            "type": "object",
            "properties": {"doc_id": DOC_ID, "name": {"type": "string", "minLength": 1, "maxLength": 300}},
            "required": ["doc_id", "name"],
            "additionalProperties": False,
        },
        "outputSchema": REF_OUT,
        "annotations": _ann("Rename board", read_only=False, destructive=False, idempotent=True),
        "handler": t_rename_board,
    },
    {
        "name": "list_versions",
        "title": "List board versions",
        "description": "Version-history snapshots of a board, newest first (id, created_at, author_name).",
        "inputSchema": {
            "type": "object", "properties": {"doc_id": DOC_ID},
            "required": ["doc_id"], "additionalProperties": False,
        },
        "outputSchema": {
            "type": "object",
            "properties": {"versions": {"type": "array", "items": {
                "type": "object",
                "properties": {"id": {"type": "string"}, "created_at": {"type": "number"},
                               "author_name": {"type": "string"}},
                "required": ["id"]}}},
            "required": ["versions"],
        },
        "annotations": _ann("List board versions", read_only=True),
        "handler": t_list_versions,
    },
    {
        "name": "get_version",
        "title": "Get board version",
        "description": "One snapshot's diagram JSON. To restore it, send that diagram to update_board.",
        "inputSchema": {
            "type": "object",
            "properties": {"doc_id": DOC_ID,
                           "version_id": {"type": "string", "pattern": SAFE_ID_RE.pattern},
                           "include_svg": {"type": "boolean", "default": False}},
            "required": ["doc_id", "version_id"],
            "additionalProperties": False,
        },
        "outputSchema": {
            "type": "object",
            "properties": {"id": {"type": ["string", "null"]}, "created_at": {"type": ["number", "null"]},
                           "author_name": {"type": ["string", "null"]}, "diagram": DIAGRAM_OUT,
                           "svg": {"type": ["string", "null"]}},
            "required": ["id", "diagram"],
        },
        "annotations": _ann("Get board version", read_only=True),
        "handler": t_get_version,
    },
    {
        "name": "list_comments",
        "title": "List comments",
        "description": "A board's comment threads (roots carry the anchor; replies are one level deep).",
        "inputSchema": {
            "type": "object", "properties": {"doc_id": DOC_ID},
            "required": ["doc_id"], "additionalProperties": False,
        },
        "outputSchema": COMMENTS_OUT,
        "annotations": _ann("List comments", read_only=True),
        "handler": t_list_comments,
    },
    {
        "name": "add_comment",
        "title": "Add comment",
        "description": "Comment on a board, signed with NODDLE_AGENT_NAME. Anchor to ONE of: "
                       "node_id, edge_id, a reply to a thread root (parent_id), or a canvas "
                       "point (x, y; default 100,100). Works on view-only links too. Returns "
                       "the full updated thread list.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "doc_id": DOC_ID,
                "body": {"type": "string", "minLength": 1, "maxLength": 5000},
                "page_id": {"type": "string", "description": "Page the pin lives on (multi-page boards)."},
                "node_id": {"type": "string"},
                "edge_id": {"type": "string"},
                "parent_id": {"type": "string", "description": "Root comment id to reply to."},
                "x": {"type": "number"},
                "y": {"type": "number"},
            },
            "required": ["doc_id", "body"],
            "additionalProperties": False,
        },
        "outputSchema": COMMENTS_OUT,
        "annotations": _ann("Add comment", read_only=False, destructive=False, idempotent=False),
        "handler": t_add_comment,
    },
    {
        "name": "generate_diagram",
        "title": "Generate diagram from text",
        "description": "Turn prose or Mermaid into editable noddle diagram JSON via the server's "
                       "AI (your own key from NODDLE_AI_PROVIDER/NODDLE_AI_KEY, else the "
                       "instance's shared pool if it has one). Does NOT save anything — pass the "
                       "result to create_board or update_board. The text leaves noddle for the "
                       "AI provider: never include PII, credentials or account numbers.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "text": {"type": "string", "minLength": 1, "maxLength": 20000},
                "format": {"type": "string", "enum": ["text", "mermaid"], "default": "text"},
            },
            "required": ["text"],
            "additionalProperties": False,
        },
        "outputSchema": {"type": "object", "properties": {"diagram": {"type": "object"}},
                         "required": ["diagram"]},
        "annotations": _ann("Generate diagram from text", read_only=True, open_world=True),
        "handler": t_generate_diagram,
    },
]
TOOLS_BY_NAME = {t["name"]: t for t in TOOLS}
RESOURCE_LINK_TOOLS = {"get_board", "create_board", "update_board", "rename_board"}
_PRIVATE_KEYS = ("handler",)


def tool_defs() -> List[Dict[str, Any]]:
    return [{k: v for k, v in t.items() if k not in _PRIVATE_KEYS} for t in TOOLS]


# ---- request context -------------------------------------------------------------


class Ctx:
    def __init__(self, era: str, version: str, backend: Optional[Backend] = None) -> None:
        self.era, self.version = era, version
        self.backend: Backend = backend or REST

    @property
    def modern(self) -> bool:
        return self.era == "modern"

    def supports_resource_links(self) -> bool:
        return self.modern or self.version >= "2025-06-18"


# ---- method handlers ---------------------------------------------------------------


def _cacheable(ctx: Ctx, result: Dict[str, Any], ttl_ms: int, scope: str) -> Dict[str, Any]:
    if ctx.modern:
        result["ttlMs"], result["cacheScope"] = ttl_ms, scope
    return result


def _reject_cursor(params: Dict[str, Any]) -> None:
    if params.get("cursor") is not None:
        raise RpcError(INVALID_PARAMS, "Invalid cursor")


def m_discover(params: Dict[str, Any], ctx: Ctx) -> Dict[str, Any]:
    return {"supportedVersions": list(MODERN_VERSIONS), "capabilities": CAPABILITIES,
            "instructions": INSTRUCTIONS, "ttlMs": 3_600_000, "cacheScope": "public"}


def m_ping(params: Dict[str, Any], ctx: Ctx) -> Dict[str, Any]:
    return {}


def m_tools_list(params: Dict[str, Any], ctx: Ctx) -> Dict[str, Any]:
    _reject_cursor(params)
    return _cacheable(ctx, {"tools": tool_defs()}, 3_600_000, "public")


def m_tools_call(params: Dict[str, Any], ctx: Ctx) -> Dict[str, Any]:
    name = params.get("name")
    if not isinstance(name, str):
        raise RpcError(INVALID_PARAMS, "tools/call needs a string `name`")
    tool = TOOLS_BY_NAME.get(name)
    if tool is None:
        raise RpcError(INVALID_PARAMS, f"Unknown tool: {name}")
    args = params.get("arguments", {})
    if args is None:
        args = {}
    if not isinstance(args, dict):
        raise RpcError(INVALID_PARAMS, "tools/call `arguments` must be an object")
    errs = validate(tool["inputSchema"], args)
    if errs:
        return _tool_error("Invalid arguments: " + "; ".join(errs[:8]))
    try:
        structured = tool["handler"](ctx.backend, args)
    except (ToolError, ApiError) as e:
        return _tool_error(str(e))
    content: List[Dict[str, Any]] = [
        {"type": "text", "text": redact(json.dumps(structured, ensure_ascii=False))}
    ]
    doc_id = structured.get("id") if isinstance(structured, dict) else None
    if name in RESOURCE_LINK_TOOLS and isinstance(doc_id, str) and ctx.supports_resource_links():
        content.append({"type": "resource_link", "uri": board_uri(doc_id),
                        "name": str(structured.get("name") or doc_id),
                        "mimeType": "application/json",
                        "description": f"noddle board — open {ctx.backend.board_url(doc_id)}"})
    return {"content": content, "structuredContent": structured, "isError": False}


def _tool_error(text: str) -> Dict[str, Any]:
    return {"content": [{"type": "text", "text": redact(text)}], "isError": True}


def m_resources_list(params: Dict[str, Any], ctx: Ctx) -> Dict[str, Any]:
    """Only boards this session created/read/edited — the API has no listing."""
    b = ctx.backend
    try:
        chunk, nxt = page_of(KNOWN.rows(), params.get("cursor"), PAGE_SIZE)
    except ValueError:
        raise RpcError(INVALID_PARAMS, "Invalid cursor") from None
    resources = []
    for d in chunk:
        label = str(d.get("name") or d["id"])
        r: Dict[str, Any] = {"uri": board_uri(d["id"]), "name": label, "title": label,
                             "mimeType": "application/json",
                             "description": f"noddle board {b.board_url(d['id'])}"}
        lm = iso(d.get("updated_at"))
        if lm:
            r["annotations"] = {"lastModified": lm}
        resources.append(r)
    out: Dict[str, Any] = {"resources": resources}
    if nxt:
        out["nextCursor"] = nxt
    return _cacheable(ctx, out, 5_000, "private")


def m_resource_templates(params: Dict[str, Any], ctx: Ctx) -> Dict[str, Any]:
    _reject_cursor(params)
    return _cacheable(ctx, {"resourceTemplates": [{
        "uriTemplate": "noddle://board/{doc_id}", "name": "board", "title": "noddle board",
        "description": "A board's name, page summary and editable diagram JSON (doc_id = 12-hex id).",
        "mimeType": "application/json",
    }]}, 3_600_000, "public")


def read_board_resource(b: Backend, uri: Any) -> Dict[str, Any]:
    m = BOARD_URI_RE.match(uri) if isinstance(uri, str) else None
    if not m:
        raise RpcError(INVALID_PARAMS, "Resource not found", {"uri": uri})
    doc_id = m.group(1)
    try:
        doc = b.call("GET", f"/api/documents/{doc_id}")
    except ApiError as e:
        if e.status in (403, 404):
            KNOWN.forget(doc_id)
            raise RpcError(INVALID_PARAMS, "Resource not found", {"uri": uri}) from None
        raise RpcError(INTERNAL_ERROR, str(e)) from None
    body = summarize_board(b, doc_id, doc)
    return {"uri": uri, "mimeType": "application/json", "text": json.dumps(body, ensure_ascii=False)}


def m_resources_read(params: Dict[str, Any], ctx: Ctx) -> Dict[str, Any]:
    return _cacheable(ctx, {"contents": [read_board_resource(ctx.backend, params.get("uri"))]},
                      5_000, "private")


PROMPTS = [
    {
        "name": "design_board",
        "title": "Design a new board",
        "description": "Draft a new noddle board about a topic and return its link.",
        "arguments": [
            {"name": "topic", "description": "What the diagram should explain.", "required": True},
            {"name": "notes", "description": "Extra constraints (audience, components, style).",
             "required": False},
        ],
    },
    {
        "name": "review_board",
        "title": "Review a board",
        "description": "Critique an existing board's clarity/layout and leave anchored comments.",
        "arguments": [{"name": "doc_id", "description": "12-hex board id or board URL.",
                       "required": True}],
    },
]


def m_prompts_list(params: Dict[str, Any], ctx: Ctx) -> Dict[str, Any]:
    _reject_cursor(params)
    return _cacheable(ctx, {"prompts": PROMPTS}, 3_600_000, "public")


def m_prompts_get(params: Dict[str, Any], ctx: Ctx) -> Dict[str, Any]:
    name = params.get("name")
    args = params.get("arguments") or {}
    if not isinstance(args, dict) or not all(isinstance(v, str) for v in args.values()):
        raise RpcError(INVALID_PARAMS, "prompt arguments must be an object of strings")
    if name == "design_board":
        topic = args.get("topic", "").strip()
        if not topic:
            raise RpcError(INVALID_PARAMS, "Missing required argument: topic")
        notes = args.get("notes", "").strip()
        text = (
            f"Create a noddle board that explains: {topic}\n"
            + (f"Constraints: {notes}\n" if notes else "")
            + "\nSteps:\n"
            "1. Call generate_diagram with a precise description (or Mermaid) of the components "
            "and how they connect — it returns editable diagram JSON. If no AI backend is "
            "available, write the diagram JSON yourself.\n"
            "2. Review that JSON: keep it to roughly 9 nodes or fewer per page, short labels, "
            "and edges attached to node ids.\n"
            "3. Call create_board with a clear name and the diagram.\n"
            "4. Reply with the board url and a one-paragraph summary. Remind the user that "
            "anyone with the url can open and edit the board.\n"
            "Do not include personal data, credentials or account numbers in any text."
        )
        return {"description": f"Design a board about {topic}",
                "messages": [{"role": "user", "content": {"type": "text", "text": text}}]}
    if name == "review_board":
        try:
            doc_id = resolve_doc_id(ctx.backend, args.get("doc_id", ""))
        except ToolError as e:
            raise RpcError(INVALID_PARAMS, str(e)) from None
        resource = read_board_resource(ctx.backend, board_uri(doc_id))
        text = (
            "Review the noddle board above for clarity: overlapping or crowded shapes, "
            "unlabeled or ambiguous connectors, inconsistent colours, missing components. "
            "For each concrete issue call add_comment anchored to the node_id or edge_id it "
            f"concerns (doc_id={doc_id}). Do not change the diagram unless asked. Finish with a "
            "short prioritized summary."
        )
        return {"description": f"Review board {doc_id}", "messages": [
            {"role": "user", "content": {"type": "resource", "resource": resource}},
            {"role": "user", "content": {"type": "text", "text": text}},
        ]}
    raise RpcError(INVALID_PARAMS, f"Unknown prompt: {name}")


COMMON_METHODS: Dict[str, Callable[[Dict[str, Any], Ctx], Dict[str, Any]]] = {
    "tools/list": m_tools_list,
    "tools/call": m_tools_call,
    "resources/list": m_resources_list,
    "resources/templates/list": m_resource_templates,
    "resources/read": m_resources_read,
    "prompts/list": m_prompts_list,
    "prompts/get": m_prompts_get,
}
MODERN_METHODS = dict(COMMON_METHODS, **{"server/discover": m_discover})
LEGACY_METHODS = dict(COMMON_METHODS, ping=m_ping)  # ping was removed in 2026-07-28


# ---- request execution -------------------------------------------------------------


def rpc_error(msg_id: Any, code: int, message: str, data: Any = None) -> Dict[str, Any]:
    err: Dict[str, Any] = {"code": code, "message": redact(message)}
    if data is not None:
        err["data"] = data
    return {"jsonrpc": "2.0", "id": msg_id, "error": err}


def execute(msg_id: Any, handler: Callable, params: Dict[str, Any], ctx: Ctx) -> Dict[str, Any]:
    """Run one method handler → a complete JSON-RPC response (never raises)."""
    try:
        result = handler(params, ctx)
    except RpcError as e:
        return rpc_error(msg_id, e.code, e.message, e.data)
    except Exception as e:  # noqa: BLE001 — keep serving
        log("internal error: " + "".join(traceback.format_exception_only(type(e), e)).strip())
        return rpc_error(msg_id, INTERNAL_ERROR, "Internal error")
    if ctx.modern:
        result = dict(result)
        result["resultType"] = "complete"
        result.setdefault("_meta", {})[META_SERVER_INFO] = {
            "name": SERVER_INFO["name"], "version": SERVER_INFO["version"]}
    return {"jsonrpc": "2.0", "id": msg_id, "result": result}


def initialize_result(params: Dict[str, Any]) -> Tuple[str, Dict[str, Any]]:
    """Legacy ``initialize`` → (negotiated version, result body)."""
    requested = params.get("protocolVersion")
    version = requested if requested in LEGACY_VERSIONS else LEGACY_VERSIONS[0]
    info = dict(SERVER_INFO)
    if version < "2025-06-18":  # title/description/websiteUrl arrived later
        info = {"name": info["name"], "version": info["version"]}
    caps = {"tools": {"listChanged": False}, "resources": {"subscribe": False, "listChanged": False},
            "prompts": {"listChanged": False}}
    return version, {"protocolVersion": version, "capabilities": caps, "serverInfo": info,
                     "instructions": INSTRUCTIONS}


# ---- JSON-RPC over stdio --------------------------------------------------------


class Server:
    def __init__(self, out: Any) -> None:
        self.out = out
        self.write_lock = threading.Lock()
        self.legacy_version: Optional[str] = None  # set by initialize (legacy era only)
        self.cancelled: set = set()
        self.pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="noddle-mcp")

    # -- output
    def send(self, obj: Any) -> None:
        line = json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n"
        with self.write_lock:
            self.out.write(line.encode("utf-8"))
            self.out.flush()

    error = staticmethod(rpc_error)

    # -- input
    def handle_line(self, raw: bytes) -> None:
        text = raw.decode("utf-8", "replace").strip()
        if not text:
            return
        try:
            msg = json.loads(text)
        except ValueError:
            self.send(self.error(None, PARSE_ERROR, "Parse error"))
            return
        if isinstance(msg, list):
            self.handle_batch(msg)
            return
        resp = self.handle_message(msg, deferred=True)
        if resp is not None:
            self.send(resp)

    def handle_batch(self, msgs: List[Any]) -> None:
        # Batches existed only in 2025-03-26; every other revision is one message per line.
        if not msgs or self.legacy_version != "2025-03-26":
            self.send(self.error(None, INVALID_REQUEST,
                                 "Invalid Request: JSON-RPC batches are not supported by this protocol version"))
            return

        def run() -> None:
            out = [r for r in (self.handle_message(m, deferred=False) for m in msgs) if r is not None]
            if out:
                self.send(out)

        self.pool.submit(run)

    def handle_message(self, msg: Any, deferred: bool) -> Optional[Dict[str, Any]]:
        """Returns an immediate response, or None (notification, or work queued)."""
        if not isinstance(msg, dict):
            return self.error(None, INVALID_REQUEST, "Invalid Request")
        has_id = "id" in msg
        msg_id = msg.get("id")
        method = msg.get("method")
        if not has_id and method is None:
            if "result" in msg or "error" in msg:
                log("ignoring a JSON-RPC response from the client (server sends no requests)")
                return None
            return self.error(None, INVALID_REQUEST, "Invalid Request")
        if not has_id:  # notification — never answered, even when invalid/unknown
            self.handle_notification(method, msg.get("params"))
            return None
        if msg.get("jsonrpc") != "2.0" or not isinstance(method, str) \
                or isinstance(msg_id, bool) or not isinstance(msg_id, (str, int)):
            safe = msg_id if isinstance(msg_id, (str, int)) and not isinstance(msg_id, bool) else None
            return self.error(safe, INVALID_REQUEST, "Invalid Request")
        params = msg.get("params", {})
        if params is None:
            params = {}
        if not isinstance(params, dict):
            return self.error(msg_id, INVALID_PARAMS, "params must be an object")

        # -- era selection
        meta = params.get("_meta") if isinstance(params.get("_meta"), dict) else {}
        if META_VERSION in meta:
            version = meta.get(META_VERSION)
            if version not in MODERN_VERSIONS:
                return self.error(msg_id, UNSUPPORTED_PROTOCOL_VERSION, "Unsupported protocol version",
                                  {"supported": list(MODERN_VERSIONS), "requested": version})
            if not isinstance(meta.get(META_CLIENT_CAPS), dict):
                return self.error(msg_id, INVALID_PARAMS,
                                  f"Missing required _meta field {META_CLIENT_CAPS}")
            ctx, table = Ctx("modern", version), MODERN_METHODS
        elif method == "initialize":
            return self.initialize(msg_id, params)
        elif self.legacy_version is not None:
            ctx, table = Ctx("legacy", self.legacy_version), LEGACY_METHODS
        else:
            if method not in MODERN_METHODS and method not in LEGACY_METHODS:
                return self.error(msg_id, METHOD_NOT_FOUND, f"Method not found: {method}")
            return self.error(
                msg_id, INVALID_PARAMS,
                f"Missing required _meta field {META_VERSION} (supported: "
                f"{', '.join(MODERN_VERSIONS)}); legacy clients must call initialize first "
                f"(supported: {', '.join(LEGACY_VERSIONS)})")

        handler = table.get(method)
        if handler is None:
            return self.error(msg_id, METHOD_NOT_FOUND, f"Method not found: {method}")
        if deferred:
            self.pool.submit(self._run_and_send, msg_id, handler, params, ctx)
            return None
        return self.run(msg_id, handler, params, ctx)

    def run(self, msg_id: Any, handler: Callable, params: Dict[str, Any], ctx: Ctx) -> Optional[Dict[str, Any]]:
        resp = execute(msg_id, handler, params, ctx)
        if msg_id in self.cancelled:  # MUST NOT answer a cancelled request
            self.cancelled.discard(msg_id)
            return None
        return resp

    def _run_and_send(self, msg_id: Any, handler: Callable, params: Dict[str, Any], ctx: Ctx) -> None:
        resp = self.run(msg_id, handler, params, ctx)
        if resp is not None:
            try:
                self.send(resp)
            except (BrokenPipeError, ValueError):
                pass

    def initialize(self, msg_id: Any, params: Dict[str, Any]) -> Dict[str, Any]:
        version, result = initialize_result(params)
        self.legacy_version = version
        return {"jsonrpc": "2.0", "id": msg_id, "result": result}

    def handle_notification(self, method: Any, params: Any) -> None:
        if method == "notifications/cancelled" and isinstance(params, dict):
            rid = params.get("requestId")
            if isinstance(rid, (str, int)) and not isinstance(rid, bool):
                self.cancelled.add(rid)
        # notifications/initialized and everything else: nothing to do

    def serve(self, inp: Any) -> int:
        try:
            for raw in iter(inp.readline, b""):
                self.handle_line(raw)
        except KeyboardInterrupt:
            pass
        finally:
            self.pool.shutdown(wait=True)  # flush in-flight answers, then exit on EOF
        return 0


HELP = f"""noddle-mcp {__version__} — MCP server (stdio) for noddle draw boards.

Usage: noddle_mcp.py [--help] [--version] [--list-tools]

Speaks MCP {MODERN_VERSIONS[0]} (stateless, server/discover) and the legacy
initialize handshake ({', '.join(LEGACY_VERSIONS)}). Reads JSON-RPC from stdin,
writes it to stdout; logs go to stderr. No accounts or tokens: a board id/URL
is the capability.

Environment:
  NODDLE_BASE_URL    default {DEFAULT_BASE_URL} (self-hosted: http://127.0.0.1:8000)
  NODDLE_AGENT_NAME  name on comments / version history (default "MCP agent")
  NODDLE_TIMEOUT     seconds per board API call (default 30)
  NODDLE_AI_TIMEOUT  seconds for generate_diagram (default 180)
  NODDLE_AI_PROVIDER claude|openai|gemini|openrouter|custom  (optional, BYOK)
  NODDLE_AI_KEY      your AI provider key (optional; else the instance's pool)
  NODDLE_AI_MODEL    model override (optional)
  NODDLE_AI_BASE     OpenAI-compatible base URL (provider "custom" only)

Register with Claude Code:
  claude mcp add noddle -- python3 mcp/noddle_mcp.py

Exit codes: 0 stdin closed, 2 bad configuration.
"""


def main(argv: Optional[List[str]] = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if "-h" in argv or "--help" in argv:
        sys.stdout.write(HELP)
        return 0
    if "--version" in argv:
        sys.stdout.write(f"noddle-mcp {__version__}\n")
        return 0
    if "--list-tools" in argv:
        sys.stdout.write(json.dumps(tool_defs(), indent=2) + "\n")
        return 0
    if argv:
        sys.stderr.write(f"unknown argument(s): {' '.join(argv)}\n\n{HELP}")
        return 2
    problems = CONFIG.problems()
    if problems:
        for p in problems:
            log(p)
        return 2
    for w in CONFIG.warnings():
        log("warning: " + w)
    out = sys.stdout.buffer
    sys.stdout = sys.stderr  # a stray print() must never corrupt the protocol channel
    log(f"serving {CONFIG.base_url} (MCP {MODERN_VERSIONS[0]} + legacy initialize)")
    try:
        return Server(out).serve(sys.stdin.buffer)
    except BrokenPipeError:
        return 0


if __name__ == "__main__":
    sys.exit(main())
