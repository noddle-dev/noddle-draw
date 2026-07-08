"""Team Trivia — a real-time multiplayer quiz game (Kahoot-lite) over WebSocket.

Second team-play game (sibling of Draw & Guess in ``api/games.py``, whose
WebSocket/turn-loop/broadcast pattern this mirrors). One shared question bank;
each round the SERVER shows a multiple-choice question + a countdown, players
lock exactly ONE answer (first pick only — no changing), then the server reveals
the correct option and awards points (correct = 500 + a speed bonus scaled by
time left; wrong / no answer = 0). After N questions → a final ranking.

``/ws/trivia/{room_id}`` — a lobby per room id. The SERVER is authoritative: it
owns the correct answer (NEVER sent to clients before the reveal), the timer and
all scores.

  client → server
    {"t":"hello","name","color"}
    {"t":"start","secs":int,"questions":int}     # lobby/over → play (≥2 players)
    {"t":"answer","choice":int}                   # lock ONE answer (0..3)
  server → clients
    {"t":"state", phase("lobby"|"question"|"reveal"|"over"), qIndex, totalQ,
                  timeLeft, question, options, players:[{id,name,color,score,
                  answered}], you}
    {"t":"reveal", answer:int, correct:[ids], scores:[...]}
    {"t":"gameOver", scores:[...]}
"""
from __future__ import annotations

import asyncio
import json
import random
from dataclasses import dataclass, field

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.domain.ids import is_valid_id

router = APIRouter()

_MAX_MSG_BYTES = 200_000
_REVEAL_SECONDS = 5
_MIN_PLAYERS = 2
_MAX_NAME = 32
_BASE_POINTS = 500

# Built-in question bank. Each: {"q", "options": [4 strings], "answer": index}.
# Mix of general / tech / fun — light and team-friendly.
_BANK: list[dict] = [
    {"q": "What is the capital city of Vietnam?",
     "options": ["Ho Chi Minh City", "Da Nang", "Hanoi", "Hue"], "answer": 2},
    {"q": "Which programming language has a snake as its logo?",
     "options": ["Java", "Python", "Ruby", "Go"], "answer": 1},
    {"q": "What does HTTP status code 404 mean?",
     "options": ["OK", "Not Found", "Server Error", "Redirect"], "answer": 1},
    {"q": "Which planet is the largest in the Solar System?",
     "options": ["Saturn", "Earth", "Jupiter", "Mars"], "answer": 2},
    {"q": "Which Git command pulls changes down from a remote?",
     "options": ["git push", "git commit", "git pull", "git stage"], "answer": 2},
    {"q": "Which ocean is the largest in the world?",
     "options": ["Atlantic Ocean", "Indian Ocean", "Arctic Ocean", "Pacific Ocean"], "answer": 3},
    {"q": "What does SQL stand for?",
     "options": ["Structured Query Language", "Simple Question Language",
                 "Server Query Logic", "Standard Quality Level"], "answer": 0},
    {"q": "How many colors are in a rainbow?",
     "options": ["5", "6", "7", "8"], "answer": 2},
    {"q": "What is the default port for HTTPS?",
     "options": ["80", "443", "8080", "22"], "answer": 1},
    {"q": "Which animal is Docker's mascot?",
     "options": ["Penguin", "Whale", "Elephant", "Leopard"], "answer": 1},
    {"q": "How many bits are in 1 byte?",
     "options": ["4", "8", "16", "32"], "answer": 1},
    {"q": "Who is the author of the theory of relativity?",
     "options": ["Isaac Newton", "Nikola Tesla", "Albert Einstein", "Galileo"], "answer": 2},
    {"q": "Which company developed React?",
     "options": ["Google", "Facebook (Meta)", "Microsoft", "Amazon"], "answer": 1},
    {"q": "Which note is NOT one of the 7 basic solfège notes?",
     "options": ["Do", "Re", "Ti", "Zo"], "answer": 3},
    {"q": "The famous Giza pyramids are located in which country?",
     "options": ["Greece", "Egypt", "Mexico", "Iraq"], "answer": 1},
    {"q": "What is CSS used for on a webpage?",
     "options": ["Processing data", "Styling & layout", "Connecting to a database",
                 "Sending email"], "answer": 1},
]


@dataclass
class Player:
    ws: WebSocket
    name: str
    color: str
    score: int = 0
    # index the player locked this question (None = not answered yet)
    choice: int | None = None
    # seconds left when they answered (drives the speed bonus)
    answered_at: int = 0


@dataclass
class TriviaRoom:
    players: dict[int, Player] = field(default_factory=dict)
    order: list[int] = field(default_factory=list)
    phase: str = "lobby"  # lobby | question | reveal | over
    q_index: int = 0
    total_q: int = 0
    questions: list[dict] = field(default_factory=list)  # picked for this game
    time_left: int = 0
    q_secs: int = 20
    loop_task: asyncio.Task | None = None
    all_answered: asyncio.Event = field(default_factory=asyncio.Event)
    host_secret: str = ""  # capability token handed to the room creator
    host_user_id: str | None = None  # creator's account id (if signed in)


