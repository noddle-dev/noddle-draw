/**
 * features/diagram/shapes/util — shared bits for the per-group shape modules.
 */
import type { JSX } from "react";
import type { DiagramNode, NodeKind } from "../../../editor-core/diagram";
import { shapeDef } from "../../../editor-core/diagram/shapeDefs";

export type ShapeRenderer = (node: DiagramNode) => JSX.Element;

/** SVG points attribute from the shapeDefs normalized polygon (0..1 → node box). */
export function polygonPoints(node: DiagramNode, kind?: NodeKind): string {
  const def = shapeDef(kind ?? node.kind);
  const poly = def?.polygon ?? [];
  return poly
    .map(([px, py]) => `${node.x + px * node.w},${node.y + py * node.h}`)
    .join(" ");
}
