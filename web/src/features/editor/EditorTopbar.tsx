/**
 * features/editor/EditorTopbar — the editor's top chrome.
 *
 * REAL: Boards menu (this browser's recent boards + New board), doc name
 * (inline rename via PATCH), undo/redo, export SVG/PNG, save, presence
 * avatars (everyone in the live-collab room), and Share (copies the /d/{id}
 * link — the link IS the sharing capability, Excalidraw-style).
 */
import { useEffect, useRef, useState } from "react";
import { useEditorStore } from "../../state/editorStore";
import { useDiagramStore } from "../../state/diagramStore";
import { useAppStore } from "../../state/appStore";
import {
  useCollabStore,
  getIdentity,
  setGuestName,
  connectCollab,
  disconnectCollab,
  broadcastName,
  onCollabName,
} from "../../state/collabStore";
import { useDiagramHistory } from "../../state/diagramHistory";
import { useCommentsStore } from "../../state/commentsStore";
import { Icon, BrandLogo } from "../../shared/ui";
import { api } from "../../shared/api/client";
import { useExport } from "../toolbar/useExport";
import { GifExportModal } from "./GifExportModal";
import { HistoryPanel } from "./HistoryPanel";
import { TemplatesModal } from "../templates/TemplatesModal";
import { createBoard } from "../templates/templates";
import { usePagesStore } from "../../state/pagesStore";
import { diagramToMermaid } from "../../editor-core/diagram";

