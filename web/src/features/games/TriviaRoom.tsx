/**
 * features/games/TriviaRoom — the live "Team Trivia" screen (Kahoot-lite).
 *
 * Flow: enter a display name → lobby (pick seconds/question count + how-to) →
 * rounds. Each round the server shows a question + 4 options + a countdown;
 * players tap ONE option to lock it (first pick only). On reveal the correct
 * option turns green, wrong picks red, and the scoreboard updates. After N
 * questions → a final ranking + "Play again". Server-authoritative (question,
 * answer, timer, scores all come from triviaStore).
 */
import { useEffect, useState } from "react";
import { useAppStore } from "../../state/appStore";
import { GameDoodle } from "./GameDoodles";
import { NameGate, KilledNotice, RoomTopbar } from "./GameChrome";
import { hasGuestName } from "../../state/collabStore";
import {
  connectTrivia,
  disconnectTrivia,
  triviaActions,
  useTriviaStore,
} from "../../state/triviaStore";

// Kahoot-style option colors (shape + hue helps recall).
const OPTION_STYLES = [
  { bg: "#e21b3c", glyph: "▲" }, // red
  { bg: "#1368ce", glyph: "◆" }, // blue
  { bg: "#d89e00", glyph: "●" }, // yellow
  { bg: "#26890c", glyph: "■" }, // green
];

function Scoreboard() {
  const players = useTriviaStore((s) => s.players);
  const you = useTriviaStore((s) => s.you);
  const phase = useTriviaStore((s) => s.phase);
  const correctIds = useTriviaStore((s) => s.correctIds);
  return (
    <div className="score-list">
      {players.map((p, i) => (
        <div key={p.id} className={`score-item${p.id === you ? " score-item--active" : ""}`}>
          <span className="score-rank">{i + 1}</span>
          <span className="avatar" style={{ width: 24, height: 24, fontSize: 10, background: p.color }}>{p.name.slice(0, 2).toUpperCase()}</span>
          <span className={`score-name${p.id === you ? " score-name--me" : ""} ellip`}>{p.name}{p.id === you ? " (you)" : ""}</span>
          {phase === "reveal" && correctIds.includes(p.id) && <span className="score-badge score-badge--ok">✓</span>}
          {phase === "question" && p.answered && <span className="score-badge score-badge--ok">✓</span>}
          <span className="score-pts">{p.score}</span>
        </div>
      ))}
    </div>
  );
}

/* ---------- the question + 2×2 answer grid ---------- */
function QuestionArea() {
  const phase = useTriviaStore((s) => s.phase);
  const question = useTriviaStore((s) => s.question);
  const options = useTriviaStore((s) => s.options);
  const myChoice = useTriviaStore((s) => s.myChoice);
  const answer = useTriviaStore((s) => s.answer);
  const revealing = phase === "reveal";

  return (
    <div className="trivia-area">
      <div className="trivia-question">{question || "…"}</div>

      <div className="trivia-grid">
        {options.map((opt, i) => {
          const st = OPTION_STYLES[i] ?? OPTION_STYLES[0];
          const isMine = myChoice === i;
          const isAnswer = revealing && answer === i;
          const isWrongMine = revealing && isMine && answer !== i;
          const dim = revealing && !isAnswer && !isMine;
          let bg = st.bg;
          if (isAnswer) bg = "var(--ok)";
          else if (isWrongMine) bg = "var(--danger)";
          const locked = myChoice !== null || phase !== "question";
          const cls = `trivia-opt${isMine ? " trivia-opt--mine" : ""}${dim ? " trivia-opt--dim" : ""}`;
          return (
            <button key={i} disabled={locked} onClick={() => triviaActions.answer(i)} className={cls} style={{ background: bg }}>
              <span className="trivia-opt__glyph">{st.glyph}</span>
              <span className="trivia-opt__label">{opt}</span>
              {isAnswer && <span style={{ fontSize: 22 }}>✓</span>}
              {isWrongMine && <span style={{ fontSize: 22 }}>✕</span>}
            </button>
          );
        })}
      </div>

      <div className="trivia-status">
        {revealing
          ? (answer !== null && myChoice === answer
              ? <b style={{ color: "var(--ok)" }}>Correct! 🎉</b>
              : myChoice !== null
                ? <b style={{ color: "var(--danger)" }}>Not quite 😅</b>
                : "Time's up — the correct answer is highlighted in green.")
          : myChoice !== null
            ? <b style={{ color: "var(--accent)" }}>✓ Locked in — waiting for others…</b>
            : "Pick the answer you think is correct!"}
      </div>
    </div>
  );
}

