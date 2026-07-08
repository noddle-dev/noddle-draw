"""Team engagement — real-time multiplayer games over WebSocket.

First game: **Draw & Guess** (skribbl.io / Pictionary style) — it reuses the
app's core strength (live drawing) and its WebSocket/presence model. One player
draws a secret word; everyone else races to guess in chat; the FIRST correct
guess wins the turn (pause → congrats → countdown → next drawer).

``/ws/games/{room_id}`` — a lobby per room id (share the /play/{id} link). The
SERVER is authoritative: it owns the word, timer, scores and who won, and never
sends the secret word to guessers. A short chat backlog is replayed to late
joiners. An optional AI-Noddle commentator drops the odd hype line (never
knowing the word) and a fun recap when the word is revealed — best-effort, the
game runs fine without it.

  client → server
    {"t":"hello","name","color"}
    {"t":"start","secs":int,"rounds":int}          # lobby → play (≥2 players)
    {"t":"stroke","stroke":{...}} / {"t":"clear"}   # drawer only; relayed
    {"t":"guess","text"}
  server → clients
    {"t":"chatlog","lines":[...]}                   # backlog, on join
    {"t":"state", players, phase, turn, totalTurns, drawerId, timeLeft,
                  hint, wordLen, you}
    {"t":"word","word"}                             # to the DRAWER only
    {"t":"stroke",...} / {"t":"clear"}
    {"t":"chat","kind":"guess"|"system"|"correct"|"ai","name","color","text"}
    {"t":"turnEnd","word","winner"}
    {"t":"gameOver","scores":[...]}
"""
from __future__ import annotations

import asyncio
import json
import os
import random
import secrets
from dataclasses import dataclass, field

from fastapi import APIRouter, Header, HTTPException, Request, WebSocket, WebSocketDisconnect

from app.api.auth import get_principal
from app.domain.ids import is_valid_id

router = APIRouter()


# ---- room host tracking (shared by all three game managers) -----------------
# A room's HOST is whoever created it (the first player to join). The host can
# force-close the room; a normal player cannot. Identity is tracked two ways so
# both guests and signed-in users are covered:
#   * ``host_secret`` — a one-time capability token handed privately to the
#     creator's socket (works for anonymous party guests, who have no account).
#   * ``host_user_id`` — the creator's account id when they were signed in, so
#     they keep control across reconnects / other devices / other sessions.
# The generic kill endpoint accepts EITHER, plus the ops admin key as override.


def assign_host(room: object, principal: object) -> str | None:
    """On the first join, make this player the room HOST and return a one-time
    host token to hand them privately. On a later join, re-hand the token to the
    same signed-in host (reconnect); everyone else gets ``None`` (no control)."""
    if not getattr(room, "host_secret", ""):
        room.host_secret = secrets.token_urlsafe(18)  # type: ignore[attr-defined]
        room.host_user_id = (  # type: ignore[attr-defined]
            principal.user_id if getattr(principal, "is_authenticated", False) else None
        )
        return room.host_secret  # type: ignore[attr-defined]
    huid = getattr(room, "host_user_id", None)
    if huid and getattr(principal, "user_id", None) == huid:
        return room.host_secret  # type: ignore[attr-defined]
    return None

_REACT_EMOJI = ["👍", "😂", "🎉", "🔥", "❤️", "😮"]


# ---- persistent cross-game leaderboard --------------------------------------
# ``_lb_store`` (a PgLeaderboard) is the production DB backend, bound at boot in
# create_app and lazily from app.state as a fallback; the JSON file under
# ``_lb_path`` is the local-dev fallback only (2026-07-06 "no local files" rule).
_lb_path: str | None = None
_lb_store: object | None = None


def _bind_lb(app) -> None:  # type: ignore[no-untyped-def]
    """Lazily bind the DB store + file path from an app's state (idempotent)."""
    global _lb_path, _lb_store
    if _lb_store is None:
        _lb_store = getattr(app.state, "games_leaderboard", None)
    if _lb_path is None:
        _lb_path = str(getattr(app.state, "settings", None) and app.state.settings.storage_dir or "")


def _lb_file() -> str | None:
    return os.path.join(_lb_path, "games_leaderboard.json") if _lb_path else None


