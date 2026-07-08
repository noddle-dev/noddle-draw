/**
 * features/dashboard/Sidebar — brand, "New with AI", "New board" (opens the
 * Templates picker), nav, REAL folders (server CRUD: create/rename/delete +
 * per-folder color tag).
 */
import { useEffect, useState } from "react";
import { useAppStore } from "../../state/appStore";
import { useAuthStore } from "../../state/authStore";
import { useEditorStore } from "../../state/editorStore";
import { api } from "../../shared/api/client";
import { Icon, BrandLogo } from "../../shared/ui";
import { NAV } from "./data";

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** REAL storage meter (#23): bytes at rest across boards this account owns. */
function StorageMeter() {
  const me = useAuthStore((s) => s.me);
  const docs = useEditorStore((s) => s.docs); // re-fetch when the list changes
  const [usage, setUsage] = useState<{ used: number; quota: number } | null>(null);

  useEffect(() => {
    if (me?.kind !== "user") {
      setUsage(null);
      return;
    }
    let alive = true;
    void api.myStorage().then((u) => { if (alive) setUsage(u); }).catch(() => {});
    return () => { alive = false; };
  }, [me, docs.length]);

  if (!usage) return null;
  const pct = Math.min(100, (usage.used / usage.quota) * 100);
  return (
    <div className="dash-storage">
      <div className="row">
        <span>Storage</span>
        <span>{fmtBytes(usage.used)} / {fmtBytes(usage.quota)}</span>
      </div>
      <div className="meter"><span style={{ width: `${Math.max(1, pct)}%` }} /></div>
    </div>
  );
}

/** Color-tag palette for folders. */
const FOLDER_COLORS = ["#2563eb", "#7c3aed", "#16a34a", "#d97706", "#dc2626", "#0891b2", "#e64980", "#6b7280"];

export function Sidebar() {
  const dashPage = useAppStore((s) => s.dashPage);
  const curFolder = useAppStore((s) => s.curFolder);
  const folders = useAppStore((s) => s.folders);
  const setDashPage = useAppStore((s) => s.setDashPage);
  const openFolder = useAppStore((s) => s.openFolder);
  const createFolder = useAppStore((s) => s.createFolder);
  const renameFolder = useAppStore((s) => s.renameFolder);
  const deleteFolder = useAppStore((s) => s.deleteFolder);
  const setFolderColor = useAppStore((s) => s.setFolderColor);
  const startNewWithAI = useAppStore((s) => s.startNewWithAI);
  const setTplModal = useAppStore((s) => s.setTplModal);
  // Which folder's color-picker popover is open (null = none).
  const [colorPickId, setColorPickId] = useState<string | null>(null);
  // Inline create/rename/delete state — designed replacements for the old
  // window.prompt/confirm native dialogs.
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [confirmDelId, setConfirmDelId] = useState<string | null>(null);

  const commitAdd = () => {
    const name = draft.trim();
    setAdding(false);
    setDraft("");
    if (name) void createFolder(name);
  };
  const commitRename = (id: string, cur: string) => {
    const name = renameDraft.trim();
    setRenamingId(null);
    if (name && name !== cur) void renameFolder(id, name);
  };

  return (
    <div className="dash-sidebar">
      <div className="dash-brand">
        <span className="brand-mark"><BrandLogo /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="brand-name">Noddle Board</div>
          <div className="brand-team">Diagram workspace</div>
        </div>
        <span style={{ color: "var(--faint-2)", display: "inline-flex" }}><Icon name="chevronDown" size={13} /></span>
      </div>

      <div className="dash-new">
        <button className="btn btn-grad btn-block" onClick={() => startNewWithAI()}>
          <Icon name="sparkles" /> New with AI
        </button>
        <button
          className="btn btn-block"
          style={{ marginTop: 8 }}
          onClick={() => setTplModal(true)}
        >
          <Icon name="plus" /> New board
        </button>
      </div>

      <div className="dash-nav">
        {NAV.map((it) => (
          <button
            key={it.key}
            className={`nav-item${dashPage === it.key ? " active" : ""}`}
            onClick={() => setDashPage(it.key)}
          >
            <span className="ico"><Icon name={it.icon} size={17} /></span>
            <span className="lbl">{it.label}</span>
          </button>
        ))}
      </div>

      <div className="dash-folders-head">
        <span className="ttl">Folders</span>
        <button className="add" title="New folder" onClick={() => { setAdding(true); setDraft(""); }}>
          <Icon name="plus" size={15} />
        </button>
      </div>
      <div className="dash-folders">
        {adding && (
          <div className="folder-item">
            <span className="dot" style={{ color: "var(--faint)" }}>
              <Icon name="folder" size={16} />
            </span>
            <input
              className="folder-inline-input"
              autoFocus
              placeholder="Folder name…"
              aria-label="New folder name"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitAdd();
                else if (e.key === "Escape") { setAdding(false); setDraft(""); }
              }}
              onBlur={commitAdd}
            />
          </div>
        )}
        {folders.length === 0 && !adding && (
          <p className="muted" style={{ fontSize: 12, padding: "4px 10px" }}>
            No folders yet — click ＋ to create one.
          </p>
        )}
        {folders.map((f) => (
          <div key={f.id}>
          <div
            className={`folder-item${dashPage === "folder" && curFolder?.id === f.id ? " active" : ""}`}
            onClick={() => openFolder(f)}
            role="button"
            style={{ position: "relative" }}
          >
            <span className="dot" style={{ color: f.color || "var(--faint)" }}>
              <Icon name="folder" size={16} />
            </span>
            {renamingId === f.id ? (
              <input
                className="folder-inline-input"
                autoFocus
                aria-label="Rename folder"
                value={renameDraft}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => setRenameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename(f.id, f.name);
                  else if (e.key === "Escape") setRenamingId(null);
                }}
                onBlur={() => commitRename(f.id, f.name)}
              />
            ) : (
              <span className="nm">{f.name}</span>
            )}
            <span className="folder-actions">
              <button
                title="Change color"
                onClick={(e) => { e.stopPropagation(); setColorPickId(colorPickId === f.id ? null : f.id); }}
              >
                <span style={{ width: 12, height: 12, borderRadius: "50%", background: f.color || "var(--faint)", display: "inline-block", border: "1px solid rgba(0,0,0,.15)" }} />
              </button>
              <button
                title="Rename"
                onClick={(e) => { e.stopPropagation(); setRenamingId(f.id); setRenameDraft(f.name); }}
              >
                <Icon name="edit" size={14} />
              </button>
              <button
                title="Delete folder"
                onClick={(e) => { e.stopPropagation(); setConfirmDelId(confirmDelId === f.id ? null : f.id); }}
              >
                <Icon name="trash" size={14} />
              </button>
            </span>
            <span className="ct">{f.count}</span>
            {confirmDelId === f.id && (
              <div className="side-pop" onClick={(e) => e.stopPropagation()}>
                <p className="side-pop-msg">
                  Delete <b>{f.name}</b>? Boards inside move to Home.
                </p>
                <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                  <button className="btn" style={{ fontSize: 12, padding: "3px 10px" }} onClick={() => setConfirmDelId(null)}>
                    Cancel
                  </button>
                  <button
                    className="btn btn-danger"
                    style={{ fontSize: 12, padding: "3px 10px" }}
                    onClick={() => { setConfirmDelId(null); void deleteFolder(f.id); }}
                  >
                    Delete
                  </button>
                </div>
              </div>
            )}
          </div>
          {/* Inline swatch row (not an overlay): .dash-folders scrolls, so an
              absolutely-positioned popover gets clipped by the container. */}
          {colorPickId === f.id && (
            <div className="folder-swatch-row" onClick={(e) => e.stopPropagation()}>
              {FOLDER_COLORS.map((c) => (
                <button
                  key={c}
                  className={`swatch${(f.color || "").toLowerCase() === c ? " sel" : ""}`}
                  title={c}
                  aria-label={`Folder color ${c}`}
                  style={{ background: c }}
                  onClick={() => { void setFolderColor(f.id, c); setColorPickId(null); }}
                />
              ))}
            </div>
          )}
          </div>
        ))}
      </div>
      <StorageMeter />
    </div>
  );
}
