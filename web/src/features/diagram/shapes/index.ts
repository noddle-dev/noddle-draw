/**
 * features/diagram/shapes — the per-group shape renderer registry.
 *
 * Each group module exports Record<kind, (node) => JSX>; this index merges
 * them. `ShapePalette.shapeElement` consults the registry FIRST and falls
 * back to its legacy switch for the original kinds — so adding a shape is:
 * one row in editor-core/diagram/shapeDefs.ts + one renderer in the matching
 * group module. No central switch edits.
 */
import { arrowShapes } from "./arrows";
import { flowchartShapes } from "./flowchart";
import { geometricShapes } from "./geometric";
import { umlShapes } from "./uml";
import type { ShapeRenderer } from "./util";

export type { ShapeRenderer } from "./util";

export const SHAPE_RENDERERS: Record<string, ShapeRenderer> = {
  ...geometricShapes,
  ...flowchartShapes,
  ...arrowShapes,
  ...umlShapes,
};
