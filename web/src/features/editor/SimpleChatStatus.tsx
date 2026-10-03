/**
 * features/editor/SimpleChatStatus — Simple mode's AI progress strip.
 *
 * Simple mode has no docked chat panel, so a message sent from the canvas
 * chat bar used to vanish: the board just changed with no feedback. This
 * strip sits right above the chat bar and shows, Excalidraw-minimal:
 *   • while the queue drains — "Editing the board…" (+ how many wait);
 *   • when a reply lands — its first lines, ↩ Rollback (if the edit left a
 *     checkpoint) and Details, which opens the full Claude panel.
 * Only replies that arrive AFTER mount surface — reopening a board never
 * re-announces an old conversation. × (or the next message) dismisses.
 */
import { useState } from "react";
import { chatKey, useAppStore } from "../../state/appStore";
import { useEditorStore } from "../../state/editorStore";
import { useAiCheckpoints } from "./aiCheckpoints";
import { rollbackAiEdit } from "./claudeEdit";

/** Markdown-lite → one plain line for the preview (the panel renders the rest). */
const plain = (t: string) =>
  t
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*_`#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();

export function SimpleChatStatus() {
  const docId = useEditorStore((s) => s.docId);
  const aiThinking = useAppStore((s) => s.aiThinking);
  const queued = useAppStore((s) => s.queuedChats);
  const chatMode = useAppStore((s) => s.chatMode);
  const messages = useAppStore((s) => {
    const b = s.chats[chatKey(docId)];
    return b?.sessions.find((x) => x.id === b.activeId)?.messages;
  });
  const rollbackable = useAiCheckpoints((s) => s.available);
  const count = messages?.length ?? 0;
  // Messages up to this index are "already seen" — the strip ignores them.
  const [seen, setSeen] = useState(count);
  const [seenDoc, setSeenDoc] = useState(docId);
  if (seenDoc !== docId) {
    // switched boards: that board's history is old news too
    setSeenDoc(docId);
    setSeen(count);
  }

  const last = messages?.[count - 1];
  const reply = !aiThinking && last?.who === "ai" && count > seen ? last : null;
  if (!aiThinking && !reply) return null;

  const openDetails = () => {
    const app = useAppStore.getState();
    app.setRightTab("claude");
    app.setSimplePanelOpen(true);
    setSeen(count);
  };

  if (aiThinking) {
    return (
      <div className="simple-ai-status busy" role="status" aria-live="polite">
        <span className="spark">✦</span>
        <span className="msg">
          {chatMode === "ask" ? "Thinking about your question" : "Editing the board"}
          <span className="dots" aria-hidden="true"><i /><i /><i /></span>
          {queued > 0 && <span className="queued">{queued} waiting</span>}
        </span>
        <button className="link" onClick={openDetails}>Details</button>
      </div>
    );
  }

  const cp = reply!.checkpointId && rollbackable[reply!.checkpointId] ? reply!.checkpointId : null;
  return (
    <div className="simple-ai-status" role="status" aria-live="polite">
      <span className="spark">✦</span>
      <span className="msg reply" title={plain(reply!.text)}>{plain(reply!.text)}</span>
      {cp && (
        <button
          className="link"
          title="Undo this AI edit (and any after it)"
          onClick={() => {
            rollbackAiEdit(docId, cp);
            // the rollback posts its own notice — surface THAT, not stay hidden
            setSeen(count);
          }}
        >
          ↩ Rollback
        </button>
      )}
      <button className="link" onClick={openDetails}>Details</button>
      <button className="close" aria-label="Dismiss" title="Dismiss" onClick={() => setSeen(count)}>×</button>
    </div>
  );
}
