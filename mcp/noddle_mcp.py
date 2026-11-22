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
import colorsys
import copy
import json
import math
import os
import re
import sys
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import uuid
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional, Tuple

__version__ = "2.1.0"

DEFAULT_BASE_URL = "https://draw.noddle.dev"

SERVER_INFO = {
    "name": "noddle",
    "title": "noddle draw",
    "version": __version__,
    "description": "Read, create and edit noddle draw diagram boards and their comments.",
    "websiteUrl": DEFAULT_BASE_URL,
}
INSTRUCTIONS = (
    "noddle boards are editable diagrams: {metadata?, pages:[{id,name,metadata?,nodes,edges}]}. Boards "
    "are anonymous: a board id (12 hex chars) or its URL ({base}/d/{id}) is all you need, and anyone "
    "holding the link can open it. There is no board listing: without board context, ask the user for "
    "the board link or whether to create a new board.\n"
    "FAST PATH — minimize tool calls and tokens:\n"
    "1. READ: call read_board_summary first — the board's meaning (metadata, groups, nodes, flows) with no "
    "geometry, ~90% fewer tokens than get_board. Use capture_board to SEE it, get_board(compact=true, node_ids) "
    "only for exact geometry. Never dump full SVG.\n"
    "2. WRITE: prefer patch_board (small ops) over update_board (full JSON). Pass category "
    "(architecture|flowchart|data|org|timeline) and set role or style (blue|green|ember|red|ink|frame|label) "
    "so every diagram has clear, distinct category colors — never monochrome. Read noddle://style-guide if unsure. "
    "Annotate as you write: diagram metadata {category, summary, tags} (create_board/patch_board `metadata`) and "
    "node meta {role, tech, layer…} so the next agent reads the board instantly.\n"
    "3. CONCISE TEXT: keep node labels short and scannable (2-5 words/line, <=3 lines; no paragraphs in boxes). "
    "Leave auto_fit=true and auto_layout=true on so the server sizes boxes and clears overlaps before saving.\n"
    "4. SINGLE-PASS VERIFY: pass capture=true (with capture_node_ids for clones) on patch_board/create_board "
    "to save, auto-fix, run pixel-exact DOM lint, and get a crisp 2x PNG in ONE call. Inspect the PNG; JSON "
    "alone is not visual validation. Fix any remaining errors and re-capture if needed.\n"
    "5. EXISTING BOARDS: call clone_diagram first (places a copy to the right), patch only clone IDs, visually "
    "inspect the cropped clone PNG, report any manual_changes, then ASK whether to keep both, replace the "
    "original, or move to a new board. Only use create_board when the user asks for a new board. "
    "Never send customer PII, credentials or account numbers through these tools."
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


_COMPACT_NODE_DEFAULTS = {
    "bold": False, "italic": False, "underline": False, "wrap": False,
    "strokeDash": "solid", "opacity": 1, "letterSpacing": 0,
}
_COMPACT_EDGE_DEFAULTS = {
    "animated": False, "startArrow": False, "endArrow": True,
    "dash": "solid", "routing": "elbow",
}


def _compact_node(n: Dict[str, Any]) -> Dict[str, Any]:
    out = {}
    for k, v in n.items():
        if k == "z" or v is None:
            continue
        if k in _COMPACT_NODE_DEFAULTS and v == _COMPACT_NODE_DEFAULTS[k]:
            continue
        out[k] = v
    return out


def _compact_edge(e: Dict[str, Any]) -> Dict[str, Any]:
    out = {}
    for k, v in e.items():
        if k == "z" or v is None:
            continue
        if k in _COMPACT_EDGE_DEFAULTS and v == _COMPACT_EDGE_DEFAULTS[k]:
            continue
        if k in ("waypoints", "labels") and v == []:
            continue
        out[k] = v
    return out


def _filter_and_compact_diagram(diagram: Any, compact: bool, node_ids: Optional[List[str]]) -> Any:
    if not isinstance(diagram, dict):
        return diagram
    if not compact and not node_ids:
        return diagram
    wanted = set(node_ids) if node_ids else None
    out = copy.deepcopy(diagram)
    page_list = out["pages"] if isinstance(out.get("pages"), list) else [out]
    for p in page_list:
        if not isinstance(p, dict):
            continue
        nodes = p.get("nodes") or []
        edges = p.get("edges") or []
        if wanted is not None:
            nodes = [n for n in nodes if isinstance(n, dict) and n.get("id") in wanted]
            edges = [
                e for e in edges if isinstance(e, dict) and (
                    (e.get("source") or {}).get("nodeId") in wanted
                    or (e.get("target") or {}).get("nodeId") in wanted
                )
            ]
        if compact:
            nodes = [_compact_node(n) for n in nodes if isinstance(n, dict)]
            edges = [_compact_edge(e) for e in edges if isinstance(e, dict)]
        p["nodes"] = nodes
        p["edges"] = edges
    return out


def summarize_board(b: Backend, doc_id: str, doc: Dict[str, Any], page_id: Optional[str] = None,
                    include_svg: bool = False, compact: bool = False,
                    node_ids: Optional[List[str]] = None) -> Dict[str, Any]:
    meta = meta_of(doc)
    KNOWN.remember(doc_id, meta.get("name"), meta.get("updated_at"))
    diagram = doc.get("diagram")
    pages = pages_of(diagram)
    root = _root_metadata(diagram)
    if page_id is not None:
        match = [p for p in pages if p.get("id") == page_id]
        if not match:
            raise ToolError(f"page {page_id!r} not found; pages: {[p.get('id') for p in pages]}")
        diagram = {**({"metadata": root} if root else {}), "pages": match}
    diagram_out = _filter_and_compact_diagram(diagram, compact, node_ids)
    page_rows = []
    for p in pages:
        row = {"id": p.get("id"), "name": p.get("name"),
               "node_count": len(p.get("nodes") or []), "edge_count": len(p.get("edges") or [])}
        if isinstance(p.get("metadata"), dict) and p["metadata"]:
            row["metadata"] = copy.deepcopy(p["metadata"])
        page_rows.append(row)
    out = {
        "id": doc_id,
        "name": meta.get("name"),
        "url": b.board_url(doc_id),
        "my_role": doc.get("my_role"),
        "updated_at": meta.get("updated_at"),
        "link_policy": meta.get("link_policy"),
        **({"metadata": root} if root else {}),
        "pages": page_rows,
        "diagram": diagram_out,
    }
    if include_svg:
        # The stored preview SVG is ONE flattened page (whichever was saved
        # last), so for a page_id on a multi-page board it would silently be
        # the wrong picture — point at capture_board instead.
        if page_id is not None and len(pages) > 1:
            out["svg_note"] = ("The stored preview SVG covers one page only and may not be this one; "
                               "call capture_board with this page_id for its image.")
        else:
            out["svg"] = doc.get("svg")
    return out


# ---- tools ------------------------------------------------------------------------

DOC_ID = {"type": "string", "minLength": 12, "maxLength": 2048,
          "description": "Board id (12 hex chars, the {id} in /d/{id}) or the full board URL."}
CATEGORY_ENUM = ["architecture", "flowchart", "data", "org", "timeline"]
PALETTE_ENUM = ["board", "editorial", "preserve"]
DIAGRAM_IN = {
    "type": "object",
    "description": (
        "noddle diagram JSON: {pages:[{id,name,nodes,edges}]} (or {nodes,edges}). "
        "Node: id, kind (rect|rounded|ellipse|diamond|cylinder|cloud|queue|terminator|process|document|note|shield|actor|icon|freedraw…; "
        "for text labels use kind:'rect' with style:'label'), x, y, w, h, text (short, 2-5 words/line). "
        "Instead of raw hexes, pass style:'ink|blue|green|ember|red|frame|label' or role (mapped by category). "
        "Edge: id, source, target ({kind:'floating',nodeId} | {kind:'port',nodeId,rel:{x,y}} | {kind:'free',point:{x,y}}), "
        "optional routing (elbow|straight|curved), style (ink|blue|green|ember|red), labels:[{id,t,text}]."
    ),
}
PATCH_OPS_IN = {
    "type": "array",
    "maxItems": 500,
    "description": (
        "Atomic diagram ops: "
        "{op:'add', node:{id,kind,x,y,w,h,text,style|role,…}} | "
        "{op:'add', edge:{id,source,target,routing?,style?,labels?}} | "
        "{op:'update', node:{id,...changedFields}} | "
        "{op:'update', edge:{id,...changedFields}} | "
        "{op:'delete', id} (cascades attached edges) | "
        "{op:'add_page', page:{id,name}} | {op:'rename_page', page_id, name} | "
        "{op:'set_metadata', metadata:{category,summary,tags,…}, page_id?} (diagram-level, or page-level "
        "with page_id; null removes a key). node/edge `meta` (role, tech, layer, protocol…) merges key by key on update. "
        "Optional per-op page_id overrides the top-level page_id."
    ),
    "items": {"type": "object"},
}
_META_STR = {"type": ["string", "null"]}
_META_TAGS = {"type": ["array", "null"], "maxItems": 20, "items": {"type": "string"}}
_META_CUSTOM = {"type": ["object", "null"],
                "description": "Free-form key -> string|number|boolean|string[] (<= 20 keys)."}
DIAGRAM_METADATA_IN = {
    "type": "object",
    "description": (
        "Diagram-level semantics stored on the board root so future agents read it instantly "
        "(merged; a key set to null is removed). Bounded and sanitized server-side."
    ),
    "properties": {
        "category": {**_META_STR, "description": "architecture|flowchart|data|org|timeline or custom."},
        "summary": {**_META_STR, "maxLength": 1000, "description": "1-2 sentence overview of the board."},
        "domain": {**_META_STR, "description": "e.g. payments, fraud, infra."},
        "tags": _META_TAGS, "owner": _META_STR, "version": _META_STR,
        "links": {"type": ["array", "null"], "maxItems": 20,
                  "items": {"type": "object", "properties": {"label": {"type": "string"},
                                                             "url": {"type": "string"}},
                            "required": ["url"]},
                  "description": "http(s) links only."},
        "custom": _META_CUSTOM,
    },
}
PAGE_METADATA_IN = {
    "type": "object",
    "description": "Page-level semantics (merged into the target page's metadata; null removes a key).",
    "properties": {
        "category": _META_STR, "summary": {**_META_STR, "maxLength": 1000}, "tags": _META_TAGS,
        "notes": {**_META_STR, "maxLength": 4000}, "custom": _META_CUSTOM,
    },
}
METADATA_OUT = {"type": "object", "description": "Diagram-level semantic metadata (when set)."}
DIAGRAM_OUT = {"type": ["object", "null"], "description": "Editable diagram JSON."}
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
                       "description": "Pass to patch_board/update_board.expected_updated_at."},
        "edit_revision": {"type": "string", "description": "Read-base token for collaborative writes."},
        "link_policy": {"type": ["string", "null"]},
        "metadata": METADATA_OUT,
        "pages": {"type": "array", "items": PAGE_SUMMARY},
        "diagram": DIAGRAM_OUT,
        "svg": {"type": ["string", "null"]},
        "svg_note": {"type": "string"},
    },
    "required": ["id", "name", "url", "pages", "diagram"],
}
REF_OUT = {
    "type": "object",
    "properties": {"id": {"type": "string"}, "name": {"type": ["string", "null"]},
                   "url": {"type": "string"}, "updated_at": {"type": ["number", "null"]},
                   "edit_revision": {"type": "string"}},
    "required": ["id", "url"],
}
CAPTURE_META_OUT = {
    "type": "object",
    "properties": {
        "page_id": {"type": "string"}, "width": {"type": "integer"}, "height": {"type": "integer"},
        "scale": {"type": "number"}, "cropped": {"type": "boolean"},
        "renderer": {"type": "string"}, "visual_validation": {"type": "string"},
    },
}
WRITE_OUT = {
    "type": "object",
    "properties": {**REF_OUT["properties"],
                   "applied_ops": {"type": "integer"},
                   "auto_fixed": {"type": "array", "items": {"type": "string"}},
                   "capture": CAPTURE_META_OUT,
                   "capture_note": {"type": "string"},
                   "post_save_check": {
        "type": "object",
        "description": "Collaborators' merged manual_changes + lint issues on touched pages.",
        "properties": {"manual_changes": {"type": "array"}, "manual_change_count": {"type": "integer"},
                       "issues": {"type": "array"}, "issue_count": {"type": "integer"},
                       "error_count": {"type": "integer"}, "dom_verified": {"type": "boolean"},
                       "next_step": {"type": "string"}}}},
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


# ---- read bases (edit_revision) -----------------------------------------------------
# What get_board returned, kept briefly in THIS process so update_board can send
# it as base_diagram: the server then 3-way merges only the agent's changes onto
# the live board, even while people autosave it. noddle draw has no tokens, so
# a base is bound to the backend it was read through (origin + agent name).
_READ_BASES: "OrderedDict[str, Dict[str, Any]]" = OrderedDict()
_READ_LOCK = threading.Lock()
_READ_TTL_S = 600.0
_READ_CAP = 12


def _identity(b: Backend) -> str:
    return getattr(b, "read_identity", None) or f"{b.base_url}|{b.agent_name}"


def _remember(b: Backend, doc_id: str, updated: Any, diagram: Any) -> str:
    revision = uuid.uuid4().hex
    with _READ_LOCK:
        now = time.monotonic()
        for key in list(_READ_BASES):
            if now - _READ_BASES[key]["at"] > _READ_TTL_S:
                del _READ_BASES[key]
        _READ_BASES[revision] = {"identity": _identity(b), "doc_id": doc_id, "updated_at": updated,
                                 "diagram": copy.deepcopy(diagram), "at": now}
        while len(_READ_BASES) > _READ_CAP:
            _READ_BASES.popitem(last=False)
    return revision


def _read_base(b: Backend, doc_id: str, a: Dict[str, Any]) -> Tuple[bool, Any]:
    """(True, base) for the edit_revision given — or, without one, the newest
    read of this board at ``expected_updated_at``. (False, None) ⇒ no base."""
    revision = a.get("edit_revision")
    with _READ_LOCK:
        items = ([_READ_BASES.get(revision)] if revision
                 else [v for _, v in reversed(list(_READ_BASES.items()))])
        for item in items:
            if (item and item["identity"] == _identity(b) and item["doc_id"] == doc_id
                    and time.monotonic() - item["at"] < _READ_TTL_S):
                if revision or item["updated_at"] == a.get("expected_updated_at"):
                    return True, copy.deepcopy(item["diagram"])
    if revision:
        raise ToolError("The edit revision expired. Call get_board and reapply your change.")
    return False, None


# ---- semantic metadata & fast summary reads ----------------------------------------
# Three optional levels (mirrors web/src/editor-core/diagram/types.ts):
#   diagram root ``metadata`` {category, summary, domain, tags, owner, version, links, custom},
#   page ``metadata`` {category, summary, tags, notes, custom}, node/edge ``meta`` (flat
#   Record<string, primitive | primitive[]>). The SERVER bounds and sanitizes everything on
#   save (backend/app/domain/diagram_metadata.py); this side only merges and reads it.

PREVIEW_UI_URI = "ui://noddle/preview"
PREVIEW_UI_MIME = "text/html;profile=mcp-app"
UI_META = {"ui": {"resourceUri": PREVIEW_UI_URI}}


def _merge_metadata(current: Any, patch: Any) -> Dict[str, Any]:
    """Shallow merge: non-null keys overwrite, keys set to ``None`` are removed."""
    out = copy.deepcopy(current) if isinstance(current, dict) else {}
    if isinstance(patch, dict):
        for k, v in patch.items():
            if v is None:
                out.pop(k, None)
            else:
                out[k] = copy.deepcopy(v)
    return out


def _set_metadata_on(holder: Dict[str, Any], patch: Any) -> None:
    merged = _merge_metadata(holder.get("metadata"), patch)
    if merged:
        holder["metadata"] = merged
    else:
        holder.pop("metadata", None)


def _root_metadata(diagram: Any) -> Optional[Dict[str, Any]]:
    meta = diagram.get("metadata") if isinstance(diagram, dict) else None
    return copy.deepcopy(meta) if isinstance(meta, dict) and meta else None


def _record_role(obj: Dict[str, Any]) -> None:
    """The ``role`` styling shorthand is ALSO semantics: keep it as ``meta.role``
    (merged with any caller-supplied ``meta``) before the style expansion strips it."""
    role = obj.get("role")
    if not isinstance(role, str) or not role.strip():
        return
    meta = dict(obj["meta"]) if isinstance(obj.get("meta"), dict) else {}
    meta["role"] = role.strip()[:64]
    obj["meta"] = meta


_SUMMARY_DECOR_KINDS = {"line", "curve", "curveDown", "freedraw"}
_SUMMARY_CONTAINER_ROLES = {
    "zone", "vpc", "group", "cluster", "layer", "frame", "lane", "tier", "boundary",
    "region", "subnet", "phase", "stage", "track", "swimlane",
}
_SUMMARY_KIND_ROLES = {
    "cylinder": "database", "storedData": "datastore", "internalStorage": "datastore",
    "queue": "queue", "actor": "actor", "cloud": "external", "diamond": "decision",
    "terminator": "terminal", "document": "document", "multiDocument": "document",
    "parallelogram": "io", "manualInput": "input", "display": "output", "shield": "security",
    "hexagon": "preparation", "component": "component", "package": "package",
    "umlClass": "class", "table": "table", "tableHeader": "table", "sticky": "note",
    "note": "note", "callout": "note", "delay": "delay", "offPage": "connector",
    "merge": "merge", "loopLimit": "loop",
}
_SUMMARY_NODE_CAP = 200
_SUMMARY_FLOW_CAP = 300


def _one_line(text: Any, cap: int = 80) -> str:
    s = " ".join(str(text or "").split())
    return s if len(s) <= cap else s[: cap - 1] + "…"


def _summary_container(n: Dict[str, Any]) -> bool:
    """Could hold other nodes: an explicit container role, or a big hollow outline."""
    if n.get("kind") in _SUMMARY_DECOR_KINDS or n.get("kind") in ("icon", "image"):
        return False
    meta = n.get("meta") if isinstance(n.get("meta"), dict) else {}
    if str(meta.get("role") or "").strip().lower() in _SUMMARY_CONTAINER_ROLES:
        return True
    try:
        big = float(n.get("w") or 0) >= 200 and float(n.get("h") or 0) >= 100
    except (TypeError, ValueError):
        return False
    return big and n.get("fill") in (None, "", "transparent", "none") and not _is_text_only(n)


def _summarize_page(p: Dict[str, Any]) -> Dict[str, Any]:
    """One page as a compact semantic graph — groups, nodes, flows — and no geometry.

    Explicit ``meta`` / page ``metadata`` win; a legacy board without any still
    reads well: groups come from frame containment (titled by the frame's own
    text or its title label), roles from the shape kind."""
    nodes = [n for n in p.get("nodes") or [] if isinstance(n, dict) and isinstance(n.get("id"), str)]
    edges = [e for e in p.get("edges") or [] if isinstance(e, dict) and isinstance(e.get("id"), str)]
    by = {n["id"]: n for n in nodes}
    boxes = {n["id"]: _box(n) for n in nodes}
    cands = [n["id"] for n in nodes if boxes[n["id"]] and _summary_container(n)]

    # innermost container fully holding each node
    parent: Dict[str, str] = {}
    for n in nodes:
        b = boxes[n["id"]]
        if not b:
            continue
        best: Optional[str] = None
        for cid in cands:
            cb = boxes[cid]
            if cid == n["id"] or not _contains(cb, b) or _area(cb) <= _area(b):
                continue
            if best is None or _area(cb) < _area(boxes[best]):
                best = cid
        if best:
            parent[n["id"]] = best
    containers = [cid for cid in cands if cid in parent.values()]

    # A text-only title inside (top band) or straddling the top edge names its frame.
    title_of: Dict[str, str] = {}
    titled: Dict[str, str] = {}
    for cid in containers:
        if _one_line(by[cid].get("text")):
            continue
        cx0, cy0, cx1, cy1 = boxes[cid]
        band = max(48.0, (cy1 - cy0) * 0.25)
        # (rank, top) — a title INSIDE the top band beats one straddling the top
        # edge; a free label merely ABOVE the frame (e.g. the board title) never counts.
        best_t: Optional[Tuple[Tuple[int, float], str]] = None
        for n in nodes:
            nid, b = n["id"], boxes[n["id"]]
            if not b or nid in title_of or nid == cid or not _is_text_only(n) or not _one_line(n.get("text")):
                continue
            inside = parent.get(nid) == cid and b[1] - cy0 <= band
            straddles = (nid not in parent and b[1] <= cy0 + 4 and b[3] >= cy0 - 4
                         and b[0] >= cx0 - 8 and b[2] <= cx1 + 8)
            if not (inside or straddles):
                continue
            rank = (0 if inside else 1, b[1])
            if best_t is None or rank < best_t[0]:
                best_t = (rank, nid)
        if best_t:
            title_of[best_t[1]] = cid
            titled[cid] = best_t[1]

    connected = set()
    for e in edges:
        for end in ("source", "target"):
            att = e.get(end)
            if isinstance(att, dict) and att.get("nodeId"):
                connected.add(att["nodeId"])

    def label_of(nid: str) -> str:
        n = by.get(nid)
        if n is None:
            return f"?{nid}"
        text = _one_line(n.get("text"), 40) or (_one_line(by[titled[nid]].get("text"), 40) if nid in titled else "")
        return text or f"{n.get('kind') or 'node'}:{nid}"

    counts: Dict[str, int] = {}
    for n in nodes:
        lbl = label_of(n["id"])
        counts[lbl] = counts.get(lbl, 0) + 1

    def flow_name(nid: str) -> str:
        lbl = label_of(nid)
        return f"{lbl} #{nid}" if counts.get(lbl, 0) > 1 else lbl

    inferred: List[str] = []
    groups: List[Dict[str, Any]] = []
    group_of: Dict[str, str] = {}
    for cid in containers:
        c = by[cid]
        members = [nid for nid, par in parent.items() if par == cid and nid not in title_of]
        g: Dict[str, Any] = {"id": cid, "label": label_of(cid) if (_one_line(c.get("text")) or cid in titled) else "",
                             "members": members}
        if parent.get(cid):
            g["parent"] = parent[cid]
        if isinstance(c.get("meta"), dict) and c["meta"]:
            g["meta"] = copy.deepcopy(c["meta"])
        groups.append(g)
        for nid in members:
            group_of[nid] = cid
    if groups:
        inferred.append("groups")
    # explicit semantic groups (node.meta.group), then ⌘G groups (shared groupId)
    by_meta: Dict[str, List[str]] = {}
    by_gid: Dict[str, List[str]] = {}
    for n in nodes:
        meta = n.get("meta") if isinstance(n.get("meta"), dict) else {}
        if isinstance(meta.get("group"), str) and meta["group"].strip():
            by_meta.setdefault(meta["group"].strip(), []).append(n["id"])
        elif isinstance(n.get("groupId"), str) and n["id"] not in containers:
            by_gid.setdefault(n["groupId"], []).append(n["id"])
    for name, members in by_meta.items():
        groups.append({"id": f"group:{name}", "label": name, "members": members})
        for nid in members:
            group_of.setdefault(nid, f"group:{name}")
    for gid, members in by_gid.items():
        if len(members) < 2:
            continue
        groups.append({"id": gid, "label": "", "members": members})
        for nid in members:
            group_of.setdefault(nid, gid)

    out_nodes: List[Dict[str, Any]] = []
    omitted = 0
    roles_inferred = False
    for n in nodes:
        nid = n["id"]
        if nid in title_of or nid in containers:
            continue
        explicit = n.get("meta") if isinstance(n.get("meta"), dict) else {}
        text = _one_line(n.get("text"))
        if not (text or explicit or nid in connected or n.get("iconKey")):
            omitted += 1  # decoration: unlabeled, unconnected, unannotated
            continue
        entry: Dict[str, Any] = {"id": nid}
        if text:
            entry["text"] = text
        entry["kind"] = n.get("kind") or "rect"
        if nid in group_of:
            entry["group"] = group_of[nid]
        meta = copy.deepcopy(explicit)
        if "role" not in meta:
            role = _SUMMARY_KIND_ROLES.get(str(n.get("kind")))
            if role is None and _is_text_only(n) and n.get("kind") not in _SUMMARY_DECOR_KINDS and text:
                role = "label"
            if role:
                meta["role"] = role
                roles_inferred = True
        if n.get("kind") == "icon" and isinstance(n.get("iconKey"), str) and "icon" not in meta:
            meta["icon"] = n["iconKey"]
        if meta:
            entry["meta"] = meta
        out_nodes.append(entry)
    if roles_inferred:
        inferred.append("roles")

    flows: List[str] = []
    edge_meta: List[Dict[str, Any]] = []
    for e in edges:
        ends = []
        for end in ("source", "target"):
            att = e.get(end)
            if isinstance(att, dict) and att.get("nodeId"):
                ends.append(flow_name(str(att["nodeId"])))
            else:
                ends.append("(point)")
        texts = [_one_line(e.get("label"), 32)] if _one_line(e.get("label")) else []
        texts += [_one_line(b.get("text"), 32) for b in (e.get("labels") or [])
                  if isinstance(b, dict) and _one_line(b.get("text"))]
        label = " / ".join(texts)
        end_head = e["endHead"] != "none" if isinstance(e.get("endHead"), str) else e.get("endArrow", True) is not False
        start_head = e["startHead"] != "none" if isinstance(e.get("startHead"), str) else bool(e.get("startArrow"))
        left = "<--" if start_head else "--"
        right = "-->" if end_head else "--"
        mid = f"{left}[{label}]{right}" if label else (left + right[2:] if right != "--" else left)
        flows.append(f"{ends[0]} {mid} {ends[1]}")
        if isinstance(e.get("meta"), dict) and e["meta"]:
            edge_meta.append({"id": e["id"], "flow": flows[-1], "meta": copy.deepcopy(e["meta"])})

    page: Dict[str, Any] = {"id": p.get("id"), "name": p.get("name")}
    if p.get("hidden") is True:
        page["hidden"] = True
    if isinstance(p.get("metadata"), dict) and p["metadata"]:
        page["metadata"] = copy.deepcopy(p["metadata"])
    page.update({"node_count": len(nodes), "edge_count": len(edges), "groups": groups,
                 "nodes": out_nodes[:_SUMMARY_NODE_CAP], "flows": flows[:_SUMMARY_FLOW_CAP]})
    if edge_meta:
        page["edges"] = edge_meta[:_SUMMARY_FLOW_CAP]
    if omitted:
        page["omitted_decorations"] = omitted
    if inferred:
        page["inferred"] = inferred
    if len(out_nodes) > _SUMMARY_NODE_CAP or len(flows) > _SUMMARY_FLOW_CAP:
        page["truncated"] = True
    return page


def t_read_board_summary(b: Backend, a: Dict[str, Any]) -> Dict[str, Any]:
    doc_id = resolve_doc_id(b, a["doc_id"])
    doc = b.call("GET", f"/api/documents/{doc_id}")
    meta = meta_of(doc)
    diagram = doc.get("diagram")
    pages = pages_of(diagram)
    root = _root_metadata(diagram)
    if a.get("page_id") is not None:
        pages = [p for p in pages if p.get("id") == a["page_id"]]
        if not pages:
            raise ToolError(f"page {a['page_id']!r} not found; pages: {[p.get('id') for p in pages_of(diagram)]}")
    out: Dict[str, Any] = {
        "id": doc_id, "name": meta.get("name"), "url": b.board_url(doc_id),
        "preview_url": f"{b.base_url}/embed/{doc_id}",
        "my_role": doc.get("my_role"), "updated_at": meta.get("updated_at"),
    }
    KNOWN.remember(doc_id, meta.get("name"), meta.get("updated_at"))
    # The read base is always the WHOLE board (a page_id read still merges correctly).
    out["edit_revision"] = _remember(b, doc_id, meta.get("updated_at"), diagram)
    if root:
        out["metadata"] = root
    out["pages"] = [_summarize_page(p) for p in pages]
    return out


PREVIEW_HTML = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>noddle board</title>
<style>
  :root { --ink:#2d3142; --muted:#4f5d75; --soft:#7a8399; --accent:#6965db; --line:#e3e5ec;
          --paper:#ffffff; --chip:#f1f0fd; color-scheme: light dark; }
  @media (prefers-color-scheme: dark) {
    :root { --ink:#eceef4; --muted:#b8bfd0; --soft:#8b93a7; --line:#3a3f4e; --paper:#1f222b; --chip:#2e2d4a; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.45 Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
         color: var(--ink); background: transparent; }
  .card { background: var(--paper); border: 1px solid var(--line); border-radius: 14px; padding: 10px 12px;
          display: flex; flex-direction: column; gap: 8px; width: 100%; margin: 0; }
  header { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .logo { width: 28px; height: 28px; border-radius: 8px; display: grid; place-items: center; flex: none;
          background: var(--accent); color: #fff; font-weight: 700; }
  .title { flex: 1 1 200px; min-width: 0; }
  h1 { font-size: 15px; margin: 0; font-weight: 650; overflow-wrap: anywhere; line-height: 1.3; }
  .sub { margin: 0; color: var(--soft); font-size: 12px; }
  .tools { display: flex; align-items: center; gap: 6px; flex: none; margin-left: auto; }
  .zoom { display: inline-flex; border: 1px solid var(--line); border-radius: 9px; overflow: hidden; }
  .zbtn { background: transparent; color: var(--ink); border: 0; border-right: 1px solid var(--line);
          font: inherit; font-size: 13px; font-weight: 600; min-width: 30px; padding: 5px 8px; cursor: pointer; }
  .zbtn:last-child { border-right: 0; }
  .zbtn:hover { background: var(--chip); }
  .zbtn[aria-pressed="true"] { color: var(--accent); }
  .zbtn:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .summary { margin: 0; color: var(--muted); }
  .tags { display: flex; flex-wrap: wrap; gap: 6px; margin: 0; padding: 0; list-style: none; }
  .tags li { background: var(--chip); color: var(--accent); border-radius: 999px; padding: 2px 10px; font-size: 12px; }
  figure { margin: 0; border: 1px solid var(--line); border-radius: 10px; overflow: auto; background: #f5f5f5;
           min-height: 380px; display: flex; align-items: center; justify-content: center; position: relative; }
  figure img { display: block; width: 100%; height: auto; max-height: 760px; object-fit: contain;
               transition: width 0.12s ease; cursor: zoom-in; }
  figure.zoomed { display: block; max-height: 760px; cursor: grab; scroll-behavior: auto; }
  figure.zoomed img { max-width: none; cursor: zoom-out; }
  figure.panning, figure.panning img { cursor: grabbing; user-select: none; }
  .loading { color: #7a8399; font-size: 13px; margin: 0; }
  .flows { margin: 0; padding-left: 18px; color: var(--muted); font: 12px/1.5 ui-monospace, Menlo, monospace; }
  .btn { display: inline-flex; align-items: center; gap: 6px; background: var(--accent); color: #fff; white-space: nowrap;
         text-decoration: none; border: 0; border-radius: 9px; padding: 6px 12px; font: inherit; font-size: 13px;
         font-weight: 600; cursor: pointer; }
  .btn:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
  .muted { color: var(--soft); margin: 0; font-size: 13px; }
  .error { color: #dc2626; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<main id="card" class="card" aria-live="polite">
  <header>
    <span class="logo" aria-hidden="true">&#9671;</span>
    <div class="title"><h1 id="name">noddle board</h1><p id="sub" class="sub"></p></div>
    <div class="tools">
      <div id="zoom" class="zoom" role="group" aria-label="Zoom" hidden>
        <button id="zoomOut" class="zbtn" type="button" aria-label="Zoom out" title="Zoom out">&#8722;</button>
        <button id="zoomFit" class="zbtn" type="button" aria-pressed="true" title="Fit the whole diagram">Fit</button>
        <button id="zoomIn" class="zbtn" type="button" aria-label="Zoom in" title="Zoom in">+</button>
      </div>
      <a id="open" class="btn" href="#" target="_blank" rel="noopener noreferrer" hidden>Open in noddle &#8599;</a>
    </div>
  </header>
  <p id="summary" class="summary" hidden></p>
  <ul id="tags" class="tags" hidden></ul>
  <figure id="shot" hidden>
    <img id="img" alt="Rendered board preview" hidden>
    <p id="loading" class="loading" hidden>Rendering diagram preview&#8230;</p>
  </figure>
  <ol id="flows" class="flows" hidden></ol>
  <p id="status" class="muted">Waiting for board data&#8230;</p>
</main>
<script>
(function () {
  "use strict";
  // Zero dependencies. Untrusted values only ever reach the DOM through
  // textContent or validated attributes — never parsed as markup.
  var $ = function (id) { return document.getElementById(id); };
  var seq = 1, initId = null, openUrl = null;
  var captureReqId = null, capturedKey = null;
  var ZOOMS = [100, 125, 150, 200, 300], zoomPct = 100;
  var embedded = window.parent && window.parent !== window;

  function post(msg) { if (embedded) { try { window.parent.postMessage(msg, "*"); } catch (e) {} } }
  function request(method, params) { var id = seq++; post({ jsonrpc: "2.0", id: id, method: method, params: params || {} }); return id; }
  function notify(method, params) { post({ jsonrpc: "2.0", method: method, params: params || {} }); }
  function str(v, cap) { return typeof v === "string" ? v.slice(0, cap || 300) : ""; }
  function safeUrl(u) {
    try { var x = new URL(String(u)); return (x.protocol === "https:" || x.protocol === "http:") ? x.href : null; }
    catch (e) { return null; }
  }
  // Measure the card itself: some hosts clamp documentElement.scrollHeight to the
  // current iframe viewport, which would pin a short iframe forever.
  function reportSize() {
    var card = $("card");
    var rect = card.getBoundingClientRect();
    var h = Math.ceil(Math.max(rect.height, card.scrollHeight, $("shot").hidden ? 140 : 460)) + 4;
    var w = Math.ceil(Math.max(rect.width, document.documentElement.scrollWidth));
    notify("ui/notifications/size-changed", { width: w, height: h });
  }
  function scheduleSize() {
    reportSize();
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(reportSize);
    setTimeout(reportSize, 80);
  }

  function structured(result) {
    if (result && typeof result.structuredContent === "object" && result.structuredContent) return result.structuredContent;
    var content = (result && result.content) || [];
    for (var i = 0; i < content.length; i++) {
      if (content[i] && content[i].type === "text") { try { return JSON.parse(content[i].text); } catch (e) {} }
    }
    return result && typeof result === "object" ? result : {};
  }
  function imageOf(result) {
    var content = (result && result.content) || [];
    for (var i = 0; i < content.length; i++) {
      var c = content[i];
      if (c && c.type === "image" && /^image\\/(png|jpeg|webp)$/.test(c.mimeType || "") &&
          typeof c.data === "string" && /^[A-Za-z0-9+\\/=]+$/.test(c.data)) return "data:" + c.mimeType + ";base64," + c.data;
    }
    return null;
  }
  function dims(sc) {
    var src = (sc && sc.capture && typeof sc.capture === "object") ? sc.capture : sc;
    var w = src && +src.width, h = src && +src.height;
    return (w > 0 && h > 0 && isFinite(w) && isFinite(h)) ? [w, h] : null;
  }

  // ---- zoom: Fit = whole image visible; zoomed = native scroll + drag-to-pan ----
  function applyZoom(pct) {
    var img = $("img"), fig = $("shot");
    var cx = fig.scrollWidth ? (fig.scrollLeft + fig.clientWidth / 2) / fig.scrollWidth : 0.5;
    var cy = fig.scrollHeight ? (fig.scrollTop + fig.clientHeight / 2) / fig.scrollHeight : 0.5;
    zoomPct = pct;
    if (pct <= 100) {
      zoomPct = 100;
      img.style.width = "100%"; img.style.maxHeight = "760px";
      fig.classList.remove("zoomed");
    } else {
      img.style.width = pct + "%"; img.style.maxHeight = "none";
      fig.classList.add("zoomed");
      fig.scrollLeft = cx * fig.scrollWidth - fig.clientWidth / 2;
      fig.scrollTop = cy * fig.scrollHeight - fig.clientHeight / 2;
    }
    $("zoomFit").setAttribute("aria-pressed", zoomPct === 100 ? "true" : "false");
    $("zoomFit").title = zoomPct === 100 ? "Fit the whole diagram" : "Zoom " + zoomPct + "% \\u2014 click to fit";
    scheduleSize();
  }
  function stepZoom(dir) {
    var i = ZOOMS.indexOf(zoomPct); if (i < 0) i = 0;
    applyZoom(ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, i + dir))]);
  }
  $("zoomIn").addEventListener("click", function () { stepZoom(1); });
  $("zoomOut").addEventListener("click", function () { stepZoom(-1); });
  $("zoomFit").addEventListener("click", function () { applyZoom(100); });

  var pan = null, dragged = false;
  $("shot").addEventListener("pointerdown", function (ev) {
    if (zoomPct === 100 || ev.button !== 0) return;
    var fig = $("shot");
    pan = { x: ev.clientX, y: ev.clientY, l: fig.scrollLeft, t: fig.scrollTop, id: ev.pointerId };
    dragged = false;
  });
  $("shot").addEventListener("pointermove", function (ev) {
    if (!pan || ev.pointerId !== pan.id) return;
    var dx = ev.clientX - pan.x, dy = ev.clientY - pan.y, fig = $("shot");
    if (!dragged && Math.abs(dx) + Math.abs(dy) > 4) {
      dragged = true; fig.classList.add("panning");
      try { fig.setPointerCapture(pan.id); } catch (e) {}
    }
    if (dragged) { ev.preventDefault(); fig.scrollLeft = pan.l - dx; fig.scrollTop = pan.t - dy; }
  });
  function endPan() { pan = null; $("shot").classList.remove("panning"); }
  $("shot").addEventListener("pointerup", endPan);
  $("shot").addEventListener("pointercancel", endPan);
  $("img").addEventListener("dragstart", function (ev) { ev.preventDefault(); });
  $("img").addEventListener("click", function () {
    if (dragged) { dragged = false; return; }
    applyZoom(zoomPct === 100 ? 200 : 100);
  });

  // ---- image display ----
  function showImage(src, wh) {
    var img = $("img");
    img.style.aspectRatio = wh ? wh[0] + " / " + wh[1] : "";
    img.hidden = false;
    img.src = src;
    $("loading").hidden = true;
    $("shot").hidden = false;
    $("zoom").hidden = false;
    $("flows").hidden = true;
    applyZoom(100);
  }
  function previewUnavailable() {
    $("shot").hidden = true; $("zoom").hidden = true; $("img").hidden = true;
    $("flows").hidden = !$("flows").children.length;
    var status = $("status");
    status.textContent = "Preview unavailable \\u2014 open the board in noddle to view it.";
    status.className = "muted"; status.hidden = false;
    scheduleSize();
  }
  $("img").addEventListener("load", scheduleSize);
  $("img").addEventListener("error", function () { if ($("img").getAttribute("src")) previewUnavailable(); else scheduleSize(); });

  function onCaptureResult(res) {
    captureReqId = null;
    var png = res && !res.isError ? imageOf(res) : null;
    if (png) showImage(png, dims(structured(res))); else previewUnavailable();
  }
  // The model forgot capture=true: ask the host to run capture_board for us.
  function autoCapture(sc) {
    var key = sc.id + "@" + (sc.updated_at || "");
    if (key === capturedKey) return;
    capturedKey = key;
    var args = { doc_id: sc.id, include_lint: false };
    var pid = (sc.capture && typeof sc.capture.page_id === "string") ? sc.capture.page_id
            : (typeof sc.page_id === "string" ? sc.page_id : null);
    if (pid) args.page_id = pid.slice(0, 128);
    $("img").hidden = true; $("loading").hidden = false; $("shot").hidden = false; $("zoom").hidden = true;
    if (window.openai && typeof window.openai.callTool === "function") {
      try {
        Promise.resolve(window.openai.callTool("capture_board", args)).then(onCaptureResult, previewUnavailable);
      } catch (e) { previewUnavailable(); }
      return;
    }
    if (!embedded) { previewUnavailable(); return; }
    captureReqId = request("tools/call", { name: "capture_board", arguments: args });
    setTimeout(function () { if (captureReqId !== null && $("img").hidden) { captureReqId = null; previewUnavailable(); } }, 45000);
  }

  function render(result) {
    if (!result || typeof result !== "object") return;
    var status = $("status");
    if (result.isError) {
      var msg = (result.content && result.content[0] && result.content[0].text) || "The tool call failed.";
      status.textContent = str(msg, 500); status.className = "muted error"; status.hidden = false; scheduleSize(); return;
    }
    var sc = structured(result) || {};
    var md = (sc.metadata && typeof sc.metadata === "object") ? sc.metadata : {};
    var pages = Array.isArray(sc.pages) ? sc.pages : [];
    $("name").textContent = str(sc.name, 200) || "noddle board";
    var nodes = 0, edges = 0;
    pages.forEach(function (p) { nodes += +p.node_count || 0; edges += +p.edge_count || 0; });
    var sub = [];
    if (md.category) sub.push(str(md.category, 64));
    if (md.domain) sub.push(str(md.domain, 64));
    if (pages.length) sub.push(pages.length + (pages.length === 1 ? " page" : " pages") + " \\u00b7 " + nodes + " shapes \\u00b7 " + edges + " connectors");
    $("sub").textContent = sub.join(" \\u00b7 ");
    var summary = str(md.summary, 1000) || (pages[0] && pages[0].metadata && str(pages[0].metadata.summary, 1000)) || "";
    $("summary").textContent = summary; $("summary").hidden = !summary;
    var tags = $("tags"); tags.textContent = "";
    (Array.isArray(md.tags) ? md.tags : []).slice(0, 12).forEach(function (t) {
      var li = document.createElement("li"); li.textContent = str(t, 64); tags.appendChild(li);
    });
    tags.hidden = !tags.children.length;
    var png = imageOf(result);
    var flows = $("flows"); flows.textContent = "";
    var list = (pages[0] && Array.isArray(pages[0].flows)) ? pages[0].flows : [];
    list.slice(0, 8).forEach(function (f) {
      var li = document.createElement("li"); li.textContent = str(f, 160); flows.appendChild(li);
    });
    flows.hidden = true;
    openUrl = safeUrl(sc.url) || safeUrl(sc.preview_url);
    var open = $("open");
    if (openUrl) { open.href = openUrl; open.hidden = false; } else { open.hidden = true; }
    status.hidden = true;
    var validId = typeof sc.id === "string" && /^[0-9a-f]{12}$/.test(sc.id);
    if (png) {
      if (validId) capturedKey = sc.id + "@" + (sc.updated_at || "");
      showImage(png, dims(sc));
    } else if (validId) {
      autoCapture(sc);
    } else {
      $("shot").hidden = true; $("zoom").hidden = true;
      flows.hidden = !flows.children.length;
    }
    scheduleSize();
  }

  $("open").addEventListener("click", function (ev) {
    if (!openUrl) return;
    if (window.openai && typeof window.openai.openExternal === "function") {
      ev.preventDefault(); window.openai.openExternal({ href: openUrl }); return;
    }
    if (embedded) { ev.preventDefault(); request("ui/open-link", { url: openUrl }); }
  });

  window.addEventListener("message", function (ev) {
    if (embedded && ev.source !== window.parent) return;
    var m = ev.data;
    if (!m || typeof m !== "object" || m.jsonrpc !== "2.0") return;
    if (m.method === "ui/notifications/tool-result") { render(m.params); return; }
    if (m.id !== undefined && m.id === captureReqId) {
      if (m.result) onCaptureResult(m.result); else { captureReqId = null; previewUnavailable(); }
      return;
    }
    if (m.id !== undefined && m.id === initId && m.result) { notify("ui/notifications/initialized", {}); scheduleSize(); }
  });

  if (typeof ResizeObserver !== "undefined") new ResizeObserver(reportSize).observe($("card"));
  window.addEventListener("resize", reportSize);

  // ChatGPT Apps SDK hosts expose the result on window.openai instead.
  function fromOpenAI() {
    var o = window.openai;
    if (o && o.toolOutput && typeof o.toolOutput === "object") render({ structuredContent: o.toolOutput, content: [] });
  }
  window.addEventListener("openai:set_globals", fromOpenAI);
  fromOpenAI();

  initId = request("ui/initialize", {
    protocolVersion: "2026-01-26",
    appInfo: { name: "noddle-preview", version: "1.1.0" },
    appCapabilities: {}
  });
})();
</script>
</body>
</html>
"""


# ---- style presets, category themes & deterministic layout hygiene ----------------
# Mirrors backend/app/domain/board_palette.py (guarded by unit test for zero drift).

STYLE_GUIDE_URI = "noddle://style-guide"
PALETTE_INK = "#2d3142"
PALETTE_STROKES = ("#2d3142", "#dc2626", "#16a34a", "#2563eb", "#eb6c36")
PALETTE_FILLS = ("transparent", "#ffffff", "#fee2e2", "#dcfce7", "#dbeafe", "#fef9c3")
_PALETTE_SET = {c.lower() for c in (*PALETTE_STROKES, *PALETTE_FILLS)}
_PALETTE_FAMILY = {
    "ink": ("#2d3142", "#ffffff"),
    "red": ("#dc2626", "#fee2e2"),
    "green": ("#16a34a", "#dcfce7"),
    "blue": ("#2563eb", "#dbeafe"),
    "ember": ("#eb6c36", "#fef9c3"),
}

STYLE_PRESETS: Dict[str, Dict[str, Any]] = {
    "ink": {"fill": "#ffffff", "stroke": "#2d3142", "textColor": "#2d3142", "strokeWidth": 2, "sketch": True, "cornerRadius": 12},
    "blue": {"fill": "#dbeafe", "stroke": "#2563eb", "textColor": "#2d3142", "strokeWidth": 2, "sketch": True, "cornerRadius": 12},
    "green": {"fill": "#dcfce7", "stroke": "#16a34a", "textColor": "#2d3142", "strokeWidth": 2, "sketch": True, "cornerRadius": 12},
    "ember": {"fill": "#fef9c3", "stroke": "#eb6c36", "textColor": "#2d3142", "strokeWidth": 2, "sketch": True, "cornerRadius": 12},
    "red": {"fill": "#fee2e2", "stroke": "#dc2626", "textColor": "#2d3142", "strokeWidth": 2, "sketch": True, "cornerRadius": 12},
    "frame": {"fill": "transparent", "stroke": "#2d3142", "textColor": "#2d3142", "strokeWidth": 1.5, "strokeDash": "dashed", "sketch": True, "cornerRadius": 12},
    "label": {"fill": "transparent", "stroke": "transparent", "textColor": "#2d3142", "strokeWidth": 0},
}

CATEGORY_THEMES: Dict[str, Dict[str, Dict[str, str]]] = {
    "architecture": {
        "roles": {
            "client": "blue", "source": "blue", "external": "blue", "user": "blue", "edge": "blue", "ingress": "blue",
            "service": "green", "api": "green", "compute": "green", "worker": "green", "backend": "green", "app": "green",
            "focal": "ember", "gateway": "ember", "orchestrator": "ember", "core": "ember", "router": "ember", "hub": "ember",
            "store": "ink", "db": "ink", "database": "ink", "cache": "ink", "queue": "ink", "storage": "ink",
            "security": "red", "auth": "red", "alert": "red", "error": "red", "dlq": "red", "firewall": "red",
            "zone": "frame", "vpc": "frame", "group": "frame", "cluster": "frame", "layer": "frame", "frame": "frame",
            "title": "label", "caption": "label", "label": "label", "subtitle": "label",
        },
        "kinds": {
            "cylinder": "ink", "queue": "ink", "storedData": "ink",
            "cloud": "blue", "actor": "blue",
            "diamond": "ember", "hexagon": "ember",
            "shield": "red",
            "rounded": "green", "rect": "green", "process": "green", "component": "green",
        },
    },
    "flowchart": {
        "roles": {
            "start": "blue", "end": "blue", "trigger": "blue", "input": "blue",
            "step": "ink", "action": "ink", "process": "ink", "task": "ink",
            "decision": "ember", "branch": "ember", "condition": "ember", "gate": "ember",
            "success": "green", "done": "green", "output": "green", "approve": "green",
            "error": "red", "fail": "red", "reject": "red", "rollback": "red", "abort": "red",
            "lane": "frame", "phase": "frame", "stage": "frame", "frame": "frame",
            "title": "label", "caption": "label", "label": "label",
        },
        "kinds": {
            "terminator": "blue", "parallelogram": "blue",
            "diamond": "ember",
            "document": "green", "multiDocument": "green",
            "process": "ink", "rect": "ink", "rounded": "ink",
        },
    },
    "data": {
        "roles": {
            "source": "blue", "ingest": "blue", "raw": "blue", "stream": "blue", "bronze": "blue",
            "transform": "green", "etl": "green", "compute": "green", "silver": "green", "job": "green",
            "gate": "ember", "quality": "ember", "gold": "ember", "curated": "ember", "focal": "ember", "serving": "ember",
            "lake": "ink", "warehouse": "ink", "store": "ink", "sink": "ink", "table": "ink", "db": "ink",
            "dlq": "red", "quarantine": "red", "error": "red", "reject": "red",
            "layer": "frame", "tier": "frame", "zone": "frame", "frame": "frame",
            "title": "label", "caption": "label", "label": "label",
        },
        "kinds": {
            "cloud": "blue", "parallelogram": "blue",
            "cylinder": "ink", "storedData": "ink", "table": "ink",
            "diamond": "ember",
            "queue": "green", "rounded": "green", "process": "green",
        },
    },
    "org": {
        "roles": {
            "exec": "ember", "lead": "ember", "ceo": "ember", "root": "ember", "head": "ember",
            "dept": "blue", "division": "blue", "domain": "blue", "org": "blue",
            "team": "green", "pod": "green", "squad": "green", "group": "green",
            "role": "ink", "ic": "ink", "staff": "ink", "support": "ink", "member": "ink",
            "escalation": "red", "risk": "red", "incident": "red",
            "boundary": "frame", "zone": "frame", "frame": "frame",
            "title": "label", "caption": "label", "label": "label",
        },
        "kinds": {"rounded": "green", "rect": "green", "actor": "blue"},
    },
    "timeline": {
        "roles": {
            "phase": "blue", "quarter": "blue", "sprint": "blue", "stage": "blue",
            "milestone": "ember", "launch": "ember", "release": "ember", "key": "ember",
            "done": "green", "shipped": "green", "live": "green", "active": "green",
            "task": "ink", "planned": "ink", "backlog": "ink",
            "blocker": "red", "risk": "red", "delay": "red", "cut": "red",
            "track": "frame", "lane": "frame", "frame": "frame",
            "title": "label", "caption": "label", "label": "label",
        },
        "kinds": {"diamond": "ember", "ellipse": "green", "rect": "blue", "rounded": "blue"},
    },
}

STYLE_GUIDE_TEXT = """# noddle Diagram Style Guide

Use `category` + `role` (or direct `style`) in `patch_board` / `create_board` so the server applies noddle's exact draw palette, sketch look, and auto-fit sizing.

## Style Presets
- `ink`: `#2d3142` stroke, `#ffffff` fill (neutral / data store / steps)
- `blue`: `#2563eb` stroke, `#dbeafe` fill (clients / sources / start / phases)
- `green`: `#16a34a` stroke, `#dcfce7` fill (services / transforms / success / teams)
- `ember`: `#eb6c36` stroke, `#fef9c3` fill (1-2 focal points / gateways / decisions / milestones)
- `red`: `#dc2626` stroke, `#fee2e2` fill (security / alerts / errors / rollback / blockers)
- `frame`: dashed `#2d3142` stroke, transparent fill (containers / zones / lanes)
- `label`: transparent fill & stroke, `#2d3142` text (titles / captions — use `kind: "rect"`)

## Category Role Maps (`category` param)
- `architecture`: client/source=`blue`, service/api=`green`, gateway/focal=`ember`, db/cache/queue=`ink`, auth/alert=`red`, zone=`frame`
- `flowchart`: start/end=`blue`, step=`ink`, decision=`ember`, success=`green`, error/reject=`red`, lane=`frame`
- `data`: source/raw=`blue`, transform/etl=`green`, quality/gold=`ember`, lake/warehouse=`ink`, dlq/error=`red`, tier=`frame`
- `org`: exec/lead=`ember`, dept=`blue`, team/pod=`green`, role/support=`ink`, escalation=`red`
- `timeline`: phase=`blue`, milestone=`ember`, done/active=`green`, task=`ink`, blocker/risk=`red`

## Semantic Metadata (read fast, write once)
- Read first with `read_board_summary` (groups, nodes, `A --[HTTPS]--> B` flows, no x/y) — ~90% fewer tokens than `get_board`.
- Diagram: `metadata: {category, summary, domain, tags, owner, version, links}` on create_board / patch_board.
- Page: `page_metadata: {summary, tags, notes}` on patch_board, or op `set_metadata` (+ `page_id`); `null` removes a key.
- Node/edge: `meta: {role, tech, layer, protocol, sla, owner, status, tags, url}` (≤20 keys). `role` shorthand is kept as `meta.role`.

## Concise Text & Layout Rules
- Keep box labels crisp: 2-5 words per line, <=3 lines (use `\\n` for subtitle). No paragraphs in shapes.
- Keep edge labels short (1-3 words, <=14 chars).
- Always differentiate roles by color — never monochrome.
- Coordinates on 4px grid; leave `auto_fit=true` and `auto_layout=true` enabled.
"""

_GRID = 4.0
_LABEL_CHIP_FONT_SIZE = 12
_LABEL_CHIP_PAD = 12
_LABEL_CHIP_CHAR_RATIO = 0.62
_LABEL_CHIP_MIN_W = 18
_LABEL_CHIP_MARGIN = 8
_STROKE_KINDS = {"line", "curve", "curveDown"}
_SHAPE_INSET: Dict[str, Tuple[float, float, float, float]] = {
    # (w_mult, h_mult, extra_w, extra_h)
    "diamond": (1.55, 1.55, 16.0, 12.0),
    "ellipse": (1.25, 1.25, 12.0, 10.0),
    "cloud": (1.25, 1.28, 16.0, 14.0),
    "cylinder": (1.05, 1.0, 8.0, 26.0),
    "hexagon": (1.22, 1.05, 12.0, 6.0),
    "parallelogram": (1.22, 1.0, 14.0, 6.0),
    "trapezoid": (1.22, 1.05, 12.0, 6.0),
    "document": (1.0, 1.0, 6.0, 16.0),
    "multiDocument": (1.05, 1.0, 10.0, 20.0),
}


def _snap4(v: float) -> float:
    return round(v / _GRID) * _GRID


def _ceil4(v: float) -> float:
    return math.ceil(v / _GRID) * _GRID


def _label_chip_width(text: str) -> float:
    return max(_LABEL_CHIP_MIN_W, len(text) * _LABEL_CHIP_FONT_SIZE * _LABEL_CHIP_CHAR_RATIO + _LABEL_CHIP_PAD)


def _min_gap_for_label(text: str) -> float:
    return _label_chip_width(text) + 2 * _LABEL_CHIP_MARGIN


def _hex_rgb(v: str) -> Optional[Tuple[float, float, float]]:
    s = v.strip().lower()
    if len(s) == 4 and s.startswith("#"):
        s = "#" + "".join(ch * 2 for ch in s[1:])
    if len(s) != 7 or not s.startswith("#"):
        return None
    try:
        return (int(s[1:3], 16) / 255.0, int(s[3:5], 16) / 255.0, int(s[5:7], 16) / 255.0)
    except ValueError:
        return None


def _snap_board_color(value: Any, role: str) -> Optional[str]:
    v = str(value or "").strip().lower()
    if not v:
        return None
    if v in ("transparent", "none"):
        return "transparent" if role == "fill" else None
    if v in _PALETTE_SET:
        if role == "text" and v not in {c.lower() for c in PALETTE_STROKES}:
            return PALETTE_INK
        return v
    rgb = _hex_rgb(v)
    if rgb is None:
        return None
    h, l, s = colorsys.rgb_to_hls(*rgb)
    if s < 0.18 or l > 0.97 or l < 0.06:
        fam = "ink"
    else:
        deg = h * 360.0
        if deg < 15 or deg >= 330:
            fam = "red"
        elif deg < 65:
            fam = "ember"
        elif deg < 170:
            fam = "green"
        elif deg < 290:
            fam = "blue"
        else:
            fam = "red"
    if role in ("stroke", "text") and s < 0.35:
        fam = "ink"
    stroke, pastel = _PALETTE_FAMILY[fam]
    if role == "fill":
        if fam == "ink":
            return "#ffffff" if l > 0.6 else "transparent"
        return pastel
    return stroke


def _resolve_style_name(node: Dict[str, Any], category: Optional[str]) -> Optional[str]:
    style = str(node.get("style") or "").strip().lower()
    if style in STYLE_PRESETS:
        return style
    role = str(node.get("role") or "").strip().lower()
    theme = CATEGORY_THEMES.get(str(category or "").strip().lower())
    if role:
        if theme and role in theme["roles"]:
            return theme["roles"][role]
        for t in CATEGORY_THEMES.values():
            if role in t["roles"]:
                return t["roles"][role]
    if theme and not node.get("fill") and not node.get("stroke"):
        if _is_frame(node):
            return "frame"
        return theme["kinds"].get(str(node.get("kind") or "rounded"), "ink")
    return None


def _apply_node_style(node: Dict[str, Any], category: Optional[str], palette: str, is_new: bool = False) -> None:
    if node.get("kind") == "text":
        node["kind"] = "rect"
        node.setdefault("style", "label")
    preset_name = _resolve_style_name(node, category)
    explicit_style = "style" in node or "role" in node
    _record_role(node)  # semantics survive the style expansion as meta.role
    node.pop("style", None)
    node.pop("role", None)
    if preset_name:
        preset = STYLE_PRESETS[preset_name]
        for k, v in preset.items():
            if explicit_style or k not in node or node.get(k) in (None, ""):
                if k == "cornerRadius" and node.get("kind") not in ("rect", "rounded", "process", None):
                    continue
                if k == "sketch" and node.get("kind") in ("icon", "image", "freedraw", "line"):
                    continue
                node[k] = v
    elif is_new:
        # Clean draw defaults when caller omitted paint fields on a new node
        if node.get("kind") not in ("icon", "image", "freedraw"):
            node.setdefault("fill", "#ffffff")
            node.setdefault("stroke", PALETTE_INK)
            node.setdefault("strokeWidth", 2)
            node.setdefault("textColor", PALETTE_INK)
            if node.get("kind") not in ("line", "curve", "curveDown"):
                node.setdefault("sketch", True)
            if node.get("kind") in ("rect", "rounded", "process", None) and "cornerRadius" not in node:
                node["cornerRadius"] = 12
    if palette == "board" and node.get("kind") not in ("icon", "image", "freedraw"):
        for key, role in (("fill", "fill"), ("stroke", "stroke"), ("textColor", "text")):
            if key in node:
                snapped = _snap_board_color(node.get(key), role)
                if snapped is not None:
                    node[key] = snapped
        if not _is_text_only(node) and node.get("kind") not in ("line", "curve", "curveDown"):
            node.setdefault("sketch", True)
            if node.get("kind") in ("rect", "rounded", "process", None) and not node.get("cornerRadius"):
                node["cornerRadius"] = 12


def _apply_edge_style(edge: Dict[str, Any], palette: str, is_new: bool = False) -> None:
    style = str(edge.pop("style", "") or "").strip().lower()
    _record_role(edge)
    edge.pop("role", None)
    if style in _PALETTE_FAMILY:
        edge["stroke"] = _PALETTE_FAMILY[style][0]
    if is_new:
        edge.setdefault("routing", "elbow")
        edge.setdefault("stroke", PALETTE_INK)
        edge.setdefault("strokeWidth", 2)
        edge.setdefault("endArrow", True)
        edge.setdefault("startArrow", False)
        edge.setdefault("animated", False)
    if palette == "board" and "stroke" in edge:
        snapped = _snap_board_color(edge.get("stroke"), "stroke")
        if snapped is not None:
            edge["stroke"] = snapped


def _char_width_em(ch: str, bold: bool, sketch: bool, family: str) -> float:
    base = (0.68 if bold else 0.62) if sketch else (
        0.62 if family == "mono" else (0.60 if bold else 0.55) if family == "serif" else (0.64 if bold else 0.58)
    )
    if ord(ch) > 0x2E7F:
        return base * 1.65
    if ch in "iIl1|!.,;:'` ":
        return base * 0.58
    if ch in "MWmw@#%&":
        return base * 1.32
    if ch.isupper():
        return base * 1.14
    if ord(ch) > 127:
        return base * 1.06
    return base


def _line_width_px(text: str, font_size: float, bold: bool, sketch: bool, family: str, letter_spacing: float = 0.0) -> float:
    if not text:
        return 0.0
    w = sum(_char_width_em(ch, bold, sketch, family) * font_size for ch in text)
    if letter_spacing and len(text) > 1:
        w += letter_spacing * (len(text) - 1)
    return w


def _wrap_lines(text: str, max_w: float, font_size: float, bold: bool, sketch: bool, family: str,
                letter_spacing: float = 0.0) -> List[str]:
    out: List[str] = []
    for para in text.split("\n"):
        words = para.split()
        if not words:
            out.append("")
            continue
        cur = words[0]
        for word in words[1:]:
            cand = f"{cur} {word}"
            if _line_width_px(cand, font_size, bold, sketch, family, letter_spacing) <= max_w:
                cur = cand
            else:
                out.append(cur)
                cur = word
        out.append(cur)
    return out


def _measure_node_text(n: Dict[str, Any], box_w: Optional[float] = None) -> Tuple[float, float, List[str]]:
    """Estimate rendered text dimensions matching NodeView.tsx (default 14px, 1.25 lineHeight, 8px pad)."""
    text = str(n.get("text") or "")
    size = float(n.get("fontSize") or 14)
    bold = bool(n.get("bold"))
    sketch = bool(n.get("sketch"))
    family = str(n.get("fontFamily") or "sans")
    ls = float(n.get("letterSpacing") or 0)
    w = float(box_w if box_w is not None else (n.get("w") or 0))
    if n.get("wrap"):
        lines = _wrap_lines(text, max(24.0, w - 16.0), size, bold, sketch, family, ls)
    else:
        lines = text.split("\n")
    max_line_w = max((_line_width_px(line, size, bold, sketch, family, ls) for line in lines), default=0.0)
    text_h = len(lines) * size * 1.25
    return max_line_w, text_h, lines


def _needed_node_box(n: Dict[str, Any]) -> Tuple[float, float]:
    max_w, text_h, _ = _measure_node_text(n)
    text_only = _is_text_only(n)
    pad_x = 12.0 if text_only else 24.0
    pad_y = 8.0 if text_only else 24.0
    wm, hm, ew, eh = _SHAPE_INSET.get(str(n.get("kind") or "rect"), (1.0, 1.0, 0.0, 0.0))
    if text_only:
        wm, hm, ew, eh = 1.0, 1.0, 0.0, 0.0
    req_w = _ceil4(max_w * wm + pad_x + ew)
    req_h = _ceil4(text_h * hm + pad_y + eh)
    return req_w, req_h


def _auto_fit_node(n: Dict[str, Any]) -> Optional[str]:
    if n.get("kind") in ("freedraw", "image", "icon", *_STROKE_KINDS) or _is_frame(n):
        return None
    text = str(n.get("text") or "").strip()
    if not text:
        return None
    try:
        w, h = float(n["w"]), float(n["h"])
    except (KeyError, TypeError, ValueError):
        return None
    text_only = _is_text_only(n)
    # Long single-line text on a solid shape: enable wrap at a tidy width instead of an ultra-wide banner
    if not text_only and not n.get("wrap") and "\n" not in text and " " in text:
        raw_w, _, _ = _measure_node_text(n)
        if raw_w + 24.0 > max(w, 280.0):
            n["wrap"] = True
            target_w = _ceil4(max(w, min(raw_w + 24.0, 260.0)))
            n["w"] = target_w
            w = target_w
    req_w, req_h = _needed_node_box(n)
    new_w = max(w, req_w)
    new_h = max(h, req_h)
    if new_w != w or new_h != h:
        n["w"], n["h"] = new_w, new_h
        return f"auto_fit {n.get('id')}: {w:.0f}x{h:.0f}->{new_w:.0f}x{new_h:.0f}"
    return None


def _auto_repair_page(page: Dict[str, Any], movable_ids: Optional[set], auto_fit: bool, auto_layout: bool) -> List[str]:
    """Deterministically size text and resolve overlaps/frame straddling on movable objects."""
    nodes = [n for n in (page.get("nodes") or []) if isinstance(n, dict) and n.get("id")]
    edges = [e for e in (page.get("edges") or []) if isinstance(e, dict)]
    by_id = {str(n["id"]): n for n in nodes}
    fixes: List[str] = []

    if auto_fit:
        for nid, n in by_id.items():
            if movable_ids is not None and nid not in movable_ids:
                continue
            note = _auto_fit_node(n)
            if note:
                fixes.append(note)

    if not auto_layout or not nodes:
        return fixes[:12]

    def rect(nid: str) -> Optional[Tuple[float, float, float, float]]:
        n = by_id.get(nid)
        if not n:
            return None
        try:
            return float(n["x"]), float(n["y"]), float(n["w"]), float(n["h"])
        except (KeyError, TypeError, ValueError):
            return None

    def solid(n: Dict[str, Any]) -> bool:
        fill = str(n.get("fill") or "").strip().lower()
        stroke = str(n.get("stroke") or "").strip().lower()
        return (n.get("kind") not in _STROKE_KINDS and n.get("kind") != "freedraw"
                and fill not in ("transparent", "none", "") and stroke not in ("transparent", "none", ""))

    def contains_r(outer: Tuple[float, float, float, float], inner: Tuple[float, float, float, float]) -> bool:
        ox, oy, ow, oh = outer
        ix, iy, iw, ih = inner
        if ow * oh <= iw * ih:
            return False
        t = 2.0
        return ix >= ox - t and iy >= oy - t and ix + iw <= ox + ow + t and iy + ih <= oy + oh + t

    parent: Dict[str, Optional[str]] = {}
    for nid in by_id:
        r = rect(nid)
        if not r:
            parent[nid] = None
            continue
        best: Optional[Tuple[float, str]] = None
        for oid in by_id:
            if oid == nid:
                continue
            orect = rect(oid)
            if orect and contains_r(orect, r):
                area = orect[2] * orect[3]
                if best is None or area < best[0]:
                    best = (area, oid)
        parent[nid] = best[1] if best else None

    def descendants(nid: str) -> List[str]:
        out = [k for k, p in parent.items() if p == nid]
        for k in list(out):
            out.extend(descendants(k))
        return out

    def shift(nid: str, dx: float, dy: float) -> None:
        for k in [nid, *descendants(nid)]:
            n = by_id[k]
            n["x"] = float(n["x"]) + dx
            n["y"] = float(n["y"]) + dy

    def chain(nid: str) -> List[str]:
        out = [nid]
        while parent.get(out[-1]):
            out.append(parent[out[-1]])  # type: ignore[arg-type]
        return out

    def reps_for(aid: str, bid: str) -> Optional[Tuple[str, str]]:
        ca, cb = chain(aid), chain(bid)
        if aid in cb or bid in ca:
            return None
        for x in ca:
            for y in cb:
                if x != y and parent.get(x) == parent.get(y):
                    return (x, y)
        return None

    # Labeled edge min gap requirements
    need_by_pair: Dict[frozenset, float] = {}
    endpoint_ids: set = set()
    for e in edges:
        texts: List[str] = []
        if isinstance(e.get("label"), str) and e["label"].strip():
            texts.append(e["label"])
        for blk in e.get("labels") or []:
            if isinstance(blk, dict) and isinstance(blk.get("text"), str) and blk["text"].strip():
                texts.append(blk["text"])
        s = (e.get("source") or {}).get("nodeId") if isinstance(e.get("source"), dict) else None
        t_ = (e.get("target") or {}).get("nodeId") if isinstance(e.get("target"), dict) else None
        if s in by_id:
            endpoint_ids.add(s)
        if t_ in by_id:
            endpoint_ids.add(t_)
        if texts and s in by_id and t_ in by_id and s != t_:
            need = max(_min_gap_for_label(x) for x in texts)
            key = frozenset((s, t_))
            need_by_pair[key] = max(need_by_pair.get(key, 0.0), need)

    def semantic(nid: str) -> bool:
        return (bool(str(by_id[nid].get("text") or "").strip())
                or nid in endpoint_ids
                or any(bool(str(by_id[d].get("text") or "").strip()) for d in descendants(nid)))

    box_ids = sorted(nid for nid, n in by_id.items() if solid(n) and rect(nid) is not None and semantic(nid))
    rep_pairs: Dict[Tuple[str, str], Tuple[float, Optional[str]]] = {}
    for i in range(len(box_ids)):
        for j in range(i + 1, len(box_ids)):
            r = reps_for(box_ids[i], box_ids[j])
            if r is None:
                continue
            key = (min(r), max(r))
            need = need_by_pair.get(frozenset((box_ids[i], box_ids[j])), 0.0)
            prev = rep_pairs.get(key, (0.0, None))
            rep_pairs[key] = (max(prev[0], need), None)

    if movable_ids is not None:
        restricted: Dict[Tuple[str, str], Tuple[float, Optional[str]]] = {}
        for (aid, bid), (need, mover) in rep_pairs.items():
            a_new, b_new = aid in movable_ids, bid in movable_ids
            if a_new and b_new:
                restricted[(aid, bid)] = (need, None)
            elif a_new or b_new:
                restricted[(aid, bid)] = (need, aid if a_new else bid)
        rep_pairs = restricted

    gap = 28.0
    moved_ids: set = set()
    for _ in range(40):
        moved = False
        for (aid, bid), (pair_need, mover) in sorted(rep_pairs.items()):
            ra, rb = rect(aid), rect(bid)
            if not (ra and rb):
                continue
            ax, ay, aw, ah = ra
            bx, by_, bw, bh = rb
            gx = max(bx - (ax + aw), ax - (bx + bw))
            gy = max(by_ - (ay + ah), ay - (by_ + bh))
            overlap = gx < 0 and gy < 0
            need = max(pair_need, gap) if overlap else pair_need
            if not overlap and (need <= 0 or max(gx, gy) >= need):
                continue
            dx_need, dy_need = need - gx, need - gy
            axis = "x" if dx_need <= dy_need else "y"
            disp = (math.ceil(max(dx_need if axis == "x" else dy_need, _GRID) / _GRID) + 1) * _GRID
            acx, acy = ax + aw / 2, ay + ah / 2
            bcx, bcy = bx + bw / 2, by_ + bh / 2
            if axis == "x":
                sign = 1.0 if bcx >= acx else -1.0
                if mover is None:
                    shift(aid, -sign * disp / 2, 0)
                    shift(bid, sign * disp / 2, 0)
                else:
                    shift(mover, (-sign if mover == aid else sign) * disp, 0)
            else:
                sign = 1.0 if bcy >= acy else -1.0
                if mover is None:
                    shift(aid, 0, -sign * disp / 2)
                    shift(bid, 0, sign * disp / 2)
                else:
                    shift(mover, 0, (-sign if mover == aid else sign) * disp)
            moved_ids.update((aid, bid) if mover is None else (mover,))
            fixes.append(f"separated {aid}<->{bid} by {disp:.0f}px ({axis})")
            moved = True
        if not moved:
            break

    # Snap moved subtrees to 4px grid
    for nid in sorted(moved_ids, key=lambda k: len(chain(k))):
        n = by_id[nid]
        dx, dy = _snap4(float(n["x"])) - float(n["x"]), _snap4(float(n["y"])) - float(n["y"])
        if dx or dy:
            shift(nid, dx, dy)

    # Separate overlapping movable text-only labels from other text/shapes (unless same groupId)
    label_ids = [nid for nid, n in by_id.items() if _is_text_only(n) and str(n.get("text") or "").strip() and rect(nid)]
    text_targets = [nid for nid, n in by_id.items() if str(n.get("text") or "").strip() and rect(nid)]
    for _ in range(12):
        nudged = False
        for lid in label_ids:
            if movable_ids is not None and lid not in movable_ids:
                continue
            rl = rect(lid)
            if not rl:
                continue
            bl = (rl[0], rl[1], rl[0] + rl[2], rl[1] + rl[3])
            lgid = by_id[lid].get("groupId")
            for tid in text_targets:
                if tid == lid:
                    continue
                if lgid and lgid == by_id[tid].get("groupId"):
                    continue
                rt = rect(tid)
                if not rt:
                    continue
                bt = (rt[0], rt[1], rt[0] + rt[2], rt[1] + rt[3])
                if _inter(bl, bt) > 0.15 * min(_area(bl), _area(bt)):
                    # Nudge label clear vertically (prefer below unless label started above target center)
                    ly_c = rl[1] + rl[3] / 2
                    ty_c = rt[1] + rt[3] / 2
                    ny = _ceil4(bt[3] + 8.0) if ly_c >= ty_c else _snap4(bt[1] - rl[3] - 8.0)
                    by_id[lid]["y"] = ny
                    fixes.append(f"nudged label {lid} clear of {tid}")
                    nudged = True
                    break
        if not nudged:
            break

    # Grow frames when children escaped or a movable node straddles the frame border
    frame_ids = [nid for nid, n in by_id.items() if _is_frame(n) and rect(nid)]
    for fid in frame_ids:
        fr = rect(fid)
        if not fr:
            continue
        fx, fy, fw, fh = fr
        fbox = (fx, fy, fx + fw, fy + fh)
        kids = [k for k, p in parent.items() if p == fid]
        # Also catch movable nodes whose center lies inside the frame but whose edge straddles it
        for nid, n in by_id.items():
            if nid == fid or nid in kids or _is_frame(n):
                continue
            if movable_ids is not None and nid not in movable_ids and fid not in movable_ids:
                continue
            nr = rect(nid)
            if not nr:
                continue
            nbox = (nr[0], nr[1], nr[0] + nr[2], nr[1] + nr[3])
            if _partial_overlap(fbox, nbox):
                cx, cy = nr[0] + nr[2] / 2, nr[1] + nr[3] / 2
                if fx <= cx <= fx + fw and fy <= cy <= fy + fh:
                    kids.append(nid)
                elif movable_ids is None or nid in movable_ids:
                    # Push outside frame along smallest escape axis
                    d_left = (nr[0] + nr[2]) - fx + 20.0
                    d_right = (fx + fw) - nr[0] + 20.0
                    d_up = (nr[1] + nr[3]) - fy + 20.0
                    d_down = (fy + fh) - nr[1] + 20.0
                    best_d, dx, dy = min(
                        (d_left, -d_left, 0.0), (d_right, d_right, 0.0),
                        (d_up, 0.0, -d_up), (d_down, 0.0, d_down), key=lambda x: x[0],
                    )
                    shift(nid, _snap4(dx), _snap4(dy))
                    fixes.append(f"moved {nid} clear of frame {fid}")
        if not kids:
            continue
        if movable_ids is not None and fid not in movable_ids and not any(k in movable_ids for k in kids):
            continue
        krects = [r for r in (rect(k) for k in kids) if r]
        if not krects:
            continue
        escaped = any(
            r[0] < fx - 2 or r[1] < fy - 2 or r[0] + r[2] > fx + fw + 2 or r[1] + r[3] > fy + fh + 2
            for r in krects
        )
        if escaped:
            pad = 16.0
            nx = min(fx, min(r[0] for r in krects) - pad)
            ny = min(fy, min(r[1] for r in krects) - pad)
            nx2 = max(fx + fw, max(r[0] + r[2] for r in krects) + pad)
            ny2 = max(fy + fh, max(r[1] + r[3] for r in krects) + pad)
            fnode = by_id[fid]
            fnode["x"], fnode["y"] = _snap4(nx), _snap4(ny)
            fnode["w"], fnode["h"] = _ceil4(nx2 - _snap4(nx)), _ceil4(ny2 - _snap4(ny))
            fixes.append(f"grew frame {fid} around children")

    return fixes[:12]


def _prepare_diagram_pages(diagram: Dict[str, Any], movable_by_page: Optional[Dict[str, set]],
                           category: Optional[str], palette: str,
                           auto_fit: bool, auto_layout: bool,
                           added_by_page: Optional[Dict[str, set]] = None) -> List[str]:
    fixes: List[str] = []
    pages = diagram["pages"] if isinstance(diagram.get("pages"), list) else [diagram]
    for p in pages:
        if not isinstance(p, dict):
            continue
        pid = str(p.get("id") or "p1")
        mov = None if movable_by_page is None else movable_by_page.get(pid, set())
        added = None if added_by_page is None else added_by_page.get(pid, set())
        if mov is not None and not mov:
            continue
        for n in p.get("nodes") or []:
            if not isinstance(n, dict):
                continue
            nid = str(n.get("id") or "")
            if mov is not None and nid not in mov:
                continue
            _apply_node_style(n, category, palette, is_new=(added is None or nid in added))
        for e in p.get("edges") or []:
            if not isinstance(e, dict):
                continue
            eid = str(e.get("id") or "")
            if mov is not None and eid not in mov:
                continue
            _apply_edge_style(e, palette, is_new=(added is None or eid in added))
        if auto_fit or auto_layout:
            fixes.extend(_auto_repair_page(p, mov, auto_fit, auto_layout))
    return fixes[:12]


def _to_pages_copy(diagram: Any) -> Dict[str, Any]:
    if isinstance(diagram, dict) and isinstance(diagram.get("pages"), list):
        out = copy.deepcopy(diagram)
        out["pages"] = [p for p in out["pages"] if isinstance(p, dict)]
        if not out["pages"]:
            out["pages"] = [{"id": "p1", "name": "Page 1", "nodes": [], "edges": []}]
        return out
    root = _root_metadata(diagram)  # diagram-level metadata is never dropped
    head: Dict[str, Any] = {"metadata": root} if root else {}
    if isinstance(diagram, dict) and ("nodes" in diagram or "edges" in diagram):
        return {**head, "pages": [{"id": "p1", "name": "Page 1",
                                   "nodes": copy.deepcopy(diagram.get("nodes") or []),
                                   "edges": copy.deepcopy(diagram.get("edges") or [])}]}
    return {**head, "pages": [{"id": "p1", "name": "Page 1", "nodes": [], "edges": []}]}


def _edge_attached_to(edge: Dict[str, Any], node_id: str) -> bool:
    for end in ("source", "target"):
        att = edge.get(end)
        if isinstance(att, dict) and att.get("nodeId") == node_id:
            return True
        if att == node_id:
            return True
    return False


def _apply_patch_ops(diagram: Any, ops: List[Dict[str, Any]],
                     default_page_id: Optional[str] = None) -> Tuple[Dict[str, Any], List[str], Dict[str, set], Dict[str, set]]:
    if not isinstance(ops, list) or not ops:
        raise ToolError("ops must be a non-empty array")
    if len(ops) > 500:
        raise ToolError("at most 500 ops per patch_board call")
    out = _to_pages_copy(diagram)
    pages = out["pages"]
    touched_pages: List[str] = []
    movable_by_page: Dict[str, set] = {}
    added_by_page: Dict[str, set] = {}

    def mark_page(pid: str) -> None:
        if pid not in touched_pages:
            touched_pages.append(pid)
        movable_by_page.setdefault(pid, set())
        added_by_page.setdefault(pid, set())

    def resolve_page(i: int, op: Dict[str, Any]) -> Dict[str, Any]:
        pid = op.get("page_id") if op.get("page_id") is not None else default_page_id
        if pid is None:
            return pages[0]
        for p in pages:
            if p.get("id") == pid:
                return p
        raise ToolError(f"ops[{i}]: page {pid!r} not found (pages: {[p.get('id') for p in pages]})")

    for i, op in enumerate(ops):
        if not isinstance(op, dict):
            raise ToolError(f"ops[{i}]: must be an object")
        verb = op.get("op")
        if verb == "add_page":
            page = op.get("page")
            if not isinstance(page, dict) or not SAFE_ID_RE.match(str(page.get("id", ""))):
                raise ToolError(f"ops[{i}]: add_page needs valid page.id")
            if any(p.get("id") == page["id"] for p in pages):
                raise ToolError(f"ops[{i}]: page {page['id']!r} already exists")
            new_p = {"id": page["id"], "name": str(page.get("name") or f"Page {len(pages) + 1}")[:120],
                     "nodes": [], "edges": []}
            pages.append(new_p)
            mark_page(new_p["id"])
            continue
        if verb == "rename_page":
            page = resolve_page(i, op)
            name = op.get("name")
            if not isinstance(name, str) or not name.strip():
                raise ToolError(f"ops[{i}]: rename_page needs a non-empty name")
            page["name"] = name.strip()[:120]
            mark_page(str(page["id"]))
            continue
        if verb == "set_metadata":
            patch = op.get("metadata")
            if not isinstance(patch, dict):
                raise ToolError(f"ops[{i}]: set_metadata needs a metadata object")
            if op.get("page_id") is None:  # diagram-level (the batch page_id does not apply)
                _set_metadata_on(out, patch)
            else:
                page = resolve_page(i, op)
                _set_metadata_on(page, patch)
                mark_page(str(page["id"]))
            continue

        page = resolve_page(i, op)
        pid = str(page.get("id") or "p1")
        nodes = page.setdefault("nodes", [])
        edges = page.setdefault("edges", [])
        mark_page(pid)

        if verb == "delete":
            oid = op.get("id")
            if not isinstance(oid, str):
                raise ToolError(f"ops[{i}]: delete needs string id")
            n_before = len(nodes)
            nodes[:] = [n for n in nodes if not (isinstance(n, dict) and n.get("id") == oid)]
            if len(nodes) != n_before:
                edges[:] = [e for e in edges if not (isinstance(e, dict) and _edge_attached_to(e, oid))]
                continue
            e_before = len(edges)
            edges[:] = [e for e in edges if not (isinstance(e, dict) and e.get("id") == oid)]
            if len(edges) == e_before:
                raise ToolError(f"ops[{i}]: no node or edge with id {oid!r}")
            continue

        if verb not in ("add", "update"):
            raise ToolError(f"ops[{i}]: unknown op {verb!r} "
                            "(add|update|delete|add_page|rename_page|set_metadata)")
        has_node, has_edge = isinstance(op.get("node"), dict), isinstance(op.get("edge"), dict)
        if has_node == has_edge:
            raise ToolError(f"ops[{i}]: provide exactly one of `node` or `edge`")
        obj = op["node"] if has_node else op["edge"]
        target = nodes if has_node else edges
        oid = obj.get("id")
        if not isinstance(oid, str) or not SAFE_ID_RE.match(oid):
            raise ToolError(f"ops[{i}]: needs a valid string id")
        idx = next((k for k, x in enumerate(target) if isinstance(x, dict) and x.get("id") == oid), None)
        if verb == "add":
            if idx is not None or any(isinstance(x, dict) and x.get("id") == oid for x in nodes + edges):
                raise ToolError(f"ops[{i}]: id {oid!r} already exists on page {pid!r}")
            item = copy.deepcopy(obj)
            if has_node:
                item.setdefault("kind", "rounded")
                item.setdefault("x", 80)
                item.setdefault("y", 80)
                item.setdefault("w", 160)
                item.setdefault("h", 64)
                item.setdefault("text", "")
            target.append(item)
            added_by_page[pid].add(oid)
            movable_by_page[pid].add(oid)
        else:
            if idx is None:
                kind = "node" if has_node else "edge"
                raise ToolError(f"ops[{i}]: no {kind} with id {oid!r} on page {pid!r}")
            merged = dict(target[idx])
            upd = copy.deepcopy(obj)
            if "meta" in upd:
                # meta merges key by key (null removes a key; meta:null clears it)
                raw_meta = upd.pop("meta")
                if raw_meta is not None and not isinstance(raw_meta, dict):
                    raise ToolError(f"ops[{i}]: meta must be an object or null")
                new_meta = (_merge_metadata(merged.get("meta"), raw_meta)
                            if isinstance(raw_meta, dict) else None)
                if new_meta:
                    merged["meta"] = new_meta
                else:
                    merged.pop("meta", None)
            merged.update(upd)
            target[idx] = merged
            movable_by_page[pid].add(oid)
    return out, touched_pages, movable_by_page, added_by_page


def t_get_board(b: Backend, a: Dict[str, Any]) -> Dict[str, Any]:
    doc_id = resolve_doc_id(b, a["doc_id"])
    doc = b.call("GET", f"/api/documents/{doc_id}")
    result = summarize_board(b, doc_id, doc, a.get("page_id"), bool(a.get("include_svg")),
                             compact=bool(a.get("compact")), node_ids=a.get("node_ids"))
    # The base is always the WHOLE board (a page_id / compact read still merges correctly).
    result["edit_revision"] = _remember(b, doc_id, result["updated_at"], doc.get("diagram"))
    return result


def _attach_inline_capture(b: Backend, doc_id: str, page_id: Optional[str], updated_at: Any,
                           node_ids: Optional[List[str]], saved_diagram: Any, out: Dict[str, Any],
                           base_diagram: Any = None, sent_diagram: Any = None) -> None:
    """Single-pass post-write visual render: attaches crisp PNG + pixel-exact DOM lint."""
    req: Dict[str, Any] = {"page_id": page_id, "expected_updated_at": updated_at}
    if node_ids:
        req["node_ids"] = node_ids
    try:
        shot = b.call("POST", f"/api/documents/{doc_id}/capture", req)
    except ApiError as e:
        out["capture_note"] = f"Saved, but capture failed ({e}); call capture_board to visually verify."
        return
    if not isinstance(shot, dict):
        return
    routes = shot.pop("edge_routes", None)
    text_metrics = shot.pop("text_metrics", None)
    edge_label_metrics = shot.pop("edge_label_metrics", None)
    png = shot.pop("png_base64", None)
    if png:
        out["png_base64"] = png
    cap_pid = shot.get("page_id") or page_id or "p1"
    out["capture"] = {
        k: shot[k] for k in ("page_id", "width", "height", "scale", "cropped", "renderer", "visual_validation")
        if k in shot
    }
    if saved_diagram is not None and (routes is not None or text_metrics is not None):
        out["post_save_check"] = post_save_check(
            base_diagram, sent_diagram, saved_diagram,
            dom_by_page={cap_pid: (routes, text_metrics, edge_label_metrics)},
            capture_included=bool(png),
        )


def t_create_board(b: Backend, a: Dict[str, Any]) -> Dict[str, Any]:
    body: Dict[str, Any] = {"name": a["name"]}
    auto_fixed: List[str] = []
    sent_diagram = None
    category = a.get("category")
    if a.get("diagram") is None and a.get("metadata"):
        a = dict(a, diagram={"pages": [{"id": "p1", "name": "Page 1", "nodes": [], "edges": []}]})
    if a.get("diagram") is not None:
        check_diagram(a["diagram"])
        sent_diagram = copy.deepcopy(a["diagram"])
        palette = a.get("palette") or ("board" if category else "preserve")
        auto_fit = a.get("auto_fit", True)
        auto_layout = a.get("auto_layout", True)
        auto_fixed = _prepare_diagram_pages(sent_diagram, None, category, palette, auto_fit, auto_layout)
        # Diagram-level semantics live on the root; `category` doubles as metadata.category.
        _set_metadata_on(sent_diagram, a.get("metadata") or {})
        if category and not (sent_diagram.get("metadata") or {}).get("category"):
            _set_metadata_on(sent_diagram, {"category": category})
        body["diagram"] = sent_diagram
    meta = meta_of(b.call("POST", "/api/documents/new", body))
    doc_id = str(meta.get("id") or "")
    if not DOC_ID_RE.match(doc_id):
        raise ToolError("noddle did not return a board id")
    out: Dict[str, Any] = _ref(b, doc_id, meta, a["name"])
    if sent_diagram is not None:
        out["edit_revision"] = _remember(b, doc_id, meta.get("updated_at"), sent_diagram)
        if auto_fixed:
            out["auto_fixed"] = auto_fixed
        out["post_save_check"] = post_save_check(None, sent_diagram, sent_diagram)
        if a.get("capture"):
            pages = pages_of(sent_diagram)
            pid = pages[0].get("id") if pages else None
            _attach_inline_capture(b, doc_id, pid, meta.get("updated_at"),
                                   a.get("capture_node_ids"), sent_diagram, out,
                                   base_diagram=None, sent_diagram=sent_diagram)
    return out


def t_patch_board(b: Backend, a: Dict[str, Any]) -> Dict[str, Any]:
    doc_id = resolve_doc_id(b, a["doc_id"])
    doc = b.call("GET", f"/api/documents/{doc_id}")
    current = meta_of(doc)
    expected = a.get("expected_updated_at")
    has_base, base = _read_base(b, doc_id, a)
    if not has_base and expected is not None and abs(float(current.get("updated_at") or 0) - float(expected)) > 1e-6:
        raise ToolError(
            f"conflict: board changed (updated_at is now {current.get('updated_at')}). "
            "Call get_board(compact=true) and retry."
        )
    source_diagram = base if has_base else doc.get("diagram")
    ops = list(a.get("ops") or [])
    if a.get("metadata") is not None:
        ops.append({"op": "set_metadata", "metadata": a["metadata"]})
    if a.get("page_metadata") is not None:
        target_pid = a.get("page_id") or _to_pages_copy(source_diagram)["pages"][0].get("id")
        ops.append({"op": "set_metadata", "metadata": a["page_metadata"], "page_id": target_pid})
    if not ops:
        raise ToolError("nothing to apply — pass ops and/or metadata / page_metadata")
    desired, touched_pages, movable_by_page, added_by_page = _apply_patch_ops(
        source_diagram, ops, default_page_id=a.get("page_id")
    )
    category = a.get("category")
    palette = a.get("palette") or ("board" if category else "preserve")
    auto_fit = a.get("auto_fit", True)
    auto_layout = a.get("auto_layout", True)
    auto_fixed = _prepare_diagram_pages(
        desired, movable_by_page, category, palette, auto_fit, auto_layout, added_by_page=added_by_page
    )
    # Collaborative merge: if caller didn't hold a read_base, use doc.get("diagram") we just loaded
    merge_base = base if has_base else doc.get("diagram")
    # author_name attributes the version snapshot; agent=True shows the agent
    # in live presence.
    body: Dict[str, Any] = {"svg": doc.get("svg") or "", "diagram": desired,
                            "author_name": b.agent_name, "agent": True, "base_diagram": merge_base}
    if expected is not None:
        body["expected_updated_at"] = expected
    meta = meta_of(b.call("PUT", f"/api/documents/{doc_id}", body))
    out: Dict[str, Any] = {**_ref(b, doc_id, meta, current.get("name")), "applied_ops": len(ops)}
    if auto_fixed:
        out["auto_fixed"] = auto_fixed
    try:
        saved = b.call("GET", f"/api/documents/{doc_id}")
        saved_diagram = saved.get("diagram")
    except ApiError:
        saved_diagram = desired
    out["edit_revision"] = _remember(b, doc_id, meta.get("updated_at"), saved_diagram)
    out["post_save_check"] = post_save_check(merge_base, desired, saved_diagram)
    if a.get("capture"):
        cap_page = a.get("page_id") or (touched_pages[0] if touched_pages else None)
        _attach_inline_capture(b, doc_id, cap_page, meta.get("updated_at"),
                               a.get("capture_node_ids"), saved_diagram, out,
                               base_diagram=merge_base, sent_diagram=desired)
    return out


def t_update_board(b: Backend, a: Dict[str, Any]) -> Dict[str, Any]:
    doc_id = resolve_doc_id(b, a["doc_id"])
    check_diagram(a["diagram"])
    doc = b.call("GET", f"/api/documents/{doc_id}")
    current = meta_of(doc)
    expected = a.get("expected_updated_at")
    has_base, base = _read_base(b, doc_id, a)
    if not has_base and expected is not None and abs(float(current.get("updated_at") or 0) - float(expected)) > 1e-6:
        raise ToolError(
            f"conflict: the board changed since you read it (updated_at is now "
            f"{current.get('updated_at')}). Call get_board again and re-apply your edit."
        )
    desired = a["diagram"]
    auto_fixed: List[str] = []
    if any(a.get(k) for k in ("category", "palette", "auto_fit", "auto_layout")):
        desired = copy.deepcopy(a["diagram"])
        category = a.get("category")
        palette = a.get("palette") or ("board" if category else "preserve")
        # Objects changed vs the base, so auto_fit/auto_layout never move untouched shapes.
        ref_pages = {p.get("id"): p for p in pages_of(base if has_base else doc.get("diagram"))}
        mov_by_page: Dict[str, set] = {}
        add_by_page: Dict[str, set] = {}
        for p in pages_of(desired):
            pid = str(p.get("id") or "p1")
            rp = ref_pages.get(pid) or {}
            old_n, old_e = _by_id(rp.get("nodes")), _by_id(rp.get("edges"))
            mov, add = set(), set()
            for n in p.get("nodes") or []:
                nid = str(n.get("id") or "")
                if nid not in old_n:
                    add.add(nid)
                    mov.add(nid)
                elif n != old_n[nid]:
                    mov.add(nid)
            for e in p.get("edges") or []:
                eid = str(e.get("id") or "")
                if eid not in old_e:
                    add.add(eid)
                    mov.add(eid)
                elif e != old_e[eid]:
                    mov.add(eid)
            mov_by_page[pid], add_by_page[pid] = mov, add
        auto_fixed = _prepare_diagram_pages(
            desired, mov_by_page, category, palette, bool(a.get("auto_fit")), bool(a.get("auto_layout")),
            added_by_page=add_by_page,
        )
    # Keep the stored SVG preview — the editor strips the baked layer on open
    # and re-renders from JSON. author_name attributes the version snapshot;
    # agent=True shows it in live presence as an agent.
    body: Dict[str, Any] = {"svg": doc.get("svg") or "", "diagram": desired,
                            "author_name": b.agent_name, "agent": True}
    if expected is not None:
        body["expected_updated_at"] = expected
    if has_base:
        body["base_diagram"] = base
    meta = meta_of(b.call("PUT", f"/api/documents/{doc_id}", body))
    out: Dict[str, Any] = _ref(b, doc_id, meta, current.get("name"))
    if auto_fixed:
        out["auto_fixed"] = auto_fixed
    try:
        saved = b.call("GET", f"/api/documents/{doc_id}")
    except ApiError:
        return out  # the write succeeded; the check is advisory
    saved_diagram = saved.get("diagram") if isinstance(saved, dict) else None
    out["edit_revision"] = _remember(b, doc_id, meta.get("updated_at"), saved_diagram)
    ref_base = base if has_base else doc.get("diagram")
    out["post_save_check"] = post_save_check(ref_base, desired, saved_diagram)
    if a.get("capture"):
        sent_pages = {p.get("id"): p for p in pages_of(desired)}
        base_pages = {p.get("id"): p for p in pages_of(ref_base)}
        touched = [pid for pid, p in sent_pages.items() if p != base_pages.get(pid)]
        cap_page = touched[0] if touched else (next(iter(sent_pages), None))
        _attach_inline_capture(b, doc_id, cap_page, meta.get("updated_at"),
                               a.get("capture_node_ids"), saved_diagram, out,
                               base_diagram=ref_base, sent_diagram=desired)
    return out


# ---- post-save check & pixel-exact lint --------------------------------------------
# People keep boards open while an agent writes: the server merges their live
# edits into the agent's save. After every write, diff the saved board against
# what was sent (manual_changes) and lint touched pages (upgraded with real
# Chromium DOM text_metrics + edge_routes whenever capture=true).

_CHECK_CAP = 20


def _by_id(items: Any) -> Dict[str, Dict[str, Any]]:
    return {str(o.get("id")): o for o in (items or []) if isinstance(o, dict) and o.get("id") is not None}


def _label(o: Dict[str, Any]) -> str:
    text = str(o.get("text") or "").strip().replace("\n", " ")
    return text[:40] if text else f"<empty {o.get('kind') or 'edge'}>"


def _is_text_only(n: Dict[str, Any]) -> bool:
    return n.get("fill") in (None, "", "transparent", "none") and n.get("stroke") in (None, "", "transparent", "none")


def _box(n: Dict[str, Any]) -> Optional[tuple]:
    try:
        x, y, w, h = (float(n[k]) for k in ("x", "y", "w", "h"))
    except (KeyError, TypeError, ValueError):
        return None
    return x, y, x + w, y + h


def _partial_overlap(a: tuple, b: tuple) -> bool:
    ix = min(a[2], b[2]) - max(a[0], b[0])
    iy = min(a[3], b[3]) - max(a[1], b[1])
    if ix <= 1 or iy <= 1:
        return False
    return not (_contains(a, b) or _contains(b, a))  # a frame around its children is fine


def _is_frame(n: Dict[str, Any]) -> bool:
    """A container: hollow, unlabeled, big enough to hold things (its title is a separate text node)."""
    return (n.get("fill") in (None, "", "transparent", "none") and not str(n.get("text") or "").strip()
            and float(n.get("w") or 0) >= 200 and float(n.get("h") or 0) >= 100)


def _contains(p: tuple, q: tuple) -> bool:
    return p[0] <= q[0] and p[1] <= q[1] and p[2] >= q[2] and p[3] >= q[3]


def _area(b: tuple) -> float:
    return max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])


def _inter(a: tuple, b: tuple) -> float:
    return max(0.0, min(a[2], b[2]) - max(a[0], b[0])) * max(0.0, min(a[3], b[3]) - max(a[1], b[1]))


def _text_fits(n: Dict[str, Any]) -> bool:
    """Font-aware fit test matching NodeView.tsx (14px default, 1.25 lineHeight, 8px pad, wrap)."""
    max_w, text_h, _ = _measure_node_text(n)
    w, h = float(n.get("w") or 0), float(n.get("h") or 0)
    text_only = _is_text_only(n)
    pad_x = 4.0 if text_only else 14.0
    pad_y = -4.0 if text_only else 6.0
    return max_w <= w - pad_x and text_h <= h - pad_y


# Severity "error" = visibly wrong, fix before finishing; "warning" = inspect PNG and decide.
LINT_FIXES = {
    "dangling_edge": "Re-attach or delete edge.",
    "stray_shape": "Empty unconnected shape: delete if yours, else ask.",
    "tiny_shape": "Delete or give real dimensions.",
    "duplicate": "Keep one copy, re-point edges, delete duplicate.",
    "overlap": "Separate shapes (>=28px gap) or pass auto_layout=true.",
    "straddles_frame": "Move fully inside/outside frame or grow frame.",
    "text_overlap": "Move label so rendered text never overlaps.",
    "text_overflow": "Grow box (or pass auto_fit=true), enable wrap, or shorten text.",
    "misaligned": "Snap centre x/y to neighbour.",
    "empty_shape": "Add short label or delete.",
    "orphan": "Connect or confirm standalone.",
    "empty_container": "Delete empty frame or move content inside.",
    "duplicate_edge": "Delete duplicate edge.",
    "edge_crosses_shape": "Re-route edge, change ports, or move blocking shape.",
    "edge_crosses_text": "Move label or re-route edge off the text.",
    "verbose_text": "Shorten to concise phrases (<=3 lines, 2-5 words/line).",
    "monochrome_board": "Differentiate roles with category style colors (blue/green/ember/red/ink).",
}
_SEVERITY = {"dangling_edge": "error", "stray_shape": "error", "tiny_shape": "error", "duplicate": "error",
             "overlap": "error", "straddles_frame": "error", "text_overlap": "error",
             "edge_crosses_shape": "error", "edge_crosses_text": "error"}


def _route_issues(page: Dict[str, Any], routes: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Edges whose RENDERED route (sampled by the capture renderer) runs through a shape or a
    text label other than the edge's own endpoints. Frames are skipped: lines legitimately
    cross container borders. A 4px inset ignores lines that merely graze an outline."""
    pid, nodes = page.get("id"), _by_id(page.get("nodes"))
    issues: List[Dict[str, Any]] = []
    for link in page.get("edges") or []:
        pts = routes.get(str(link.get("id"))) if isinstance(link, dict) else None
        if not pts:
            continue
        ends = {str((link.get(k) or {}).get("nodeId")) for k in ("source", "target")}
        for nid, n in nodes.items():
            b = _box(n)
            if nid in ends or not b or _is_frame(n) or n.get("kind") == "freedraw":
                continue
            text_only = _is_text_only(n)
            if text_only and not str(n.get("text") or "").strip():
                continue
            inset = (b[0] + 4, b[1] + 4, b[2] - 4, b[3] - 4)
            if inset[0] >= inset[2] or inset[1] >= inset[3]:
                continue
            hits = sum(1 for x, y in pts if inset[0] < x < inset[2] and inset[1] < y < inset[3])
            if hits >= 2:  # two samples ≈ 6px of line inside: a real crossing, not a rounding blip
                kind = "edge_crosses_text" if text_only else "edge_crosses_shape"
                what = (link.get("labels") or [{}])[0].get("text") or link.get("id")
                issues.append({"page_id": pid, "type": kind, "severity": "error", "ids": [link.get("id"), nid],
                               "detail": f"edge '{what}' runs through '{_label(n)}'", "fix": LINT_FIXES[kind]})
    return issues


def _dom_text_issues(page: Dict[str, Any], text_metrics: Dict[str, Any],
                     edge_label_metrics: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
    """Pixel-exact text overflow and text-on-text overlap from Chromium's real SVG <text> getBBox()."""
    pid, nodes = page.get("id"), _by_id(page.get("nodes"))
    issues: List[Dict[str, Any]] = []
    rendered_boxes: List[Tuple[str, str, tuple]] = []

    for nid, tm in text_metrics.items():
        n = nodes.get(str(nid))
        if not n or not isinstance(tm, dict):
            continue
        try:
            tx, ty, tw, th = float(tm["x"]), float(tm["y"]), float(tm["w"]), float(tm["h"])
        except (KeyError, TypeError, ValueError):
            continue
        tbox = (tx, ty, tx + tw, ty + th)
        rendered_boxes.append((str(nid), _label(n), tbox))
        if n.get("kind") == "icon" or _is_frame(n):
            continue
        b = _box(n)
        if not b:
            continue
        bw, bh = b[2] - b[0], b[3] - b[1]
        text_only = _is_text_only(n)
        over_x = tw - (bw + 6.0 if text_only else bw - 8.0)
        over_y = th - (bh + 6.0 if text_only else bh - 4.0)
        if over_x > 2.0 or over_y > 2.0:
            need_w = _ceil4(tw + (12.0 if text_only else 24.0))
            need_h = _ceil4(th + (8.0 if text_only else 20.0))
            sev = "error" if (not text_only and (over_x > 6.0 or over_y > 6.0)) else "warning"
            issues.append({
                "page_id": pid, "type": "text_overflow", "severity": sev, "ids": [nid],
                "detail": f"'{_label(n)}' renders {tw:.0f}x{th:.0f}px in {bw:.0f}x{bh:.0f}px box (need >={need_w:.0f}x{need_h:.0f})",
                "fix": LINT_FIXES["text_overflow"],
            })

    if isinstance(edge_label_metrics, dict):
        for eid, items in edge_label_metrics.items():
            for item in (items or []):
                if not isinstance(item, dict):
                    continue
                try:
                    ex, ey, ew, eh = float(item["x"]), float(item["y"]), float(item["w"]), float(item["h"])
                except (KeyError, TypeError, ValueError):
                    continue
                rendered_boxes.append((str(eid), str(item.get("text") or eid)[:30], (ex, ey, ex + ew, ey + eh)))

    # Pairwise real rendered <text> vs <text> collision
    for k, (id_a, lbl_a, ba) in enumerate(rendered_boxes):
        for id_b, lbl_b, bb in rendered_boxes[k + 1:]:
            if id_a == id_b:
                continue
            ix = min(ba[2], bb[2]) - max(ba[0], bb[0])
            iy = min(ba[3], bb[3]) - max(ba[1], bb[1])
            if ix > 4.0 and iy > 4.0:
                issues.append({
                    "page_id": pid, "type": "text_overlap", "severity": "error", "ids": [id_a, id_b],
                    "detail": f"rendered text '{lbl_a}' collides with '{lbl_b}' ({ix:.0f}x{iy:.0f}px)",
                    "fix": LINT_FIXES["text_overlap"],
                })
    return issues


def _page_issues(page: Dict[str, Any], text_metrics: Optional[Dict[str, Any]] = None,
                 edge_label_metrics: Optional[Dict[str, Any]] = None,
                 routes: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
    pid, nodes = page.get("id"), _by_id(page.get("nodes"))
    links = [e for e in page.get("edges") or [] if isinstance(e, dict)]
    issues: List[Dict[str, Any]] = []
    use_dom_text = isinstance(text_metrics, dict) and bool(text_metrics)

    def add(kind: str, ids: List[Any], detail: str) -> None:
        issues.append({"page_id": pid, "type": kind, "severity": _SEVERITY.get(kind, "warning"),
                       "ids": ids, "detail": detail, "fix": LINT_FIXES[kind]})

    connected: set = set()
    pairs: Dict[tuple, Any] = {}
    for link in links:
        ends = []
        for end in ("source", "target"):
            att = link.get(end) or {}
            if att.get("kind") in ("port", "floating"):
                nid = str(att.get("nodeId"))
                if nid not in nodes:
                    add("dangling_edge", [link.get("id")], f"edge {end} points at missing node {nid}")
                connected.add(nid)
                ends.append(nid)
        if len(ends) == 2:
            key = tuple(ends)
            if key in pairs:
                add("duplicate_edge", [pairs[key], link.get("id")], f"two edges {ends[0]} -> {ends[1]}")
            pairs.setdefault(key, link.get("id"))

    boxed = [(i, n, _box(n)) for i, n in nodes.items() if n.get("kind") != "freedraw" and _box(n)]
    frames = [(i, b) for i, n, b in boxed if _is_frame(n)]
    labels = [(i, n, b) for i, n, b in boxed if _is_text_only(n) and str(n.get("text") or "").strip()]
    shapes = [(i, n, b) for i, n, b in boxed if not _is_text_only(n)]

    def inside(i: str, b: tuple) -> bool:
        return any(f != i and _contains(fb, b) for f, fb in frames)

    colored_solids: List[Tuple[str, Tuple[str, str]]] = []
    for i, n, b in shapes:
        raw_text = str(n.get("text") or "").strip()
        has_text = bool(raw_text)
        if (b[2] - b[0]) < 8 or (b[3] - b[1]) < 8:
            add("tiny_shape", [i], f"{n.get('kind')} is {b[2]-b[0]:.0f}x{b[3]-b[1]:.0f}px")
            continue
        if _is_frame(n):
            if not any(j != i and _contains(b, bj) for j, _, bj in boxed):
                add("empty_container", [i], "frame contains nothing")
            continue
        if has_text and n.get("kind") not in ("icon", "image", *_STROKE_KINDS):
            colored_solids.append((i, (str(n.get("fill") or "").lower(), str(n.get("stroke") or "").lower())))
        if not has_text and n.get("kind") != "icon":
            if i not in connected and not inside(i, b):
                add("stray_shape", [i], f"empty {n.get('kind')} at ({b[0]:.0f},{b[1]:.0f})")
            else:
                add("empty_shape", [i], f"{n.get('kind')} with no label")
        elif has_text and n.get("kind") != "icon":
            if not use_dom_text and not _text_fits(n):
                req_w, req_h = _needed_node_box(n)
                add("text_overflow", [i],
                    f"'{_label(n)}' may not fit {b[2]-b[0]:.0f}x{b[3]-b[1]:.0f}px (need >={req_w:.0f}x{req_h:.0f})")
            if n.get("kind") not in ("note", "sticky", "callout") and (len(raw_text) > 90 or len(raw_text.split("\n")) > 4):
                add("verbose_text", [i], f"'{_label(n)}' is verbose ({len(raw_text)} chars)")
        if has_text and links and i not in connected and not inside(i, b) and n.get("kind") != "icon":
            add("orphan", [i], f"'{_label(n)}' has no connections and sits outside every frame")

    if len(colored_solids) >= 4 and len({pair for _, pair in colored_solids}) == 1:
        add("monochrome_board", [i for i, _ in colored_solids[:6]],
            f"all {len(colored_solids)} shapes share identical colors {colored_solids[0][1]}")

    if not use_dom_text:
        for i, n, b in labels:
            if not _text_fits(n):
                add("text_overflow", [i], f"label '{_label(n)}' is wider than its {b[2]-b[0]:.0f}px box")

    for k, (i, n, bi) in enumerate(shapes):
        for j, m, bj in shapes[k + 1:]:
            if _inter(bi, bj) <= 1:
                continue
            same = ((n.get("kind"), str(n.get("text") or ""), n.get("iconKey"))
                    == (m.get("kind"), str(m.get("text") or ""), m.get("iconKey")))
            similar = min(_area(bi), _area(bj)) >= 0.8 * max(_area(bi), _area(bj))  # nested frames aren't copies
            if same and similar and _inter(bi, bj) >= 0.8 * min(_area(bi), _area(bj)):
                add("duplicate", [i, j], f"'{_label(n)}' is stacked on an identical copy")
            elif _is_frame(n) != _is_frame(m) and _partial_overlap(bi, bj):
                frame_id, other_id, other = (i, j, m) if _is_frame(n) else (j, i, n)
                add("straddles_frame", [other_id, frame_id], f"'{_label(other)}' sits across a frame border")
            elif not _is_frame(n) and not _is_frame(m) and _partial_overlap(bi, bj):
                add("overlap", [i, j], f"'{_label(n)}' overlaps '{_label(m)}'")

    if use_dom_text:
        issues.extend(_dom_text_issues(page, text_metrics or {}, edge_label_metrics))
    else:
        texty = labels + [(i, n, b) for i, n, b in shapes if str(n.get("text") or "").strip()]
        for k, (i, n, bi) in enumerate(texty):
            for j, m, bj in texty[k + 1:]:
                if (_is_text_only(n) or _is_text_only(m)) and _inter(bi, bj) > 0.15 * min(_area(bi), _area(bj)):
                    add("text_overlap", [i, j], f"text '{_label(n)}' collides with '{_label(m)}'")

    if isinstance(routes, dict):
        issues.extend(_route_issues(page, routes))

    solid = [(i, b) for i, n, b in shapes if not _is_frame(n) and (b[2] - b[0]) < 400]
    for k, (i, bi) in enumerate(solid):
        for j, bj in solid[k + 1:]:
            dx = abs((bi[0] + bi[2]) - (bj[0] + bj[2])) / 2
            dy = abs((bi[1] + bi[3]) - (bj[1] + bj[3])) / 2
            off = dy if 1 <= dy <= 6 and dx < 600 else dx if 1 <= dx <= 6 and dy < 600 else 0
            if off:
                add("misaligned", [i, j], f"centres differ by {off:.0f}px")
    return sorted(issues, key=lambda x: 0 if x["severity"] == "error" else 1)


SELF_REVIEW = (
    "SELF-REVIEW: fix all errors on your objects (overlaps, text overflow/overlap, edge crossings, straddling frames, dangling edges), "
    "keep labels concise and colors distinct by role, then inspect the captured PNG."
)


def post_save_check(base: Any, sent: Any, saved: Any,
                    dom_by_page: Optional[Dict[str, Tuple[Any, Any, Any]]] = None,
                    capture_included: bool = False) -> Dict[str, Any]:
    """Compare what the agent sent with what the board holds after the save
    (``manual_changes`` = other people's work merged in) and lint touched pages."""
    sent_pages = {p.get("id"): p for p in pages_of(sent)}
    saved_pages = {p.get("id"): p for p in pages_of(saved)}
    base_pages = {p.get("id"): p for p in pages_of(base)}
    manual: List[Dict[str, Any]] = []
    for pid in sorted(set(sent_pages) | set(saved_pages), key=str):
        if pid not in saved_pages:
            manual.append({"page_id": pid, "change": "page_removed", "ids": []})
            continue
        if pid not in sent_pages:
            manual.append({"page_id": pid, "change": "page_added", "ids": []})
            continue
        for key in ("nodes", "edges"):
            mine, theirs = _by_id(sent_pages[pid].get(key)), _by_id(saved_pages[pid].get(key))
            for oid in theirs.keys() - mine.keys():
                manual.append({"page_id": pid, "change": "added", "ids": [oid], "label": _label(theirs[oid])})
            for oid in mine.keys() - theirs.keys():
                manual.append({"page_id": pid, "change": "removed", "ids": [oid], "label": _label(mine[oid])})
            for oid in mine.keys() & theirs.keys():
                fields = sorted(f for f in set(mine[oid]) | set(theirs[oid])
                                if f != "z" and mine[oid].get(f) != theirs[oid].get(f))
                if fields:
                    manual.append({"page_id": pid, "change": "modified", "ids": [oid],
                                   "label": _label(theirs[oid]), "fields": fields[:8]})
    touched = [pid for pid, p in sent_pages.items() if p != base_pages.get(pid) and pid in saved_pages]
    dom = dom_by_page or {}
    issues: List[Dict[str, Any]] = []
    for pid in touched:
        routes, tm, elm = dom.get(pid, (None, None, None))
        issues.extend(_page_issues(saved_pages[pid], text_metrics=tm, edge_label_metrics=elm, routes=routes))
    for issue in issues:
        sent_p, base_p = sent_pages.get(issue["page_id"]) or {}, base_pages.get(issue["page_id"]) or {}
        mine = {**_by_id(sent_p.get("nodes")), **_by_id(sent_p.get("edges"))}
        before = {**_by_id(base_p.get("nodes")), **_by_id(base_p.get("edges"))}
        issue["yours"] = any(str(i) in mine and mine[str(i)] != before.get(str(i)) for i in issue["ids"])
    errors = sum(1 for i in issues if i["severity"] == "error")
    dom_verified = bool(dom)
    if manual or errors:
        next_step = (
            "Report manual_changes (never revert others' edits). Fix yours=true errors via patch_board"
            + (" and inspect the PNG." if capture_included else ", then capture_board.")
        )
    elif issues:
        next_step = "Inspect the PNG for warnings; patch_board only if visually needed." if capture_included else "Call capture_board to visually inspect."
    else:
        next_step = "Zero lint issues. Visually inspect the attached PNG to confirm." if capture_included else "Zero lint issues. Call capture_board to visually inspect."
    return {"manual_changes": manual[:_CHECK_CAP], "manual_change_count": len(manual),
            "issues": issues[:_CHECK_CAP], "issue_count": len(issues), "error_count": errors,
            "dom_verified": dom_verified, "next_step": next_step}


def t_clone_diagram(b: Backend, a: Dict[str, Any]) -> Dict[str, Any]:
    doc_id = resolve_doc_id(b, a["doc_id"])
    doc = b.call("GET", f"/api/documents/{doc_id}")
    diagram = copy.deepcopy(doc.get("diagram")) if isinstance(doc, dict) else None
    if not isinstance(diagram, dict):
        raise ToolError("This board has no editable diagram to clone.")
    check_diagram(diagram)
    pages = diagram.get("pages") or [diagram]
    page_id = a.get("page_id")
    if not page_id and len(pages) > 1:
        raise ToolError("Choose page_id from get_board before cloning a multi-page board.")
    page = next((p for p in pages if p.get("id", "p1") == page_id), None) if page_id else pages[0]
    if page is None:
        raise ToolError("Page not found. Call get_board for the page IDs.")
    nodes, edges = page.get("nodes", []), page.get("edges", [])
    selected = set(a.get("node_ids") or [n["id"] for n in nodes])
    if not selected or not selected <= {n["id"] for n in nodes}:
        raise ToolError("node_ids must select existing nodes on this page.")
    originals = [n for n in nodes if n["id"] in selected]
    for n in nodes:
        if any(not isinstance(n.get(k), (int, float)) or not math.isfinite(n[k]) for k in ("x", "y", "w", "h")):
            raise ToolError("Cannot clone nodes with missing or invalid geometry.")
    dx = math.ceil((max(n["x"] + n["w"] for n in nodes) + a.get("gap", 120)
                    - min(n["x"] for n in originals)) / 4) * 4
    node_map = {n["id"]: "n_" + uuid.uuid4().hex[:16] for n in originals}
    groups = {n["groupId"]: "g_" + uuid.uuid4().hex[:16] for n in originals if n.get("groupId")}
    clones = []
    for n in originals:
        clone = copy.deepcopy(n)
        clone.update(id=node_map[n["id"]], x=n["x"] + dx)
        if clone.get("groupId"):
            clone["groupId"] = groups[clone["groupId"]]
        clones.append(clone)
    edge_map: Dict[str, str] = {}
    cloned_edges, skipped = [], []
    whole_page = selected == {n["id"] for n in nodes}
    for e in edges:
        refs = {att["nodeId"] for att in (e.get("source") or {}, e.get("target") or {})
                if isinstance(att, dict) and att.get("nodeId")}
        if not whole_page and (not refs or not refs <= selected):
            if refs & selected:
                skipped.append(e["id"])
            continue
        clone = copy.deepcopy(e)
        clone["id"] = edge_map[e["id"]] = "e_" + uuid.uuid4().hex[:16]
        for key in ("source", "target"):
            att = clone.get(key)
            if not isinstance(att, dict):
                continue
            if att.get("nodeId"):
                if att["nodeId"] not in node_map:
                    raise ToolError("An edge references a missing node; repair the source before cloning.")
                att["nodeId"] = node_map[att["nodeId"]]
            elif att.get("kind") == "free" and isinstance(att.get("point"), dict):
                att["point"]["x"] += dx
        for point in clone.get("waypoints") or []:
            point["x"] += dx
        for label in clone.get("labels") or []:
            label["id"] = "l_" + uuid.uuid4().hex[:16]
        cloned_edges.append(clone)
    page["nodes"] = nodes + clones
    page["edges"] = edges + cloned_edges
    revision = _remember(b, doc_id, meta_of(doc).get("updated_at"), doc.get("diagram"))
    result = t_update_board(b, {"doc_id": doc_id, "diagram": diagram, "edit_revision": revision,
                                "expected_updated_at": a["expected_updated_at"]})
    clone_ids = list(node_map.values())
    return {**result, "page_id": page.get("id", "p1"), "node_id_map": node_map,
            "edge_id_map": edge_map, "clone_node_ids": clone_ids, "offset": {"x": dx, "y": 0},
            "skipped_crossing_edge_ids": skipped,
            "next_step": "Use patch_board with this edit_revision on clone IDs only (capture=true, "
                         "capture_node_ids=clone_node_ids), preserve originals, read post_save_check and "
                         "inspect the PNG. Ask before removing originals or creating a separate board."}


def t_lint_board(b: Backend, a: Dict[str, Any]) -> Dict[str, Any]:
    doc_id = resolve_doc_id(b, a["doc_id"])
    doc = b.call("GET", f"/api/documents/{doc_id}")
    pages = pages_of(doc.get("diagram") if isinstance(doc, dict) else None)
    if a.get("page_id") is not None:
        pages = [p for p in pages if p.get("id") == a["page_id"]]
        if not pages:
            raise ToolError(f"page {a['page_id']!r} not found")
    issues: List[Dict[str, Any]] = []
    routes_checked, unchecked = [], []
    for p in pages:
        routes, tm, elm = None, None, None
        if a.get("check_routes", True) and (p.get("edges") or p.get("nodes")):
            try:
                shot = b.call("POST", f"/api/documents/{doc_id}/capture", {"page_id": p.get("id")})
                if isinstance(shot, dict):
                    routes = shot.get("edge_routes")
                    tm = shot.get("text_metrics")
                    elm = shot.get("edge_label_metrics")
            except ApiError:
                routes = None
            if routes is not None:
                routes_checked.append(p.get("id"))
            elif p.get("edges"):
                unchecked.append(p.get("id"))
        issues.extend(_page_issues(p, text_metrics=tm, edge_label_metrics=elm, routes=routes))
    out: Dict[str, Any] = {
        "id": doc_id, "url": b.board_url(doc_id), "updated_at": meta_of(doc).get("updated_at"),
        "pages": [{"page_id": p.get("id"), "name": p.get("name"),
                   "issue_count": sum(1 for i in issues if i["page_id"] == p.get("id"))} for p in pages],
        "error_count": sum(1 for i in issues if i["severity"] == "error"),
        "issue_count": len(issues), "issues": issues[:50], "routes_checked": routes_checked,
        "checklist": SELF_REVIEW,
    }
    if unchecked:
        out["routes_unchecked"] = unchecked
        out["note"] = "Edge routing NOT checked (renderer unavailable): inspect capture_board."
    return out


def t_capture_board(b: Backend, a: Dict[str, Any]) -> Dict[str, Any]:
    doc_id = resolve_doc_id(b, a["doc_id"])
    req: Dict[str, Any] = {
        "page_id": a.get("page_id"), "expected_updated_at": a.get("expected_updated_at"),
    }
    if a.get("node_ids"):
        req["node_ids"] = a["node_ids"]
    out = b.call("POST", f"/api/documents/{doc_id}/capture", req)
    if not isinstance(out, dict):
        raise ToolError("unexpected capture payload")
    routes = out.pop("edge_routes", None)
    text_metrics = out.pop("text_metrics", None)
    edge_label_metrics = out.pop("edge_label_metrics", None)
    if a.get("include_lint", True):
        try:
            doc = b.call("GET", f"/api/documents/{doc_id}")
            pages = pages_of(doc.get("diagram"))
            pid = out.get("page_id") or a.get("page_id")
            page = next((p for p in pages if p.get("id") == pid), pages[0] if pages else None)
            if page is not None:
                issues = _page_issues(page, text_metrics=text_metrics,
                                      edge_label_metrics=edge_label_metrics, routes=routes)
                if a.get("node_ids"):
                    wanted = set(a["node_ids"])
                    issues = [i for i in issues if any(str(x) in wanted for x in i.get("ids") or [])]
                out["lint"] = {
                    "error_count": sum(1 for i in issues if i["severity"] == "error"),
                    "issue_count": len(issues),
                    "dom_verified": bool(text_metrics or routes),
                    "issues": issues[:_CHECK_CAP],
                }
        except ApiError:
            pass
    return out


def t_join_board(b: Backend, a: Dict[str, Any]) -> Dict[str, Any]:
    doc_id = resolve_doc_id(b, a["doc_id"])
    out = b.call("POST", f"/api/documents/{doc_id}/presence", {"name": b.agent_name})
    out = out if isinstance(out, dict) else {}
    return {**out, "id": doc_id, "url": b.board_url(doc_id)}


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
        "description": "Fetch one board by id or URL: name, url, my_role (editor|viewer), metadata, "
                       "edit_revision, page summaries and the editable diagram JSON. Pass compact=true "
                       "(recommended) to strip default fields and cut tokens, or filter to page_id / "
                       "node_ids. For meaning without geometry use read_board_summary.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "doc_id": DOC_ID,
                "page_id": {"type": "string", "description": "Return only this page."},
                "compact": {"type": "boolean", "default": False,
                            "description": "Strip default/empty fields (~50% fewer tokens)."},
                "node_ids": {"type": "array", "items": {"type": "string"}, "maxItems": 1000,
                             "description": "Optional subset of nodes (+ their edges) to return."},
                "include_svg": {"type": "boolean", "default": False,
                                "description": "Also return stored preview SVG. Prefer capture_board."},
            },
            "required": ["doc_id"],
            "additionalProperties": False,
        },
        "outputSchema": BOARD_OUT,
        "annotations": _ann("Get board", read_only=True),
        "handler": t_get_board,
    },
    {
        "name": "read_board_summary",
        "title": "Read board summary (fast)",
        "description": "FASTEST way to understand a board (~90% fewer tokens than get_board): a compact "
                       "semantic graph with NO geometry — diagram/page metadata, groups (frames + members), "
                       "nodes {id, text, kind, group, meta.role…} and flows like 'A --[HTTPS]--> B'. Works "
                       "on legacy boards too (groups and roles are inferred from frames and shape kinds). "
                       "Returns edit_revision, so you can patch_board straight after.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "doc_id": DOC_ID,
                "page_id": {"type": "string", "description": "Summarize only this page."},
            },
            "required": ["doc_id"],
            "additionalProperties": False,
        },
        "outputSchema": {
            "type": "object",
            "properties": {
                "id": {"type": "string"}, "name": {"type": ["string", "null"]}, "url": {"type": "string"},
                "preview_url": {"type": "string"}, "my_role": {"type": ["string", "null"]},
                "updated_at": {"type": ["number", "null"]}, "edit_revision": {"type": "string"},
                "metadata": METADATA_OUT,
                "pages": {"type": "array", "items": {
                    "type": "object",
                    "properties": {
                        "id": {"type": ["string", "null"]}, "name": {"type": ["string", "null"]},
                        "metadata": {"type": "object"},
                        "node_count": {"type": "integer"}, "edge_count": {"type": "integer"},
                        "groups": {"type": "array", "items": {"type": "object"}},
                        "nodes": {"type": "array", "items": {"type": "object"}},
                        "flows": {"type": "array", "items": {"type": "string"}},
                        "edges": {"type": "array", "items": {"type": "object"}},
                        "inferred": {"type": "array", "items": {"type": "string"}},
                    },
                    "required": ["id", "node_count", "edge_count", "groups", "nodes", "flows"],
                }},
            },
            "required": ["id", "url", "preview_url", "pages"],
        },
        "annotations": _ann("Read board summary", read_only=True),
        "_meta": UI_META,
        "handler": t_read_board_summary,
    },
    {
        "name": "create_board",
        "title": "Create board",
        "description": "Only when the user explicitly chooses a NEW board — to revise an existing "
                       "diagram use clone_diagram instead. Creates an anonymous board (anyone with the "
                       "url can open and edit it). Pass category (architecture|flowchart|data|org|timeline) "
                       "and style/role per node for clear category colors. auto_fit=true and "
                       "auto_layout=true size text and clear overlaps; capture=true returns the crisp PNG "
                       "+ pixel-exact lint in ONE call. Set metadata {summary, tags, domain} (category is "
                       "filled from `category`) and node meta {tech, layer…} (role is recorded as "
                       "meta.role) so agents read it instantly.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "minLength": 1, "maxLength": 300},
                "diagram": DIAGRAM_IN,
                "category": {"type": "string", "enum": CATEGORY_ENUM,
                             "description": "Diagram category for semantic role->color mapping."},
                "palette": {"type": "string", "enum": PALETTE_ENUM,
                            "description": "board (snap to the noddle draw palette) | editorial | preserve."},
                "auto_fit": {"type": "boolean", "default": True,
                             "description": "Auto-size boxes to fit text with breathing room."},
                "auto_layout": {"type": "boolean", "default": True,
                                "description": "Auto-separate overlaps, widen edge-label gaps, grow frames."},
                "capture": {"type": "boolean", "default": False,
                            "description": "Return crisp 2x PNG + real DOM lint in this same call."},
                "capture_node_ids": {"type": "array", "items": {"type": "string"}, "maxItems": 1000,
                                     "description": "Optional node IDs to crop the PNG tightly around."},
                "metadata": DIAGRAM_METADATA_IN,
            },
            "required": ["name"],
            "additionalProperties": False,
        },
        "outputSchema": WRITE_OUT,
        "annotations": _ann("Create board", read_only=False, destructive=False, idempotent=False),
        "_meta": UI_META,
        "handler": t_create_board,
    },
    {
        "name": "patch_board",
        "title": "Patch board with atomic ops",
        "description": "PREFERRED write tool: apply small atomic ops (add/update/delete nodes/edges/pages) "
                       "without re-sending the full diagram. Collaboratively merges with open editors, "
                       "expands style/role colors by category, auto-fits text, clears overlaps, and with "
                       "capture=true returns crisp 2x PNG + real DOM lint in ONE call. metadata / "
                       "page_metadata (or op set_metadata) annotate the board; ops may be omitted then.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "doc_id": DOC_ID,
                "ops": PATCH_OPS_IN,
                "page_id": {"type": "string", "description": "Default page_id for ops in this batch."},
                "category": {"type": "string", "enum": CATEGORY_ENUM,
                             "description": "Diagram category for semantic role->color mapping."},
                "palette": {"type": "string", "enum": PALETTE_ENUM,
                            "description": "board (snap touched colors to the noddle palette) | editorial | preserve."},
                "auto_fit": {"type": "boolean", "default": True,
                             "description": "Auto-grow touched boxes so text never overflows."},
                "auto_layout": {"type": "boolean", "default": True,
                                "description": "Auto-separate overlaps, widen labeled-edge gaps, grow frames on touched objects."},
                "edit_revision": {"type": "string", "description": "From get_board / clone_diagram / prior write."},
                "expected_updated_at": {"type": "number"},
                "capture": {"type": "boolean", "default": False,
                            "description": "Render crisp 2x PNG + pixel-exact DOM lint in this same call."},
                "capture_node_ids": {"type": "array", "items": {"type": "string"}, "maxItems": 1000,
                                     "description": "Crop PNG tightly around these nodes (e.g. clone_node_ids)."},
                "metadata": DIAGRAM_METADATA_IN,
                "page_metadata": PAGE_METADATA_IN,
            },
            "required": ["doc_id"],
            "additionalProperties": False,
        },
        "outputSchema": WRITE_OUT,
        "annotations": _ann("Patch board ops", read_only=False, destructive=False, idempotent=False),
        "_meta": UI_META,
        "handler": t_patch_board,
    },
    {
        "name": "update_board",
        "title": "Replace board diagram",
        "description": "Full-diagram collaborative write (prefer patch_board for smaller diffs and "
                       "fewer tokens); a version snapshot is kept. Send the WHOLE diagram with its "
                       "edit_revision (or expected_updated_at): only the fields you changed merge with "
                       "the live board, so unrelated human edits survive; without a read base, "
                       "expected_updated_at fails instead of overwriting a newer edit. Optional "
                       "category/palette/auto_fit/auto_layout/capture apply hygiene and verify in one "
                       "call. Read post_save_check after EVERY write and report manual edits.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "doc_id": DOC_ID,
                "diagram": DIAGRAM_IN,
                "edit_revision": {"type": "string", "maxLength": 64,
                                  "description": "From get_board: merge only your changed fields "
                                                 "with live collaborators. Preferred."},
                "expected_updated_at": {"type": "number",
                                        "description": "updated_at from get_board (optimistic "
                                                       "concurrency when no read base is known)."},
                "category": {"type": "string", "enum": CATEGORY_ENUM},
                "palette": {"type": "string", "enum": PALETTE_ENUM},
                "auto_fit": {"type": "boolean", "default": False},
                "auto_layout": {"type": "boolean", "default": False},
                "capture": {"type": "boolean", "default": False},
                "capture_node_ids": {"type": "array", "items": {"type": "string"}, "maxItems": 1000},
            },
            "required": ["doc_id", "diagram"],
            "additionalProperties": False,
        },
        "outputSchema": WRITE_OUT,
        "annotations": _ann("Update board", read_only=False, destructive=True, idempotent=True),
        "handler": t_update_board,
    },
    {
        "name": "clone_diagram", "title": "Clone diagram beside original",
        "description": "FIRST step before editing an existing diagram. Clone all or selected nodes to "
                       "the right on the SAME page for safe before/after edits (originals preserved; "
                       "groups, edges and waypoints remapped; no new board). Returns edit_revision, "
                       "node_id_map, edge_id_map, and clone_node_ids (pass directly to "
                       "patch_board(..., capture=true, capture_node_ids=clone_node_ids)).",
        "inputSchema": {"type": "object", "properties": {
            "doc_id": DOC_ID, "page_id": {"type": "string"},
            "node_ids": {"type": "array", "items": {"type": "string"}, "maxItems": 1000},
            "gap": {"type": "number", "minimum": 80, "maximum": 1000, "default": 120},
            "expected_updated_at": {"type": "number"},
        }, "required": ["doc_id", "expected_updated_at"], "additionalProperties": False},
        "outputSchema": {"type": "object", "properties": {
            **WRITE_OUT["properties"], "page_id": {"type": "string"},
            "node_id_map": {"type": "object", "additionalProperties": {"type": "string"}},
            "edge_id_map": {"type": "object", "additionalProperties": {"type": "string"}},
            "clone_node_ids": {"type": "array", "items": {"type": "string"}},
            "offset": {"type": "object"}, "skipped_crossing_edge_ids": {"type": "array", "items": {"type": "string"}},
            "next_step": {"type": "string"},
        }, "required": ["id", "url", "updated_at", "page_id", "node_id_map", "edge_id_map"]},
        "annotations": _ann("Clone beside original", read_only=False, destructive=False, idempotent=False),
        "handler": t_clone_diagram,
    },
    {
        "name": "capture_board", "title": "Capture diagram PNG + pixel lint",
        "description": "Render a saved page in real Chromium and return a crisp PNG plus (by default) pixel-exact "
                       "DOM lint (text overflow, text overlap, edge crossings, overlaps) in ONE render. "
                       "Pass node_ids to crop tightly around a clone or section at sharp 2x scale. You must actually inspect the image; fails if the instance has no "
                       "headless browser installed.",
        "inputSchema": {"type": "object", "properties": {
            "doc_id": DOC_ID, "page_id": {"type": "string"},
            "expected_updated_at": {"type": "number",
                                    "description": "Fail if the board changed since this revision."},
            "node_ids": {"type": "array", "items": {"type": "string"}, "maxItems": 1000,
                         "description": "Crop PNG and lint tightly to these nodes (2x crisp zoom)."},
            "include_lint": {"type": "boolean", "default": True,
                             "description": "Return pixel-exact DOM lint from this same render."},
        }, "required": ["doc_id"], "additionalProperties": False},
        "outputSchema": {"type": "object", "properties": {
            "id": {"type": "string"}, "page_id": {"type": "string"}, "updated_at": {"type": "number"},
            "width": {"type": "integer"}, "height": {"type": "integer"}, "scale": {"type": "number"},
            "cropped": {"type": "boolean"},
            "renderer": {"type": "string"}, "scope": {"type": "string"}, "visual_validation": {"type": "string"},
            "lint": {"type": "object", "properties": {
                "error_count": {"type": "integer"}, "issue_count": {"type": "integer"},
                "dom_verified": {"type": "boolean"}, "issues": {"type": "array"},
            }},
        }, "required": ["id", "page_id", "updated_at", "width", "height", "renderer", "visual_validation"]},
        "annotations": _ann("Capture diagram PNG", read_only=True),
        "_meta": UI_META,
        "handler": t_capture_board,
    },
    {
        "name": "lint_board", "title": "Lint board layout",
        "description": "Audit a board without returning a PNG (prefer capture_board or patch_board(capture=true) "
                       "to get BOTH the PNG and pixel-exact lint in one render). Checks overlaps, text fit/overlap, "
                       "edge crossings, straddling frames, verbose labels, and monochrome coloring.",
        "inputSchema": {"type": "object", "properties": {
            "doc_id": DOC_ID, "page_id": {"type": "string", "description": "Lint only this page."},
            "check_routes": {"type": "boolean", "default": True,
                             "description": "Render each page for real DOM text & edge-route checks."},
        }, "required": ["doc_id"], "additionalProperties": False},
        "outputSchema": {"type": "object", "properties": {
            "id": {"type": "string"}, "url": {"type": "string"}, "updated_at": {"type": ["number", "null"]},
            "pages": {"type": "array"}, "error_count": {"type": "integer"}, "issue_count": {"type": "integer"},
            "issues": {"type": "array"}, "checklist": {"type": "string"},
            "routes_checked": {"type": "array"}, "routes_unchecked": {"type": "array"}, "note": {"type": "string"},
        }, "required": ["id", "issues", "issue_count", "error_count"]},
        "annotations": _ann("Lint board layout", read_only=True),
        "handler": t_lint_board,
    },
    {
        "name": "join_board",
        "title": "Join board",
        "description": "Show yourself in the board's live presence (as NODDLE_AGENT_NAME — an agent "
                       "named Claude gets the Claude icon) so people with the board open see you "
                       "are there. Changes nothing on the board. Call it when you start working "
                       "on a board; saves keep you visible too. Visible for ~5 minutes per join.",
        "inputSchema": {
            "type": "object", "properties": {"doc_id": DOC_ID},
            "required": ["doc_id"], "additionalProperties": False,
        },
        "outputSchema": {
            "type": "object",
            "properties": {
                "id": {"type": "string"}, "url": {"type": "string"},
                "joined_as": {"type": "object"}, "live_viewers": {"type": "boolean"},
                "visible_for_seconds": {"type": "number"},
            },
            "required": ["id", "joined_as", "live_viewers"],
        },
        "annotations": _ann("Join board", read_only=False, destructive=False, idempotent=True),
        "handler": t_join_board,
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
RESOURCE_LINK_TOOLS = {"get_board", "read_board_summary", "create_board", "patch_board", "update_board",
                       "rename_board"}
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
    png = structured.pop("png_base64", None) if isinstance(structured, dict) else None
    content: List[Dict[str, Any]] = [
        {"type": "text", "text": redact(json.dumps(structured, ensure_ascii=False))}
    ]
    if png:
        content.append({"type": "image", "mimeType": "image/png", "data": png})
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
    resources: List[Dict[str, Any]] = []
    if not params.get("cursor"):
        resources.append({
            "uri": STYLE_GUIDE_URI, "name": "style-guide", "title": "noddle diagram style guide",
            "mimeType": "text/markdown",
            "description": "Category color maps, style presets, and concise diagram rules.",
        })
        resources.append({
            "uri": PREVIEW_UI_URI, "name": "preview", "title": "noddle board preview card",
            "mimeType": PREVIEW_UI_MIME,
            "description": "MCP Apps inline preview: captured PNG, board metadata and an Open in noddle button.",
        })
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
    if uri == STYLE_GUIDE_URI:
        return {"uri": STYLE_GUIDE_URI, "mimeType": "text/markdown", "text": STYLE_GUIDE_TEXT}
    if uri == PREVIEW_UI_URI:
        # Static, self-contained template (no CDN, no board data baked in): the
        # host pushes the tool result to it over the MCP Apps postMessage bridge.
        return {"uri": PREVIEW_UI_URI, "mimeType": PREVIEW_UI_MIME, "text": PREVIEW_HTML,
                "_meta": {"ui": {"prefersBorder": False}}}
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
    uri = params.get("uri")
    if uri in (STYLE_GUIDE_URI, PREVIEW_UI_URI):  # static content: publicly cacheable
        return _cacheable(ctx, {"contents": [read_board_resource(ctx.backend, uri)]}, 3_600_000, "public")
    return _cacheable(ctx, {"contents": [read_board_resource(ctx.backend, uri)]},
                      5_000, "private")


PROMPTS = [
    {
        "name": "design_board",
        "title": "Design or revise a diagram",
        "description": "Draft a new board, or revise an existing one beside the original, capture "
                       "a PNG for visual review, then ask how to keep it.",
        "arguments": [
            {"name": "topic", "description": "What the diagram should explain.", "required": True},
            {"name": "doc_id", "description": "Existing board id or URL to revise beside the original.",
             "required": False},
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
        existing = args.get("doc_id", "").strip()
        if existing:
            try:
                doc_id = resolve_doc_id(ctx.backend, existing)
            except ToolError as e:
                raise RpcError(INVALID_PARAMS, str(e)) from None
            text = (
                f"Revise the diagram on board {doc_id} so it explains: {topic}\n"
                + (f"Constraints: {notes}\n" if notes else "")
                + "\n" + INSTRUCTIONS
            )
            return {"description": f"Revise board {doc_id} about {topic}",
                    "messages": [{"role": "user", "content": {"type": "text", "text": text}}]}
        text = (
            f"Create a noddle board that explains: {topic}\n"
            + (f"Constraints: {notes}\n" if notes else "")
            + "\nSteps:\n"
            "1. Call generate_diagram with a precise description (or Mermaid) of the components "
            "and how they connect — it returns editable diagram JSON. If no AI backend is "
            "available, write the diagram JSON yourself.\n"
            "2. Review that JSON: keep it to roughly 9 nodes or fewer per page, short labels, "
            "and edges attached to node ids.\n"
            "3. Call create_board with a clear name and the diagram, then lint_board and "
            "capture_board to check it visually; fix every lint error.\n"
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
            f"Review the noddle board above. First call lint_board (doc_id={doc_id}) and "
            "capture_board for each page, then judge clarity: overlapping or crowded shapes, "
            "leftover/duplicate shapes, text on text, unlabeled or ambiguous connectors, "
            "inconsistent colours, missing components. For each concrete issue call add_comment "
            f"anchored to the node_id or edge_id it concerns (doc_id={doc_id}). Do not change the "
            "diagram unless asked. Finish with a short prioritized summary (errors first)."
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