def _read_board() -> dict:
    f = _lb_file()
    if not f or not os.path.exists(f):
        return {}
    try:
        with open(f, encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _record_game(results: list[dict]) -> None:
    """Fold one finished game into the persistent board (keyed by player name)."""
    if not results:
        return
    if _lb_store is not None:
        try:
            _lb_store.record(results)
        except Exception:  # noqa: BLE001 — leaderboard is best-effort
            pass
        return
    f = _lb_file()
    if not f:
        return
    board = _read_board()
    top = max((r["score"] for r in results), default=0)
    for r in results:
        key = r["name"]
        row = board.get(key) or {"name": key, "color": r["color"], "points": 0, "wins": 0, "games": 0}
        row["color"] = r["color"]
        row["points"] += r["score"]
        row["games"] += 1
        if r["score"] == top and top > 0:
            row["wins"] += 1
        board[key] = row
    try:
        with open(f, "w", encoding="utf-8") as fh:
            json.dump(board, fh, ensure_ascii=False)
    except Exception:
        pass


@router.get("/api/games/leaderboard")
def leaderboard(request: Request) -> list[dict]:
    _bind_lb(request.app)
    if _lb_store is not None:
        try:
            rows = _lb_store.read_all()
        except Exception:  # noqa: BLE001
            rows = []
    else:
        rows = list(_read_board().values())
    rows.sort(key=lambda r: (-r.get("wins", 0), -r.get("points", 0)))
    return rows[:20]


@router.get("/api/games/active")
def active_games(request: Request) -> dict:
    """Live snapshot of ALL in-memory game rooms across the three games (for the
    'Playing now' panel). Each game keeps its own manager; we aggregate them here.
    Lazy imports avoid any module-load cycle."""
    from app.api.game_trivia import manager as trivia_mgr
    from app.api.game_wordbomb import manager as wordbomb_mgr

    def turn_of(room: object) -> tuple[int, int]:
        # Draw&Guess uses turn/total_turns; Trivia uses q_index/total_q.
        return (
            getattr(room, "turn", 0) or (getattr(room, "q_index", 0) + 1 if getattr(room, "phase", "") not in ("lobby", "over") else 0),
            getattr(room, "total_turns", 0) or getattr(room, "total_q", 0),
        )

    sources = [
        ("draw", "Draw & Guess", "✏️", manager),
        ("trivia", "Team Trivia", "🧠", trivia_mgr),
        ("wordbomb", "Word Bomb", "💣", wordbomb_mgr),
    ]
    rooms = []
    total_users = 0
    for gtype, label, emoji, mgr in sources:
        for rid, room in mgr._rooms.items():
            n = len(room.players)
            if n == 0:
                continue
            total_users += n
            turn, total = turn_of(room)
            rooms.append({
                "id": rid,
                "type": gtype,
                "game": label,
                "emoji": emoji,
                "players": n,
                "phase": getattr(room, "phase", "lobby"),
                "turn": turn,
                "totalTurns": total,
            })
    rooms.sort(key=lambda r: -r["players"])
    return {"rooms": rooms, "totalUsers": total_users, "totalRooms": len(rooms)}


def _admin_ok(request: Request, key: str | None) -> bool:
    """True when a valid ops admin key was presented (non-raising)."""
    expected = getattr(request.app.state.settings, "admin_key", "")
    return bool(expected) and secrets.compare_digest(key or "", expected)


def _requester_is_host(
    room: object, principal: object, host_token: str | None, admin_ok: bool
) -> bool:
    """May this requester close ``room``? Ops admin, the holder of the room's
    host token, or the signed-in account that created it — nobody else."""
    if admin_ok:
        return True
    secret = getattr(room, "host_secret", "")
    if host_token and secret and secrets.compare_digest(host_token, secret):
        return True
    huid = getattr(room, "host_user_id", None)
    puid = getattr(principal, "user_id", None)
    return bool(huid and puid and huid == puid)


async def _generic_kill(mgr: object, room_id: str, reason: str) -> int:
    """Force-close a room in ANY game manager: cancel its loop, notify + drop
    every socket. Works across Draw&Guess / Trivia / Word Bomb managers since
    they share the same room shape (players dict of objects with a .ws)."""
    room = getattr(mgr, "_rooms", {}).get(room_id)
    if not room:
        return 0
    task = getattr(room, "loop_task", None)
    if task and not task.done():
        task.cancel()
    n = len(room.players)
    for p in list(room.players.values()):
        try:
            await p.ws.send_text(json.dumps({"t": "killed", "reason": reason}))
        except Exception:
            pass
        try:
            await p.ws.close(code=4001)
        except Exception:
            pass
    room.players.clear()
    if hasattr(room, "order"):
        room.order.clear()
    mgr._rooms.pop(room_id, None)
    return n


def _all_managers(request: Request) -> list:
    from app.api.game_trivia import manager as trivia_mgr
    from app.api.game_wordbomb import manager as wordbomb_mgr

    return [manager, trivia_mgr, wordbomb_mgr]


@router.post("/api/games/rooms/{room_id}/kill")
async def kill_room(
    room_id: str,
    request: Request,
    x_admin_key: str | None = Header(default=None),
    x_host_token: str | None = Header(default=None),
) -> dict:
    """Close a game room. Allowed for the room HOST (via the host token handed
    to the creator, or their signed-in account) — a normal player gets 403. The
    ops admin key is honored as an override."""
    principal = get_principal(request)
    admin_ok = _admin_ok(request, x_admin_key)
    total = 0
    found = False
    for mgr in _all_managers(request):
        room = getattr(mgr, "_rooms", {}).get(room_id)
        if not room:
            continue
        found = True
        if not _requester_is_host(room, principal, x_host_token, admin_ok):
            raise HTTPException(
                status_code=403, detail="Only the room host can close this room."
            )
        total += await _generic_kill(mgr, room_id, "The host closed this room.")
    if not found:
        return {"ok": True, "closed": 0}  # already gone — treat as success
    return {"ok": True, "closed": total}


@router.post("/api/games/rooms/kill-all")
async def kill_all_rooms(
    request: Request, x_admin_key: str | None = Header(default=None)
) -> dict:
    """Ops-only sweep of every live room (admin key required — never host)."""
    if not _admin_ok(request, x_admin_key):
        raise HTTPException(status_code=403, detail="Sai admin key.")
    total = 0
    for mgr in _all_managers(request):
        for rid in list(getattr(mgr, "_rooms", {}).keys()):
            total += await _generic_kill(mgr, rid, "This room was closed by an admin.")
    return {"ok": True, "closed": total}

_MAX_MSG_BYTES = 200_000
_REVEAL_SECONDS = 6
_MIN_PLAYERS = 2
_MAX_NAME = 32
_CHATLOG_CAP = 80
_AI_EVERY = 10  # seconds between AI hype lines during a turn

_WORDS = [
    "database", "server", "laptop", "coffee", "meeting", "deadline", "rocket",
    "keyboard", "firewall", "cloud", "pipeline", "dashboard", "backlog",
    "sprint", "standup", "diagram", "flowchart", "network", "browser",
    "elephant", "guitar", "pizza", "mountain", "rainbow", "umbrella", "robot",
    "banana", "bicycle", "camera", "island", "castle", "dragon", "penguin",
    "spaceship", "volcano", "lighthouse", "waterfall", "sandwich", "telescope",
    "kangaroo", "snowman", "butterfly", "octopus", "helicopter", "treasure",
]


@dataclass
class Player:
    ws: WebSocket
    name: str
    color: str
    score: int = 0
    guessed: bool = False


@dataclass
class GameRoom:
    players: dict[int, Player] = field(default_factory=dict)
    order: list[int] = field(default_factory=list)
    phase: str = "lobby"  # lobby | draw | reveal | over
    turn: int = 0
    total_turns: int = 0
    drawer_id: int | None = None
    word: str = ""
    winner: str = ""
    time_left: int = 0
    draw_secs: int = 60
    rounds: int = 1
    chat_log: list[dict] = field(default_factory=list)
    chat_seq: int = 0
    loop_task: asyncio.Task | None = None
    turn_over: asyncio.Event = field(default_factory=asyncio.Event)
    ai: object | None = None
    ai_busy: bool = False
    host_secret: str = ""  # capability token handed to the room creator
    host_user_id: str | None = None  # creator's account id (if signed in)


class GameManager:
    def __init__(self) -> None:
        self._rooms: dict[str, GameRoom] = {}
        self._next = 0

    def next_id(self) -> int:
        self._next += 1
        return self._next

    def room(self, room_id: str) -> GameRoom:
        return self._rooms.setdefault(room_id, GameRoom())

    def drop_if_empty(self, room_id: str) -> None:
        r = self._rooms.get(room_id)
        if r and not r.players:
            if r.loop_task and not r.loop_task.done():
                r.loop_task.cancel()
            del self._rooms[room_id]

    async def kill_room(self, room_id: str) -> int:
        """Admin force-close: notify + disconnect every socket, cancel the turn
        loop, and drop the room. Returns how many players were disconnected."""
        room = self._rooms.get(room_id)
        if not room:
            return 0
        if room.loop_task and not room.loop_task.done():
            room.loop_task.cancel()
        sockets = [p.ws for p in room.players.values()]
        n = len(sockets)
        for ws in sockets:
            try:
                await ws.send_text(json.dumps({"t": "killed", "reason": "This room was closed by an admin."}))
            except Exception:
                pass
            try:
                await ws.close(code=4001)
            except Exception:
                pass
        room.players.clear()
        room.order.clear()
        self._rooms.pop(room_id, None)
        return n

    async def send(self, ws: WebSocket, payload: dict) -> bool:
        try:
            await ws.send_text(json.dumps(payload, ensure_ascii=False))
            return True
        except Exception:
            return False

    async def broadcast(self, room: GameRoom, payload: dict, exclude: int | None = None) -> None:
        dead: list[int] = []
        for pid, p in list(room.players.items()):
            if pid == exclude:
                continue
            if not await self.send(p.ws, payload):
                dead.append(pid)
        for pid in dead:
            room.players.pop(pid, None)

    async def chat(self, room: GameRoom, kind: str, name: str, color: str, text: str) -> None:
        """Append to the room backlog (replayed to late joiners) + broadcast.
        Each line gets a stable id so clients can attach emoji reactions."""
        room.chat_seq += 1
        line = {"id": room.chat_seq, "kind": kind, "name": name, "color": color, "text": text, "reactions": {}}
        room.chat_log.append(line)
        if len(room.chat_log) > _CHATLOG_CAP:
            room.chat_log = room.chat_log[-_CHATLOG_CAP:]
        await self.broadcast(room, {"t": "chat", **line})

    async def react(self, room: GameRoom, line_id: int, emoji: str, who: str) -> None:
        """Toggle `who`'s emoji reaction on a chat line, then broadcast the set."""
        if emoji not in _REACT_EMOJI:
            return
        for line in room.chat_log:
            if line.get("id") == line_id:
                reacts: dict = line.setdefault("reactions", {})
                names = reacts.setdefault(emoji, [])
                if who in names:
                    names.remove(who)
                    if not names:
                        reacts.pop(emoji, None)
                else:
                    names.append(who)
                await self.broadcast(room, {"t": "react", "id": line_id, "reactions": line["reactions"]})
                return

    def _hint(self, room: GameRoom) -> str:
        return "".join(" " if c == " " else ("-" if c == "-" else "_") for c in room.word)

    def state_payload(self, room: GameRoom) -> dict:
        return {
            "t": "state",
            "phase": room.phase,
            "turn": room.turn,
            "totalTurns": room.total_turns,
            "drawerId": room.drawer_id,
            "timeLeft": room.time_left,
            "winner": room.winner,
            "hint": self._hint(room) if room.phase in ("draw", "reveal") else "",
            "wordLen": len(room.word) if room.phase in ("draw", "reveal") else 0,
            "players": [
                {"id": pid, "name": p.name, "color": p.color, "score": p.score, "guessed": p.guessed}
                for pid, p in sorted(room.players.items(), key=lambda kv: -kv[1].score)
            ],
        }

    async def push_state(self, room: GameRoom) -> None:
        await self.broadcast(room, self.state_payload(room))

    def _ai_say(self, room: GameRoom, system: str, user: str) -> None:
        """Fire-and-forget AI commentary (best-effort; ignores all failures)."""
        if room.ai is None or room.ai_busy:
            return

        async def run() -> None:
            room.ai_busy = True
            try:
                loop = asyncio.get_event_loop()
                text = await asyncio.wait_for(
                    loop.run_in_executor(None, room.ai.commentate, system, user), timeout=9.0
                )
                text = (text or "").strip()
                if text and room.players:
                    await self.chat(room, "ai", "✦ AI-Noddle", "#7c3aed", text[:200])
            except Exception:
                pass
            finally:
                room.ai_busy = False

        asyncio.create_task(run())

    async def run_game(self, room: GameRoom) -> None:
        try:
            ids = [pid for pid in room.order if pid in room.players]
            room.total_turns = min(12, max(_MIN_PLAYERS, len(ids) * max(1, room.rounds)))
            for t in range(room.total_turns):
                present = [pid for pid in room.order if pid in room.players]
                if len(present) < _MIN_PLAYERS:
                    break
                drawer = present[t % len(present)]
                room.turn = t + 1
                room.phase = "draw"
                room.drawer_id = drawer
                room.word = random.choice(_WORDS)
                room.winner = ""
                room.time_left = room.draw_secs
                for p in room.players.values():
                    p.guessed = False
                room.turn_over.clear()

                dp = room.players.get(drawer)
                if dp:
                    await self.send(dp.ws, {"t": "word", "word": room.word})
                await self.broadcast(room, {"t": "clear"})
                await self.chat(room, "system", "", "", f"Turn {room.turn}/{room.total_turns} — {dp.name if dp else '?'} is drawing!")
                await self.push_state(room)

                # Draw countdown: tick each second, end early on first correct guess.
                while room.time_left > 0:
                    try:
                        await asyncio.wait_for(room.turn_over.wait(), timeout=1.0)
                        break
                    except asyncio.TimeoutError:
                        room.time_left -= 1
                        await self.push_state(room)
                        if room.time_left > 5 and room.time_left % _AI_EVERY == 0:
                            self._ai_say(
                                room,
                                "You are the upbeat host of a draw-and-guess game. Cheer the players on in ONE "
                                "SHORT English sentence. You do NOT know the secret word, so never guess it or "
                                "reveal it. Max 15 words.",
                                f"There are {len(room.players)} players, {room.time_left}s left, and nobody has "
                                "guessed yet. Cheer them on!",
                            )

                # Reveal + congrats + countdown to next turn.
                room.phase = "reveal"
                await self.broadcast(room, {"t": "turnEnd", "word": room.word, "winner": room.winner})
                self._ai_say(
                    room,
                    "You are the host of a draw-and-guess game, giving one fun English sentence of commentary.",
                    f"The secret word was '{room.word}'. "
                    + (f"{room.winner} guessed it first." if room.winner else "Nobody guessed it.")
                    + " Give a fun comment, max 20 words.",
                )
                room.time_left = _REVEAL_SECONDS
                await self.push_state(room)
                while room.time_left > 0:
                    await asyncio.sleep(1.0)
                    room.time_left -= 1
                    await self.push_state(room)

            room.phase = "over"
            room.drawer_id = None
            scores = [
                {"id": pid, "name": p.name, "color": p.color, "score": p.score}
                for pid, p in sorted(room.players.items(), key=lambda kv: -kv[1].score)
            ]
            _record_game(scores)  # fold into the persistent cross-game leaderboard
            await self.broadcast(room, {"t": "gameOver", "scores": scores})
            await self.push_state(room)
        except asyncio.CancelledError:
            pass


manager = GameManager()


def _clean(v: object, fallback: str, cap: int = _MAX_NAME) -> str:
    s = v if isinstance(v, str) else fallback
    return (s.strip() or fallback)[:cap]


def _clamp(v: object, lo: int, hi: int, default: int) -> int:
    try:
        return max(lo, min(hi, int(v)))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default


@router.websocket("/ws/games/{room_id}")
async def game_ws(websocket: WebSocket, room_id: str) -> None:
    if not is_valid_id(room_id):
        await websocket.close(code=4404)
        return
    await websocket.accept()
    room = manager.room(room_id)
    if room.ai is None:
        room.ai = getattr(websocket.app.state, "ai_service", None)
    _bind_lb(websocket.app)
    pid = manager.next_id()

    # Resolve the acting identity (same mechanism as the collab room): bearer
    # token (agents) → session cookie (signed-in humans) → guest. Used only to
    # bind an authenticated host to their account for the "Close room" control.
    auth = websocket.app.state.auth_service
    principal = auth.principal_from_bearer(websocket.query_params.get("token"))
    if not principal.is_authenticated:
        principal = auth.principal_from_session(websocket.cookies.get("noddle_session"))

    try:
        while True:
            raw = await websocket.receive_text()
            if len(raw) > _MAX_MSG_BYTES:
                continue
            try:
                msg = json.loads(raw)
            except ValueError:
                continue
            t = msg.get("t")

            if t == "hello":
                room.players[pid] = Player(
                    ws=websocket,
                    name=_clean(msg.get("name"), f"Player {pid}"),
                    color=_clean(msg.get("color"), "#2563eb", 16),
                )
                if pid not in room.order:
                    room.order.append(pid)
                # First joiner becomes the host — hand them the close-room token.
                host_token = assign_host(room, principal)
                if host_token:
                    await manager.send(websocket, {"t": "host", "token": host_token})
                # Replay the chat backlog so late/ad-hoc joiners see history.
                await manager.send(websocket, {"t": "chatlog", "lines": room.chat_log})
                await manager.send(websocket, {**manager.state_payload(room), "you": pid})
                await manager.push_state(room)
                await manager.chat(room, "system", "", "", f"{room.players[pid].name} joined the room.")
                # A drawer already has the word — resend it so a reconnect keeps drawing.
                if room.phase == "draw" and pid == room.drawer_id:
                    await manager.send(websocket, {"t": "word", "word": room.word})

            elif t == "start":
                if room.phase in ("lobby", "over") and len(room.players) >= _MIN_PLAYERS:
                    room.draw_secs = _clamp(msg.get("secs"), 30, 180, 60)
                    room.rounds = _clamp(msg.get("rounds"), 1, 3, 1)
                    for p in room.players.values():
                        p.score = 0
                    if room.loop_task and not room.loop_task.done():
                        room.loop_task.cancel()
                    room.loop_task = asyncio.create_task(manager.run_game(room))

            elif t == "stroke":
                if pid == room.drawer_id and room.phase == "draw":
                    stroke = msg.get("stroke")
                    if isinstance(stroke, dict):
                        await manager.broadcast(room, {"t": "stroke", "stroke": stroke}, exclude=pid)

            elif t == "clear":
                if pid == room.drawer_id and room.phase == "draw":
                    await manager.broadcast(room, {"t": "clear"}, exclude=pid)

            elif t == "react":
                me = room.players.get(pid)
                lid = msg.get("id")
                emoji = msg.get("emoji")
                if me and isinstance(lid, int) and isinstance(emoji, str):
                    await manager.react(room, lid, emoji, me.name)

            elif t == "guess":
                text = _clean(msg.get("text"), "", 120)
                me = room.players.get(pid)
                if not text or not me:
                    continue
                correct = (
                    pid != room.drawer_id
                    and room.phase == "draw"
                    and not room.winner
                    and text.strip().lower() == room.word.strip().lower()
                )
                if correct:
                    me.guessed = True
                    me.score += 50 + room.time_left
                    if room.drawer_id in room.players:
                        room.players[room.drawer_id].score += 25
                    room.winner = me.name
                    await manager.chat(room, "correct", me.name, me.color, f"{me.name} guessed it! 🎉")
                    await manager.push_state(room)
                    room.turn_over.set()  # first correct guess ends the turn immediately
                else:
                    await manager.chat(room, "guess", me.name, me.color, text)
    except WebSocketDisconnect:
        pass
    finally:
        room.players.pop(pid, None)
        if pid in room.order:
            room.order.remove(pid)
        if room.drawer_id == pid:
            room.turn_over.set()
        await manager.chat(room, "system", "", "", "A player left the room.")
        await manager.push_state(room)
        manager.drop_if_empty(room_id)
