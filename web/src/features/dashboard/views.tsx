/**
 * features/dashboard/views — the four dashboard pages (Home / Templates /
 * Shared / Folder). Home's "Recent" grid, folders and templates are REAL
 * (documents + folders API; templates create documents). "Shared with me" is
 * REAL too: GET /api/documents/shared (per-user shares + team boards).
 */
import { useEffect, useState } from "react";
import { useAppStore } from "../../state/appStore";
import { useEditorStore } from "../../state/editorStore";
import { useAuthStore } from "../../state/authStore";
import { api, type DocMeta, type FolderOut, type SharedDocRow } from "../../shared/api/client";
import { esc } from "../../editor-core";
import { Icon } from "../../shared/ui";
import { DocThumb, TemplateThumb } from "./Thumbnails";
import { createBoard, TEMPLATES, TPL_CATS } from "./templates";
import { DOC_ACCENTS, relTime } from "./data";

/**
 * Real board preview: the stored (flattened, sanitized) SVG served by the
 * backend — autosave keeps it fresh; `updated_at` busts the browser cache.
 * Falls back to the decorative placeholder when the SVG can't render.
 */
function DocPreview({ doc, accent }: { doc: DocMeta; accent: string }) {
  const [broken, setBroken] = useState(false);
  if (broken) return <DocThumb accent={accent} />;
  return (
    <img
      className="doc-preview"
      src={`/api/documents/${doc.id}/export.svg?v=${doc.updated_at}`}
      alt=""
      loading="lazy"
      draggable={false}
      onError={() => setBroken(true)}
    />
  );
}

/** Stable per-board accent: hash the id so a board keeps its tint across
 * re-orders/refreshes (index-based tints shuffled on every list change). */
function docAccent(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return DOC_ACCENTS[h % DOC_ACCENTS.length];
}