const HOW_TO = [
  "Each question has 4 options — you can pick only ONE.",
  "The faster and more accurate you are, the higher your score (500 + speed bonus).",
  "You can't change your answer once picked — choose carefully!",
  "After the last question → a final leaderboard.",
];

/** Lobby / how-to / config (before the game and between games). */
function Lobby({ over }: { over: boolean }) {
  const players = useTriviaStore((s) => s.players);
  const connected = useTriviaStore((s) => s.connected);
  const finalScores = useTriviaStore((s) => s.finalScores);
  const [secs, setSecs] = useState(20);
  const [questions, setQuestions] = useState(5);

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
            <div className="game-modal__title"><GameDoodle kind="trivia" size={22} /> Team Trivia</div>
            <div className="how-to">
              <div className="how-to__title">How to play</div>
              <ol>{HOW_TO.map((h, i) => <li key={i}>{h}</li>)}</ol>
            </div>
          </>
        )}

        <div className="game-config">
          <label className="game-config__field">
            <span>Seconds / question</span>
            <select className="text-input" value={secs} onChange={(e) => setSecs(+e.target.value)}>
              {[10, 15, 20, 30].map((v) => <option key={v} value={v}>{v}s</option>)}
            </select>
          </label>
          <label className="game-config__field">
            <span>Number of questions</span>
            <select className="text-input" value={questions} onChange={(e) => setQuestions(+e.target.value)}>
              {[5, 10].map((v) => <option key={v} value={v}>{v} questions</option>)}
            </select>
          </label>
        </div>

        <div className="game-lobby__status">
          {connected ? `${players.length} in the room` : "Connecting…"} · needs ≥ 2 players
        </div>
        <button className="btn btn-primary btn-block" disabled={players.length < 2} onClick={() => triviaActions.start(secs, questions)}>
          {over ? "Play again" : "Start"} →
        </button>
      </div>
    </div>
  );
}

export function TriviaRoom({ roomId }: { roomId: string }) {
  const go = useAppStore((s) => s.go);
  const setDashPage = useAppStore((s) => s.setDashPage);
  const phase = useTriviaStore((s) => s.phase);
  const qIndex = useTriviaStore((s) => s.qIndex);
  const totalQ = useTriviaStore((s) => s.totalQ);
  const timeLeft = useTriviaStore((s) => s.timeLeft);
  const players = useTriviaStore((s) => s.players);
  const hostToken = useTriviaStore((s) => s.hostToken);
  const killed = useTriviaStore((s) => s.killed);
  const [named, setNamed] = useState(hasGuestName());

  useEffect(() => {
    if (!named) return;
    connectTrivia(roomId);
    return () => disconnectTrivia();
  }, [roomId, named]);

  const leave = () => { disconnectTrivia(); go("dashboard"); setDashPage("games"); };

  if (!named) return <NameGate kind="trivia" onDone={() => setNamed(true)} />;
  if (killed) return <KilledNotice onLeave={leave} />;

  const inRound = phase === "question" || phase === "reveal";

  const center = inRound ? (
    <>
      <span className="pill pill-accent">Question {qIndex + 1}/{totalQ}</span>
      <div style={{ flex: 1 }} />
      <span className={`game-timer${timeLeft <= 5 && phase === "question" ? " game-timer--danger" : ""}`}>⏱ {timeLeft}s</span>
    </>
  ) : undefined;

  return (
    <div className="game-screen">
      <RoomTopbar
        kind="trivia"
        title="Team Trivia"
        roomId={roomId}
        players={players}
        hostToken={hostToken}
        onLeave={leave}
        center={center}
      />

      <div className="game-body">
        <div className="game-stage">
          {inRound ? <QuestionArea /> : <div style={{ flex: 1 }} />}
          {(phase === "lobby" || phase === "over") && <Lobby over={phase === "over"} />}
        </div>

        <div className="game-rail">
          <div className="game-rail__title">Scoreboard</div>
          <Scoreboard />
        </div>
      </div>
    </div>
  );
}
