/**
 * features/diagram/shapes/basic — extra "basic" palette kinds.
 *
 * `text` is a label-only element: NO outline or fill regardless of the node's
 * fill/stroke props — the label itself (drawn by NodeView) is the whole
 * element. The transparent rect keeps the node body hit-testable so it can be
 * clicked/dragged like any shape.
 */
import type { ShapeRenderer } from "./util";

export const basicShapes: Record<string, ShapeRenderer> = {
  text: (n) => (
    <rect x={n.x} y={n.y} width={n.w} height={n.h} fill="transparent" stroke="none" />
  ),
};
