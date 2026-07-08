/**
 * state/appStore — the shell state (Zustand).
 *
 * Owns navigation between the three product screens (dashboard → generate →
 * editor) with real URL sync (/d/{docId} is the shareable address of a board),
 * the dashboard's server-backed folders, the Templates picker modal, the
 * generate flow, editor panel tabs and page settings.
 *
 * It is deliberately separate from editorStore/diagramStore, which remain the
 * source of truth for the REAL editing engine (DOM, camera, selection, history)
 * and persistence/AI. Nothing here touches the engine — screens read both
 * stores and wire real actions themselves.
 */
import { create } from "zustand";
import { api, type FolderOut } from "../shared/api/client";
import { useAuthStore } from "./authStore";
import { getIdentity } from "./collabStore";

export type View = "dashboard" | "generate" | "editor" | "game" | "settings";
export type SettingsTab = "profile" | "credits" | "usage" | "ai" | "tokens" | "teams";
export type GameType = "draw" | "trivia" | "wordbomb";
export type DashPage = "home" | "templates" | "shared" | "folder" | "games";
export type GenMode = "text" | "sketch" | "mermaid";
export type LeftTab = "shapes" | "layers";
export type RightTab = "props" | "claude";

export interface ChatMessage {
  who: "ai" | "you";
  text: string;
  /** Optional reference image sent with the message (data URL) — shown as a
   * small thumbnail in the bubble. Only on "you" messages that attached one. */
  image?: string;
}

/** Token usage accumulated over a chat session (cost tracking). */
export interface ChatUsage {
  calls: number;
  prompt: number;
  completion: number;
}

/** One conversation on a board. A board can hold several (init on first msg). */
export interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  usage: ChatUsage;
  /** Databricks serving-endpoint the session sends edits to (see CHAT_MODELS). */
  model?: string;
}

/**
 * Selectable AI models for a chat session. The value is the Databricks
 * serving-endpoint name (the backend whitelists names starting with
 * "databricks-" and otherwise falls back to its default endpoint).
 */
export const CHAT_MODELS: { value: string; label: string }[] = [
  { value: "databricks-claude-opus-4-8", label: "Claude Opus 4.8 · default" },
  { value: "databricks-claude-3-7-sonnet", label: "Claude Sonnet · faster" },
];
export const DEFAULT_CHAT_MODEL = CHAT_MODELS[0].value;

interface BoardChats {
  sessions: ChatSession[];
  activeId: string;
}

/** Push a URL without reloading; no-op when already there. */
function pushUrl(path: string) {
  if (typeof history !== "undefined" && location.pathname !== path) {
    history.pushState({}, "", path);
  }
}

/** URL for a dashboard page (home lives at "/"). Folder uses /folder/{id}. */
function dashPath(page: DashPage): string {
  switch (page) {
    case "templates": return "/templates";
    case "shared": return "/shared";
    case "games": return "/games";
    default: return "/"; // home (folder is pushed by openFolder with its id)
  }
}

interface AppState {
  // ---- navigation ----
  view: View;
  dashPage: DashPage;
  curFolder: FolderOut | null;
  profileOpen: boolean;
  /** Doc id to load once the editor's canvas has mounted. */
  pendingDocId: string | null;
  /** Raw SVG (e.g. from image→SVG) to load once the canvas has mounted. */
  pendingSvg: string | null;
  /** Active game room id (view === "game"). */
  gameRoomId: string | null;
  /** Which game the active room is (routes to the right room component). */
  gameType: GameType;
  /** Folder id from a /folder/{id} deep link, resolved once folders load. */
  pendingFolderId: string | null;

  // ---- dashboard (folders are REAL — server-backed) ----
  folders: FolderOut[];
  tplCat: string;
  /** Lucid-style Templates picker modal (New board). */
  tplModalOpen: boolean;

  // ---- generate ----
  genMode: GenMode;
  seedPrompt: string;
  generating: boolean;
  genStep: number;
  genTotal: number;

  // ---- editor UI ----
  leftTab: LeftTab;
  rightTab: RightTab;
  commentOpen: boolean;
  /** Read-only iframe mode (/embed/{id}) — chrome hidden, no collab join. */
  embedMode: boolean;
  /** Presentation mode (#16) — fullscreen, pages become slides (←/→, Esc). */
  presenting: boolean;
  setPresenting: (on: boolean) => void;

  // ---- page settings ----
  gridOn: boolean;
  snapOn: boolean;

