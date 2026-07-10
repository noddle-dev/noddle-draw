/**
 * editor-core/diagram/geometry — derive edge geometry from nodes on render.
 *
 * Endpoints are resolved from ATTACHMENTs (never stored coords, except free),
 * so moving a node re-routes its edges automatically. Elbow edges route
 * through the orthogonal sparse-grid A* (see ./orthogonal) with side-aware
 * exits, and honour user waypoints when a segment has been dragged. PURE TS.
 */
import { perimeterPoint, rotatePoint } from "./perimeter";
import {
  applyWaypoints,
  autoSide,
  ROUTE_PAD,
  routeOrthogonal,
  sideAnchor,
  sideOfPort,
  simplifyOrtho,
  type Side,
} from "./orthogonal";
import type { Attachment, DiagramEdge, DiagramNode, Vec } from "./types";

/** Cap on avoided obstacles per edge — keeps the A* grid tiny on big boards. */
const MAX_OBSTACLES = 8;

export type NodeMap = Record<string, DiagramNode>;

export function nodeCenter(node: DiagramNode): Vec {
  return { x: node.x + node.w / 2, y: node.y + node.h / 2 };
}

/**
 * The perimeter point aimed at `toward`, honoring node rotation: the shape body
 * is authored axis-aligned (ports/routing model), so we aim in the node's LOCAL
 * frame and rotate the hit back out. Keeps floating edges clipping to the
 * rotated silhouette the user sees.
 */
function rotatedPerimeter(node: DiagramNode, toward: Vec): Vec {
  if (!node.rotation) return perimeterPoint(node, toward);
  const c = nodeCenter(node);
  const local = rotatePoint(toward, c, -node.rotation);
  return rotatePoint(perimeterPoint(node, local), c, node.rotation);
}

/**
 * The diagram node whose axis-aligned body contains a content-space point, or
 * null. `excludeId` skips one node (e.g. an edge's other endpoint, so dragging
 * an endpoint can't create a degenerate self-loop). PURE TS — used by both the
 * port drag-to-connect and the edge endpoint drag-to-reconnect.
 */
export function nodeAtPoint(
  nodes: NodeMap,
  p: Vec,
  excludeId?: string,
): string | null {
  for (const n of Object.values(nodes)) {
    if (n.id === excludeId) continue;
    // Test in the node's own frame so a rotated shape is hit under its
    // visible body, not its axis-aligned bbox.
    const q = n.rotation ? rotatePoint(p, nodeCenter(n), -n.rotation) : p;
    if (q.x >= n.x && q.x <= n.x + n.w && q.y >= n.y && q.y <= n.y + n.h) {
      return n.id;
    }
  }
  return null;
}

/** Absolute point for a relative port (rel in 0..1 of the node box), rotated
 * with the node so the anchor sits on the shape the user sees. */
export function portPoint(node: DiagramNode, rel: Vec): Vec {
  const p = { x: node.x + rel.x * node.w, y: node.y + rel.y * node.h };
  return node.rotation ? rotatePoint(p, nodeCenter(node), node.rotation) : p;
}

/** Inverse of portPoint: a WORLD point → its rel (0..1 of the node box),
 * inverse-rotating first so a drop on a rotated shape maps to the right rel. */
export function worldPointToRel(node: DiagramNode, p: Vec): Vec {
  const q = node.rotation ? rotatePoint(p, nodeCenter(node), -node.rotation) : p;
  return {
    x: node.w ? (q.x - node.x) / node.w : 0.5,
    y: node.h ? (q.y - node.y) / node.h : 0.5,
  };
}

/**
 * Resolve one endpoint to an absolute content point.
 * - port:     exact port point.
 * - floating: border point aimed at `otherPoint` (falls back to node center).
 * - free:     the stored point.
 * Returns null if a referenced node is missing.
 */
export function resolveEndpoint(
  att: Attachment,
  nodes: NodeMap,
  otherPoint: Vec | null,
): Vec | null {
  if (att.kind === "free") return att.point;
  const node = nodes[att.nodeId];
  if (!node) return null;
  if (att.kind === "port") return portPoint(node, att.rel);
  // floating
  const toward = otherPoint ?? nodeCenter(node);
  return rotatedPerimeter(node, toward);
}

