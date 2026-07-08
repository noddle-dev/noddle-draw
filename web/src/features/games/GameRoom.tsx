/**
 * features/games/GameRoom — the live "Draw & Guess" screen.
 *
 * Flow: enter a display name → lobby (pick seconds/round + how-to) → turns.
 * The drawer sketches on a shared 900×600 board (freehand, broadcast live);
 * everyone else watches and races to guess in the side chat. The FIRST correct
 * guess pauses the turn → a congrats popup → a countdown to the next drawer.
 * Server-authoritative (word/timer/scores/winner all come from gameStore).
 */
import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../../state/appStore";
import { Icon } from "../../shared/ui";
import { GameDoodle } from "./GameDoodles";
import { NameGate, KilledNotice, RoomTopbar } from "./GameChrome";
import { hasGuestName } from "../../state/collabStore";
import {
  connectGame,
  disconnectGame,
  gameActions,
  useGameStore,
  REACT_EMOJI,
  type ChatLine,
  type GameStroke,
} from "../../state/gameStore";

const BW = 900;
const BH = 600;
const PEN_COLORS = ["#1a1d23", "#dc2626", "#ea580c", "#d97706", "#16a34a", "#2563eb", "#7c3aed", "#db2777"];

/* ---------- word as letter tiles (easier to read / guess) ---------- */
function WordTiles({ text, big }: { text: string; big?: boolean }) {
  return (
    <div className={`word-tiles${big ? " word-tiles--big" : ""}`}>
      {text.split("").map((c, i) =>
        c === " " ? (
          <span key={i} className="word-tile word-tile--space" />
        ) : (
          <span key={i} className="word-tile">{c === "_" ? "" : c}</span>
        ),
      )}
    </div>
  );
}

function Board() {
  const svgRef = useRef<SVGSVGElement>(null);
  const strokes = useGameStore((s) => s.strokes);
  const isDrawer = useGameStore((s) => s.isDrawer);
  const phase = useGameStore((s) => s.phase);
  const [color, setColor] = useState("#1a1d23");
  const [width, setWidth] = useState(4);
  const drawing = useRef<GameStroke | null>(null);
  const lastSent = useRef(0);
  const canDraw = isDrawer && phase === "draw";

  const toBoard = (e: React.PointerEvent): [number, number] => {
    const r = svgRef.current!.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * BW, ((e.clientY - r.top) / r.height) * BH];
  };
  const down = (e: React.PointerEvent) => {
    if (!canDraw) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    drawing.current = { id: `${useGameStore.getState().you}-${Date.now()}`, color, width, points: [toBoard(e)] };
    gameActions.sendStroke(drawing.current);
  };
  const move = (e: React.PointerEvent) => {
    if (!canDraw || !drawing.current) return;
    drawing.current.points.push(toBoard(e));
    const now = Date.now();
    if (now - lastSent.current > 45) {
      lastSent.current = now;
      gameActions.sendStroke({ ...drawing.current, points: drawing.current.points.slice() });
    }
  };
  const up = () => {
    if (drawing.current) gameActions.sendStroke({ ...drawing.current, points: drawing.current.points.slice() });
    drawing.current = null;
  };
  const path = (pts: [number, number][]) =>
    pts.length === 1 ? `M ${pts[0][0]} ${pts[0][1]} L ${pts[0][0] + 0.1} ${pts[0][1]}` : "M " + pts.map((p) => `${p[0]} ${p[1]}`).join(" L ");

  return (
    <div className="draw-wrap">
      {/* Center the board and PIN it to the 3:2 viewBox aspect so screen→board
          coordinate mapping is exact (no letterbox → cursor tracks the ink). */}
      <div className="draw-canvas-wrap">
        <svg
          ref={svgRef}
          className="draw-canvas"
          viewBox={`0 0 ${BW} ${BH}`}
          preserveAspectRatio="xMidYMid meet"
          style={{ cursor: canDraw ? "crosshair" : "default" }}
          onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerLeave={up}
        >
          {strokes.map((s) => (
            <path key={s.id} d={path(s.points)} fill="none" stroke={s.color} strokeWidth={s.width} strokeLinecap="round" strokeLinejoin="round" />
          ))}
        </svg>
      </div>
      {canDraw && (
        <div className="draw-toolbar">
          <div className="pen-swatches">
            {PEN_COLORS.map((c) => (
              <button key={c} onClick={() => setColor(c)} className={`pen-swatch${color === c ? " pen-swatch--on" : ""}`} style={{ background: c }} />
            ))}
          </div>
          <input type="range" min={2} max={18} value={width} onChange={(e) => setWidth(+e.target.value)} />
          <button className="btn" onClick={gameActions.clear}>Clear board</button>
        </div>
      )}
    </div>
  );
}

