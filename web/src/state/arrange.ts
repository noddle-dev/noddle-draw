/**
 * state/arrange — Excalidraw-style arrangement actions on the diagram
 * selection: paint-order steps (⌘[ ⌘] / ⌘⇧[ ⌘⇧]), flip (⇧H / ⇧V) and
 * copy/paste styles (⌘⌥C / ⌘⌥V). One module so the keyboard, the style
 * panel and the shortcuts sheet all call the same thing (like grouping.ts).
 */
import type { Attachment, DiagramEdge, DiagramNode } from "../editor-core/diagram";
import { useDiagramStore } from "./diagramStore";

type Obj = { id: string; kind: "node" | "edge"; z: number };

/** Every object in PAINT order — the same sort DiagramLayer renders with
 * (edges default -2, nodes -1, stable on insertion order). */
function paintOrder(nodes: Record<string, DiagramNode>, edges: Record<string, DiagramEdge>): Obj[] {
  return [
    ...Object.values(edges).map((e) => ({ id: e.id, kind: "edge" as const, z: e.z ?? -2 })),
    ...Object.values(nodes).map((n) => ({ id: n.id, kind: "node" as const, z: n.z ?? -1 })),
  ].sort((a, b) => a.z - b.z);
}

/** Write a new paint order back as dense z stamps (only objects that moved). */
function commitOrder(order: Obj[]) {
  const ds = useDiagramStore.getState();
  const upsertNodes: DiagramNode[] = [];
  const upsertEdges: DiagramEdge[] = [];
  order.forEach((o, i) => {
    if (o.kind === "node") {
      const n = ds.nodes[o.id];
      if (n.z !== i) upsertNodes.push({ ...n, z: i });
    } else {
      const e = ds.edges[o.id];
      if (e.z !== i) upsertEdges.push({ ...e, z: i });
    }
  });
  if (upsertNodes.length || upsertEdges.length) ds.applyPatch({ upsertNodes, upsertEdges });
}

/**
 * Move the selection in paint order. `step` ±1 = one object forward/backward
 * (past the next unselected neighbour, so a selected block keeps its shape);
 * "front"/"back" = all the way. Nodes AND arrows both move.
 */
export function arrangeSelection(dir: "forward" | "backward" | "front" | "back") {
  const ds = useDiagramStore.getState();
  const sel = new Set(ds.diagramSelection.filter((id) => ds.nodes[id] || ds.edges[id]));
  if (!sel.size) return;
  const order = paintOrder(ds.nodes, ds.edges);
  const isSel = (o: Obj) => sel.has(o.id);
  let next: Obj[];
  if (dir === "front") next = [...order.filter((o) => !isSel(o)), ...order.filter(isSel)];
  else if (dir === "back") next = [...order.filter(isSel), ...order.filter((o) => !isSel(o))];
  else {
    next = [...order];
    if (dir === "forward") {
      for (let i = next.length - 2; i >= 0; i--) {
        if (isSel(next[i]) && !isSel(next[i + 1])) [next[i], next[i + 1]] = [next[i + 1], next[i]];
      }
    } else {
      for (let i = 1; i < next.length; i++) {
        if (isSel(next[i]) && !isSel(next[i - 1])) [next[i], next[i - 1]] = [next[i - 1], next[i]];
      }
    }
  }
  commitOrder(next);
}

/**
 * Mirror the selection across its own bounding box (Excalidraw ⇧H / ⇧V).
 * Shapes swap sides, pen ink mirrors inside its box, port attachments flip
 * with their shape, free arrow ends + bends of the involved arrows mirror.
 * Labels are NOT mirrored — text must stay readable.
 */
