/**
 * features/games/GamesView — the "Team play" hub (a dashboard page).
 *
 * A small catalog of quick multiplayer games the team can jump into over
 * WebSocket: Draw & Guess, Team Trivia, Word Bomb. "Create room" mints a room
 * id and opens the game; "Join by code / link" joins an existing room (OPEN to
 * everyone, guests included — that's intended for party games). Below the
 * catalog: the live "playing now" panel and the cross-game leaderboard.
 */
import { useEffect, useState } from "react";
import { useAppStore } from "../../state/appStore";
import { Icon } from "../../shared/ui";
import { api, type ActiveRoom, type LeaderboardRow } from "../../shared/api/client";
import { GameDoodle, type GameKind } from "./GameDoodles";

/** 12-hex room id (matches the backend `^[0-9a-f]{12}$` guard). */
function newRoomId(): string {
  const hex = "0123456789abcdef";
  let s = "";
  const rnd =
    typeof crypto !== "undefined" && crypto.getRandomValues
      ? Array.from(crypto.getRandomValues(new Uint8Array(12)))
      : Array.from({ length: 12 }, () => Math.floor(Math.random() * 256));
  for (const b of rnd) s += hex[b & 15];
  return s;
}

interface GameDef {
  id: string;
  title: string;
  tagline: string;
  kind: GameKind;
  players: string;
  accent: string;
  soft: string;
}

const CATALOG: GameDef[] = [
  {
    id: "draw-guess",
    title: "Draw & Guess",
    tagline: "One player sketches a secret word while the team races to guess it in chat. Guess fast — score high!",
    kind: "draw",
    players: "2–12 players",
    accent: "#2563eb",
    soft: "#eef4ff",
  },
  {
    id: "trivia",
    title: "Team Trivia",
    tagline: "A round-based quiz showdown — lock in the right answer faster than everyone else to win the round.",
    kind: "trivia",
    players: "2–12 players",
    accent: "#7c3aed",
    soft: "#f4f0ff",
  },
  {
    id: "wordbomb",
    title: "Word Bomb",
    tagline: "Type a word containing the given fragment before the bomb blows. Lose all your lives and you're out!",
    kind: "wordbomb",
    players: "2–8 players",
    accent: "#dc2626",
    soft: "#fef2f2",
  },
];

/** English phase label for an active room (covers all 3 games). */
function phaseLabel(r: ActiveRoom): string {
  switch (r.phase) {
    case "draw":
    case "question":
      return r.totalTurns ? `Playing · turn ${r.turn}/${r.totalTurns}` : "Playing";
    case "play":
      return "Playing";
    case "reveal":
      return "Revealing";
    case "over":
      return "Finished";
    default:
      return "Waiting room";
  }
}

