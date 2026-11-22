"""Real-time collaboration — WebSocket rooms per document.

``/ws/documents/{doc_id}``: anyone with the share link joins the board's room
(no auth — matches the app's single-tenant, link-based sharing model). Clients
send full page state plus the read base it was derived from; the server merges
only the fields the sender changed into the board's live diagram, so
concurrent edits to different objects/fields/pages survive. HTTP/MCP saves
publish into the same room. For the same field the last arriving write wins:

  client → server
    {"t": "hello",  "name": str, "color": str, "clientId": str, "pageId"?: str}
                    # clientId (stable per browser) dedups reconnects: a new
                    # hello evicts any prior connection with the same
                    # clientId (close code 4001).
    {"t": "state",  "diagram": {"nodes": [...], "edges": [...]},
                    "baseDiagram"?: {"nodes": [...], "edges": [...]},
                    "pageId"?: str, "removedNodeIds"?: [...],
                    "removedEdgeIds"?: [...]}
                    # edit-gated (ignored from view-only links). With
                    # baseDiagram only the sender's changed fields merge into
                    # the live page; without it (legacy) the frame replaces
                    # the page (full-state LWW). Removals always apply, so
                    # late joiners never resurrect deleted objects.
    {"t": "meta",   "name": str}                     # live board-name sync
    {"t": "cursor", "x": float, "y": float, "pageId"?: str}  # content coords
  server → clients
    {"t": "init",     "diagram": {"nodes", "edges"} | null, "pages": [...],
                      "pageId", "you": int, "may_edit": bool}
                      # diagram = the requested (else first) live page
    {"t": "presence", "users": [{"id", "name", "color", "kind", "icon"?}, ...]}
                      # agents (MCP join_board / agent saves): kind="agent",
                      # icon="claude" when the agent's name says Claude
    {"t": "state",    "diagram": {...}, "baseDiagram", "from": int | null,
                      "pageId", "removedNodeIds", "removedEdgeIds",
                      "actor"?: {"name", "kind"}}  # to others only; from=null
                                                   # ⇒ an HTTP/MCP save
    {"t": "meta",     "name": str}                           # to others only
    {"t": "cursor",   "id", "name", "color", "x", "y", "pageId"}  # to others
    {"t": "bye",      "id": int}
    {"t": "comments", "comments": [...]}  # full-state LWW, pushed by the
                                          # comments REST handlers after every
                                          # mutation (see push_to_room)

Close codes: 4404 unknown/malformed doc id · 4403 legacy private board ·
4001 evicted by a newer connection with the same clientId.

The service keeps the live diagram in memory while the room is open so late
joiners (and HTTP/MCP readers) sync instantly; durable persistence stays
explicit (the Save button / autosave → PUT /api/documents).
This docstring is the wire-protocol spec — keep it in lockstep with
``contracts/openapi.yaml#x-websocket-protocol`` on any change.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import re
from dataclasses import dataclass, field
from itertools import count

import anyio
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.domain.diagram_merge import pages_of
from app.domain.ids import is_valid_id
from app.services.documents import DocumentNotFound, InvalidDiagram

router = APIRouter()

_MAX_MSG_BYTES = 1_200_000  # diagram cap (1MB) + envelope headroom


@dataclass
class Room:
    """One live document room: sockets + user info + last known diagram."""

    sockets: dict[int, WebSocket] = field(default_factory=dict)
    users: dict[int, dict] = field(default_factory=dict)
    state: dict | None = None  # last merged page (diagnostics; init reads live state)
    # Agents shown in presence without a socket (MCP join_board / agent saves),
    # keyed by a negative id; each retires after a TTL of silence.
    agents: dict[int, dict] = field(default_factory=dict)
    agent_tasks: dict[int, asyncio.Task] = field(default_factory=dict)


class RoomManager:
    def __init__(self) -> None:
        self._rooms: dict[str, Room] = {}
        self._ids = count(1)

    def next_id(self) -> int:
        return next(self._ids)

    def room(self, doc_id: str) -> Room:
        return self._rooms.setdefault(doc_id, Room())

    def peek(self, doc_id: str) -> Room | None:
        """The live room for a document, or None — never creates one."""
        return self._rooms.get(doc_id)

    def drop_if_empty(self, doc_id: str) -> None:
        room = self._rooms.get(doc_id)
        if room and not room.sockets:
            del self._rooms[doc_id]

    @staticmethod
    async def send(ws: WebSocket, payload: dict) -> bool:
        """Send a frame; return False if the socket is dead (send failed)."""
        try:
            await ws.send_text(json.dumps(payload, ensure_ascii=False))
            return True
        except Exception:  # peer gone (abrupt disconnect) — caller prunes it
            return False

    async def broadcast(
        self,
        room: Room,
        payload: dict,
        exclude: int | None = None,
    ) -> None:
        dead: list[int] = []
        for cid, ws in list(room.sockets.items()):
            if cid == exclude:
                continue
            if not await self.send(ws, payload):
                dead.append(cid)
        # Reap sockets that died without a clean close (e.g. network drop) so a
        # ghost peer stops showing in presence, then push a corrected presence
        # frame. Recursion is bounded: each reap strictly shrinks the room, so
        # a presence broadcast can re-enter here at most once per dead socket
        # (the old guard suppressed the correction and left the ghost visible
        # until some unrelated frame happened to flush it).
        if dead:
            for cid in dead:
                room.sockets.pop(cid, None)
                room.users.pop(cid, None)
            await self.presence(room)

    async def presence(self, room: Room) -> None:
        # Only publish display fields — client_id is an internal dedup key and
        # must not leak to other peers.
        users = []
        for cid, info in sorted({**room.users, **room.agents}.items()):
            user = {"id": cid, "name": info.get("name"), "color": info.get("color"),
                    "kind": info.get("kind")}
            if info.get("icon"):
                user["icon"] = info["icon"]
            users.append(user)
        await self.broadcast(room, {"t": "presence", "users": users})


manager = RoomManager()


async def push_to_room(doc_id: str, payload: dict) -> None:
    """REST → room bridge: fan a frame out to everyone in a live room (no-op
    when nobody has the board open). Used by mutations that happen over HTTP —
    e.g. comment CRUD — so peers see them without polling."""
    room = manager.peek(doc_id)
    if room:
        await manager.broadcast(room, payload)


AGENT_SAVE_TTL = 30.0   # an agent stays in presence this long after a save
AGENT_JOIN_TTL = 300.0  # …and this long after an explicit MCP join_board
_CLAUDE_RE = re.compile(r"\bclaude\b", re.IGNORECASE)
_AGENT_COLORS = ("#7c3aed", "#0891b2", "#c2410c", "#15803d", "#be185d", "#4338ca")


def agent_presence(name: str) -> dict:
    """Presence entry for an agent. ``icon`` lets the web client draw a
    recognisable mark (the Claude logo) instead of initials — derived from the
    agent's display name, never chosen by the caller directly."""
    digest = hashlib.sha256(name.encode()).digest()
    info = {"name": name, "color": _AGENT_COLORS[digest[0] % len(_AGENT_COLORS)], "kind": "agent"}
    if _CLAUDE_RE.search(name):
        info["icon"] = "claude"
    return info


