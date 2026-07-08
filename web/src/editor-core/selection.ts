/**
 * editor-core/selection — hit-testing, bounding boxes, marquee intersection.
 *
 * Ported from `frontend/editor.js` (topObject / isVisual / contentBBox /
 * unionBBox / marquee hit-test). Pure geometry over real SVG DOM; no globals.
 */
import { localName, NON_VISUAL, type Rect, type SceneObject } from "./types";

/** The element's own (consolidated) transform matrix, or identity. */
export function ownMatrix(el: SVGGraphicsElement): DOMMatrix {
  const c = el.transform.baseVal.consolidate();
  return c ? c.matrix : new DOMMatrix();
}

/** True if `el` is a direct, selectable child of #content. */
export function isVisual(content: SVGGElement, el: Node | null): boolean {
  return (
    el != null &&
    (el as Node).parentNode === content &&
    !NON_VISUAL.has(localName(el as Element))
  );
}

/** Walk up from a hit node to the direct child of #content that owns it. */
export function topObject(
  content: SVGGElement,
  node: Node | null,
): SceneObject | null {
  let n: Node | null = node;
  while (n && n.parentNode !== content) n = n.parentNode;
  return n && isVisual(content, n) ? (n as SceneObject) : null;
}

/** Axis-aligned bbox of an element expressed in #content coordinates. */
export function contentBBox(el: SVGGraphicsElement): Rect {
  const b = el.getBBox();
  const m = ownMatrix(el);
  const pts = [
    new DOMPoint(b.x, b.y),
    new DOMPoint(b.x + b.width, b.y),
    new DOMPoint(b.x + b.width, b.y + b.height),
    new DOMPoint(b.x, b.y + b.height),
  ].map((p) => p.matrixTransform(m));
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return {
    x: minX,
    y: minY,
    w: Math.max(...xs) - minX,
    h: Math.max(...ys) - minY,
  };
}

/** Union bbox (in #content coords) of a set of elements. */
export function unionBBox(els: SVGGraphicsElement[]): Rect {
  const bs = els.map(contentBBox);
  const x = Math.min(...bs.map((b) => b.x));
  const y = Math.min(...bs.map((b) => b.y));
  const x2 = Math.max(...bs.map((b) => b.x + b.w));
  const y2 = Math.max(...bs.map((b) => b.y + b.h));
  return { x, y, w: x2 - x, h: y2 - y };
}

/** List the visual children of #content in z-order (bottom → top). */
export function visualChildren(content: SVGGElement): SceneObject[] {
  return Array.from(content.children).filter(
    (el) => !NON_VISUAL.has(localName(el)),
  ) as SceneObject[];
}

/**
 * Elements whose content-space bbox intersects the marquee rectangle (defined
 * by two content-space points). Touch/intersect mode, matching the vanilla app.
 */
export function marqueeHits(
  content: SVGGElement,
  p0: { x: number; y: number },
  p1: { x: number; y: number },
): SceneObject[] {
  const r = {
    x: Math.min(p0.x, p1.x),
    y: Math.min(p0.y, p1.y),
    x2: Math.max(p0.x, p1.x),
    y2: Math.max(p0.y, p1.y),
  };
  return visualChildren(content).filter((el) => {
    const b = contentBBox(el);
    return b.x < r.x2 && b.x + b.w > r.x && b.y < r.y2 && b.y + b.h > r.y;
  });
}
