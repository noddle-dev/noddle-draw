/**
 * features/editor/EditorTopbar — the editor's top chrome.
 *
 * REAL: doc name (inline rename via PATCH), undo/redo, export SVG/PNG, save,
 * back-to-dashboard, presence avatars (everyone in the live-collab room), and
 * Share (copies the /d/{id} link — anyone with it joins the same board).
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
import { useAuthStore } from "../../state/authStore";
import { useCommentsStore } from "../../state/commentsStore";
import { Icon, BrandLogo } from "../../shared/ui";
import { api, type SharesInfo } from "../../shared/api/client";
import { useExport } from "../toolbar/useExport";
import { GifExportModal } from "./GifExportModal";
import { HistoryPanel } from "./HistoryPanel";
import { MentionsBell } from "../comments/MentionsBell";
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

/** Lucid-style Share dialog: Individual access + Shareable link toggle. */
function ShareDialog({
  docId,
  title,
  onClose,
}: {
  docId: string;
  title: string;
  onClose: () => void;
}) {
  const [info, setInfo] = useState<SharesInfo | null>(null);
  const [isOwner, setIsOwner] = useState(true);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("editor");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const linkRef = useRef<HTMLInputElement>(null);
  const shareUrl = `${location.origin}/d/${docId}`;

  // Your display name in this room. Signed-in → profile name (read-only here);
  // guest → editable nickname (updates presence/cursors live).
  const me = useAuthStore((s) => s.me);
  const isGuest = !me || me.kind === "guest";
  const [nick, setNick] = useState(getIdentity().name);
  const saveNick = () => {
    const n = nick.trim();
    if (!n || !isGuest) return;
    setGuestName(n);
    // reconnect so the server re-broadcasts the new identity to the room
    disconnectCollab();
    connectCollab(docId);
  };

  const reload = () =>
    void api
      .getShares(docId)
      .then((i) => { setInfo(i); setIsOwner(true); })
      .catch(() => setIsOwner(false)); // not owner → link-only view
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(reload, [docId]);

  // Boards are private by default — until the server says otherwise, show
  // link sharing as OFF (fail-safe; matches the backend default).
  const linkOn = (info?.link_policy ?? "private") !== "private";
  const setPolicy = (p: "edit" | "view" | "private") =>
    void api.patchDoc(docId, { link_policy: p }).then(reload);

  const invite = () => {
    setError(null);
    void api
      .addShare(docId, email.trim(), role)
      .then(() => { setEmail(""); reload(); })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };

  // Change a shared user's role — POST /shares upserts by email.
  const changeRole = (memberEmail: string, newRole: string) => {
    setError(null);
    void api
      .addShare(docId, memberEmail, newRole)
      .then(reload)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };

  // Revoke access — confirm first (destructive, can't be undone in one click).
  const revoke = (memberId: string, name: string) => {
    if (!window.confirm(`Remove ${name}'s access to "${title}"?`)) return;
    setError(null);
    void api
      .removeShare(docId, memberId)
      .then(reload)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
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
            disabled={!isGuest}
            title={isGuest ? "" : "Name comes from your account"}
            onChange={(e) => setNick(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") saveNick(); }}
          />
          {isGuest && (
            <button className="btn" disabled={!nick.trim() || nick.trim() === getIdentity().name} onClick={saveNick}>
              Rename
            </button>
          )}
        </div>
        <div style={{ borderTop: "1px solid var(--border-faint)", margin: "0 0 14px" }} />

        {/* Individual access */}
        {isOwner && (
          <>
            <div style={{ fontWeight: 650, fontSize: 13.5, marginBottom: 8 }}>Individual access</div>
            <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
              <input
                className="text-input"
                style={{ flex: 1 }}
                placeholder="Add people by email…"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") invite(); }}
              />
              <select className="text-input" style={{ width: 130 }} value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="editor">Can edit & share</option>
                <option value="viewer">Can view only</option>
              </select>
              <button className="btn btn-primary" onClick={invite}>Invite</button>
            </div>
            {error && <p style={{ color: "var(--danger)", fontSize: 12, margin: "0 0 8px" }}>{error}</p>}
            {/* Owner — always listed first, not removable. */}
            {info?.owner && (
              <div className="share-row">
                <span className="share-person">
                  <span className="avatar" style={{ width: 22, height: 22, fontSize: 9, background: info.owner.color }}>
                    {info.owner.name.slice(0, 2).toUpperCase()}
                  </span>
                  <span className="share-name">{info.owner.name}</span>
                </span>
                <span className="share-owner-badge">Owner</span>
              </div>
            )}
            {info?.shares.map((s) => (
              <div key={s.id} className="share-row">
                <span className="share-person">
                  <span className="avatar" style={{ width: 22, height: 22, fontSize: 9, background: s.color }}>
                    {s.name.slice(0, 2).toUpperCase()}
                  </span>
                  <span className="share-name">{s.name}</span>
                </span>
                <select
                  className="text-input share-role"
                  value={s.role}
                  onChange={(e) => changeRole(s.email, e.target.value)}
                >
                  <option value="editor">Can edit</option>
                  <option value="viewer">View only</option>
                </select>
                <button
                  className="btn share-revoke"
                  title={`Remove ${s.name}`}
                  onClick={() => revoke(s.id, s.name)}
                >
                  ✕
                </button>
              </div>
            ))}
            <div style={{ borderTop: "1px solid var(--border-faint)", margin: "14px 0" }} />
          </>
        )}

        {/* Shareable link */}
        <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
          <div style={{ fontWeight: 650, fontSize: 13.5, flex: 1 }}>Shareable link</div>
          {isOwner ? (
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: "var(--muted)", cursor: "pointer" }}>
              {linkOn ? "On" : "Off"}
              <button
                className={`switch${linkOn ? " on" : ""}`}
                onClick={() => setPolicy(linkOn ? "private" : "edit")}
              >
                <span className="knob" />
              </button>
            </label>
          ) : (
            <span className="muted" style={{ fontSize: 12 }}>On</span>
          )}
        </div>

        <div style={{ display: "flex", gap: 8, opacity: linkOn || !isOwner ? 1 : 0.45 }}>
          <input
            ref={linkRef}
            className="text-input"
            readOnly
            value={shareUrl}
            style={{ flex: 1, fontSize: 12 }}
            onFocus={(e) => e.currentTarget.select()}
            onClick={(e) => e.currentTarget.select()}
          />
          {linkOn || !isOwner ? (
            <button className={`btn ${copied ? "" : "btn-primary"}`} onClick={() => void copy()}>
              {copied ? "✓ Copied" : "Copy"}
            </button>
          ) : (
            <button className="btn btn-primary" onClick={() => setPolicy("edit")}>
              Turn on shareable link
            </button>
          )}
        </div>

        {isOwner && linkOn && (
          <div className="prop-row" style={{ marginTop: 10 }}>
            <span className="lbl" style={{ display: "flex", alignItems: "center", gap: 6 }}>
              🌐 Anyone with the link
            </span>
            <select
              className="text-input"
              style={{ width: 150, fontSize: 12.5 }}
              value={info?.link_policy ?? "private"}
              onChange={(e) => setPolicy(e.target.value as "edit" | "view")}
            >
              <option value="edit">Can edit & share</option>
              <option value="view">Can view only</option>
            </select>
          </div>
        )}
        <p className="muted" style={{ fontSize: 12, margin: "10px 0 0", lineHeight: 1.45 }}>
          {linkOn || !isOwner
            ? `Anyone with the link can ${(info?.link_policy ?? "private") === "view" ? "view" : "co-edit in realtime"} — no sign-in required.`
            : "Link sharing is off — only people invited by name can access this board."}
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

export function EditorTopbar() {
  const go = useAppStore((s) => s.go);

  const docId = useEditorStore((s) => s.docId);
  const docName = useEditorStore((s) => s.docName);
  const myRole = useEditorStore((s) => s.myRole);
  const docOwner = useEditorStore((s) => s.docOwner);
  const me = useAuthStore((s) => s.me);
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

  return (
    <div className="editor-topbar">
      <button className="editor-logo" title="Back to dashboard" onClick={() => go("dashboard")}>
        <span className="brand-mark"><BrandLogo /></span>
      </button>
      <button
        className="btn btn-ghost"
        title="Back to dashboard"
        onClick={() => go("dashboard")}
        style={{ padding: "5px 10px", gap: 5, fontWeight: 600, color: "var(--text-2)" }}
      >
        <Icon name="back" size={16} /> Back
      </button>
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
      {docOwner && (
        <span
          className="owner-chip"
          title={`Owned by ${docOwner.name}`}
        >
          <span className="avatar owner-chip-avatar" style={{ background: docOwner.color }}>
            {docOwner.name.slice(0, 2).toUpperCase()}
          </span>
          <span className="owner-chip-text">
            {me?.kind === "user" && me.id === docOwner.id ? "You" : docOwner.name}
          </span>
        </span>
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

      <div className="spacer" />

      <MentionsBell />

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
    </div>
  );
}