def _agent_id(name: str, client_id: str | None) -> int:
    """Stable negative id (never collides with socket ids, which count up)."""
    key = f"{client_id or ''}|{name}".encode()
    return -int(hashlib.sha256(key).hexdigest()[:8], 16) - 1


async def _show_agent(room: Room, name: str, client_id: str | None, ttl: float) -> None:
    """Put an agent in the room's presence and retire it after ``ttl`` seconds
    of silence (each save/join restarts the clock)."""
    aid = _agent_id(name, client_id)
    room.agents[aid] = agent_presence(name)
    previous = room.agent_tasks.pop(aid, None)
    if previous:
        previous.cancel()

    async def retire() -> None:
        try:
            await asyncio.sleep(ttl)
            room.agents.pop(aid, None)
            room.agent_tasks.pop(aid, None)
            await manager.presence(room)
        except asyncio.CancelledError:
            pass

    room.agent_tasks[aid] = asyncio.create_task(retire())
    await manager.presence(room)


async def announce_agent(doc_id: str, name: str, client_id: str | None = None) -> bool:
    """MCP ``join_board``: show the agent to everyone who has the board open,
    without editing anything. Returns False when nobody is in the room."""
    room = manager.peek(doc_id)
    if room is None:
        return False
    await _show_agent(room, name, client_id, AGENT_JOIN_TTL)
    return True


