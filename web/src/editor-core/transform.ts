/**
 * editor-core/transform — move & resize transform matrices around a pivot.
 *
 * Ported from `frontend/editor.js` (startMove / startResize math + the M()
 * matrix serialiser). Pure functions over DOMMatrix; the feature layer applies
 * the returned strings to elements and commits history.
 */
import type { HandleId, Point, Rect } from "./types";

/** Serialise a DOMMatrix to an SVG `matrix(...)` transform string. */
export function matrixToString(m: DOMMatrix): string {
  return `matrix(${m.a} ${m.b} ${m.c} ${m.d} ${m.e} ${m.f})`;
}

/**
 * Matrix to apply to an element being MOVED by (dx, dy) in content space,
 * given the element's original own-matrix `m`. Pre-multiplies a translation.
 */
export function moveMatrix(m: DOMMatrix, dx: number, dy: number): DOMMatrix {
  return new DOMMatrix().translate(dx, dy).multiply(m);
}

/** Fixed pivot = corner opposite the grabbed handle, in content coords. */
export function resizePivot(handle: HandleId, box: Rect): Point {
  const pivots: Record<HandleId, Point> = {
    nw: { x: box.x + box.w, y: box.y + box.h },
    ne: { x: box.x, y: box.y + box.h },
    se: { x: box.x, y: box.y },
    sw: { x: box.x + box.w, y: box.y },
  };
  return pivots[handle];
}

/**
 * Scale factors for a resize drag, from the pointer's start/current positions
 * relative to the pivot. `d0` is (start - pivot) captured at pointer-down.
 * When `uniform` (shift) is held, both axes use the larger magnitude.
 */
export function resizeScale(
  pivot: Point,
  d0: Point,
  current: Point,
  uniform: boolean,
): { sx: number; sy: number } {
  const d0x = d0.x || 1e-6;
  const d0y = d0.y || 1e-6;
  let sx = (current.x - pivot.x) / d0x;
  let sy = (current.y - pivot.y) / d0y;
  if (uniform) {
    const s = Math.max(Math.abs(sx), Math.abs(sy));
    sx = Math.sign(sx) * s;
    sy = Math.sign(sy) * s;
  }
  return { sx, sy };
}

/**
 * Matrix to apply to an element being RESIZED, given its original own-matrix
 * `m`, the pivot, and scale factors. Scales about the pivot then reapplies `m`.
 */
export function resizeMatrix(
  m: DOMMatrix,
  pivot: Point,
  sx: number,
  sy: number,
): DOMMatrix {
  const t = new DOMMatrix()
    .translate(pivot.x, pivot.y)
    .scale(sx, sy)
    .translate(-pivot.x, -pivot.y);
  return t.multiply(m);
}
