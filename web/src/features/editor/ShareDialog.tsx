/**
 * features/editor/ShareDialog — your display name and the shareable link.
 * Anonymous edition: there are no accounts or invites — the board URL IS the
 * capability (Excalidraw-style), so sharing = copying the link.
 */
import { useRef, useState } from "react";
import { useEditorStore } from "../../state/editorStore";
import { getIdentity, setGuestName, connectCollab, disconnectCollab } from "../../state/collabStore";

/** Share dialog: your display name + the shareable link (the capability).
 * Opened from the top-right Share button and the ☰ menu (SimpleMode.tsx). */
export function ShareDialog({
  docId,
  title,
  onClose,
}: {
  docId: string;
  title: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const linkRef = useRef<HTMLInputElement>(null);
  const shareUrl = `${location.origin}/d/${docId}`;
  const viewer = useEditorStore((s) => s.myRole === "viewer");

  // Your display name in this room — editable nickname (updates presence/
  // cursors live).
  const [nick, setNick] = useState(getIdentity().name);
  const saveNick = () => {
    const n = nick.trim();
    if (!n) return;
    setGuestName(n);
    // reconnect so the room re-broadcasts the new identity
    disconnectCollab();
    connectCollab(docId);
  };

  const copy = async () => {
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(shareUrl);
        ok = true;
      }
    } catch { /* fall through */ }
    if (!ok && linkRef.current) {
      linkRef.current.focus();
      linkRef.current.select();
      try { ok = document.execCommand("copy"); } catch { ok = false; }
    }
    setCopied(ok);
  };

  return (
    <div className="gen-overlay" onClick={onClose}>
      <div className="gen-modal" style={{ textAlign: "left", width: 480 }} onClick={(e) => e.stopPropagation()}>
        {/* header */}
        <div style={{ display: "flex", alignItems: "center", marginBottom: 16 }}>
          <div className="t" style={{ flex: 1, margin: 0 }}>Share "{title}"</div>
          <button className="props-close" onClick={onClose}>✕</button>
        </div>

        {/* Your display name in the room */}
        <div style={{ fontWeight: 650, fontSize: 13.5, marginBottom: 8 }}>Your display name</div>
        <div style={{ display: "flex", gap: 8, marginBottom: 14, alignItems: "center" }}>
          <span className="avatar" style={{ width: 30, height: 30, background: getIdentity().color, fontSize: 11 }}>
            {(nick || "?").slice(0, 2).toUpperCase()}
          </span>
          <input
            className="text-input"
            style={{ flex: 1 }}
            value={nick}
            onChange={(e) => setNick(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") saveNick(); }}
          />
          <button className="btn" disabled={!nick.trim() || nick.trim() === getIdentity().name} onClick={saveNick}>
            Rename
          </button>
        </div>
        <div style={{ borderTop: "1px solid var(--border-faint)", margin: "0 0 14px" }} />

        {/* Shareable link — always on: the URL IS the capability. */}
        <div style={{ fontWeight: 650, fontSize: 13.5, marginBottom: 10 }}>Shareable link</div>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            ref={linkRef}
            className="text-input"
            readOnly
            value={shareUrl}
            style={{ flex: 1, fontSize: 12 }}
            onFocus={(e) => e.currentTarget.select()}
            onClick={(e) => e.currentTarget.select()}
          />
          <button className={`btn ${copied ? "" : "btn-primary"}`} onClick={() => void copy()}>
            {copied ? "✓ Copied" : "Copy"}
          </button>
        </div>
        <p className="muted" style={{ fontSize: 12, margin: "10px 0 0", lineHeight: 1.45 }}>
          {viewer
            ? "Anyone with the link can view this board — no sign-up required."
            : "Anyone with the link can co-edit in realtime — no sign-up required. Keep it private if the board is."}
        </p>
      </div>
    </div>
  );
}