  // ---- Claude chat (live co-editor) ----
  /** PER-BOARD chat, keyed by docId — each board owns several graph-scoped
   * sessions (never shared across boards). */
  chats: Record<string, BoardChats>;
  aiThinking: boolean;
  /** Messages waiting in the sequential edit queue (input never locks). */
  queuedChats: number;

  /** Why the login screen is being shown (e.g. "Sign in to view this board."). */
  authNotice: string | null;
  /** Board to reopen automatically once the user signs in (guest hit a 401/403). */
  authRetryDocId: string | null;

  // ---- actions ----
  go: (view: View) => void;
  /** Route a signed-out user to the login screen with a contextual message. */
  promptSignIn: (notice: string, retryDocId?: string) => void;
  clearAuthPrompt: () => void;
  /** Which settings section is open (full-page /settings route). */
  settingsTab: SettingsTab;
  /** Open the full-page settings screen at an optional section. */
  openSettings: (tab?: SettingsTab) => void;
  /** Upgrade prompt: the 402 reason to show, or null when the card is closed. */
  upgradeReason: string | null;
  showUpgrade: (reason: string) => void;
  hideUpgrade: () => void;
  /** Open a multiplayer game room at /play/{roomId} (draw) or /play/{type}/{roomId}. */
  openGame: (roomId: string, gameType?: GameType) => void;
  openInEditor: (docId: string) => void;
  openSvgInEditor: (svg: string) => void;
  consumePending: () => void;
  setDashPage: (p: DashPage) => void;
  openFolder: (f: FolderOut) => void;
  toggleProfile: () => void;
  setTplCat: (c: string) => void;
  setTplModal: (open: boolean) => void;

  loadFolders: () => Promise<void>;
  createFolder: (name: string) => Promise<void>;
  renameFolder: (id: string, name: string) => Promise<void>;
  /** Set a folder's color tag (keeps its current name). */
  setFolderColor: (id: string, color: string) => Promise<void>;
  deleteFolder: (id: string) => Promise<void>;

  setGenMode: (m: GenMode) => void;
  startNewWithAI: (opts?: { mode?: GenMode; prompt?: string }) => void;
  startGenerating: (total: number) => void;
  setGenStep: (n: number) => void;
  stopGenerating: () => void;

  setLeftTab: (t: LeftTab) => void;
  setRightTab: (t: RightTab) => void;
  toggleComment: () => void;
  toggleGrid: () => void;
  toggleSnap: () => void;

  /** Append a message to a board's ACTIVE session (auto-inits the first one). */
  pushChat: (docId: string | null, m: ChatMessage) => void;
  /** Add token usage to a board's active session (cost tracking). */
  addChatUsage: (docId: string | null, u: { prompt: number; completion: number }) => void;
  /** Start a fresh session on a board and make it active. */
  newChatSession: (docId: string | null) => void;
  /** Switch the active session of a board. */
  switchChatSession: (docId: string | null, sessionId: string) => void;
  /** Set the AI model used by a session (falls back to the active session). */
  setChatModel: (docId: string | null, sessionId: string, model: string) => void;
  setAiThinking: (v: boolean) => void;
}

/**
 * Chat storage key — ISOLATED per (identity, board). Chats never travel over
 * collab (only diagram state does), so collaborators already have separate
 * conversations; folding the identity in also stops one person's chat from
 * showing after an account switch in the same browser tab.
 */
export const chatKey = (docId: string | null): string => {
  const me = useAuthStore.getState().me;
  const who =
    me && me.kind === "user" && me.id
      ? `u:${me.id}`
      : `g:${getIdentity().name}`; // guest → per-tab name
  return `${who}::${docId ?? "__scratch__"}`;
};

function mintSessionId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID().slice(0, 8);
  return Math.random().toString(36).slice(2, 10);
}
function freshSession(n = 1): ChatSession {
  return {
    id: mintSessionId(),
    title: `Session ${n}`,
    messages: [],
    usage: { calls: 0, prompt: 0, completion: 0 },
    model: DEFAULT_CHAT_MODEL,
  };
}
/** Get (creating if absent) the board's chat state. */
function ensureBoard(chats: Record<string, BoardChats>, key: string): BoardChats {
  const existing = chats[key];
  if (existing && existing.sessions.length) return existing;
  const s = freshSession();
  return { sessions: [s], activeId: s.id };
}

// Chat sessions survive a page reload (per tab). Best-effort — quota/privacy
// errors just mean an empty history.
const CHATS_KEY = "noddle-chats-v2";

