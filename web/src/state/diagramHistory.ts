/**
 * state/diagramHistory — PER-OBJECT undo/redo for the diagram layer.
 *
 * Why not whole-board snapshots: on a shared/live board, restoring a full
 * snapshot rewinds EVERYONE's work — one person's undo clobbers a
 * collaborator's edits. Instead each checkpoint records the DIFF of only the
 * objects that changed (id → before/after); undo/redo re-apply just those
 * objects via diagramStore.applyPatch, leaving every other object (i.e. other
 * people's work) untouched. Union-merge then syncs only the reverted objects.
 *
 * Checkpoints are captured on idle (350ms) so one gesture = one undo step, and
 * recording is paused during remote applies / page loads (see pauseHistory).
 */
import { create } from "zustand";
import type { DiagramEdge, DiagramNode } from "../editor-core/diagram";
import { useDiagramStore } from "./diagramStore";

type NodeMap = Record<string, DiagramNode>;
type EdgeMap = Record<string, DiagramEdge>;
interface Snap { nodes: NodeMap; edges: EdgeMap; }

/** A reversible change: objects that differ between two checkpoints. */
interface Step {
  nodes: { id: string; before?: DiagramNode; after?: DiagramNode }[];
  edges: { id: string; before?: DiagramEdge; after?: DiagramEdge }[];
}

interface HistoryState {
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
}

const DEBOUNCE_MS = 350;

let past: Step[] = [];
let future: Step[] = [];
let committed: Snap = { nodes: {}, edges: {} };
let paused = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let started = false;

const snap = (): Snap => {
  const s = useDiagramStore.getState();
  return { nodes: { ...s.nodes }, edges: { ...s.edges } };
};
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

function sync() {
  useDiagramHistory.setState({ canUndo: past.length > 0, canRedo: future.length > 0 });
}

/** Diff two checkpoints into a reversible step (only changed ids). */
function diff(prev: Snap, next: Snap): Step | null {
  const step: Step = { nodes: [], edges: [] };
  const nodeIds = new Set([...Object.keys(prev.nodes), ...Object.keys(next.nodes)]);
  for (const id of nodeIds) {
    const b = prev.nodes[id], a = next.nodes[id];
    if (JSON.stringify(b) !== JSON.stringify(a)) step.nodes.push({ id, before: b, after: a });
  }
  const edgeIds = new Set([...Object.keys(prev.edges), ...Object.keys(next.edges)]);
  for (const id of edgeIds) {
    const b = prev.edges[id], a = next.edges[id];
    if (JSON.stringify(b) !== JSON.stringify(a)) step.edges.push({ id, before: b, after: a });
  }
  return step.nodes.length || step.edges.length ? step : null;
}

/** Build an applyPatch payload restoring the `which` side of a step. */
function patchFor(step: Step, which: "before" | "after") {
  const upsertNodes: DiagramNode[] = [];
  const removeNodeIds: string[] = [];
  const upsertEdges: DiagramEdge[] = [];
  const removeEdgeIds: string[] = [];
  for (const n of step.nodes) {
    const v = n[which];
    if (v) upsertNodes.push(clone(v));
    else removeNodeIds.push(n.id); // absent on that side → it was added → remove
  }
  for (const e of step.edges) {
    const v = e[which];
    if (v) upsertEdges.push(clone(v));
    else removeEdgeIds.push(e.id);
  }
  return { upsertNodes, removeNodeIds, upsertEdges, removeEdgeIds };
}

export function pauseHistory<T>(fn: () => T): T {
  paused += 1;
  try {
    return fn();
  } finally {
    paused -= 1;
    committed = snap(); // programmatic state becomes the new baseline
    if (timer) { clearTimeout(timer); timer = null; }
  }
}

export function resetHistory() {
  past = [];
  future = [];
  pageStacks.clear();
  currentHistoryPage = null;
  committed = snap();
  sync();
}

// --- per-PAGE undo/redo stacks ------------------------------------------------
// The stacks live per page: without this, ⌘Z after a page switch popped the
// PREVIOUS page's diff and replayed its objects onto the current page.
const pageStacks = new Map<string, { past: Step[]; future: Step[] }>();
let currentHistoryPage: string | null = null;

/** Stash the current page's stacks and activate the target page's (called by
 * pagesStore right after a page loads into the diagram store). */
export function switchHistoryPage(pageId: string | null): void {
  if (pageId === currentHistoryPage) return;
  if (currentHistoryPage !== null) {
    pageStacks.set(currentHistoryPage, { past, future });
  }
  currentHistoryPage = pageId;
  const stacks = (pageId && pageStacks.get(pageId)) || { past: [], future: [] };
  past = stacks.past;
  future = stacks.future;
  committed = snap(); // the freshly loaded page is the new baseline
  sync();
}

export function startDiagramHistory() {
  if (started) return;
  started = true;
  committed = snap();
  useDiagramStore.subscribe((state, prev) => {
    if (paused > 0) return;
    if (state.nodes === prev.nodes && state.edges === prev.edges) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const now = snap();
      const step = diff(committed, now);
      if (!step) return;
      past.push(step);
      if (past.length > 200) past.shift();
      future = [];
      committed = now;
      sync();
    }, DEBOUNCE_MS);
  });
}

/** Apply a targeted patch WITHOUT recording it as a new step (but DO let it
 * broadcast — an undo is a real change peers should see per-object). */
function applyStep(step: Step, which: "before" | "after") {
  pauseHistory(() => {
    useDiagramStore.getState().applyPatch(patchFor(step, which));
  });
}

export const useDiagramHistory = create<HistoryState>(() => ({
  canUndo: false,
  canRedo: false,

  undo() {
    if (!past.length) return;
    if (timer) { clearTimeout(timer); timer = null; committed = snap(); }
    const step = past.pop()!;
    applyStep(step, "before"); // revert ONLY the objects in this step
    future.push(step);
    sync();
  },

  redo() {
    if (!future.length) return;
    if (timer) { clearTimeout(timer); timer = null; committed = snap(); }
    const step = future.pop()!;
    applyStep(step, "after");
    past.push(step);
    sync();
  },
}));
