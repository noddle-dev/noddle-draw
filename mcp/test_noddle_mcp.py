"""Drive mcp/noddle_mcp.py over stdio against a FAKE noddle draw REST backend.

stdlib unittest, pytest-compatible:
    python3 -m pytest mcp -q        or        python3 -m unittest discover mcp
"""
from __future__ import annotations

import json
import os
import queue
import re
import subprocess
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional

SERVER = Path(__file__).with_name("noddle_mcp.py")
AI_KEY = "fake-ai-key-for-redaction-test"
MODERN = "2026-07-28"
DOC = "0123456789ab"
VIEW_ONLY = "aaaaaaaaaaaa"


def modern_meta(version: str = MODERN) -> Dict[str, Any]:
    return {"io.modelcontextprotocol/protocolVersion": version,
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/clientInfo": {"name": "test", "version": "0"}}


def board(bid: str, name: str, policy: str = "edit", diagram: Any = None) -> Dict[str, Any]:
    return {"meta": {"id": bid, "name": name, "created_at": 1.0, "updated_at": 2.0,
                     "link_policy": policy},
            "svg": "<svg/>", "my_role": "editor" if policy == "edit" else "viewer",
            "diagram": diagram}


class FakeNoddle:
    """Just enough of the anonymous /api to exercise every tool; records writes."""

    def __init__(self) -> None:
        self.boards: Dict[str, Dict[str, Any]] = {
            DOC: board(DOC, "Payment flow", diagram={"pages": [{"id": "p1", "name": "Page 1", "nodes": [
                {"id": "n1", "kind": "freedraw", "x": 0, "y": 0, "w": 10, "h": 10, "text": "",
                 "fill": "none", "stroke": "#000", "strokeWidth": 1, "points": [[0, 0], [5, 5]]}],
                "edges": []}]}),
            VIEW_ONLY: board(VIEW_ONLY, "Read me", policy="view"),
        }
        self.puts: List[Dict[str, Any]] = []
        self.patches: List[Dict[str, Any]] = []
        self.comments: List[Dict[str, Any]] = []
        self.ai_calls: List[Dict[str, Any]] = []
        self.auth_headers: List[str] = []
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), self._handler())
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def _handler(self):
        fake = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):  # keep test output quiet
                pass

            def _send(self, code: int, obj: Any) -> None:
                body = json.dumps(obj).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def _body(self) -> Any:
                n = int(self.headers.get("Content-Length") or 0)
                return json.loads(self.rfile.read(n)) if n else None

            def _route(self, method: str) -> None:
                if self.headers.get("Authorization"):
                    fake.auth_headers.append(self.headers["Authorization"])
                path = self.path.split("?")[0]
                m = re.match(r"^/api/documents/([0-9a-f]{12})(/.*)?$", path)
                if method == "POST" and path == "/api/documents/new":
                    body = self._body()
                    bid = "fedcba987654"
                    fake.boards[bid] = board(bid, body["name"], diagram=body.get("diagram"))
                    fake.boards[bid]["meta"]["updated_at"] = 3.0
                    return self._send(200, fake.boards[bid]["meta"])  # bare DocMeta
                if method == "POST" and path == "/api/ai/text-to-diagram":
                    fake.ai_calls.append({"body": self._body(),
                                          "key": self.headers.get("X-AI-Key"),
                                          "provider": self.headers.get("X-AI-Provider")})
                    if not self.headers.get("X-AI-Key"):
                        return self._send(503, {"detail": "No AI backend available"})
                    if self.headers.get("X-AI-Provider") == "custom":
                        # an upstream error that echoes the key back — we must redact it
                        return self._send(422, {"detail": f"bad key {self.headers.get('X-AI-Key')}"})
                    return self._send(200, {"nodes": [], "edges": []})
                if not m or m.group(1) not in fake.boards:
                    return self._send(404, {"detail": "Document not found."})
                b, sub = fake.boards[m.group(1)], m.group(2) or ""
                writable = b["meta"]["link_policy"] == "edit"
                if method == "GET" and sub == "":
                    return self._send(200, b)
                if method in ("PUT", "PATCH") and sub == "" and not writable:
                    return self._send(403, {"detail": "This board's link is view-only."})
                if method == "PUT" and sub == "":
                    body = self._body()
                    fake.puts.append(body)
                    b["diagram"] = body["diagram"]
                    b["meta"]["updated_at"] += 1
                    return self._send(200, b["meta"])
                if method == "PATCH" and sub == "":
                    body = self._body()
                    fake.patches.append(body)
                    b["meta"]["name"] = body["name"]
                    return self._send(200, b["meta"])
                if method == "GET" and sub == "/versions":
                    return self._send(200, [{"id": "v1", "created_at": 5.0, "author_name": "MCP agent"}])
                if method == "GET" and sub == "/versions/v1":
                    return self._send(200, {"id": "v1", "created_at": 5.0, "author_name": "x",
                                            "svg": "<svg/>", "diagram": {"nodes": [], "edges": []}})
                if method == "GET" and sub == "/comments":
                    return self._send(200, {"comments": fake.comments})
                if method == "POST" and sub == "/comments":
                    body = self._body()
                    fake.comments.append(dict(body, id="c1"))
                    return self._send(200, {"comments": fake.comments})
                return self._send(404, {"detail": "nope"})

            def do_GET(self):
                self._route("GET")

            def do_POST(self):
                self._route("POST")

            def do_PUT(self):
                self._route("PUT")

            def do_PATCH(self):
                self._route("PATCH")

        return H


