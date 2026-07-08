"""Team engagement — real-time multiplayer game **Word Bomb** over WebSocket.

A fast turn-based word game (skribbl-style lobby, but no drawing). Players sit
in a circle; each turn the SERVER shows a random syllable FRAGMENT (2-3 letters,
e.g. "st", "ca", "ing"). The ACTIVE player must type a word that CONTAINS that
fragment before the per-turn "bomb" timer runs out. Valid → the player is safe,
the word is broadcast, and play passes to the next alive player with a NEW
fragment + reset timer. Timer hits 0 → the active player loses a life; at 0
lives they are eliminated. Last player standing wins.

``/ws/wordbomb/{room_id}`` — one lobby per room id (share the /play link). The
SERVER is authoritative: it owns the fragment, the timer, whose turn it is,
lives, the used-words set and elimination. Non-active players just watch the
live feed of accepted words / misses.

  client → server
    {"t":"hello","name","color"}
    {"t":"start","secs":int,"lives":int}     # lobby/over → play (≥2 players)
    {"t":"submit","word"}                     # active player only
  server → clients
    {"t":"state", phase("lobby"|"play"|"over"), fragment, timeLeft, activeId,
                  players:[{id,name,color,lives,score,alive}], you}
    {"t":"accepted","id","word"}              # a valid word was accepted
    {"t":"miss","id"}                          # active player let the bomb blow
    {"t":"feed","text"}                        # a system line for the feed
    {"t":"invalid","reason"}                   # to the SENDER only (keep trying)
    {"t":"gameOver","winner","scores":[...]}
    {"t":"killed","reason"}                     # admin force-close
"""
from __future__ import annotations

import asyncio
import json
import random
from dataclasses import dataclass, field

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.domain.ids import is_valid_id

router = APIRouter()

_MAX_MSG_BYTES = 100_000
_MIN_PLAYERS = 2
_MAX_NAME = 32
_MAX_WORD = 40
_MIN_WORD_LEN = 3
_POINTS_ACCEPTED = 100
_POINTS_WINNER = 200

# ~30 common English 2-3 letter fragments that appear inside many words.
_FRAGMENTS = [
    "st", "tr", "ca", "in", "ing", "er", "an", "re", "co", "on",
    "at", "en", "ti", "es", "te", "or", "de", "al", "ar", "ra",
    "pro", "com", "str", "ent", "ion", "ch", "th", "ea", "ou", "ll",
    "un", "pl", "gr", "sh",
]


@dataclass
class Player:
    ws: WebSocket
    name: str
    color: str
    lives: int = 3
    score: int = 0
    alive: bool = True


@dataclass
class WordBombRoom:
    players: dict[int, Player] = field(default_factory=dict)
    order: list[int] = field(default_factory=list)
    phase: str = "lobby"  # lobby | play | over
    fragment: str = ""
    active_id: int | None = None
    time_left: int = 0
    turn_secs: int = 8
    lives_start: int = 3
    used_words: set[str] = field(default_factory=set)
    winner: str = ""
    loop_task: asyncio.Task | None = None
    turn_over: asyncio.Event = field(default_factory=asyncio.Event)
    host_secret: str = ""  # capability token handed to the room creator
    host_user_id: str | None = None  # creator's account id (if signed in)


class WordBombManager:
    def __init__(self) -> None:
        self._rooms: dict[str, WordBombRoom] = {}
        self._next = 0

    def next_id(self) -> int:
        self._next += 1
        return self._next

    def room(self, room_id: str) -> WordBombRoom:
        return self._rooms.setdefault(room_id, WordBombRoom())

    def drop_if_empty(self, room_id: str) -> None:
        r = self._rooms.get(room_id)
        if r and not r.players:
            if r.loop_task and not r.loop_task.done():
                r.loop_task.cancel()
            del self._rooms[room_id]

    async def send(self, ws: WebSocket, payload: dict) -> bool:
        try:
            await ws.send_text(json.dumps(payload, ensure_ascii=False))
            return True
        except Exception:
            return False

    async def broadcast(self, room: WordBombRoom, payload: dict, exclude: int | None = None) -> None:
        dead: list[int] = []
        for pid, p in list(room.players.items()):
            if pid == exclude:
                continue
            if not await self.send(p.ws, payload):
                dead.append(pid)
        for pid in dead:
            room.players.pop(pid, None)

    async def feed(self, room: WordBombRoom, text: str) -> None:
        await self.broadcast(room, {"t": "feed", "text": text})

    def state_payload(self, room: WordBombRoom) -> dict:
        return {
            "t": "state",
            "phase": room.phase,
            "fragment": room.fragment if room.phase == "play" else "",
            "timeLeft": room.time_left,
            "activeId": room.active_id,
            "players": [
                {
                    "id": pid,
                    "name": p.name,
                    "color": p.color,
                    "lives": p.lives,
                    "score": p.score,
                    "alive": p.alive,
                }
                for pid, p in sorted(room.players.items(), key=lambda kv: -kv[1].score)
            ],
        }

    async def push_state(self, room: WordBombRoom) -> None:
        await self.broadcast(room, self.state_payload(room))

    def _alive_ids(self, room: WordBombRoom) -> list[int]:
        return [pid for pid in room.order if pid in room.players and room.players[pid].alive]

    async def run_game(self, room: WordBombRoom) -> None:
        """Server-authoritative turn loop until one player remains (or none)."""
        try:
            living = self._alive_ids(room)
            if len(living) < _MIN_PLAYERS:
                return
            active = living[0]
            while True:
                living = self._alive_ids(room)
                if len(living) <= 1:
                    break
                if active not in living:
                    active = living[0]

                room.active_id = active
                room.phase = "play"
                room.fragment = random.choice(_FRAGMENTS)
                room.time_left = room.turn_secs
                room.turn_over.clear()
                ap = room.players.get(active)
                await self.feed(room, f"{ap.name if ap else '?'}'s turn — fragment \"{room.fragment}\"")
                await self.push_state(room)

                # Bomb countdown: tick each second, end early on a valid word.
                accepted = False
                while room.time_left > 0:
                    try:
                        await asyncio.wait_for(room.turn_over.wait(), timeout=1.0)
                        accepted = True
                        break
                    except asyncio.TimeoutError:
                        room.time_left -= 1
                        await self.push_state(room)

                cur = room.players.get(active)
                if not accepted and cur is not None:
                    # The bomb went off — the active player loses a life.
                    cur.lives -= 1
                    await self.broadcast(room, {"t": "miss", "id": active})
                    if cur.lives <= 0:
                        cur.alive = False
                        await self.feed(room, f"💥 {cur.name} is out of lives and eliminated!")
                    else:
                        await self.feed(room, f"💥 Boom! {cur.name} has {cur.lives} lives left.")
                    await self.push_state(room)

                # Pass to the next alive player.
                living = self._alive_ids(room)
                if len(living) <= 1:
                    break
                if active in living:
                    i = living.index(active)
                    active = living[(i + 1) % len(living)]
                else:
                    active = living[0]

            room.phase = "over"
            room.active_id = None
            room.fragment = ""
            survivors = self._alive_ids(room)
            if len(survivors) == 1:
                w = room.players[survivors[0]]
                w.score += _POINTS_WINNER
                room.winner = w.name
            else:
                room.winner = ""
            scores = [
                {"id": pid, "name": p.name, "color": p.color, "score": p.score, "lives": p.lives}
                for pid, p in sorted(room.players.items(), key=lambda kv: -kv[1].score)
            ]
            await self.broadcast(room, {"t": "gameOver", "winner": room.winner, "scores": scores})
            await self.push_state(room)
        except asyncio.CancelledError:
            pass


