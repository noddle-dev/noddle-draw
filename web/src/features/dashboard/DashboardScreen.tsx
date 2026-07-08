/**
 * features/dashboard/DashboardScreen — the dashboard shell: sidebar + top bar
 * (search, notifications, profile) + the active page. Loads the REAL document
 * list on mount so the Home/Folder grids reflect GET /api/documents.
 */
import { useEffect, useState } from "react";
import { useAppStore } from "../../state/appStore";
import { useAuthStore } from "../../state/authStore";
import { useEditorStore } from "../../state/editorStore";
import { MentionsBell } from "../comments/MentionsBell";
import { EMAIL_AUTH_ENABLED } from "../../shared/config";
import { api } from "../../shared/api/client";
import { Icon } from "../../shared/ui";
import { Sidebar } from "./Sidebar";
import { TEMPLATES, createBoard, type TemplateDef } from "./templates";
import { TemplatesModal } from "./TemplatesModal";
import { HomeView, TemplatesView, SharedView, FolderView } from "./views";
import { GamesView } from "../games";

/** One flattened search hit — boards first, then templates. */
type SearchHit =
  | { kind: "board"; id: string; name: string }
  | { kind: "template"; tpl: TemplateDef };

/** Topbar search: filters real boards by name + templates by name/category.
 * Enter/click opens the board (or creates a board from the template). */
