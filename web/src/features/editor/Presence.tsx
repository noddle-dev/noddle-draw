/**
 * features/editor/Presence — avatars of everyone in the live-collab room,
 * plus AI-Noddle as a permanent co-editor (pulses while it edits).
 */
import { useCollabStore, getIdentity } from "../../state/collabStore";
import { useAppStore } from "../../state/appStore";

export function Presence() {
  const peers = useCollabStore((s) => s.peers);
  const you = useCollabStore((s) => s.you);
  const connected = useCollabStore((s) => s.connected);
  const aiThinking = useAppStore((s) => s.aiThinking);
  const me = getIdentity();

  // Room list already includes "you"; if not connected yet, show just you.
  const list = connected && peers.length
    ? peers
    : [{ id: -1, name: me.name, color: me.color }];

  return (
    <div className="presence">
      {list.slice(0, 6).map((p) => (
        <span
          key={p.id}
          className="avatar"
          title={p.id === you ? `${p.name} (you)` : p.name}
          style={{ background: p.color }}
        >
          {p.name.replace(/^Guest-/, "").slice(0, 2).toUpperCase()}
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
