/**
 * state/myShapesStore — user-defined reusable stencils (#20, "My shapes").
 *
 * A custom stencil is a normalized FRAGMENT (selected nodes + the edges fully
 * inside the selection, re-based to origin). Stored per browser in
 * localStorage — stencils are a personal palette, not board data.
 * Instantiating stamps fresh ids so repeated drops never collide.
 */
import { create } from "zustand";
import type { DiagramEdge, DiagramNode } from "../editor-core/diagram";
import { useDiagramStore } from "./diagramStore";

export interface MyShape {
  id: string;
  name: string;
  nodes: DiagramNode[]; // coords re-based: bbox min = (0,0)
  edges: DiagramEdge[];
  w: number;
  h: number;
}

const LS_KEY = "noddle-my-shapes";
const MAX_SHAPES = 30;

function load(): MyShape[] {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) ?? "[]") as MyShape[];
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function persist(shapes: MyShape[]): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(shapes.slice(0, MAX_SHAPES)));
  } catch {
    /* quota — keep in-memory only */
  }
}

function mintId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID().slice(0, 8);
  }
  return Math.random().toString(36).slice(2, 10);
}

interface MyShapesState {
  shapes: MyShape[];
  /** Snapshot the current diagram selection as a stencil. Returns it, or null
   * when the selection holds no nodes. */
  saveFromSelection: (name: string) => MyShape | null;
  remove: (id: string) => void;
  /** Stamp a stencil onto the board CENTERED at `at` (content coords). */
  instantiate: (id: string, at: { x: number; y: number }) => void;
}

export const useMyShapesStore = create<MyShapesState>((set, get) => ({
  shapes: load(),

  saveFromSelection(name) {
    const ds = useDiagramStore.getState();
    const picked = ds.diagramSelection
      .map((id) => ds.nodes[id])
      .filter((n): n is DiagramNode => !!n);
    if (!picked.length) return null;
    const ids = new Set(picked.map((n) => n.id));
    const edges = Object.values(ds.edges).filter(
      (e) =>
        e.source.kind !== "free" &&
        e.target.kind !== "free" &&
        ids.has(e.source.nodeId) &&
        ids.has(e.target.nodeId),
    );
    const minX = Math.min(...picked.map((n) => n.x));
    const minY = Math.min(...picked.map((n) => n.y));
    const maxX = Math.max(...picked.map((n) => n.x + n.w));
    const maxY = Math.max(...picked.map((n) => n.y + n.h));
    const shape: MyShape = {
      id: mintId(),
      name: name.trim().slice(0, 40) || `Shape ${get().shapes.length + 1}`,
      nodes: picked.map((n) => ({ ...n, x: n.x - minX, y: n.y - minY })),
      edges: edges.map((e) => ({
        ...e,
        waypoints: e.waypoints?.map((p) => ({ x: p.x - minX, y: p.y - minY })),
      })),
      w: maxX - minX,
      h: maxY - minY,
    };
    const shapes = [shape, ...get().shapes].slice(0, MAX_SHAPES);
    set({ shapes });
    persist(shapes);
    return shape;
  },

  remove(id) {
    const shapes = get().shapes.filter((s) => s.id !== id);
    set({ shapes });
    persist(shapes);
  },

  instantiate(id, at) {
    const shape = get().shapes.find((s) => s.id === id);
    if (!shape) return;
    const dx = at.x - shape.w / 2;
    const dy = at.y - shape.h / 2;
    const idMap = new Map<string, string>();
    const nodes = shape.nodes.map((n) => {
      const nid = mintId();
      idMap.set(n.id, nid);
      return { ...n, id: nid, x: n.x + dx, y: n.y + dy };
    });
    const edges = shape.edges.map((e) => ({
      ...e,
      id: mintId(),
      source:
        e.source.kind === "free"
          ? e.source
          : { ...e.source, nodeId: idMap.get(e.source.nodeId) ?? e.source.nodeId },
      target:
        e.target.kind === "free"
          ? e.target
          : { ...e.target, nodeId: idMap.get(e.target.nodeId) ?? e.target.nodeId },
      waypoints: e.waypoints?.map((p) => ({ x: p.x + dx, y: p.y + dy })),
    }));
    const ds = useDiagramStore.getState();
    ds.setDiagramMode(true);
    ds.applyPatch({ upsertNodes: nodes, upsertEdges: edges as DiagramEdge[] });
    ds.setDiagramSelection(nodes.map((n) => n.id));
  },
}));
