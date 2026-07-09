/**
 * features/editor/CanvasCollab — canvas overlays.
 *
 * REAL: remote live cursors of everyone else in the document's WebSocket room
 * (content coords → screen via the shared camera; pruned when stale).
 * MOCKUP: the floating "Ask Claude" chat bar (routes to the chat panel).
 */
import { useEffect, useRef, useState } from "react";
import { contentToStage } from "../../editor-core";
import { useAppStore } from "../../state/appStore";
import { useEditorStore } from "../../state/editorStore";
import { useCollabStore, type RemoteCursor } from "../../state/collabStore";
import { usePagesStore } from "../../state/pagesStore";
import { getAiKeyConfig } from "../../shared/api/client";
import { poolInfoSync } from "../../shared/poolConfig";
import { AiKeySettings } from "../ai/AiKeySettings";
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
  const aiThinking = useAppStore((s) => s.aiThinking);
  const queuedChats = useAppStore((s) => s.queuedChats);
  // UNCONTROLLED input — same IME fix as the chat panel: a controlled value +
  // Vietnamese composition + store re-renders duplicated the last segment.
  const inputRef = useRef<HTMLInputElement>(null);
  const [keyModalOpen, setKeyModalOpen] = useState(false);

  const sendToClaude = () => {
    const el = inputRef.current;
    const t = (el?.value ?? "").trim();
    if (!t) return;
    // BYOK gate — without a key the request can only 503; prompt for the key
    // and KEEP the draft so it sends after configuring.
    if (!getAiKeyConfig() && !(poolInfoSync()?.pool_ai)) {
      setKeyModalOpen(true);
      return;
    }
    // Open the chat panel so the conversation is visible; the queue takes it
    // from here — no locking, messages process in order.
    useAppStore.getState().setRightTab("claude");
    if (el) el.value = "";
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
          ref={inputRef}
          placeholder={hint}
          defaultValue=""
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) sendToClaude();
          }}
          onPaste={(e) => {
            // An image pasted into the mini bar belongs to the FULL chat
            // (attachment preview + send live there): route the focus over
            // and let the panel's own paste pipeline handle the file.
            const hasImage = Array.from(e.clipboardData.items).some((i) =>
              /^image\//.test(i.type),
            );
            if (hasImage) {
              e.preventDefault();
              useAppStore.getState().setRightTab("claude");
              // Re-dispatch on the panel textarea once it mounts.
              const dt = e.clipboardData;
              requestAnimationFrame(() => {
                const ta = document.querySelector<HTMLTextAreaElement>(".chat-input");
                if (!ta) return;
                ta.focus();
                ta.dispatchEvent(new ClipboardEvent("paste", {
                  clipboardData: dt,
                  bubbles: true,
                  cancelable: true,
                }));
              });
            }
          }}
        />
        <button className="send" onClick={sendToClaude}>↑</button>
      </div>
      {keyModalOpen && <AiKeySettings onClose={() => setKeyModalOpen(false)} />}
    </>
  );
}
