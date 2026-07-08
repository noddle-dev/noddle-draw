/**
 * features/games/WordBombRoom — the live "Word Bomb" screen.
 *
 * Flow: enter a display name → lobby (pick seconds/turn + lives + how-to) →
 * turns. Each turn the server shows a random syllable FRAGMENT in a central
 * bomb with a countdown ring; the ACTIVE player must type a word CONTAINING
 * that fragment before the bomb blows. Valid → safe, pass on; timeout → lose a
 * life; 0 lives → eliminated. Last alive wins.
 * Server-authoritative (fragment/timer/turn/lives/winner all from the store).
 */
import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../../state/appStore";
import { GameDoodle } from "./GameDoodles";
import { NameGate, KilledNotice, RoomTopbar } from "./GameChrome";
import { hasGuestName } from "../../state/collabStore";
import {
  connectWordBomb,
  disconnectWordBomb,
  wordBombActions,
  useWordBombStore,
  type WBFeedLine,
} from "../../state/wordBombStore";

/* ---------- the central bomb: big fragment + countdown ring ---------- */
function Bomb() {
  const fragment = useWordBombStore((s) => s.fragment);
  const timeLeft = useWordBombStore((s) => s.timeLeft);
  const turnSecs = useRef(8);
  // Track the largest timeLeft seen this turn as the ring's full value.
  const [full, setFull] = useState(8);
  useEffect(() => {
    if (timeLeft > full) {
      turnSecs.current = timeLeft;
      setFull(timeLeft);
    }
    if (timeLeft === 0) setFull(turnSecs.current);
  }, [timeLeft, full]);

  const R = 88;
  const C = 2 * Math.PI * R;
  const frac = full > 0 ? Math.max(0, Math.min(1, timeLeft / full)) : 0;
  const danger = timeLeft <= 3;
  const ringColor = danger ? "var(--danger)" : "var(--accent)";

  return (
    <div className="wb-bomb">
      <svg width={220} height={220} viewBox="0 0 220 220" className="wb-bomb__ring">
        <circle cx={110} cy={110} r={R} fill="none" stroke="var(--border)" strokeWidth={12} />
        <circle
          cx={110} cy={110} r={R} fill="none" stroke={ringColor} strokeWidth={12}
          strokeLinecap="round" strokeDasharray={C} strokeDashoffset={C * (1 - frac)}
          transform="rotate(-90 110 110)"
        />
      </svg>
      <div className="wb-bomb__inner">
        <div className="wb-bomb__label"><GameDoodle kind="wordbomb" size={14} /> fragment</div>
        <div className="wb-frag">{fragment || "…"}</div>
        <div className={`wb-frag__time${danger ? " wb-frag__time--danger" : ""}`}>{timeLeft}s</div>
      </div>
    </div>
  );
}

/* ---------- one player avatar with hearts ---------- */
function PlayerChip({
  name, color, lives, alive, active, you,
}: { name: string; color: string; lives: number; alive: boolean; active: boolean; you: boolean }) {
  return (
    <div className={`player-chip${active ? " player-chip--active" : ""}${alive ? "" : " player-chip--out"}`}>
      <span className="player-chip__avatar" style={{ background: color }}>{name.slice(0, 2).toUpperCase()}</span>
      <span className="player-chip__name ellip">{name}{you ? " (you)" : ""}</span>
      <span className={`player-chip__hearts${alive ? "" : " player-chip__hearts--out"}`}>
        {alive ? "♥".repeat(Math.max(0, lives)) || "—" : "☠ out"}
      </span>
    </div>
  );
}

const FEED_CLS: Record<WBFeedLine["kind"], string> = {
  feed: "",
  accepted: " wb-feed__line--accepted",
  miss: " wb-feed__line--miss",
};

function Feed() {
  const feed = useWordBombStore((s) => s.feed);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [feed]);
  return (
    <div ref={listRef} className="wb-feed">
      {feed.map((l) => (
        <div key={l.id} className={`wb-feed__line${FEED_CLS[l.kind]}`}>{l.text}</div>
      ))}
    </div>
  );
}

/* ---------- scoreboard (right rail) ---------- */
function Scoreboard() {
  const players = useWordBombStore((s) => s.players);
  const you = useWordBombStore((s) => s.you);
  const activeId = useWordBombStore((s) => s.activeId);
  return (
    <div className="score-list">
      {players.map((p, i) => (
        <div key={p.id} className={`score-item${p.id === activeId ? " score-item--active" : ""}${p.alive ? "" : " score-item--out"}`}>
          <span className="score-rank">{i + 1}</span>
          <span className="avatar" style={{ width: 24, height: 24, fontSize: 10, background: p.color }}>{p.name.slice(0, 2).toUpperCase()}</span>
          <span className={`score-name${p.id === you ? " score-name--me" : ""} ellip`}>{p.name}{p.id === you ? " (you)" : ""}</span>
          <span className="score-badge score-badge--hearts">{p.alive ? "♥".repeat(Math.max(0, p.lives)) : "☠"}</span>
          <span className="score-pts">{p.score}</span>
        </div>
      ))}
    </div>
  );
}

