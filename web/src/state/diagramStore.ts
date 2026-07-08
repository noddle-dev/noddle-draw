/**
 * state/diagramStore — Zustand slice for the additive node/edge diagram layer.
 *
 * Normalized: nodes/edges keyed by id, plus an edgesByNode index maintained on
 * add/delete. Geometry is NEVER stored on edges — it is derived on render from
 * node positions (see editor-core/diagram/geometry). moveNode only mutates a
 * node's x/y, so connected edges re-route automatically ("sticky").
 *
 * This store shares the SAME camera as editorStore (pan/zoom) — it holds no
 * camera of its own. Screen↔content conversion uses editorStore.refs.content.
 */
import { create } from "zustand";
import type {
  DiagramEdge,
  DiagramNode,
  NodeKind,
  Vec,
} from "../editor-core/diagram";
import { shapeDef } from "../editor-core/diagram/shapeDefs";

/** Photoshop-style arrangement of a multi-selection (see alignSelection). */
export type AlignMode =
  | "left" | "centerH" | "right"
  | "top" | "middleV" | "bottom"
  | "distH" | "distV";

function mintId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID().slice(0, 8);
  }
  return Math.random().toString(36).slice(2, 10);
}

// In-app clipboard for ⌘C/⌘V/⌘D — module-level (survives selection changes,
// intentionally NOT the OS clipboard: shapes are app-internal structures).
let clipboard: { nodes: DiagramNode[]; edges: DiagramEdge[] } | null = null;
let pasteCount = 0;

// Default size per kind; unlisted kinds use FALLBACK_SIZE.
const DEFAULT_SIZE: Partial<Record<NodeKind, { w: number; h: number }>> = {
  rect: { w: 140, h: 80 },
  rounded: { w: 140, h: 80 },
  ellipse: { w: 140, h: 90 },
  diamond: { w: 140, h: 100 },
  process: { w: 150, h: 80 },
  terminator: { w: 150, h: 64 },
  document: { w: 150, h: 96 },
  parallelogram: { w: 150, h: 80 },
  cylinder: { w: 130, h: 100 },
  hexagon: { w: 150, h: 90 },
  manualInput: { w: 150, h: 84 },
  delay: { w: 140, h: 80 },
  display: { w: 160, h: 84 },
  card: { w: 140, h: 90 },
  internalStorage: { w: 140, h: 90 },
  note: { w: 130, h: 110 },
  triangle: { w: 130, h: 110 },
  pentagon: { w: 130, h: 120 },
  star: { w: 120, h: 120 },
  cross: { w: 110, h: 110 },
  cloud: { w: 160, h: 110 },
  callout: { w: 150, h: 110 },
  sticky: { w: 150, h: 130 },
  actor: { w: 76, h: 120 },
  icon: { w: 104, h: 112 },
  image: { w: 200, h: 150 },
};
const FALLBACK_SIZE = { w: 140, h: 90 };

const NODE_FILL = "#eef4ff";
const NODE_STROKE = "#2563eb";

interface DiagramState {
  nodes: Record<string, DiagramNode>;
  edges: Record<string, DiagramEdge>;
  /** Index: nodeId → edge ids that reference it (either endpoint). */
  edgesByNode: Record<string, string[]>;
  diagramSelection: string[];
  diagramMode: boolean;

  setDiagramMode: (on: boolean) => void;
  /** Replace the whole diagram (e.g. from AI text→diagram) and enter diagram mode. */
  loadDiagram: (nodes: DiagramNode[], edges: DiagramEdge[]) => void;
  /**
   * MERGE a remote snapshot into the local diagram (live collab): upsert/prune
   * per object instead of replacing wholesale, so a remote update never wipes
   * the local user's in-progress work. The node the local user is currently
   * dragging keeps its LOCAL position (not clobbered mid-drag); local selection
   * is preserved. This is the "local state is protected from global" behavior.
   */
  mergeDiagram: (nodes: DiagramNode[], edges: DiagramEdge[]) => void;
  /** Id of the node the local user is actively dragging (collab-merge guard). */
  draggingId: string | null;
  setDraggingId: (id: string | null) => void;
  /**
   * Apply a TARGETED patch (per-object undo/redo): upsert/remove only the given
   * ids, leaving every other object untouched — so a local undo never rewinds
   * a collaborator's work. Rebuilds the edge index; keeps valid selection.
   */
  applyPatch: (patch: {
    upsertNodes?: DiagramNode[];
    removeNodeIds?: string[];
    upsertEdges?: DiagramEdge[];
    removeEdgeIds?: string[];
  }) => void;

