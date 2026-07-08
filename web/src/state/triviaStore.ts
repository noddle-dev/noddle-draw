/**
 * state/triviaStore — client for the real-time "Team Trivia" game (Kahoot-lite)
 * over WebSocket `/ws/trivia/{roomId}`. Mirrors `gameStore.ts`. The SERVER is
 * authoritative (question bank, correct answer, timer, scores); this store just
 * mirrors what it pushes and sends the local player's actions (start / answer).
 * The correct answer index is NOT known until the server's `reveal` message.
 * Identity (name + color) is reused from the collab identity.
 */
import { create } from "zustand";
import { getIdentity } from "./collabStore";

export interface TriviaPlayer {
  id: number;
  name: string;
  color: string;
  score: number;
  answered: boolean;
}

type Phase = "lobby" | "question" | "reveal" | "over";

interface TriviaState {
  connected: boolean;
  you: number | null;
  phase: Phase;
  qIndex: number;
  totalQ: number;
  timeLeft: number;
  question: string;
  options: string[];
  players: TriviaPlayer[];
  /** MY locked choice for the current question (null = not answered). */
  myChoice: number | null;
  /** Correct option index — only set during the reveal phase (else null). */
  answer: number | null;
  /** ids of players who got the current question right (reveal phase). */
  correctIds: number[];
  /** Every player's pick for the current question, keyed by id (reveal). */
  picks: Record<number, number | null>;
  finalScores: TriviaPlayer[] | null;
  /** Set when the room is force-closed (client shows a notice + leaves). */
  killed: boolean;
  /** One-time host token — non-empty ONLY for the room creator (host). */
  hostToken: string;
}

const initial: TriviaState = {
  connected: false,
  you: null,
  phase: "lobby",
  qIndex: 0,
  totalQ: 0,
  timeLeft: 0,
  question: "",
  options: [],
  players: [],
  myChoice: null,
  answer: null,
  correctIds: [],
  picks: {},
  finalScores: null,
  killed: false,
  hostToken: "",
};

export const useTriviaStore = create<TriviaState>(() => ({ ...initial }));

let ws: WebSocket | null = null;

function wsUrl(roomId: string): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws/trivia/${roomId}`;
}

function send(payload: object): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

export function connectTrivia(roomId: string): void {
  disconnectTrivia();
  useTriviaStore.setState({ ...initial });
  const socket = new WebSocket(wsUrl(roomId));
  ws = socket;
  socket.onopen = () => {
    useTriviaStore.setState({ connected: true });
    send({ t: "hello", ...getIdentity() });
  };
  socket.onclose = () => {
    if (ws === socket) useTriviaStore.setState({ connected: false });
  };
  socket.onmessage = (ev) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    const s = useTriviaStore.getState();
    switch (msg.t) {
      case "state": {
        const you = (msg.you as number) ?? s.you;
        const phase = msg.phase as Phase;
        // A fresh question clears my local pick + any prior reveal data.
        const isNewQuestion = phase === "question" && (msg.qIndex as number) !== s.qIndex;
        const enteringQuestion = phase === "question" && s.phase !== "question";
        const reset = isNewQuestion || enteringQuestion;
        useTriviaStore.setState({
          you,
          phase,
          qIndex: (msg.qIndex as number) ?? 0,
          totalQ: (msg.totalQ as number) ?? 0,
          timeLeft: (msg.timeLeft as number) ?? 0,
          question: (msg.question as string) ?? "",
          options: (msg.options as string[]) ?? [],
          players: (msg.players as TriviaPlayer[]) ?? [],
          ...(reset ? { myChoice: null, answer: null, correctIds: [], picks: {} } : {}),
        });
        break;
      }
      case "reveal": {
        const picksRaw = (msg.picks as Record<string, number | null>) ?? {};
        const picks: Record<number, number | null> = {};
        for (const k of Object.keys(picksRaw)) picks[Number(k)] = picksRaw[k];
        useTriviaStore.setState({
          answer: (msg.answer as number) ?? null,
          correctIds: (msg.correct as number[]) ?? [],
          picks,
          players: ((msg.scores as TriviaPlayer[]) ?? s.players).map((sc) => ({
            ...sc,
            answered: true,
          })),
        });
        break;
      }
      case "gameOver":
        useTriviaStore.setState({
          finalScores: (msg.scores as TriviaPlayer[]) ?? [],
          phase: "over",
        });
        break;
      case "host":
        useTriviaStore.setState({ hostToken: (msg.token as string) ?? "" });
        break;
      case "killed":
        useTriviaStore.setState({ killed: true });
        break;
    }
  };
}

export function disconnectTrivia(): void {
  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
  }
  useTriviaStore.setState({ connected: false });
}

export const triviaActions = {
  start: (secs = 20, questions = 5) => send({ t: "start", secs, questions }),
  answer: (choice: number) => {
    const s = useTriviaStore.getState();
    if (s.phase !== "question" || s.myChoice !== null) return;
    useTriviaStore.setState({ myChoice: choice }); // optimistic lock (server is authoritative)
    send({ t: "answer", choice });
  },
};
