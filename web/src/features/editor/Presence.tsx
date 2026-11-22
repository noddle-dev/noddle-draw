/**
 * features/editor/Presence — avatars of everyone in the live-collab room,
 * plus AI-Noddle as a permanent co-editor (pulses while it edits).
 */
import { useCollabStore, getIdentity, type Peer } from "../../state/collabStore";
import { useAppStore } from "../../state/appStore";

/** Claude's starburst mark — shown for MCP agents the server tags icon="claude". */
function ClaudeMark() {
  const rays = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];
  return (
    <svg viewBox="-12 -12 24 24" width="18" height="18" aria-hidden="true">
      {rays.map((deg, i) => (
        <line key={deg} x1="0" y1="0" x2="0" y2={i % 2 ? -8 : -10.5}
          transform={`rotate(${deg})`} stroke="#d97757" strokeWidth="2.6" strokeLinecap="round" />
      ))}
    </svg>
  );
}

function isClaude(p: Peer) {
  return p.kind === "agent" && p.icon === "claude";
}

/** The room lists one entry per CONNECTION — the same person in two tabs (or
 * a reconnect not yet reaped) would show twice. Collapse to one avatar per
 * identity (kind + name + colour — the browser-local guest identity),
 * keeping the viewer's own connection so the "(you)" tooltip survives. */
function onePerPerson(peers: Peer[], you: number | null): Peer[] {
  const byIdentity = new Map<string, Peer>();
  for (const p of peers) {
    const key = `${p.kind ?? ""}|${p.name}|${p.color}`;
    if (!byIdentity.has(key) || p.id === you) byIdentity.set(key, p);
  }
  return [...byIdentity.values()];
}

export function Presence() {
  const peers = useCollabStore((s) => s.peers);
  const you = useCollabStore((s) => s.you);
  const connected = useCollabStore((s) => s.connected);
  const aiThinking = useAppStore((s) => s.aiThinking);
  const me = getIdentity();

  // Room list already includes "you"; if not connected yet, show just you.
  const list = connected && peers.length
    ? onePerPerson(peers, you)
    : [{ id: -1, name: me.name, color: me.color }];

  return (
    <div className="presence">
      {list.slice(0, 6).map((p) => (
        <span
          key={p.id}
          className={`avatar${isClaude(p) ? " agent-claude" : ""}`}
          title={p.id === you ? `${p.name} (you)` : p.kind === "agent" ? `${p.name} (AI agent via MCP)` : p.name}
          style={{ background: isClaude(p) ? "#faf9f5" : p.color }}
        >
          {isClaude(p) ? <ClaudeMark /> : p.name.replace(/^Guest-/, "").slice(0, 2).toUpperCase()}
          <span className="dot" style={{ background: "#16a34a" }} />
        </span>
      ))}
      {list.length > 6 && (
        <span className="avatar" style={{ background: "var(--faint)" }}>+{list.length - 6}</span>
      )}
      {/* AI-Noddle — always in the room as a co-editor; pulses while editing */}
      <span
        className={`avatar claude${aiThinking ? " thinking" : ""}`}
        title={aiThinking ? "AI-Noddle is editing the diagram…" : "AI-Noddle — co-editor (chat to ask for edits)"}
        style={{ background: "var(--grad)" }}
      >
        ✦
        <span className="dot" style={{ background: aiThinking ? "#f59e0b" : "#16a34a" }} />
      </span>
    </div>
  );
}