  addNode: (kind: NodeKind, at: Vec, init?: Partial<DiagramNode>) => string;
  /** Add a node CENTERED exactly at `at` (drag-drop). `init` overrides defaults
   * — e.g. `{ iconKey, text }` for icon nodes. */
  addNodeAt: (kind: NodeKind, at: Vec, init?: Partial<DiagramNode>) => string;
  /** Clear the whole diagram and leave diagram mode (e.g. opening an SVG doc). */
  clearDiagram: () => void;
  moveNode: (id: string, dx: number, dy: number) => void;
  updateNode: (id: string, patch: Partial<DiagramNode>) => void;
  setNodeText: (id: string, text: string) => void;

  addEdge: (edge: DiagramEdge) => void;
  updateEdge: (id: string, patch: Partial<DiagramEdge>) => void;
  toggleEdgeAnimated: (id: string) => void;
  /** Swap an edge's endpoints AND its arrowheads (Lucid-style reverse). */
  reverseEdge: (id: string) => void;
  /**
   * Auto-untangle: clear every edge's user-owned `waypoints` so they all
   * re-run the A* orthogonal auto-router (which avoids shapes) on next render.
   * Safe/idempotent — never touches nodes or endpoints.
   */
  autoRouteAllEdges: () => void;
  setEdgeLabel: (id: string, label: string) => void;
  /** Add an empty text block at fraction `t` along the edge; returns its id. */
  addEdgeLabel: (id: string, t: number) => string;
  /** Set a label block's text (empty text removes the block). */
  setEdgeLabelText: (id: string, labelId: string, text: string) => void;
  /** Slide a label block to a new fraction `t` (0..1) along the edge. */
  moveEdgeLabel: (id: string, labelId: string, t: number) => void;

  setDiagramSelection: (ids: string[]) => void;
  deleteSelectedDiagram: () => void;
  /** Create a new node just past one end of an edge and attach that end to it
   * (right-click "add connected shape" — the arrow auto-snaps). Returns the id. */
  addNodeFromEdge: (edgeId: string, which: "source" | "target", kind?: NodeKind) => string | null;
  /** Copy the selected shapes (+ connectors between them) to the in-app
   * clipboard (⌘C). Returns false when nothing copyable is selected. */
  copySelection: () => boolean;
  /** Paste the clipboard with a growing offset, fresh ids and remapped
   * groups/connectors; the pasted objects become the selection (⌘V). */
  pasteClipboard: () => void;
  /** Copy + paste in one gesture without touching the clipboard (⌘D). */
  duplicateSelection: () => void;
  /** Photoshop-style alignment of the selected nodes (≥2; distribute ≥3):
   * one state update = one undo checkpoint for the whole arrangement. */
  alignSelection: (mode: AlignMode) => void;
  /** Group the selected nodes (≥2) so they click/drag as one unit (⌘G). */
  groupSelection: () => void;
  /** Remove the selected nodes from their group(s) (⌘⇧G). */
  ungroupSelection: () => void;
  /** Z-order among diagram nodes (Records keep insertion order → render order). */
  bringNodesToFront: (ids: string[]) => void;
  sendNodesToBack: (ids: string[]) => void;
}

/** Node ids referenced by an edge's endpoints (for the edgesByNode index). */
function edgeNodeIds(edge: DiagramEdge): string[] {
  const ids: string[] = [];
  if (edge.source.kind !== "free") ids.push(edge.source.nodeId);
  if (edge.target.kind !== "free") ids.push(edge.target.nodeId);
  return ids;
}

/** Next unified paint-order value — one above the current top across BOTH nodes
 * and edges, so a freshly created shape/arrow always lands on top. Legacy
 * objects (no `z`) count as 0, so the first new object gets 1 and rises above
 * them; recomputed from live state each time (survives reload without a
 * module counter). */
function nextZ(nodes: Record<string, DiagramNode>, edges: Record<string, DiagramEdge>): number {
  let top = 0;
  for (const n of Object.values(nodes)) if (typeof n.z === "number" && n.z > top) top = n.z;
  for (const e of Object.values(edges)) if (typeof e.z === "number" && e.z > top) top = e.z;
  return top + 1;
}