async def publish_document_save(
    doc_id: str, before: dict | None, after: dict | None, author: str = "", agent: bool = False
) -> None:
    """HTTP and MCP saves are first-class live writers, not a parallel stale
    store: push every changed page (with its base) into the open room."""
    room = manager.peek(doc_id)
    if room is None:
        return
    if agent and author:
        await _show_agent(room, author, None, AGENT_SAVE_TTL)
    old = {p["id"]: p for p in pages_of(before)}
    for page in pages_of(after):
        base = old.get(page["id"], {"nodes": [], "edges": []})
        if base == page:
            continue
        node_ids = {v["id"] for v in page.get("nodes", [])}
        edge_ids = {v["id"] for v in page.get("edges", [])}
        await manager.broadcast(room, {
            "t": "state", "pageId": page["id"], "diagram": page, "baseDiagram": base,
            "from": None, "actor": {"name": author, "kind": "agent" if agent else "guest"},
            "removedNodeIds": [n["id"] for n in base.get("nodes", []) if n["id"] not in node_ids],
            "removedEdgeIds": [e["id"] for e in base.get("edges", []) if e["id"] not in edge_ids],
        })


def _clean_str(v: object, fallback: str, cap: int = 40) -> str:
    s = str(v) if isinstance(v, str) else fallback
    return (s.strip() or fallback)[:cap]