function DashSearch() {
  const docs = useEditorStore((s) => s.docs);
  const openInEditor = useAppStore((s) => s.openInEditor);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [idx, setIdx] = useState(0);

  const query = q.trim().toLowerCase();
  const boardHits: SearchHit[] = query
    ? docs
        .filter((d) => (d.name ?? "").toLowerCase().includes(query))
        .slice(0, 6)
        .map((d) => ({ kind: "board", id: d.id, name: d.name ?? "Untitled" }))
    : [];
  const tplHits: SearchHit[] = query
    ? TEMPLATES.filter(
        (t) => t.name.toLowerCase().includes(query) || t.cat.toLowerCase().includes(query),
      )
        .slice(0, 4)
        .map((tpl) => ({ kind: "template", tpl }))
    : [];
  const hits = [...boardHits, ...tplHits];

  const run = (hit: SearchHit) => {
    setOpen(false);
    setQ("");
    if (hit.kind === "board") openInEditor(hit.id);
    else void createBoard(hit.tpl);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open || !hits.length) {
      if (e.key === "Escape") { setQ(""); (e.target as HTMLInputElement).blur(); }
      return;
    }
    if (e.key === "ArrowDown") { e.preventDefault(); setIdx((i) => (i + 1) % hits.length); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setIdx((i) => (i - 1 + hits.length) % hits.length); }
    else if (e.key === "Enter") { e.preventDefault(); run(hits[Math.min(idx, hits.length - 1)]); }
    else if (e.key === "Escape") { setOpen(false); setQ(""); (e.target as HTMLInputElement).blur(); }
  };

  return (
    <div className="dash-search" role="combobox" aria-expanded={open && !!query} aria-haspopup="listbox">
      <Icon name="search" size={15} />
      <input
        aria-label="Search diagrams and templates"
        placeholder="Search diagrams, templates…"
        value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); setIdx(0); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      {open && query && (
        <div className="dash-search-pop" role="listbox">
          {hits.length === 0 && <div className="search-empty">No boards or templates match "{q.trim()}".</div>}
          {boardHits.length > 0 && <div className="search-sec">Boards</div>}
          {boardHits.map((h, i) => (
            <button
              key={h.kind === "board" ? h.id : i}
              className={`search-row${idx === i ? " active" : ""}`}
              role="option"
              aria-selected={idx === i}
              // pointerdown fires before the input's blur → the click still lands.
              onPointerDown={(e) => { e.preventDefault(); run(h); }}
              onMouseEnter={() => setIdx(i)}
            >
              <Icon name="edit" size={14} />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {h.kind === "board" ? h.name : ""}
              </span>
              <span className="hint">Board</span>
            </button>
          ))}
          {tplHits.length > 0 && <div className="search-sec">Templates — creates a new board</div>}
          {tplHits.map((h, i) => {
            const flat = boardHits.length + i;
            const tpl = (h as Extract<SearchHit, { kind: "template" }>).tpl;
            return (
              <button
                key={tpl.id}
                className={`search-row${idx === flat ? " active" : ""}`}
                role="option"
                aria-selected={idx === flat}
                onPointerDown={(e) => { e.preventDefault(); run(h); }}
                onMouseEnter={() => setIdx(flat)}
              >
                <Icon name="templates" size={14} />
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {tpl.name}
                </span>
                <span className="hint">{tpl.cat}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

const TITLES: Record<string, string> = {
  home: "Home",
  templates: "Templates",
  shared: "Shared with me",
  folder: "Folder",
  games: "Team play",
};

function ProfileMenu() {
  const open = useAppStore((s) => s.profileOpen);
  const toggle = useAppStore((s) => s.toggleProfile);
  const openSettings = useAppStore((s) => s.openSettings);
  const promptSignIn = useAppStore((s) => s.promptSignIn);
  const me = useAuthStore((s) => s.me);
  const logout = useAuthStore((s) => s.logout);
  // SSO (ADR-0003): the button shows only when a provider is configured.
  const [ssoEnabled, setSsoEnabled] = useState(false);
  useEffect(() => {
    void api.oidcStatus().then((s) => setSsoEnabled(s.enabled)).catch(() => {});
  }, []);

  const isUser = me?.kind === "user";
  const initials = (me?.name ?? "?").slice(0, 2).toUpperCase();
  // Photo avatar (data URL) when set; fallback stays initials + color.
  const avatarFace = (size: number, fontSize: number) => (
    <span
      className="avatar"
      style={{ width: size, height: size, background: me?.color ?? "var(--accent)", fontSize, overflow: "hidden" }}
    >
      {me?.avatar ? (
        <img
          src={me.avatar}
          alt=""
          style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: "50%" }}
        />
      ) : (
        initials
      )}
    </span>
  );

  return (
    <div className="dash-profile">
      {isUser ? (
        <button className="dash-profile-trigger" aria-label="Open profile menu" onClick={toggle}>
          {avatarFace(31, 12)}
          <span style={{ color: "var(--faint)", fontSize: 10 }}>▾</span>
        </button>
      ) : ssoEnabled ? (
        <a className="btn btn-primary" href="/api/auth/oidc/login">
          Sign in with SSO
        </a>
      ) : EMAIL_AUTH_ENABLED ? (
        <button className="btn btn-primary" onClick={() => promptSignIn("Sign in to your workspace.")}>
          Sign in
        </button>
      ) : null /* no SSO configured, email auth is off — app runs in guest mode */}
      {open && isUser && (
        <div>
          <div className="menu-backdrop" onClick={toggle} />
          <div className="menu-pop">
            <div className="menu-head">
              {avatarFace(40, 15)}
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 650, fontSize: 13.5 }}>{me?.name}</div>
                {me?.title && (
                  <div className="brand-team" style={{ color: "var(--text-2)" }}>{me.title}</div>
                )}
                <div className="brand-team">{me?.email}</div>
              </div>
            </div>
            <div className="menu-body">
              <div className="menu-row" onClick={() => { toggle(); openSettings("profile"); }}>
                <span className="ico"><Icon name="user" size={16} /></span>
                <span style={{ flex: 1 }}>Profile &amp; account</span>
              </div>
              <div className="menu-row" onClick={() => { toggle(); openSettings("credits"); }}>
                <span className="ico">✦</span>
                <span style={{ flex: 1 }}>Credits &amp; billing</span>
              </div>
              <div className="menu-row" onClick={() => { toggle(); openSettings("teams"); }}>
                <span className="ico"><Icon name="shared" size={16} /></span>
                <span style={{ flex: 1 }}>Teams &amp; API tokens</span>
              </div>
              <div
                className="menu-row"
                style={{ color: "var(--danger-text, var(--danger))" }}
                onClick={() => { toggle(); void logout(); }}
              >
                <span className="ico"><Icon name="logout" size={16} /></span>
                <span style={{ flex: 1 }}>Sign out</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function DashboardScreen() {
  const dashPage = useAppStore((s) => s.dashPage);
  const refreshDocs = useEditorStore((s) => s.refreshDocs);
  const loadFolders = useAppStore((s) => s.loadFolders);
  const folders = useAppStore((s) => s.folders);
  const pendingFolderId = useAppStore((s) => s.pendingFolderId);

  useEffect(() => {
    void refreshDocs();
    void loadFolders();
  }, [refreshDocs, loadFolders]);

  // Resolve a /folder/{id} deep link once the folder list has loaded.
  useEffect(() => {
    if (!pendingFolderId) return;
    const f = folders.find((x) => x.id === pendingFolderId);
    if (f) {
      useAppStore.setState({ pendingFolderId: null });
      useAppStore.getState().openFolder(f);
    }
  }, [folders, pendingFolderId]);

  return (
    <div className="dash">
      <Sidebar />
      <div className="dash-main">
        <div className="dash-topbar">
          <div className="dash-title">{TITLES[dashPage] ?? "Home"}</div>
          <div style={{ flex: 1, display: "flex", justifyContent: "center" }}>
            <DashSearch />
          </div>
          <MentionsBell />
          <ProfileMenu />
        </div>

        <div className="dash-scroll">
          <div className="dash-inner">
            {dashPage === "home" && <HomeView />}
            {dashPage === "templates" && <TemplatesView />}
            {dashPage === "shared" && <SharedView />}
            {dashPage === "games" && <GamesView />}
            {dashPage === "folder" && <FolderView />}
          </div>
        </div>
      </div>
      <TemplatesModal />
    </div>
  );
}
