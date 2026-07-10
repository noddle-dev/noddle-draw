/**
 * editor-core/diagram/orthogonal — Lucid/Excalidraw-grade elbow routing. PURE TS.
 *
 * Patterns ported from studying excalidraw's elbowArrow.ts:
 *   • HEADINGS — every endpoint exits its shape perpendicular to a side.
 *   • DONGLES — the route runs between points offset PAD away from each shape,
 *     the true endpoints are stitched on afterwards.
 *   • SPARSE-GRID A* — candidate grid lines are only the "interesting"
 *     coordinates (padded AABB edges, dongle axes, midlines); A* over that tiny
 *     grid with a bend penalty yields clean, minimal-corner routes that avoid
 *     both endpoint shapes.
 *   • USER SEGMENTS — a dragged segment turns the route into explicit interior
 *     corners (waypoints); end corners re-anchor when the shapes move, middle
 *     corners stay where the user put them.
 */
import { shapeDef } from "./shapeDefs";
import type { DiagramNode, Vec } from "./types";

export type Side = "N" | "E" | "S" | "W";

/** Distance the route keeps from shapes (excalidraw BASE_PADDING=40, scaled). */
export const ROUTE_PAD = 24;
/** Magnet radius around a shape for auto-connect while drawing an arrow. */
export const SNAP_RADIUS = 22;
/** Magnet radius around a port dot. */
export const PORT_SNAP_RADIUS = 14;

const BEND_PENALTY_FACTOR = 0.5; // × manhattan(start,end), like excalidraw

// ---------------------------------------------------------------------------
// sides & anchors
// ---------------------------------------------------------------------------

export function oppositeSide(s: Side): Side {
  return { N: "S", S: "N", E: "W", W: "E" }[s] as Side;
}

export function sideDir(s: Side): Vec {
  switch (s) {
    case "N": return { x: 0, y: -1 };
    case "S": return { x: 0, y: 1 };
    case "E": return { x: 1, y: 0 };
    case "W": return { x: -1, y: 0 };
  }
}

/** Side implied by a port's relative position, or null for the center port. */
export function sideOfPort(rel: Vec): Side | null {
  if (rel.y === 0) return "N";
  if (rel.y === 1) return "S";
  if (rel.x === 0) return "W";
  if (rel.x === 1) return "E";
  return null;
}

/** Pick the exit side of `node` that best faces `toward`. */
export function autoSide(node: DiagramNode, toward: Vec): Side {
  const cx = node.x + node.w / 2;
  const cy = node.y + node.h / 2;
  const dx = toward.x - cx;
  const dy = toward.y - cy;
  // Compare normalized by half-extents so flat/tall shapes pick naturally.
  if (Math.abs(dx) / (node.w / 2) >= Math.abs(dy) / (node.h / 2)) {
    return dx >= 0 ? "E" : "W";
  }
  return dy >= 0 ? "S" : "N";
}

/**
 * The attach point ON a given side, sliding along it toward the far point
 * (clamped away from corners) — how Lucid picks floating side anchors.
 */
