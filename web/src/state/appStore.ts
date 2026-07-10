/**
 * state/appStore — the shell state (Zustand).
 *
 * Owns navigation between the two product screens (editor ↔ generate) with
 * real URL sync (/d/{docId} is the shareable address of a board), the
 * Templates picker modal, the generate flow, editor panel tabs and page
 * settings. `/` is Excalidraw-style: it reopens the browser's most recent
 * board (localStorage) or auto-creates a fresh one.
 *
 * It is deliberately separate from editorStore/diagramStore, which remain the
 * source of truth for the REAL editing engine (DOM, camera, selection, history)
 * and persistence/AI. Nothing here touches the engine — screens read both
 * stores and wire real actions themselves.
 */
import { create } from "zustand";
import { api } from "../shared/api/client";
import { getIdentity } from "./collabStore";

export type View = "generate" | "editor";
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
}

interface BoardChats {
  sessions: ChatSession[];
  activeId: string;
}

// ---- last-board persistence (the Excalidraw-style "/" behavior) -------------

const LAST_BOARD_KEY = "noddle.lastBoardId";
const RECENTS_KEY = "noddle.recentBoards";
const RECENTS_CAP = 20;

export interface RecentBoard {
  id: string;
  name: string;
  at: number;
}

export function lastBoardId(): string | null {
  try {
    const id = localStorage.getItem(LAST_BOARD_KEY);
    return id && /^[0-9a-f]{12}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

export function clearLastBoardId(): void {
  try {
    localStorage.removeItem(LAST_BOARD_KEY);
  } catch {
    /* storage blocked */
  }
}

export function recentBoards(): RecentBoard[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (r): r is RecentBoard =>
        r && typeof r.id === "string" && /^[0-9a-f]{12}$/.test(r.id),
    );
  } catch {
    return [];
  }
}

/** Remember the board this browser is working on (drives `/` + the Boards menu). */
export function rememberBoard(id: string, name: string): void {
  try {
    localStorage.setItem(LAST_BOARD_KEY, id);
    const rest = recentBoards().filter((r) => r.id !== id);
    const next = [{ id, name, at: Date.now() }, ...rest].slice(0, RECENTS_CAP);
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    /* storage blocked — "/" will just create fresh boards */
  }
}

export function forgetBoard(id: string): void {
  try {
    if (localStorage.getItem(LAST_BOARD_KEY) === id) clearLastBoardId();
    localStorage.setItem(
      RECENTS_KEY,
      JSON.stringify(recentBoards().filter((r) => r.id !== id)),
    );
  } catch {
    /* storage blocked */
  }
}

/** Push a URL without reloading; no-op when already there. */
function pushUrl(path: string) {
  if (typeof history !== "undefined" && location.pathname !== path) {
    history.pushState({}, "", path);
  }
}

/** Replace the URL (boot redirects: Back should leave the site, not bounce). */
function replaceUrl(path: string) {
  if (typeof history !== "undefined" && location.pathname !== path) {
    history.replaceState({}, "", path);
  }
}

interface AppState {
  // ---- navigation ----
  view: View;
  /** Doc id to load once the editor's canvas has mounted. */
  pendingDocId: string | null;
  /** Raw SVG (e.g. from image→SVG) to load once the canvas has mounted. */
  pendingSvg: string | null;

  /** Lucid-style Templates picker modal (New board). */
  tplCat: string;
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
  /** Left/right rail visibility — declutter without leaving the editor.
   * Toggle with `[` / `]`; focus mode hides everything (`\`, Esc exits). */
  leftPanelOpen: boolean;
  rightPanelOpen: boolean;
  focusMode: boolean;
  toggleLeftPanel: () => void;
  toggleRightPanel: () => void;
  toggleFocusMode: (on?: boolean) => void;
  /** Keyboard-shortcut cheat sheet (? opens, Esc/click closes). */
  shortcutsOpen: boolean;
  setShortcutsOpen: (open: boolean) => void;

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