export const useDiagramStore = create<DiagramState>((set, get) => ({
  nodes: {},
  edges: {},
  edgesByNode: {},
  diagramSelection: [],
  diagramMode: false,
  draggingId: null,

  setDiagramMode(on) {
    set({ diagramMode: on });
  },

  setDraggingId(id) {
    set({ draggingId: id });
  },

  applyPatch(patch) {
    set((s) => {
      const nodes = { ...s.nodes };
      for (const n of patch.upsertNodes ?? []) nodes[n.id] = n;
      for (const id of patch.removeNodeIds ?? []) delete nodes[id];
      const edges = { ...s.edges };
      for (const e of patch.upsertEdges ?? []) edges[e.id] = e;
      for (const id of patch.removeEdgeIds ?? []) delete edges[id];
      const edgesByNode: Record<string, string[]> = {};
      for (const e of Object.values(edges)) {
        for (const nid of edgeNodeIds(e)) {
          edgesByNode[nid] = [...(edgesByNode[nid] ?? []), e.id];
        }
      }
      const sel = s.diagramSelection.filter((id) => nodes[id] || edges[id]);
      return { nodes, edges, edgesByNode, diagramSelection: sel, diagramMode: true };
    });
  },

  mergeDiagram(nodes, edges) {
    set((s) => {
      // UNION merge: start from LOCAL state, overlay the remote snapshot
      // per-id (remote wins for shared objects). This way a teammate's update
      // never wipes objects only YOU have yet (concurrent adds both survive),
      // and the node you're dragging keeps its local position. Trade-off: a
      // delete made elsewhere lags until you touch that object — far less
      // jarring than the whole board thrashing (see ADR note).
      const nodeMap: Record<string, DiagramNode> = { ...s.nodes };
      for (const n of nodes) nodeMap[n.id] = n;
      if (s.draggingId && s.nodes[s.draggingId]) {
        nodeMap[s.draggingId] = s.nodes[s.draggingId]; // protect active drag
      }
      const edgeMap: Record<string, DiagramEdge> = { ...s.edges };
      for (const e of edges) edgeMap[e.id] = e;
      const edgesByNode: Record<string, string[]> = {};
      for (const e of Object.values(edgeMap)) {
        for (const nid of edgeNodeIds(e)) {
          edgesByNode[nid] = [...(edgesByNode[nid] ?? []), e.id];
        }
      }
      // Preserve local selection that still resolves (don't clear every tick).
      const sel = s.diagramSelection.filter((id) => nodeMap[id] || edgeMap[id]);
      return { nodes: nodeMap, edges: edgeMap, edgesByNode, diagramSelection: sel, diagramMode: true };
    });
  },

  loadDiagram(nodes, edges) {
    // Replace nodes/edges wholesale, rebuild the edgesByNode index from the new
    // edges, flip diagram mode on so the result renders editable, clear
    // selection. Each edge keeps its own `animated` flag (feature #3).
    const nodeMap: Record<string, DiagramNode> = {};
    for (const n of nodes) nodeMap[n.id] = n;
    const edgeMap: Record<string, DiagramEdge> = {};
    const edgesByNode: Record<string, string[]> = {};
    for (const e of edges) {
      edgeMap[e.id] = e;
      for (const nid of edgeNodeIds(e)) {
        edgesByNode[nid] = [...(edgesByNode[nid] ?? []), e.id];
      }
    }
    set({
      nodes: nodeMap,
      edges: edgeMap,
      edgesByNode,
      diagramSelection: [],
      diagramMode: true,
    });
  },

  addNode(kind, at, init) {
    // Lay click-added nodes out on a grid (spacing > node size) so they never
    // stack on the same center — overlapping shapes are hard to select/connect.
    const n = Object.keys(get().nodes).length;
    const COL = 220, ROW = 150; // > default node w/h, so no overlap
    const offX = (n % 3) * COL;
    const offY = Math.floor(n / 3) * ROW;
    return get().addNodeAt(kind, { x: at.x + offX, y: at.y + offY }, init);
  },

  addNodeAt(kind, at, init) {
    const id = mintId();
    // Catalog (shapeDefs) is the source of truth for new kinds; legacy
    // DEFAULT_SIZE covers kinds not yet migrated into the catalog.
    const size = shapeDef(kind)?.size ?? DEFAULT_SIZE[kind] ?? FALLBACK_SIZE;
    const node: DiagramNode = {
      id,
      kind,
      x: at.x - size.w / 2,
      y: at.y - size.h / 2,
      w: size.w,
      h: size.h,
      text: labelFor(kind),
      fill: NODE_FILL,
      stroke: NODE_STROKE,
      strokeWidth: 2,
      z: nextZ(get().nodes, get().edges), // new shape paints on top
      ...init, // e.g. { iconKey, text } for icon nodes
    };
    set((s) => ({
      nodes: { ...s.nodes, [id]: node },
      diagramSelection: [id],
    }));
    return id;
  },

  clearDiagram() {
    set({
      nodes: {},
      edges: {},
      edgesByNode: {},
      diagramSelection: [],
      diagramMode: false,
    });
  },

  moveNode(id, dx, dy) {
    // Only mutates node position — edges re-derive on render (sticky).
    set((s) => {
      const n = s.nodes[id];
      if (!n) return s;
      return {
        nodes: { ...s.nodes, [id]: { ...n, x: n.x + dx, y: n.y + dy } },
      };
    });
  },

  updateNode(id, patch) {
    set((s) => {
      const n = s.nodes[id];
      if (!n) return s;
      return { nodes: { ...s.nodes, [id]: { ...n, ...patch } } };
    });
  },

  setNodeText(id, text) {
    get().updateNode(id, { text });
  },

  addEdge(edge) {
    set((s) => {
      // Stamp paint order (unless the caller already set one) so a freshly
      // drawn arrow lands on top of the shapes it crosses instead of hiding
      // behind them.
      const stamped: DiagramEdge =
        typeof edge.z === "number" ? edge : { ...edge, z: nextZ(s.nodes, s.edges) };
      const edgesByNode = { ...s.edgesByNode };
      for (const nid of edgeNodeIds(stamped)) {
        edgesByNode[nid] = [...(edgesByNode[nid] ?? []), stamped.id];
      }
      return { edges: { ...s.edges, [stamped.id]: stamped }, edgesByNode };
    });
  },

  updateEdge(id, patch) {
    set((s) => {
      const e = s.edges[id];
      if (!e) return s;
      const next = { ...e, ...patch } as DiagramEdge;
      // If endpoints changed, rebuild this edge's index entries.
      const endpointsChanged =
        patch.source !== undefined || patch.target !== undefined;
      // Reconnecting an endpoint invalidates a user-dragged route — let the
      // auto router take over again (unless the caller supplies new waypoints,
      // e.g. reverseEdge which just mirrors them).
      if (endpointsChanged && patch.waypoints === undefined) {
        delete next.waypoints;
      }
      if (!endpointsChanged) {
        return { edges: { ...s.edges, [id]: next } };
      }
      const edgesByNode: Record<string, string[]> = {};
      for (const [nid, ids] of Object.entries(s.edgesByNode)) {
        const filtered = ids.filter((x) => x !== id);
        if (filtered.length) edgesByNode[nid] = filtered;
      }
      for (const nid of edgeNodeIds(next)) {
        edgesByNode[nid] = [...(edgesByNode[nid] ?? []), id];
      }
      return { edges: { ...s.edges, [id]: next }, edgesByNode };
    });
  },

  toggleEdgeAnimated(id) {
    set((s) => {
      const e = s.edges[id];
      if (!e) return s;
      return { edges: { ...s.edges, [id]: { ...e, animated: !e.animated } } };
    });
  },

  reverseEdge(id) {
    const e = get().edges[id];
    if (!e) return;
    // Route through updateEdge so the edgesByNode index rebuilds (endpoints
    // changed). Swap arrowheads too so a reversed connector still "points" the
    // way its geometry now runs; a user route is mirrored, not discarded.
    get().updateEdge(id, {
      source: e.target,
      target: e.source,
      startArrow: e.endArrow,
      endArrow: e.startArrow,
      waypoints: e.waypoints ? [...e.waypoints].reverse() : undefined,
    });
  },

  setEdgeLabel(id, label) {
    const trimmed = label.trim();
    get().updateEdge(id, { label: trimmed || undefined });
  },

  addEdgeLabel(id, t) {
    const lid = "l" + mintId();
    const e = get().edges[id];
    if (!e) return lid;
    const labels = [...(e.labels ?? []), { id: lid, t: Math.min(1, Math.max(0, t)), text: "" }];
    get().updateEdge(id, { labels });
    return lid;
  },

  setEdgeLabelText(id, labelId, text) {
    const e = get().edges[id];
    if (!e) return;
    const trimmed = text.trim();
    // Empty text removes the block (so an abandoned add leaves no ghost).
    const labels = (e.labels ?? [])
      .map((l) => (l.id === labelId ? { ...l, text: trimmed } : l))
      .filter((l) => l.text.length > 0);
    get().updateEdge(id, { labels: labels.length ? labels : undefined });
  },

  moveEdgeLabel(id, labelId, t) {
    const e = get().edges[id];
    if (!e?.labels) return;
    const clamped = Math.min(1, Math.max(0, t));
    get().updateEdge(id, {
      labels: e.labels.map((l) => (l.id === labelId ? { ...l, t: clamped } : l)),
    });
  },

  autoRouteAllEdges() {
    set((s) => {
      let changed = false;
      const edges: Record<string, DiagramEdge> = {};
      for (const [id, e] of Object.entries(s.edges)) {
        if (e.waypoints) {
          const { waypoints, ...rest } = e;
          void waypoints;
          edges[id] = rest as DiagramEdge;
          changed = true;
        } else {
          edges[id] = e;
        }
      }
      return changed ? { edges } : s;
    });
  },

  setDiagramSelection(ids) {
    set({ diagramSelection: ids });
  },

  // ⚠ Since the unified paint order (2026-07) the renderer sorts by `z` —
  // front/back must move the z STAMPS. (The old record-reorder version became
  // a silent no-op for any z-stamped object.)
  bringNodesToFront(ids) {
    set((s) => {
      const base = nextZ(s.nodes, s.edges);
      const nodes = { ...s.nodes };
      ids.filter((id) => nodes[id]).forEach((id, i) => {
        nodes[id] = { ...nodes[id], z: base + i };
      });
      return { nodes };
    });
  },

  sendNodesToBack(ids) {
    set((s) => {
      // strictly below EVERYTHING — legacy edges sort at -2, so start under
      // the true minimum across both kinds
      let bottom = -2;
      for (const o of [...Object.values(s.nodes), ...Object.values(s.edges)]) {
        const z = o.z ?? -2;
        if (z < bottom) bottom = z;
      }
      const nodes = { ...s.nodes };
      const picked = ids.filter((id) => nodes[id]);
      picked.forEach((id, i) => {
        nodes[id] = { ...nodes[id], z: bottom - picked.length + i };
      });
      return { nodes };
    });
  },

  deleteSelectedDiagram() {
    const { diagramSelection, nodes, edges, edgesByNode } = get();
    if (!diagramSelection.length) return;
    const selNodes = new Set(diagramSelection.filter((id) => nodes[id]));
    const selEdges = new Set(diagramSelection.filter((id) => edges[id]));

    // Selecting a node also removes edges attached to it.
    for (const nid of selNodes) {
      for (const eid of edgesByNode[nid] ?? []) selEdges.add(eid);
    }

    const nextNodes: Record<string, DiagramNode> = {};
    for (const [id, n] of Object.entries(nodes)) {
      if (!selNodes.has(id)) nextNodes[id] = n;
    }
    const nextEdges: Record<string, DiagramEdge> = {};
    for (const [id, e] of Object.entries(edges)) {
      if (!selEdges.has(id)) nextEdges[id] = e;
    }
    const nextIndex: Record<string, string[]> = {};
    for (const [id, e] of Object.entries(nextEdges)) {
      for (const nid of edgeNodeIds(e)) {
        nextIndex[nid] = [...(nextIndex[nid] ?? []), id];
      }
    }
    set({
      nodes: nextNodes,
      edges: nextEdges,
      edgesByNode: nextIndex,
      diagramSelection: [],
    });
  },

  addNodeFromEdge(edgeId, which, kind = "rounded") {
    const st = get();
    const edge = st.edges[edgeId];
    if (!edge) return null;
    const centerOf = (att: DiagramEdge["source"]) => {
      if (att.kind === "free") return att.point;
      const n = st.nodes[att.nodeId];
      return n ? { x: n.x + n.w / 2, y: n.y + n.h / 2 } : { x: 0, y: 0 };
    };
    const endAtt = which === "target" ? edge.target : edge.source;
    const otherAtt = which === "target" ? edge.source : edge.target;
    const end = centerOf(endAtt);
    const other = centerOf(otherAtt);
    // Direction other→end; place the new node further along that line so the
    // arrow keeps its heading. Fall back to "rightward" for degenerate cases.
    let dx = end.x - other.x, dy = end.y - other.y;
    const len = Math.hypot(dx, dy);
    if (len < 1) { dx = 1; dy = 0; } else { dx /= len; dy /= len; }
    const size = DEFAULT_SIZE[kind] ?? FALLBACK_SIZE;
    const GAP = 70;
    const at = {
      x: end.x + dx * (GAP + size.w / 2),
      y: end.y + dy * (GAP + size.h / 2),
    };
    const id = get().addNodeAt(kind, at);
    // Re-point the edge end to the new node (floating attach) + reindex.
    set((s) => {
      const next: DiagramEdge = { ...s.edges[edgeId], [which]: { kind: "floating", nodeId: id } };
      const edges = { ...s.edges, [edgeId]: next };
      const edgesByNode: Record<string, string[]> = {};
      for (const e of Object.values(edges)) {
        for (const nid of edgeNodeIds(e)) {
          edgesByNode[nid] = [...(edgesByNode[nid] ?? []), e.id];
        }
      }
      return { edges, edgesByNode };
    });
    return id;
  },

  copySelection() {
    const s = get();
    const nodeIds = new Set(s.diagramSelection.filter((id) => s.nodes[id]));
    const edgeIds = new Set(s.diagramSelection.filter((id) => s.edges[id]));
    // Connectors BETWEEN copied shapes ride along even when not selected —
    // pasting a subgraph should keep its arrows (Lucid behavior).
    for (const e of Object.values(s.edges)) {
      const ends = edgeNodeIds(e);
      if (ends.length && ends.every((id) => nodeIds.has(id))) edgeIds.add(e.id);
    }
    if (nodeIds.size === 0 && edgeIds.size === 0) return false;
    clipboard = {
      nodes: [...nodeIds].map((id) => JSON.parse(JSON.stringify(s.nodes[id]))),
      edges: [...edgeIds].map((id) => JSON.parse(JSON.stringify(s.edges[id]))),
    };
    pasteCount = 0;
    return true;
  },

  pasteClipboard() {
    if (!clipboard || (clipboard.nodes.length === 0 && clipboard.edges.length === 0)) return;
    const clip = clipboard;
    pasteCount += 1;
    const off = 24 * pasteCount;
    set((s) => {
      const idMap = new Map<string, string>();
      const gidMap = new Map<string, string>();
      const nodes = { ...s.nodes };
      let z = nextZ(s.nodes, s.edges);
      for (const n of clip.nodes) {
        const nid = mintId();
        idMap.set(n.id, nid);
        let groupId = n.groupId;
        if (groupId) {
          // pasted group is its OWN group, never merged into the original
          if (!gidMap.has(groupId)) gidMap.set(groupId, "g" + mintId());
          groupId = gidMap.get(groupId);
        }
        nodes[nid] = { ...n, id: nid, x: n.x + off, y: n.y + off, groupId, z: z++ };
      }
      const edges = { ...s.edges };
      const edgesByNode = { ...s.edgesByNode };
      const remap = (a: DiagramEdge["source"]): DiagramEdge["source"] | null => {
        if (a.kind === "free") {
          return { ...a, point: { x: a.point.x + off, y: a.point.y + off } };
        }
        const nid = idMap.get(a.nodeId);
        return nid ? { ...a, nodeId: nid } : null; // endpoint not pasted → drop edge
      };
      for (const e of clip.edges) {
        const source = remap(e.source);
        const target = remap(e.target);
        if (!source || !target) continue;
        const eid = mintId();
        const edge: DiagramEdge = {
          ...e,
          id: eid,
          source,
          target,
          waypoints: e.waypoints?.map((p) => ({ x: p.x + off, y: p.y + off })),
          z: z++,
        };
        idMap.set(e.id, eid);
        edges[eid] = edge;
        for (const nid of edgeNodeIds(edge)) {
          edgesByNode[nid] = [...(edgesByNode[nid] ?? []), eid];
        }
      }
      return {
        nodes,
        edges,
        edgesByNode,
        diagramSelection: [...idMap.values()],
      };
    });
  },

  duplicateSelection() {
    // borrow copy+paste without clobbering what the user copied earlier
    const savedClip = clipboard;
    const savedCount = pasteCount;
    if (!get().copySelection()) return;
    get().pasteClipboard();
    clipboard = savedClip;
    pasteCount = savedCount;
  },

  alignSelection(mode) {
    set((s) => {
      const ids = s.diagramSelection.filter((id) => s.nodes[id]);
      if (ids.length < 2) return s;
      const sel = ids.map((id) => s.nodes[id]);
      const minX = Math.min(...sel.map((n) => n.x));
      const maxX = Math.max(...sel.map((n) => n.x + n.w));
      const minY = Math.min(...sel.map((n) => n.y));
      const maxY = Math.max(...sel.map((n) => n.y + n.h));
      const nodes = { ...s.nodes };
      const place = (n: DiagramNode, x: number, y: number) => {
        nodes[n.id] = { ...n, x, y };
      };
      switch (mode) {
        case "left":    sel.forEach((n) => place(n, minX, n.y)); break;
        case "centerH": sel.forEach((n) => place(n, (minX + maxX) / 2 - n.w / 2, n.y)); break;
        case "right":   sel.forEach((n) => place(n, maxX - n.w, n.y)); break;
        case "top":     sel.forEach((n) => place(n, n.x, minY)); break;
        case "middleV": sel.forEach((n) => place(n, n.x, (minY + maxY) / 2 - n.h / 2)); break;
        case "bottom":  sel.forEach((n) => place(n, n.x, maxY - n.h)); break;
        case "distH": {
          if (sel.length < 3) return s;
          // keep first/last where they sit, spread the gaps evenly between
          const byX = [...sel].sort((a, b) => a.x - b.x);
          const totalW = byX.reduce((acc, n) => acc + n.w, 0);
          const gap = (maxX - minX - totalW) / (byX.length - 1);
          let cursor = minX;
          byX.forEach((n) => { place(n, cursor, n.y); cursor += n.w + gap; });
          break;
        }
        case "distV": {
          if (sel.length < 3) return s;
          const byY = [...sel].sort((a, b) => a.y - b.y);
          const totalH = byY.reduce((acc, n) => acc + n.h, 0);
          const gap = (maxY - minY - totalH) / (byY.length - 1);
          let cursor = minY;
          byY.forEach((n) => { place(n, n.x, cursor); cursor += n.h + gap; });
          break;
        }
      }
      return { nodes };
    });
  },

  groupSelection() {
    set((s) => {
      const ids = s.diagramSelection.filter((id) => s.nodes[id]);
      if (ids.length < 2) return s;
      // Single state update → one undo checkpoint for the whole group action.
      const gid = "g" + mintId();
      const nodes = { ...s.nodes };
      for (const id of ids) nodes[id] = { ...nodes[id], groupId: gid };
      return { nodes };
    });
  },

  ungroupSelection() {
    set((s) => {
      const ids = s.diagramSelection.filter((id) => s.nodes[id]?.groupId);
      if (!ids.length) return s;
      const nodes = { ...s.nodes };
      for (const id of ids) {
        const { groupId: _gid, ...rest } = nodes[id];
        nodes[id] = rest as DiagramNode;
      }
      return { nodes };
    });
  },
}));

function labelFor(kind: NodeKind): string {
  const def = shapeDef(kind);
  if (def) return def.text;
  switch (kind) {
    case "rect": return "Process";
    case "rounded": return "Step";
    case "ellipse": return "Start";
    case "diamond": return "Decision";
    case "process": return "Process";
    case "terminator": return "Start";
    case "document": return "Document";
    case "parallelogram": return "Data";
    case "cylinder": return "Database";
    case "hexagon": return "Preparation";
    case "manualInput": return "Manual input";
    case "delay": return "Delay";
    case "display": return "Display";
    case "card": return "Card";
    case "internalStorage": return "Storage";
    case "note": return "Note";
    case "triangle": return "Triangle";
    case "pentagon": return "Pentagon";
    case "star": return "Star";
    case "cross": return "";
    case "cloud": return "Cloud";
    case "callout": return "Note";
    case "sticky": return "";
    case "actor": return "Actor";
    case "icon": return "";
    case "image": return "";
    default: return "Node";
  }
}