export function sideAnchor(node: DiagramNode, side: Side, toward: Vec): Vec {
  const inset = Math.min(12, node.w / 4, node.h / 4);
  const clampX = (x: number) => Math.min(node.x + node.w - inset, Math.max(node.x + inset, x));
  const clampY = (y: number) => Math.min(node.y + node.h - inset, Math.max(node.y + inset, y));

  // Ellipse: the box edge sits OFF the curve at any offset from center, so a
  // slid N/S/E/W anchor must be projected onto the ellipse itself — otherwise
  // arrows land in the gap between the bounding box and the visible shape.
  if (node.kind === "ellipse") {
    const cx = node.x + node.w / 2, cy = node.y + node.h / 2;
    const rx = node.w / 2, ry = node.h / 2;
    if (side === "N" || side === "S") {
      const x = clampX(toward.x);
      const dy = ry * Math.sqrt(Math.max(0, 1 - ((x - cx) / rx) ** 2));
      return { x, y: side === "N" ? cy - dy : cy + dy };
    }
    const y = clampY(toward.y);
    const dx = rx * Math.sqrt(Math.max(0, 1 - ((y - cy) / ry) ** 2));
    return { x: side === "W" ? cx - dx : cx + dx, y };
  }

  // Any polygon shape (diamond/triangle/pentagon/hexagon/arrows/…): project the
  // slid anchor onto the true edge via a scanline, so orthogonal arrows meet
  // the visible outline instead of the bounding box.
  const poly = shapeDef(node.kind)?.polygon;
  if (poly && poly.length >= 3) {
    const pts = poly.map(([px, py]) => ({ x: node.x + px * node.w, y: node.y + py * node.h }));
    if (side === "N" || side === "S") {
      const x = clampX(toward.x);
      const y = scanlineExtreme(pts, "v", x, side === "N");
      if (y != null) return { x, y };
    } else {
      const y = clampY(toward.y);
      const x = scanlineExtreme(pts, "h", y, side === "W");
      if (x != null) return { x, y };
    }
  }

  switch (side) {
    case "N": return { x: clampX(toward.x), y: node.y };
    case "S": return { x: clampX(toward.x), y: node.y + node.h };
    case "W": return { x: node.x, y: clampY(toward.y) };
    case "E": return { x: node.x + node.w, y: clampY(toward.y) };
  }
}

/**
 * Where a scanline crosses a polygon's outline: vertical scanline at x=`coord`
 * ("v") returns the min-y (top, `wantMin`) or max-y (bottom); horizontal at
 * y=`coord` ("h") returns min-x (left) or max-x (right). null if no crossing.
 */
function scanlineExtreme(
  pts: Vec[],
  axis: "v" | "h",
  coord: number,
  wantMin: boolean,
): number | null {
  let best: number | null = null;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const a0 = axis === "v" ? a.x : a.y;
    const b0 = axis === "v" ? b.x : b.y;
    if ((coord < a0 && coord < b0) || (coord > a0 && coord > b0)) continue;
    if (a0 === b0) continue; // edge parallel to the scanline
    const u = (coord - a0) / (b0 - a0); // 0..1 along the edge
    const cross = axis === "v" ? a.y + u * (b.y - a.y) : a.x + u * (b.x - a.x);
    if (best == null || (wantMin ? cross < best : cross > best)) best = cross;
  }
  return best;
}

/** The dongle: `pad` away from `p` along the side's outward direction. */
export function dongle(p: Vec, side: Side, pad: number): Vec {
  const d = sideDir(side);
  return { x: p.x + d.x * pad, y: p.y + d.y * pad };
}

/**
 * A dongle that clears the node's BOUNDING BOX (not just `pad` from the anchor).
 * For a rect the anchor is already on the box edge so this equals `dongle`, but
 * for a diamond/ellipse the anchor sits on a slanted/curved edge INSIDE the box
 * — a plain dongle would stay inside the padded obstacle and the route hugs the
 * shape. Extending to the box edge + pad makes the first segment exit cleanly,
 * so A* turns outside the shape.
 */
export function clearingDongle(p: Vec, side: Side, pad: number, node?: DiagramNode): Vec {
  if (!node) return dongle(p, side, pad);
  switch (side) {
    case "N": return { x: p.x, y: node.y - pad };
    case "S": return { x: p.x, y: node.y + node.h + pad };
    case "W": return { x: node.x - pad, y: p.y };
    case "E": return { x: node.x + node.w + pad, y: p.y };
  }
}

// ---------------------------------------------------------------------------
// route simplification
// ---------------------------------------------------------------------------