function ActiveSessions() {
  const [data, setData] = useState<{ rooms: ActiveRoom[]; totalUsers: number } | null>(null);
  // Ops admin mode: the admin key (kept in localStorage) unlocks a force-close
  // override on ANY room. Off by default; hosts close their own rooms in-game.
  const [adminKey, setAdminKey] = useState<string>(() => localStorage.getItem("noddle-admin-key") ?? "");
  const [adminOpen, setAdminOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = () => void api.gameActive().then(setData).catch(() => {});
  useEffect(() => {
    let alive = true;
    const tick = () =>
      void api
        .gameActive()
        .then((d) => { if (alive) setData(d); })
        .catch(() => { if (alive) setData({ rooms: [], totalUsers: 0 }); });
    tick();
    const iv = setInterval(tick, 4000);
    return () => { alive = false; clearInterval(iv); };
  }, []);

  const closeRoom = async (id: string) => {
    if (!adminKey || !window.confirm("Force-close this room? Everyone will be disconnected.")) return;
    setBusy(id);
    try {
      await api.closeGameRoom(id, { adminKey });
      refresh();
    } catch {
      alert("Couldn't close the room — check your admin key.");
    } finally {
      setBusy(null);
    }
  };
  const saveKey = (k: string) => {
    setAdminKey(k);
    if (k) localStorage.setItem("noddle-admin-key", k);
    else localStorage.removeItem("noddle-admin-key");
  };

  const rooms = data?.rooms ?? [];
  const isAdmin = !!adminKey;

  return (
    <div className="games-panel">
      <div className="games-panel__head">
        <span className="live-dot" />
        Playing now
        <span className="games-panel__count">
          {rooms.length ? `${data?.totalUsers ?? 0} online · ${rooms.length} rooms` : "no live rooms"}
        </span>
      </div>
      {rooms.length === 0 ? (
        <div className="games-panel__empty">No games running right now — start one above!</div>
      ) : (
        rooms.map((r) => (
          <div key={r.id} className="room-item">
            <GameDoodle kind={r.type} size={22} />
            <div className="room-item__info">
              <div className="room-item__name ellip">{r.game}</div>
              <div className="room-item__sub">{phaseLabel(r)}</div>
            </div>
            <span className="room-item__count">
              <Icon name="game" size={11} /> {r.players}
            </span>
            {isAdmin && (
              <button className="btn btn-danger" style={{ fontSize: 12, padding: "5px 10px" }} disabled={busy === r.id} onClick={() => void closeRoom(r.id)}>
                Close
              </button>
            )}
            <button className="btn btn-primary" style={{ fontSize: 12.5, padding: "5px 12px" }} onClick={() => useAppStore.getState().openGame(r.id, r.type)}>
              Join
            </button>
          </div>
        ))
      )}
      <div className="games-admin" style={{ margin: "0", padding: "10px 14px", borderTop: "1px solid var(--border-faint)" }}>
        <button className="btn btn-ghost games-admin__toggle" onClick={() => setAdminOpen((v) => !v)}>
          <Icon name="settings" size={12} /> {isAdmin ? "Ops admin: on" : "Ops admin"}
        </button>
        {adminOpen && (
          <div className="games-admin__row">
            <input className="text-input" style={{ flex: 1 }} type="password" placeholder="Admin key (blank = off)…" value={adminKey} onChange={(e) => saveKey(e.target.value)} />
          </div>
        )}
      </div>
    </div>
  );
}

function Leaderboard() {
  const [rows, setRows] = useState<LeaderboardRow[] | null>(null);
  useEffect(() => {
    void api.gameLeaderboard().then(setRows).catch(() => setRows([]));
  }, []);
  return (
    <div className="games-panel">
      <div className="games-panel__head">
        <GameDoodle kind="trophy" size={18} /> Leaderboard
        {rows && rows.length > 0 && <span className="games-panel__count">top {rows.length}</span>}
      </div>
      {!rows || rows.length === 0 ? (
        <div className="games-panel__empty">Play a game to get on the board!</div>
      ) : (
        rows.map((r, i) => (
          <div key={r.name} className="lb-item">
            <span className={`lb-rank${i < 3 ? ` lb-rank--${i + 1}` : ""}`}>{i + 1}</span>
            <span className="avatar" style={{ width: 26, height: 26, fontSize: 10, background: r.color }}>{r.name.slice(0, 2).toUpperCase()}</span>
            <span className="lb-name ellip">{r.name}</span>
            <span className="lb-stat">{r.wins} wins · {r.games} games</span>
            <span className="lb-points">{r.points} pts</span>
          </div>
        ))
      )}
    </div>
  );
}

export function GamesView() {
  const openGame = useAppStore((s) => s.openGame);
  const [joinCode, setJoinCode] = useState("");

  const play = (g: GameDef) => openGame(newRoomId(), g.kind);

  const join = () => {
    const raw = joinCode.trim().toLowerCase();
    // Accept a raw id, or a pasted /play/{id} or /play/{trivia|wordbomb}/{id} link.
    const typed = raw.match(/\/play\/(trivia|wordbomb)\/([0-9a-f]{12})/);
    if (typed) {
      openGame(typed[2], typed[1] as GameKind);
      return;
    }
    const m = raw.match(/([0-9a-f]{12})/);
    if (m) openGame(m[1]);
  };

  return (
    <div className="games-hub">
      <p className="games-hub__intro">
        Quick real-time games to warm up a meeting or celebrate a launch. Create a room and share the
        link — anyone with the link can join, no account needed. Whoever creates a room is its host and
        can close it any time.
      </p>

      <div className="game-cards">
        {CATALOG.map((g) => (
          <button key={g.id} className="game-card" onClick={() => play(g)}>
            <div className="game-card__art" style={{ background: g.soft }}>
              <GameDoodle kind={g.kind} size={52} accent={g.accent} />
            </div>
            <div className="game-card__body">
              <div className="game-card__title">
                {g.title}
                <span className="pill pill-accent" style={{ fontSize: 10 }}>Play now</span>
              </div>
              <div className="game-card__desc">{g.tagline}</div>
              <div className="game-card__meta">
                <Icon name="game" size={13} /> {g.players}
              </div>
            </div>
          </button>
        ))}
      </div>

      <div className="games-bar">
        <div className="games-join">
          <div className="games-join__label">Join a room by code or link</div>
          <div className="games-join__row">
            <input
              className="text-input"
              style={{ flex: 1 }}
              placeholder="Paste a room code or /play/… link"
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") join(); }}
            />
            <button className="btn btn-primary" disabled={!joinCode.trim()} onClick={join}>Join</button>
          </div>
        </div>
      </div>

      <div className="games-columns">
        <ActiveSessions />
        <Leaderboard />
      </div>
    </div>
  );
}
