"""Real-time collaboration — WebSocket rooms per document.

``/ws/documents/{doc_id}``: anyone with the share link joins the board's room
(no auth — matches the app's single-tenant, link-based sharing model). The
protocol is deliberately simple, full-state last-write-wins:

  client → server
    {"t": "hello",  "name": str, "color": str}
    {"t": "state",  "diagram": {"nodes": [...], "edges": [...]}}
    {"t": "cursor", "x": float, "y": float}          # content coords
  server → clients
    {"t": "init",     "diagram": {...} | null, "you": int}
    {"t": "presence", "users": [{"id", "name", "color"}, ...]}
    {"t": "state",    "diagram": {...}, "from": int}   # to others only
    {"t": "cursor",   "id", "name", "color", "x", "y"} # to others only
    {"t": "bye",      "id": int}
    {"t": "comments", "comments": [...]}  # full-state LWW, pushed by the
                                          # comments REST handlers after every
                                          # mutation (see push_to_room)

The room keeps the latest diagram in memory so late joiners sync instantly;
durable persistence stays explicit (the Save button → PUT /api/documents).
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from itertools import count

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.domain.ids import is_valid_id

router = APIRouter()

_MAX_MSG_BYTES = 1_200_000  # diagram cap (1MB) + envelope headroom


@dataclass
class Room:
    """One live document room: sockets + user info + last known diagram."""

    sockets: dict[int, WebSocket] = field(default_factory=dict)
    users: dict[int, dict] = field(default_factory=dict)
    state: dict | None = None


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
        _is_presence: bool = False,
    ) -> None:
        dead: list[int] = []
        for cid, ws in list(room.sockets.items()):
            if cid == exclude:
                continue
            if not await self.send(ws, payload):
                dead.append(cid)
        # Reap sockets that died without a clean close (e.g. network drop) so a
        # ghost peer stops showing in presence. Refresh presence once after a
        # reap — guarded so the presence frame itself never re-triggers this.
        if dead:
            for cid in dead:
                room.sockets.pop(cid, None)
                room.users.pop(cid, None)
            if not _is_presence:
                await self.presence(room)

    async def presence(self, room: Room) -> None:
        users = [
            {"id": cid, **info} for cid, info in sorted(room.users.items())
        ]
        await self.broadcast(room, {"t": "presence", "users": users}, _is_presence=True)


manager = RoomManager()


async def push_to_room(doc_id: str, payload: dict) -> None:
    """REST → room bridge: fan a frame out to everyone in a live room (no-op
    when nobody has the board open). Used by mutations that happen over HTTP —
    e.g. comment CRUD — so peers see them without polling."""
    room = manager.peek(doc_id)
    if room:
        await manager.broadcast(room, payload)


def _clean_str(v: object, fallback: str, cap: int = 40) -> str:
    s = str(v) if isinstance(v, str) else fallback
    return (s.strip() or fallback)[:cap]


@router.websocket("/ws/documents/{doc_id}")
async def collab_ws(websocket: WebSocket, doc_id: str) -> None:
    if not is_valid_id(doc_id):
        await websocket.close(code=4404)
        return

    # ---- resolve the ACL for this room (ADR-0002) --------------------------
    # Identity: session cookie (humans) or ?token= (agents — headers are hard
    # to set on browser WebSockets, so agents pass the bearer as a query param
    # over the same origin). Viewers may watch; only editors may send state.
    auth = websocket.app.state.auth_service
    principal = auth.principal_from_bearer(websocket.query_params.get("token"))
    if not principal.is_authenticated:
        principal = auth.principal_from_session(
            websocket.cookies.get("noddle_session")
        )
    try:
        doc = websocket.app.state.document_service.get(doc_id)
    except Exception:
        await websocket.close(code=4404)
        return
    from app.services.auth import can  # local import avoids a cycle at boot

    if not can(principal, "view", doc.meta, auth):
        await websocket.close(code=4403)
        return
    may_edit = can(principal, "edit", doc.meta, auth)

    await websocket.accept()

    room = manager.room(doc_id)
    cid = manager.next_id()
    room.sockets[cid] = websocket

    try:
        while True:
            raw = await websocket.receive_text()
            if len(raw) > _MAX_MSG_BYTES:
                continue  # oversized frame — drop silently
            try:
                msg = json.loads(raw)
            except ValueError:
                continue
            t = msg.get("t")

            if t == "hello":
                # Authenticated identities are SERVER-ASSIGNED (a client can't
                # spoof a teammate); guests may pick their display name.
                if principal.is_authenticated:
                    room.users[cid] = {
                        "name": principal.name,
                        "color": principal.color,
                        "kind": principal.kind,  # agents render distinctly
                    }
                else:
                    room.users[cid] = {
                        "name": _clean_str(msg.get("name"), f"Guest {cid}"),
                        "color": _clean_str(msg.get("color"), "#2563eb", 16),
                        "kind": "guest",
                    }
                await manager.send(
                    websocket,
                    {
                        "t": "init",
                        "diagram": room.state,
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
                    room.state = {
                        "nodes": diagram["nodes"],
                        "edges": diagram["edges"],
                    }
                    # Apply removals to the authoritative room state too so late
                    # joiners don't resurrect deleted objects.
                    rm_n = set(msg.get("removedNodeIds") or [])
                    rm_e = set(msg.get("removedEdgeIds") or [])
                    if rm_n:
                        room.state["nodes"] = [
                            n for n in room.state["nodes"] if n.get("id") not in rm_n
                        ]
                    if rm_e:
                        room.state["edges"] = [
                            e for e in room.state["edges"] if e.get("id") not in rm_e
                        ]
                    await manager.broadcast(
                        room,
                        {
                            "t": "state",
                            "diagram": room.state,
                            "from": cid,
                            "pageId": msg.get("pageId"),
                            "removedNodeIds": list(rm_n),
                            "removedEdgeIds": list(rm_e),
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
        manager.drop_if_empty(doc_id)
