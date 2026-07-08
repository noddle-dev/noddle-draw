/**
 * features/diagram/shapes/arrows — block-arrow shapes (2026-07 expansion).
 * Outlines come from shapeDefs polygons so connector clipping matches exactly.
 */
import type { DiagramNode } from "../../../editor-core/diagram";
import { polygonPoints, type ShapeRenderer } from "./util";

function common(node: DiagramNode) {
  const { fill, stroke, strokeWidth } = node;
  return { fill, stroke, strokeWidth };
}

const arrow =
  (kind: "arrowRight" | "arrowLeft" | "arrowDouble" | "chevron"): ShapeRenderer =>
  (n: DiagramNode) => (
    <polygon points={polygonPoints(n, kind)} {...common(n)} strokeLinejoin="round" />
  );

export const arrowShapes: Record<string, ShapeRenderer> = {
  arrowRight: arrow("arrowRight"),
  arrowLeft: arrow("arrowLeft"),
  arrowDouble: arrow("arrowDouble"),
  chevron: arrow("chevron"),
};