manager = WordBombManager()


def _clean(v: object, fallback: str, cap: int = _MAX_NAME) -> str:
    s = v if isinstance(v, str) else fallback
    return (s.strip() or fallback)[:cap]


def _clamp(v: object, lo: int, hi: int, default: int) -> int:
    try:
        return max(lo, min(hi, int(v)))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default


@router.websocket("/ws/wordbomb/{room_id}")
async def wordbomb_ws(websocket: WebSocket, room_id: str) -> None:
    if not is_valid_id(room_id):
        await websocket.close(code=4404)
        return
    await websocket.accept()
    room = manager.room(room_id)
    pid = manager.next_id()

    # Resolve identity (bearer → session cookie → guest) to bind an
    # authenticated host to their account for the "Close room" control.
    from app.api.games import assign_host

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
                    lives=room.lives_start,
                    alive=room.phase != "play",
                )
                if pid not in room.order:
                    room.order.append(pid)
                host_token = assign_host(room, principal)
                if host_token:
                    await manager.send(websocket, {"t": "host", "token": host_token})
                await manager.send(websocket, {**manager.state_payload(room), "you": pid})
                await manager.push_state(room)
                await manager.feed(room, f"{room.players[pid].name} joined the room.")

            elif t == "start":
                if room.phase in ("lobby", "over") and len(room.players) >= _MIN_PLAYERS:
                    room.turn_secs = _clamp(msg.get("secs"), 5, 15, 8)
                    room.lives_start = _clamp(msg.get("lives"), 2, 4, 3)
                    room.used_words.clear()
                    room.winner = ""
                    for p in room.players.values():
                        p.lives = room.lives_start
                        p.score = 0
                        p.alive = True
                    if room.loop_task and not room.loop_task.done():
                        room.loop_task.cancel()
                    room.loop_task = asyncio.create_task(manager.run_game(room))

            elif t == "submit":
                me = room.players.get(pid)
                if not me or room.phase != "play" or pid != room.active_id:
                    continue
                word = _clean(msg.get("word"), "", _MAX_WORD)
                low = word.strip().lower()
                if len(low) < _MIN_WORD_LEN:
                    await manager.send(websocket, {"t": "invalid", "reason": f"Word must be at least {_MIN_WORD_LEN} letters long."})
                    continue
                if room.fragment.lower() not in low:
                    await manager.send(websocket, {"t": "invalid", "reason": f"Word must contain \"{room.fragment}\"."})
                    continue
                if low in room.used_words:
                    await manager.send(websocket, {"t": "invalid", "reason": "This word has already been used."})
                    continue
                # Valid! Award, broadcast, and end the turn immediately.
                room.used_words.add(low)
                me.score += _POINTS_ACCEPTED
                await manager.broadcast(room, {"t": "accepted", "id": pid, "word": word})
                await manager.feed(room, f"✅ {me.name}: \"{word}\"")
                await manager.push_state(room)
                room.turn_over.set()
    except WebSocketDisconnect:
        pass
    finally:
        room.players.pop(pid, None)
        if pid in room.order:
            room.order.remove(pid)
        if room.active_id == pid:
            room.turn_over.set()
        await manager.feed(room, "A player left the room.")
        await manager.push_state(room)
        manager.drop_if_empty(room_id)