function loadChats(): Record<string, BoardChats> {
  try {
    return JSON.parse(sessionStorage.getItem(CHATS_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function persistChats(chats: Record<string, BoardChats>) {
  try {
    sessionStorage.setItem(CHATS_KEY, JSON.stringify(chats));
  } catch {
    /* quota — skip */
  }
}

export const useAppStore = create<AppState>((set, get) => ({
  view: "dashboard",
  authNotice: null,
  authRetryDocId: null,
  settingsTab: "profile",
  upgradeReason: null,
  gameRoomId: null,
  gameType: "draw",
  pendingFolderId: null,
  dashPage: "home",
  curFolder: null,
  profileOpen: false,
  pendingDocId: null,
  pendingSvg: null,

  folders: [],
  tplCat: "All",
  tplModalOpen: false,

  genMode: "text",
  seedPrompt: "",
  generating: false,
  genStep: 0,
  genTotal: 4,

  leftTab: "shapes",
  rightTab: "props",
  commentOpen: false,
  embedMode: false,
  presenting: false,
  setPresenting: (on) => set({ presenting: on }),

  gridOn: true,
  snapOn: true,

  chats: loadChats(),
  aiThinking: false,
  queuedChats: 0,

  go: (view) => {
    // Returning to the dashboard restores the URL of the page you were on
    // (so Back from a board/game lands on the right tab, and reload keeps it).
    if (view === "dashboard") pushUrl(dashPath(get().dashPage));
    else if (view === "generate") pushUrl("/");
    set({ view, profileOpen: false });
  },
  openGame: (roomId, gameType = "draw") => {
    pushUrl(gameType === "draw" ? `/play/${roomId}` : `/play/${gameType}/${roomId}`);
    set({ view: "game", gameRoomId: roomId, gameType, profileOpen: false });
  },
  openSettings: (tab = "profile") => {
    pushUrl("/settings");
    set({ view: "settings", settingsTab: tab, profileOpen: false });
  },
  showUpgrade: (upgradeReason) => set({ upgradeReason }),
  hideUpgrade: () => set({ upgradeReason: null }),
  openInEditor: (docId) => {
    pushUrl(`/d/${docId}`);
    set({
      view: "editor",
      pendingDocId: docId,
      pendingSvg: null,
      profileOpen: false,
      tplModalOpen: false,
    });
  },
  openSvgInEditor: (svg) =>
    set({ view: "editor", pendingSvg: svg, pendingDocId: null, profileOpen: false }),
  consumePending: () => set({ pendingDocId: null, pendingSvg: null }),
  setDashPage: (dashPage) => {
    pushUrl(dashPath(dashPage));
    set({ dashPage, curFolder: null, profileOpen: false });
  },
  openFolder: (curFolder) => {
    pushUrl(`/folder/${curFolder.id}`);
    set({ dashPage: "folder", curFolder });
  },
  toggleProfile: () => set((s) => ({ profileOpen: !s.profileOpen })),
  promptSignIn: (authNotice, retryDocId) => {
    pushUrl("/");
    set({
      view: "dashboard", // guests see the LoginScreen at this view (App.tsx gate)
      authNotice,
      authRetryDocId: retryDocId ?? null,
      profileOpen: false,
    });
  },
  clearAuthPrompt: () => set({ authNotice: null, authRetryDocId: null }),
  setTplCat: (tplCat) => set({ tplCat }),
  setTplModal: (tplModalOpen) => set({ tplModalOpen }),

  async loadFolders() {
    try {
      set({ folders: await api.listFolders() });
    } catch {
      set({ folders: [] });
    }
  },
  async createFolder(name) {
    await api.createFolder(name);
    await get().loadFolders();
  },
  async renameFolder(id, name) {
    await api.renameFolder(id, name);
    await get().loadFolders();
  },
  async setFolderColor(id, color) {
    const f = get().folders.find((x) => x.id === id);
    await api.renameFolder(id, f?.name ?? "Folder", color);
    await get().loadFolders();
  },
  async deleteFolder(id) {
    await api.deleteFolder(id);
    const cur = get().curFolder;
    if (cur?.id === id) set({ dashPage: "home", curFolder: null });
    await get().loadFolders();
  },

  setGenMode: (genMode) => set({ genMode }),
  startNewWithAI: (opts) =>
    set({
      view: "generate",
      profileOpen: false,
      tplModalOpen: false,
      genMode: opts?.mode ?? "text",
      seedPrompt: opts?.prompt ?? "",
    }),
  startGenerating: (genTotal) => set({ generating: true, genStep: 0, genTotal }),
  setGenStep: (genStep) => set({ genStep }),
  stopGenerating: () => set({ generating: false, genStep: 0 }),

  setLeftTab: (leftTab) => set({ leftTab }),
  setRightTab: (rightTab) => set({ rightTab }),
  toggleComment: () => set((s) => ({ commentOpen: !s.commentOpen })),
  toggleGrid: () => set((s) => ({ gridOn: !s.gridOn })),
  toggleSnap: () => set((s) => ({ snapOn: !s.snapOn })),

  pushChat: (docId, m) =>
    set((s) => {
      const key = chatKey(docId);
      const board = ensureBoard(s.chats, key);
      const sessions = board.sessions.map((sess) =>
        sess.id === board.activeId ? { ...sess, messages: [...sess.messages, m] } : sess,
      );
      const chats = { ...s.chats, [key]: { ...board, sessions } };
      persistChats(chats);
      return { chats };
    }),

  addChatUsage: (docId, u) =>
    set((s) => {
      const key = chatKey(docId);
      const board = ensureBoard(s.chats, key);
      const sessions = board.sessions.map((sess) =>
        sess.id === board.activeId
          ? {
              ...sess,
              usage: {
                calls: sess.usage.calls + 1,
                prompt: sess.usage.prompt + (u.prompt || 0),
                completion: sess.usage.completion + (u.completion || 0),
              },
            }
          : sess,
      );
      const chats = { ...s.chats, [key]: { ...board, sessions } };
      persistChats(chats);
      return { chats };
    }),

  newChatSession: (docId) =>
    set((s) => {
      const key = chatKey(docId);
      const board = ensureBoard(s.chats, key);
      const sess = freshSession(board.sessions.length + 1);
      const chats = { ...s.chats, [key]: { sessions: [...board.sessions, sess], activeId: sess.id } };
      persistChats(chats);
      return { chats };
    }),

  switchChatSession: (docId, sessionId) =>
    set((s) => {
      const key = chatKey(docId);
      const board = ensureBoard(s.chats, key);
      if (!board.sessions.some((x) => x.id === sessionId)) return {};
      const chats = { ...s.chats, [key]: { ...board, activeId: sessionId } };
      persistChats(chats);
      return { chats };
    }),

  setChatModel: (docId, sessionId, model) =>
    set((s) => {
      const key = chatKey(docId);
      const board = ensureBoard(s.chats, key);
      const targetId = board.sessions.some((x) => x.id === sessionId)
        ? sessionId
        : board.activeId;
      const sessions = board.sessions.map((sess) =>
        sess.id === targetId ? { ...sess, model } : sess,
      );
      const chats = { ...s.chats, [key]: { ...board, sessions } };
      persistChats(chats);
      return { chats };
    }),

  setAiThinking: (aiThinking) => set({ aiThinking }),
}));

/** Parse the current location into shell state (boot + popstate). */
export function applyLocation() {
  const m = location.pathname.match(/^\/d\/([0-9a-f]{12})$/);
  const em = location.pathname.match(/^\/embed\/([0-9a-f]{12})$/);
  const g = location.pathname.match(/^\/play\/([0-9a-f]{12})$/);
  const gt = location.pathname.match(/^\/play\/(trivia|wordbomb)\/([0-9a-f]{12})$/);
  const fo = location.pathname.match(/^\/folder\/([0-9a-f]{12})$/);
  if (em) {
    // Read-only iframe view: same editor shell, chrome hidden via embedMode.
    useAppStore.setState({
      view: "editor",
      pendingDocId: em[1],
      pendingSvg: null,
      embedMode: true,
    });
  } else if (m) {
    useAppStore.setState({
      view: "editor",
      pendingDocId: m[1],
      pendingSvg: null,
    });
  } else if (gt) {
    useAppStore.setState({ view: "game", gameRoomId: gt[2], gameType: gt[1] as GameType });
  } else if (g) {
    useAppStore.setState({ view: "game", gameRoomId: g[1], gameType: "draw" });
  } else if (location.pathname === "/templates") {
    useAppStore.setState({ view: "dashboard", dashPage: "templates", curFolder: null });
  } else if (location.pathname === "/shared") {
    useAppStore.setState({ view: "dashboard", dashPage: "shared", curFolder: null });
  } else if (location.pathname === "/games") {
    useAppStore.setState({ view: "dashboard", dashPage: "games", curFolder: null });
  } else if (location.pathname === "/settings") {
    useAppStore.setState({ view: "settings" });
  } else if (fo) {
    // Folder deep link — mark the page + remember the id; DashboardScreen
    // resolves it to the real folder once the folder list has loaded.
    useAppStore.setState({ view: "dashboard", dashPage: "folder", pendingFolderId: fo[1] });
  } else {
    useAppStore.setState({ view: "dashboard", dashPage: "home", curFolder: null });
  }
}
