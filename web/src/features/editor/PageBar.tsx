/**
 * features/editor/PageBar — Lucid-style bottom page tabs.
 *
 * Tabs for each page + a per-tab ⋯ menu (Rename / Duplicate / Hide / Delete) +
 * ＋ add page. Icons are hand-drawn doodle inline SVG (no AI-look glyphs), to
 * match the sketchy board aesthetic. Renders only for boards that have pages
 * (diagram boards); uploaded-SVG docs with no diagram show nothing. Autosave
 * picks up page changes automatically.
 *
 * Hidden pages: the tab is still shown (dimmed, with a "hidden" dot + a Show
 * action) but present/export skip it — see EditorScreen PresentHud + useExport.
 */
import { useEffect, useRef, useState } from "react";
import { usePagesStore } from "../../state/pagesStore";
import { useEditorStore } from "../../state/editorStore";

/* --- doodle icons (rough single-stroke, currentColor) ------------------- */
function Doodle({ children }: { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}
const IconMore = () => (
  <Doodle>
    <path d="M5.5 12h.02M12 12h.02M18.5 12h.02" strokeWidth="2.6" />
  </Doodle>
);
const IconRename = () => (
  <Doodle>
    <path d="M4 20c1-.3 2.2-.4 3-1L18 8c1-1 1-2 0-3s-2-1-3 0L4 16c-.6.8-.7 2-1 4Z" />
    <path d="M13.5 6.5 17 10" />
  </Doodle>
);
const IconDuplicate = () => (
  <Doodle>
    <path d="M9 9.5c-.3-2 0-3.5 2-3.7 2.2-.2 5-.2 7 0 1.7.2 2 1.6 2 4 0 2.2 0 4.6-.2 6-.2 1.7-1.7 1.9-3.8 1.9" />
    <path d="M4.2 13.5c-.2 2 0 4.2.2 5.6.2 1.5 1.4 1.7 3.4 1.8 2 .1 4 .1 5.6 0 1.7-.2 1.9-1.6 1.9-3.8 0-2 0-4-.2-5.3-.2-1.6-1.5-1.8-3.5-1.9-2-.1-4.4-.1-5.5.1-1.4.2-1.7 1.5-1.9 3.5Z" />
  </Doodle>
);
const IconHide = () => (
  <Doodle>
    <path d="M2.5 12c2.5-4 6-6 9.5-6s7 2 9.5 6c-2.5 4-6 6-9.5 6a11 11 0 0 1-4-.8" />
    <path d="M9.5 9.6a3.4 3.4 0 0 0 4.8 4.8" />
    <path d="M3.5 3.5 20.5 20.5" />
  </Doodle>
);
const IconShow = () => (
  <Doodle>
    <path d="M2.5 12c2.5-4.2 6-6.2 9.5-6.2S19 7.8 21.5 12c-2.5 4.2-6 6.2-9.5 6.2S5 16.2 2.5 12Z" />
    <path d="M9.4 9.7a3.5 3.5 0 1 0 5.2 4.6 3.5 3.5 0 0 0-5.2-4.6Z" />
  </Doodle>
);
const IconTrash = () => (
  <Doodle>
    <path d="M4 6.5c4.5-.6 11-.6 16 0" />
    <path d="M6.5 6.5c.2 5 .3 9 .6 11.5.2 1.6 1.4 1.8 4.9 1.8s4.7-.2 4.9-1.8c.3-2.5.4-6.5.6-11.5" />
    <path d="M9 6c0-1.8.4-2.5 3-2.5S15 4.2 15 6" />
  </Doodle>
);

export function PageBar() {
  const pages = usePagesStore((s) => s.pages);
  const activeId = usePagesStore((s) => s.activeId);
  const switchPage = usePagesStore((s) => s.switchPage);
  const addPage = usePagesStore((s) => s.addPage);
  const duplicatePage = usePagesStore((s) => s.duplicatePage);
  const renamePage = usePagesStore((s) => s.renamePage);
  const setPageHidden = usePagesStore((s) => s.setPageHidden);
  const deletePage = usePagesStore((s) => s.deletePage);
  const viewer = useEditorStore((s) => s.myRole === "viewer");
  const [menuFor, setMenuFor] = useState<string | null>(null);
  // Fixed-viewport coords for the open menu — the page-bar has overflow-x:auto
  // (which forces overflow-y:auto too), so an absolutely-positioned dropdown
  // gets CLIPPED inside the bar. Positioning it `fixed` escapes that clip.
  const [menuPos, setMenuPos] = useState<{ left: number; bottom: number } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Esc closes the open menu; focus moves into the menu when it opens.
  useEffect(() => {
    if (!menuFor) return;
    menuRef.current?.querySelector<HTMLElement>("[data-menu-item]")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuFor(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuFor]);

  if (pages.length === 0) return null;

  const beginRename = (id: string, name: string) => {
    setMenuFor(null);
    setDraft(name);
    setEditingId(id);
  };
  const commitRename = () => {
    if (editingId) renamePage(editingId, draft);
    setEditingId(null);
  };
  const confirmDelete = (id: string, name: string) => {
    setMenuFor(null);
    if (window.confirm(`Delete page "${name}"? This can't be undone.`)) {
      deletePage(id);
    }
  };

  return (
    <div className="page-bar">
      <span className="page-bar-icon" title="Page list">☰</span>
      {pages.map((p) => {
        const hidden = p.hidden === true;
        return (
          <div
            key={p.id}
            className={`page-tab${p.id === activeId ? " active" : ""}${hidden ? " page-tab-hidden" : ""}`}
          >
            {editingId === p.id ? (
              <input
                className="page-tab-input"
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename();
                  else if (e.key === "Escape") setEditingId(null);
                }}
              />
            ) : (
              <button
                className="page-tab-name"
                onClick={() => switchPage(p.id)}
                onDoubleClick={() => !viewer && beginRename(p.id, p.name)}
              >
                {hidden && <span className="page-tab-hidden-dot" title="Hidden from present/export" />}
                {p.name}
              </button>
            )}
            {!viewer && editingId !== p.id && (
              <button
                className="page-tab-more"
                aria-label={`Page options for ${p.name}`}
                aria-haspopup="menu"
                aria-expanded={menuFor === p.id}
                onClick={(e) => {
                  if (menuFor === p.id) {
                    setMenuFor(null);
                    return;
                  }
                  const r = e.currentTarget.getBoundingClientRect();
                  setMenuPos({
                    left: Math.max(8, Math.min(r.left, window.innerWidth - 184)),
                    bottom: window.innerHeight - r.top + 6, // open upward
                  });
                  setMenuFor(p.id);
                }}
              >
                <IconMore />
              </button>
            )}
            {menuFor === p.id && menuPos && (
              <>
                <div className="menu-backdrop" onClick={() => setMenuFor(null)} />
                <div
                  ref={menuRef}
                  className="page-tab-menu"
                  role="menu"
                  aria-label={`${p.name} options`}
                  style={{ position: "fixed", left: menuPos.left, bottom: menuPos.bottom, top: "auto" }}
                >
                  <button
                    className="page-tab-menu-row"
                    role="menuitem"
                    data-menu-item
                    onClick={() => beginRename(p.id, p.name)}
                  >
                    <span className="ico"><IconRename /></span>
                    <span className="lbl">Rename</span>
                  </button>
                  <button
                    className="page-tab-menu-row"
                    role="menuitem"
                    data-menu-item
                    onClick={() => { setMenuFor(null); duplicatePage(p.id); }}
                  >
                    <span className="ico"><IconDuplicate /></span>
                    <span className="lbl">Duplicate</span>
                  </button>
                  <button
                    className="page-tab-menu-row"
                    role="menuitem"
                    data-menu-item
                    onClick={() => { setMenuFor(null); setPageHidden(p.id, !hidden); }}
                  >
                    <span className="ico">{hidden ? <IconShow /> : <IconHide />}</span>
                    <span className="lbl">{hidden ? "Show" : "Hide"}</span>
                  </button>
                  {pages.length > 1 && (
                    <button
                      className="page-tab-menu-row page-tab-menu-danger"
                      role="menuitem"
                      data-menu-item
                      onClick={() => confirmDelete(p.id, p.name)}
                    >
                      <span className="ico"><IconTrash /></span>
                      <span className="lbl">Delete</span>
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        );
      })}
      {!viewer && (
        <button className="page-add" title="Add page" onClick={addPage}>＋</button>
      )}
    </div>
  );
}