/** Drop repeated + collinear points from an orthogonal polyline. */
export function simplifyOrtho(points: Vec[]): Vec[] {
  const out: Vec[] = [];
  for (const p of points) {
    const a = out[out.length - 2];
    const b = out[out.length - 1];
    if (b && Math.abs(b.x - p.x) < 0.5 && Math.abs(b.y - p.y) < 0.5) continue; // dupe
    if (a && b) {
      const colinear =
        (Math.abs(a.x - b.x) < 0.5 && Math.abs(b.x - p.x) < 0.5) ||
        (Math.abs(a.y - b.y) < 0.5 && Math.abs(b.y - p.y) < 0.5);
      if (colinear) {
        out[out.length - 1] = p;
        continue;
      }
    }
    out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// sparse-grid A* router
// ---------------------------------------------------------------------------

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function padded(node: DiagramNode, pad: number): Rect {
  return { x0: node.x - pad, y0: node.y - pad, x1: node.x + node.w + pad, y1: node.y + node.h + pad };
}

function strictlyInside(p: Vec, r: Rect, eps = 0.5): boolean {
  return p.x > r.x0 + eps && p.x < r.x1 - eps && p.y > r.y0 + eps && p.y < r.y1 - eps;
}

/** True if the segment a→b (orthogonal) passes strictly through rect r. */
function segmentCrosses(a: Vec, b: Vec, r: Rect): boolean {
  const eps = 0.5;
  if (Math.abs(a.x - b.x) < eps) {
    // vertical
    if (a.x <= r.x0 + eps || a.x >= r.x1 - eps) return false;
    const lo = Math.min(a.y, b.y);
    const hi = Math.max(a.y, b.y);
    return hi > r.y0 + eps && lo < r.y1 - eps;
  }
  // horizontal
  if (a.y <= r.y0 + eps || a.y >= r.y1 - eps) return false;
  const lo = Math.min(a.x, b.x);
  const hi = Math.max(a.x, b.x);
  return hi > r.x0 + eps && lo < r.x1 - eps;
}

interface GridNode {
  x: number;
  y: number;
  col: number;
  row: number;
  g: number;
  f: number;
  dir: Side | null;
  visited: boolean;
  parent: GridNode | null;
}

/**
 * Route an orthogonal path start→end that exits/enters along the given sides
 * and avoids the (padded) endpoint shapes. Returns the FULL corner list
 * including both true endpoints. Falls back to a simple dongle Z-route when
 * A* finds no path (e.g. overlapping shapes).
 */
export function routeOrthogonal(
  start: { point: Vec; side: Side; node?: DiagramNode | null },
  end: { point: Vec; side: Side; node?: DiagramNode | null },
  obstacles: DiagramNode[],
  pad: number = ROUTE_PAD,
): Vec[] {
  // Dongles clear each endpoint's bounding box so slanted/curved-edge exits
  // (diamond/ellipse) don't hug the shape.
  const sd = clearingDongle(start.point, start.side, pad, start.node ?? undefined);
  const ed = clearingDongle(end.point, end.side, pad, end.node ?? undefined);
  const rects = obstacles.map((o) => padded(o, pad - 1));

  // --- candidate grid lines (the "interesting" coordinates) ---
  const xs = new Set<number>([sd.x, ed.x]);
  const ys = new Set<number>([sd.y, ed.y]);
  for (const o of obstacles) {
    const r = padded(o, pad);
    xs.add(r.x0); xs.add(r.x1);
    ys.add(r.y0); ys.add(r.y1);
  }
  xs.add((sd.x + ed.x) / 2);
  ys.add((sd.y + ed.y) / 2);
  if (obstacles.length === 2) {
    const [a, b] = obstacles.map((o) => padded(o, pad));
    if (a.x1 < b.x0) xs.add((a.x1 + b.x0) / 2);
    if (b.x1 < a.x0) xs.add((b.x1 + a.x0) / 2);
    if (a.y1 < b.y0) ys.add((a.y1 + b.y0) / 2);
    if (b.y1 < a.y0) ys.add((b.y1 + a.y0) / 2);
  }
  const colX = [...xs].sort((m, n) => m - n);
  const rowY = [...ys].sort((m, n) => m - n);

  // --- grid nodes (blocked when strictly inside an obstacle) ---
  const grid: (GridNode | null)[][] = rowY.map((y, row) =>
    colX.map((x, col) => {
      const p = { x, y };
      if (rects.some((r) => strictlyInside(p, r))) return null;
      return { x, y, col, row, g: Infinity, f: Infinity, dir: null, visited: false, parent: null };
    }),
  );

  const at = (col: number, row: number): GridNode | null =>
    row >= 0 && row < rowY.length && col >= 0 && col < colX.length ? grid[row][col] : null;
  const find = (p: Vec): GridNode | null => {
    const col = colX.findIndex((x) => Math.abs(x - p.x) < 0.5);
    const row = rowY.findIndex((y) => Math.abs(y - p.y) < 0.5);
    return col >= 0 && row >= 0 ? at(col, row) : null;
  };

  const startNode = find(sd);
  const endNode = find(ed);
  const fallback = (): Vec[] => {
    // Z-route through the dongles, no avoidance (always well-formed).
    const mid: Vec[] = [];
    if (Math.abs(sd.x - ed.x) < 0.5 || Math.abs(sd.y - ed.y) < 0.5) {
      // already aligned
    } else if (start.side === "E" || start.side === "W") {
      const mx = (sd.x + ed.x) / 2;
      mid.push({ x: mx, y: sd.y }, { x: mx, y: ed.y });
    } else {
      const my = (sd.y + ed.y) / 2;
      mid.push({ x: sd.x, y: my }, { x: ed.x, y: my });
    }
    return simplifyOrtho([start.point, sd, ...mid, ed, end.point]);
  };
  if (!startNode || !endNode) return fallback();

  // --- A* with bend penalty; entry heading = outward side, exit = inward ---
  const manhattan = (a: Vec, b: Vec) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  const bendPenalty = Math.max(40, manhattan(sd, ed) * BEND_PENALTY_FACTOR);

  startNode.g = 0;
  startNode.f = manhattan(sd, ed);
  startNode.dir = start.side;
  const open: GridNode[] = [startNode];

  const STEPS: { dc: number; dr: number; dir: Side }[] = [
    { dc: 0, dr: -1, dir: "N" },
    { dc: 1, dr: 0, dir: "E" },
    { dc: 0, dr: 1, dir: "S" },
    { dc: -1, dr: 0, dir: "W" },
  ];

  while (open.length) {
    // tiny grid → linear extract-min is fine
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
    const cur = open.splice(bi, 1)[0];
    if (cur.visited) continue;
    cur.visited = true;

    if (cur === endNode) break;

    for (const s of STEPS) {
      const nb = at(cur.col + s.dc, cur.row + s.dr);
      if (!nb || nb.visited) continue;
      if (s.dir === (cur.dir && oppositeSide(cur.dir))) continue; // no backtracking
      if (rects.some((r) => segmentCrosses(cur, nb, r))) continue;
      const stepCost = manhattan(cur, nb) + (cur.dir && cur.dir !== s.dir ? bendPenalty : 0);
      const g = cur.g + stepCost;
      if (g < nb.g) {
        nb.g = g;
        // prefer arriving at the end dongle already facing INTO the shape
        const endBias = nb === endNode && s.dir !== oppositeSide(end.side) ? bendPenalty : 0;
        nb.f = g + manhattan(nb, ed) + endBias;
        nb.dir = s.dir;
        nb.parent = cur;
        open.push(nb);
      }
    }
  }

  if (!endNode.visited) return fallback();

  const corners: Vec[] = [];
  let n: GridNode | null = endNode;
  while (n) {
    corners.unshift({ x: n.x, y: n.y });
    n = n.parent;
  }
  return simplifyOrtho([start.point, ...corners, end.point]);
}

// ---------------------------------------------------------------------------
// user waypoints (dragged segments)
// ---------------------------------------------------------------------------

/**
 * Stitch endpoints onto user-owned interior corners, re-anchoring the first
 * and last corner so the route stays orthogonal while shapes move: if the
 * corner's outgoing segment is horizontal, its incoming segment must be
 * vertical → it inherits the endpoint's x (and vice versa).
 */
export function applyWaypoints(startPt: Vec, waypoints: Vec[], endPt: Vec): Vec[] {
  if (!waypoints.length) return [startPt, endPt];
  const ws = waypoints.map((w) => ({ ...w }));

  if (ws.length === 1) {
    // Single corner: it must share one axis with EACH endpoint. Choose the
    // orientation closer to where the user put it.
    const w = ws[0];
    const a = { x: startPt.x, y: endPt.y };
    const b = { x: endPt.x, y: startPt.y };
    const da = Math.abs(a.x - w.x) + Math.abs(a.y - w.y);
    const db = Math.abs(b.x - w.x) + Math.abs(b.y - w.y);
    return simplifyOrtho([startPt, da <= db ? a : b, endPt]);
  }

  const first = ws[0];
  const second = ws[1];
  if (Math.abs(first.y - second.y) < 0.5) first.x = startPt.x; // horiz out → vert in
  else first.y = startPt.y;

  const last = ws[ws.length - 1];
  const prev = ws[ws.length - 2];
  if (Math.abs(last.y - prev.y) < 0.5) last.x = endPt.x;
  else last.y = endPt.y;

  return simplifyOrtho([startPt, ...ws, endPt]);
}

// ---------------------------------------------------------------------------
// auto-connect magnet
// ---------------------------------------------------------------------------

import { perimeterPoint, rotatePoint } from "./perimeter";

export interface SnapHit {
  nodeId: string;
  /** Set when snapped to a specific port dot. */
  portRel?: Vec;
  /** The magnetically snapped attach point (for the preview line). */
  point: Vec;
}

const PORT_RELS: Vec[] = [
  { x: 0.5, y: 0 },
  { x: 1, y: 0.5 },
  { x: 0.5, y: 1 },
  { x: 0, y: 0.5 },
];

/**
 * Magnetic hit-test for arrow endpoints: within SNAP_RADIUS of a shape counts
 * (not just inside), and within PORT_SNAP_RADIUS of a port dot snaps exactly
 * to it. Inside-hits beat nearby-hits; nearer shapes beat farther ones.
 *
 * `radiusScale` converts the radii from screen feel to content coords — pass
 * 1/zoom so the magnet is equally grabby at every zoom level (at 50% zoom an
 * unscaled 14px content radius is a measly 7 screen px and feels dead).
 */
export function snapConnect(
  nodes: Record<string, DiagramNode>,
  p: Vec,
  excludeId?: string,
  radiusScale = 1,
): SnapHit | null {
  const snapR = SNAP_RADIUS * radiusScale;
  const portR = PORT_SNAP_RADIUS * radiusScale;
  let best: { hit: SnapHit; dist: number; inside: boolean } | null = null;

  for (const n of Object.values(nodes)) {
    if (n.id === excludeId) continue;

    // Work in the node's own (unrotated) frame: inverse-rotate the cursor,
    // test/project against the axis-aligned body, then rotate the resulting
    // attach point back out so it lands on the shape the user sees. The stored
    // portRel is frame-independent — resolveEndpoint/portPoint re-rotate it.
    const c = { x: n.x + n.w / 2, y: n.y + n.h / 2 };
    const pl = n.rotation ? rotatePoint(p, c, -n.rotation) : p;
    const out = (q: Vec): Vec => (n.rotation ? rotatePoint(q, c, n.rotation) : q);

    // port magnets first — they win over the body
    let portHit: SnapHit | null = null;
    let portDist = Infinity;
    for (const rel of PORT_RELS) {
      const pp = { x: n.x + rel.x * n.w, y: n.y + rel.y * n.h };
      const d = Math.hypot(pp.x - pl.x, pp.y - pl.y);
      if (d <= portR && d < portDist) {
        portDist = d;
        portHit = { nodeId: n.id, portRel: rel, point: out(pp) };
      }
    }

    const inside = pl.x >= n.x && pl.x <= n.x + n.w && pl.y >= n.y && pl.y <= n.y + n.h;
    const dx = Math.max(n.x - pl.x, 0, pl.x - (n.x + n.w));
    const dy = Math.max(n.y - pl.y, 0, pl.y - (n.y + n.h));
    const boxDist = Math.hypot(dx, dy);

    let cand: { hit: SnapHit; dist: number; inside: boolean } | null = null;
    if (portHit) {
      cand = { hit: portHit, dist: portDist - 1000, inside }; // ports dominate
    } else if (inside) {
      cand = { hit: { nodeId: n.id, point: out(perimeterPoint(n, pl)) }, dist: -500 + boxDist, inside };
    } else if (boxDist <= snapR) {
      cand = { hit: { nodeId: n.id, point: out(perimeterPoint(n, pl)) }, dist: boxDist, inside };
    }
    if (cand && (!best || cand.dist < best.dist)) best = cand;
  }
  return best?.hit ?? null;
}