function Scoreboard() {
  const players = useGameStore((s) => s.players);
  const drawerId = useGameStore((s) => s.drawerId);
  const you = useGameStore((s) => s.you);
  return (
    <div className="score-list">
      {players.map((p, i) => (
        <div key={p.id} className={`score-item${p.id === drawerId ? " score-item--active" : ""}`}>
          <span className="score-rank">{i + 1}</span>
          <span className="avatar" style={{ width: 24, height: 24, fontSize: 10, background: p.color }}>{p.name.slice(0, 2).toUpperCase()}</span>
          <span className={`score-name${p.id === you ? " score-name--me" : ""} ellip`}>{p.name}{p.id === you ? " (you)" : ""}</span>
          {p.id === drawerId && <Icon name="edit" size={13} />}
          {p.guessed && <span className="score-badge score-badge--ok">✓</span>}
          <span className="score-pts">{p.score}</span>
        </div>
      ))}
    </div>
  );
}

function ChatRow({ l }: { l: ChatLine }) {
  const [pickOpen, setPickOpen] = useState(false);
  const reactions = l.reactions ?? {};
  const chips = Object.entries(reactions).filter(([, names]) => names.length > 0);
  const kindCls =
    l.kind === "system" ? " chat-row--system" : l.kind === "correct" ? " chat-row--correct" : l.kind === "ai" ? " chat-row--ai" : "";
  return (
    <div className={`chat-row${kindCls}`} onMouseLeave={() => setPickOpen(false)}>
      <div className="chat-row__main">
        <div style={{ flex: 1, minWidth: 0 }}>
          {l.kind === "ai" ? (
            <span><b>✦ AI-Noddle:</b> {l.text.replace(/^✦ AI-Noddle:?\s*/, "")}</span>
          ) : l.kind === "system" || l.kind === "correct" ? (
            <span>{l.text}</span>
          ) : (
            <span><b style={{ color: l.color }}>{l.name}:</b> {l.text}</span>
          )}
        </div>
        <button title="React" className="chat-react-btn" onClick={() => setPickOpen((v) => !v)}>🙂</button>
      </div>
      {chips.length > 0 && (
        <div className="chat-reactions">
          {chips.map(([emoji, names]) => (
            <button key={emoji} title={names.join(", ")} className="react-chip" onClick={() => gameActions.react(l.id, emoji)}>
              {emoji} {names.length}
            </button>
          ))}
        </div>
      )}
      {pickOpen && (
        <div className="react-pop">
          {REACT_EMOJI.map((e) => (
            <button key={e} onClick={() => { gameActions.react(l.id, e); setPickOpen(false); }}>{e}</button>
          ))}
        </div>
      )}
    </div>
  );
}

function GuessChat() {
  const chat = useGameStore((s) => s.chat);
  const isDrawer = useGameStore((s) => s.isDrawer);
  const phase = useGameStore((s) => s.phase);
  const [text, setText] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [chat]);
  const submit = () => {
    const t = text.trim();
    if (!t) return;
    gameActions.guess(t);
    setText("");
  };
  const disabled = isDrawer && phase === "draw";
  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div ref={listRef} className="chat-list">
        {chat.map((l) => <ChatRow key={l.id} l={l} />)}
      </div>
      <div className="chat-input-row">
        <input
          className="text-input" style={{ flex: 1 }}
          placeholder={disabled ? "You're drawing — others are guessing…" : "Type your guess…"}
          value={text} disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
        />
        <button className="btn btn-primary" disabled={disabled} onClick={submit}>Send</button>
      </div>
    </div>
  );
}

const HOW_TO = [
  "Each turn, one person gets a secret word to draw.",
  "The drawer can only draw — no typing. Everyone else types guesses in the chat.",
  "The FIRST correct guess wins the turn: the faster you guess, the higher your score.",
  "The drawer changes after each turn. After the last turn → the leaderboard.",
];