/** A document card backed by a real DocMeta, with a ⋯ menu (move/rename/delete). */
function RealDocCard({ doc }: { doc: DocMeta; index?: number }) {
  const openInEditor = useAppStore((s) => s.openInEditor);
  const openFolder = useAppStore((s) => s.openFolder);
  const folders = useAppStore((s) => s.folders);
  const [menuOpen, setMenuOpen] = useState(false);
  // Inline rename + delete-confirm state — designed replacements for the old
  // window.prompt/confirm native dialogs (same pattern as Sidebar folders).
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [confirmDel, setConfirmDel] = useState(false);
  const accent = docAccent(doc.id);
  const folder = folders.find((f) => f.id === doc.folder_id) ?? null;
  const linkOn = (doc.link_policy ?? "private") !== "private";

  const refresh = async () => {
    await useEditorStore.getState().refreshDocs();
    await useAppStore.getState().loadFolders();
  };
  const move = async (folderId: string | null) => {
    setMenuOpen(false);
    await api.patchDoc(doc.id, { folder_id: folderId });
    await refresh();
  };
  const startRename = () => {
    setMenuOpen(false);
    setRenameDraft(doc.name);
    setRenaming(true);
  };
  const commitRename = async () => {
    const name = renameDraft.trim();
    setRenaming(false);
    if (name && name !== doc.name) {
      await api.patchDoc(doc.id, { name });
      await refresh();
    }
  };
  const remove = async () => {
    setConfirmDel(false);
    await useEditorStore.getState().deleteDoc(doc.id);
    await useAppStore.getState().loadFolders();
  };

  return (
    <div
      className="doc-card"
      style={{ position: "relative", "--card-accent": accent } as React.CSSProperties}
    >
      <button
        className="doc-card-body"
        onClick={() => {
          if (!renaming && !confirmDel) openInEditor(doc.id);
        }}
      >
        <div className="doc-thumb">
          <DocPreview doc={doc} accent={accent} />
        </div>
        <div className="doc-meta">
          {renaming ? (
            <input
              className="folder-inline-input"
              style={{ display: "block", width: "100%", marginBottom: 3 }}
              autoFocus
              aria-label="Rename board"
              value={renameDraft}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setRenameDraft(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") void commitRename();
                else if (e.key === "Escape") setRenaming(false);
              }}
              onBlur={() => void commitRename()}
            />
          ) : (
            <div className="nm">{esc(doc.name)}</div>
          )}
          <div className="row">
            <span className="when">{relTime(doc.updated_at)}</span>
            {folder && (
              // Not a <button>: we're inside the card's button (nested buttons
              // are invalid HTML) — span with a click that opens the folder.
              <span
                className="doc-folder-chip"
                role="link"
                title={`Open folder ${folder.name}`}
                onClick={(e) => { e.stopPropagation(); openFolder(folder); }}
              >
                <span style={{ color: folder.color || "var(--faint)", display: "inline-flex" }}>
                  <Icon name="folder" size={11} />
                </span>
                {esc(folder.name)}
              </span>
            )}
            <span style={{ flex: 1 }} />
            <span className="doc-badges">
              {doc.team_id && (
                <span className="doc-badge" title="Team board">
                  <Icon name="shared" size={11} />
                </span>
              )}
              {linkOn && (
                <span className="doc-badge" title="Link sharing is on">
                  <Icon name="share" size={11} />
                </span>
              )}
            </span>
          </div>
        </div>
      </button>

      {confirmDel && (
        <div
          className="side-pop"
          style={{ top: 8 }} /* .doc-card clips overflow — anchor INSIDE the card */
          role="dialog"
          aria-label={`Delete ${doc.name}?`}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "Escape") setConfirmDel(false);
          }}
        >
          <p className="side-pop-msg">
            Delete <b>{esc(doc.name)}</b>? This can't be undone.
          </p>
          <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
            <button
              className="btn"
              style={{ fontSize: 12, padding: "3px 10px" }}
              autoFocus
              onClick={() => setConfirmDel(false)}
            >
              Cancel
            </button>
            <button
              className="btn btn-danger"
              style={{ fontSize: 12, padding: "3px 10px" }}
              onClick={() => void remove()}
            >
              Delete
            </button>
          </div>
        </div>
      )}

      <button className="doc-card-more" title="Options" onClick={() => setMenuOpen((v) => !v)}>
        ⋯
      </button>
      {menuOpen && (
        <>
          <div className="menu-backdrop" onClick={() => setMenuOpen(false)} />
          <div className="menu-pop" style={{ top: 34, right: 8, width: 210 }}>
            <div className="menu-body">
              <div className="menu-row" onClick={startRename}>
                <span className="ico">✎</span><span style={{ flex: 1 }}>Rename</span>
              </div>
              {folders.length > 0 && (
                <div style={{ padding: "6px 10px 2px", fontSize: 10.5, fontWeight: 650, textTransform: "uppercase", letterSpacing: ".04em", color: "var(--faint)" }}>
                  Move to
                </div>
              )}
              {folders.map((f) => (
                <div key={f.id} className="menu-row" onClick={() => void move(f.id)}>
                  <span className="ico" style={{ color: f.color }}>▸</span>
                  <span style={{ flex: 1 }} className="ellip">{f.name}</span>
                  {doc.folder_id === f.id && <span style={{ color: "var(--accent)" }}>✓</span>}
                </div>
              ))}
              {doc.folder_id && (
                <div className="menu-row" onClick={() => void move(null)}>
                  <span className="ico">⌂</span><span style={{ flex: 1 }}>Move to root</span>
                </div>
              )}
              <div
                className="menu-row"
                style={{ color: "var(--danger)" }}
                onClick={() => {
                  setMenuOpen(false);
                  setConfirmDel(true);
                }}
              >
                <span className="ico">✕</span><span style={{ flex: 1 }}>Delete</span>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function DocGrid({ docs }: { docs: DocMeta[] }) {
  return (
    <div className="card-grid">
      {docs.map((d) => (
        <RealDocCard key={d.id} doc={d} />
      ))}
    </div>
  );
}

/** One entry point for every importable format — branches on extension:
 * .svg → sanitize-upload · .drawio/.xml → server-side mxGraph parse ·
 * .mmd → the existing Mermaid AI path · .json → noddle's own open format. */
async function importPickedFile(
  file: File,
  openInEditor: (id: string) => void,
): Promise<void> {
  const name = file.name.replace(/\.[^.]+$/, "") || "Imported board";
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  let meta: DocMeta;
  if (ext === "svg") {
    meta = await api.upload(file);
  } else if (ext === "mmd" || ext === "mermaid") {
    const out = await api.textToDiagram(await file.text(), "mermaid");
    meta = await api.create({ name, diagram: { nodes: out.nodes, edges: out.edges } });
  } else if (ext === "json") {
    const payload = JSON.parse(await file.text()) as {
      pages?: unknown[];
      nodes?: unknown[];
      edges?: unknown[];
    };
    const diagram = Array.isArray(payload.pages)
      ? { pages: payload.pages }
      : { nodes: (payload.nodes ?? []) as never, edges: (payload.edges ?? []) as never };
    meta = await api.create({ name, diagram });
  } else {
    meta = await api.importFile(file); // .drawio / .xml
  }
  openInEditor(meta.id);
}

export function HomeView() {
  const docs = useEditorStore((s) => s.docs);
  const folders = useAppStore((s) => s.folders);
  const openFolder = useAppStore((s) => s.openFolder);
  const startNewWithAI = useAppStore((s) => s.startNewWithAI);
  const setTplModal = useAppStore((s) => s.setTplModal);
  const openInEditor = useAppStore((s) => s.openInEditor);
  const [importing, setImporting] = useState(false);
  // Inline error popover — designed replacement for the old window.alert.
  const [importError, setImportError] = useState<string | null>(null);

  const onImport = async (file: File | null) => {
    if (!file || importing) return;
    setImporting(true);
    setImportError(null);
    try {
      await importPickedFile(file, openInEditor);
    } catch (e) {
      setImportError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  };

  return (
    <div>
      <div className="hero-grid">
        <button className="hero" onClick={() => startNewWithAI()}>
          <span className="hero-eyebrow">Draw with AI</span>
          <h1>Describe it. AI-Noddle drafts an editable diagram.</h1>
          <p>Type a prompt, drop in a rough sketch, or start from a template. Every shape stays fully editable.</p>
          <div className="hero-input">
            <span>✦</span>
            <span className="ph">e.g. "User login and authentication flow…"</span>
            <span className="go">Generate →</span>
          </div>
        </button>
        <div className="hero-side">
          <button className="hero-card" onClick={() => setTplModal(true)}>
            <div className="ic blue">▦</div>
            <div>
              <div className="t">New board</div>
              <div className="d">Blank or from a template — flowchart, org chart, ERD…</div>
            </div>
          </button>
          <button className="hero-card" onClick={() => startNewWithAI({ mode: "sketch" })}>
            <div className="ic purple">✎</div>
            <div>
              <div className="t">Redraw a sketch</div>
              <div className="d">Upload a whiteboard photo — AI redraws it clean.</div>
            </div>
          </button>
          <label className="hero-card" style={{ cursor: importing ? "wait" : "pointer", position: "relative" }}>
            <div className="ic blue">⇪</div>
            <div>
              <div className="t">{importing ? "Importing…" : "Import file"}</div>
              <div className="d">draw.io (.drawio/.xml), Mermaid (.mmd), SVG, board JSON.</div>
            </div>
            <input
              type="file"
              accept=".svg,.drawio,.xml,.mmd,.mermaid,.json"
              style={{ display: "none" }}
              disabled={importing}
              onChange={(e) => {
                void onImport(e.target.files?.[0] ?? null);
                e.target.value = "";
              }}
            />
            {importError && (
              <div
                className="side-pop"
                role="alert"
                onClick={(e) => {
                  // Keep clicks inside the popover from re-opening the file
                  // picker (we're inside the <label>).
                  e.preventDefault();
                  e.stopPropagation();
                }}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setImportError(null);
                }}
              >
                <p className="side-pop-msg" style={{ color: "var(--danger-text)" }}>
                  Import failed: {importError}
                </p>
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <button
                    className="btn"
                    style={{ fontSize: 12, padding: "3px 10px" }}
                    autoFocus
                    onClick={() => setImportError(null)}
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            )}
          </label>
        </div>
      </div>

      {docs.length === 0 ? (
        <>
          <div className="section-head"><h2>Recent</h2></div>
          <div className="empty-state">
            No boards yet. Click <b>New board</b> or <b>New with AI</b> to get started.
          </div>
        </>
      ) : (
        <HomeBoards docs={docs} folders={folders} openFolder={openFolder} />
      )}
    </div>
  );
}

/**
 * Home organization (Lucid-style): a cross-cutting "Recent" row on top, then
 * one section per folder that has boards, then "Unfiled" for the rest — so a
 * board outside every folder has an explicit, named place instead of being
 * lost in one big grid. With no folders yet, it's just the plain Recent grid.
 */
function HomeBoards({
  docs,
  folders,
  openFolder,
}: {
  docs: DocMeta[];
  folders: FolderOut[];
  openFolder: (f: FolderOut) => void;
}) {
  const byUpdated = [...docs].sort((a, b) => b.updated_at - a.updated_at);
  const recent = byUpdated.slice(0, 4);
  const grouped = folders
    .map((f) => ({ f, items: byUpdated.filter((d) => d.folder_id === f.id) }))
    .filter((g) => g.items.length > 0);
  const unfiled = byUpdated.filter(
    (d) => !d.folder_id || !folders.some((f) => f.id === d.folder_id),
  );

  return (
    <>
      <div className="section-head"><h2>Recent</h2><span className="count">{docs.length}</span></div>
      <DocGrid docs={recent} />

      {grouped.map(({ f, items }) => (
        <div key={f.id}>
          <div className="section-head home-sec">
            <span style={{ color: f.color || "var(--faint)", display: "inline-flex" }}>
              <Icon name="folder" size={15} />
            </span>
            <h2>{esc(f.name)}</h2>
            <span className="count">{items.length}</span>
            <button
              className="btn btn-ghost"
              style={{ fontSize: 12, marginLeft: "auto" }}
              onClick={() => openFolder(f)}
            >
              Open folder →
            </button>
          </div>
          <DocGrid docs={items.slice(0, 4)} />
        </div>
      ))}

      {grouped.length > 0 && unfiled.length > 0 && (
        <div>
          <div className="section-head home-sec">
            <h2>Unfiled</h2>
            <span className="count">{unfiled.length}</span>
            <span className="muted" style={{ fontSize: 12, marginLeft: "auto" }}>
              Tip: use ⋯ → Move to, to file a board into a folder
            </span>
          </div>
          <DocGrid docs={unfiled} />
        </div>
      )}
    </>
  );
}

export function TemplatesView() {
  const tplCat = useAppStore((s) => s.tplCat);
  const setTplCat = useAppStore((s) => s.setTplCat);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const shown = TEMPLATES.filter((t) => tplCat === "All" || t.cat === tplCat);

  const pick = async (tplId: string) => {
    const tpl = TEMPLATES.find((t) => t.id === tplId);
    if (!tpl || busy) return;
    setBusy(tplId);
    setError(null);
    try {
      await createBoard(tpl);
    } catch (e) {
      // Surface quota (402) / auth (401) instead of a silent no-op.
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      // createBoard swallows 402 (→ upgrade card) without navigating, so always
      // clear the per-card spinner here rather than on unmount.
      setBusy(null);
    }
  };

  return (
    <div style={{ animation: "fadeIn .2s ease" }}>
      <p className="section-sub">
        Start from a professionally structured layout, then ask AI-Noddle to adapt it. All templates are fully editable.
      </p>
      <div className="chips">
        {TPL_CATS.map((c) => (
          <button key={c} className={`chip${tplCat === c ? " active" : ""}`} onClick={() => setTplCat(c)}>
            {c}
          </button>
        ))}
      </div>
      {error && (
        <p style={{ color: "var(--danger-text, var(--danger))", fontSize: 13, margin: "0 0 14px" }}>{error}</p>
      )}
      <div className="card-grid">
        {shown.map((t) => (
          <button
            key={t.id}
            className="doc-card"
            disabled={busy !== null}
            onClick={() => void pick(t.id)}
          >
            <div className="tpl-thumb" style={{ background: t.soft }}>
              {busy === t.id ? <span className="tpl-spin" /> : <TemplateThumb tpl={t} />}
              <span className="tpl-cat">{t.cat}</span>
            </div>
            <div className="doc-meta">
              <div className="nm">{t.name}</div>
              <div className="when">{t.count}</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function SharedEmpty({ signedIn }: { signedIn: boolean }) {
  return (
    <div
      style={{
        display: "flex", flexDirection: "column", alignItems: "center",
        justifyContent: "center", textAlign: "center", padding: "72px 24px",
        color: "var(--muted)", gap: 12,
      }}
    >
      <div
        style={{
          width: 56, height: 56, borderRadius: 16, display: "grid",
          placeItems: "center", background: "var(--accent-soft)", color: "var(--accent)",
        }}
      >
        <Icon name="shared" size={26} />
      </div>
      <div style={{ fontWeight: 650, fontSize: 15, color: "var(--text)" }}>
        No shared boards yet
      </div>
      <p style={{ maxWidth: 420, fontSize: 13, lineHeight: 1.5, margin: 0 }}>
        {signedIn
          ? "When someone invites you to a board (by email or team), it will show up here. Boards opened via a share link still go straight to /d/{id}."
          : "This list is tied to your account — sign in to see boards shared with you. Boards opened via a share link still go straight to /d/{id}."}
      </p>
    </div>
  );
}

export function SharedView() {
  // REAL: GET /api/documents/shared — boards someone else owns that this
  // account can access by name (per-user share or team membership).
  const me = useAuthStore((s) => s.me);
  const openInEditor = useAppStore((s) => s.openInEditor);
  const signedIn = me?.kind === "user";
  const [rows, setRows] = useState<SharedDocRow[] | null>(null);

  useEffect(() => {
    if (!signedIn) {
      setRows([]);
      return;
    }
    let alive = true;
    void api.listShared().then((r) => { if (alive) setRows(r); }).catch(() => setRows([]));
    return () => { alive = false; };
  }, [signedIn]);

  if (!signedIn || rows === null || rows.length === 0) {
    return (
      <div style={{ animation: "fadeIn .2s ease" }}>
        {rows === null && signedIn ? null : <SharedEmpty signedIn={signedIn} />}
      </div>
    );
  }

  return (
    <div style={{ animation: "fadeIn .2s ease" }}>
      <table className="shared-table">
        <thead>
          <tr>
            <th>Board</th>
            <th>Owner</th>
            <th>Role</th>
            <th>Via</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} onClick={() => openInEditor(r.id)}>
              <td className="nm">{esc(r.name)}</td>
              <td>
                <span className="owner">
                  <span
                    className="avatar"
                    style={{ width: 20, height: 20, fontSize: 9, background: r.owner?.color ?? "#9aa1ad" }}
                  >
                    {(r.owner?.name ?? "?").slice(0, 2).toUpperCase()}
                  </span>
                  {r.owner?.name ?? "—"}
                </span>
              </td>
              <td>
                <span className={`pill role-${r.my_role}`}>
                  {r.my_role === "viewer" ? "View only" : r.my_role === "owner" ? "Manage" : "Can edit"}
                </span>
              </td>
              <td className="via">{r.via === "team" ? "Team" : "Direct invite"}</td>
              <td className="when">{relTime(r.updated_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function FolderView() {
  const curFolder = useAppStore((s) => s.curFolder);
  const setDashPage = useAppStore((s) => s.setDashPage);
  const docs = useEditorStore((s) => s.docs);
  const inFolder = docs.filter((d) => d.folder_id === curFolder?.id);

  return (
    <div style={{ animation: "fadeIn .2s ease" }}>
      <div className="crumbs">
        <button className="lnk" onClick={() => setDashPage("home")}>Home</button>
        <span>/</span>
        <span className="cur">{curFolder?.name ?? "Folder"}</span>
      </div>
      {inFolder.length === 0 ? (
        <div className="empty-state">
          This folder is empty. Use the <b>⋯</b> menu on a board to move it here.
        </div>
      ) : (
        <DocGrid docs={inFolder} />
      )}
    </div>
  );
}
