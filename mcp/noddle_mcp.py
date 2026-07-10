#!/usr/bin/env python3
"""noddle MCP server — boards as tools for AI agents (Claude Code, etc.).

Stdlib-only (urllib + json), stdio transport: newline-delimited JSON-RPC 2.0
per the Model Context Protocol. The server is a thin wrapper over noddle's
REST API. noddle is anonymous (Excalidraw-style): a board's URL/id IS the
capability, so no token is needed — the agent works on any board id it is
given and signs its comments with NODDLE_AGENT_NAME.

Env:
  NODDLE_BASE_URL    default http://127.0.0.1:8000
  NODDLE_AGENT_NAME  display name for comments (default "MCP agent")

Run (see mcp/README.md for Claude Code registration):
  python3 mcp/noddle_mcp.py
"""
from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.request

BASE = os.environ.get("NODDLE_BASE_URL", "http://127.0.0.1:8000").rstrip("/")
AGENT_NAME = os.environ.get("NODDLE_AGENT_NAME", "MCP agent")[:40]

# Board ids are uuid4().hex[:12] — mirror the server's validator so an
# agent-supplied id can't smuggle path traversal / query chars into a URL.
_ID_RE = re.compile(r"^[0-9a-f]{12}$")


def _doc_id(args: dict) -> str:
    did = str(args.get("doc_id", ""))
    if not _ID_RE.match(did):
        raise ValueError(f"Invalid board id: {did!r} (expected 12 hex chars).")
    return did

PROTOCOL_VERSION = "2024-11-05"


# ---- noddle REST client ---------------------------------------------------------


def api(method: str, path: str, payload: dict | None = None) -> object:
    req = urllib.request.Request(
        BASE + path,
        method=method,
        headers={"Content-Type": "application/json"},
        data=json.dumps(payload).encode() if payload is not None else None,
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return json.loads(res.read().decode())
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:400]
        raise RuntimeError(f"noddle API {e.code}: {detail}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"noddle did not respond at {BASE}: {e.reason}") from e


# ---- tools ---------------------------------------------------------------------

TOOLS: list[dict] = [
    {
        "name": "get_board",
        "description": (
            "Fetch one board: name + the editable diagram JSON "
            "({pages:[{id,name,nodes,edges}]} or legacy {nodes,edges}). "
            "The share URL is {base}/d/{doc_id}."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {"doc_id": {"type": "string", "description": "12-hex board id"}},
            "required": ["doc_id"],
        },
    },
    {
        "name": "create_board",
        "description": (
            "Create a new board. Optional `diagram` is noddle diagram JSON — nodes "
            "need id/kind/x/y/w/h/text (+fill/stroke/strokeWidth); edges need "
            "id/source/target attachments ({kind:'floating',nodeId}) and routing "
            "'elbow'. Returns the new board id + URL."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "diagram": {"type": "object"},
            },
            "required": ["name"],
        },
    },
    {
        "name": "update_board",
        "description": (
            "Replace a board's diagram JSON (full-state, like the live protocol). "
            "Fetch with get_board first, modify, then send the whole diagram back."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "doc_id": {"type": "string"},
                "diagram": {"type": "object"},
            },
            "required": ["doc_id", "diagram"],
        },
    },
    {
        "name": "list_comments",
        "description": "List a board's comment threads (pins + replies).",
        "inputSchema": {
            "type": "object",
            "properties": {"doc_id": {"type": "string"}},
            "required": ["doc_id"],
        },
    },
    {
        "name": "add_comment",
        "description": (
            "Comment on a board (signed with NODDLE_AGENT_NAME). Anchor to a "
            "node (node_id), an edge (edge_id), or reply to a thread root "
            "(parent_id)."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "doc_id": {"type": "string"},
                "body": {"type": "string"},
                "node_id": {"type": "string"},
                "edge_id": {"type": "string"},
                "parent_id": {"type": "string"},
            },
            "required": ["doc_id", "body"],
        },
    },
]


def call_tool(name: str, args: dict) -> str:
    if name == "get_board":
        did = _doc_id(args)
        doc = api("GET", f"/api/documents/{did}")
        assert isinstance(doc, dict)
        return json.dumps(
            {
                "id": did,
                "name": (doc.get("meta") or {}).get("name"),
                "url": f"{BASE}/d/{did}",
                "my_role": doc.get("my_role"),
                "diagram": doc.get("diagram"),
            },
            ensure_ascii=False,
        )

    if name == "create_board":
        body: dict = {"name": args["name"]}
        if args.get("diagram"):
            body["diagram"] = args["diagram"]
        meta = api("POST", "/api/documents/new", body)
        assert isinstance(meta, dict)
        return json.dumps(
            {"id": meta.get("id"), "url": f"{BASE}/d/{meta.get('id')}"},
            ensure_ascii=False,
        )

    if name == "update_board":
        did = _doc_id(args)
        doc = api("GET", f"/api/documents/{did}")
        assert isinstance(doc, dict)
        api(
            "PUT",
            f"/api/documents/{did}",
            {
                "svg": doc.get("svg") or "",
                "diagram": args["diagram"],
                "author_name": AGENT_NAME,
            },
        )
        return json.dumps({"ok": True, "url": f"{BASE}/d/{did}"})

    if name == "list_comments":
        did = _doc_id(args)
        out = api("GET", f"/api/documents/{did}/comments")
        return json.dumps(out, ensure_ascii=False)

    if name == "add_comment":
        did = _doc_id(args)
        body: dict = {"body": args["body"], "guest_name": AGENT_NAME}
        if args.get("parent_id"):
            body["parent_id"] = args["parent_id"]
        elif args.get("node_id"):
            body["anchor"] = {"kind": "node", "ref": args["node_id"]}
        elif args.get("edge_id"):
            body["anchor"] = {"kind": "edge", "ref": args["edge_id"]}
        else:
            body["anchor"] = {"kind": "point", "x": 100.0, "y": 100.0}
        out = api("POST", f"/api/documents/{did}/comments", body)
        return json.dumps(out, ensure_ascii=False)

    raise RuntimeError(f"Unknown tool: {name}")


# ---- JSON-RPC over stdio --------------------------------------------------------


def reply(msg_id: object, result: dict) -> None:
    sys.stdout.write(
        json.dumps({"jsonrpc": "2.0", "id": msg_id, "result": result}) + "\n"
    )
    sys.stdout.flush()


def reply_error(msg_id: object, code: int, message: str) -> None:
    sys.stdout.write(
        json.dumps(
            {"jsonrpc": "2.0", "id": msg_id, "error": {"code": code, "message": message}}
        )
        + "\n"
    )
    sys.stdout.flush()


def main() -> int:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        method = msg.get("method")
        msg_id = msg.get("id")
        if method == "initialize":
            reply(
                msg_id,
                {
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "noddle", "version": "0.1.0"},
                },
            )
        elif method == "notifications/initialized":
            continue  # notification — no response
        elif method == "tools/list":
            reply(msg_id, {"tools": TOOLS})
        elif method == "tools/call":
            params = msg.get("params") or {}
            try:
                text = call_tool(params.get("name", ""), params.get("arguments") or {})
                reply(msg_id, {"content": [{"type": "text", "text": text}]})
            except Exception as e:  # noqa: BLE001 — surface as tool error, keep serving
                reply(
                    msg_id,
                    {"content": [{"type": "text", "text": f"ERROR: {e}"}], "isError": True},
                )
        elif method == "ping":
            reply(msg_id, {})
        elif msg_id is not None:
            reply_error(msg_id, -32601, f"Method not found: {method}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
