/**
 * editor-core/diagram/perimeter — closed-form border-intersection.
 *
 * Given a node and a target point, return the point on the node's border along
 * the ray from the node center toward the target. Used for "floating" edge
 * endpoints so connectors clip cleanly to the shape boundary at any angle.
 *
 * PURE TS. c=center, hw=w/2, hh=h/2, dx=toward.x-c.x, dy=toward.y-c.y.
 */
import { shapeDef } from "./shapeDefs";
import type { DiagramNode, Vec } from "./types";

function center(node: DiagramNode): Vec {
  return { x: node.x + node.w / 2, y: node.y + node.h / 2 };
}

/**
 * Ray-from-center intersection with an arbitrary polygon outline (normalized
 * 0..1 points from shapeDefs, scaled to the node box). Generalizes diamond to
 * ALL polygon shapes (triangle/pentagon/hexagon/arrows/…) so floating edges +
 * the follow-dot clip to the real edge, not the bounding box.
 */
export function polygonPerimeter(node: DiagramNode, toward: Vec, rel: [number, number][]): Vec {
  const c = center(node);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  if (dx === 0 && dy === 0) return c;
  const pts = rel.map(([px, py]) => ({ x: node.x + px * node.w, y: node.y + py * node.h }));
  let bestT = Infinity;
  let best: Vec | null = null;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const denom = dx * ey - dy * ex;
    if (Math.abs(denom) < 1e-9) continue; // ray parallel to this edge
    const t = ((a.x - c.x) * ey - (a.y - c.y) * ex) / denom; // along the ray
    const u = ((a.x - c.x) * dy - (a.y - c.y) * dx) / denom; // along the edge
    if (t > 1e-6 && u >= -1e-6 && u <= 1 + 1e-6 && t < bestT) {
      bestT = t;
      best = { x: c.x + dx * t, y: c.y + dy * t };
    }
  }
  return best ?? rectPerimeter(node, toward);
}

export function rectPerimeter(node: DiagramNode, toward: Vec): Vec {
  const c = center(node);
  const hw = node.w / 2;
  const hh = node.h / 2;
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  if (dx === 0 && dy === 0) return c;
  const scale = 1 / Math.max(Math.abs(dx) / hw, Math.abs(dy) / hh);
  return { x: c.x + dx * scale, y: c.y + dy * scale };
}

export function ellipsePerimeter(node: DiagramNode, toward: Vec): Vec {
  const c = center(node);
  const hw = node.w / 2;
  const hh = node.h / 2;
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  if (dx === 0 && dy === 0) return c;
  const t = 1 / Math.sqrt((dx * dx) / (hw * hw) + (dy * dy) / (hh * hh));
  return { x: c.x + dx * t, y: c.y + dy * t };
}

export function diamondPerimeter(node: DiagramNode, toward: Vec): Vec {
  const c = center(node);
  const hw = node.w / 2;
  const hh = node.h / 2;
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  if (dx === 0 && dy === 0) return c;
  const t = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh);
  return { x: c.x + dx * t, y: c.y + dy * t };
}

/** Dispatch to the right perimeter formula by node kind (rounded → rect). */
export function perimeterPoint(node: DiagramNode, toward: Vec): Vec {
  switch (node.kind) {
    case "ellipse":
    case "terminator": // stadium ≈ ellipse for edge clipping
      return ellipsePerimeter(node, toward);
    case "diamond":
      return diamondPerimeter(node, toward);
    default: {
      // Any shape whose catalog entry carries a polygon outline clips to that
      // real edge; the rest (rect/rounded/process/document/…/icon) → rect.
      const poly = shapeDef(node.kind)?.polygon;
      return poly && poly.length >= 3
        ? polygonPerimeter(node, toward, poly)
        : rectPerimeter(node, toward);
    }
  }
}