export interface EdgeGeometry {
  d: string;
  /** Full corner list, endpoints included (2 points for straight edges). */
  points: Vec[];
  /** Midpoint along the polyline (label anchor / handle hints). */
  mid: Vec;
  sx: number;
  sy: number;
  tx: number;
  ty: number;
}

interface ResolvedEnd {
  point: Vec;
  side: Side;
  node: DiagramNode | null;
}

/** Resolve an elbow endpoint to {attach point, exit side, node}. */
function resolveElbowEnd(
  att: Attachment,
  nodes: NodeMap,
  otherAnchor: Vec,
): ResolvedEnd | null {
  if (att.kind === "free") {
    // Free points exit toward the other anchor along the dominant axis.
    const dx = otherAnchor.x - att.point.x;
    const dy = otherAnchor.y - att.point.y;
    const side: Side =
      Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? "E" : "W") : (dy >= 0 ? "S" : "N");
    return { point: att.point, side, node: null };
  }
  const node = nodes[att.nodeId];
  if (!node) return null;
  if (att.kind === "port") {
    const side = sideOfPort(att.rel) ?? autoSide(node, otherAnchor);
    return { point: portPoint(node, att.rel), side, node };
  }
  const side = autoSide(node, otherAnchor);
  return { point: sideAnchor(node, side, otherAnchor), side, node };
}

/** Point at half the total length of a polyline (nice label anchor). */
function polylineMid(points: Vec[]): Vec {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.abs(points[i].x - points[i - 1].x) + Math.abs(points[i].y - points[i - 1].y);
  }
  let rest = total / 2;
  for (let i = 1; i < points.length; i++) {
    const seg = Math.abs(points[i].x - points[i - 1].x) + Math.abs(points[i].y - points[i - 1].y);
    if (seg >= rest && seg > 0) {
      const t = rest / seg;
      return {
        x: points[i - 1].x + (points[i].x - points[i - 1].x) * t,
        y: points[i - 1].y + (points[i].y - points[i - 1].y) * t,
      };
    }
    rest -= seg;
  }
  const a = points[0];
  const b = points[points.length - 1] ?? a;
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** Euclidean length of each segment + the total (for arc-length param). */
function segLengths(points: Vec[]): { segs: number[]; total: number } {
  const segs: number[] = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const d = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    segs.push(d);
    total += d;
  }
  return { segs, total };
}

/** Point at fraction `t` (0..1) of a polyline's TOTAL arc length. */
export function pointAtT(points: Vec[], t: number): Vec {
  if (points.length === 0) return { x: 0, y: 0 };
  if (points.length === 1) return points[0];
  const { segs, total } = segLengths(points);
  if (total === 0) return points[0];
  let want = Math.min(1, Math.max(0, t)) * total;
  for (let i = 0; i < segs.length; i++) {
    if (want <= segs[i] || i === segs.length - 1) {
      const f = segs[i] > 0 ? want / segs[i] : 0;
      return {
        x: points[i].x + (points[i + 1].x - points[i].x) * f,
        y: points[i].y + (points[i + 1].y - points[i].y) * f,
      };
    }
    want -= segs[i];
  }
  return points[points.length - 1];
}

/** Arc-length fraction (0..1) of the point on the polyline nearest to `p` —
 * used to anchor a label where the user clicks along the connector. */
export function tOfPoint(points: Vec[], p: Vec): number {
  if (points.length < 2) return 0.5;
  const { segs, total } = segLengths(points);
  if (total === 0) return 0.5;
  let acc = 0, bestD = Infinity, bestLen = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const u = len2 ? Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
    const qx = a.x + dx * u, qy = a.y + dy * u;
    const d = Math.hypot(p.x - qx, p.y - qy);
    if (d < bestD) { bestD = d; bestLen = acc + segs[i - 1] * u; }
    acc += segs[i - 1];
  }
  return bestLen / total;
}

/**
 * Does any part of the polyline lie inside the axis-aligned rect?
 * Used by the marquee so connectors co-select with the shapes they cross.
 * Segments are clipped Liang–Barsky style, so diagonal (straight-routed)
 * edges that merely pass through the rect still count.
 */