class McpProc:
    def __init__(self, base_url: str, extra_env: Optional[Dict[str, str]] = None) -> None:
        env = {k: v for k, v in os.environ.items() if not k.startswith("NODDLE_")}
        env.update(NODDLE_BASE_URL=base_url, NODDLE_TIMEOUT="5", NODDLE_AGENT_NAME="Test agent")
        env.update(extra_env or {})
        self.p = subprocess.Popen([sys.executable, str(SERVER)], stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
        self.lines: List[str] = []
        self._next = 0
        self._q: "queue.Queue[Optional[str]]" = queue.Queue()
        threading.Thread(target=self._pump, daemon=True).start()

    def _pump(self) -> None:
        assert self.p.stdout is not None
        for raw in iter(self.p.stdout.readline, b""):
            line = raw.decode()
            self.lines.append(line)
            self._q.put(line)
        self._q.put(None)

    def write_raw(self, text: str) -> None:
        assert self.p.stdin is not None
        self.p.stdin.write(text.encode() + b"\n")
        self.p.stdin.flush()

    def send(self, obj: Any) -> None:
        self.write_raw(json.dumps(obj))

    def read(self, timeout: float = 10.0) -> Any:
        try:
            line = self._q.get(timeout=timeout)
        except queue.Empty:
            raise TimeoutError("no response") from None
        if line is None:
            raise EOFError("server closed stdout")
        return json.loads(line)

    def request(self, method: str, params: Optional[Dict[str, Any]] = None,
                meta: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        self._next += 1
        params = dict(params or {})
        if meta is not None:
            params["_meta"] = meta
        self.send({"jsonrpc": "2.0", "id": self._next, "method": method, "params": params})
        resp = self.read()
        assert resp.get("id") == self._next, resp
        return resp

    def call(self, name: str, args: Dict[str, Any]) -> Dict[str, Any]:
        return self.request("tools/call", {"name": name, "arguments": args}, meta=modern_meta())

    def close(self) -> int:
        assert self.p.stdin is not None
        self.p.stdin.close()
        self.stderr = self.p.stderr.read().decode() if self.p.stderr else ""
        code = self.p.wait(timeout=10)
        while self._q.get(timeout=5) is not None:  # drain until the pump hits EOF
            pass
        return code


class _Harness(unittest.TestCase):
    """Fake REST backend + a real server subprocess per test (no tests itself)."""

    extra_env: Dict[str, str] = {}

    def setUp(self) -> None:
        self.fake = FakeNoddle()
        self.fake.thread.start()
        self.mcp = McpProc(self.fake.url, self.extra_env)

    def tearDown(self) -> None:
        code = self.mcp.close()
        self.fake.httpd.shutdown()
        self.fake.httpd.server_close()
        self.assertEqual(code, 0, "server must exit 0 on stdin EOF")
        # Nothing but JSON-RPC 2.0 messages on stdout, ever.
        for line in self.mcp.lines:
            msg = json.loads(line)
            items = msg if isinstance(msg, list) else [msg]
            for item in items:
                self.assertEqual(item.get("jsonrpc"), "2.0", line)
                self.assertTrue("result" in item or "error" in item or "method" in item, line)
        # Anonymous model: the server never authenticates.
        self.assertEqual(self.fake.auth_headers, [])
        self.assertNotIn(AI_KEY, self.mcp.stderr)
        self.assertNotIn(AI_KEY, "".join(self.mcp.lines))



class StdioServerTest(_Harness):
    # -- lifecycle / versioning -------------------------------------------------

    def test_modern_discover(self) -> None:
        r = self.mcp.request("server/discover", meta=modern_meta())["result"]
        self.assertEqual(r["resultType"], "complete")
        self.assertIn(MODERN, r["supportedVersions"])
        self.assertEqual(set(r["capabilities"]), {"tools", "resources", "prompts"})
        self.assertEqual(r["_meta"]["io.modelcontextprotocol/serverInfo"]["name"], "noddle")
        self.assertIn(r["cacheScope"], ("public", "private"))
        self.assertIsInstance(r["ttlMs"], int)

    def test_modern_unsupported_version(self) -> None:
        r = self.mcp.request("tools/list", meta=modern_meta("1900-01-01"))
        self.assertEqual(r["error"]["code"], -32022)
        self.assertEqual(r["error"]["data"]["requested"], "1900-01-01")
        self.assertIn(MODERN, r["error"]["data"]["supported"])

    def test_modern_missing_capabilities_is_invalid_params(self) -> None:
        r = self.mcp.request("tools/list", meta={"io.modelcontextprotocol/protocolVersion": MODERN})
        self.assertEqual(r["error"]["code"], -32602)

    def test_no_meta_no_initialize_is_rejected(self) -> None:
        r = self.mcp.request("tools/list")
        self.assertEqual(r["error"]["code"], -32602)
        self.assertIn("initialize", r["error"]["message"])

    def test_legacy_initialize_negotiation(self) -> None:
        r = self.mcp.request("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                            "clientInfo": {"name": "t", "version": "0"}})["result"]
        self.assertEqual(r["protocolVersion"], "2025-06-18")
        self.assertEqual(r["serverInfo"]["name"], "noddle")
        self.assertIn("title", r["serverInfo"])
        self.assertIn("tools", r["capabilities"])
        self.mcp.send({"jsonrpc": "2.0", "method": "notifications/initialized"})  # no reply
        self.assertEqual(self.mcp.request("ping")["result"], {})
        tl = self.mcp.request("tools/list")["result"]
        self.assertNotIn("resultType", tl)  # modern-only fields stay out of legacy results
        self.assertTrue(tl["tools"])

    def test_legacy_oldest_version_and_unknown_version(self) -> None:
        r = self.mcp.request("initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                                            "clientInfo": {"name": "t", "version": "0"}})["result"]
        self.assertEqual(r["protocolVersion"], "2024-11-05")
        self.assertNotIn("title", r["serverInfo"])  # not in that revision
        # 2024-11-05 predates resource_link content blocks
        got = self.mcp.request("tools/call", {"name": "get_board", "arguments": {"doc_id": DOC}})
        self.assertFalse(any(c["type"] == "resource_link" for c in got["result"]["content"]))
        r = self.mcp.request("initialize", {"protocolVersion": "2099-01-01", "capabilities": {},
                                            "clientInfo": {"name": "t", "version": "0"}})["result"]
        self.assertEqual(r["protocolVersion"], "2025-11-25")

    def test_ping_removed_in_modern(self) -> None:
        self.assertEqual(self.mcp.request("ping", meta=modern_meta())["error"]["code"], -32601)

    # -- tools -----------------------------------------------------------------------

    def test_tools_list_schemas(self) -> None:
        r = self.mcp.request("tools/list", meta=modern_meta())["result"]
        self.assertEqual(r["resultType"], "complete")
        self.assertIn("ttlMs", r)
        names = [t["name"] for t in r["tools"]]
        self.assertEqual(len(names), len(set(names)))
        # Anonymous OSS API: no listing, no delete.
        self.assertNotIn("list_boards", names)
        self.assertFalse([n for n in names if "delete" in n])
        try:
            from jsonschema import Draft202012Validator  # optional, dev-only
        except ImportError:
            Draft202012Validator = None
        for t in r["tools"]:
            self.assertRegex(t["name"], r"^[a-z][a-z0-9_]{0,127}$")
            self.assertTrue(t["title"] and t["description"])
            self.assertNotIn("handler", t)
            schema = t["inputSchema"]
            self.assertEqual(schema["type"], "object")
            self.assertTrue(set(schema.get("required", [])) <= set(schema.get("properties", {})), t["name"])
            ann = t["annotations"]
            self.assertIsInstance(ann["readOnlyHint"], bool)
            self.assertIsInstance(ann["openWorldHint"], bool)
            if not ann["readOnlyHint"]:
                self.assertIsInstance(ann["destructiveHint"], bool)
                self.assertIsInstance(ann["idempotentHint"], bool)
            self.assertIn("outputSchema", t)
            if Draft202012Validator:
                Draft202012Validator.check_schema(schema)
                Draft202012Validator.check_schema(t["outputSchema"])
        by = {t["name"]: t["annotations"] for t in r["tools"]}
        self.assertTrue(by["get_board"]["readOnlyHint"])
        self.assertTrue(by["update_board"]["destructiveHint"])
        self.assertFalse(by["create_board"]["idempotentHint"])
        self.assertTrue(by["generate_diagram"]["openWorldHint"])

    def test_read_tool_get_board(self) -> None:
        r = self.mcp.call("get_board", {"doc_id": DOC})["result"]
        self.assertFalse(r["isError"])
        sc = r["structuredContent"]
        self.assertEqual(sc["name"], "Payment flow")
        self.assertEqual(sc["my_role"], "editor")
        self.assertEqual(sc["url"], f"{self.fake.url}/d/{DOC}")
        self.assertEqual(sc["pages"][0]["node_count"], 1)
        node = sc["diagram"]["pages"][0]["nodes"][0]
        self.assertEqual(node["points"], [[0, 0], [5, 5]])  # new fields pass through
        self.assertEqual(json.loads(r["content"][0]["text"]), sc)
        self.assertTrue(any(c["type"] == "resource_link" for c in r["content"]))
        self._check_output_schema("get_board", sc)

    def test_board_url_is_accepted_as_id(self) -> None:
        r = self.mcp.call("get_board", {"doc_id": f"{self.fake.url}/d/{DOC}?x=1"})["result"]
        self.assertFalse(r["isError"], r)
        self.assertEqual(r["structuredContent"]["id"], DOC)
        other = self.mcp.call("get_board", {"doc_id": f"https://elsewhere.example/d/{DOC}"})["result"]
        self.assertTrue(other["isError"])
        self.assertIn("NODDLE_BASE_URL", other["content"][0]["text"])

    def test_write_tool_update_board(self) -> None:
        diagram = {"pages": [{"id": "p1", "name": "Page 1", "nodes": [], "edges": [
            {"id": "e1", "source": {"kind": "free", "point": {"x": 0, "y": 0}},
             "target": {"kind": "free", "point": {"x": 9, "y": 9}}, "routing": "curved",
             "stroke": "#000", "strokeWidth": 1, "endArrow": True, "startArrow": False,
             "animated": False}]}]}
        before = self.mcp.call("get_board", {"doc_id": DOC})["result"]["structuredContent"]
        r = self.mcp.call("update_board", {"doc_id": DOC, "diagram": diagram,
                                           "expected_updated_at": before["updated_at"]})["result"]
        self.assertFalse(r["isError"], r)
        self.assertEqual(self.fake.puts[-1]["diagram"], diagram)  # pass-through, curved kept
        self.assertEqual(self.fake.puts[-1]["svg"], "<svg/>")
        self.assertEqual(self.fake.puts[-1]["author_name"], "Test agent")
        stale = self.mcp.call("update_board", {"doc_id": DOC, "diagram": diagram,
                                               "expected_updated_at": before["updated_at"]})["result"]
        self.assertTrue(stale["isError"])
        self.assertIn("conflict", stale["content"][0]["text"])

    def test_view_only_link_write_is_tool_error(self) -> None:
        r = self.mcp.call("update_board", {"doc_id": VIEW_ONLY, "diagram": {"nodes": [], "edges": []}})
        self.assertTrue(r["result"]["isError"])
        self.assertIn("403", r["result"]["content"][0]["text"])
        self.assertIn("view-only", r["result"]["content"][0]["text"])

    def test_create_rename_and_comment(self) -> None:
        r = self.mcp.call("create_board", {"name": "New one"})["result"]
        self.assertFalse(r["isError"], r)
        self.assertEqual(r["structuredContent"]["id"], "fedcba987654")
        self._check_output_schema("create_board", r["structuredContent"])
        rn = self.mcp.call("rename_board", {"doc_id": "fedcba987654", "name": "Renamed"})["result"]
        self.assertEqual(rn["structuredContent"]["name"], "Renamed")
        self.assertEqual(self.fake.patches[-1], {"name": "Renamed"})
        c = self.mcp.call("add_comment", {"doc_id": DOC, "body": "check indexes", "node_id": "n1"})
        self.assertFalse(c["result"]["isError"])
        self.assertEqual(self.fake.comments[-1]["anchor"], {"kind": "node", "ref": "n1"})
        self.assertEqual(self.fake.comments[-1]["guest_name"], "Test agent")
        lc = self.mcp.call("list_comments", {"doc_id": DOC})["result"]["structuredContent"]
        self.assertEqual(len(lc["comments"]), 1)
        both = self.mcp.call("add_comment", {"doc_id": DOC, "body": "x", "node_id": "a", "edge_id": "b"})
        self.assertTrue(both["result"]["isError"])
        unknown = self.mcp.call("add_comment", {"doc_id": DOC, "body": "x", "mentions": ["u1"]})
        self.assertTrue(unknown["result"]["isError"])  # no @mentions in the anonymous edition

    def test_versions(self) -> None:
        lv = self.mcp.call("list_versions", {"doc_id": DOC})["result"]["structuredContent"]
        self.assertEqual(lv["versions"][0]["id"], "v1")
        gv = self.mcp.call("get_version", {"doc_id": DOC, "version_id": "v1"})["result"]
        self.assertEqual(gv["structuredContent"]["diagram"], {"nodes": [], "edges": []})
        self.assertNotIn("svg", gv["structuredContent"])
        bad = self.mcp.call("get_version", {"doc_id": DOC, "version_id": "../x"})["result"]
        self.assertTrue(bad["isError"])

    def test_generate_diagram_without_key_uses_pool(self) -> None:
        r = self.mcp.call("generate_diagram", {"text": "A -> B", "format": "mermaid"})["result"]
        self.assertTrue(r["isError"])  # the fake has no pool → 503
        self.assertIn("503", r["content"][0]["text"])
        self.assertEqual(self.fake.ai_calls[-1]["body"], {"text": "A -> B", "format": "mermaid"})
        self.assertIsNone(self.fake.ai_calls[-1]["key"])

    def test_argument_validation_is_tool_error(self) -> None:
        r = self.mcp.call("get_board", {"doc_id": "../../etc/passwd"})["result"]
        self.assertTrue(r["isError"])
        r = self.mcp.call("update_board", {"doc_id": DOC, "diagram": {"foo": 1}})["result"]
        self.assertTrue(r["isError"])
        r = self.mcp.call("get_board", {"doc_id": DOC, "extra": 1})["result"]
        self.assertTrue(r["isError"])

    def test_unknown_tool_is_protocol_error(self) -> None:
        r = self.mcp.call("drop_tables", {})
        self.assertEqual(r["error"]["code"], -32602)

    def test_api_404_is_tool_error(self) -> None:
        r = self.mcp.call("get_board", {"doc_id": "ffffffffffff"})["result"]
        self.assertTrue(r["isError"])
        self.assertIn("404", r["content"][0]["text"])

    # -- resources / prompts -----------------------------------------------------------

    def test_resources(self) -> None:
        lst = self.mcp.request("resources/list", meta=modern_meta())["result"]
        self.assertEqual(lst["resources"], [])  # nothing known yet — there is no listing API
        self.assertEqual(lst["cacheScope"], "private")
        self.mcp.call("get_board", {"doc_id": DOC})
        self.mcp.call("create_board", {"name": "New one"})
        uris = [x["uri"] for x in self.mcp.request("resources/list", meta=modern_meta())["result"]["resources"]]
        self.assertEqual(uris, ["noddle://board/fedcba987654", f"noddle://board/{DOC}"])  # newest first
        tpl = self.mcp.request("resources/templates/list", meta=modern_meta())["result"]
        self.assertEqual(tpl["resourceTemplates"][0]["uriTemplate"], "noddle://board/{doc_id}")
        rd = self.mcp.request("resources/read", {"uri": f"noddle://board/{VIEW_ONLY}"}, meta=modern_meta())
        self.assertEqual(json.loads(rd["result"]["contents"][0]["text"])["id"], VIEW_ONLY)
        missing = self.mcp.request("resources/read", {"uri": "noddle://board/ffffffffffff"},
                                   meta=modern_meta())
        self.assertEqual(missing["error"]["code"], -32602)
        bogus = self.mcp.request("resources/read", {"uri": "file:///etc/passwd"}, meta=modern_meta())
        self.assertEqual(bogus["error"]["code"], -32602)

    def test_prompts(self) -> None:
        lst = self.mcp.request("prompts/list", meta=modern_meta())["result"]
        self.assertEqual([p["name"] for p in lst["prompts"]], ["design_board", "review_board"])
        got = self.mcp.request("prompts/get", {"name": "review_board", "arguments": {"doc_id": DOC}},
                               meta=modern_meta())["result"]
        self.assertEqual(got["messages"][0]["content"]["type"], "resource")
        design = self.mcp.request("prompts/get", {"name": "design_board", "arguments": {"topic": "CI"}},
                                  meta=modern_meta())["result"]
        self.assertIn("create_board", design["messages"][0]["content"]["text"])
        bad = self.mcp.request("prompts/get", {"name": "design_board", "arguments": {}}, meta=modern_meta())
        self.assertEqual(bad["error"]["code"], -32602)
        bad_id = self.mcp.request("prompts/get", {"name": "review_board", "arguments": {"doc_id": "x"}},
                                  meta=modern_meta())
        self.assertEqual(bad_id["error"]["code"], -32602)

    # -- JSON-RPC error paths ---------------------------------------------------------

    def test_unknown_method(self) -> None:
        self.assertEqual(self.mcp.request("boards/explode", meta=modern_meta())["error"]["code"], -32601)

    def test_malformed_json(self) -> None:
        self.mcp.write_raw('{"jsonrpc": "2.0", "id": 1, "method": ')
        r = self.mcp.read()
        self.assertEqual(r["error"]["code"], -32700)
        self.assertIsNone(r["id"])

    def test_invalid_request_and_batch(self) -> None:
        self.mcp.send({"jsonrpc": "2.0", "id": None, "method": "tools/list"})
        self.assertEqual(self.mcp.read()["error"]["code"], -32600)
        self.mcp.send([{"jsonrpc": "2.0", "id": 9, "method": "tools/list"}])
        self.assertEqual(self.mcp.read()["error"]["code"], -32600)

    def test_legacy_2025_03_26_batch(self) -> None:
        self.mcp.request("initialize", {"protocolVersion": "2025-03-26", "capabilities": {},
                                        "clientInfo": {"name": "t", "version": "0"}})
        self.mcp.send([{"jsonrpc": "2.0", "id": 41, "method": "ping"},
                       {"jsonrpc": "2.0", "method": "notifications/initialized"},
                       {"jsonrpc": "2.0", "id": 42, "method": "prompts/list"}])
        out = self.mcp.read()
        self.assertEqual(sorted(x["id"] for x in out), [41, 42])

    def test_notifications_get_no_response(self) -> None:
        self.mcp.send({"jsonrpc": "2.0", "method": "notifications/whatever"})
        self.mcp.send({"jsonrpc": "2.0", "method": "tools/list"})  # notification, even if a request name
        r = self.mcp.request("server/discover", meta=modern_meta())
        self.assertIn("result", r)  # the very next line is the discover answer

    def _check_output_schema(self, tool: str, value: Any) -> None:
        sys.path.insert(0, str(SERVER.parent))
        import noddle_mcp  # noqa: E402 — validate with the server's own validator

        schema = noddle_mcp.TOOLS_BY_NAME[tool]["outputSchema"]
        self.assertEqual(noddle_mcp.validate(schema, value, "out"), [])


class ByokTest(_Harness):
    """generate_diagram forwards a bring-your-own key as X-AI-* headers and
    never lets it leak (tearDown asserts AI_KEY is absent from stdout/stderr)."""

    extra_env = {"NODDLE_AI_PROVIDER": "claude", "NODDLE_AI_KEY": AI_KEY}

    def test_generate_diagram_with_key(self) -> None:
        r = self.mcp.call("generate_diagram", {"text": "A -> B"})["result"]
        self.assertFalse(r["isError"], r)
        self.assertEqual(r["structuredContent"], {"diagram": {"nodes": [], "edges": []}})
        self.assertEqual(self.fake.ai_calls[-1]["key"], AI_KEY)
        self.assertEqual(self.fake.ai_calls[-1]["provider"], "claude")


class EchoedKeyTest(_Harness):
    extra_env = {"NODDLE_AI_PROVIDER": "custom", "NODDLE_AI_KEY": AI_KEY}

    def test_upstream_error_echoing_key_is_redacted(self) -> None:
        r = self.mcp.call("generate_diagram", {"text": "A -> B"})["result"]
        self.assertTrue(r["isError"])
        self.assertIn("422", r["content"][0]["text"])
        self.assertIn("[redacted]", r["content"][0]["text"])


class CoreTest(unittest.TestCase):
    """The transport-neutral core with a pluggable Backend."""

    def setUp(self) -> None:
        sys.path.insert(0, str(SERVER.parent))
        import noddle_mcp  # noqa: E402

        self.nm = noddle_mcp

    def test_defaults_are_oss(self) -> None:
        cfg = self.nm.Config({})
        self.assertEqual(cfg.base_url, "https://draw.noddle.dev")
        self.assertEqual(cfg.agent_name, "MCP agent")
        self.assertEqual(cfg.ai_headers(), {})
        src = SERVER.read_text()
        for banned in ("NODDLE_TOKEN", "Bearer", "board.noddle.dev", "scopes"):
            self.assertNotIn(banned, src)

    def test_custom_backend(self) -> None:
        nm = self.nm
        calls: List[Any] = []

        class Fake(nm.Backend):
            base_url = "https://example.test"

            def call(self, method, path, payload=None, timeout=None, headers=None):
                calls.append((method, path))
                return {"meta": {"id": DOC, "name": "B", "updated_at": 1}, "svg": "", "diagram": None}

        ctx = nm.Ctx("modern", "2026-07-28", backend=Fake())
        res = nm.m_tools_call({"name": "get_board", "arguments": {"doc_id": DOC}}, ctx)
        self.assertFalse(res["isError"])
        self.assertEqual(res["structuredContent"]["url"], f"https://example.test/d/{DOC}")
        self.assertEqual(calls, [("GET", f"/api/documents/{DOC}")])
        resp = nm.execute(7, nm.m_ping, {}, nm.Ctx("legacy", "2025-06-18"))
        self.assertEqual(resp, {"jsonrpc": "2.0", "id": 7, "result": {}})


class CliTest(unittest.TestCase):
    def test_help_and_bad_config(self) -> None:
        out = subprocess.run([sys.executable, str(SERVER), "--help"], capture_output=True, text=True)
        self.assertEqual(out.returncode, 0)
        self.assertIn("NODDLE_BASE_URL", out.stdout)
        lt = subprocess.run([sys.executable, str(SERVER), "--list-tools"], capture_output=True, text=True)
        self.assertEqual(lt.returncode, 0)
        self.assertIn("get_board", [t["name"] for t in json.loads(lt.stdout)])
        bad = subprocess.run([sys.executable, str(SERVER)], input="", capture_output=True, text=True,
                             env=dict(os.environ, NODDLE_BASE_URL="ftp://x"))
        self.assertEqual(bad.returncode, 2)
        self.assertEqual(bad.stdout, "")


if __name__ == "__main__":
    unittest.main()