/** Lobby / how-to / config (before the first turn and between games). */
function Lobby({ over }: { over: boolean }) {
  const players = useGameStore((s) => s.players);
  const connected = useGameStore((s) => s.connected);
  const finalScores = useGameStore((s) => s.finalScores);
  const [secs, setSecs] = useState(60);
  const [rounds, setRounds] = useState(1);

  return (
    <div className="game-overlay">
      <div className="game-modal">
        {over ? (
          <>
            <div className="game-modal__title">🏆 Game over!</div>
            <div className="final-rank">
              {(finalScores ?? players).slice(0, 5).map((p, i) => (
                <div key={p.id} className="final-rank__row">
                  <span className="game-over__medal">{["🥇", "🥈", "🥉"][i] ?? `${i + 1}.`}</span> <b>{p.name}</b> — {p.score} pts
                </div>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="game-modal__title"><GameDoodle kind="draw" size={22} /> Draw &amp; Guess</div>
            <div className="how-to">
              <div className="how-to__title">How to play</div>
              <ol>{HOW_TO.map((h, i) => <li key={i}>{h}</li>)}</ol>
            </div>
          </>
        )}

        <div className="game-config">
          <label className="game-config__field">
            <span>Seconds / turn</span>
            <select className="text-input" value={secs} onChange={(e) => setSecs(+e.target.value)}>
              {[30, 45, 60, 90, 120].map((v) => <option key={v} value={v}>{v}s</option>)}
            </select>
          </label>
          <label className="game-config__field">
            <span>Number of rounds</span>
            <select className="text-input" value={rounds} onChange={(e) => setRounds(+e.target.value)}>
              {[1, 2, 3].map((v) => <option key={v} value={v}>{v} rounds</option>)}
            </select>
          </label>
        </div>

        <div className="game-lobby__status">
          {connected ? `${players.length} in the room` : "Connecting…"} · needs ≥ 2 players
        </div>
        <button className="btn btn-primary btn-block" disabled={players.length < 2} onClick={() => gameActions.start(secs, rounds)}>
          {over ? "Play again" : "Start"} →
        </button>
      </div>
    </div>
  );
}

/** Reveal overlay: congrats for the winner + the word + countdown to next turn. */
function RevealOverlay() {
  const winner = useGameStore((s) => s.winner);
  const word = useGameStore((s) => s.word);
  const timeLeft = useGameStore((s) => s.timeLeft);
  return (
    <div className="game-overlay">
      <div className="game-modal" style={{ maxWidth: 380 }}>
        <div className="reveal-emoji">{winner ? "🎉" : "⏱"}</div>
        <div className="reveal-title">{winner ? `${winner} guessed it!` : "Time's up!"}</div>
        <div style={{ color: "var(--muted)", fontSize: 13, marginBottom: 12 }}>The word was</div>
        <div style={{ marginBottom: 16 }}><WordTiles text={word} big /></div>
        <div style={{ fontSize: 13, color: "var(--muted)" }}>New turn in <b>{timeLeft}s</b>…</div>
      </div>
    </div>
  );
}

export function GameRoom({ roomId }: { roomId: string }) {
  const go = useAppStore((s) => s.go);
  const setDashPage = useAppStore((s) => s.setDashPage);
  const phase = useGameStore((s) => s.phase);
  const turn = useGameStore((s) => s.turn);
  const totalTurns = useGameStore((s) => s.totalTurns);
  const timeLeft = useGameStore((s) => s.timeLeft);
  const hint = useGameStore((s) => s.hint);
  const isDrawer = useGameStore((s) => s.isDrawer);
  const word = useGameStore((s) => s.word);
  const players = useGameStore((s) => s.players);
  const hostToken = useGameStore((s) => s.hostToken);
  const [named, setNamed] = useState(hasGuestName());
  const killed = useGameStore((s) => s.killed);

  useEffect(() => {
    if (!named) return;
    connectGame(roomId);
    return () => disconnectGame();
  }, [roomId, named]);

  const leave = () => { disconnectGame(); go("dashboard"); setDashPage("games"); };

  if (!named) return <NameGate kind="draw" onDone={() => setNamed(true)} />;
  if (killed) return <KilledNotice onLeave={leave} />;

  // Word line: drawer sees the real word; guessers see the masked hint.
  const wordText = isDrawer && phase === "draw" ? word : hint;

  const center =
    phase === "draw" ? (
      <>
        <span className="pill pill-accent">Turn {turn}/{totalTurns}</span>
        <div style={{ flex: 1 }}><WordTiles text={wordText} /></div>
        <span className={`game-timer${timeLeft <= 10 ? " game-timer--danger" : ""}`}>⏱ {timeLeft}s</span>
      </>
    ) : undefined;

  return (
    <div className="game-screen">
      <RoomTopbar
        kind="draw"
        title="Draw & Guess"
        roomId={roomId}
        players={players}
        hostToken={hostToken}
        onLeave={leave}
        center={center}
      />

      <div className="game-body">
        <div className="game-rail">
          <div className="game-rail__title">Scoreboard</div>
          <Scoreboard />
        </div>

        <div className="game-stage">
          <Board />
          {(phase === "lobby" || phase === "over") && <Lobby over={phase === "over"} />}
          {phase === "reveal" && <RevealOverlay />}
        </div>

        <div className="game-rail game-rail--wide">
          <div className="game-rail__title">Guess &amp; chat</div>
          <GuessChat />
        </div>
      </div>
    </div>
  );
}
