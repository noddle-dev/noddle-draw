/**
 * state/wordBombStore — client for the real-time "Word Bomb" game
 * (WebSocket `/ws/wordbomb/{roomId}`). The SERVER is authoritative (fragment,
 * timer, whose turn, lives, used-words, elimination, winner); this store just
 * mirrors the state it pushes and sends the local player's actions (start /
 * submit). Identity (name + color) is reused from the collab identity so it
 * matches the rest of the app.
 */
import { create } from "zustand";
import { getIdentity } from "./collabStore";

export interface WBPlayer {
  id: number;
  name: string;
  color: string;
  lives: number;
  score: number;
  alive: boolean;
}

/** One line in the live feed (accepted words, misses, system notices). */
export interface WBFeedLine {
  id: number; // local sequence — for React keys only
  text: string;
  kind: "feed" | "accepted" | "miss";
}

type Phase = "lobby" | "play" | "over";

interface WBState {
  connected: boolean;
  you: number | null;
  phase: Phase;
  fragment: string;
  timeLeft: number;
  activeId: number | null;
  players: WBPlayer[];
  feed: WBFeedLine[];
  winner: string; // set at game over
  finalScores: WBPlayer[] | null;
  /** Last invalid-submit reason (shown to the sender, then cleared). */
  invalidReason: string;
  isMyTurn: boolean;
  /** Set when the room is force-closed. */
  killed: boolean;
  /** One-time host token — non-empty ONLY for the room creator (host). */
  hostToken: string;
}

const initial: WBState = {
  connected: false,
  you: null,
  phase: "lobby",
  fragment: "",
  timeLeft: 0,
  activeId: null,
  players: [],
  feed: [],
  winner: "",
  finalScores: null,
  invalidReason: "",
  isMyTurn: false,
  killed: false,
  hostToken: "",
};

export const useWordBombStore = create<WBState>(() => ({ ...initial }));

let ws: WebSocket | null = null;
let feedSeq = 0;

function wsUrl(roomId: string): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws/wordbomb/${roomId}`;
}

function send(payload: object): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function pushFeed(text: string, kind: WBFeedLine["kind"]): void {
  const line: WBFeedLine = { id: ++feedSeq, text, kind };
  useWordBombStore.setState((st) => ({ feed: [...st.feed, line].slice(-40) }));
}

export function connectWordBomb(roomId: string): void {
  disconnectWordBomb();
  useWordBombStore.setState({ ...initial });
  const socket = new WebSocket(wsUrl(roomId));
  ws = socket;
  socket.onopen = () => {
    useWordBombStore.setState({ connected: true });
    send({ t: "hello", ...getIdentity() });
  };
  socket.onclose = () => {
    if (ws === socket) useWordBombStore.setState({ connected: false });
  };
  socket.onmessage = (ev) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    const s = useWordBombStore.getState();
    switch (msg.t) {
      case "state": {
        const you = (msg.you as number) ?? s.you;
        const activeId = (msg.activeId as number | null) ?? null;
        useWordBombStore.setState({
          you,
          phase: msg.phase as Phase,
          fragment: (msg.fragment as string) ?? "",
          timeLeft: (msg.timeLeft as number) ?? 0,
          activeId,
          players: (msg.players as WBPlayer[]) ?? [],
          isMyTurn: you != null && you === activeId && msg.phase === "play",
        });
        break;
      }
      case "accepted": {
        const word = (msg.word as string) ?? "";
        const id = msg.id as number;
        const p = s.players.find((x) => x.id === id);
        pushFeed(`✅ ${p ? p.name : "?"}: "${word}"`, "accepted");
        // A fresh valid word clears any lingering invalid notice.
        useWordBombStore.setState({ invalidReason: "" });
        break;
      }
      case "miss": {
        const id = msg.id as number;
        const p = s.players.find((x) => x.id === id);
        pushFeed(`💥 Boom! ${p ? p.name : "?"} lost a life.`, "miss");
        break;
      }
      case "feed":
        pushFeed((msg.text as string) ?? "", "feed");
        break;
      case "invalid":
        useWordBombStore.setState({ invalidReason: (msg.reason as string) ?? "Invalid word." });
        break;
      case "gameOver":
        useWordBombStore.setState({
          phase: "over",
          winner: (msg.winner as string) ?? "",
          finalScores: (msg.scores as WBPlayer[]) ?? [],
          activeId: null,
          fragment: "",
          isMyTurn: false,
        });
        break;
      case "host":
        useWordBombStore.setState({ hostToken: (msg.token as string) ?? "" });
        break;
      case "killed":
        useWordBombStore.setState({ killed: true });
        break;
    }
  };
}

export function disconnectWordBomb(): void {
  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
  }
  useWordBombStore.setState({ connected: false });
}

export const wordBombActions = {
  start: (secs = 8, lives = 3) => send({ t: "start", secs, lives }),
  submit: (word: string) => {
    // Clear the previous invalid notice so a new attempt starts fresh.
    useWordBombStore.setState({ invalidReason: "" });
    send({ t: "submit", word });
  },
};
