# noddle draw MCP server

<!-- mcp-name: io.github.noddle-dev/noddle-draw -->

Lets an AI agent (Claude Code, Claude Desktop, or any MCP client) **work on a board
alongside you**: read, create and edit boards, browse version history, and comment like
any other collaborator.

noddle draw is **anonymous**. There are no accounts and no tokens. A board id (12 hex
chars) or a board URL is the capability. The agent can open any board you give it, and
anyone holding the link of a board the agent creates can open it too. The agent signs its
comments and version snapshots with `NODDLE_AGENT_NAME`.

- **Stdlib-only** Python ≥ 3.9 (`urllib` + `json`), so there is nothing to install.
- **stdio transport**: one JSON-RPC 2.0 message per line. stdout carries only protocol
  messages, and logs go to stderr.
- **MCP protocol, dual-era**:
  - **2026-07-28 (modern, stateless)**: every request carries
    `_meta["io.modelcontextprotocol/protocolVersion"]` + `clientCapabilities`. The server
    implements `server/discover`, and sets `resultType` and
    `_meta["io.modelcontextprotocol/serverInfo"]` on every result, plus `ttlMs`/`cacheScope`
    on list/read results. An unsupported version returns `-32022 UnsupportedProtocolVersion`.
  - **Legacy `initialize` handshake**: 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05. The
    server answers with the client's version when it supports it, and otherwise with
    2025-11-25. `ping` works in this mode. JSON-RPC batches are accepted only for
    2025-03-26, the only revision that allowed them.

## 1. Register

**Claude Code** (from the repo root; an absolute script path is more robust):

```bash
claude mcp add noddle -- python3 mcp/noddle_mcp.py
# a self-hosted instance instead of draw.noddle.dev:
claude mcp add noddle --env NODDLE_BASE_URL=http://127.0.0.1:8000 -- python3 mcp/noddle_mcp.py
```

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`)
or a project `.mcp.json` use the same shape:

```json
{
  "mcpServers": {
    "noddle": {
      "command": "python3",
      "args": ["/absolute/path/to/noddle-draw/mcp/noddle_mcp.py"],
      "env": { "NODDLE_BASE_URL": "https://draw.noddle.dev" }
    }
  }
}
```

**From PyPI** (package `noddle-draw-mcp`, console scripts `noddle-draw-mcp` and `noddle-mcp`):

```bash
claude mcp add noddle -- uvx noddle-draw-mcp
# or: pipx install noddle-draw-mcp && noddle-draw-mcp
```

**From a checkout** (`pyproject.toml` here):

```bash
uvx --from ./mcp noddle-draw-mcp       # or: pipx install ./mcp && noddle-draw-mcp
```

The server is also listed in the [official MCP Registry](https://registry.modelcontextprotocol.io)
as `io.github.noddle-dev/noddle-draw` (see [Releasing](#releasing)).

| Env | Default | |
|---|---|---|
| `NODDLE_BASE_URL` | `https://draw.noddle.dev` | http(s) origin of the noddle draw instance. A non-http(s) value exits with code 2 |
| `NODDLE_AGENT_NAME` | `MCP agent` | display name on comments and version history (max 40 chars) |
| `NODDLE_TIMEOUT` | `30` | seconds per board API call |
| `NODDLE_AI_TIMEOUT` | `180` | seconds for `generate_diagram` |
| `NODDLE_AI_PROVIDER` | — | optional BYOK for `generate_diagram`: `claude`, `openai`, `gemini`, `openrouter` or `custom` |
| `NODDLE_AI_KEY` | — | your AI provider key. It is sent only to `NODDLE_BASE_URL`, as the same `X-AI-*` headers the web app uses, and never stored. Unset means the instance's shared pool is used, if it has one |
| `NODDLE_AI_MODEL` | — | optional model override |
| `NODDLE_AI_BASE` | — | OpenAI-compatible base URL (provider `custom` only) |

CLI: `--help`, `--version`, `--list-tools` (prints the tool definitions as JSON).
Exit codes: `0` when stdin closes (normal shutdown), `2` for bad configuration.

## 2. Tools

Every tool returns `structuredContent` that conforms to its `outputSchema`, plus the same
JSON as a text block. Board tools also return a `resource_link` to `noddle://board/{id}`
(revisions ≥ 2025-06-18). Wherever a tool takes `doc_id`, you can pass either the 12-hex
id or the board URL (`{base}/d/{id}` or `/embed/{id}`). A URL on a different origin than
`NODDLE_BASE_URL` is refused.