class TriviaManager:
    def __init__(self) -> None:
        self._rooms: dict[str, TriviaRoom] = {}
        self._next = 0

    def next_id(self) -> int:
        self._next += 1
        return self._next

    def room(self, room_id: str) -> TriviaRoom:
        return self._rooms.setdefault(room_id, TriviaRoom())

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

    async def broadcast(self, room: TriviaRoom, payload: dict, exclude: int | None = None) -> None:
        dead: list[int] = []
        for pid, p in list(room.players.items()):
            if pid == exclude:
                continue
            if not await self.send(p.ws, payload):
                dead.append(pid)
        for pid in dead:
            room.players.pop(pid, None)

    def _current(self, room: TriviaRoom) -> dict | None:
        if 0 <= room.q_index < len(room.questions):
            return room.questions[room.q_index]
        return None

    def _scores(self, room: TriviaRoom) -> list[dict]:
        return [
            {"id": pid, "name": p.name, "color": p.color, "score": p.score}
            for pid, p in sorted(room.players.items(), key=lambda kv: -kv[1].score)
        ]

    def state_payload(self, room: TriviaRoom) -> dict:
        q = self._current(room)
        # NEVER leak the answer index — only the public question text + options.
        return {
            "t": "state",
            "phase": room.phase,
            "qIndex": room.q_index,
            "totalQ": room.total_q,
            "timeLeft": room.time_left,
            "question": q["q"] if q and room.phase in ("question", "reveal") else "",
            "options": list(q["options"]) if q and room.phase in ("question", "reveal") else [],
            "players": [
                {"id": pid, "name": p.name, "color": p.color, "score": p.score,
                 "answered": p.choice is not None}
                for pid, p in sorted(room.players.items(), key=lambda kv: -kv[1].score)
            ],
        }

    async def push_state(self, room: TriviaRoom) -> None:
        await self.broadcast(room, self.state_payload(room))

    async def run_game(self, room: TriviaRoom) -> None:
        try:
            for i in range(room.total_q):
                present = [pid for pid in room.order if pid in room.players]
                if len(present) < _MIN_PLAYERS:
                    break
                room.q_index = i
                room.phase = "question"
                room.time_left = room.q_secs
                for p in room.players.values():
                    p.choice = None
                    p.answered_at = 0
                room.all_answered.clear()
                await self.push_state(room)

                # Countdown: tick each second, end early once everyone answered.
                while room.time_left > 0:
                    try:
                        await asyncio.wait_for(room.all_answered.wait(), timeout=1.0)
                        break
                    except asyncio.TimeoutError:
                        room.time_left -= 1
                        await self.push_state(room)

                # Reveal: score, disclose the correct index + everyone's pick.
                q = self._current(room)
                answer = int(q["answer"]) if q else -1
                correct_ids: list[int] = []
                for pid, p in room.players.items():
                    if p.choice is not None and p.choice == answer:
                        bonus = int(_BASE_POINTS * (p.answered_at / room.q_secs)) if room.q_secs else 0
                        p.score += _BASE_POINTS + bonus
                        correct_ids.append(pid)
                room.phase = "reveal"
                room.time_left = _REVEAL_SECONDS
                await self.broadcast(room, {
                    "t": "reveal",
                    "answer": answer,
                    "correct": correct_ids,
                    "picks": {str(pid): p.choice for pid, p in room.players.items()},
                    "scores": self._scores(room),
                })
                await self.push_state(room)
                while room.time_left > 0:
                    await asyncio.sleep(1.0)
                    room.time_left -= 1
                    await self.push_state(room)

            room.phase = "over"
            await self.broadcast(room, {"t": "gameOver", "scores": self._scores(room)})
            await self.push_state(room)
        except asyncio.CancelledError:
            pass


manager = TriviaManager()


def _clean(v: object, fallback: str, cap: int = _MAX_NAME) -> str:
    s = v if isinstance(v, str) else fallback
    return (s.strip() or fallback)[:cap]


def _clamp(v: object, lo: int, hi: int, default: int) -> int:
    try:
        return max(lo, min(hi, int(v)))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default


@router.websocket("/ws/trivia/{room_id}")
async def trivia_ws(websocket: WebSocket, room_id: str) -> None:
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
                )
                if pid not in room.order:
                    room.order.append(pid)
                host_token = assign_host(room, principal)
                if host_token:
                    await manager.send(websocket, {"t": "host", "token": host_token})
                await manager.send(websocket, {**manager.state_payload(room), "you": pid})
                await manager.push_state(room)

            elif t == "start":
                if room.phase in ("lobby", "over") and len(room.players) >= _MIN_PLAYERS:
                    room.q_secs = _clamp(msg.get("secs"), 10, 30, 20)
                    n = _clamp(msg.get("questions"), 5, 10, 5)
                    n = min(n, len(_BANK))
                    room.questions = random.sample(_BANK, n)
                    room.total_q = n
                    room.q_index = 0
                    for p in room.players.values():
                        p.score = 0
                        p.choice = None
                    if room.loop_task and not room.loop_task.done():
                        room.loop_task.cancel()
                    room.loop_task = asyncio.create_task(manager.run_game(room))

            elif t == "answer":
                me = room.players.get(pid)
                if not me or room.phase != "question":
                    continue
                if me.choice is not None:  # first answer only — can't change
                    continue
                choice = msg.get("choice")
                q = manager._current(room)
                n_opts = len(q["options"]) if q else 0
                if not isinstance(choice, int) or not (0 <= choice < n_opts):
                    continue
                me.choice = choice
                me.answered_at = room.time_left  # more time left → bigger bonus
                await manager.push_state(room)
                # Everyone present answered → end the question early.
                present = [p for p in room.players.values()]
                if present and all(p.choice is not None for p in present):
                    room.all_answered.set()
    except WebSocketDisconnect:
        pass
    finally:
        room.players.pop(pid, None)
        if pid in room.order:
            room.order.remove(pid)
        # If the departing player was the last one still thinking, unblock.
        present = [p for p in room.players.values()]
        if present and all(p.choice is not None for p in present):
            room.all_answered.set()
        await manager.push_state(room)
        manager.drop_if_empty(room_id)
