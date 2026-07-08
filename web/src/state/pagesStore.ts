/**
 * state/pagesStore — multi-page boards (Lucid-style page tabs).
 *
 * A document holds N pages. The ACTIVE page's nodes/edges live in diagramStore
 * (the single working set every editor feature already reads); inactive pages
 * are cached here as plain {nodes, edges}. Switching pages snapshots the active
 * diagram into the cache and loads the target into diagramStore.
 *
 * Persistence shape (diagram sidecar): `{pages:[{id,name,nodes,edges}]}`.
 * Legacy `{nodes,edges}` (single diagram) is wrapped as "Page 1" on load — full
 * backward compatibility.
 */
import { create } from "zustand";
import type { DiagramEdge, DiagramNode } from "../editor-core/diagram";
import { useDiagramStore } from "./diagramStore";
import { onCollabPageState, setLocalPageId, suppressDiagramBroadcast } from "./collabStore";
import { pauseHistory, switchHistoryPage } from "./diagramHistory";

// --- per-board "last active page" (restored on reload) -----------------------
let currentDocId: string | null = null;
const PAGE_KEY = (docId: string) => `noddle:page:${docId}`;
function rememberActive(id: string | null): void {
  if (!currentDocId || !id) return;
  try {
    localStorage.setItem(PAGE_KEY(currentDocId), id);
  } catch { /* best-effort */ }
}
function savedActive(docId: string): string | null {
  try {
    return localStorage.getItem(PAGE_KEY(docId));
  } catch {
    return null;
  }
}

// Page-switch hook (old → new) — editorStore registers to swap the per-page
// camera. A registry, not an import: editorStore imports THIS module.
let pageSwitchHandler: ((oldId: string | null, newId: string) => void) | null = null;
export function onPageSwitch(h: typeof pageSwitchHandler): void {
  pageSwitchHandler = h;
}

export interface PageMeta {
  id: string;
  name: string;
  /** Hidden pages stay in the board (tab shown, dimmed) but are EXCLUDED from
   * presentation mode and deck/PNG export. Round-trips through the sidecar. */
  hidden?: boolean;
}
interface PageContent {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}
export interface Page extends PageMeta, PageContent {}

function mintId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID().slice(0, 8);
  }
  return Math.random().toString(36).slice(2, 10);
}

interface PagesState {
  pages: PageMeta[];
  activeId: string | null;
  /** nodes/edges of INACTIVE pages (active page's live copy is in diagramStore). */
  cache: Record<string, PageContent>;

  /** Load a document's diagram payload → pages (legacy {nodes,edges} → 1 page).
   * ``docId`` keys the per-board "last active page" restore. */
  loadFromPayload: (payload: unknown, docId?: string | null) => void;
  /** Collect all pages (active from diagramStore) for save/collab. */
  collect: () => { pages: Page[] };
  /** True when the doc genuinely has >1 page (else callers can stay single). */

  switchPage: (id: string) => void;
  addPage: () => void;
  duplicatePage: (id: string) => void;
  renamePage: (id: string, name: string) => void;
  setPageHidden: (id: string, hidden: boolean) => void;
  deletePage: (id: string) => void;
  reset: () => void;
}

/** Snapshot the live diagram (active page) into the cache under `id`. */
function snapshotActive(id: string | null, cache: Record<string, PageContent>) {
  if (!id) return cache;
  const ds = useDiagramStore.getState();
  return {
    ...cache,
    [id]: { nodes: Object.values(ds.nodes), edges: Object.values(ds.edges) },
  };
}

/** Load a page into the live diagram WITHOUT echoing it as a collab edit, and
 * tell collab which page is now active (so remote state is filtered by page). */
function loadIntoDiagram(pageId: string, content: PageContent) {
  setLocalPageId(pageId);
  // A page switch is neither a collab edit nor an undo step.
  pauseHistory(() => {
    suppressDiagramBroadcast(() => {
      useDiagramStore.getState().loadDiagram(content.nodes ?? [], content.edges ?? []);
    });
  });
  // Undo/redo stacks are PER PAGE — without this, ⌘Z after a switch replayed
  // the previous page's diffs onto this one.
  switchHistoryPage(pageId);
  rememberActive(pageId);
}