/** Download a text file (open-format exports — #15). */
function downloadText(filename: string, text: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** The whole board (all pages) as noddle's open diagram JSON — re-importable
 * via the dashboard "Import file" card. */
function exportBoardJson(title: string): void {
  const payload = usePagesStore.getState().collect();
  downloadText(
    `${title || "board"}.json`,
    JSON.stringify(payload, null, 2),
    "application/json",
  );
}

/** The ACTIVE page as a Mermaid flowchart (structure only — layout is lossy). */
function exportMermaid(title: string): void {
  const s = useDiagramStore.getState();
  downloadText(
    `${title || "board"}.mmd`,
    diagramToMermaid(Object.values(s.nodes), Object.values(s.edges)),
    "text/plain",
  );
}

/** Share dialog: your display name + the shareable link (the capability). */
function ShareDialog({
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

function Presence() {
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

/** Boards menu: this browser's recent boards + New board / Templates / AI. */
function BoardsMenu({ onClose }: { onClose: () => void }) {
  const docs = useEditorStore((s) => s.docs);
  const activeId = useEditorStore((s) => s.docId);
  useEffect(() => {
    void useEditorStore.getState().refreshDocs();
  }, []);
  return (
    <div>
      <div className="menu-backdrop" onClick={onClose} />
      <div className="menu-pop" style={{ width: 240, top: 42, left: 8 }}>
        <div className="menu-body">
          <div
            className="menu-row"
            onClick={() => { onClose(); void createBoard(); }}
          >
            <span className="ico">＋</span>
            <span style={{ flex: 1 }}>New board</span>
          </div>
          <div
            className="menu-row"
            onClick={() => { onClose(); useAppStore.getState().setTplModal(true); }}
          >
            <span className="ico">▦</span>
            <span style={{ flex: 1 }}>Templates…</span>
          </div>
          <div
            className="menu-row"
            onClick={() => { onClose(); useAppStore.getState().startNewWithAI(); }}
          >
            <span className="ico">✦</span>
            <span style={{ flex: 1 }}>Generate with AI</span>
          </div>
          {docs.length > 0 && (
            <div className="muted" style={{ fontSize: 11, padding: "8px 10px 2px" }}>
              Recent on this browser
            </div>
          )}
          {docs.slice(0, 10).map((d) => (
            <div
              key={d.id}
              className="menu-row"
              style={d.id === activeId ? { fontWeight: 650 } : undefined}
              onClick={() => {
                onClose();
                if (d.id !== activeId) useAppStore.getState().openInEditor(d.id);
              }}
            >
              <span className="ico">◇</span>
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {d.name}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function EditorTopbar() {
  const docId = useEditorStore((s) => s.docId);
  const docName = useEditorStore((s) => s.docName);
  const myRole = useEditorStore((s) => s.myRole);
  // Undo/redo availability spans BOTH histories (SVG content + diagram layer).
  const svgCanUndo = useEditorStore((s) => s.canUndo);
  const svgCanRedo = useEditorStore((s) => s.canRedo);
  const diaCanUndo = useDiagramHistory((s) => s.canUndo);
  const diaCanRedo = useDiagramHistory((s) => s.canRedo);
  const canUndo = svgCanUndo || diaCanUndo;
  const canRedo = svgCanRedo || diaCanRedo;
  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);
  const save = useEditorStore((s) => s.save);
  const diagramMode = useDiagramStore((s) => s.diagramMode);
  const leftPanelOpen = useAppStore((s) => s.leftPanelOpen);
  const rightPanelOpen = useAppStore((s) => s.rightPanelOpen);

  const { exportSvg, exportPng, exportDeckPng } = useExport();
  const [exportOpen, setExportOpen] = useState(false);
  const [gifOpen, setGifOpen] = useState(false);

  // 💬 comment tool — armed → the next canvas click drops a pin.
  const commentMode = useCommentsStore((s) => s.commentMode);
  const commentsVisible = useCommentsStore((s) => s.commentsVisible);
  const openThreads = useCommentsStore(
    (s) => s.comments.filter((c) => !c.parent_id && !c.resolved).length,
  );
  // 🕘 version history dropdown.
  const [historyOpen, setHistoryOpen] = useState(false);

  const title = docName.replace(/^·\s*/, "") || "Untitled board";

  // Inline rename (no window.prompt): click the title → editable input; Enter
  // or blur commits via PATCH, Esc cancels. Viewers can't rename.
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState(title);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const canRename = !!docId && myRole !== "viewer";

  const beginRename = () => {
    if (!canRename) return;
    setDraftName(title);
    setEditingName(true);
  };
  useEffect(() => {
    if (editingName) {
      nameInputRef.current?.focus();
      nameInputRef.current?.select();
    }
  }, [editingName]);

  // Receive live renames from collaborators — update the local title only
  // (no PATCH: the peer who renamed already persisted it).
  useEffect(() => {
    onCollabName((name) => {
      useEditorStore.setState({ docName: "· " + name });
      void useEditorStore.getState().refreshDocs();
    });
    return () => onCollabName(null);
  }, [docId]);

  const commitRename = async () => {
    setEditingName(false);
    const name = draftName.trim();
    if (!docId || !name || name === title) return;
    try {
      await api.patchDoc(docId, { name });
      useEditorStore.setState({ docName: "· " + name });
      broadcastName(name); // live-sync the rename to collaborators
      await useEditorStore.getState().refreshDocs();
    } catch {
      /* keep old title on failure */
    }
  };

  const [shareOpen, setShareOpen] = useState(false);
  const [boardsOpen, setBoardsOpen] = useState(false);
  const tplModalOpen = useAppStore((s) => s.tplModalOpen);

  return (
    <div className="editor-topbar">
      <button className="editor-logo" title="Boards" onClick={() => setBoardsOpen((v) => !v)}>
        <span className="brand-mark"><BrandLogo /></span>
      </button>
      <div style={{ position: "relative" }}>
        <button
          className="btn btn-ghost"
          title="Your boards (this browser)"
          onClick={() => setBoardsOpen((v) => !v)}
          style={{ padding: "5px 10px", gap: 5, fontWeight: 600, color: "var(--text-2)" }}
        >
          Boards ▾
        </button>
        {boardsOpen && <BoardsMenu onClose={() => setBoardsOpen(false)} />}
      </div>
      <span className="crumb-sep">/</span>
      {editingName ? (
        <input
          ref={nameInputRef}
          className="editor-docname-input"
          value={draftName}
          onChange={(e) => setDraftName(e.target.value)}
          onBlur={() => void commitRename()}
          onKeyDown={(e) => {
            if (e.key === "Enter") void commitRename();
            else if (e.key === "Escape") { setDraftName(title); setEditingName(false); }
          }}
        />
      ) : (
        <button
          className="editor-docname"
          style={{ border: "none", background: "none", cursor: canRename ? "text" : "default", padding: "2px 6px" }}
          title={canRename ? "Click to rename" : undefined}
          onClick={beginRename}
        >
          {title}
        </button>
      )}
      {diagramMode && <span className="pill pill-ai">✦ AI-drafted</span>}
      {myRole === "viewer" && (
        <span className="pill" style={{ background: "var(--panel-2)", color: "var(--muted)" }}>
          👁 View only
        </span>
      )}

      <div className="editor-undo">
        <button className="icon-btn" title="Undo (⌘Z)" disabled={!canUndo} onClick={undo}>↶</button>
        <button className="icon-btn" title="Redo (⌘⇧Z)" disabled={!canRedo} onClick={redo}>↷</button>
      </div>

      <div className="editor-viewtoggle">
        <button
          className={`icon-btn${leftPanelOpen ? " on" : ""}`}
          title={`${leftPanelOpen ? "Hide" : "Show"} left panel ([)`}
          onClick={() => useAppStore.getState().toggleLeftPanel()}
        >
          ⇤
        </button>
        <button
          className={`icon-btn${rightPanelOpen ? " on" : ""}`}
          title={`${rightPanelOpen ? "Hide" : "Show"} right panel (])`}
          onClick={() => useAppStore.getState().toggleRightPanel()}
        >
          ⇥
        </button>
        <button
          className="icon-btn"
          disabled={!docId}
          title="Focus mode (\) — just the canvas, Esc to exit"
          onClick={() => useAppStore.getState().toggleFocusMode(true)}
        >
          ⤢
        </button>
        <button
          className="icon-btn"
          title="Keyboard shortcuts (?)"
          onClick={() => useAppStore.getState().setShortcutsOpen(true)}
        >
          ?
        </button>
      </div>

      <div className="spacer" />

      <button
        className="btn"
        disabled={!docId}
        title="Present (each page is a slide — ←/→, Esc to exit)"
        onClick={() => useAppStore.getState().setPresenting(true)}
      >
        ▶ Present
      </button>

      <div style={{ position: "relative" }}>
        <button
          className="btn"
          disabled={!docId}
          title="Version history"
          onClick={() => setHistoryOpen((v) => !v)}
        >
          🕘
        </button>
        {historyOpen && docId && (
          <HistoryPanel docId={docId} onClose={() => setHistoryOpen(false)} />
        )}
      </div>

      <div className="comment-cluster">
        {/* Show/hide the comment layer (declutter the board) */}
        <button
          className={`btn comment-toggle${commentsVisible ? " on" : ""}`}
          disabled={!docId}
          title={commentsVisible ? "Hide comments" : "Show comments"}
          onClick={() => useCommentsStore.getState().toggleCommentsVisible()}
        >
          💬{openThreads > 0 && <span className="count">{openThreads}</span>}
        </button>
        {/* Arm add-mode (only meaningful while the layer is shown) */}
        {commentsVisible && (
          <button
            className={`btn comment-add${commentMode ? " on" : ""}`}
            disabled={!docId}
            title={
              commentMode
                ? "Picking a spot — click the board to pin the comment (Esc to cancel)"
                : "Add a comment"
            }
            onClick={() => useCommentsStore.getState().setCommentMode(!commentMode)}
          >
            ＋
          </button>
        )}
      </div>

      <Presence />

      <div style={{ position: "relative" }}>
        <button className="btn" onClick={() => setExportOpen((v) => !v)}><Icon name="download" size={15} /> Export</button>
        {exportOpen && (
          <div>
            <div className="menu-backdrop" onClick={() => setExportOpen(false)} />
            <div className="menu-pop" style={{ width: 160, top: 42 }}>
              <div className="menu-body">
                <div className="menu-row" onClick={() => { setExportOpen(false); exportSvg(); }}>
                  <span className="ico">⬡</span><span style={{ flex: 1 }}>Export SVG</span>
                </div>
                <div className="menu-row" onClick={() => { setExportOpen(false); exportPng(); }}>
                  <span className="ico">▧</span><span style={{ flex: 1 }}>Export PNG</span>
                </div>
                <div className="menu-row" onClick={() => { setExportOpen(false); setGifOpen(true); }}>
                  <span className="ico">⬒</span><span style={{ flex: 1 }}>Animated GIF…</span>
                </div>
                <div className="menu-row" onClick={() => { setExportOpen(false); void exportDeckPng(); }}>
                  <span className="ico">▤</span><span style={{ flex: 1 }}>Deck PNG (per page)</span>
                </div>
                <div className="menu-row" onClick={() => { setExportOpen(false); exportBoardJson(title); }}>
                  <span className="ico">{"{}"}</span><span style={{ flex: 1 }}>Board JSON</span>
                </div>
                <div className="menu-row" onClick={() => { setExportOpen(false); exportMermaid(title); }}>
                  <span className="ico">⛓</span><span style={{ flex: 1 }}>Mermaid (.mmd)</span>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
      {gifOpen && <GifExportModal onClose={() => setGifOpen(false)} />}

      <button
        className="btn btn-primary"
        disabled={!docId || myRole === "viewer"}
        onClick={() => void save()}
        title={myRole === "viewer" ? "You have view-only access" : docId ? "Save" : "Board isn't attached to a document"}
      >
        <Icon name="save" size={15} /> Save
      </button>
      <button
        className="btn btn-primary"
        disabled={!docId}
        title={docId ? "Share to co-edit" : "Board isn't attached to a document"}
        onClick={() => setShareOpen(true)}
      >
        <Icon name="share" size={15} /> Share
      </button>
      {shareOpen && docId && (
        <ShareDialog docId={docId} title={title} onClose={() => setShareOpen(false)} />
      )}
      {tplModalOpen && <TemplatesModal />}
    </div>
  );
}