export function flipSelection(axis: "h" | "v") {
  const ds = useDiagramStore.getState();
  const nodeIds = new Set(ds.diagramSelection.filter((id) => ds.nodes[id]));
  const selEdges = ds.diagramSelection.filter((id) => ds.edges[id]);
  const edgeIds = new Set(selEdges);
  // an arrow between two flipped shapes is part of the picture even if it
  // wasn't picked — its bends must follow or it would cross itself
  for (const e of Object.values(ds.edges)) {
    const a = "nodeId" in e.source ? e.source.nodeId : null;
    const b = "nodeId" in e.target ? e.target.nodeId : null;
    if (a && b && nodeIds.has(a) && nodeIds.has(b)) edgeIds.add(e.id);
  }
  if (!nodeIds.size && !edgeIds.size) return;

  // bbox over the shapes + any free points of the involved arrows
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const grow = (x: number, y: number) => {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  };
  nodeIds.forEach((id) => { const n = ds.nodes[id]; grow(n.x, n.y); grow(n.x + n.w, n.y + n.h); });
  edgeIds.forEach((id) => {
    const e = ds.edges[id];
    for (const at of [e.source, e.target]) if (at.kind === "free") grow(at.point.x, at.point.y);
    e.waypoints?.forEach((p) => grow(p.x, p.y));
  });
  if (!isFinite(x0)) return;
  const mx = (x: number) => (axis === "h" ? x0 + x1 - x : x);
  const my = (y: number) => (axis === "v" ? y0 + y1 - y : y);

  const upsertNodes: DiagramNode[] = [];
  nodeIds.forEach((id) => {
    const n = ds.nodes[id];
    const moved: DiagramNode = {
      ...n,
      x: axis === "h" ? mx(n.x + n.w) : n.x,
      y: axis === "v" ? my(n.y + n.h) : n.y,
    };
    // OSS nodes can rotate: a mirror reverses the turn direction.
    if (n.rotation) moved.rotation = -n.rotation;
    if (n.kind === "freedraw" && n.points) {
      moved.points = n.points.map((v, i) => ((i % 2 === 0) === (axis === "h") ? 1 - v : v));
    }
    upsertNodes.push(moved);
  });

  const flipAt = (at: Attachment): Attachment => {
    if (at.kind === "free") return { kind: "free", point: { x: mx(at.point.x), y: my(at.point.y) } };
    if (at.kind === "port" && nodeIds.has(at.nodeId)) {
      return { ...at, rel: { x: axis === "h" ? 1 - at.rel.x : at.rel.x, y: axis === "v" ? 1 - at.rel.y : at.rel.y } };
    }
    return at;
  };
  const upsertEdges: DiagramEdge[] = [];
  for (const e of Object.values(ds.edges)) {
    const involved = edgeIds.has(e.id);
    const touchesPort =
      (e.source.kind === "port" && nodeIds.has(e.source.nodeId)) ||
      (e.target.kind === "port" && nodeIds.has(e.target.nodeId));
    if (!involved && !touchesPort) continue;
    const next: DiagramEdge = { ...e };
    if (involved) {
      next.source = flipAt(e.source);
      next.target = flipAt(e.target);
      if (e.waypoints) next.waypoints = e.waypoints.map((p) => ({ x: mx(p.x), y: my(p.y) }));
    } else {
      // a port on a flipped shape moves with it; the far end stays put
      if (e.source.kind === "port") next.source = flipAt(e.source);
      if (e.target.kind === "port") next.target = flipAt(e.target);
    }
    upsertEdges.push(next);
  }
  ds.applyPatch({ upsertNodes, upsertEdges });
}

/* ---------- copy / paste styles ---------- */

const NODE_STYLE_KEYS = [
  "fill", "stroke", "strokeWidth", "strokeDash", "sketch", "cornerRadius", "opacity",
  "fontSize", "fontFamily", "bold", "italic", "underline", "textColor", "textAlign",
  "letterSpacing", "anim", "animSpeed", "pen",
] as const satisfies readonly (keyof DiagramNode)[];
const EDGE_STYLE_KEYS = [
  "stroke", "strokeWidth", "dash", "routing", "endArrow", "startArrow", "endHead", "startHead",
  "animated", "flowStyle", "flowSpeed", "flowIntensity",
] as const satisfies readonly (keyof DiagramEdge)[];

let styleClip: { node?: Partial<DiagramNode>; edge?: Partial<DiagramEdge> } = {};

function pick<T extends object>(src: T, keys: readonly (keyof T)[]): Partial<T> {
  const out: Partial<T> = {};
  for (const k of keys) if (src[k] !== undefined) out[k] = src[k];
  return out;
}

/** ⌘⌥C — remember the first selected shape's (and arrow's) look. */
export function copyStyles(): boolean {
  const ds = useDiagramStore.getState();
  const n = ds.diagramSelection.map((id) => ds.nodes[id]).find(Boolean);
  const e = ds.diagramSelection.map((id) => ds.edges[id]).find(Boolean);
  if (!n && !e) return false;
  styleClip = {
    node: n ? pick(n, NODE_STYLE_KEYS) : styleClip.node,
    edge: e ? pick(e, EDGE_STYLE_KEYS) : styleClip.edge,
  };
  return true;
}

export const hasCopiedStyles = () => !!(styleClip.node || styleClip.edge);

/** ⌘⌥V — paint the remembered look onto the selection. Pen brush settings
 * only land on pen strokes (and vice-versa a stroke ignores text styles it
 * cannot show — harmless, they're just fields). */
export function pasteStyles(): boolean {
  const ds = useDiagramStore.getState();
  if (!hasCopiedStyles()) return false;
  const upsertNodes: DiagramNode[] = [];
  const upsertEdges: DiagramEdge[] = [];
  for (const id of ds.diagramSelection) {
    const n = ds.nodes[id];
    if (n && styleClip.node) {
      const { pen, ...rest } = styleClip.node;
      upsertNodes.push({ ...n, ...rest, ...(n.kind === "freedraw" && pen ? { pen } : {}) });
    }
    const e = ds.edges[id];
    if (e && styleClip.edge) upsertEdges.push({ ...e, ...styleClip.edge });
  }
  if (!upsertNodes.length && !upsertEdges.length) return false;
  ds.applyPatch({ upsertNodes, upsertEdges });
  return true;
}