@router.websocket("/ws/documents/{doc_id}")
async def collab_ws(websocket: WebSocket, doc_id: str) -> None:
    if not is_valid_id(doc_id):
        await websocket.close(code=4404)
        return

    # ---- resolve the ACL for this room -------------------------------------
    # Anonymous-only: the board URL is the capability. Viewers may watch;
    # only editors (link_policy "edit") may send state.
    try:
        doc = websocket.app.state.document_service.get(doc_id)
    except Exception:
        await websocket.close(code=4404)
        return
    from app.services.auth import can  # local import avoids a cycle at boot

    if not can("view", doc.meta):
        await websocket.close(code=4403)
        return
    may_edit = can("edit", doc.meta)

    await websocket.accept()

    service = websocket.app.state.document_service
    room = manager.room(doc_id)
    cid = manager.next_id()
    room.sockets[cid] = websocket
    try:
        await anyio.to_thread.run_sync(service.begin_live, doc_id)
    except DocumentNotFound:
        pass  # removed between the ACL check and here — reads below degrade

    try:
        while True:
            raw = await websocket.receive_text()
            if len(raw) > _MAX_MSG_BYTES:
                continue  # oversized frame — drop silently
            try:
                msg = json.loads(raw)
            except ValueError:
                continue
            if not isinstance(msg, dict):
                continue
            t = msg.get("t")

            if t == "hello":
                # Everyone is a guest — the client-chosen display name/color
                # (localStorage identity) is the presence identity.
                client_id = _clean_str(msg.get("clientId"), "", 64) or None
                # One browser = one presence entry. A reconnect (network blip,
                # rename → disconnect+connect) opens a NEW socket while the old
                # one may still linger; evict any prior connection carrying the
                # same stable clientId so it can't show as a duplicate "you".
                if client_id:
                    stale = [
                        other
                        for other, info in room.users.items()
                        if other != cid and info.get("client_id") == client_id
                    ]
                    for other in stale:
                        old = room.sockets.pop(other, None)
                        room.users.pop(other, None)
                        if old is not None:
                            try:
                                await old.close(code=4001)
                            except Exception:
                                pass
                        await manager.broadcast(room, {"t": "bye", "id": other})
                room.users[cid] = {
                    "name": _clean_str(msg.get("name"), f"Guest {cid}"),
                    "color": _clean_str(msg.get("color"), "#2563eb", 16),
                    "kind": "guest",
                    "client_id": client_id,
                }
                try:
                    current = await anyio.to_thread.run_sync(service.get_live, doc_id)
                    pages = pages_of(current.diagram)
                except DocumentNotFound:
                    pages = []
                want = msg.get("pageId")
                page = next((p for p in pages if p["id"] == want), pages[0] if pages else None)
                await manager.send(
                    websocket,
                    {
                        "t": "init",
                        "diagram": (
                            {"nodes": page.get("nodes", []), "edges": page.get("edges", [])}
                            if page else None
                        ),
                        "pages": pages,
                        "pageId": page["id"] if page else None,
                        "you": cid,
                        "may_edit": may_edit,
                    },
                )
                await manager.presence(room)

            elif t == "state":
                if not may_edit:
                    continue  # viewers watch — they never write
                diagram = msg.get("diagram")
                if (
                    isinstance(diagram, dict)
                    and isinstance(diagram.get("nodes"), list)
                    and isinstance(diagram.get("edges"), list)
                ):
                    page_id = msg.get("pageId")
                    if page_id is not None and (not isinstance(page_id, str) or len(page_id) > 128):
                        continue
                    rm_n = [v for v in (msg.get("removedNodeIds") or []) if isinstance(v, str)]
                    rm_e = [v for v in (msg.get("removedEdgeIds") or []) if isinstance(v, str)]
                    base = msg.get("baseDiagram")
                    if not (
                        isinstance(base, dict)
                        and isinstance(base.get("nodes"), list)
                        and isinstance(base.get("edges"), list)
                    ):
                        base = None
                    try:
                        page = await anyio.to_thread.run_sync(
                            service.apply_live_page,
                            doc_id, page_id, diagram, base, rm_n, rm_e,
                        )
                    except (ValueError, KeyError, TypeError, InvalidDiagram, DocumentNotFound):
                        continue
                    room.state = page
                    await manager.broadcast(
                        room,
                        {
                            "t": "state",
                            "diagram": diagram,
                            "baseDiagram": base,
                            "from": cid,
                            "pageId": page["id"],
                            "removedNodeIds": rm_n,
                            "removedEdgeIds": rm_e,
                        },
                        exclude=cid,
                    )

            elif t == "meta":
                # Live board-name sync — relay verbatim to the rest of the room.
                name = msg.get("name")
                if isinstance(name, str) and may_edit:
                    await manager.broadcast(
                        room, {"t": "meta", "name": name[:120]}, exclude=cid
                    )

            elif t == "cursor":
                x, y = msg.get("x"), msg.get("y")
                if isinstance(x, (int, float)) and isinstance(y, (int, float)):
                    info = room.users.get(cid, {})
                    # Cursors are PAGE-scoped like state frames: relay the
                    # sender's page id so viewers of another page don't see a
                    # ghost cursor floating over unrelated shapes. None ⇒
                    # legacy client (shown everywhere, as before).
                    page_id = msg.get("pageId")
                    await manager.broadcast(
                        room,
                        {
                            "t": "cursor",
                            "id": cid,
                            "name": info.get("name", f"Guest {cid}"),
                            "color": info.get("color", "#2563eb"),
                            "x": x,
                            "y": y,
                            "pageId": page_id if isinstance(page_id, str) else None,
                        },
                        exclude=cid,
                    )
    except WebSocketDisconnect:
        pass
    finally:
        room.sockets.pop(cid, None)
        room.users.pop(cid, None)
        await manager.broadcast(room, {"t": "bye", "id": cid})
        await manager.presence(room)
        if not room.sockets:
            for task in room.agent_tasks.values():
                task.cancel()
            # Last editor gone: unsaved live state is dropped (clients autosave
            # explicitly); every successful save is already durable.
            await anyio.to_thread.run_sync(service.end_live, doc_id)
        manager.drop_if_empty(doc_id)
