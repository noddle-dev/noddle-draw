/**
 * features/editor/CanvasCollab — canvas overlays.
 *
 * REAL: remote live cursors of everyone else in the document's WebSocket room
 * (content coords → screen via the shared camera; pruned when stale).
 * MOCKUP: the floating "Ask Claude" chat bar (routes to the chat panel).
 */
import { useEffect, useState } from "react";
import { contentToStage } from "../../editor-core";
import { useAppStore } from "../../state/appStore";
import { useEditorStore } from "../../state/editorStore";
import { useCollabStore, type RemoteCursor } from "../../state/collabStore";
import { usePagesStore } from "../../state/pagesStore";
import { askClaudeEdit } from "./claudeEdit";

const STALE_MS = 6000;

function CursorArrow({ fill }: { fill: string }) {
  return (
    <svg width="20" height="22" viewBox="0 0 20 22">
      <path d="M2 2 L2 17 L6 13 L9 20 L12 18 L9 11 L15 11 Z" fill={fill} stroke="#fff" strokeWidth="1.2" />
    </svg>
  );
}

/** Remote teammates' cursors, mapped content→screen through the live camera. */
function RemoteCursors() {
  const cursors = useCollabStore((s) => s.cursors);
  const cam = useEditorStore((s) => s.cam); // re-render on pan/zoom
  const refs = useEditorStore((s) => s.refs);
  const activePageId = usePagesStore((s) => s.activeId);
  const [, forceTick] = useState(0);

  // prune stale cursors visually (peer idle / left without bye)
  useEffect(() => {
    const t = setInterval(() => forceTick((v) => v + 1), 2000);
    return () => clearInterval(t);
  }, []);
  void cam;

  if (!refs) return null;
  const now = Date.now();
  // Same-page only: a peer editing page B must not ghost over page A's
  // shapes. Null pageId = legacy client / no page context → show as before.
  const live = Object.values(cursors).filter(
    (c) =>
      now - c.at < STALE_MS &&
      (c.pageId == null || activePageId == null || c.pageId === activePageId),
  );

  return (
    <>
      {live.map((c: RemoteCursor) => {
        const p = contentToStage(refs.content, refs.host, c.x, c.y);
        return (
          <div
            key={c.id}
            className="collab-cursor"
            style={{ transform: `translate(${p.x}px, ${p.y}px)` }}
          >
            <CursorArrow fill={c.color} />
            <span className="name" style={{ background: c.color }}>{c.name}</span>
          </div>
        );
      })}
    </>
  );
}

export function CanvasCollab() {
  const [chatInput, setChatInput] = useState("");
  const aiThinking = useAppStore((s) => s.aiThinking);
  const queuedChats = useAppStore((s) => s.queuedChats);

  const sendToClaude = () => {
    const t = chatInput.trim();
    if (!t) return;
    // Open the chat panel so the conversation is visible; the queue takes it
    // from here — no locking, messages process in order.
    useAppStore.getState().setRightTab("claude");
    setChatInput("");
    askClaudeEdit(t);
  };

  const hint = aiThinking
    ? queuedChats > 0
      ? `✦ Editing… (${queuedChats} messages waiting) — keep typing`
      : "✦ Editing… — keep typing, messages will queue up"
    : "Ask AI-Noddle to edit the diagram…";

  return (
    <>
      <RemoteCursors />
      <div className="canvas-chatbar">
        <span className="spark">✦</span>
        <input
          placeholder={hint}
          value={chatInput}
          onChange={(e) => setChatInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") sendToClaude(); }}
        />
        <button className="send" onClick={sendToClaude}>↑</button>
      </div>
    </>
  );
}
