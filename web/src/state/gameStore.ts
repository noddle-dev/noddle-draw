/**
 * state/gameStore — client for the real-time "Draw & Guess" game
 * (WebSocket `/ws/games/{roomId}`). The SERVER is authoritative (word, timer,
 * scores, who guessed); this store just mirrors the state it pushes and sends
 * the local player's actions (start / stroke / clear / guess). Identity (name +
 * color) is reused from the collab identity so it matches the rest of the app.
 */
import { create } from "zustand";
import { getIdentity } from "./collabStore";

export interface GamePlayer {
  id: number;
  name: string;
  color: string;
  score: number;
  guessed: boolean;
}

/** A freehand stroke on the shared 900×600 board. */
export interface GameStroke {
  id: string;
  color: string;
  width: number;
  points: [number, number][];
}

export interface ChatLine {
  id: number; // SERVER id (stable) — reactions target it
  kind: "guess" | "system" | "correct" | "ai";
  name: string;
  color: string;
  text: string;
  reactions?: Record<string, string[]>; // emoji → names who reacted
}

/** Emoji available for chat reactions (must match the backend whitelist). */
export const REACT_EMOJI = ["👍", "😂", "🎉", "🔥", "❤️", "😮"];

type Phase = "lobby" | "draw" | "reveal" | "over";

interface GameState {
  connected: boolean;
  you: number | null;
  phase: Phase;
  turn: number;
  totalTurns: number;
  drawerId: number | null;
  timeLeft: number;
  hint: string;
  wordLen: number;
  word: string; // known only to the drawer (server sends it privately)
  winner: string; // who guessed the current word first (reveal phase)
  players: GamePlayer[];
  strokes: GameStroke[]; // current turn's drawing (drawer + relayed)
  chat: ChatLine[];
  finalScores: GamePlayer[] | null;
  isDrawer: boolean;
  /** Set when the room is force-closed (client shows a notice + leaves). */
  killed: boolean;
  /** One-time host token — non-empty ONLY for the room creator (host). Its
   *  presence is what gates the "Close room" control. */
  hostToken: string;
}

const initial: GameState = {
  connected: false,
  you: null,
  phase: "lobby",
  turn: 0,
  totalTurns: 0,
  drawerId: null,
  timeLeft: 0,
  hint: "",
  wordLen: 0,
  word: "",
  winner: "",
  players: [],
  strokes: [],
  chat: [],
  finalScores: null,
  isDrawer: false,
  killed: false,
  hostToken: "",
};

export const useGameStore = create<GameState>(() => ({ ...initial }));

let ws: WebSocket | null = null;
let chatSeq = 0;

function wsUrl(roomId: string): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws/games/${roomId}`;
}

function send(payload: object): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

export function connectGame(roomId: string): void {
  disconnectGame();
  useGameStore.setState({ ...initial });
  const socket = new WebSocket(wsUrl(roomId));
  ws = socket;
  socket.onopen = () => {
    useGameStore.setState({ connected: true });
    send({ t: "hello", ...getIdentity() });
  };
  socket.onclose = () => {
    if (ws === socket) useGameStore.setState({ connected: false });
  };
  socket.onmessage = (ev) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    const s = useGameStore.getState();
    switch (msg.t) {
      case "state": {
        const you = (msg.you as number) ?? s.you;
        const drawerId = (msg.drawerId as number | null) ?? null;
        useGameStore.setState({
          you,
          phase: msg.phase as Phase,
          turn: (msg.turn as number) ?? 0,
          totalTurns: (msg.totalTurns as number) ?? 0,
          drawerId,
          timeLeft: (msg.timeLeft as number) ?? 0,
          hint: (msg.hint as string) ?? "",
          wordLen: (msg.wordLen as number) ?? 0,
          winner: (msg.winner as string) ?? "",
          players: (msg.players as GamePlayer[]) ?? [],
          isDrawer: you != null && you === drawerId,
          // A new turn (word cleared) resets our private word until we're told.
          word: msg.phase === "draw" && you === drawerId ? s.word : msg.phase === "draw" ? "" : s.word,
        });
        break;
      }
      case "word":
        useGameStore.setState({ word: (msg.word as string) ?? "" });
        break;
      case "chatlog": {
        const lines = (msg.lines as ChatLine[]) ?? [];
        useGameStore.setState({ chat: lines });
        break;
      }
      case "react": {
        const id = msg.id as number;
        const reactions = (msg.reactions as Record<string, string[]>) ?? {};
        useGameStore.setState((st) => ({
          chat: st.chat.map((l) => (l.id === id ? { ...l, reactions } : l)),
        }));
        break;
      }
      case "stroke": {
        const stroke = msg.stroke as GameStroke;
        if (!stroke || !stroke.id) break;
        useGameStore.setState((st) => {
          const i = st.strokes.findIndex((x) => x.id === stroke.id);
          const strokes = i >= 0 ? st.strokes.slice() : [...st.strokes, stroke];
          if (i >= 0) strokes[i] = stroke;
          return { strokes };
        });
        break;
      }
      case "clear":
        useGameStore.setState({ strokes: [] });
        break;
      case "chat": {
        const line: ChatLine = {
          id: (msg.id as number) ?? ++chatSeq,
          kind: (msg.kind as ChatLine["kind"]) ?? "guess",
          name: (msg.name as string) ?? "",
          color: (msg.color as string) ?? "#888",
          text: (msg.text as string) ?? "",
          reactions: (msg.reactions as Record<string, string[]>) ?? {},
        };
        useGameStore.setState((st) => ({ chat: [...st.chat, line].slice(-120) }));
        break;
      }
      case "turnEnd": {
        const w = (msg.word as string) ?? "";
        useGameStore.setState({ word: w, winner: (msg.winner as string) ?? "" });
        break;
      }
      case "gameOver":
        useGameStore.setState({ finalScores: (msg.scores as GamePlayer[]) ?? [], phase: "over" });
        break;
      case "host":
        useGameStore.setState({ hostToken: (msg.token as string) ?? "" });
        break;
      case "killed":
        useGameStore.setState({ killed: true });
        break;
    }
  };
}

export function disconnectGame(): void {
  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
  }
  useGameStore.setState({ connected: false });
}

export const gameActions = {
  start: (secs = 60, rounds = 1) => send({ t: "start", secs, rounds }),
  clear: () => {
    useGameStore.setState({ strokes: [] });
    send({ t: "clear" });
  },
  guess: (text: string) => send({ t: "guess", text }),
  react: (id: number, emoji: string) => send({ t: "react", id, emoji }),
  /** Push (or update) one of MY strokes and broadcast it. */
  sendStroke: (stroke: GameStroke) => {
    useGameStore.setState((st) => {
      const i = st.strokes.findIndex((x) => x.id === stroke.id);
      const strokes = i >= 0 ? st.strokes.slice() : [...st.strokes, stroke];
      if (i >= 0) strokes[i] = stroke;
      return { strokes };
    });
    send({ t: "stroke", stroke });
  },
};
