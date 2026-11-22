"""Drive mcp/noddle_mcp.py's tool table in-process against the real FastAPI app.

The stdio server talks to noddle over plain REST with no credentials; here the
same ``Backend`` contract dispatches each call into a TestClient instead, so a
test exercises the real routes, the real merge/live-collab code and the real
tool handlers together — no sockets, no subprocess.
"""
from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from typing import Any

_MCP_PATH = Path(__file__).resolve().parents[2] / "mcp" / "noddle_mcp.py"


def core():
    """The noddle_mcp module (loaded once, by path — mcp/ is not a package)."""
    mod = sys.modules.get("noddle_mcp")
    if mod is None:
        spec = importlib.util.spec_from_file_location("noddle_mcp", _MCP_PATH)
        mod = importlib.util.module_from_spec(spec)
        sys.modules["noddle_mcp"] = mod
        spec.loader.exec_module(mod)
    return mod


def backend(client, agent_name: str = "MCP agent"):
    """A noddle_mcp.Backend whose REST calls go through ``client``."""
    m = core()

    class ClientBackend(m.Backend):
        base_url = "http://testserver"

        def __init__(self) -> None:
            self.agent_name = agent_name

        def call(self, method: str, path: str, payload: Any = None, timeout=None, headers=None):
            res = client.request(method, path, json=payload, headers=headers or {})
            if res.status_code >= 400:
                raise m.ApiError(res.status_code, m.format_api_error(res.status_code, res.content))
            return res.json() if res.content else None

    return ClientBackend()


def call(b, name: str, arguments: dict) -> dict:
    """tools/call through the server's own dispatcher (validation included)."""
    m = core()
    ctx = m.Ctx("modern", m.MODERN_VERSIONS[0], b)
    result = m.m_tools_call({"name": name, "arguments": arguments}, ctx)
    # Round-trip like the wire would.
    return json.loads(json.dumps(result))


def tool(b, name: str, arguments: dict) -> dict:
    result = call(b, name, arguments)
    assert not result["isError"], result
    return result["structuredContent"]


def rpc(b, method: str, params: dict | None = None) -> dict:
    """One JSON-RPC method through the server's own dispatch table (modern era),
    returned as the ``{"result": …}`` / ``{"error": …}`` envelope the wire carries."""
    m = core()
    ctx = m.Ctx("modern", m.MODERN_VERSIONS[0], b)
    handler = m.MODERN_METHODS[method]
    return json.loads(json.dumps(m.execute(1, handler, dict(params or {}), ctx)))