| Tool | readOnly | destructive | idempotent | openWorld | What it does |
|---|---|---|---|---|---|
| `get_board` | ✓ | | | ✗ | Name, url, `my_role` (`editor`/`viewer`), `updated_at`, page summary and diagram JSON. Optional `page_id` and `include_svg` |
| `create_board` | ✗ | ✗ | ✗ | ✗ | New board, with optional diagram JSON. Anyone with its url can edit it |
| `update_board` | ✗ | ✓ | ✓ | ✗ | Replace the WHOLE diagram (fetch → edit → send back). A version snapshot is kept. `expected_updated_at` turns a concurrent edit into a conflict error instead of an overwrite |
| `rename_board` | ✗ | ✗ | ✓ | ✗ | Rename |
| `list_versions` | ✓ | | | ✗ | Version-history snapshots, newest first |
| `get_version` | ✓ | | | ✗ | One snapshot's diagram. To restore it, pass it to `update_board` |
| `list_comments` | ✓ | | | ✗ | Comment threads |
| `add_comment` | ✗ | ✗ | ✗ | ✗ | Pin to ONE of `node_id` / `edge_id` / `parent_id` (reply) / point `x`,`y` (+ `page_id`). Works on view-only links too |
| `generate_diagram` | ✓ | | | ✓ | Turns prose or Mermaid into diagram JSON through the instance's AI (your BYOK key or its shared pool). It **saves nothing**, so pass the result to `create_board`/`update_board` |

There is deliberately **no `list_boards` and no delete**: the API has neither. Link access
is not discovery, and an anonymous board has no owner who could be trusted to delete it.
Writes to a board whose link is view-only fail with a 403 tool error.

Diagram payloads are **pass-through**. The server checks only the envelope
(`{pages:[{id,nodes,edges}]}` or legacy `{nodes,edges}`, with string ids). Node and edge
fields are forwarded untouched, so new editor fields (e.g. the `freedraw` kind with
`points`, or `curved` routing) work without a server update. See `DiagramNode` /
`DiagramEdge` in `contracts/openapi.yaml`.

Errors:
- **Bad arguments, API failures (400/403/404/413/422/429/503) and conflicts** come back as
  `isError: true` tool results that the model can act on.
- **Protocol errors** use standard JSON-RPC codes: unknown tool or invalid params
  `-32602`, unknown method `-32601`, malformed JSON `-32700`, invalid request `-32600`.

## 3. Resources & prompts

- **Resources**: `resources/list` lists the boards **this session** has created, read or
  edited, as `noddle://board/{id}` (`application/json`, `lastModified`). It starts empty,
  because the API has no listing. `resources/templates/list` exposes
  `noddle://board/{doc_id}`, so a client can read any board by id. `resources/read`
  returns the same JSON as `get_board`. An unknown board returns `-32602`.
- **Prompts**:
  - `design_board(topic, notes?)`: generate → sanity-check → `create_board` → reply with
    the url.
  - `review_board(doc_id)`: embeds the board as a resource and asks for a critique posted
    as anchored comments.

## 4. Example (Claude Code)

```
> Create a board "Payment flow" with Client → API Gateway → Payment Service → Database,
  then comment on the Database node reminding the team to review indexes.

Claude: generate_diagram(text="Client -> API Gateway -> Payment Service -> Database")
        → create_board(name="Payment flow", diagram=…)
        → add_comment(doc_id, body="Please review indexes for the payments table", node_id="db")
        → returns https://draw.noddle.dev/d/{id}
```

Comments reach an open board in realtime. A diagram written with `update_board` shows up
when the board is reloaded.

## 5. Tests

```bash
python3 -m pytest mcp -q        # or: python3 -m unittest discover mcp
```

`test_noddle_mcp.py` runs the real server over stdio against a fake in-process REST
backend. It covers version negotiation (modern and legacy), schema validity, read and
write tools, board-URL ids, view-only links, resources, prompts, BYOK header forwarding
and error paths. It also asserts that stdout carries only JSON-RPC, that no request ever
carries an `Authorization` header, and that a BYOK key never leaks into output or logs.

## Releasing

`mcp/server.json` is the registry listing; it points at the PyPI package `noddle-draw-mcp`.
The registry verifies package ownership by finding the `mcp-name:` marker at the top of this
README in the published PyPI description, so keep that comment.

1. Bump the version in **three** places, all equal: `__version__` in `noddle_mcp.py`,
   `version` in `pyproject.toml`, and both `version` fields in `server.json`. Registry
   versions are immutable; a metadata-only fix uses a suffix such as `1.0.0-1`.
2. Push a tag `mcp-v<version>` (for example `mcp-v1.0.0`). The workflow
   `.github/workflows/mcp-publish.yml` checks the versions match, runs the MCP tests,
   publishes to PyPI through Trusted Publishing, waits until PyPI serves the release, and then
   publishes `server.json` through `mcp-publisher login github-oidc`. Neither step needs a
   stored secret.

One-time setup: on PyPI, add a trusted publisher for project `noddle-draw-mcp` with owner
`noddle-dev`, repository `noddle-draw`, workflow `mcp-publish.yml` and environment `pypi`.

## Notes

- `update_board` keeps the stored SVG preview. The preview refreshes on the next save in
  the editor.
- Cross-origin HTTP redirects are refused, so a BYOK key is never forwarded to another
  host. A BYOK key over plain `http` to a non-loopback host logs a warning.
- `generate_diagram` sends text to an AI provider. Never pass customer PII, credentials or
  account numbers.