export function polylineIntersectsRect(
  points: Vec[],
  r: { x0: number; y0: number; x1: number; y1: number },
): boolean {
  const clipSeg = (a: Vec, b: Vec): boolean => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    let t0 = 0;
    let t1 = 1;
    const clip = (p: number, q: number): boolean => {
      if (p === 0) return q >= 0;
      const t = q / p;
      if (p < 0) {
        if (t > t1) return false;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return false;
        if (t < t1) t1 = t;
      }
      return true;
    };
    return (
      clip(-dx, a.x - r.x0) &&
      clip(dx, r.x1 - a.x) &&
      clip(-dy, a.y - r.y0) &&
      clip(dy, r.y1 - a.y)
    );
  };
  for (let i = 1; i < points.length; i++) {
    if (clipSeg(points[i - 1], points[i])) return true;
  }
  return false;
}

function toPath(points: Vec[]): string {
  return points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${Math.round(p.x * 10) / 10} ${Math.round(p.y * 10) / 10}`)
    .join(" ");
}

/**
 * Build the geometry for an edge.
 * Floating endpoints need the far endpoint to aim at, so we resolve a coarse
 * "anchor" for each side first (using the other side's node center / point),
 * then resolve the final points aimed at those anchors.
 */
export function edgePath(edge: DiagramEdge, nodes: NodeMap): EdgeGeometry | null {
  const sourceAnchor = anchorFor(edge.source, nodes);
  const targetAnchor = anchorFor(edge.target, nodes);
  if (!sourceAnchor || !targetAnchor) return null;

  let points: Vec[];

  if (edge.routing === "elbow") {
    const s = resolveElbowEnd(edge.source, nodes, targetAnchor);
    const t = resolveElbowEnd(edge.target, nodes, sourceAnchor);
    if (!s || !t) return null;
    if (edge.waypoints?.length) {
      points = applyWaypoints(s.point, edge.waypoints, t.point);
    } else {
      const obstacles = [s.node, t.node].filter(Boolean) as DiagramNode[];
      // Also avoid OTHER shapes sitting in the route's corridor (bounding box
      // of the endpoints, padded) — capped and nearest-first so the sparse
      // grid stays small on big boards.
      const minX = Math.min(s.point.x, t.point.x) - ROUTE_PAD * 2;
      const maxX = Math.max(s.point.x, t.point.x) + ROUTE_PAD * 2;
      const minY = Math.min(s.point.y, t.point.y) - ROUTE_PAD * 2;
      const maxY = Math.max(s.point.y, t.point.y) + ROUTE_PAD * 2;
      const mid = { x: (s.point.x + t.point.x) / 2, y: (s.point.y + t.point.y) / 2 };
      const bystanders = Object.values(nodes)
        .filter(
          (n) =>
            n !== s.node &&
            n !== t.node &&
            n.x < maxX && n.x + n.w > minX &&
            n.y < maxY && n.y + n.h > minY,
        )
        .sort(
          (a, b) =>
            Math.hypot(a.x + a.w / 2 - mid.x, a.y + a.h / 2 - mid.y) -
            Math.hypot(b.x + b.w / 2 - mid.x, b.y + b.h / 2 - mid.y),
        )
        .slice(0, MAX_OBSTACLES - obstacles.length);
      points = routeOrthogonal(
        { point: s.point, side: s.side, node: s.node },
        { point: t.point, side: t.side, node: t.node },
        [...obstacles, ...bystanders],
      );
    }
    points = simplifyOrtho(points);
  } else {
    const s = resolveEndpoint(edge.source, nodes, targetAnchor);
    const t = resolveEndpoint(edge.target, nodes, sourceAnchor);
    if (!s || !t) return null;
    points = [s, t];
  }

  if (points.length < 2) return null;
  const first = points[0];
  const last = points[points.length - 1];

  return {
    d: toPath(points),
    points,
    mid: polylineMid(points),
    sx: first.x,
    sy: first.y,
    tx: last.x,
    ty: last.y,
  };
}

/** A coarse point for an attachment, used to aim the OTHER floating side. */
function anchorFor(att: Attachment, nodes: NodeMap): Vec | null {
  if (att.kind === "free") return att.point;
  const node = nodes[att.nodeId];
  if (!node) return null;
  if (att.kind === "port") return portPoint(node, att.rel);
  return nodeCenter(node);
}
