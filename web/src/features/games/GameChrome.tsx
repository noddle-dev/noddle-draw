/**
 * features/games/GameChrome — shared UI for the three live game ROOM screens
 * (Draw & Guess / Trivia / Word Bomb). Consolidates the bits every room needs
 * so they look and behave identically:
 *   - NameGate      : the display-name prompt shown before joining (guests OK).
 *   - RoomTopbar    : game title + copyable room code + presence + a HOST-only
 *                     "Close room" button + a slot for per-game turn/timer state.
 *   - KilledNotice  : the overlay shown when the room is force-closed.
 *
 * Host control: the server hands the room CREATOR a one-time host token on join
 * (see backend api/games.py `assign_host`). Only a non-empty `hostToken` shows
 * the "Close room" control — normal players never receive one, so they can't.
 */
import { useState, type ReactNode } from "react";
import { Icon } from "../../shared/ui";
import { GameDoodle, type GameKind } from "./GameDoodles";
import { api } from "../../shared/api/client";
import { getIdentity, hasGuestName, setGuestName } from "../../state/collabStore";

/** Minimal shape the presence stack needs (all three player types satisfy it). */
export interface PresencePlayer {
  id: number;
  name: string;
  color: string;
}

/** Overlapping avatar stack of everyone currently in the room. */
export function PresenceStack({ players, max = 5 }: { players: PresencePlayer[]; max?: number }) {
  const shown = players.slice(0, max);
  const extra = players.length - shown.length;
  return (
    <div className="game-presence" title={players.map((p) => p.name).join(", ")}>
      {shown.map((p) => (
        <span key={p.id} className="game-presence__avatar" style={{ background: p.color }}>
          {p.name.slice(0, 2)}
        </span>
      ))}
      {extra > 0 && <span className="game-presence__more">+{extra}</span>}
    </div>
  );
}

/** Copyable room-code chip → copies the shareable /play link to the clipboard. */
export function RoomCode({ roomId, gameType }: { roomId: string; gameType: GameKind }) {
  const [copied, setCopied] = useState(false);
  const shareUrl =
    gameType === "draw"
      ? `${location.origin}/play/${roomId}`
      : `${location.origin}/play/${gameType}/${roomId}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — no-op */
    }
  };
  return (
    <span className="game-code">
      <span className="game-code__value">{roomId.slice(0, 6)}</span>
      <button className="btn btn-primary game-code__btn" onClick={copy}>
        <Icon name="share" size={13} /> {copied ? "Copied!" : "Invite"}
      </button>
    </span>
  );
}

/** HOST-only close-room button (hidden entirely when the user isn't the host). */
export function HostCloseButton({
  roomId,
  hostToken,
  onClosed,
}: {
  roomId: string;
  hostToken: string;
  onClosed: () => void;
}) {
  const [busy, setBusy] = useState(false);
  if (!hostToken) return null;
  const close = async () => {
    if (!window.confirm("Close this room? Everyone will be disconnected.")) return;
    setBusy(true);
    try {
      await api.closeGameRoom(roomId, { hostToken });
      onClosed();
    } catch {
      alert("Couldn't close the room. Please try again.");
      setBusy(false);
    }
  };
  return (
    <button className="btn btn-danger game-code__btn" disabled={busy} onClick={close}>
      <Icon name="trash" size={13} /> Close room
    </button>
  );
}

/** The consistent room header used by all three games. */
export function RoomTopbar({
  kind,
  title,
  roomId,
  players,
  hostToken,
  onLeave,
  center,
}: {
  kind: GameKind;
  title: string;
  roomId: string;
  players: PresencePlayer[];
  hostToken: string;
  onLeave: () => void;
  /** Per-game middle content (turn pill, word tiles, timer). */
  center?: ReactNode;
}) {
  return (
    <div className="game-topbar">
      <button className="btn btn-ghost" onClick={onLeave} style={{ gap: 5 }}>
        <Icon name="back" size={16} /> Exit
      </button>
      <div className="game-topbar__title">
        <GameDoodle kind={kind} size={18} /> {title}
      </div>
      {center ?? <div className="game-spacer" />}
      <PresenceStack players={players} />
      <RoomCode roomId={roomId} gameType={kind} />
      <HostCloseButton roomId={roomId} hostToken={hostToken} onClosed={onLeave} />
    </div>
  );
}

/** Name gate: guests pick a display name before joining (never gated on login). */
export function NameGate({ kind, onDone }: { kind: GameKind; onDone: () => void }) {
  const [name, setName] = useState(hasGuestName() ? getIdentity().name : "");
  const submit = () => {
    const n = name.trim();
    if (!n) return;
    setGuestName(n);
    onDone();
  };
  return (
    <div className="gen-overlay">
      <div className="gen-modal" style={{ width: 380, textAlign: "left" }} onClick={(e) => e.stopPropagation()}>
        <div className="t" style={{ marginBottom: 4 }}>
          <GameDoodle kind={kind} size={17} /> Join game room
        </div>
        <p style={{ color: "var(--muted)", fontSize: 13, margin: "0 0 14px" }}>
          Pick a display name so the team knows who you are.
        </p>
        <input
          className="text-input"
          style={{ width: "100%", marginBottom: 12 }}
          autoFocus
          placeholder="Your name (e.g. Alex)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
        <button className="btn btn-primary btn-block" disabled={!name.trim()} onClick={submit}>
          Join room →
        </button>
      </div>
    </div>
  );
}

/** Full-screen notice shown when the room is force-closed by its host/admin. */
export function KilledNotice({ onLeave }: { onLeave: () => void }) {
  return (
    <div className="gen-overlay">
      <div className="gen-modal" style={{ width: 360, textAlign: "center" }}>
        <div style={{ marginBottom: 8 }}>
          <GameDoodle kind="controller" size={40} accent="var(--muted)" />
        </div>
        <div className="t" style={{ marginBottom: 4 }}>
          This room has been closed
        </div>
        <p style={{ color: "var(--muted)", fontSize: 13, margin: "0 0 16px" }}>
          The room host ended this game session.
        </p>
        <button className="btn btn-primary btn-block" onClick={onLeave}>
          Back to Team play
        </button>
      </div>
    </div>
  );
}