  // ---- actions ----
  go: (view: View) => void;
  /** `/` behavior: reopen the last board, else create a fresh one. */
  bootHome: () => void;
  openInEditor: (docId: string, opts?: { replace?: boolean }) => void;
  openSvgInEditor: (svg: string) => void;
  consumePending: () => void;
  setTplCat: (c: string) => void;
  setTplModal: (open: boolean) => void;

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
  setAiThinking: (v: boolean) => void;
}

/**
 * Chat storage key — ISOLATED per (identity, board). Chats never travel over
 * collab (only diagram state does), so collaborators already have separate
 * conversations.
 */
export const chatKey = (docId: string | null): string =>
  `g:${getIdentity().name}::${docId ?? "__scratch__"}`;

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

export const useAppStore = create<AppState>((set) => ({
  view: "editor",
  pendingDocId: null,
  pendingSvg: null,

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
  leftPanelOpen: true,
  rightPanelOpen: true,
  focusMode: false,
  toggleLeftPanel: () => set((s) => ({ leftPanelOpen: !s.leftPanelOpen })),
  toggleRightPanel: () => set((s) => ({ rightPanelOpen: !s.rightPanelOpen })),
  toggleFocusMode: (on) =>
    set((s) => ({ focusMode: on ?? !s.focusMode })),
  shortcutsOpen: false,
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),

  gridOn: true,
  snapOn: true,

  chats: loadChats(),
  aiThinking: false,
  queuedChats: 0,

  go: (view) => {
    if (view === "generate") pushUrl("/generate");
    set({ view });
  },
  bootHome: () => {
    const last = lastBoardId();
    if (last) {
      // Straight into the board you were drawing (Excalidraw semantics).
      replaceUrl(`/d/${last}`);
      set({ view: "editor", pendingDocId: last, pendingSvg: null });
      return;
    }
    // First visit: mint a board, then land in it (replace — Back leaves the
    // site instead of bouncing between "/" and "/d/{id}").
    set({ view: "editor", pendingDocId: null, pendingSvg: null });
    void api
      .create({ name: "Untitled board" })
      .then((meta) => {
        rememberBoard(meta.id, meta.name);
        replaceUrl(`/d/${meta.id}`);
        set({ pendingDocId: meta.id });
      })
      .catch(() => {
        /* backend down — the editor shows an empty scratch board */
      });
  },
  openInEditor: (docId, opts) => {
    (opts?.replace ? replaceUrl : pushUrl)(`/d/${docId}`);
    set({
      view: "editor",
      pendingDocId: docId,
      pendingSvg: null,
      tplModalOpen: false,
    });
  },
  openSvgInEditor: (svg) =>
    set({ view: "editor", pendingSvg: svg, pendingDocId: null }),
  consumePending: () => set({ pendingDocId: null, pendingSvg: null }),
  setTplCat: (tplCat) => set({ tplCat }),
  setTplModal: (tplModalOpen) => set({ tplModalOpen }),

  setGenMode: (genMode) => set({ genMode }),
  startNewWithAI: (opts) => {
    pushUrl("/generate");
    set({
      view: "generate",
      tplModalOpen: false,
      genMode: opts?.mode ?? "text",
      seedPrompt: opts?.prompt ?? "",
    });
  },
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

  setAiThinking: (aiThinking) => set({ aiThinking }),
}));

/** Parse the current location into shell state (boot + popstate). */
export function applyLocation() {
  const m = location.pathname.match(/^\/d\/([0-9a-f]{12})$/);
  const em = location.pathname.match(/^\/embed\/([0-9a-f]{12})$/);
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
  } else if (location.pathname === "/generate") {
    useAppStore.setState({ view: "generate" });
  } else {
    // "/" (and anything unknown): reopen the last board or mint a fresh one.
    useAppStore.getState().bootHome();
  }
}
