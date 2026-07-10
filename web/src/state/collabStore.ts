/**
 * state/collabStore — REAL live collaboration client.
 *
 * Connects to the backend room ``/ws/documents/{docId}`` (same origin — anyone
 * with the /d/{id} share link joins, no auth). Protocol: full-state
 * last-write-wins (see backend app/api/collab.py).
 *
 *   outgoing: hello (identity) · state (on local diagram change, throttled)
 *             · cursor (content coords, throttled)
 *   incoming: init (room state for late joiners) · state (apply to
 *             diagramStore with an echo-suppression flag) · cursor/presence/bye
 *
 * The random guest identity is auto-generated once into localStorage — a
 * stable per-browser "user" without any login (rename via the Share dialog).
 */
import { create } from "zustand";
import { useDiagramStore } from "./diagramStore";
import { pauseHistory } from "./diagramHistory";

/** Per-TAB connection id. Dedups presence across RECONNECTS of this page
 * (network blip, rename → disconnect+connect) while letting two tabs of the
 * same browser coexist as two peers — a browser-wide id (localStorage) made
 * tabs evict each other in a 2s kick loop. Module-scoped on purpose: a clean
 * reload closes the socket (no ghost) and mints a fresh id. */
const tabId = (() => {
  try {
    return crypto.randomUUID();
  } catch {
    return `t-${Math.random().toString(36).slice(2, 12)}`;
  }
})();

export interface Peer {
  id: number;
  name: string;
  color: string;
}

export interface RemoteCursor extends Peer {
  x: number;
  y: number;
  /** last update (ms) — stale cursors are pruned */
  at: number;
  /** The sender's active page — cursors only render for viewers of the SAME
   * page (null = legacy client, shown everywhere). */
  pageId?: string | null;
}

interface CollabState {
  connected: boolean;
  you: number | null;
  peers: Peer[];
  cursors: Record<number, RemoteCursor>;
}

export const useCollabStore = create<CollabState>(() => ({
  connected: false,
  you: null,
  peers: [],
  cursors: {},
}));

// ---- guest identity ---------------------------------------------------------

const COLORS = ["#ec4899", "#d97706", "#16a34a", "#0891b2", "#7c3aed", "#dc2626"];

/** Rename this browser's identity (Share dialog); keeps the current color. */
export function setGuestName(name: string): void {
  const identity = {
    name: name.trim().slice(0, 40) || "Guest",
    color: getIdentity().color,
  };
  try {
    localStorage.setItem("noddle-user", JSON.stringify(identity));
  } catch {
    /* ignore */
  }
}

/** This browser's anonymous identity — auto-generated AND persisted on first
 * read (Excalidraw-style), so drawing needs zero prompts.
 * Reads the old sessionStorage key as a migration. */
export function getIdentity(): { name: string; color: string } {
  try {
    const raw = localStorage.getItem("noddle-user") ?? sessionStorage.getItem("noddle-user");
    if (raw) {
      const v = JSON.parse(raw) as { name?: string; color?: string };
      if (v && typeof v.name === "string" && v.name) {
        return { name: v.name, color: v.color || COLORS[0] };
      }
    }
  } catch {
    /* ignore */
  }
  const identity = {
    name: `Guest-${Math.random().toString(16).slice(2, 6)}`,
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
  };
  try {
    localStorage.setItem("noddle-user", JSON.stringify(identity));
  } catch {
    /* storage blocked — a fresh ephemeral identity per read is fine */
  }
  return identity;
}

// ---- connection lifecycle ---------------------------------------------------

