/**
 * editor-core/diagram/fragment — stamp a reusable diagram FRAGMENT (a library
 * item, a "My shapes" stencil) onto a board as brand-new objects.
 *
 * Pure TypeScript, no React/DOM/store: the caller supplies id minting and the
 * paint-order base, so the store (diagramStore.insertFragment) owns identity
 * and this stays unit-testable. Every stamp is independent of the source:
 *   • fresh node/edge ids (id map) — repeated drops never collide;
 *   • edge attachments (port/floating) follow the id map; an edge whose
 *     endpoint node isn't in the fragment is DROPPED (never dangles);
 *   • `free` endpoints and waypoints move with the fragment;
 *   • groups are re-minted (a stamp is never merged into the source group);
 *     an ungrouped multi-node insert gets ONE shared group so it drags as a
 *     unit — the user ungroups (⌘⇧G) to take it apart;
 *   • increasing `z` from `zStart`, nodes first, so the insert paints on top.
 */
import type { Attachment, DiagramEdge, DiagramNode, Vec } from "./types";

export interface Fragment {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

export interface StampOptions {
  /** Fresh object id (store convention). Group ids get a "g" prefix. */
  mintId: () => string;
  /** First paint-order value; each stamped object takes the next one. */
  zStart: number;
}

/** Bbox centre of the fragment — nodes, else free endpoints/waypoints. */
function fragmentCenter(frag: Fragment): Vec {
  const pts: Vec[] = [];
  for (const n of frag.nodes) {
    pts.push({ x: n.x, y: n.y }, { x: n.x + n.w, y: n.y + n.h });
  }
  if (!pts.length) {
    for (const e of frag.edges) {
      for (const a of [e.source, e.target]) if (a.kind === "free") pts.push(a.point);
      for (const p of e.waypoints ?? []) pts.push(p);
    }
  }
  if (!pts.length) return { x: 0, y: 0 };
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return {
    x: (Math.min(...xs) + Math.max(...xs)) / 2,
    y: (Math.min(...ys) + Math.max(...ys)) / 2,
  };
}

/** Stamp `frag` with its bbox CENTRE at content point `at`. */
export function stampFragment(frag: Fragment, at: Vec, opts: StampOptions): Fragment {
  const c = fragmentCenter(frag);
  const dx = at.x - c.x;
  const dy = at.y - c.y;
  const shift = (p: Vec): Vec => ({ x: p.x + dx, y: p.y + dy });
  let z = opts.zStart;

  const hasGroups = frag.nodes.some((n) => n.groupId);
  const unitGroup = !hasGroups && frag.nodes.length >= 2 ? "g" + opts.mintId() : undefined;
  const gidMap = new Map<string, string>();
  const idMap = new Map<string, string>();

  const nodes = frag.nodes.map((n): DiagramNode => {
    const id = opts.mintId();
    idMap.set(n.id, id);
    let groupId = unitGroup;
    if (n.groupId) {
      if (!gidMap.has(n.groupId)) gidMap.set(n.groupId, "g" + opts.mintId());
      groupId = gidMap.get(n.groupId);
    }
    const out: DiagramNode = { ...n, id, x: n.x + dx, y: n.y + dy, z: z++ };
    if (groupId) out.groupId = groupId;
    else delete out.groupId;
    return out;
  });

  const remap = (a: Attachment): Attachment | null => {
    if (a.kind === "free") return { ...a, point: shift(a.point) };
    const nodeId = idMap.get(a.nodeId);
    return nodeId ? { ...a, nodeId } : null;
  };

  const edges: DiagramEdge[] = [];
  for (const e of frag.edges) {
    const source = remap(e.source);
    const target = remap(e.target);
    if (!source || !target) continue; // endpoint outside the fragment
    const edge: DiagramEdge = { ...e, id: opts.mintId(), source, target, z: z++ };
    if (e.waypoints) edge.waypoints = e.waypoints.map(shift);
    edges.push(edge);
  }
  return { nodes, edges };
}

/**
 * Nearest spot to `at` (the insert's bbox CENTER) where a w×h box, padded by
 * `gap`, overlaps no node — a square-ring search on a `step` grid, so repeated
 * click-inserts fan out beside each other instead of stacking on the canvas
 * centre. Falls back to `at` when nothing free is found within `maxRing`.
 */
export function findFreeSpot(
  nodes: DiagramNode[],
  w: number,
  h: number,
  at: Vec,
  opts: { gap?: number; step?: number; maxRing?: number } = {},
): Vec {
  const gap = opts.gap ?? 24;
  const step = opts.step ?? 40;
  const maxRing = opts.maxRing ?? 25;
  const blocked = (c: Vec) =>
    nodes.some(
      (n) =>
        c.x - w / 2 - gap < n.x + n.w &&
        c.x + w / 2 + gap > n.x &&
        c.y - h / 2 - gap < n.y + n.h &&
        c.y + h / 2 + gap > n.y,
    );
  if (!blocked(at)) return at;
  for (let r = 1; r <= maxRing; r++) {
    const ring: Vec[] = [];
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        ring.push({ x: at.x + dx * step, y: at.y + dy * step });
      }
    }
    ring.sort((a, b) => Math.hypot(a.x - at.x, a.y - at.y) - Math.hypot(b.x - at.x, b.y - at.y));
    const free = ring.find((c) => !blocked(c));
    if (free) return free;
  }
  return at;
}
