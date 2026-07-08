#!/usr/bin/env python3
"""noddle MCP server — boards as tools for AI agents (Claude Code, etc.).

Stdlib-only (urllib + json), stdio transport: newline-delimited JSON-RPC 2.0
per the Model Context Protocol. The server is a thin wrapper over noddle's
REST API; identity is an noddle AGENT TOKEN (`noddle_…`) so every edit shows up
in presence/authorship as the agent itself (ADR-0002).

Env:
  NODDLE_TOKEN      required — agent token (create one in Account → API tokens;
                   needs the boards:write scope to edit).
  NODDLE_BASE_URL   default http://127.0.0.1:8000

Run (see mcp/README.md for Claude Code registration):
  NODDLE_TOKEN=noddle_… python3 mcp/noddle_mcp.py
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

BASE = os.environ.get("NODDLE_BASE_URL", "http://127.0.0.1:8000").rstrip("/")
TOKEN = os.environ.get("NODDLE_TOKEN", "")

PROTOCOL_VERSION = "2024-11-05"


# ---- noddle REST client ---------------------------------------------------------


def api(method: str, path: str, payload: dict | None = None) -> object:
    req = urllib.request.Request(
        BASE + path,
        method=method,
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Content-Type": "application/json",
        },
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
        "name": "list_boards",
        "description": "List the boards this agent can see (id, name, updated_at).",
        "inputSchema": {"type": "object", "properties": {}, "required": []},
    },
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
            "Comment on a board as this agent. Anchor to a node (node_id), an "
            "edge (edge_id), or reply to a thread root (parent_id)."
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
    if name == "list_boards":
        docs = api("GET", "/api/documents")
        return json.dumps(docs, ensure_ascii=False)

    if name == "get_board":
        doc = api("GET", f"/api/documents/{args['doc_id']}")
        assert isinstance(doc, dict)
        return json.dumps(
            {
                "id": args["doc_id"],
                "name": (doc.get("meta") or {}).get("name"),
                "url": f"{BASE}/d/{args['doc_id']}",
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
        doc = api("GET", f"/api/documents/{args['doc_id']}")
        assert isinstance(doc, dict)
        api(
            "PUT",
            f"/api/documents/{args['doc_id']}",
            {"svg": doc.get("svg") or "", "diagram": args["diagram"]},
        )
        return json.dumps({"ok": True, "url": f"{BASE}/d/{args['doc_id']}"})

    if name == "list_comments":
        out = api("GET", f"/api/documents/{args['doc_id']}/comments")
        return json.dumps(out, ensure_ascii=False)

    if name == "add_comment":
        body: dict = {"body": args["body"]}
        if args.get("parent_id"):
            body["parent_id"] = args["parent_id"]
        elif args.get("node_id"):
            body["anchor"] = {"kind": "node", "ref": args["node_id"]}
        elif args.get("edge_id"):
            body["anchor"] = {"kind": "edge", "ref": args["edge_id"]}
        else:
            body["anchor"] = {"kind": "point", "x": 100.0, "y": 100.0}
        out = api("POST", f"/api/documents/{args['doc_id']}/comments", body)
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
    if not TOKEN:
        print("NODDLE_TOKEN is not set (agent token noddle_…).", file=sys.stderr)
        return 2
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