/* ---------- submit input (enabled only on your turn) ---------- */
function SubmitBar() {
  const isMyTurn = useWordBombStore((s) => s.isMyTurn);
  const fragment = useWordBombStore((s) => s.fragment);
  const invalidReason = useWordBombStore((s) => s.invalidReason);
  const [text, setText] = useState("");
  const submit = () => {
    const t = text.trim();
    if (!t) return;
    wordBombActions.submit(t);
    setText("");
  };
  return (
    <div className="wb-submit">
      {isMyTurn && invalidReason && <div className="wb-submit__hint">{invalidReason}</div>}
      <div className="wb-submit__row">
        <input
          className="text-input" style={{ flex: 1 }} autoFocus={isMyTurn}
          placeholder={isMyTurn ? `Type a word containing "${fragment}"…` : "Waiting for your turn…"}
          value={text} disabled={!isMyTurn}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
        />
        <button className="btn btn-primary" disabled={!isMyTurn} onClick={submit}>Send</button>
      </div>
    </div>
  );
}

const HOW_TO = [
  "Players take turns around the circle receiving a FRAGMENT (2-3 letters).",
  "On your turn: type a word CONTAINING that fragment before the bomb explodes.",
  "The word must be ≥ 3 letters, contain the fragment, and not have been used yet this round.",
  "Time runs out = lose 1 life. No lives left = eliminated. Last one standing wins!",
];

/** Lobby / how-to / config (before the first turn and between games). */
function Lobby({ over }: { over: boolean }) {
  const players = useWordBombStore((s) => s.players);
  const connected = useWordBombStore((s) => s.connected);
  const finalScores = useWordBombStore((s) => s.finalScores);
  const winner = useWordBombStore((s) => s.winner);
  const [secs, setSecs] = useState(8);
  const [lives, setLives] = useState(3);

  return (
    <div className="game-overlay">
      <div className="game-modal">
        {over ? (
          <>
            <div className="game-modal__title">🏆 {winner ? `${winner} wins!` : "Finished!"}</div>
            <div className="final-rank">
              {(finalScores ?? players).slice(0, 5).map((p, i) => (
                <div key={p.id} className="final-rank__row">
                  <span className="game-over__medal">{["🥇", "🥈", "🥉"][i] ?? `${i + 1}.`}</span> <b>{p.name}</b> — {p.score} points
                </div>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="game-modal__title"><GameDoodle kind="wordbomb" size={22} /> Word Bomb</div>
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
              {[5, 7, 10].map((v) => <option key={v} value={v}>{v}s</option>)}
            </select>
          </label>
          <label className="game-config__field">
            <span>Lives</span>
            <select className="text-input" value={lives} onChange={(e) => setLives(+e.target.value)}>
              {[2, 3, 4].map((v) => <option key={v} value={v}>{v} ♥</option>)}
            </select>
          </label>
        </div>

        <div className="game-lobby__status">
          {connected ? `${players.length} people in the room` : "Connecting…"} · needs ≥ 2 people
        </div>
        <button className="btn btn-primary btn-block" disabled={players.length < 2} onClick={() => wordBombActions.start(secs, lives)}>
          {over ? "Play again" : "Start"} →
        </button>
      </div>
    </div>
  );
}

export function WordBombRoom({ roomId }: { roomId: string }) {
  const go = useAppStore((s) => s.go);
  const setDashPage = useAppStore((s) => s.setDashPage);
  const phase = useWordBombStore((s) => s.phase);
  const players = useWordBombStore((s) => s.players);
  const activeId = useWordBombStore((s) => s.activeId);
  const timeLeft = useWordBombStore((s) => s.timeLeft);
  const killed = useWordBombStore((s) => s.killed);
  const hostToken = useWordBombStore((s) => s.hostToken);
  const you = useWordBombStore((s) => s.you);
  const [named, setNamed] = useState(hasGuestName());

  useEffect(() => {
    if (!named) return;
    connectWordBomb(roomId);
    return () => disconnectWordBomb();
  }, [roomId, named]);

  const leave = () => { disconnectWordBomb(); go("dashboard"); setDashPage("games"); };

  if (!named) return <NameGate kind="wordbomb" onDone={() => setNamed(true)} />;
  if (killed) return <KilledNotice onLeave={leave} />;

  const active = players.find((p) => p.id === activeId);

  const center = phase === "play" ? (
    <>
      <span className="pill pill-accent">Turn: {active ? active.name : "?"}</span>
      <div style={{ flex: 1 }} />
      <span className={`game-timer${timeLeft <= 3 ? " game-timer--danger" : ""}`}>⏱ {timeLeft}s</span>
    </>
  ) : undefined;

  return (
    <div className="game-screen">
      <RoomTopbar
        kind="wordbomb"
        title="Word Bomb"
        roomId={roomId}
        players={players}
        hostToken={hostToken}
        onLeave={leave}
        center={center}
      />

      <div className="game-body">
        <div className="wb-stage">
          <div className="wb-players">
            {players.map((p) => (
              <PlayerChip
                key={p.id} name={p.name} color={p.color} lives={p.lives}
                alive={p.alive} active={p.id === activeId} you={p.id === you}
              />
            ))}
          </div>
          <div className="wb-center">
            <Bomb />
          </div>
          <SubmitBar />
          {(phase === "lobby" || phase === "over") && <Lobby over={phase === "over"} />}
        </div>

        <div className="game-rail game-rail--wide">
          <div>
            <div className="game-rail__title" style={{ marginBottom: 6 }}>Scoreboard</div>
            <Scoreboard />
          </div>
          <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
            <div className="game-rail__title" style={{ marginBottom: 6 }}>Activity</div>
            <Feed />
          </div>
        </div>
      </div>
    </div>
  );
}