let ws: WebSocket | null = null;
let currentDocId: string | null = null;
/** True while applying a remote state → the local subscriber must not re-send. */
let applyingRemote = false;
let sendTimer: ReturnType<typeof setTimeout> | null = null;
let cursorLast = 0;
let unsubscribe: (() => void) | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function wsUrl(docId: string): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws/documents/${docId}`;
}

function sendJson(payload: unknown) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

// Multi-page: the live diagram is one PAGE of the doc. Broadcasts carry the
// page id so peers only apply state for the page they're viewing (editing a
// different page won't clobber theirs). Page switches load a page into the
// diagram programmatically — those mutations must NOT broadcast.
let localPageId: string | null = null;
/** Last cursor position sent — replayed on page switch (see below). */
let lastCursor: { x: number; y: number } | null = null;

/** The active page id — set by pagesStore on load/switch. */
export function setLocalPageId(id: string | null): void {
  const changed = id !== localPageId;
  localPageId = id;
  // Re-announce the cursor under the NEW page immediately — otherwise the
  // last frame (stamped with the old page) keeps a ghost cursor on screens
  // still viewing that page until it goes stale.
  if (changed && lastCursor) {
    sendJson({ t: "cursor", ...lastCursor, pageId: localPageId });
  }
}

// Live board-name sync: broadcast a rename to the room, and route incoming
// renames to a handler the editor registers.
let onRemoteName: ((name: string) => void) | null = null;
export function onCollabName(handler: ((name: string) => void) | null): void {
  onRemoteName = handler;
}

// State frames for a page the viewer is NOT on: pagesStore registers here to
// merge them into its cache (avoids a module cycle) — dropping them left the
// viewer's cache stale, and the next save overwrote the peer's work.
let onRemotePageState:
  | ((pageId: string, diagram: { nodes: unknown[]; edges: unknown[] }) => void)
  | null = null;
export function onCollabPageState(h: typeof onRemotePageState): void {
  onRemotePageState = h;
}

// Comment sync: the backend pushes the full comment list after every REST
// mutation; commentsStore registers here (avoids a module cycle).
let onRemoteComments: ((comments: unknown[]) => void) | null = null;
export function onCollabComments(
  handler: ((comments: unknown[]) => void) | null,
): void {
  onRemoteComments = handler;
}
export function broadcastName(name: string): void {
  sendJson({ t: "meta", name: name.slice(0, 120) });
}

/** Run a programmatic diagram swap (page switch) without echoing it to peers. */
export function suppressDiagramBroadcast(fn: () => void): void {
  const prev = applyingRemote;
  applyingRemote = true;
  try {
    fn();
  } finally {
    applyingRemote = prev;
  }
}

// Ids present in our last broadcast — the diff tells peers what we REMOVED
// (union-merge only upserts; without explicit tombstones a delete/undo-of-add
// would never propagate). Kept per active page.
let lastSentNodeIds = new Set<string>();
let lastSentEdgeIds = new Set<string>();

/** Throttled (trailing) full-state broadcast + the ids removed since last send. */
function scheduleStateSend() {
  if (sendTimer) return;
  sendTimer = setTimeout(() => {
    sendTimer = null;
    const s = useDiagramStore.getState();
    const nodeIds = new Set(Object.keys(s.nodes));
    const edgeIds = new Set(Object.keys(s.edges));
    const removedNodeIds = [...lastSentNodeIds].filter((id) => !nodeIds.has(id));
    const removedEdgeIds = [...lastSentEdgeIds].filter((id) => !edgeIds.has(id));
    lastSentNodeIds = nodeIds;
    lastSentEdgeIds = edgeIds;
    sendJson({
      t: "state",
      pageId: localPageId,
      diagram: { nodes: Object.values(s.nodes), edges: Object.values(s.edges) },
      removedNodeIds,
      removedEdgeIds,
    });
  }, 120);
}

function applyRemoteState(
  diagram: { nodes: unknown[]; edges: unknown[] },
  removedNodeIds?: string[],
  removedEdgeIds?: string[],
) {
  const ds = useDiagramStore.getState();
  // Explicit removals first (tombstones) — a peer's delete/undo-of-add. Never
  // drop the node the local user is actively dragging.
  const drag = ds.draggingId;
  const rmN = (removedNodeIds ?? []).filter((id) => id !== drag);
  const rmE = removedEdgeIds ?? [];
  if (rmN.length || rmE.length) {
    pauseHistory(() => ds.applyPatch({ removeNodeIds: rmN, removeEdgeIds: rmE }));
  }
  applyingRemote = true;
  try {
    // A remote edit is not a local undo step either. MERGE (not replace) so the
    // local user's in-progress drag/selection survives — mergeDiagram protects
    // the dragging node and keeps still-valid selection itself.
    pauseHistory(() => {
      ds.mergeDiagram(diagram.nodes as never, diagram.edges as never);
    });
  } finally {
    applyingRemote = false;
  }
}

export function connectCollab(docId: string): void {
  if (currentDocId === docId && ws && ws.readyState <= WebSocket.OPEN) return;
  disconnectCollab();
  currentDocId = docId;

  const socket = new WebSocket(wsUrl(docId));
  ws = socket;

  socket.onopen = () => {
    // The server evicts any prior connection carrying this tab's id, so a
    // reconnect (network blip, rename) never leaves a duplicate "ghost" of
    // you in the presence list.
    sendJson({ t: "hello", ...getIdentity(), clientId: tabId });
    useCollabStore.setState({ connected: true });
  };

  socket.onmessage = (ev) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    switch (msg.t) {
      case "init": {
        useCollabStore.setState({ you: (msg.you as number) ?? null });
        const diagram = msg.diagram as { nodes: unknown[]; edges: unknown[] } | null;
        if (diagram && Array.isArray(diagram.nodes)) applyRemoteState(diagram);
        break;
      }
      case "presence":
        useCollabStore.setState({ peers: (msg.users as Peer[]) ?? [] });
        break;
      case "state": {
        // Apply state for the page the viewer is on; frames for OTHER pages
        // go to the pages cache instead (a peer editing another page must not
        // overwrite mine — but dropping their frames made MY next save
        // overwrite THEIRS). null pageId = legacy single-page → always apply.
        const pid = (msg.pageId as string | null) ?? null;
        const diagram = msg.diagram as { nodes: unknown[]; edges: unknown[] };
        if (!diagram || !Array.isArray(diagram.nodes)) break;
        if (pid !== null && localPageId !== null && pid !== localPageId) {
          onRemotePageState?.(pid, diagram);
          break;
        }
        applyRemoteState(
          diagram,
          (msg.removedNodeIds as string[]) ?? [],
          (msg.removedEdgeIds as string[]) ?? [],
        );
        break;
      }
      case "meta": {
        // Live board-name sync — a peer renamed the board.
        const name = typeof msg.name === "string" ? msg.name : null;
        if (name) onRemoteName?.(name);
        break;
      }
      case "comments": {
        // A peer created/edited/resolved a comment — apply the full list.
        if (Array.isArray(msg.comments)) onRemoteComments?.(msg.comments);
        break;
      }
      case "cursor": {
        const c = msg as unknown as RemoteCursor;
        useCollabStore.setState((s) => ({
          cursors: { ...s.cursors, [c.id]: { ...c, at: Date.now() } },
        }));
        break;
      }
      case "bye": {
        const id = msg.id as number;
        useCollabStore.setState((s) => {
          const cursors = { ...s.cursors };
          delete cursors[id];
          return { cursors };
        });
        break;
      }
    }
  };

  socket.onclose = (ev) => {
    useCollabStore.setState({ connected: false, peers: [], cursors: {} });
    // 4001 = superseded by a newer connection with our own id — reconnecting
    // would just evict that one back (kick loop). Let the newer one live.
    if (ev.code === 4001) return;
    // Auto-reconnect while this doc is still open (e.g. dev server restart).
    if (currentDocId === docId && !reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (currentDocId === docId) connectCollab(docId);
      }, 2000);
    }
  };
  socket.onerror = () => socket.close();

  // Broadcast local diagram edits (drag, add, style, delete, …).
  unsubscribe = useDiagramStore.subscribe((state, prev) => {
    if (applyingRemote) return;
    if (state.nodes !== prev.nodes || state.edges !== prev.edges) {
      scheduleStateSend();
    }
  });
}

export function disconnectCollab(): void {
  currentDocId = null;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (sendTimer) {
    clearTimeout(sendTimer);
    sendTimer = null;
  }
  unsubscribe?.();
  unsubscribe = null;
  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
  }
  useCollabStore.setState({ connected: false, you: null, peers: [], cursors: {} });
}

/**
 * Force a state broadcast of the CURRENT diagram (e.g. after a version
 * restore, which loads pages through suppressed programmatic swaps that the
 * normal change-subscriber deliberately ignores).
 */
export function broadcastDiagramNow(): void {
  scheduleStateSend();
}

/** Send the local pointer position (content coords), throttled to ~25/s.
 * Carries the active page id so peers on OTHER pages don't render it. */
export function sendCursor(x: number, y: number): void {
  const now = Date.now();
  if (now - cursorLast < 40) return;
  cursorLast = now;
  lastCursor = { x, y };
  sendJson({ t: "cursor", x, y, pageId: localPageId });
}