export const usePagesStore = create<PagesState>((set, get) => ({
  pages: [],
  activeId: null,
  cache: {},

  loadFromPayload(payload, docId = null) {
    currentDocId = docId;
    let pages: Page[] = [];
    const p = payload as { pages?: Page[]; nodes?: DiagramNode[]; edges?: DiagramEdge[] } | null;
    if (p && Array.isArray(p.pages) && p.pages.length) {
      pages = p.pages.map((pg, i) => ({
        id: pg.id || mintId(),
        name: pg.name || `Page ${i + 1}`,
        hidden: pg.hidden === true,
        nodes: pg.nodes ?? [],
        edges: pg.edges ?? [],
      }));
    } else if (p && (Array.isArray(p.nodes) || Array.isArray(p.edges))) {
      // DETERMINISTIC wrap id ("p1", matching the backend's `p{i}` default):
      // a random id here would differ per client, so two people opening the
      // same legacy board would drop each other's page-scoped frames
      // (diagram state AND comment pins) until the first save stabilizes it.
      pages = [{ id: "p1", name: "Page 1", nodes: p.nodes ?? [], edges: p.edges ?? [] }];
    } else {
      pages = [{ id: "p1", name: "Page 1", nodes: [], edges: [] }];
    }
    const cache: Record<string, PageContent> = {};
    for (const pg of pages) cache[pg.id] = { nodes: pg.nodes, edges: pg.edges };
    // Reload lands on the page you were working on (falls back to page 1).
    const remembered = docId ? savedActive(docId) : null;
    const activeId =
      remembered && pages.some((pg) => pg.id === remembered) ? remembered : pages[0].id;
    set({ pages: pages.map(({ id, name, hidden }) => ({ id, name, hidden })), activeId, cache });
    loadIntoDiagram(activeId, cache[activeId]);
  },

  collect() {
    const { pages, activeId, cache } = get();
    const merged = snapshotActive(activeId, cache);
    return {
      pages: pages.map((p) => ({
        id: p.id,
        name: p.name,
        ...(p.hidden ? { hidden: true } : {}),
        nodes: merged[p.id]?.nodes ?? [],
        edges: merged[p.id]?.edges ?? [],
      })),
    };
  },

  switchPage(id) {
    const { activeId, cache, pages } = get();
    if (id === activeId || !pages.some((p) => p.id === id)) return;
    const snapped = snapshotActive(activeId, cache);
    set({ activeId: id, cache: snapped });
    loadIntoDiagram(id, snapped[id] ?? { nodes: [], edges: [] });
    pageSwitchHandler?.(activeId, id);
  },

  addPage() {
    const { activeId, cache, pages } = get();
    const snapped = snapshotActive(activeId, cache);
    const id = mintId();
    const name = `Page ${pages.length + 1}`;
    set({
      pages: [...pages, { id, name }],
      cache: { ...snapped, [id]: { nodes: [], edges: [] } },
      activeId: id,
    });
    loadIntoDiagram(id, { nodes: [], edges: [] });
    pageSwitchHandler?.(activeId, id);
  },

  duplicatePage(id) {
    const { activeId, cache, pages } = get();
    const snapped = snapshotActive(activeId, cache);
    const src = snapped[id];
    if (!src) return;
    const newId = mintId();
    const srcName = pages.find((p) => p.id === id)?.name ?? "Page";
    const idx = pages.findIndex((p) => p.id === id);
    // deep-copy so the clone is independent
    const copy = JSON.parse(JSON.stringify(src)) as PageContent;
    const nextPages = [...pages];
    nextPages.splice(idx + 1, 0, { id: newId, name: `${srcName} (copy)` });
    set({ pages: nextPages, cache: { ...snapped, [newId]: copy }, activeId: newId });
    loadIntoDiagram(newId, copy);
    pageSwitchHandler?.(activeId, newId);
  },

  renamePage(id, name) {
    set((s) => ({
      pages: s.pages.map((p) => (p.id === id ? { ...p, name: name.trim() || p.name } : p)),
    }));
  },

  setPageHidden(id, hidden) {
    // Hiding is allowed on the ACTIVE page — it stays active in the editor and
    // is only excluded from present/export. No page-switch side effect here.
    set((s) => ({
      pages: s.pages.map((p) => (p.id === id ? { ...p, hidden } : p)),
    }));
  },

  deletePage(id) {
    const { pages, activeId, cache } = get();
    if (pages.length <= 1) return; // always keep one page
    const snapped = snapshotActive(activeId, cache);
    const idx = pages.findIndex((p) => p.id === id);
    const nextPages = pages.filter((p) => p.id !== id);
    const nextCache = { ...snapped };
    delete nextCache[id];
    let nextActive = activeId;
    if (activeId === id) {
      nextActive = (nextPages[idx] ?? nextPages[idx - 1] ?? nextPages[0]).id;
      loadIntoDiagram(nextActive, nextCache[nextActive] ?? { nodes: [], edges: [] });
      pageSwitchHandler?.(null, nextActive); // old page is gone — nothing to save
    }
    set({ pages: nextPages, cache: nextCache, activeId: nextActive });
  },

  reset() {
    set({ pages: [], activeId: null, cache: {} });
  },
}));

// Live frames for a page we are NOT viewing update its CACHE (previously they
// were dropped — the viewer's stale cache then overwrote the peer's work on
// the next save). Frames carry the page's FULL state, so replace is correct.
// An unknown page id means a peer created a page live: surface a tab for it.
onCollabPageState((pageId, diagram) => {
  usePagesStore.setState((s) => {
    if (s.activeId === pageId) return s; // active page flows through diagramStore
    const known = s.pages.some((p) => p.id === pageId);
    return {
      pages: known
        ? s.pages
        : [...s.pages, { id: pageId, name: `Page ${s.pages.length + 1}` }],
      cache: {
        ...s.cache,
        [pageId]: {
          nodes: diagram.nodes as DiagramNode[],
          edges: diagram.edges as DiagramEdge[],
        },
      },
    };
  });
});
